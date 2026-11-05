/** Server-held query context. A locator, structural capture or public output cannot enter this branch. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
import {
  authoritativeTimeValue,
  commandAttemptDeadline,
  type AuthoritativeTime,
  type CommandAttempt,
} from '../command/command.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readNativeCollectionMemberAdmission, type CollectionMemberAdmission } from './owner-filter.ts';
import type { NativeCollectionWork } from '../work-ledger/native-collection-work.ts';

type Context = Readonly<{
  pool: Pool;
  actor: Actor;
  collectionId: string;
  admission: CollectionMemberAdmission;
  at: AuthoritativeTime;
  deadline: number;
  work: NativeCollectionWork;
  attempt?: CommandAttempt;
}>;
const contexts = new AsyncLocalStorage<Context>();

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

/** Context lookup never grants authority. The native reader still checks the actual current curator/account. */
export function admittedOwnerWorkingSource(pool: Pool, collectionId: string) {
  const context = contexts.getStore();
  if (
    !context ||
    context.pool !== pool ||
    context.collectionId !== collectionId ||
    context.actor.kind !== 'account' ||
    !context.admission.filter
  )
    return undefined;
  authoritativeTimeValue(context.at);
  requireAccessDeadline(context.deadline);
  context.work.assertReady();
  return context;
}
