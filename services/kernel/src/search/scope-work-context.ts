import type { Pool } from 'pg';
import { authoritativeTimeValue, commandTime, type AuthoritativeTime } from '../command/command.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import { ProblemError } from '../http/problem.ts';
import { createMembersPreparation, type PreparationLocator } from '../library/members-preparation.ts';
import type { Access } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';

/** SERVER ONLY. A native lookup, never an Actor, permission, DTO or persisted cursor value. */
export type MembersPreparationWorkContext = Readonly<{
  kind: 'members-preparation';
  tx: OperationalTransaction;
  locator: PreparationLocator;
}>;

/** Repeat native admission on every use; neither this tuple nor an earlier admission is authority. */
export async function admitMembersPreparationWork(
  work: MembersPreparationWorkContext,
  options: Readonly<{ pool: Pool; access: Access; deadline: number }>,
): Promise<AuthoritativeTime> {
  if (work.kind !== 'members-preparation' || !hasLiveOperationalTransaction(work.tx))
    throw new ProblemError('semantic_not_ready');
  const resources = currentOperationalResources(work.tx);
  const locator = Object.freeze({ ...work.locator });
  const route = routeOf(locator.collectionId);
  if (
    route === null ||
    locator.route !== route ||
    routeOf(locator.ownerAccountId) !== route ||
    resources.pool !== options.pool ||
    resources.mode !== 'work-step' ||
    resources.partition !== partitionOf(route) ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== locator.ownerAccountId ||
    !Number.isFinite(options.deadline) ||
    Date.now() >= Math.min(options.deadline, resources.deadline)
  )
    throw new ProblemError('semantic_not_ready');
  const time = commandTime(work.tx);
  if (!time) throw new ProblemError('semantic_not_ready');
  authoritativeTimeValue(time);
  const preparation = createMembersPreparation({
    pool: resources.pool,
    workClient: resources.workClient,
    access: options.access,
  });
  // Library alone locks the current namespace/owner/episode and immutable definition.
  // Its unavailable native producer must propagate; no local permission or fabricated episode substitutes.
  if ((await preparation.admitStep(work.tx, locator)) !== true)
    throw new ProblemError('semantic_not_ready');
  if (!hasLiveOperationalTransaction(work.tx) || Date.now() >= Math.min(options.deadline, resources.deadline))
    throw new ProblemError('semantic_not_ready');
  authoritativeTimeValue(time);
  return time;
}
