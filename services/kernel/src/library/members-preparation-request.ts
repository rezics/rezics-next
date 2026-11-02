import type { Pool } from 'pg';
import {
  fundOperationalWorkOriginal,
  OPERATIONAL_WORK_LOCAL_DECLARATION,
  sumOperationalWork,
} from '../history/operational-work-budget.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { WorkClient } from '../work/client.ts';
import type { WorkReceipt } from './collection-source.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import {
  declareMembersPreparationParent,
  type MembersPreparationOwnerDeclarations,
} from './members-preparation-budget.ts';
import {
  preparationDefinitionBases,
  type MembersPreparation,
  type MembersPreparationHistory,
  type PreparationDefinition,
  type PreparingEpisode,
} from './members-preparation.ts';

// History's complete native original already includes these bodies, executor controls and their retries.
// They must not also become independently spendable children of this request.
const historyChildren = new Set([
  'historyRegistration',
  'receivingReadback',
  'historyResolve',
  'historyVerify',
  'historyReplay',
  'historyRetirement',
  'executor',
]);
const attempted = new WeakMap<NativeCollectionWork, Set<string>>();

export type MembersPreparationRequestChildren = Readonly<{
  sourceResolve: NativeCollectionWork;
  sourceVerify: NativeCollectionWork;
  selectedRuntime: NativeCollectionWork;
}>;
export type MembersPreparationRequest = Readonly<{
  episode: PreparingEpisode;
  /** Null for a duplicate: only the creating transaction registers a durable original and intent. */
  history: MembersPreparationHistory | null;
  children: MembersPreparationRequestChildren;
}>;

/** The complete request price, using History's released native retry declaration exactly once.
 * Other owners remain explicit, including any Source/selected-runtime failure and cleanup work.
 */
export function declareMembersPreparationRequest(owners: MembersPreparationOwnerDeclarations) {
  const declared = declareMembersPreparationParent(owners);
  const ownerChildren = Object.fromEntries(
    Object.entries(declared.children).filter(([name]) => !historyChildren.has(name)),
  ) as Omit<
    typeof declared.children,
    | 'historyRegistration'
    | 'receivingReadback'
    | 'historyResolve'
    | 'historyVerify'
    | 'historyReplay'
    | 'historyRetirement'
    | 'executor'
  >;
  const children = Object.freeze({ ...ownerChildren, history: OPERATIONAL_WORK_LOCAL_DECLARATION });
  return Object.freeze({ children, total: sumOperationalWork(...Object.values(children)) });
}

/** One exact native episode, committed before the Source callback can start.
 * The caller lends its existing finite request parent and supplies all non-History owner prices.
 * This does not authorize Source execution, result publication, disclosure or a selected-runtime apply.
 * The callback must acquire those actual authorities and await every dispatched child operation.
 */
export async function runMembersPreparationRequest<T>(
  dependencies: Readonly<{ pool: Pool; workClient: WorkClient; preparation: MembersPreparation }>,
  input: Readonly<{
    actor: Actor;
    collectionId: string;
    definition: PreparationDefinition;
    parent: NativeCollectionWork;
    owners: MembersPreparationOwnerDeclarations;
  }>,
  source: (request: MembersPreparationRequest) => Promise<T>,
  cleanup: (
    children: Readonly<{ rollback: NativeCollectionWork; cleanup: NativeCollectionWork }>,
    outcome: Readonly<{ ok: true } | { ok: false; error: unknown }>,
  ) => Promise<void>,
): Promise<Readonly<{ value: T; work: WorkReceipt }>> {
  const { actor, collectionId, parent } = input;
  const route = routeOf(collectionId);
  if (actor.kind !== 'account' || route === null || routeOf(actor.accountId) !== route)
    throw new ProblemError('not_found');
  // Snapshot retained meaning before any await. A caller editing its filter cannot retarget this admission.
  const [basis] = preparationDefinitionBases(actor.accountId, collectionId, [input.definition]);
  if (!basis || attempted.get(parent)?.has(basis.canonicalBasis)) throw new ProblemError('dependency_unavailable');
  const declared = declareMembersPreparationRequest(input.owners);
  // Transfer the WHOLE episode, including native History's three-attempt original, before checkout.
  // No new ledger is made from a local subtotal, and siblings cannot borrow the held Source partitions.
  const funded = parent.transferChildren(declared.children);
  const keys = attempted.get(parent) ?? new Set<string>();
  keys.add(basis.canonicalBasis);
  attempted.set(parent, keys);
  const children = funded.children;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    // Conservative complete owner declarations cover their reached bodies, failed prefixes and retries.
    // Allocation alone spends nothing: debit them immediately before the native reservation dispatch.
    for (const name of ['members', 'core', 'access', 'transferControls', 'retry'] as const) {
      const reservation = children[name].reserve(declared.children[name]);
      reservation.dispatch();
      reservation.settle();
    }
    const history = fundOperationalWorkOriginal(
      children.history,
      dependencies.pool,
      dependencies.workClient,
      parent.deadlineAt,
    );
    const reserved = await dependencies.preparation.reserve(actor, collectionId, [basis.definition], {
      deadline: parent.deadlineAt,
      history,
    });
    const [episode] = reserved.episodes;
    if (
      reserved.episodes.length !== 1 ||
      !episode ||
      episode.state !== 'preparing' ||
      episode.locator.route !== route ||
      episode.locator.ownerAccountId !== actor.accountId ||
      episode.locator.collectionId !== collectionId ||
      (reserved.intent !== null && !reserved.history)
    )
      throw new ProblemError('dependency_unavailable');
    outcome = {
      ok: true,
      value: await source(
        Object.freeze({
          episode,
          history: reserved.history ?? null,
          children: Object.freeze({
            sourceResolve: children.sourceResolve,
            sourceVerify: children.sourceVerify,
            selectedRuntime: children.selectedRuntime,
          }),
        }),
      ),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const failures: unknown[] = outcome.ok ? [] : [outcome.error];
  try {
    await cleanup(
      Object.freeze({ rollback: children.rollback, cleanup: children.cleanup }),
      Object.freeze(outcome.ok ? { ok: true as const } : { ok: false as const, error: outcome.error }),
    );
  } catch (error) {
    failures.push(error);
  }
  let work: WorkReceipt | undefined;
  try {
    work = funded.finish();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    const error = failures.length === 1 ? failures[0] : new AggregateError(failures, 'Members reservation failed');
    if (error instanceof Error && Object.isExtensible(error)) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'work');
      if (!descriptor || descriptor.configurable)
        Object.defineProperty(error, 'work', { get: () => parent.receipt(), configurable: true });
    }
    throw error;
  }
  if (!outcome.ok || !work) throw new TypeError('Members reservation did not settle');
  return Object.freeze({ value: outcome.value, work });
}
