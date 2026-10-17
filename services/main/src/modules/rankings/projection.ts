import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withWorkerTelemetry } from '@rezics/observability/runtime';
import { logWorkerFault } from '@rezics/observability/log';
import { runWorkerTick } from '../../worker-tick.ts';
import type { ContentCore, ContentOutboxEvent } from '../../../../content/src/core.ts';
import { readProgressSignal, type ProgressSignal } from '../structure/progress-outbox.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { refreshReadRankingAdmissions } from '../feed/ranking-admission.ts';
import { wallRankingClock, type RankingClock } from './clock.ts';
import { captureRankingPopulation, fenceRankingPopulation,
  type RankingCaptureRow, type RankingPopulation, type RankingPopulationCapture } from './store.ts';

export const RANKING_COST = { sourceEvents: 32, retryEvents: 8, graphRowsPerEvent: 2,
  pageCandidates: 100, pageSize: 20, cleanupRows: 500, deadlineMs: 10_000 } as const;
export type RankingMetric = 'reads' | 'finished-chapters' | 'reviews';
export type RankingInterval = 'day' | 'week' | 'month';
const intervals: readonly RankingInterval[] = ['day', 'week', 'month'];
const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export class RankingProjectionUnavailable extends Error {}
export class RankingProjectionIncomplete extends RankingProjectionUnavailable {
  constructor(readonly population: RankingPopulation) {
    super('The selected ranking population has a pending removal');
  }
}

/** What one progress signal adds to the rankings. A row whose structure is the
 * occurrence is the Work itself: there is no Structure to look up, and the Work
 * has no chapters. That completion counts as a read and adds nothing to finished
 * chapters. */
export function progressRankingMetrics(signal: Pick<ProgressSignal, 'structure' | 'occurrence' | 'read' | 'finished'>): RankingMetric[] {
  const wholeWork = signal.structure === signal.occurrence;
  return [
    ...(signal.read ? ['reads' as const] : []),
    ...(signal.finished && !wholeWork ? ['finished-chapters' as const] : []),
  ];
}
export interface RankingCheckpoint { generation: string; contentEpoch: string;
  contentSequence: string; graphEpoch: string; reviewPosition: string }

