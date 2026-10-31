import { readNativeAccessTime } from '../access/authenticate.ts';
import { authoritativeTimeValue, releaseOperationalTime } from '../command/command.ts';
import { accessCheck, type AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import readEndpoints from './read-first-erasure-post.sql';
import { snapshot, type ContentReadDependencies } from './reads.ts';

/** Private presentation only. The command and each workflow step authorize independently. */
export type AuthorErasureAdmission = Readonly<{ authorId: string; mayErase: boolean }>;

/** Called only between ordinary initial and final thread/container disclosure.
 * The command's exact two indexed prefix seeks select the real first affected
 * post. No endpoint, body, upper tuple or count crosses this boundary.
 */
export async function readAuthorErasureAdmission(
  dependencies: ContentReadDependencies,
  threadId: string,
  context: { actor: AccountActor; deadline: number },
): Promise<AuthorErasureAdmission> {
  const accessContext = { pool: dependencies.pool, deadline: context.deadline };
  const time = await readNativeAccessTime(accessContext, dependencies.clock);
  try {
    const route = routeOf(threadId);
    if (route === null) throw new TypeError('Invalid thread identity');
    const parameters = {
      route,
      thread_id: threadId,
      author_id: context.actor.accountId,
      at: authoritativeTimeValue(time),
    };
    const selected = await snapshot(dependencies, threadId, context, async (client) => {
      const result = await client.query<(typeof readEndpoints)['~reylo']['element']>(
        readEndpoints.sql,
        readEndpoints.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      return result.rows[0]?.post_id;
    });
    if (!selected.value) return { authorId: context.actor.accountId, mayErase: false };
    // Preparation releases all account/permission anchors before resource checkout.
    const check = await accessCheck(
      dependencies.access,
      context.actor,
      'post:erase',
      { route, id: selected.value },
      { ...accessContext, time },
    );
    const result = await snapshot(dependencies, threadId, context, (client) => check(client, time));
    return { authorId: context.actor.accountId, mayErase: result.value };
  } finally {
    releaseOperationalTime(time);
  }
}
