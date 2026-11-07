import { authoritativeTimeValue, noEffect, principalCommandIdentity, runCommand } from '../command/command.ts';
import { accessCheck, accessCommandAuthorization } from './access-port.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ContentNotFoundError } from './commands.ts';
import type { ReadContext } from './model.ts';
import { ContentNotFoundError as ReadNotFoundError, readThread, type ContentReadDependencies } from './reads.ts';
import { withEditionReadTime } from './edition-store.ts';
import { prepareEditionSubject } from './edition-subject.ts';
import originalReview from './restoration-conflict-original.sql';
import readLiveReview from './live-review-read.sql';

/** Call after the native restore conflict has rolled back and discovery abort has
 * resolved. Null means no authorized hint, never proof that a review is absent.
 * This is a source consumer, not an alternative restore or permission authority.
 */
export async function readCurrentRestorationConflict(
  deps: ContentReadDependencies,
  postId: string,
  context: ReadContext,
): Promise<{ existingThreadId: string } | null> {
  const { actor } = context;
  const route = routeOf(postId);
  if (route === null || actor.kind !== 'account') return null;
  try {
    const authorization = await accessCommandAuthorization(
      deps.access,
      actor,
      'post:erase',
      { route, id: postId },
      { pool: deps.pool, deadline: context.deadline },
      () => new ContentNotFoundError(),
    );
    // The native executor supplies current owner/action authority and live T.
    // No receipt, event or counter change is produced by this metadata read.
    const candidate = await runCommand(
      deps.pool,
      {
        ...principalCommandIdentity(actor),
        partition: partitionOf(route),
        authorization,
        deadline: context.deadline,
        clock: deps.clock,
      },
      async (tx, { time }) => {
        const original = await originalReview.run(tx, {
          route,
          post_id: postId,
          author_id: actor.accountId,
          at: authoritativeTimeValue(time),
        });
        if (!original?.subject_id) return noEffect(null);
        const live = await readLiveReview.run(tx, {
          route,
          board_id: original.board_id,
          author_id: actor.accountId,
          subject_id: original.subject_id,
        });
        return noEffect(live && live.thread_id !== original.thread_id ? { original, id: live.thread_id } : null);
      },
    );
    if (!candidate.value) return null;
    // Release original home before any board/subject/Realm/Space preparation.
    // The index row is data only. Ordinary reads retain all current source and
    // ancestor fences and independently check the actual request actor's scopes.
    const { original, id } = candidate.value;
    return await withEditionReadTime(deps, context, async (time) => {
      // Reuse the existing native source-subject guard: ordinary thread reads
      // do not themselves authorize disclosure of the referenced subject.
      const accessContext = { pool: deps.pool, deadline: context.deadline };
      const subject = await prepareEditionSubject(deps, original.subject_id!, time, accessContext, (action, anchor) =>
        accessCheck(deps.access, actor, action, anchor.resource, accessContext),
      );
      if (!subject) return null;
      const thread = (await readThread(deps, id, context)).value;
      if (
        !thread ||
        thread.id !== id ||
        thread.kind !== 'review' ||
        thread.authorId !== actor.accountId ||
        thread.boardId !== original.board_id ||
        thread.subjectIds.length !== 1 ||
        thread.subjectIds[0] !== original.subject_id ||
        thread.availability !== 'available' ||
        thread.firstPost.availability !== 'available' ||
        !(await subject.final())
      )
        return null;
      return { existingThreadId: thread.id };
    });
  } catch (error) {
    if (error instanceof ContentNotFoundError || error instanceof ReadNotFoundError) return null;
    // Unavailability and expired request budgets keep their native typed failure.
    throw error;
  }
}
