import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withWorkerTelemetry } from '@rezics/observability/runtime';
import type { ContentCore } from '../../../../content/src/core.ts';
import { readProgressSignal, type ProgressSignal } from '../structure/progress-outbox.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { refreshReadRankingAdmissions } from '../feed/ranking-admission.ts';

export const RANKING_COST = { sourceEvents: 32, graphRowsPerEvent: 2,
  pageCandidates: 100, pageSize: 20, cleanupRows: 500, deadlineMs: 10_000 } as const;
export type RankingMetric = 'reads' | 'finished-chapters' | 'reviews';
export type RankingInterval = 'day' | 'week' | 'month';
const intervals: readonly RankingInterval[] = ['day', 'week', 'month'];
const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export class RankingProjectionUnavailable extends Error {}
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
    content_sequence: string; graph_epoch: string; review_position: string }>(`SELECT generation, content_epoch,
      content_sequence::text, graph_epoch, review_position::text FROM access.read_ranking_checkpoint
      WHERE singleton FOR UPDATE`)).rows[0];
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
    private readonly contentPool: Pool, private readonly env: WorkActivationEnvironment) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = withWorkerTelemetry('main.read-ranking.projection', () => this.tick(), count => ({
        outcome: count ? 'worked' : 'idle', processed: count, unit: 'event',
      })).catch(error => { console.error('read ranking projection deferred', error); })
        .finally(() => { this.running = undefined; });
    }, 500);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
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
    const cutoff = new Date();
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
    const owner = await this.content.ownerPosition();
    const existing = (await this.access.query<{ generation: string; content_epoch: string;
      content_sequence: string; graph_epoch: string; review_position: string }>(`SELECT generation, content_epoch,
      content_sequence::text, graph_epoch, review_position::text FROM access.read_ranking_checkpoint WHERE singleton`)).rows[0];
    const reviewHead = (await this.access.query<{ position: string }>(`SELECT position::text
      FROM access.reader_review_rank_head WHERE singleton`)).rows[0];
    if (!reviewHead) throw new RankingProjectionUnavailable('Review ranking source is unavailable');
    const reset = !existing || existing.content_epoch !== owner.dataEpoch
      || existing.graph_epoch !== this.env.lineage.dataEpoch
      || BigInt(existing.content_sequence) > BigInt(owner.sequence)
      || BigInt(existing.review_position) > BigInt(reviewHead.position);
    const after = reset ? '0' : existing.content_sequence;
    const events = await this.content.readOutbox(owner.dataEpoch, after, RANKING_COST.sourceEvents);
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
    if (!events.length && BigInt(after) < BigInt(owner.sequence)) {
      throw new RankingProjectionUnavailable('Content source has an outbox gap');
    }
    let sequence = BigInt(after);
    const signals: { value: ProgressSignal; work: string }[] = [];
    for (const event of events) {
      if (event.position.dataEpoch !== owner.dataEpoch
        || BigInt(event.position.sequence) !== sequence + 1n) {
        throw new RankingProjectionUnavailable('Content source is not contiguous');
      }
      sequence++;
      if (event.recipe === 'structure-progress-v1') {
        const value = await readProgressSignal(this.contentPool, event);
        const work = await this.graphWork(value.structure);
        if (!work) throw new RankingProjectionUnavailable('Progress Structure has no current Work');
        signals.push({ value, work });
      }
    }
    const client = await this.access.connect();
    try {
      await client.query('BEGIN');
      const latest = await checkpoint(client);
      if (latest?.generation !== existing?.generation || latest?.contentSequence !== existing?.content_sequence
        || latest?.contentEpoch !== existing?.content_epoch || latest?.graphEpoch !== existing?.graph_epoch
        || latest?.reviewPosition !== existing?.review_position) {
        if (latest || existing) throw new RankingProjectionUnavailable('Ranking checkpoint changed concurrently');
      }
      const generation = reset ? randomUUID() : latest!.generation;
      await refreshReadRankingAdmissions(this.env,this.access,
        [...signals.map(signal => signal.work), ...reviewEvents.map(event => event.work)],client);
      if (reset) {
        await client.query(`INSERT INTO access.read_ranking_checkpoint
          (singleton, generation, content_epoch, content_sequence, graph_epoch)
          VALUES (true,$1,$2,0,$3) ON CONFLICT (singleton) DO UPDATE SET
          generation = EXCLUDED.generation, content_epoch = EXCLUDED.content_epoch,
          content_sequence = 0, review_position = 0, graph_epoch = EXCLUDED.graph_epoch,
          updated_at = clock_timestamp()`, [generation, owner.dataEpoch, this.env.lineage.dataEpoch]);
      }
      for (const { value, work } of signals) {
        const at = new Date(value.occurredAt);
        for (const [enabled, metric] of [[value.read, 'reads'],
          [value.finished, 'finished-chapters']] as const) {
          if (enabled) for (const interval of intervals) {
            await this.increment(client, generation, work, metric, interval, at);
          }
        }
      }
      for (const event of reviewEvents) {
        for (const interval of intervals) {
          await this.changeReview(client, generation, event.work, interval, event.occurred_at, event.delta);
        }
      }
      if (events.length) await client.query(`UPDATE access.read_ranking_checkpoint
        SET content_sequence = $1, updated_at = clock_timestamp() WHERE singleton`, [String(sequence)]);
      if (reviewEvents.length) await client.query(`UPDATE access.read_ranking_checkpoint
        SET review_position = $1, updated_at = clock_timestamp() WHERE singleton`, [String(reviewPosition)]);
      await client.query(`DELETE FROM access.read_ranking_score WHERE ctid IN (
        SELECT ctid FROM access.read_ranking_score
        WHERE generation <> $1 OR bucket < (date_trunc('month', now() AT TIME ZONE 'UTC')
          - interval '3 months')::date LIMIT $2)`, [generation, RANKING_COST.cleanupRows]);
      await client.query('COMMIT');
      return events.length + reviewEvents.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async current(): Promise<RankingCheckpoint> {
    const owner = await this.content.ownerPosition();
    const row = (await this.access.query<{ generation: string; content_epoch: string;
      content_sequence: string; graph_epoch: string; review_position: string; updated_at: Date }>(`SELECT generation,
      content_epoch, content_sequence::text, graph_epoch, review_position::text, updated_at
      FROM access.read_ranking_checkpoint WHERE singleton`)).rows[0];
    const reviewHead = (await this.access.query<{ position: string }>(`SELECT position::text
      FROM access.reader_review_rank_head WHERE singleton`)).rows[0];
    if (!row || row.content_epoch !== owner.dataEpoch
      || BigInt(row.content_sequence) > BigInt(owner.sequence)
      || row.graph_epoch !== this.env.lineage.dataEpoch
      || !reviewHead || BigInt(row.review_position) > BigInt(reviewHead.position)
      || (row.content_sequence !== owner.sequence || row.review_position !== reviewHead.position)
        && Date.now() - row.updated_at.getTime() > 60_000) {
      throw new RankingProjectionUnavailable('Rankings are catching up with owner events');
    }
    return { generation: row.generation, contentEpoch: row.content_epoch,
      contentSequence: row.content_sequence, graphEpoch: row.graph_epoch,
      reviewPosition: row.review_position };
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
