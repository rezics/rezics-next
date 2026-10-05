import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { controlRead, controlTransaction, ControlConflict, ControlInvalid, ControlStale } from '../access/topology-control.ts';
import { followPrincipal } from '../follows/authority.ts';
import { commandKey } from '../follows/store.ts';
import { digest } from '../recommendation/derived-generation.ts';
import { WorkReadMoved, WorkReadUnavailable, type ReadPosition } from '../work/read-session.ts';
import { FEED_COST, type FeedVoteCommand, type FeedVoteResult, type FeedQuery } from './contract.ts';
import { activityTime, bestKey, FEED_RANKING, rankCandidates } from './ranking.ts';
import type { FeedSource, FeedReference } from './source.ts';
import type { ReviewEvent } from '../review/store.ts';
import { reviewActivityId } from './source.ts';
import { FeedReadFrame } from './frame.ts';
import { FeedTargetIndex } from './target-index.ts';
import { RealmThreadRankingProjection } from '../rankings/realm-threads.ts';

/** `revision` changes with the projection's population (ingested items and
 * their groups, reviews, restore copies), never with a score or a position
 * that ingested nothing: page frames and cursors pin it. */
export interface FeedCheckpoint { data_epoch: string; sequence: string; after_id: string; revision: string;
  rebuild_epoch: string | null; rebuild_after: string; review_sequence: string }
export interface FeedRow { id: string; kind: FeedSource['kind']; occurred_at: Date;
  time_basis: 'revision' | 'relay'; realm: string | null; group_key: string; group_members: string[]; sort_time: Date; score: number; order_key: string; vote: -1 | 0 | 1; vote_revision: string | null }
/** A Best cursor's ranked position. An earlier offset cursor restarts its feed. */
function bestPosition(key: string): { rank: number; time: number } {
  let value: unknown;
  try { value = JSON.parse(key); } catch { value = null; }
  const { rank, time } = (value ?? {}) as { rank?: unknown; time?: unknown };
  if (typeof rank !== 'number' || typeof time !== 'number') throw new WorkReadMoved('Feed ranking changed');
  return { rank, time };
}
/** Refresh's compare-and-swap. The revision alone no longer moves on every
 * write, so the positions it advances are compared as well. */
function unmoved(current: FeedCheckpoint | undefined, expected: FeedCheckpoint) {
  return current?.revision === expected.revision && String(current.sequence) === String(expected.sequence)
    && current.after_id === expected.after_id && String(current.review_sequence) === String(expected.review_sequence);
}
/** Activities that are posts of their own: each takes its own votes and appears on its own. */
const soloKinds: ReadonlySet<string> = new Set(['discussion', 'reply']);

export class FeedStore {
  constructor(private readonly pool: Pool) {}

  openFrame(epoch: string, reader?: { principal: VerifiedPrincipal; agent: string }) {
    return FeedReadFrame.open(this.pool, epoch, reader);
  }
  projectTargets(session: import('../work/read-session.ts').WorkReadSession, relay: Pool, checkpoint: FeedCheckpoint, through: string) {
    return new FeedTargetIndex(this.pool,relay).tick(session,checkpoint,through);
  }
  projectRealmThreads(
    session: import('../work/read-session.ts').WorkReadSession,
    relay: Pool,
    checkpoint: FeedCheckpoint,
    through: string,
  ) {
    return new RealmThreadRankingProjection(this.pool, relay).tick(session, checkpoint, through);
  }