function bucketOf(at: Date, interval: RankingInterval): string {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  if (interval === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  if (interval === 'month') date.setUTCDate(1);
  return date.toISOString().slice(0, 10);
}
export function rankingBuckets(at: Date, interval: RankingInterval): { current: string; previous: string } {
  const current = bucketOf(at, interval);
  const before = new Date(`${current}T00:00:00.000Z`);
  if (interval === 'day') before.setUTCDate(before.getUTCDate() - 1);
  if (interval === 'week') before.setUTCDate(before.getUTCDate() - 7);
  if (interval === 'month') before.setUTCMonth(before.getUTCMonth() - 1);
  return { current, previous: bucketOf(before, interval) };
}

async function checkpoint(client: PoolClient): Promise<RankingCheckpoint | null> {
  const row = (await client.query<{ generation: string; content_epoch: string;
    content_sequence: string; graph_epoch: string; review_position: string; coverage_intact: boolean }>(`SELECT generation, content_epoch,
      content_scan_sequence::text AS content_sequence, graph_epoch, review_scan_position::text AS review_position,
      content_sequence = COALESCE((SELECT min(position) - 1 FROM access.read_ranking_pending
        WHERE generation=c.generation AND source='content'), content_scan_sequence)
      AND review_position = COALESCE((SELECT min(position) - 1 FROM access.read_ranking_pending
        WHERE generation=c.generation AND source='review'), review_scan_position) AS coverage_intact
      FROM access.read_ranking_checkpoint c WHERE singleton FOR UPDATE`)).rows[0];
  if (row && !row.coverage_intact) throw new RankingProjectionUnavailable('Retained ranking coverage differs');
  return row ? { generation: row.generation, contentEpoch: row.content_epoch,
    contentSequence: row.content_sequence, graphEpoch: row.graph_epoch,
    reviewPosition: row.review_position } : null;
}

/** Source and target are separate owners. One Access transaction advances the
 * checkpoint and score rows together; a changed owner epoch starts a generation. */
export class ReadRankingProjection {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | undefined;
  constructor(private readonly access: Pool, private readonly content: ContentCore,
    private readonly contentPool: Pool, private readonly env: WorkActivationEnvironment,
    readonly clock: RankingClock = wallRankingClock) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = runWorkerTick('main.read-ranking.projection', () => withWorkerTelemetry('main.read-ranking.projection', () => this.tick(), count => ({
        outcome: count ? 'worked' : 'idle', processed: count, unit: 'event',
      }))).catch(error => { logWorkerFault('main.read-ranking.projection', error); })
        .finally(() => { this.running = undefined; });
    }, 500);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** A whole-Work mark names the Work as its structure. One keyed ask proves that
   * IRI is a current Work; anything else is the same miss as an unknown Structure. */
  private async rankedWork(signal: ProgressSignal): Promise<string | null> {
    if (signal.structure !== signal.occurrence) return this.graphWork(signal.structure);
    if (!ID.test(signal.structure)) return null;
    const found = await this.env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(this.env.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(signal.structure)} a <https://schema.org/CreativeWork> ; rv:mainVersion ?main . }
    }`, 1024);
    return found.boolean === true ? signal.structure : null;
  }

  private async graphWork(structure: string): Promise<string | null> {
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(this.env.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} { ${iri(structure)} a rv:Structure ; rv:structureOf ?main .
        ?work a <https://schema.org/CreativeWork> ; rv:mainVersion ?main . }
    } LIMIT ${RANKING_COST.graphRowsPerEvent}`, 8192)).results?.bindings ?? [];
    if (rows.length > 1 || rows.some(row => !ID.test(row.work?.value ?? ''))) {
      throw new RankingProjectionUnavailable('Structure maps to ambiguous Work');
    }
    return rows[0]?.work?.value ?? null;
  }

  private async increment(client: PoolClient, generation: string, work: string,
    metric: RankingMetric, interval: RankingInterval, at: Date) {
    const { current, previous } = rankingBuckets(at, interval);
    const prior = (await client.query<{ score: string }>(`SELECT score::text FROM access.read_ranking_score
      WHERE generation = $1 AND metric = $2 AND interval = $3 AND bucket = $4 AND work = $5`,
    [generation, metric, interval, previous, work])).rows[0];
    await client.query(`INSERT INTO access.read_ranking_score
      (generation, metric, interval, bucket, work, score, growth)
      VALUES ($1,$2,$3,$4,$5,1,1 - $6::bigint)
      ON CONFLICT (generation, metric, interval, bucket, work)
      DO UPDATE SET score = access.read_ranking_score.score + 1,
        growth = access.read_ranking_score.growth + 1`,
    [generation, metric, interval, current, work, prior?.score ?? '0']);
  }

  private async changeReview(client: PoolClient, generation: string, work: string,
    interval: RankingInterval, at: Date, delta: number): Promise<void> {
    const { current, previous } = rankingBuckets(at, interval);
    const cutoff = this.clock.at();
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
    if (current < cutoff.toISOString().slice(0, 10)) return;
    const score = (await client.query<{ score: string }>(`SELECT score::text
      FROM access.read_ranking_score WHERE generation = $1 AND metric = 'reviews'
        AND interval = $2 AND bucket = $3 AND work = $4`,
    [generation, interval, current, work])).rows[0];
    const next = BigInt(score?.score ?? '0') + BigInt(delta);
    if (next < 0n) throw new RankingProjectionUnavailable('Review ranking source has a negative count');
    if (next === 0n) {
      await client.query(`DELETE FROM access.read_ranking_score WHERE generation = $1
        AND metric = 'reviews' AND interval = $2 AND bucket = $3 AND work = $4`,
      [generation, interval, current, work]);
    } else {
      const prior = (await client.query<{ score: string }>(`SELECT score::text
        FROM access.read_ranking_score WHERE generation = $1 AND metric = 'reviews'
          AND interval = $2 AND bucket = $3 AND work = $4`,
      [generation, interval, previous, work])).rows[0];
      await client.query(`INSERT INTO access.read_ranking_score
        (generation, metric, interval, bucket, work, score, growth)
        VALUES ($1, 'reviews', $2, $3, $4, $5, $6)
        ON CONFLICT (generation, metric, interval, bucket, work)
        DO UPDATE SET score = EXCLUDED.score, growth = EXCLUDED.growth`,
      [generation, interval, current, work, next.toString(),
        (next - BigInt(prior?.score ?? '0')).toString()]);
    }
    const following = new Date(`${current}T00:00:00.000Z`);
    if (interval === 'day') following.setUTCDate(following.getUTCDate() + 1);
    else if (interval === 'week') following.setUTCDate(following.getUTCDate() + 7);
    else following.setUTCMonth(following.getUTCMonth() + 1);
    await client.query(`UPDATE access.read_ranking_score SET growth = score - $5
      WHERE generation = $1 AND metric = 'reviews' AND interval = $2
        AND bucket = $3 AND work = $4`,
    [generation, interval, following.toISOString().slice(0, 10), work, next.toString()]);
  }

  async tick(): Promise<number> {
    await this.access.query('SELECT access.sequence_reader_review_ranks($1)', [RANKING_COST.sourceEvents]);
    const owner = await this.content.ownerPosition();
    const progressHead = await this.progressHead(owner.dataEpoch);
    const existing = (await this.access.query<{ generation: string; content_epoch: string;
      content_sequence: string; graph_epoch: string; review_position: string; coverage_intact: boolean }>(`SELECT generation, content_epoch,
      content_scan_sequence::text AS content_sequence, graph_epoch, review_scan_position::text AS review_position,
      content_sequence = COALESCE((SELECT min(position) - 1 FROM access.read_ranking_pending
        WHERE generation=c.generation AND source='content'), content_scan_sequence)
      AND review_position = COALESCE((SELECT min(position) - 1 FROM access.read_ranking_pending
        WHERE generation=c.generation AND source='review'), review_scan_position) AS coverage_intact
      FROM access.read_ranking_checkpoint c WHERE singleton`)).rows[0];
    const reviewHead = (await this.access.query<{ position: string }>(`SELECT position::text
      FROM access.reader_review_rank_head WHERE singleton`)).rows[0];
    if (!reviewHead) throw new RankingProjectionUnavailable('Review ranking source is unavailable');
    const reset = !existing || existing.content_epoch !== owner.dataEpoch
      || existing.graph_epoch !== this.env.lineage.dataEpoch
      || BigInt(existing.content_sequence) > BigInt(owner.sequence)
      || BigInt(existing.review_position) > BigInt(reviewHead.position);
    if (!reset && !existing.coverage_intact) throw new RankingProjectionUnavailable('Retained ranking coverage differs');
    const after = reset ? '0' : existing.content_sequence;
    const events = (await this.contentPool.query<{ id: string; sequence: string; operation_id: string;
      event_type: string; recipe: string; revision_id: string | null; payload: Record<string, unknown> }>(`
      SELECT id,sequence::text,operation_id,event_type,recipe,revision_id,payload FROM content.outbox
      WHERE data_epoch = $1 AND recipe = 'structure-progress-v1'
        AND sequence > $2 AND sequence <= $3 ORDER BY content.outbox.sequence LIMIT $4`,
    [owner.dataEpoch, after, progressHead.sequence, RANKING_COST.sourceEvents])).rows.map(row => ({
      id: row.id, position: { owner: 'content' as const, dataEpoch: owner.dataEpoch, sequence: row.sequence },
      operationId: row.operation_id, eventType: row.event_type, recipe: row.recipe,
      revisionId: row.revision_id, payload: row.payload,
    } satisfies ContentOutboxEvent));
    const reviewAfter = reset ? '0' : existing.review_position;
    const reviewEvents = (await this.access.query<{ position: string; work: string;
      occurred_at: Date; delta: number }>(`SELECT c.position::text, c.work, c.occurred_at, c.delta
      FROM access.reader_review_rank_change c WHERE c.position > $1
      -- Qualified: a bare name would sort by the text alias, putting 10 before 5.
      ORDER BY c.position LIMIT $2`,
    [reviewAfter, RANKING_COST.sourceEvents])).rows;
    if (!reviewEvents.length && BigInt(reviewAfter) < BigInt(reviewHead.position)) {
      throw new RankingProjectionUnavailable('Review ranking source has a gap');
    }
    let reviewPosition = BigInt(reviewAfter);
    for (const event of reviewEvents) {
      if (BigInt(event.position) !== ++reviewPosition || !ID.test(event.work)) {
        throw new RankingProjectionUnavailable('Review ranking source is not contiguous');
      }
    }
    if (!events.length && BigInt(after) < BigInt(progressHead.sequence)) {
      throw new RankingProjectionUnavailable('Progress source has an outbox gap');
    }
    let sequence = BigInt(after);
    const signals: { event: ContentOutboxEvent; value: ProgressSignal }[] = [];
    for (const event of events) {
      if (event.position.dataEpoch !== owner.dataEpoch
        || BigInt(event.position.sequence) <= sequence) {
        throw new RankingProjectionUnavailable('Progress source is not ordered');
      }
      sequence = BigInt(event.position.sequence);
      signals.push({ event, value: await readProgressSignal(this.contentPool, event) });
    }
    type Retained = { source: 'content' | 'review'; position: string; target: string;
      source_event: ContentOutboxEvent | { work: string; occurred_at: string; delta: number } };
    const pending = reset ? [] : (await this.access.query<Retained>(`WITH targets AS MATERIALIZED (
      SELECT * FROM access.read_ranking_target WHERE generation=$1
      ORDER BY attempted_at,source,first_position LIMIT $2)
      SELECT event.source,event.position::text,event.target,event.source_event FROM targets t
      CROSS JOIN LATERAL (SELECT * FROM access.read_ranking_pending p
        WHERE p.generation=t.generation AND p.source=t.source AND p.position=t.first_position LIMIT 1) event`,
    [existing.generation, RANKING_COST.retryEvents])).rows;
    const retrySignals = new Map<string, ProgressSignal>();
    for (const row of pending) if (row.source === 'content') {
      const event = row.source_event as ContentOutboxEvent;
      if (event.position.dataEpoch !== owner.dataEpoch || event.position.sequence !== row.position) {
        throw new RankingProjectionUnavailable('Retained progress source differs');
      }
      let value: ProgressSignal;
      try { value = await readProgressSignal(this.contentPool, event); }
      catch { continue; } // Previously proven work stays pending if its source cannot be rechecked.
      if (value.structure !== row.target) throw new RankingProjectionUnavailable('Retained progress target differs');
      retrySignals.set(row.position, value);
    }
    const reviewRetries = pending.filter(row => row.source === 'review');
    if (reviewRetries.length) {
      const proofs = (await this.access.query<{ position: string; work: string; occurred_at: Date; delta: number }>(
        `SELECT position::text,work,occurred_at,delta FROM access.reader_review_rank_change
          WHERE position=ANY($1::bigint[])`, [reviewRetries.map(row => row.position)])).rows;
      for (const row of reviewRetries) {
        const retained = row.source_event as { work: string; occurred_at: string; delta: number };
        const proof = proofs.find(candidate => candidate.position === row.position);
        if (!proof || proof.work !== row.target || retained.work !== proof.work
          || retained.occurred_at !== proof.occurred_at.toISOString() || retained.delta !== proof.delta) {
          throw new RankingProjectionUnavailable('Retained Review source differs');
        }
      }
    }
    // Resolve the bounded Work set before any publication row is locked.
    // Otherwise a source can hold a later Work while waiting on this turn's
    // population row, producing a cycle across two targets.
    const rankedWorks = new Map<ProgressSignal, string | null>();
    for (const value of [...retrySignals.values(), ...signals.map(signal => signal.value)]) {
      try { rankedWorks.set(value, await this.rankedWork(value)); }
      catch { rankedWorks.set(value, null); }
    }
    const works = [...new Set([
      ...[...rankedWorks.values()].filter((work): work is string => work !== null),
      ...reviewEvents.map(event => event.work), ...reviewRetries.map(row => row.target),
    ])].sort();
    const client = await this.access.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT access.lock_read_ranking_works($1::text[])', [works]);
      const latest = await checkpoint(client);
      if (latest?.generation !== existing?.generation || latest?.contentSequence !== existing?.content_sequence
        || latest?.contentEpoch !== existing?.content_epoch || latest?.graphEpoch !== existing?.graph_epoch
        || latest?.reviewPosition !== existing?.review_position) {
        if (latest || existing) throw new RankingProjectionUnavailable('Ranking checkpoint changed concurrently');
      }
      const generation = reset ? randomUUID() : latest!.generation;
      if (reset) {
        await client.query(`INSERT INTO access.read_ranking_checkpoint
          (singleton, generation, content_epoch, content_sequence, graph_epoch, review_rebuild_position)
          VALUES (true,$1,$2,0,$3,$4) ON CONFLICT (singleton) DO UPDATE SET
          generation = EXCLUDED.generation, content_epoch = EXCLUDED.content_epoch,
          content_sequence = 0, content_scan_sequence = 0, review_position = 0, review_scan_position = 0, graph_epoch = EXCLUDED.graph_epoch,
          review_rebuild_position = EXCLUDED.review_rebuild_position,
          updated_at = clock_timestamp()`, [generation, owner.dataEpoch, this.env.lineage.dataEpoch,reviewHead.position]);
      }

      // Savepoints isolate a target's graph/admission/score failure. Retention and
      // scan advancement still commit together in this Access transaction.
      const apply = async (source: Retained['source'], position: string, target: string,
        sourceEvent: Retained['source_event'], value?: ProgressSignal, retry = false) => {
        // Another worker can settle a retained target without moving its scan
        // position. A cached retry must not apply or recreate that event again.
        if (retry && !(await client.query(`SELECT 1 FROM access.read_ranking_pending
          WHERE generation=$1 AND source=$2 AND position=$3`, [generation,source,position])).rowCount) return;
        const retained = await client.query(`SELECT position::text FROM access.read_ranking_pending
          WHERE generation = $1 AND source = $2 AND target = $3 AND position <= $4
          ORDER BY position LIMIT 1`, [generation, source, target, position]);
        if (retry && retained.rows[0]?.position !== position) return;
        const blocked = retained.rowCount && (!retry || retained.rows[0]?.position !== position);
        await client.query('SAVEPOINT ranking_target');
        try {
          if (blocked) throw new RankingProjectionUnavailable('Earlier target work remains pending');
          if (source === 'content' && !value) throw new RankingProjectionUnavailable('Retained progress proof is unavailable');
          const review = sourceEvent as { work: string; occurred_at: string; delta: number };
          const work = value ? rankedWorks.get(value) : review.work;
          if (!work) throw new RankingProjectionUnavailable('Progress Structure has no current Work');
          await refreshReadRankingAdmissions(this.env, this.access, [work], client);
          if (value) {
            const at = this.clock.at(new Date(value.occurredAt));
            for (const metric of progressRankingMetrics(value)) {
              for (const interval of intervals) await this.increment(client, generation, work, metric, interval, at);
            }
          } else {
            for (const interval of intervals) await this.changeReview(client, generation, work, interval,
              this.clock.at(new Date(review.occurred_at)), review.delta);
            if (review.delta < 0) await client.query(`DELETE FROM access.read_ranking_removal
              WHERE event_id=(SELECT id FROM access.reader_review_rank_change WHERE position=$1)`, [position]);
          }
          if (retry) {
            await client.query(`DELETE FROM access.read_ranking_pending
              WHERE generation=$1 AND source=$2 AND position=$3`, [generation, source, position]);
            await client.query(`INSERT INTO access.read_ranking_target(generation,source,target,first_position)
              SELECT generation,source,target,position FROM access.read_ranking_pending
              WHERE generation=$1 AND source=$2 AND target=$3 ORDER BY position LIMIT 1`, [generation, source, target]);
          }
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT ranking_target');
          // A generation replay can fail a negative event that an earlier
          // generation applied. Restore that source-owned removal fence too.
          if (source === 'review' && (sourceEvent as { delta: number }).delta < 0) {
            await client.query(`SELECT access.register_read_ranking_removal(id,work,occurred_at)
              FROM access.reader_review_rank_change WHERE position=$1`, [position]);
          }
          await client.query(`INSERT INTO access.read_ranking_pending
            (generation, source, position, target, source_event) VALUES ($1,$2,$3,$4,$5::jsonb)
            ON CONFLICT (generation, source, position) DO NOTHING`,
          [generation, source, position, target, JSON.stringify(sourceEvent)]);
          await client.query(`INSERT INTO access.read_ranking_target(generation,source,target,first_position)
            VALUES ($1,$2,$3,$4) ON CONFLICT (generation,source,target) DO NOTHING`, [generation, source, target, position]);
          if (retry) await client.query(`UPDATE access.read_ranking_target SET attempted_at=clock_timestamp()
            WHERE generation=$1 AND source=$2 AND target=$3 AND first_position=$4`, [generation, source, target, position]);
        }
        await client.query('RELEASE SAVEPOINT ranking_target');
      };
      for (const row of pending) await apply(row.source, row.position, row.target, row.source_event,
        row.source === 'content' ? retrySignals.get(row.position) : undefined, true);
      for (const { event, value } of signals) await apply('content', event.position.sequence,
        value.structure, event, value);
      for (const event of reviewEvents) await apply('review', event.position, event.work,
        { work: event.work, occurred_at: event.occurred_at.toISOString(), delta: event.delta });
      if (!events.length && sequence > BigInt(progressHead.sequence)) sequence = BigInt(progressHead.sequence);
      await client.query(`UPDATE access.read_ranking_checkpoint SET content_scan_sequence = $1,
        review_scan_position = $2,
        content_sequence = COALESCE((SELECT min(position) - 1 FROM access.read_ranking_pending
          WHERE generation = $3 AND source = 'content'), $1::bigint),
        review_position = COALESCE((SELECT min(position) - 1 FROM access.read_ranking_pending
          WHERE generation = $3 AND source = 'review'), $2::bigint),
        updated_at = CASE WHEN content_scan_sequence <> $1 OR review_scan_position <> $2
          OR $4::boolean THEN clock_timestamp() ELSE updated_at END WHERE singleton`,
      [String(sequence), String(reviewPosition), generation, pending.length > 0]);
      await client.query(`DELETE FROM access.read_ranking_pending WHERE ctid IN (
        SELECT ctid FROM access.read_ranking_pending WHERE generation <> $1 LIMIT $2)`, [generation, RANKING_COST.cleanupRows]);
      const cleanupAt = this.clock.at().toISOString();
      await client.query(`DELETE FROM access.read_ranking_score WHERE ctid IN (
        SELECT ctid FROM access.read_ranking_score
        WHERE generation <> $1 OR bucket < (date_trunc('month', $3::timestamptz AT TIME ZONE 'UTC')
          - interval '3 months')::date LIMIT $2)`, [generation, RANKING_COST.cleanupRows, cleanupAt]);
      await client.query(`DELETE FROM access.read_ranking_publication WHERE ctid IN (
        SELECT ctid FROM access.read_ranking_publication
        WHERE generation <> $1 OR bucket < (date_trunc('month', $3::timestamptz AT TIME ZONE 'UTC')
          - interval '3 months')::date LIMIT $2)`, [generation, RANKING_COST.cleanupRows, cleanupAt]);
      await client.query('COMMIT');
      return events.length + reviewEvents.length + pending.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  /** Strict source-progress diagnostic; admitted pages use capture instead. */
  async current(): Promise<RankingCheckpoint> {
    // The same reads the projection worker uses. A copied predicate here would
    // let this fence and that worker disagree about which head is current.
    // A page fences this twice, so each statement is counted twice.
    const owner = await this.content.ownerPosition();
    const progressHead = await this.progressHead(owner.dataEpoch);
    // Checkpoint and review source share one Access snapshot. Each page fences
    // twice, so a separate head read would add two statements to its cost.
    const row = (await this.access.query<{ generation: string; content_epoch: string;
      content_sequence: string; graph_epoch: string; review_position: string; updated_at: Date;
      review_head: string | null; review_pending: boolean; retained_pending: boolean; coverage_intact: boolean }>(`SELECT c.generation,
      c.content_epoch, c.content_sequence::text, c.graph_epoch, c.review_position::text, c.updated_at,
      h.position::text AS review_head,
      c.content_sequence = COALESCE((SELECT min(position) - 1 FROM access.read_ranking_pending
        WHERE generation=c.generation AND source='content'), c.content_scan_sequence)
      AND c.review_position = COALESCE((SELECT min(position) - 1 FROM access.read_ranking_pending
        WHERE generation=c.generation AND source='review'), c.review_scan_position) AS coverage_intact,
      EXISTS (SELECT 1 FROM access.read_ranking_pending p WHERE p.generation = c.generation) AS retained_pending,
      EXISTS (SELECT 1 FROM access.reader_review_rank_change WHERE position IS NULL) AS review_pending
      FROM access.read_ranking_checkpoint c
      LEFT JOIN access.reader_review_rank_head h ON h.singleton WHERE c.singleton`)).rows[0];
    if (!row || !row.coverage_intact || row.retained_pending || row.content_epoch !== owner.dataEpoch
      || row.graph_epoch !== this.env.lineage.dataEpoch
      || BigInt(row.content_sequence) > BigInt(owner.sequence)
      || row.review_head === null || BigInt(row.review_position) > BigInt(row.review_head)
      || (BigInt(row.content_sequence) < BigInt(progressHead.sequence) || progressHead.pending
        || row.review_position !== row.review_head || row.review_pending)
        && Date.now() - row.updated_at.getTime() > 60_000) {
      throw new RankingProjectionUnavailable('Rankings are catching up with owner events');
    }
    return { generation: row.generation, contentEpoch: row.content_epoch,
      contentSequence: row.content_sequence, graphEpoch: row.graph_epoch,
      reviewPosition: row.review_position };
  }

  private async validateCapture(row: RankingCaptureRow | undefined, population: RankingPopulation) {
    const owner = await this.content.ownerPosition();
    if (!row || !row.coverage_intact || row.content_epoch !== owner.dataEpoch
      || row.graph_epoch !== this.env.lineage.dataEpoch
      || row.rows.length > 0 && row.revision === '0'
      || BigInt(row.content_scan_sequence) > BigInt(owner.sequence)
      || row.review_head === null || BigInt(row.review_scan_position) > BigInt(row.review_head)) {
      throw new RankingProjectionUnavailable('Ranking population integrity is unavailable');
    }
    if (row.removal_pending) throw new RankingProjectionIncomplete(population);
    return row;
  }

  async capture(metric: RankingMetric, interval: RankingInterval, bucket: string,
    order: 'score' | 'growth', after: { value: string; work: string } | null, limit: number,
    realm: string | null = null): Promise<RankingPopulationCapture> {
    if (!['reads','finished-chapters','reviews'].includes(metric) || !intervals.includes(interval)
      || !/^\d{4}-\d{2}-\d{2}$/.test(bucket) || !['score','growth'].includes(order)
      || !Number.isInteger(limit) || limit < 1 || limit > RANKING_COST.pageCandidates
      || realm !== null && !ID.test(realm)
      || after && (!/^-?\d+$/.test(after.value) || !ID.test(after.work))) {
      throw new RankingProjectionUnavailable('Invalid ranking window');
    }
    const population = { metric,interval,bucket,context: realm ?? 'urn:rezics:context:global' };
    const row = await this.validateCapture(await captureRankingPopulation(this.access,population,order,after,limit),population);
    return { checkpoint: { generation: row.generation,contentEpoch: row.content_epoch,
      contentSequence: row.content_sequence,graphEpoch: row.graph_epoch,reviewPosition: row.review_position },
    revision: row.revision,removalRevision: row.removal_revision,rows: row.rows,population };
  }

  async fence(capture: RankingPopulationCapture): Promise<boolean> {
    const row = await this.validateCapture(await fenceRankingPopulation(this.access,capture),capture.population);
    if (row.generation !== capture.checkpoint.generation) {
      throw new RankingProjectionUnavailable('Ranking generation changed');
    }
    if (row.removal_revision !== capture.removalRevision) {
      throw new RankingProjectionIncomplete(capture.population);
    }
    return !row.removed;
  }

  /** Two index probes, independent of the number of unrelated Content events. */
  private async progressHead(dataEpoch: string): Promise<{ sequence: string; pending: boolean }> {
    return (await this.contentPool.query<{ sequence: string; pending: boolean }>(`SELECT
      COALESCE((SELECT sequence::text FROM content.outbox WHERE data_epoch = $1
        AND recipe = 'structure-progress-v1' AND sequence IS NOT NULL ORDER BY content.outbox.sequence DESC LIMIT 1),'0') AS sequence,
      EXISTS (SELECT 1 FROM content.outbox WHERE recipe = 'structure-progress-v1'
        AND sequence IS NULL) AS pending`, [dataEpoch])).rows[0]!;
  }

  async candidates(generation: string, metric: RankingMetric, interval: RankingInterval,
    bucket: string, order: 'score' | 'growth', after: { value: string; work: string } | null, limit: number,
    realm: string | null = null) {
    if (!/^[0-9a-f-]{36}$/.test(generation) || !['reads', 'finished-chapters', 'reviews'].includes(metric)
      || !intervals.includes(interval) || !/^\d{4}-\d{2}-\d{2}$/.test(bucket)
      || !['score', 'growth'].includes(order)
      || !Number.isInteger(limit) || limit < 1 || limit > RANKING_COST.pageCandidates
      || after && (!/^-?\d+$/.test(after.value) || !ID.test(after.work))) {
      throw new RankingProjectionUnavailable('Invalid ranking window');
    }
    const key = order === 'score' ? 'score' : 'growth';
    const result = await this.access.query<{ work: string; score: string; growth: string }>(
      `SELECT work, score::text, growth::text FROM access.read_ranking_admitted AS admitted
       WHERE generation = $1 AND metric = $2 AND interval = $3 AND bucket = $4 AND context=$8
         ${order === 'growth' ? 'AND growth > 0' : ''}
         AND ($5::bigint IS NULL OR ${key} < $5::bigint
           OR (${key} = $5::bigint AND work > $6::text))
       ORDER BY admitted.${key} DESC, work LIMIT $7`,
      [generation, metric, interval, bucket, after?.value ?? null, after?.work ?? '', limit,
        realm ?? 'urn:rezics:context:global']);
    return result.rows;
  }
}
