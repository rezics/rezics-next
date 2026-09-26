import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { checkedRunKey, OPEN_LIBRARY_WORKS_RUN, recentChangeIds, SourceRunConflict, SourceRunInvalid,
  SourceRunUnavailable, type CaptureRequest, type SourceRunStore } from './acquisition-run.ts';
import type { FeedContinuity } from './run-schema.ts';

export class SourceFeedStale extends Error {}

export const OPEN_LIBRARY_CHANGES_FEED = 'open-library-recent-changes-v1';
export const OPEN_LIBRARY_CHANGES_RUN = 'open-library-recent-changes-run-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iri = (id: string) => `https://rezics.com/id/${id}`;

export interface FeedCheckpointView {
  checkpoint: string;
  seq: number;
  kind: 'baseline' | 'change' | 'reconciliation';
  continuity: FeedContinuity;
  from: string;
  to: string;
  itemCount: number;
  run: string;
  observation: string | null;
}

export interface SourceFeedView {
  profile: 'source-feed-v1';
  feed: string;
  acquisitionProfile: typeof OPEN_LIBRARY_CHANGES_FEED;
  pageItems: number;
  head: null | { seq: number; position: string; checkpoint: string; resumeToken: string | null };
  openGaps: Array<{ checkpoint: string; from: string; to: string }>;
  recent: FeedCheckpointView[];
}

export interface SourceFeedWindow {
  profile: 'source-feed-window-v1';
  feed: string;
  run: string;
  state: 'committed' | 'failed' | 'stale-head';
  floor: string | null;
  checkpoints: FeedCheckpointView[];
  changes: Array<{ position: string; records: string[] }>;
}

interface Page { captureId: string; observationId: string; items: Array<{ id: bigint; keys: string[] }> }

function changesRequest(pageItems: number, page: number): CaptureRequest {
  const offset = page * pageItems;
  return { requestKey: `GET /recentchanges.json?limit=${pageItems}&offset=${offset}`,
    path: `/recentchanges.json?limit=${pageItems}&offset=${offset}`, namespace: 'recent-changes',
    externalId: 'recentchanges', coverageScope: 'open-library-recent-changes-page-v1',
    captureProfile: 'open-library-run-capture-v1',
    validate: parsed => {
      const ids = recentChangeIds(parsed);
      return ids && ids.length <= pageItems ? null : 'malformed';
    } };
}

function changedKeys(item: { key?: unknown; changes?: unknown }): string[] {
  let changes = item.changes;
  // The provider serializes `changes` as a JSON string; an unreadable list keeps only the entry key.
  if (typeof changes === 'string') { try { changes = JSON.parse(changes); } catch { changes = []; } }
  const keys = [item.key, ...(Array.isArray(changes) ? changes.map(change => (change as { key?: unknown })?.key) : [])];
  return [...new Set(keys.filter((key): key is string => typeof key === 'string' && key.length <= 200))];
}

function pageItems(bytes: Buffer): Page['items'] {
  const parsed = JSON.parse(bytes.toString('utf8')) as Array<{ id: string | number; key?: unknown; changes?: unknown }>;
  return parsed.map(item => ({ id: BigInt(item.id), keys: changedKeys(item) }));
}

/**
 * Derive inclusive page ranges oldest-first. Adjacent offset pages leave no provider change
 * between them, so a later page covers from the older page's end; only the oldest page can
 * open a gap below the floor. The owner trigger re-derives the same continuity.
 */
export function windowRanges(pages: ReadonlyArray<{ ids: readonly bigint[] }>, floor: bigint):
  Array<{ index: number; from: bigint; to: bigint; continuity: FeedContinuity }> {
  const ranges: Array<{ index: number; from: bigint; to: bigint; continuity: FeedContinuity }> = [];
  let position = floor;
  let previousTo: bigint | null = null;
  for (let index = pages.length - 1; index >= 0; index--) {
    const ids = pages[index]!.ids;
    if (!ids.length) {
      if (index === 0 && previousTo === null) ranges.push({ index, from: floor, to: floor, continuity: 'overlap' });
      continue;
    }
    const min = ids.reduce((a, b) => a < b ? a : b);
    const max = ids.reduce((a, b) => a > b ? a : b);
    const from = previousTo === null || min <= previousTo ? min : previousTo + 1n;
    const continuity: FeedContinuity = from <= position ? 'overlap' : from === position + 1n ? 'contiguous' : 'gap';
    ranges.push({ index, from, to: max, continuity });
    position = position > max ? position : max;
    previousTo = max;
  }
  return ranges;
}

export class SourceFeedStore {
  constructor(private readonly pool: Pool, private readonly runs: SourceRunStore) {}

