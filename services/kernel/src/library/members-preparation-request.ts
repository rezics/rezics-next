import type { Pool } from 'pg';
import {
  OPERATIONAL_WORK_LOCAL_DECLARATION,
  sumOperationalWork,
} from '../history/operational-work-budget.ts';
import { openWorkExecutionOriginal } from '../work/selected-runtime.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import type { WorkClient } from '../work/client.ts';
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

const historyChildren = new Set([
  'historyRegistration',
  'receivingReadback',
  'historyResolve',
  'historyVerify',
  'historyReplay',
  'historyRetirement',
  'executor',
]);

export type MembersPreparationRequest = Readonly<{
  episode: PreparingEpisode;
  /** Null for a duplicate: only the creating transaction registers a durable original and intent. */
  history: MembersPreparationHistory | null;
}>;

/** Documented static equation: History's three-attempt original once; other owners stay explicit. */
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
 * History opens from documented static bounds. This does not authorize Source execution,
 * result publication, disclosure or a selected-runtime apply.
 */
export async function runMembersPreparationRequest<T>(
  dependencies: Readonly<{ pool: Pool; workClient: WorkClient; preparation: MembersPreparation }>,
  input: Readonly<{
    actor: Actor;
    collectionId: string;
    definition: PreparationDefinition;
    deadline?: number;
  }>,
  source: (request: MembersPreparationRequest) => Promise<T>,
  cleanup: (outcome: Readonly<{ ok: true } | { ok: false; error: unknown }>) => Promise<void>,
): Promise<Readonly<{ value: T }>> {
  const { actor, collectionId } = input;
  const route = routeOf(collectionId);
  if (actor.kind !== 'account' || route === null || routeOf(actor.accountId) !== route)
    throw new ProblemError('not_found');
  const [basis] = preparationDefinitionBases(actor.accountId, collectionId, [input.definition]);
  if (!basis) throw new ProblemError('dependency_unavailable');
  const deadline = input.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  const history = openWorkExecutionOriginal(dependencies.pool, deadline, dependencies.workClient);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const reserved = await dependencies.preparation.reserve(actor, collectionId, [basis.definition], {
      deadline,
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
      value: await source(Object.freeze({ episode, history: reserved.history ?? null })),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const failures: unknown[] = outcome.ok ? [] : [outcome.error];
  try {
    await cleanup(Object.freeze(outcome.ok ? { ok: true as const } : { ok: false as const, error: outcome.error }));
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Members reservation failed');
  }
  if (!outcome.ok) throw new TypeError('Members reservation did not settle');
  return Object.freeze({ value: outcome.value });
}
