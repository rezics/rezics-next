/** Server-held query context. A locator, structural capture or public output cannot enter this branch. */
import { authoritativeTimeValue, commandAttemptDeadline } from '../command/command.ts';
import { requireAccessDeadline } from '../request/unavailable.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readNativeCollectionMemberAdmission } from './owner-filter.ts';
import { contexts, type Context } from './owner-filter-working-context.ts';

/** Reenter only with the immutable ordinary admission and the SAME native time/attempt and ledger.
 * This selects private Source semantics; current Collection, account and family Access remain mandatory.
 */
export function withAdmittedOwnerWorkingSource<T>(context: Context, body: () => Promise<T>): Promise<T> {
  const admitted = readNativeCollectionMemberAdmission(context.admission);
  const route = routeOf(context.collectionId);
  if (!admitted || admitted.pool !== context.pool || admitted.actor !== context.actor || route === null)
    throw new TypeError('Foreign owner working Source admission');
  authoritativeTimeValue(context.at);
  requireAccessDeadline(Math.min(context.deadline, admitted.deadline));
  context.work.assertReady();
  if (
    context.attempt &&
    (context.attempt.time !== context.at ||
      context.attempt.partition !== partitionOf(route) ||
      context.actor.kind !== 'account' ||
      context.attempt.basis?.actorAccountId !== context.actor.accountId ||
      context.attempt.basis.clientId !== context.actor.clientId ||
      context.attempt.basis.requestedBy !== context.actor.requestedBy ||
      context.deadline > commandAttemptDeadline(context.attempt))
  )
    throw new TypeError('Foreign owner working Source attempt');
  return contexts.run(context, body);
}
