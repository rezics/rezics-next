import { memoizedValue } from '../memoized.ts';
import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { AccessClient } from '../request/access.ts';
import type { Actor } from '../request/access.ts';
import type { RealmParticipationCheck } from '../community/participation.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import parent from './read-media-parent.sql';
import board from './read-media-parent-board.sql';

export function parentStatement(): string {
  return memoizedValue(parentStatement, () => parent.sql);
}
export function boardStatement(): string {
  return memoizedValue(boardStatement, () => board.sql);
}

export type MediaParent = {
  kind: 'post' | 'thread' | 'board';
  id: string;
  parent_id: string | null;
  thread_id: string | null;
  board_id: string | null;
  realm_id: string | null;
  purpose: string | null;
  visibility: string;
  security_revision: string;
  availability: string;
};
export type RealmParticipationProof = Readonly<{ realmId: string | null; allowed: boolean }>;
/** Prepare the Realm action before checking out the content anchor. The anchor
 * compares this T-bound result with its current board relationship. */
export async function prepareRealmParticipation(
  pool: Pool,
  check: RealmParticipationCheck | undefined,
  actor: Actor,
  realmId: string | null,
  time: AuthoritativeTime,
  deadline: number,
): Promise<RealmParticipationProof> {
  if (realmId === null || !check) return { realmId, allowed: true };
  return within(deadline, async () => {
    // The Realm check prepares Access evidence through independent reads on
    // this same pool. Keep the query port lazy so preparation never holds an
    // anchor connection while those reads acquire theirs.
    const allowed = await check(deadlineClient(pool, deadline), { realmId, actor }, time);
    return { realmId, allowed };
  });
}

export function realmParticipationMatches(proof: RealmParticipationProof | undefined, realmId: string | null): boolean {
  return proof !== undefined && proof.realmId === realmId && proof.allowed;
}

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new GrantDeniedError();
  return value;
}
function existing(
  rows: readonly {
    kind: string;
    id: string;
    parent_id: string | null;
    thread_id: string | null;
    board_id: string | null;
    realm_id: string | null;
    purpose: string | null;
    visibility: string;
    security_revision: string;
    availability: string;
  }[],
  id: string,
): MediaParent {
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.id !== id ||
    (row.kind !== 'post' && row.kind !== 'thread' && row.kind !== 'board') ||
    !row.visibility ||
    !row.security_revision ||
    row.visibility === 'taken_down' ||
    row.availability !== 'available'
  )
    throw new GrantDeniedError();
  return {
    kind: row.kind,
    id: row.id,
    parent_id: row.parent_id,
    thread_id: row.thread_id,
    board_id: row.board_id,
    realm_id: row.realm_id,
    purpose: row.purpose,
    visibility: row.visibility,
    security_revision: row.security_revision,
    availability: row.availability,
  };
}

/** Private storage reads only. The caller prepares all Access evidence before
 * entering; no callback may acquire another partition while this anchor is held. */
export async function mediaParentSnapshot<T>(
  pool: Pool,
  r: number,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return within(deadline, () =>
    withConnection(pool, async (client) => {
      const bounded = deadlineClient(client, deadline);
      try {
        await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const anchor = await readPartition(bounded, partitionOf(r));
        if (!anchor || anchor.writeState === 'moved') throw new GrantDeniedError();
        const result = await read(bounded);
        await bounded.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(client, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

/** At most 33 posts and one thread, all on the container's exact route. The
 * board ID is a reference only: even a co-located board is read independently. */
export async function mediaParentChain(
  client: AccessClient,
  containerId: string,
  readParent = (input: { route: number; id: string; kind: string }) => parent.run(client, input),
): Promise<MediaParent[]> {
  const result: MediaParent[] = [];
  const seen = new Set<string>();
  const r = route(containerId);
  let id = containerId;
  let kind = 'container';
  let threadId: string | null = null;
  let posts = 0;
  while (result.length < 34) {
    if (seen.has(id) || route(id) !== r) throw new GrantDeniedError();
    seen.add(id);
    const rows = await readParent({ route: r, id, kind });
    const row = existing(rows, id);
    result.push(row);
    if (row.kind === 'thread') {
      if ((threadId !== null && threadId !== row.id) || !row.board_id) throw new GrantDeniedError();
      route(row.board_id);
      return result;
    }
    if (
      row.kind !== 'post' ||
      ++posts > 33 ||
      !row.thread_id ||
      route(row.thread_id) !== r ||
      (threadId !== null && threadId !== row.thread_id)
    )
      throw new GrantDeniedError();
    threadId = row.thread_id;
    id = row.parent_id ?? row.thread_id;
    kind = row.parent_id ? 'post' : 'thread';
  }
  throw new GrantDeniedError();
}

export async function mediaParentBoard(client: AccessClient, boardId: string): Promise<MediaParent> {
  const found = await board.run(client, { route: route(boardId), id: boardId });
  const row = existing(found ? [found] : [], boardId);
  if (row.kind !== 'board') throw new GrantDeniedError();
  return row;
}