  async checkpoint(epoch: string): Promise<FeedCheckpoint> {
    return controlRead(this.pool, async client => {
      const row = (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id')).rows[0];
      if (!row) throw new WorkReadUnavailable('Feed projection is starting');
      if (row.data_epoch !== epoch) throw new WorkReadUnavailable('Feed projection is recovering');
      return row;
    });
  }

  /** Constant-size status probes; no payloads, inventory walks or refresh writes. */
  async readiness(position: ReadPosition) {
    return controlRead(this.pool, async client => {
      const row = (await client.query<{ checkpoint: FeedCheckpoint | null; target_sequence: string | null;
        target_complete: boolean; pending_reviews: boolean }>(`SELECT
        to_jsonb(c) || jsonb_build_object('sequence',c.sequence::text,'review_sequence',c.review_sequence::text) AS checkpoint,
        t.sequence::text AS target_sequence,
        t.data_epoch IS NOT NULL AND t.after_event='￿'
          AND NOT EXISTS(SELECT 1 FROM access.feed_item WHERE data_epoch=c.data_epoch AND NOT target_indexed LIMIT 1)
          AND NOT EXISTS(SELECT 1 FROM access.feed_author_dirty WHERE data_epoch=c.data_epoch LIMIT 1) AS target_complete,
        EXISTS(SELECT 1 FROM access.reader_review_event WHERE sequence>c.review_sequence LIMIT 1) AS pending_reviews
        FROM (SELECT 1) root LEFT JOIN access.feed_checkpoint c ON c.id
        LEFT JOIN access.feed_target_checkpoint t ON t.data_epoch=c.data_epoch`)).rows[0]!;
      const c = row.checkpoint;
      if (!c || c.data_epoch !== position.dataEpoch || BigInt(c.sequence) > BigInt(position.sequence))
        throw new WorkReadUnavailable('Feed projection is recovering');
      const targetsCurrent = row.target_complete && row.target_sequence === position.sequence;
      const current = c.sequence === position.sequence && c.after_id === '\uffff'
        && !c.rebuild_epoch && !row.pending_reviews && targetsCurrent;
      return { status: current ? 'ready' as const : 'indexing' as const, sourcePosition: position,
        projection: { sequence: c.sequence, reviewSequence: c.review_sequence },
        targets: { sequence: row.target_sequence, status: targetsCurrent ? 'current' as const : 'indexing' as const } };
    });
  }

  async reviewPending(sequence: string): Promise<boolean> {
    return controlRead(this.pool, async client => (await client.query(
      'SELECT 1 FROM access.reader_review_event WHERE sequence > $1::bigint LIMIT 1', [sequence])).rowCount !== 0);
  }

  async initialize(epoch: string): Promise<FeedCheckpoint> {
    return controlTransaction(this.pool, async client => {
      await client.query(`INSERT INTO access.feed_checkpoint (data_epoch, sequence, revision) VALUES ($1,0,$2)
        ON CONFLICT (id) DO UPDATE SET data_epoch = EXCLUDED.data_epoch, sequence = 0, review_sequence = 0,
        after_id = '', rebuild_epoch = access.feed_checkpoint.data_epoch, rebuild_after = '',
        revision = EXCLUDED.revision WHERE access.feed_checkpoint.data_epoch <> EXCLUDED.data_epoch`,
      [epoch, randomUUID()]);
      return (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id')).rows[0]!;
    });
  }

  /** Restore retains opaque prior references in batches. They still pass the
   * live graph/Content gates, so rolled-back and erased activities stay hidden.
   * Copy is before new-epoch ingestion, preserving votes and original times.
   * The batch is share-locked before its scores are copied: a vote still
   * writing the prior epoch commits first, and a later one sees the new epoch. */
  async copyRetained(expected: FeedCheckpoint) {
    return controlTransaction(this.pool, async client => {
      const current = (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id FOR UPDATE')).rows[0];
      if (!unmoved(current, expected) || !current?.rebuild_epoch) throw new WorkReadMoved('Feed rebuild changed');
      const rows = (await client.query<{ id: string }>(`SELECT id FROM access.feed_item
        WHERE data_epoch = $1 AND id > $2 ORDER BY id LIMIT $3 FOR SHARE`,
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
      if (!unmoved(current, expected)) throw new WorkReadMoved('Feed projection changed');
      let ingested = false;
      for (const source of sources.slice(0, FEED_COST.refreshItems)) {
        const fallbackTime = relayTimes.get(source.sequence);
        if (!fallbackTime) throw new WorkReadUnavailable('Relay event time is unavailable');
        const { time, basis } = activityTime(source.id, fallbackTime);
        if ((await client.query('SELECT 1 FROM access.feed_item WHERE data_epoch = $1 AND id = $2',
          [expected.data_epoch, source.id])).rowCount) continue;
        await client.query(`INSERT INTO access.follow_activity(target,activity_at)
          SELECT target,$2 FROM unnest($1::text[]) target ON CONFLICT(target) DO UPDATE SET
          activity_at=GREATEST(access.follow_activity.activity_at,EXCLUDED.activity_at)`,
        [[...new Set([source.target === source.id ? null : source.target,source.work,source.realm,source.actor].filter(Boolean))],time]);
        // A discussion or reply is a post of its own, never grouped (migration 820 promoted earlier ones).
        const bucket = soloKinds.has(source.kind) ? digest(['home-solo-v1', source.id])
          : digest([source.groupKind ?? source.kind, source.realm ?? null,
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
        ingested = true;
        if (source.groupKind === 'chapter' && source.work && source.actor && source.occurrence
          && source.contentRevision) {
          const eventId = randomUUID();
          const inserted = await client.query(`INSERT INTO access.chapter_notification_event
            (id, activity, work, author, occurrence, content_revision)
            VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (activity) DO NOTHING`,
          [eventId, source.id, source.work, source.actor, source.occurrence, source.contentRevision]);
          if (inserted.rowCount) await client.query(`SELECT access.append_notification_producer_event($1,$2)`,
            ['chapter_published', eventId]);
        }
        if (group) await client.query(`UPDATE access.feed_item SET group_members = array_append(group_members,$3) WHERE data_epoch = $1 AND id = $2`,
        [expected.data_epoch, group.id, source.id]);
      }
      const last = sources[FEED_COST.refreshItems - 1];
      const more = sources.length > FEED_COST.refreshItems;
      const sequence = more ? last!.sequence : through;
      const after = more ? last!.id : '\uffff';
      // Most graph events are not feed activity. Moving only the position keeps
      // open page frames and cursors valid; new items or groups replace it.
      await client.query(`UPDATE access.feed_checkpoint SET sequence = $1, after_id = $2, revision = $3 WHERE id`,
        [sequence, after, ingested ? randomUUID() : current!.revision]);
      // Bounded cleanup of old epochs; restored graph identities are re-admitted.
      await client.query(`DELETE FROM access.feed_item WHERE (data_epoch, id) IN (
        SELECT data_epoch, id FROM access.feed_item WHERE data_epoch <> $1 LIMIT 100)`, [expected.data_epoch]);
    });
  }

  /** One indexed Access event seek per tick. The item stores no review text;
   * hidden events still advance the cursor and remain subject to live reads. */
  async advanceReviews(expected: FeedCheckpoint, events: readonly ReviewEvent[],
    admitted: ReadonlyMap<string, FeedSource>) {
    if (events.length > FEED_COST.refreshItems + 1) throw new WorkReadUnavailable('Review refresh budget exceeded');
    return controlTransaction(this.pool, async client => {
      const current = (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id FOR UPDATE')).rows[0];
      if (!unmoved(current, expected)) throw new WorkReadMoved('Feed projection changed');
      let ingested = false;
      for (const event of events.slice(0, FEED_COST.refreshItems)) {
        const source = admitted.get(reviewActivityId(event.review));
        if (event.kind !== 'created') continue;
        const time = source?.readerReview?.created_at ?? new Date(event.occurredAt);
        const bucket = source ? digest(['review', source.actor, source.realm, time.toISOString().slice(0, 13)])
          : digest(['review-hidden', event.review]);
        const groupKey = digest(['home-group-v1', reviewActivityId(event.review)]);
        if ((await client.query(`INSERT INTO access.feed_item (data_epoch, id, sequence, kind, occurred_at,
          time_basis, best_key, realm, group_bucket, group_key, group_leader, group_members, sort_time)
          VALUES ($1,$2,$3,'review',$4,'revision',$5,$6,$7,$8,true,$9,$4) ON CONFLICT DO NOTHING`,
        [expected.data_epoch, reviewActivityId(event.review), event.sequence, time, bestKey(0, time.getTime()),
          source?.realm ?? event.realm, bucket, groupKey, [reviewActivityId(event.review)]])).rowCount) ingested = true;
      }
      await client.query('UPDATE access.feed_checkpoint SET review_sequence = $1, revision = $2 WHERE id',
        [events[Math.min(events.length, FEED_COST.refreshItems) - 1]!.sequence, ingested ? randomUUID() : current!.revision]);
    });
  }

  async page(position: ReadPosition, revision: string, sort: 'best' | 'new' | 'top', limit: number,
    after: { key: string; id: string } | undefined, reader: { principal: VerifiedPrincipal; agent: string; scope?: string } | undefined,
    window: NonNullable<FeedQuery['window']>, asOf: number, kinds?: readonly string[], frame?: FeedReadFrame) {
    if (!Number.isInteger(limit) || limit < 1 || limit > FEED_COST.pageSize) throw new ControlInvalid('Invalid feed page');
    if (kinds && (kinds.length < 1 || kinds.length > 8 || new Set(kinds).size !== kinds.length)) {
      throw new ControlInvalid('Invalid feed kinds');
    }
    const read = async (client: Pick<PoolClient, 'query'>) => {
      const checkpoint = frame?.checkpoint ?? (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id')).rows[0];
      if (checkpoint?.data_epoch !== position.dataEpoch || checkpoint.revision !== revision) throw new WorkReadMoved('Feed changed');
      const owner = frame ? frame.owner : reader ? await followPrincipal(client as PoolClient, reader.principal, reader.agent) : null;
      const cutoff = window === 'all' ? new Date(0) : new Date(asOf - (window === 'week' ? 7 : 30) * 86_400_000);
      if (sort === 'new' && reader?.scope === 'following' && frame) {
        // A partial target index still provides a bounded, live-disclosed page.
        // The reader reports projecting until its frontier and backfill catch up.
        frame.useFollowingIndex();
        return (await client.query<FeedRow>(`WITH followed AS MATERIALIZED (
          SELECT target FROM access.follow WHERE principal_id=$5 AND following),
        keys AS MATERIALIZED (
          SELECT target FROM followed UNION SELECT a.alias AS target FROM access.follow_space_alias a
            JOIN followed f ON f.target=a.space UNION SELECT a.space FROM access.follow_space_alias a JOIN followed f ON f.target=a.alias),
        candidates AS MATERIALIZED (
          SELECT DISTINCT seek.id,seek.sort_time FROM keys CROSS JOIN LATERAL (
            SELECT id,sort_time FROM access.feed_target WHERE data_epoch=$1 AND target=keys.target
              AND sort_time>=$3 AND sort_time<=$4
              ${after ? 'AND (sort_time,id)<($6::timestamptz,$7)' : ''}
              ${kinds ? `AND kind=ANY($${after ? 8 : 6}::text[])` : ''}
            ORDER BY sort_time DESC,id DESC LIMIT $2) seek)
        SELECT item.*,item.sort_time::text AS order_key,COALESCE(v.value,0) AS vote,v.revision AS vote_revision
        FROM (SELECT * FROM candidates ORDER BY sort_time DESC,id DESC LIMIT $2) candidate
        JOIN access.feed_item item ON item.data_epoch=$1 AND item.id=candidate.id
        LEFT JOIN access.feed_vote v ON v.target=item.id AND v.principal_id=$5
        ORDER BY item.sort_time DESC,item.id DESC`,
        [position.dataEpoch,limit+1,cutoff,new Date(asOf),owner,...(after ? [after.key,after.id] : []),...(kinds ? [kinds] : [])])).rows;
      }
      // New has an unbounded history but a bounded index seek. Best declares
      // its recent candidate horizon and ranks only that bounded cohort.
      // A kind filter seeks that kind: filtering after the seek hid every
      // discussion behind newer catalogue posts.
      if (sort === 'top') {
        const key = after ? JSON.parse(after.key) as { score: number; time: string } : null;
        const kindParam = key ? 7 : 4;
        return (await client.query<FeedRow>(`WITH candidates AS MATERIALIZED (
          SELECT * FROM access.feed_item WHERE data_epoch = $1 AND group_leader
            ${kinds ? `AND kind = ANY($${kindParam}::text[])` : ''}
            ${key ? 'AND (score, sort_time, id) < ($4::integer,$5::timestamptz,$6)' : ''}
          ORDER BY score DESC, sort_time DESC, id DESC LIMIT $2
        ) SELECT c.*, COALESCE(v.value,0) AS vote, v.revision AS vote_revision
          FROM candidates c LEFT JOIN access.feed_vote v ON v.target = c.id AND v.principal_id = $3
          ORDER BY c.score DESC, c.sort_time DESC, c.id DESC`,
        [position.dataEpoch, limit + 1, owner, ...(key ? [key.score, key.time, after!.id] : []), ...(kinds ? [kinds] : [])])).rows
          .map(row => ({ ...row, order_key: JSON.stringify({ score: row.score, time: row.sort_time.toISOString() }) }));
      }
      const rankedPool = sort === 'best' && !kinds;
      /** Discussions stay in Best's cohort when newer catalogue posts would otherwise fill it. */
      const talkReserve = 64;
      const candidates = (await client.query<FeedRow>(rankedPool ? `WITH recent AS (
          SELECT * FROM access.feed_item WHERE data_epoch = $1 AND group_leader
            AND sort_time >= $3 AND sort_time <= $4
          ORDER BY sort_time DESC, id DESC LIMIT $2
        ), talks AS (
          SELECT * FROM access.feed_item WHERE data_epoch = $1 AND group_leader
            AND kind IN ('discussion', 'reply')
            AND sort_time >= $3 AND sort_time <= $4
          ORDER BY sort_time DESC, id DESC LIMIT ${talkReserve}
        ), candidates AS (
          SELECT * FROM recent UNION SELECT * FROM talks
        ) SELECT c.*, c.sort_time::text AS order_key, COALESCE(v.value,0) AS vote, v.revision AS vote_revision
          FROM candidates c LEFT JOIN access.feed_vote v ON v.target = c.id AND v.principal_id = $5
          ORDER BY c.sort_time DESC, c.id DESC`
        : `WITH candidates AS MATERIALIZED (
          SELECT * FROM access.feed_item WHERE data_epoch = $1 AND group_leader
            AND sort_time >= $3 AND sort_time <= $4
            ${sort === 'new' && after ? 'AND (sort_time, id) < ($6::timestamptz, $7)' : ''}
            ${kinds ? `AND kind = ANY($${sort === 'new' && after ? 8 : 6}::text[])` : ''}
          ORDER BY sort_time DESC, id DESC LIMIT $2
        ) SELECT c.*, c.sort_time::text AS order_key, COALESCE(v.value,0) AS vote, v.revision AS vote_revision
          FROM candidates c LEFT JOIN access.feed_vote v ON v.target = c.id AND v.principal_id = $5
          ORDER BY c.sort_time DESC, c.id DESC`,
      [position.dataEpoch, rankedPool ? FEED_RANKING.candidatePool - talkReserve
        : sort === 'new' ? limit + 1 : FEED_RANKING.candidatePool, cutoff, new Date(asOf), owner,
        ...(sort === 'new' && after ? [after.key, after.id] : []), ...(rankedPool || !kinds ? [] : [kinds])])).rows;
      if (sort === 'new') return candidates;
      const ranked = rankCandidates(candidates.map(row => ({ ...row, time: row.sort_time.getTime() })), sort)
        .map(row => ({ ...row, order_key: JSON.stringify({ rank: row.rank, time: row.time }) }));
      if (!after) return ranked.slice(0, limit + 1);
      // Continue after the last served position in the current ranking, as Top
      // and New do. Votes re-rank without a new revision; an item whose rank
      // crossed the position repeats or is passed over (timeline.md).
      const { rank, time } = bestPosition(after.key);
      const start = ranked.findIndex(row => row.rank < rank
        || row.rank === rank && (row.time < time || row.time === time && row.id < after.id));
      return start < 0 ? [] : ranked.slice(start, start + limit + 1);
    };
    if (frame) return read(this.pool);
    // Reads take no lock behind refresh. Every population change replaces the
    // revision in the same commit, so an unchanged closing probe proves the
    // rows came from the population the caller pinned (as a frame's close does).
    return controlRead(this.pool, async client => {
      const rows = await read(client);
      const closing = (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id')).rows[0];
      if (closing?.data_epoch !== position.dataEpoch || closing.revision !== revision) throw new WorkReadMoved('Feed changed');
      return rows;
    });
  }

  async members(epoch: string, ids: string[], frame?: FeedReadFrame): Promise<FeedRow[]> {
    if (ids.length > FEED_COST.candidates) throw new ControlInvalid('Feed member budget exceeded');
    const read = async (client: Pick<PoolClient,'query'>) => (await client.query<FeedRow>(
      'SELECT * FROM access.feed_item WHERE data_epoch = $1 AND id = ANY($2::text[])', [epoch, ids])).rows;
    return frame ? read(this.pool) : controlRead(this.pool, read);
  }

  /** Indexed head probe only; disclosure and follows are checked by the reader,
   * which also re-reads the revision afterwards, so this takes no lock. */
  async since(position: ReadPosition, revision: string, afterSequence: string,
    realm?: string, limit = 20, afterReview?: string): Promise<{ id: string; kind: string; realm: string | null; group_key: string }[]> {
    if (!/^\d{1,30}$/.test(afterSequence) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new ControlInvalid('Invalid feed head');
    }
    if (afterReview !== undefined && !/^\d{1,30}$/.test(afterReview)) throw new ControlInvalid('Invalid review head');
    return controlRead(this.pool, async client => {
      const checkpoint = (await client.query<FeedCheckpoint>(
        'SELECT * FROM access.feed_checkpoint WHERE id')).rows[0];
      if (checkpoint?.data_epoch !== position.dataEpoch || checkpoint.revision !== revision) {
        throw new WorkReadMoved('Feed changed');
      }
      return (await client.query<{ id: string; kind: string; realm: string | null; group_key: string }>(`SELECT id, kind, realm,
          CASE WHEN kind = 'review' THEN group_bucket ELSE group_key END AS group_key FROM access.feed_item
        WHERE data_epoch = $1 AND (kind <> 'review' AND sequence > $2
          OR kind = 'review' AND sequence > $5)
          AND ($4::text IS NULL OR realm = $4)
        ORDER BY occurred_at DESC, id DESC LIMIT $3`,
      [position.dataEpoch, afterSequence, limit + 1, realm ?? null,
        afterReview ?? checkpoint.review_sequence])).rows;
    });
  }

  /** The target is a feed activity, not its Work's quality rating or a ballot.
   * One principal-group-anchor PK across all their Agents; a vote flips by its delta.
   * A visible member can stand in for a filtered or hidden anchor. Resolve it
   * only for storage: receipts keep the requested target and intent so retries
   * remain stable across projection refreshes, without disclosing the anchor.
   * The rank row and receipt share the transaction, including lost-response replay.
   * Disclosure is a graph and Content read, so it runs before the transaction
   * rather than while it holds row locks: a slow admission once delayed every
   * other vote and refresh, which is how the seed's votes ran past their read
   * deadline. A replay needs no admission. A score is not part of the
   * projection's revision, so a vote leaves every open page frame valid. */
  async vote(principal: VerifiedPrincipal, target: string, epoch: string, input: FeedVoteCommand,
    key: string, disclose: () => Promise<{ actor: string; work: string | null } | void>): Promise<FeedVoteResult> {
    commandKey(key);
    const intent = digest({ target, ...input });
    const prior = await controlRead(this.pool, async client => {
      const owner = await followPrincipal(client, principal, input.actingSubject);
      return (await client.query<{ request_digest: string; result: FeedVoteResult }>(
        'SELECT request_digest, result FROM access.feed_vote_receipt WHERE principal_id = $1 AND idempotency_key = $2',
        [owner, key])).rows[0];
    });
    if (prior) {
      if (prior.request_digest !== intent) throw new ControlConflict('Idempotency key has a different vote intent');
      return { ...prior.result, replayed: true };
    }
    const source = await disclose();
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, input.actingSubject);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`feed-vote:${owner}`]);
      const receipt = (await client.query<{ request_digest: string; result: FeedVoteResult }>(
        'SELECT request_digest, result FROM access.feed_vote_receipt WHERE principal_id = $1 AND idempotency_key = $2',
        [owner, key])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== intent) throw new ControlConflict('Idempotency key has a different vote intent');
        return { ...receipt.result, replayed: true };
      }
      // A vote locks only what it changes: the group leader that carries the
      // score, then its own vote row. Two indexed seeks: the member PK and the
      // group's leader index. Refresh only appends members, under this same
      // row lock, so the lock fixes the membership the vote resolves.
      const item = (await client.query<{ id: string; score: number; occurred_at: Date }>(`SELECT leader.id, leader.score, leader.occurred_at
        FROM access.feed_item member JOIN access.feed_item leader
          ON leader.data_epoch = member.data_epoch AND leader.group_key = member.group_key
        WHERE member.data_epoch = $1 AND member.id = $2 AND leader.group_leader
          AND member.id = ANY(leader.group_members)
        LIMIT 1 FOR NO KEY UPDATE OF leader`, [epoch, target])).rows[0];
      // A plain read after the leader lock: a restore's copy share-locks the
      // rows it retains, so it either waits for this score or this vote sees
      // the new epoch here and stops. Taking the singleton checkpoint row ran
      // every vote on the platform one at a time.
      const checkpoint = (await client.query<FeedCheckpoint>('SELECT * FROM access.feed_checkpoint WHERE id')).rows[0];
      if (checkpoint?.data_epoch !== epoch) throw new WorkReadUnavailable('Feed is recovering');
      if (!item) throw new WorkReadUnavailable('Feed activity is unavailable');
      const prior = (await client.query<{ value: number; revision: string }>(
        'SELECT value, revision FROM access.feed_vote WHERE principal_id = $1 AND target = $2', [owner, item.id])).rows[0];
      if ((prior?.revision ?? null) !== input.expectedRevision) throw new ControlStale('Vote changed; refresh its state');
      const revision = randomUUID();
      const score = item.score + input.value - (prior?.value ?? 0);
      await client.query(`INSERT INTO access.feed_vote (principal_id, target, acting_subject, value, revision)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (principal_id, target) DO UPDATE SET
        value = EXCLUDED.value, acting_subject = EXCLUDED.acting_subject, revision = EXCLUDED.revision`,
      [owner, item.id, input.actingSubject, input.value, revision]);
      await client.query('UPDATE access.feed_item SET score = $3, best_key = $4 WHERE data_epoch = $1 AND id = $2',
        [epoch, item.id, score, bestKey(score, item.occurred_at.getTime())]);
      const result: FeedVoteResult = { profile: 'feed-vote-receipt-v1', target, value: input.value, revision, score, replayed: false };
      await client.query(`INSERT INTO access.feed_vote_receipt (principal_id, idempotency_key, request_digest, result)
        VALUES ($1,$2,$3,$4)`, [owner, key, intent, result]);
      if (input.value !== 0 && prior?.value !== input.value && source && source.actor !== input.actingSubject) {
        const eventId = randomUUID();
        await client.query(`INSERT INTO access.feed_post_vote_event
          (id, target, author, voter, voter_principal, vote_revision, work)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [eventId, item.id, source.actor, input.actingSubject,
          owner, revision, source.work]);
        await client.query(`SELECT access.append_notification_producer_event($1,$2)`, ['feed_post_vote', eventId]);
      }
      return result;
    });
  }
}
