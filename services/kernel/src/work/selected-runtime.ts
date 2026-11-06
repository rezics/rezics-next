import { memoizedValue } from '../memoized.ts';
import type { Pool, QueryResult } from 'pg';
import {
  currentOperationalResources,
  type OperationalOptions,
  type OperationalTransaction,
} from '../command/operational.ts';
import {
  type ExecutionTransaction,
  type SelectedExecutionPhase,
  type WorkExecutionOriginal,
  type WorkExecutionPort,
} from '../command/execution-contract.ts';
import { enqueueWorkIntent, type WorkClient, type WorkIntent } from './client.ts';
import { WORK_EXECUTION_ATTEMPT_BOUND, type SelectedCost } from './selected-runtime-cost.ts';
import type { SelectedEpisode, SelectedLocator, SelectedOutcome } from '../history/contract/index.ts';
import { ensureNativeWorkApplication } from './adapters/index.ts';
import { SelectedRuntimeUnavailable } from './application/index.ts';
import type { WorkSelectedIdentity } from './contract/index.ts';

export { SelectedRuntimeUnavailable };
export type SelectedIdentity = WorkSelectedIdentity;
export type SelectedNativeDeclaration = Readonly<{ sql: string; limit: number; cost: SelectedCost }>;
export type SelectedChildren = Readonly<{
  native: readonly SelectedNativeDeclaration[];
  source?: SelectedCost;
}>;
export type SelectedInvocation = Readonly<{
  deadline: number;
  select(locator: SelectedLocator): Promise<SelectedEpisode>;
  source<T>(body: (deadline: number) => Promise<T>): Promise<T>;
  apply(
    episode: SelectedEpisode,
    body: (tx: OperationalTransaction) => Promise<SelectedOutcome>,
  ): Promise<SelectedOutcome>;
  failure(
    episode: SelectedEpisode,
    body: (tx: OperationalTransaction) => Promise<SelectedOutcome>,
  ): Promise<SelectedOutcome>;
}>;
export type SelectedRuntime = Readonly<{
  registerMembersStep<R>(
    body: (invocation: SelectedInvocation, locator: SelectedLocator) => Promise<R>,
    children?: SelectedChildren,
  ): (locator: SelectedLocator) => Promise<R>;
}>;
export type SelectedOperationalPhase = SelectedExecutionPhase;

export class WorkExecutionUnavailable extends Error {
  constructor(readonly gap: string) {
    super(gap);
  }
}

type ExecutionOriginalState = { pool: Pool; client: WorkClient; deadline: number; claimed: boolean; attempts: number };
const executionOriginals = new WeakMap<WorkExecutionOriginal, ExecutionOriginalState>();
const executionTransactions = new WeakMap<ExecutionTransaction, WorkExecutionOriginal>();

/** Work creates this opaque original once; retries retain its pool, client and absolute deadline. */
export function openWorkExecutionOriginal(pool: Pool, deadline: number, client: WorkClient): WorkExecutionOriginal {
  if (!Number.isFinite(deadline) || Date.now() >= deadline)
    throw new WorkExecutionUnavailable('work-execution-deadline');
  const original = Object.freeze({}) as WorkExecutionOriginal;
  executionOriginals.set(original, { pool, client, deadline, claimed: false, attempts: 0 });
  return original;
}

/** Executor entry claims the exact original before authorization, checkout or BEGIN. */
export function claimWorkExecutionOriginal(
  original: WorkExecutionOriginal,
  pool: Pool,
  client: WorkClient,
  deadline: number,
): WorkExecutionOriginal {
  const state = executionOriginals.get(original);
  if (
    !state ||
    state.claimed ||
    state.pool !== pool ||
    state.client !== client ||
    state.deadline !== deadline ||
    Date.now() >= deadline
  )
    throw new WorkExecutionUnavailable('work-execution-original-unavailable');
  state.claimed = true;
  return original;
}