  async create(principalId: string, items: number): Promise<{ feed: SourceFeedView; created: boolean }> {
    if (!UUID.test(principalId) || !Number.isInteger(items) || items < 1 || items > 100) {
      throw new SourceRunInvalid('invalid source feed');
    }
    const id = Bun.randomUUIDv7();
    const inserted = await this.pool.query(`INSERT INTO source.feed (id, principal_id, provider, namespace, feed_key,
      position_scheme, max_page_items) VALUES ($1,$2,'open-library','recent-changes','recentchanges',
      'provider-sequence',$3) ON CONFLICT (principal_id, provider, namespace, feed_key) DO NOTHING`,
    [id, principalId, items]);
    const row = (await this.pool.query<{ id: string; max_page_items: number }>(`SELECT id, max_page_items
      FROM source.feed WHERE principal_id = $1 AND provider = 'open-library' AND namespace = 'recent-changes'
        AND feed_key = 'recentchanges'`, [principalId])).rows[0];
    if (!row) throw new SourceRunUnavailable('source feed is unavailable');
    if (row.max_page_items !== items) throw new SourceRunConflict('source feed exists with another page size');
    return { feed: (await this.read(principalId, row.id))!, created: inserted.rowCount === 1 };
  }

  /** Bootstrap from a completed run whose frontier capture precedes its record captures. */
  async baseline(principalId: string, feedId: string, runId: string):
    Promise<{ feed: SourceFeedView; checkpoint: FeedCheckpointView; replayed: boolean } | null> {
    if (![principalId, feedId, runId].every(id => UUID.test(id))) throw new SourceRunInvalid('invalid source feed baseline');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      const head = (await client.query<{ seq: number; checkpoint_id: string | null }>(`SELECT h.seq, h.checkpoint_id
        FROM source.feed_head h JOIN source.feed f ON f.id = h.feed_id
        WHERE h.feed_id = $1 AND f.principal_id = $2 FOR UPDATE OF h`, [feedId, principalId])).rows[0];
      if (!head) { await client.query('ROLLBACK'); return null; }
      const prior = await client.query<{ id: string }>(`SELECT id FROM source.feed_checkpoint
        WHERE feed_id = $1 AND run_id = $2 AND kind = 'baseline'`, [feedId, runId]);
      if (prior.rows[0]) {
        await client.query('COMMIT');
        return { feed: (await this.read(principalId, feedId))!, checkpoint: (await this.checkpoint(prior.rows[0].id))!,
          replayed: true };
      }
      const frontier = (await client.query<{ profile: string; completion: string | null; raw_bytes: Buffer | null }>(
        `SELECT r.profile, c.outcome AS completion, o.raw_bytes FROM source.acquisition_run r
         LEFT JOIN source.acquisition_run_completion c ON c.run_id = r.id
         LEFT JOIN source.run_surface_outcome s ON s.run_id = r.id AND s.surface = 'frontier' AND s.outcome = 'qualified'
         LEFT JOIN source.run_capture rc ON rc.run_id = s.run_id AND rc.surface = s.surface
         LEFT JOIN source.observation o ON o.id = rc.observation_id
         WHERE r.id = $1 AND r.principal_id = $2`, [runId, principalId])).rows[0];
      if (!frontier) { await client.query('ROLLBACK'); return null; }
      if (frontier.profile !== OPEN_LIBRARY_WORKS_RUN || frontier.completion !== 'completed' || !frontier.raw_bytes) {
        throw new SourceFeedStale('baseline needs a completed run with a captured frontier');
      }
      const ids = recentChangeIds(JSON.parse(frontier.raw_bytes.toString('utf8'))) ?? [];
      const position = ids.reduce((a, b) => a > b ? a : b, 0n);
      const id = Bun.randomUUIDv7();
      await client.query(`INSERT INTO source.feed_checkpoint (id, feed_id, seq, predecessor_id, kind, run_id,
        capture_id, from_position, to_position, resume_token, item_count, continuity)
        VALUES ($1,$2,$3,$4,'baseline',$5,NULL,0,$6,$7,0,'baseline')`,
      [id, feedId, head.seq + 1, head.checkpoint_id, runId, position.toString(), `change:${position}`]);
      await client.query('COMMIT');
      return { feed: (await this.read(principalId, feedId))!, checkpoint: (await this.checkpoint(id))!, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  /** Phase 1: freeze newest-first change pages in a run until they reach the head or the budget. */
  async captureWindow(principalId: string, feedId: string, key: string, maxPages: number):
    Promise<{ runId: string; created: boolean } | null> {
    checkedRunKey(principalId, key);
    if (!UUID.test(feedId) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 8) {
      throw new SourceRunInvalid('invalid source feed window');
    }
    const feed = (await this.pool.query<{ max_page_items: number; seq: number; position: string | null;
      checkpoint_id: string | null }>(`SELECT f.max_page_items, h.seq, h.position::text, h.checkpoint_id
      FROM source.feed f JOIN source.feed_head h ON h.feed_id = f.id WHERE f.id = $1 AND f.principal_id = $2`,
    [feedId, principalId])).rows[0];
    if (!feed) return null;
    if (feed.position === null) throw new SourceFeedStale('source feed needs a baseline first');
    const digest = createHash('sha256').update(JSON.stringify({ feed: feedId, maxPages,
      pageItems: feed.max_page_items })).digest('hex');
    const started = await this.runs.start(principalId, key, this.runs.openLibraryAdapter.provider,
      OPEN_LIBRARY_CHANGES_RUN, digest, [{ surface: 'changes', namespace: 'recent-changes', required: true,
        captureLimit: maxPages }],
      this.runs.openLibraryAdapter.termsReference);
    await this.runs.exclusive(started.runId, async () => {
      if ((await this.runs.settledSurfaces(started.runId)).has('changes')) return;
      const floor = BigInt(feed.position!);
      for (let page = 0; page < maxPages; page++) {
        const result = await this.runs.acquire(principalId, started.runId, 'changes',
          changesRequest(feed.max_page_items, page), this.runs.openLibraryAdapter);
        if (!result.ok) {
          await this.runs.settle(started.runId, 'changes', result.outcome, result.reason, { page });
          return;
        }
        const ids = recentChangeIds(result.parsed)!;
        if (!ids.length || ids.some(id => id <= floor) || ids.length < feed.max_page_items) break;
      }
      await this.runs.settle(started.runId, 'changes', 'qualified', 'complete',
        { floor: floor.toString(), headCheckpoint: feed.checkpoint_id, headSeq: feed.seq });
    });
    return started;
  }

  /** Phase 2: append the frozen pages as checkpoints on the exact head they were read against. */
  async commitWindow(principalId: string, feedId: string, runId: string): Promise<SourceFeedWindow> {
    const client = await this.pool.connect();
    let state: SourceFeedWindow['state'] = 'committed';
    let floor: bigint | null = null;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const head = (await client.query<{ seq: number; checkpoint_id: string | null }>(`SELECT h.seq, h.checkpoint_id
        FROM source.feed_head h JOIN source.feed f ON f.id = h.feed_id
        WHERE h.feed_id = $1 AND f.principal_id = $2 FOR UPDATE OF h`, [feedId, principalId])).rows[0];
      const outcome = (await client.query<{ outcome: string; detail: { floor?: string; headCheckpoint?: string | null } }>(
        `SELECT outcome, detail FROM source.run_surface_outcome WHERE run_id = $1 AND surface = 'changes'`,
        [runId])).rows[0];
      if (!head || !outcome) throw new SourceRunUnavailable('source feed window is unavailable');
      const committed = await client.query('SELECT 1 FROM source.feed_checkpoint WHERE feed_id = $1 AND run_id = $2',
        [feedId, runId]);
      if (outcome.outcome !== 'qualified') state = 'failed';
      else {
        floor = BigInt(outcome.detail.floor!);
        if (!committed.rowCount && head.checkpoint_id !== outcome.detail.headCheckpoint) state = 'stale-head';
      }
      if (state === 'committed' && !committed.rowCount) {
        const pages = await this.pages(client, runId);
        let predecessor = head.checkpoint_id;
        let seq = head.seq;
        for (const range of windowRanges(pages.map(page => ({ ids: page.items.map(item => item.id) })), floor!)) {
          const page = pages[range.index]!;
          const id = Bun.randomUUIDv7();
          seq += 1;
          await client.query(`INSERT INTO source.feed_checkpoint (id, feed_id, seq, predecessor_id, kind, run_id,
            capture_id, from_position, to_position, resume_token, item_count, continuity)
            VALUES ($1,$2,$3,$4,'change',$5,$6,$7,$8,$9,$10,$11)`,
          [id, feedId, seq, predecessor, runId, page.captureId, range.from.toString(), range.to.toString(),
            `change:${range.to}`, page.items.length, range.continuity]);
          predecessor = id;
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
    await this.runs.complete(runId);
    return this.window(feedId, runId, state, floor);
  }

  async advance(principalId: string, feedId: string, key: string, maxPages: number):
    Promise<{ window: SourceFeedWindow; replayed: boolean } | null> {
    const started = await this.captureWindow(principalId, feedId, key, maxPages);
    if (!started) return null;
    return { window: await this.commitWindow(principalId, feedId, started.runId), replayed: !started.created };
  }

  private async pages(client: Pick<PoolClient, 'query'>, runId: string): Promise<Page[]> {
    const rows = await client.query<{ id: string; observation_id: string; raw_bytes: Buffer; byte_digest: string }>(
      `SELECT c.id, c.observation_id, o.raw_bytes, o.byte_digest FROM source.run_capture c
       JOIN source.observation o ON o.id = c.observation_id
       WHERE c.run_id = $1 AND c.surface = 'changes' ORDER BY c.ordinal`, [runId]);
    return rows.rows.map(row => {
      if (createHash('sha256').update(row.raw_bytes).digest('hex') !== row.byte_digest) {
        throw new SourceRunUnavailable('frozen feed page digest differs');
      }
      return { captureId: row.id, observationId: row.observation_id, items: pageItems(row.raw_bytes) };
    });
  }

  private async window(feedId: string, runId: string, state: SourceFeedWindow['state'],
    floor: bigint | null): Promise<SourceFeedWindow> {
    const rows = await this.pool.query<{ id: string }>(
      'SELECT id FROM source.feed_checkpoint WHERE feed_id = $1 AND run_id = $2 ORDER BY seq', [feedId, runId]);
    const checkpoints = await Promise.all(rows.rows.map(row => this.checkpoint(row.id)));
    const changes = new Map<bigint, string[]>();
    if (floor !== null && checkpoints.length) {
      const client = await this.pool.connect();
      try {
        for (const page of await this.pages(client, runId)) {
          // Items at or below the floor were already consumed: overlap deduplicates here.
          for (const item of page.items) {
            if (item.id > floor) changes.set(item.id, [...new Set([...changes.get(item.id) ?? [], ...item.keys])]);
          }
        }
      } finally { client.release(); }
    }
    return { profile: 'source-feed-window-v1', feed: iri(feedId), run: iri(runId), state,
      floor: floor?.toString() ?? null, checkpoints: checkpoints.map(checkpoint => checkpoint!),
      changes: [...changes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([position, records]) => ({ position: position.toString(), records })) };
  }

  private async checkpoint(id: string): Promise<FeedCheckpointView | null> {
    const row = (await this.pool.query<{ id: string; seq: number; kind: FeedCheckpointView['kind'];
      continuity: FeedContinuity; from_position: string; to_position: string; item_count: number; run_id: string;
      observation_id: string | null }>(`SELECT k.id, k.seq, k.kind, k.continuity, k.from_position::text,
      k.to_position::text, k.item_count, k.run_id, c.observation_id FROM source.feed_checkpoint k
      LEFT JOIN source.run_capture c ON c.id = k.capture_id WHERE k.id = $1`, [id])).rows[0];
    return row ? { checkpoint: iri(row.id), seq: row.seq, kind: row.kind, continuity: row.continuity,
      from: row.from_position, to: row.to_position, itemCount: row.item_count, run: iri(row.run_id),
      observation: row.observation_id ? iri(row.observation_id) : null } : null;
  }

  async read(principalId: string, feedId: string): Promise<SourceFeedView | null> {
    if (!UUID.test(principalId) || !UUID.test(feedId)) throw new SourceRunInvalid('invalid source feed identity');
    const feed = (await this.pool.query<{ max_page_items: number; seq: number; position: string | null;
      checkpoint_id: string | null; resume_token: string | null }>(`SELECT f.max_page_items, h.seq, h.position::text,
      h.checkpoint_id, k.resume_token FROM source.feed f JOIN source.feed_head h ON h.feed_id = f.id
      LEFT JOIN source.feed_checkpoint k ON k.id = h.checkpoint_id
      WHERE f.id = $1 AND f.principal_id = $2`, [feedId, principalId])).rows[0];
    if (!feed) return null;
    const gaps = await this.pool.query<{ checkpoint_id: string; gap_from: string; gap_to: string }>(
      `SELECT checkpoint_id, gap_from::text, gap_to::text FROM source.feed_open_gap WHERE feed_id = $1
       ORDER BY gap_from LIMIT 64`, [feedId]);
    const recent = await this.pool.query<{ id: string }>(
      'SELECT id FROM source.feed_checkpoint WHERE feed_id = $1 ORDER BY seq DESC LIMIT 20', [feedId]);
    return { profile: 'source-feed-v1', feed: iri(feedId), acquisitionProfile: OPEN_LIBRARY_CHANGES_FEED,
      pageItems: feed.max_page_items,
      head: feed.checkpoint_id ? { seq: feed.seq, position: feed.position!, checkpoint: iri(feed.checkpoint_id),
        resumeToken: feed.resume_token } : null,
      openGaps: gaps.rows.map(gap => ({ checkpoint: iri(gap.checkpoint_id), from: gap.gap_from, to: gap.gap_to })),
      recent: (await Promise.all(recent.rows.map(row => this.checkpoint(row.id)))).map(item => item!) };
  }
}
