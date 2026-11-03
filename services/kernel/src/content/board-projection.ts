import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { runCommand, type CommandReceipt } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { type CloudEvent } from '../events/log.ts';
import { readPartition, type Partition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS, type ContentEventData } from './events.ts';
import type { BoardId, ThreadId } from './model.ts';
import activePage from './board-rank-page.sql';
import pinPage from './board-pin-page.sql';
import page from './page-board-threads.sql';
import readSourceActivity from './read-source-activity.sql';
import upsert from './board-rank-upsert.sql';

export type BoardCandidateKey = Readonly<{ createdAt: string; id: ThreadId }>;
export type BoardCandidate = Readonly<{
  id: ThreadId;
  boardId: BoardId;
  createdAt: string;
  epoch: number;
  position: bigint;
}>;
export type BoardCandidatePage = Readonly<{
  candidates: readonly BoardCandidate[];
  next: BoardCandidateKey | null;
  epoch: number;
  position: bigint;
}>;
export type BoardRankKey = Readonly<{ activeRank: number; threadId: ThreadId }>;
export type BoardRankCandidate = Readonly<{
  id: ThreadId;
  activeRank: number;
  rankRefreshedAt: string;
}>;
export type BoardRankCandidatePage = Readonly<{
  candidates: readonly BoardRankCandidate[];
  next: BoardRankKey | null;
  epoch: number;
  position: bigint;
}>;

const sourceTypes = [
  'com.rezics.content.thread.created.v1',
  'com.rezics.content.post.created.v1',
  'com.rezics.content.revision.created.v1',
] as const;
const projected = 'com.rezics.content.board-thread.projected.v1';
const maxPosition = 9223372036854775807n;
export const MAX_BOARD_PINS = 3;

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new RangeError('Invalid routed content identity');
  return value;
}