export function debitWorkExecutionAttempt(original: WorkExecutionOriginal): void {
  const state = executionOriginals.get(original);
  if (!state?.claimed || Date.now() >= state.deadline)
    throw new WorkExecutionUnavailable('work-execution-original-unavailable');
  if (++state.attempts > WORK_EXECUTION_ATTEMPT_BOUND)
    throw new WorkExecutionUnavailable('work-execution-attempt-bound');
}

function assertExecutionTransaction(tx: ExecutionTransaction, original: WorkExecutionOriginal): void {
  const state = executionOriginals.get(original);
  const resources = currentOperationalResources(tx as OperationalTransaction);
  if (
    executionTransactions.get(tx) !== original ||
    !state?.claimed ||
    state.pool !== resources.pool ||
    state.client !== resources.workClient ||
    state.deadline !== resources.deadline
  )
    throw new WorkExecutionUnavailable('work-execution-original-transaction-unavailable');
}

/** Work owner check used by History's native transfer adapter. */
export function assertWorkExecutionOriginal(tx: ExecutionTransaction, original: WorkExecutionOriginal): void {
  assertExecutionTransaction(tx, original);
}

function bindWorkExecutionOriginal(tx: ExecutionTransaction, original: WorkExecutionOriginal): void {
  const state = executionOriginals.get(original);
  const resources = currentOperationalResources(tx as OperationalTransaction);
  if (
    executionTransactions.has(tx) ||
    !state?.claimed ||
    state.pool !== resources.pool ||
    state.client !== resources.workClient ||
    state.deadline !== resources.deadline
  )
    throw new WorkExecutionUnavailable('work-execution-original-transaction-unavailable');
  executionTransactions.set(tx, original);
}

function finishWorkExecutionTransaction(tx: ExecutionTransaction): void {
  executionTransactions.delete(tx);
}

export function selectedOperationalEnqueue(
  tx: OperationalTransaction,
  intent: WorkIntent,
): ((created: boolean) => void) | undefined {
  return ensureNativeWorkApplication().selectedOperationalEnqueue(tx, intent);
}

export function assertSelectedOperationalTransaction(tx: OperationalTransaction, expected: SelectedIdentity): void {
  ensureNativeWorkApplication().assertSelectedOperationalTransaction(tx, expected);
}

export function selectedLocalQuery(
  tx: OperationalTransaction,
  expected: SelectedIdentity,
  sql: string,
  values?: unknown[],
): Promise<QueryResult> {
  return ensureNativeWorkApplication().selectedLocalQuery(tx, expected, sql, values) as Promise<QueryResult>;
}

export function assertSelectedContinuation(
  tx: OperationalTransaction,
  expected: SelectedIdentity,
  workflow: string,
): void {
  ensureNativeWorkApplication().assertSelectedContinuation(tx, expected, workflow);
}

export function openSelectedOperationalPhase(pool: Pool, options: OperationalOptions) {
  return ensureNativeWorkApplication().openSelectedOperationalPhase(pool, options);
}

export function composeSelectedRuntime(pool: Pool, work: WorkClient): SelectedRuntime {
  return ensureNativeWorkApplication().composeSelectedRuntime(pool, work) as SelectedRuntime;
}

/** Work-owned adapter installed on each native WorkClient by the Kernel composition roots. */
export function workExecutionPort(): WorkExecutionPort {
  return memoizedValue(workExecutionPort, () =>
    Object.freeze({
      openOriginal: openWorkExecutionOriginal,
      claimOriginal: claimWorkExecutionOriginal,
      debitAttempt: debitWorkExecutionAttempt,
      bindOriginal: bindWorkExecutionOriginal,
      assertOriginal: assertWorkExecutionOriginal,
      finishTransaction: finishWorkExecutionTransaction,
      openSelectedPhase(pool: Pool, options: unknown) {
        return openSelectedOperationalPhase(pool, options as OperationalOptions) as SelectedExecutionPhase | undefined;
      },
      selectedEnqueue: selectedOperationalEnqueue,
      enqueue: enqueueWorkIntent,
    }),
  );
}

export type { SelectedEpisode, SelectedLocator, SelectedOutcome };
