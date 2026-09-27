import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { controlTransaction, ControlConflict, ControlInvalid, ControlStale } from '../access/topology-control.ts';
import { followPrincipal } from '../follows/authority.ts';
import { commandKey } from '../follows/store.ts';
import { digest } from '../recommendation/derived-generation.ts';
import { WorkReadMoved, WorkReadUnavailable, type ReadPosition } from '../work/read-session.ts';
import { FEED_COST, type FeedVoteCommand, type FeedVoteResult, type FeedQuery } from './contract.ts';
import { activityTime, bestKey, FEED_RANKING, rankCandidates } from './ranking.ts';
import type { FeedSource, FeedReference } from './source.ts';

export interface FeedCheckpoint { data_epoch: string; sequence: string; after_id: string; revision: string;
  rebuild_epoch: string | null; rebuild_after: string }
export interface FeedRow { id: string; kind: FeedSource['kind']; occurred_at: Date;
  time_basis: 'revision' | 'relay'; realm: string | null; group_key: string; group_members: string[]; sort_time: Date; score: number; order_key: string; vote: -1 | 0 | 1; vote_revision: string | null }
export class FeedStore {
  constructor(private readonly pool: Pool) {}

  async checkpoint(epoch: string): Promise<FeedCheckpoint> {
    return controlTransaction(this.pool, async client => {
      const row = (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id')).rows[0];
      if (!row) throw new WorkReadUnavailable('Feed projection is starting');
      if (row.data_epoch !== epoch) throw new WorkReadUnavailable('Feed projection is recovering');
      return row;
    });
  }

  async initialize(epoch: string): Promise<FeedCheckpoint> {
    return controlTransaction(this.pool, async client => {
      await client.query(`INSERT INTO access.feed_checkpoint (data_epoch, sequence, revision) VALUES ($1,0,$2)
        ON CONFLICT (id) DO UPDATE SET data_epoch = EXCLUDED.data_epoch, sequence = 0,
        after_id = '', rebuild_epoch = access.feed_checkpoint.data_epoch, rebuild_after = '',
        revision = EXCLUDED.revision WHERE access.feed_checkpoint.data_epoch <> EXCLUDED.data_epoch`,
      [epoch, randomUUID()]);
      return (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id')).rows[0]!;
    });
  }

  /** Restore retains opaque prior references in batches. They still pass the
   * live graph/Content gates, so rolled-back and erased activities stay hidden.
   * Copy is before new-epoch ingestion, preserving votes and original times. */
  async copyRetained(expected: FeedCheckpoint) {
    return controlTransaction(this.pool, async client => {
      const current = (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id FOR UPDATE')).rows[0];
      if (current?.revision !== expected.revision || !current.rebuild_epoch) throw new WorkReadMoved('Feed rebuild changed');
      const rows = (await client.query<{ id: string }>(`SELECT id FROM access.feed_item
        WHERE data_epoch = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [current.rebuild_epoch, current.rebuild_after, FEED_COST.refreshItems + 1])).rows;
      const ids = rows.slice(0, FEED_COST.refreshItems).map(row => row.id);
      await client.query(`INSERT INTO access.feed_item (data_epoch, id, sequence, kind, occurred_at, time_basis, score, best_key, realm, group_bucket, group_key, group_leader, group_members, sort_time)
        SELECT $1, id, sequence, kind, occurred_at, time_basis, score, best_key, realm, group_bucket, group_key, group_leader, group_members, sort_time FROM access.feed_item
        WHERE data_epoch = $2 AND id = ANY($3::text[]) ON CONFLICT DO NOTHING`, [current.data_epoch, current.rebuild_epoch, ids]);
      await client.query(`UPDATE access.feed_checkpoint SET rebuild_after = $1, rebuild_epoch = $2, revision = $3 WHERE id`,
        [ids.at(-1) ?? '', rows.length > FEED_COST.refreshItems ? current.rebuild_epoch : null, randomUUID()]);
    });
  }

  async advance(expected: FeedCheckpoint, through: string, sources: FeedReference[], relayTimes: ReadonlyMap<string, Date>) {
    if (sources.length > FEED_COST.refreshItems + 1 || BigInt(through) < BigInt(expected.sequence)) {
      throw new WorkReadUnavailable('Invalid feed refresh range');
    }
    return controlTransaction(this.pool, async client => {
      const current = (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id FOR UPDATE')).rows[0];
      if (current?.revision !== expected.revision) throw new WorkReadMoved('Feed projection changed');
      for (const source of sources.slice(0, FEED_COST.refreshItems)) {
        const fallbackTime = relayTimes.get(source.sequence);
        if (!fallbackTime) throw new WorkReadUnavailable('Relay event time is unavailable');
        const { time, basis } = activityTime(source.id, fallbackTime);
        if ((await client.query('SELECT 1 FROM access.feed_item WHERE data_epoch = $1 AND id = $2',
          [expected.data_epoch, source.id])).rowCount) continue;
        const bucket = digest([source.groupKind ?? source.kind, source.realm ?? null,
          source.kind === 'work' ? source.id : source.work ?? source.target ?? source.id, time.toISOString().slice(0, 10)]);
        const group = (await client.query<FeedRow>(`SELECT * FROM access.feed_item
          WHERE data_epoch = $1 AND group_bucket = $2 AND group_leader AND cardinality(group_members) < 4
          ORDER BY id DESC LIMIT 1 FOR UPDATE`, [expected.data_epoch, bucket])).rows[0];
        const groupKey = group?.group_key ?? digest(['home-group-v1', source.id]);
        await client.query(`INSERT INTO access.feed_item (data_epoch, id, sequence, kind, occurred_at, time_basis,
          best_key, realm, group_bucket, group_key, group_leader, group_members, sort_time)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$5)`,
        [expected.data_epoch, source.id, source.sequence, source.kind, time, basis, bestKey(0, time.getTime()),
          source.realm ?? null, bucket, groupKey, !group, [source.id]]);
        if (group) await client.query(`UPDATE access.feed_item SET group_members = array_append(group_members,$3) WHERE data_epoch = $1 AND id = $2`,
        [expected.data_epoch, group.id, source.id]);
      }
      const last = sources[FEED_COST.refreshItems - 1];
      const more = sources.length > FEED_COST.refreshItems;
      const sequence = more ? last!.sequence : through;
      const after = more ? last!.id : '\uffff';
      await client.query(`UPDATE access.feed_checkpoint SET sequence = $1, after_id = $2, revision = $3 WHERE id`,
        [sequence, after, randomUUID()]);
      // Bounded cleanup of old epochs; restored graph identities are re-admitted.
      await client.query(`DELETE FROM access.feed_item WHERE (data_epoch, id) IN (
        SELECT data_epoch, id FROM access.feed_item WHERE data_epoch <> $1 LIMIT 100)`, [expected.data_epoch]);
    });
  }

  async page(position: ReadPosition, revision: string, sort: 'best' | 'new' | 'top', limit: number,
    after: { key: string; id: string } | undefined, reader: { principal: VerifiedPrincipal; agent: string } | undefined,
    window: NonNullable<FeedQuery['window']>, asOf: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > FEED_COST.pageSize) throw new ControlInvalid('Invalid feed page');
    return controlTransaction(this.pool, async client => {
      const checkpoint = (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id FOR SHARE')).rows[0];
      if (checkpoint?.data_epoch !== position.dataEpoch || checkpoint.revision !== revision) throw new WorkReadMoved('Feed changed');
      const owner = reader ? await followPrincipal(client, reader.principal, reader.agent) : null;
      const cutoff = window === 'all' ? new Date(0) : new Date(asOf - (window === 'week' ? 7 : 30) * 86_400_000);
      // New has an unbounded history but a bounded index seek. Best declares
      // its recent candidate horizon and ranks only that bounded cohort.
      if (sort === 'top') {
        const key = after ? JSON.parse(after.key) as { score: number; time: string } : null;
        // Seek before applying the time window. Old high-score rows yield
        // sparse pages with continuation rather than an unbounded filtered scan.
        return (await client.query<FeedRow>(`WITH candidates AS MATERIALIZED (
          SELECT * FROM access.feed_item WHERE data_epoch = $1 AND group_leader
            ${key ? 'AND (score, sort_time, id) < ($4::integer,$5::timestamptz,$6)' : ''}
          ORDER BY score DESC, sort_time DESC, id DESC LIMIT $2
        ) SELECT c.*, COALESCE(v.value,0) AS vote, v.revision AS vote_revision
          FROM candidates c LEFT JOIN access.feed_vote v ON v.target = c.id AND v.principal_id = $3
          ORDER BY c.score DESC, c.sort_time DESC, c.id DESC`,
        [position.dataEpoch, limit + 1, owner, ...(key ? [key.score, key.time, after!.id] : [])])).rows
          .map(row => ({ ...row, order_key: JSON.stringify({ score: row.score, time: row.sort_time.toISOString() }) }));
      }
      const candidates = (await client.query<FeedRow>(`WITH candidates AS MATERIALIZED (
        SELECT * FROM access.feed_item WHERE data_epoch = $1 AND group_leader
          AND sort_time >= $3 AND sort_time <= $4
          ${sort === 'new' && after ? 'AND (sort_time, id) < ($6::timestamptz, $7)' : ''}
        ORDER BY sort_time DESC, id DESC LIMIT $2
      ) SELECT c.*, c.sort_time::text AS order_key, COALESCE(v.value,0) AS vote, v.revision AS vote_revision
        FROM candidates c LEFT JOIN access.feed_vote v ON v.target = c.id AND v.principal_id = $5
        ORDER BY c.sort_time DESC, c.id DESC`,
      [position.dataEpoch, sort === 'new' ? limit + 1 : FEED_RANKING.candidatePool, cutoff, new Date(asOf), owner,
        ...(sort === 'new' && after ? [after.key, after.id] : [])])).rows;
      if (sort === 'new') return candidates;
      const ranked = rankCandidates(candidates.map(row => ({ ...row, time: row.sort_time.getTime() })), sort)
        .map((row, index) => ({ ...row, order_key: String(index) }));
      const offset = after ? Number(after.key) + 1 : 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || after && ranked[offset - 1]?.id !== after.id) {
        throw new WorkReadMoved('Feed ranking changed');
      }
      return ranked.slice(offset, offset + limit + 1);
    });
  }

  async members(epoch: string, ids: string[]): Promise<FeedRow[]> {
    if (ids.length > FEED_COST.candidates) throw new ControlInvalid('Feed member budget exceeded');
    return controlTransaction(this.pool, async client => (await client.query<FeedRow>(
      'SELECT * FROM access.feed_item WHERE data_epoch = $1 AND id = ANY($2::text[])', [epoch, ids])).rows);
  }

  /** The target is a feed activity, not its Work's quality rating or a ballot.
   * One principal-target PK across all their Agents; a vote flips by its delta.
   * The rank row and receipt share the transaction, including lost-response replay. */
  async vote(principal: VerifiedPrincipal, target: string, epoch: string, input: FeedVoteCommand,
    key: string, disclose: () => Promise<void>): Promise<FeedVoteResult> {
    commandKey(key);
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, input.actingSubject);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`feed-vote:${owner}`]);
      const intent = digest({ target, ...input });
      const receipt = (await client.query<{ request_digest: string; result: FeedVoteResult }>(
        'SELECT request_digest, result FROM access.feed_vote_receipt WHERE principal_id = $1 AND idempotency_key = $2',
        [owner, key])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== intent) throw new ControlConflict('Idempotency key has a different vote intent');
        return { ...receipt.result, replayed: true };
      }
      // Lock order matches projection refresh, so refresh/vote cannot deadlock.
      const checkpoint = (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id FOR UPDATE')).rows[0];
      if (checkpoint?.data_epoch !== epoch) throw new WorkReadUnavailable('Feed is recovering');
      const item = (await client.query<{ score: number; occurred_at: Date }>(
        'SELECT score, occurred_at FROM access.feed_item WHERE data_epoch = $1 AND id = $2 AND group_leader FOR UPDATE', [epoch, target])).rows[0];
      if (!item) throw new WorkReadUnavailable('Feed activity is unavailable');
      const prior = (await client.query<{ value: number; revision: string }>(
        'SELECT value, revision FROM access.feed_vote WHERE principal_id = $1 AND target = $2', [owner, target])).rows[0];
      if ((prior?.revision ?? null) !== input.expectedRevision) throw new ControlStale('Vote changed; refresh its state');
      await disclose();
      const revision = randomUUID();
      const score = item.score + input.value - (prior?.value ?? 0);
      await client.query(`INSERT INTO access.feed_vote (principal_id, target, acting_subject, value, revision)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (principal_id, target) DO UPDATE SET
        value = EXCLUDED.value, acting_subject = EXCLUDED.acting_subject, revision = EXCLUDED.revision`,
      [owner, target, input.actingSubject, input.value, revision]);
      await client.query('UPDATE access.feed_item SET score = $3, best_key = $4 WHERE data_epoch = $1 AND id = $2',
        [epoch, target, score, bestKey(score, item.occurred_at.getTime())]);
      await client.query('UPDATE access.feed_checkpoint SET revision = $1 WHERE id', [randomUUID()]);
      const result: FeedVoteResult = { profile: 'feed-vote-receipt-v1', target, value: input.value, revision, score, replayed: false };
      await client.query(`INSERT INTO access.feed_vote_receipt (principal_id, idempotency_key, request_digest, result)
        VALUES ($1,$2,$3,$4)`, [owner, key, intent, result]);
      return result;
    });
  }
}
