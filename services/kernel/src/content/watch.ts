import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import type { Access } from '../request/access.ts';
import type { Actor } from '../request/access.ts';
import { ProblemError } from '../http/problem.ts';
import { newId, routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { withConnection } from '../database/pool.ts';
import { readThread, ContentNotFoundError } from './reads.ts';
import { withWritableNoticeRoute } from './notices.ts';

type Dependencies = Readonly<{ pool: Pool; access: Access; tokens: KeyRing; clock?: () => Date }>;
type ThreadAnchor = Awaited<ReturnType<typeof readThread>>['anchor'];

async function readableThread(dependencies: Dependencies, actor: Actor, threadId: string, deadline: number) {
  if (routeOf(threadId) === null) throw new ContentNotFoundError();
  const result = await readThread(dependencies, threadId, { actor, deadline });
  if (!result.value) throw new ContentNotFoundError();
  return result;
}

async function requireLiveAccount(client: PoolClient, accountId: string) {
  const route = routeOf(accountId);
  if (route === null) throw new ProblemError('not_found');
  const account = await readAccount(client, route, accountId);
  if (!account || account.state === 'deleted' || account.state === 'pending') throw new ProblemError('not_found');
}

/** Read only the caller's own current watch state, after the normal thread disclosure check. */
export async function readThreadWatchState(
  dependencies: Dependencies,
  actor: Actor,
  threadId: string,
  deadline: number,
): Promise<{ watching: boolean; anchor: ThreadAnchor }> {
  if (actor.kind !== 'account') throw new ProblemError('forbidden');
  const thread = await readableThread(dependencies, actor, threadId, deadline);
  const route = routeOf(actor.accountId)!;
  const result = await withConnection(dependencies.pool, (client) =>
    client.query(
      `SELECT 1 FROM content.thread_watch
       WHERE route=$1 AND thread_id=$2 AND watcher_account_id=$3`,
      [route, threadId, actor.accountId],
    ),
  );
  return { watching: result.rowCount === 1, anchor: thread.anchor };
}

/** Watching requires current thread access; the personal edge is unique and PUT is naturally idempotent. */
export async function watchThread(
  dependencies: Dependencies,
  actor: Actor,
  threadId: string,
  deadline: number,
): Promise<ThreadAnchor> {
  if (actor.kind !== 'account') throw new ProblemError('forbidden');
  const thread = await readableThread(dependencies, actor, threadId, deadline);
  const ownerRoute = routeOf(actor.accountId)!;
  await withWritableNoticeRoute(dependencies.pool, ownerRoute, async (client) => {
    await requireLiveAccount(client, actor.accountId);
    await client.query(
      `INSERT INTO content.thread_watch(route,thread_id,watcher_account_id,watch_id,created_at)
       VALUES ($1,$2,$3,$4,$5::timestamptz)
       ON CONFLICT (route,thread_id,watcher_account_id) DO NOTHING`,
      [ownerRoute, threadId, actor.accountId, newId(ownerRoute), (dependencies.clock?.() ?? new Date()).toISOString()],
    );
  });
  return thread.anchor;
}

/** A caller may always clear their own edge, even if thread access has since been removed. */
export async function unwatchThread(dependencies: Dependencies, actor: Actor, threadId: string): Promise<void> {
  if (actor.kind !== 'account') throw new ProblemError('forbidden');
  const route = routeOf(threadId);
  const ownerRoute = routeOf(actor.accountId);
  if (route === null || ownerRoute === null) throw new ProblemError('not_found');
  await withWritableNoticeRoute(dependencies.pool, ownerRoute, async (client) => {
    await requireLiveAccount(client, actor.accountId);
    await client.query(
      `DELETE FROM content.thread_watch WHERE route=$1 AND thread_id=$2 AND watcher_account_id=$3`,
      [ownerRoute, threadId, actor.accountId],
    );
  });
}
