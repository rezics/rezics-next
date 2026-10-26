import type { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, AccessClient } from '../request/access.ts';
import type { Actor } from '../request/access.ts';
import type { RealmParticipationCheck } from '../community/participation.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';

export type MediaParent = {
  kind: 'post' | 'thread' | 'board';
  id: string;
  parent_id: string | null;
  thread_id: string | null;
  board_id: string | null;
  realm_id: string | null;
  visibility: string;
  security_revision: string;
  availability: string;
};
export type RealmParticipationProof = Readonly<{ realmId: string | null; allowed: boolean }>;
const realmParticipationChecks = new WeakMap<Access, RealmParticipationCheck>();
type PoolConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  release: (error?: Error) => void,
) => void;
const indexedPools = new AsyncLocalStorage<Pool>();
const installedIndexedPools = new WeakSet<Pool>();

function installIndexedPool(pool: Pool): void {
  if (installedIndexedPools.has(pool)) return;
  installedIndexedPools.add(pool);
  const connect = pool.connect.bind(pool) as Pool['connect'];
  const configure = (client: PoolClient, release: (error?: Error) => void) => {
    let returned = false;
    const releaseWithReset = (error?: Error) => {
      if (returned) return;
      returned = true;
      if (error) {
        release(error);
        return;
      }
      client.query('RESET enable_seqscan; RESET plan_cache_mode', (resetError) => release(resetError ?? undefined));
    };
    client.release = releaseWithReset;
    return releaseWithReset;
  };
  (pool as Pool & { connect: Pool['connect'] }).connect = ((callback?: PoolConnectCallback) => {
    if (indexedPools.getStore() !== pool) return connect(callback as never);
    if (callback) {
      return connect(((error: Error | undefined, client: PoolClient | undefined, release: (error?: Error) => void) => {
        if (error || !client) {
          callback(error, client, release);
          return;
        }
        client.query(
          'SET enable_seqscan = off; SET plan_cache_mode = force_custom_plan',
          (settingError: Error | undefined) => {
            if (settingError) {
              release(settingError);
              callback(settingError, undefined, release);
              return;
            }
            callback(undefined, client, configure(client, release));
          },
        );
      }) as never);
    }
    return (connect() as Promise<PoolClient>).then(
      (client) =>
        new Promise<PoolClient>((resolve, reject) => {
          client.query('SET enable_seqscan = off; SET plan_cache_mode = force_custom_plan', (error) => {
            if (error) {
              client.release(error);
              reject(error);
              return;
            }
            configure(client, client.release.bind(client));
            resolve(client);
          });
        }),
    );
  }) as Pool['connect'];
}

export function withRealmIndexedReads<T>(pool: Pool, work: () => Promise<T>): Promise<T> {
  installIndexedPool(pool);
  return indexedPools.run(pool, work);
}

function indexedAccessClient(pool: Pool): AccessClient {
  return {
    query: (async (...args: unknown[]) =>
      withConnection(pool, async (client) => {
        await client.query('BEGIN READ ONLY');
        try {
          await client.query('SET LOCAL enable_seqscan = off');
          await client.query('SET LOCAL plan_cache_mode = force_custom_plan');
          const result = await (client.query as (...query: unknown[]) => Promise<unknown>)(...args);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(client, rollbackError as Error);
          }
          throw error;
        }
      })) as AccessClient['query'],
  };
}

export function installRealmParticipationCheck(access: Access, check: RealmParticipationCheck): void {
  realmParticipationChecks.set(access, check);
}

export function realmParticipationCheckFor(access: Access): RealmParticipationCheck | undefined {
  return realmParticipationChecks.get(access);
}

/** Prepare the Realm action before checking out the content anchor. The anchor
 * compares this T-bound result with its current board relationship. */
export async function prepareRealmParticipation(
  pool: Pool,
  check: RealmParticipationCheck | undefined,
  actor: Actor,
  realmId: string | null,
  time: AuthoritativeTime,
): Promise<RealmParticipationProof> {
  if (realmId === null || !check) return { realmId, allowed: true };
  const allowed = await withRealmIndexedReads(pool, () => check(indexedAccessClient(pool), { realmId, actor }, time));
  return { realmId, allowed };
}

export function realmParticipationMatches(proof: RealmParticipationProof | undefined, realmId: string | null): boolean {
  return proof !== undefined && proof.realmId === realmId && proof.allowed;
}

// Separate statements keep board storage entirely out of parent validation.
export const parentStatement = `SELECT 'thread'::text AS kind, t.thread_id AS id, NULL::uuid AS parent_id,
  t.thread_id, t.board_id, NULL::uuid AS realm_id, t.visibility, t.security_revision::text, 'available'::text AS availability
  FROM content.thread t WHERE $3::text IN ('container', 'thread') AND t.route=$1 AND t.thread_id=$2
  UNION ALL
  SELECT 'post', p.post_id, p.reply_to_post_id, p.thread_id, NULL::uuid,
  NULL::uuid, p.visibility, p.security_revision::text,
  CASE WHEN p.availability='erased' THEN 'erased' ELSE r.availability END
  FROM content.post p JOIN content.revision r ON r.route=$1 AND r.thread_id=p.thread_id
    AND r.post_id=p.post_id AND r.revision_id=p.head_revision_id
  WHERE $3::text IN ('container', 'post') AND p.route=$1 AND p.post_id=$2`;
export const boardStatement = `SELECT 'board'::text AS kind, board_id AS id, NULL::uuid AS parent_id,
  NULL::uuid AS thread_id, NULL::uuid AS board_id, realm_id, visibility, security_revision::text, 'available'::text AS availability
  FROM content.board WHERE route=$1 AND board_id=$2`;
function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new GrantDeniedError();
  return value;
}
function existing(rows: MediaParent[], id: string): MediaParent {
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
  return row;
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
export async function mediaParentChain(client: AccessClient, containerId: string): Promise<MediaParent[]> {
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
    const { rows } = await client.query<MediaParent>(parentStatement, [r, id, kind]);
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
  const { rows } = await client.query<MediaParent>(boardStatement, [route(boardId), boardId]);
  const row = existing(rows, boardId);
  if (row.kind !== 'board') throw new GrantDeniedError();
  return row;
}