/** The persisted pin section is a fixed indexed read from the board projection. */
export async function readBoardPins(client: Pick<PoolClient, 'query'>, boardId: BoardId): Promise<readonly ThreadId[]> {
  const parameters = { route: route(boardId), board_id: boardId, limit: MAX_BOARD_PINS };
  const { rows } = await client.query<(typeof pinPage)['~reylo']['element']>(
    pinPage.sql,
    pinPage.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  if (rows.length > MAX_BOARD_PINS || rows.some((row, index) => row.pin_slot !== index + 1))
    throw new Error('Board pin positions are inconsistent');
  return rows.map((row) => row.thread_id);
}

function timestamp(value: string): string {
  // Keep sub-millisecond precision for immutable keyset ties, matching ISO milliseconds when exact.
  return value.replace(/(\.\d{3})000Z$/, '$1Z');
}

function checkTime(value: string): void {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new RangeError('Invalid candidate creation time');
}

/** An internal fact snapshot, never an Access or disclosure decision. */
async function snapshot<T>(
  pool: Pool,
  partition: number,
  read: (client: PoolClient, anchor: Partition) => Promise<T>,
): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const anchor = await readPartition(client, partition);
      if (!anchor || anchor.writeState === 'moved') throw new Error('Content partition is unavailable');
      const result = await read(client, anchor);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export function createBoardEffect(pool: Pool): Effect {
  return {
    name: 'content_board_thread',
    types: [...sourceTypes],
    async run(event: CloudEvent) {
      if (!sourceTypes.includes(event.type as (typeof sourceTypes)[number]))
        throw new TypeError('Unsupported board projection source event');
      const type = event.type as (typeof sourceTypes)[number];
      if (!Value.Check(CONTENT_EVENTS[type], event.data)) throw new TypeError('Invalid content source payload');
      const data = event.data as ContentEventData<typeof type>;
      const sourceRoute = route(data.threadId);
      const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
      const epoch = Number(source?.[2]);
      if (
        !source ||
        Number(source[1]) !== partitionOf(sourceRoute) ||
        !Number.isSafeInteger(epoch) ||
        epoch > 2147483647 ||
        !/^\d{19}$/.test(event.sequence) ||
        BigInt(event.sequence) <= 0n ||
        BigInt(event.sequence) > maxPosition ||
        (event.subject !== data.threadId && event.subject !== data.itemId) ||
        route(data.itemId) !== sourceRoute ||
        route(data.revisionId) !== sourceRoute ||
        !/^[0-9a-f-]{36}$/.test(event.id)
      )
        throw new TypeError('Invalid content source envelope');
      const position = BigInt(event.sequence);
      const thread = await snapshot(pool, partitionOf(sourceRoute), async (client, anchor) => {
        if (epoch > anchor.epoch || (epoch === anchor.epoch && position > anchor.position))
          throw new Error('Source envelope is ahead of its partition');
        return readSourceActivity.run(client, {
          route: sourceRoute,
          thread_id: data.threadId,
          post_id: data.itemId,
        });
      });
      if (!thread?.board_id || !thread.created_at) throw new Error('Source thread reference is missing');
      const activityAt = type === 'com.rezics.content.post.created.v1' ? thread.item_created_at : thread.created_at;
      if (!activityAt) throw new Error('Source post reference is missing');
      // The source snapshot and its checkout are released before the board command starts.
      const identity = JSON.stringify([event.source, event.sequence, event.id, event.type]);
      const digest = createHash('sha256').update(identity).digest();
      await updateCandidate(
        pool,
        { id: data.threadId, boardId: thread.board_id, createdAt: timestamp(thread.created_at), epoch, position },
        data.revisionId,
        timestamp(activityAt),
        { actorAccountId: data.actorId, kind: 'content.board-thread.project', key: digest.toString('hex'), digest },
      );
    },
  };
}

export async function readBoardCandidates(
  pool: Pool,
  boardId: BoardId,
  after: BoardCandidateKey | null,
  limit: number,
): Promise<BoardCandidatePage> {
  return pageBoardCandidates(pool, boardId, after, limit, 'desc');
}

/** Internal candidate traversal in either index direction, without disclosure authority. */
export async function pageBoardCandidates(
  pool: Pool,
  boardId: BoardId,
  after: BoardCandidateKey | null,
  limit: number,
  direction: 'asc' | 'desc' = 'desc',
): Promise<BoardCandidatePage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Candidate limit must be 1 to 200');
  if (direction !== 'asc' && direction !== 'desc') throw new RangeError('Invalid candidate page direction');
  const boardRoute = route(boardId);
  if (after) {
    route(after.id);
    checkTime(after.createdAt);
  }
  return snapshot(pool, partitionOf(boardRoute), async (client, anchor) => {
    const parameters = {
      route: boardRoute,
      board_id: boardId,
      created_at: after?.createdAt ?? (direction === 'desc' ? 'infinity' : '-infinity'),
      thread_id: after?.id ?? '00000000-0000-0000-0000-000000000000',
      limit,
    };
    const sql = direction === 'desc' ? page.sql : page.sql.replace(') < (', ') > (').replaceAll(' DESC', ' ASC');
    const { rows } = await client.query<(typeof page)['~reylo']['element']>(
      sql,
      page.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    const candidates = rows.map((row) => ({
      id: row.thread_id,
      boardId: row.board_id,
      createdAt: timestamp(row.created_at!),
      epoch: row.source_epoch,
      position: BigInt(row.source_position),
    }));
    const last = candidates.at(-1);
    return {
      candidates,
      next: candidates.length === limit && last ? { createdAt: last.createdAt, id: last.id } : null,
      epoch: anchor.epoch,
      position: anchor.position,
    };
  });
}

/** Bounded active-rank traversal. Candidate identity still carries no disclosure authority. */
export async function pageActiveBoardCandidates(
  pool: Pool,
  boardId: BoardId,
  after: BoardRankKey | null,
  limit: number,
): Promise<BoardRankCandidatePage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Candidate limit must be 1 to 200');
  const boardRoute = route(boardId);
  if (after) {
    route(after.threadId);
    if (!Number.isFinite(after.activeRank) || after.activeRank < 0) throw new RangeError('Invalid active rank cursor');
  }
  return snapshot(pool, partitionOf(boardRoute), async (client, anchor) => {
    const parameters = {
      route: boardRoute,
      board_id: boardId,
      active_rank: after?.activeRank ?? 0,
      thread_id: after?.threadId ?? '00000000-0000-0000-0000-000000000000',
      has_after: after !== null,
      limit,
    };
    const { rows } = await client.query<(typeof activePage)['~reylo']['element']>(
      activePage.sql,
      activePage.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    const candidates = rows.map((row) => {
      if (row.rank_refreshed_at === null) throw new Error('Board rank freshness is missing');
      return {
        id: row.thread_id,
        activeRank: row.active_rank,
        rankRefreshedAt: row.rank_refreshed_at,
      };
    });
    const last = candidates.at(-1);
    return {
      candidates,
      next: candidates.length === limit && last ? { activeRank: last.activeRank, threadId: last.id } : null,
      epoch: anchor.epoch,
      position: anchor.position,
    };
  });
}

class UnchangedCandidate extends Error {}

async function updateCandidate(
  pool: Pool,
  candidate: BoardCandidate,
  revisionId: string | null,
  activityAt: string,
  receipt?: CommandReceipt,
) {
  const boardRoute = route(candidate.boardId);
  route(candidate.id);
  checkTime(candidate.createdAt);
  checkTime(activityAt);
  if (
    !Number.isInteger(candidate.epoch) ||
    candidate.epoch < 1 ||
    candidate.epoch > 2147483647 ||
    typeof candidate.position !== 'bigint' ||
    candidate.position <= 0n ||
    candidate.position > maxPosition
  )
    throw new RangeError('Invalid candidate source watermark');
  try {
    await runCommand(pool, { partition: partitionOf(boardRoute), ...(receipt ? { receipt } : {}) }, async (tx) => {
      const parameters = {
        route: boardRoute,
        board_id: candidate.boardId,
        thread_id: candidate.id,
        created_at: candidate.createdAt,
        activity_at: activityAt,
        source_epoch: candidate.epoch,
        source_position: candidate.position.toString(),
        source_revision_id: revisionId,
      };
      const result = await tx.query(
        upsert.sql,
        upsert.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      // runCommand requires an event. Roll back a stale upsert instead of fencing an empty mutation.
      if (result.rows.length === 0) throw new UnchangedCandidate();
      return {
        value: null,
        events: [
          {
            type: projected,
            subject: candidate.boardId,
            data: {
              boardId: candidate.boardId,
              threadId: candidate.id,
              sourceEpoch: candidate.epoch,
              sourcePosition: candidate.position.toString(),
            },
          },
        ],
      };
    });
  } catch (error) {
    if (!(error instanceof UnchangedCandidate)) throw error;
  }
}

/** Trusted workflow input only. Candidate references are never authoritative disclosure. */
export async function applyBoardCandidate(pool: Pool, candidate: BoardCandidate): Promise<void> {
  await updateCandidate(pool, candidate, null, candidate.createdAt);
}
