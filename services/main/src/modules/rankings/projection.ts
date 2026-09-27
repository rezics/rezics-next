import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ContentCore } from '../../../../content/src/core.ts';
import { readProgressSignal, type ProgressSignal } from '../structure/progress-outbox.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';

export const RANKING_COST = { sourceEvents: 32, graphRowsPerEvent: 2,
  pageCandidates: 100, pageSize: 20, cleanupRows: 500, deadlineMs: 10_000 } as const;
export type RankingMetric = 'reads' | 'finished-chapters';
export type RankingInterval = 'day' | 'week' | 'month';
const intervals: readonly RankingInterval[] = ['day', 'week', 'month'];
const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export class RankingProjectionUnavailable extends Error {}
export interface RankingCheckpoint { generation: string; contentEpoch: string;
  contentSequence: string; graphEpoch: string }

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
    content_sequence: string; graph_epoch: string }>(`SELECT generation, content_epoch,
      content_sequence::text, graph_epoch FROM access.read_ranking_checkpoint
      WHERE singleton FOR UPDATE`)).rows[0];
  return row ? { generation: row.generation, contentEpoch: row.content_epoch,
    contentSequence: row.content_sequence, graphEpoch: row.graph_epoch } : null;
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
      this.running = this.tick().catch(error => { console.error('read ranking projection deferred', error); })
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

  async tick(): Promise<number> {
    const owner = await this.content.ownerPosition();
    const existing = (await this.access.query<{ generation: string; content_epoch: string;
      content_sequence: string; graph_epoch: string }>(`SELECT generation, content_epoch,
      content_sequence::text, graph_epoch FROM access.read_ranking_checkpoint WHERE singleton`)).rows[0];
    const reset = !existing || existing.content_epoch !== owner.dataEpoch
      || existing.graph_epoch !== this.env.lineage.dataEpoch
      || BigInt(existing.content_sequence) > BigInt(owner.sequence);
    const after = reset ? '0' : existing.content_sequence;
    const events = await this.content.readOutbox(owner.dataEpoch, after, RANKING_COST.sourceEvents);
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
        || latest?.contentEpoch !== existing?.content_epoch || latest?.graphEpoch !== existing?.graph_epoch) {
        if (latest || existing) throw new RankingProjectionUnavailable('Ranking checkpoint changed concurrently');
      }
      const generation = reset ? randomUUID() : latest!.generation;
      if (reset) {
        await client.query(`INSERT INTO access.read_ranking_checkpoint
          (singleton, generation, content_epoch, content_sequence, graph_epoch)
          VALUES (true,$1,$2,0,$3) ON CONFLICT (singleton) DO UPDATE SET
          generation = EXCLUDED.generation, content_epoch = EXCLUDED.content_epoch,
          content_sequence = 0, graph_epoch = EXCLUDED.graph_epoch,
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
      if (events.length) await client.query(`UPDATE access.read_ranking_checkpoint
        SET content_sequence = $1, updated_at = clock_timestamp() WHERE singleton`, [String(sequence)]);
      await client.query(`DELETE FROM access.read_ranking_score WHERE ctid IN (
        SELECT ctid FROM access.read_ranking_score
        WHERE generation <> $1 OR bucket < (date_trunc('month', now() AT TIME ZONE 'UTC')
          - interval '3 months')::date LIMIT $2)`, [generation, RANKING_COST.cleanupRows]);
      await client.query('COMMIT');
      return events.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async current(): Promise<RankingCheckpoint> {
    const owner = await this.content.ownerPosition();
    const row = (await this.access.query<{ generation: string; content_epoch: string;
      content_sequence: string; graph_epoch: string; updated_at: Date }>(`SELECT generation,
      content_epoch, content_sequence::text, graph_epoch, updated_at
      FROM access.read_ranking_checkpoint WHERE singleton`)).rows[0];
    if (!row || row.content_epoch !== owner.dataEpoch
      || BigInt(row.content_sequence) > BigInt(owner.sequence)
      || row.graph_epoch !== this.env.lineage.dataEpoch
      || row.content_sequence !== owner.sequence
        && Date.now() - row.updated_at.getTime() > 60_000) {
      throw new RankingProjectionUnavailable('Rankings are catching up with Content');
    }
    return { generation: row.generation, contentEpoch: row.content_epoch,
      contentSequence: row.content_sequence, graphEpoch: row.graph_epoch };
  }

  async candidates(generation: string, metric: RankingMetric, interval: RankingInterval,
    bucket: string, order: 'score' | 'growth', after: { value: string; work: string } | null, limit: number) {
    if (!/^[0-9a-f-]{36}$/.test(generation) || !['reads', 'finished-chapters'].includes(metric)
      || !intervals.includes(interval) || !/^\d{4}-\d{2}-\d{2}$/.test(bucket)
      || !['score', 'growth'].includes(order)
      || !Number.isInteger(limit) || limit < 1 || limit > RANKING_COST.pageCandidates
      || after && (!/^-?\d+$/.test(after.value) || !ID.test(after.work))) {
      throw new RankingProjectionUnavailable('Invalid ranking window');
    }
    const key = order === 'score' ? 'score' : 'growth';
    const result = await this.access.query<{ work: string; score: string; growth: string }>(
      `SELECT work, score::text, growth::text FROM access.read_ranking_score
       WHERE generation = $1 AND metric = $2 AND interval = $3 AND bucket = $4
         ${order === 'growth' ? 'AND growth > 0' : ''}
         AND ($5::bigint IS NULL OR ${key} < $5::bigint
           OR (${key} = $5::bigint AND work > $6::text))
       ORDER BY ${key} DESC, work LIMIT $7`,
      [generation, metric, interval, bucket, after?.value ?? null, after?.work ?? '', limit]);
    return result.rows;
  }
}
