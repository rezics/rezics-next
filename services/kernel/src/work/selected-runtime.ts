import canonicalize from 'canonicalize';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import type { Pool, PoolClient } from 'pg';
import {
  currentOperationalResources,
  runOperationalTransaction,
  type OperationalOptions,
  type OperationalTransaction,
} from '../command/operational.ts';
import {
  type ExecutionTransaction,
  type SelectedExecutionPhase,
  type WorkExecutionOriginal,
  type WorkExecutionPort,
} from '../command/execution-contract.ts';
import { assertSelectedWorkClient, enqueueWorkIntent, type WorkClient, type WorkIntent } from './client.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { isBound } from '@rezics/bounds';
import { WORK_EXECUTION_ATTEMPT_BOUND, type SelectedCost } from './selected-runtime-cost.ts';
import {
  associateSelectedEpisode,
  finishSelectedEpisode,
  type SelectedEpisode,
  type SelectedLocator,
  type SelectedOutcome,
} from '../history/operational-work-selected.ts';

export type SelectedIdentity = Readonly<{
  workflowID: string;
  functionID: number;
  stepName: string;
  attemptGeneration: string;
  restoreGeneration: string;
  workflowName: string;
  queueName: string | null;
  creatorXid: string | null;
  serialization: string | null;
  inputs: string;
  stepArguments: string;
  deadline: number;
  schema: string;
}>;
type Claim = object;
type Lifecycle = {
  open(): Promise<{
    deadline: number;
    reserve(dispatch: 'issue' | 'release'): Promise<void>;
    close(): Promise<void>;
    run<T>(body: () => Promise<T>): Promise<T>;
  }>;
};
type NativeSdk = DBOSClient & {
  selectedExecutionIdentity(claim: Claim, pool: Pool): SelectedIdentity;
  consumeSelectedExecutionAdmission(claim: Claim, pool: Pool): Promise<boolean>;
  checkSelectedExecutionInTransaction(tx: Pick<PoolClient, 'query'>, pool: Pool, claim: Claim): Promise<void>;
};
type RuntimeSdk = typeof DBOS & {
  registerSelectedStep<A extends unknown[], R>(
    body: (...args: A) => Promise<R>,
    config: { name: string },
    lifecycle: Lifecycle,
  ): (...args: A) => Promise<R>;
  getSelectedExecution(): Claim | undefined;
};
export class SelectedRuntimeUnavailable extends Error {
  constructor(readonly gap: string) {
    super(gap);
  }
}
function refuse(gap: string): never {
  throw new SelectedRuntimeUnavailable(gap);
}
export class WorkExecutionUnavailable extends Error {
  constructor(readonly gap: string) {
    super(gap);
  }
}
type ExecutionOriginalState = { pool: Pool; client: WorkClient; deadline: number; claimed: boolean; attempts: number };
const executionOriginals = new WeakMap<WorkExecutionOriginal, ExecutionOriginalState>();
const executionTransactions = new WeakMap<ExecutionTransaction, WorkExecutionOriginal>();

/** Work creates this opaque original once; retries retain its pool, client and absolute deadline. */
export function openWorkExecutionOriginal(
  pool: Pool,
  deadline: number,
  client: WorkClient,
): WorkExecutionOriginal {
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
/** Reviewed literal native statements, each with its complete child declaration and multiplicity.
 * This is a dispatch description, never a Source or user authorization capability. */
export type SelectedNativeDeclaration = Readonly<{ sql: string; limit: number; cost: SelectedCost }>;
export type SelectedChildren = Readonly<{
  native: readonly SelectedNativeDeclaration[];
  /** Complete released Source invocation, including reached failure and its cleanup. */
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
  /** Trusted Work registration. One invocation is ONE episode; cleanup has separate authority. */
  registerMembersStep<R>(
    body: (invocation: SelectedInvocation, locator: SelectedLocator) => Promise<R>,
    children?: SelectedChildren,
  ): (locator: SelectedLocator) => Promise<R>;
}>;
type Original = {
  pool: Pool;
  work: NativeSdk;
  deadline: number;
  children: SelectedChildren | undefined;
  counts: Map<string, number>;
  claim?: Claim;
  identity?: SelectedIdentity;
  revoked: boolean;
  phase: 'new' | 'selecting' | 'selected' | 'source' | 'read' | 'applied' | 'failed';
  busy: boolean;
  operations: Set<Promise<unknown>>;
  nativeLifecycle: 'open' | 'issued' | 'closing' | 'closed' | 'released';
  closeDrain?: Promise<void>;
  localQuery?: string | undefined;
  continuation?: string;
  locator?: SelectedLocator;
  attempted: Set<string>;
};
const active = new AsyncLocalStorage<Original>();
function live(state: Original): void {
  if (state.revoked || Date.now() >= state.deadline) refuse('selected-runtime-not-live');
}
function identity(state: Original): SelectedIdentity {
  if (!state.claim || state.revoked || Date.now() >= state.deadline) refuse('selected-runtime-not-live');
  const observed = state.work.selectedExecutionIdentity(state.claim, state.pool);
  return state.identity ?? observed;
}
function scope(state: Original, locator: SelectedLocator): void {
  if (
    routeOf(locator.ownerAccountId) !== locator.route ||
    routeOf(locator.collectionId) !== locator.route ||
    routeOf(locator.episodeId) !== locator.route
  )
    throw new TypeError('Invalid selected episode locator');
  if (state.locator && canonicalize(state.locator) !== canonicalize(locator))
    refuse('selected-runtime-episode-changed');
  state.locator ??= Object.freeze({ ...locator });
}
export type SelectedOperationalPhase = SelectedExecutionPhase;
type Phase = { original: Original; locator: SelectedLocator; kind: 'select' | 'apply' | 'failure'; used: boolean };
const phases = new WeakMap<SelectedOperationalPhase, Phase>();
const transactionSelections = new WeakMap<OperationalTransaction, Original>();
/** Same executor enqueue, exactly once; SDK costs are paid independently of foreign native SQL. */
export function selectedOperationalEnqueue(
  tx: OperationalTransaction,
  intent: WorkIntent,
): ((created: boolean) => void) | undefined {
  const state = transactionSelections.get(tx);
  if (!state) return;
  identity(state);
  const l = state.locator!;
  if (
    state.counts.has('sdk-enqueue') ||
    intent.workflowName !== 'library.membersPreparation' ||
    intent.queue !== 'workflows' ||
    intent.arguments ||
    Buffer.byteLength(JSON.stringify(intent.input)) > 4096 ||
    JSON.stringify(intent.input) !==
      JSON.stringify({
        accounts: [l.ownerAccountId],
        route: l.route,
        episodes: [{ collectionId: l.collectionId, episodeId: l.episodeId }],
        cleanup: [],
      })
  )
    refuse('selected-runtime-continuation-enqueue-refused');
  state.counts.set('sdk-enqueue', 1);
  return (created) => {
    identity(state);
    if (!created) refuse('selected-runtime-continuation-not-new');
    state.continuation = intent.workflowId;
  };
}
/** History can dispatch owned SQL only with the exact private identity of this live transaction. */
export function assertSelectedOperationalTransaction(tx: OperationalTransaction, expected: SelectedIdentity): void {
  const state = transactionSelections.get(tx);
  if (!state || state.identity !== expected) refuse('selected-runtime-forged-association');
  identity(state);
  currentOperationalResources(tx);
}
export function selectedLocalQuery(
  tx: OperationalTransaction,
  expected: SelectedIdentity,
  sql: string,
  values?: unknown[],
) {
  assertSelectedOperationalTransaction(tx, expected);
  const state = transactionSelections.get(tx)!;
  if (state.localQuery) refuse('selected-runtime-nested-local-dispatch');
  state.localQuery = sql;
  try {
    return tx.query(sql, values);
  } finally {
    state.localQuery = undefined;
  }
}
export function assertSelectedContinuation(
  tx: OperationalTransaction,
  expected: SelectedIdentity,
  workflow: string,
): void {
  assertSelectedOperationalTransaction(tx, expected);
  if (transactionSelections.get(tx)!.continuation !== workflow)
    refuse('selected-runtime-continuation-not-enqueued-here');
}
function phaseToken(state: Original, locator: SelectedLocator, kind: Phase['kind']): SelectedOperationalPhase {
  identity(state);
  scope(state, locator);
  if (state.busy || state.attempted.has(kind)) refuse('selected-runtime-repeated-phase');
  state.attempted.add(kind);
  const token = Object.freeze({}) as SelectedOperationalPhase;
  phases.set(token, { original: state, locator, kind, used: false });
  return token;
}
/** Executor-only optional lifecycle. Native transaction construction and live maps stay in operational.ts. */
export function openSelectedOperationalPhase(pool: Pool, options: OperationalOptions) {
  const binding = options.selectedRuntime && phases.get(options.selectedRuntime);
  if (!binding || binding.used) refuse('selected-runtime-forged-phase');
  const { original: state, locator, kind } = binding;
  identity(state);
  if (
    pool !== state.pool ||
    options.workClient !== state.work ||
    options.mode !== 'work-step' ||
    options.operationalHistory ||
    options.partition !== partitionOf(locator.route) ||
    options.kind !== `library.membersPreparation.${kind === 'select' ? 'step' : kind}` ||
    options.accounts.length !== 1 ||
    options.accounts[0] !== locator.ownerAccountId ||
    (options.deadline !== undefined && options.deadline !== state.deadline)
  )
    refuse('selected-runtime-foreign-transaction');
  binding.used = true;
  live(state);
  state.busy = true;
  let guarded = false;
  let held: OperationalTransaction | undefined;
  return {
    deadline: state.deadline,
    assertLive() {
      identity(state);
    },
    query(sql: unknown) {
      identity(state);
      if (!guarded) return;
      if (typeof sql !== 'string') refuse('selected-runtime-unknown-native-sql');
      if (state.localQuery === sql) {
        state.localQuery = undefined;
        return;
      }
      const declaration = state.children?.native.find((item) => item.sql === sql);
      if (!declaration) refuse('selected-runtime-unknown-native-sql');
      const count = state.counts.get(sql) ?? 0;
      if (count >= declaration.limit) refuse('selected-runtime-native-multiplicity-exhausted');
      state.counts.set(sql, count + 1);
    },
    async hold(tx: OperationalTransaction, raw: PoolClient) {
      held = tx;
      transactionSelections.set(tx, state);
      const current = currentOperationalResources(tx);
      if (current.pool !== state.pool || current.workClient !== state.work || current.deadline !== state.deadline)
        refuse('selected-runtime-foreign-client');
      await state.work.checkSelectedExecutionInTransaction(raw, state.pool, state.claim!);
    },
    guardBody() {
      guarded = true;
    },
    finish() {
      if (held) transactionSelections.delete(held);
      state.busy = false;
    },
  };
}
async function transaction<T>(
  state: Original,
  locator: SelectedLocator,
  kind: Phase['kind'],
  body: (tx: OperationalTransaction) => Promise<T>,
): Promise<T> {
  const selectedRuntime = phaseToken(state, locator, kind);
  const operation = runOperationalTransaction(
    state.pool,
    {
      mode: 'work-step',
      partition: partitionOf(locator.route),
      kind: `library.membersPreparation.${kind === 'select' ? 'step' : kind}`,
      accounts: [locator.ownerAccountId],
      workClient: state.work as WorkClient,
      deadline: state.deadline,
      selectedRuntime,
    },
    body,
  );
  state.operations.add(operation);
  try {
    return await operation;
  } finally {
    state.operations.delete(operation);
  }
}
function trackOperation<T>(state: Original, operation: Promise<T>): Promise<T> {
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  state.operations.add(settled);
  void settled.then(() => state.operations.delete(settled));
  return operation;
}
/** Trusted composition only. The genuine client binding is installed solely by createWorkClient. */
export function composeSelectedRuntime(pool: Pool, work: WorkClient): SelectedRuntime {
  assertSelectedWorkClient(work, pool);
  const sdk = DBOS as RuntimeSdk;
  if (
    typeof sdk.registerSelectedStep !== 'function' ||
    typeof sdk.getSelectedExecution !== 'function' ||
    !(work instanceof DBOSClient) ||
    typeof (work as NativeSdk).selectedExecutionIdentity !== 'function'
  )
    refuse('selected-runtime-sdk-extension-unavailable');
  return Object.freeze({
    registerMembersStep<R>(
      body: (invocation: SelectedInvocation, locator: SelectedLocator) => Promise<R>,
      children?: SelectedChildren,
    ) {
      // Capture a defensive immutable declaration once at registration, never from a workflow locator.
      const declarations = children && structuredClone(children);
      if (
        declarations &&
        (declarations.native.length > 64 ||
          new Set(declarations.native.map((x) => x.sql)).size !== declarations.native.length ||
          declarations.native.some((x) => !x.sql || !Number.isSafeInteger(x.limit) || x.limit < 1 || x.limit > 64))
      )
        throw new TypeError('Invalid selected native declaration');
      const sourceCost = declarations?.source;
      if (
        declarations &&
        (declarations.native.some((item) => !isBound(item.cost)) || (sourceCost && !isBound(sourceCost)))
      )
        throw new TypeError('Invalid selected native declaration');
      const lifecycle: Lifecycle = {
        async open() {
          const state: Original = {
            pool,
            work: work as NativeSdk,
            deadline: Date.now() + 5000,
            children: declarations,
            counts: new Map(),
            nativeLifecycle: 'open',
            revoked: false,
            phase: 'new',
            busy: false,
            operations: new Set(),
            attempted: new Set(),
          };
          // Native capability and held database owner locks supply execution authority.
          // Async context pairs the documented static bound with its registered body.
          return {
            deadline: state.deadline,
            run<T>(run: () => Promise<T>) {
              return active.run(state, run);
            },
            // New useful work is live-bound; only this issued, closed lifecycle can authorize terminal release.
            async reserve(dispatch) {
              if (dispatch !== 'issue' && dispatch !== 'release') refuse('selected-runtime-unpriced-sdk-dispatch');
              if (dispatch === 'issue') {
                if (state.nativeLifecycle !== 'open') {
                  refuse(
                    state.nativeLifecycle === 'issued'
                      ? 'selected-runtime-repeated-sdk-dispatch'
                      : 'selected-runtime-issue-after-close',
                  );
                }
                live(state);
                state.nativeLifecycle = 'issued';
                state.counts.set('sdk-issue', 1);
                return;
              }
              if (state.nativeLifecycle === 'released') refuse('selected-runtime-repeated-sdk-dispatch');
              if (state.nativeLifecycle !== 'closed' || !state.counts.has('sdk-issue'))
                refuse('selected-runtime-release-before-close');
              // The SDK's private finally owns the exact identity/owner pair for its one release query.
              state.nativeLifecycle = 'released';
              state.counts.set('sdk-release', 1);
            },
            async close() {
              if (state.nativeLifecycle === 'released') refuse('selected-runtime-close-after-release');
              if (state.closeDrain) return state.closeDrain;
              state.nativeLifecycle = 'closing';
              state.revoked = true;
              state.closeDrain = Promise.allSettled([...state.operations]).then(() => {
                state.nativeLifecycle = 'closed';
              });
              return state.closeDrain;
            },
          };
        },
      };
      return sdk.registerSelectedStep(
        async (locator: SelectedLocator) => {
          const state = active.getStore();
          const claim = sdk.getSelectedExecution();
          if (!state || state.pool !== pool || !claim) refuse('selected-runtime-authentic-selection-unavailable');
          state.claim = claim;
          state.identity = identity(state);
          if (
            state.identity.stepName !== 'library.membersPreparation.step' ||
            state.identity.workflowName !== 'library.membersPreparation' ||
            state.identity.schema !== 'dbos' ||
            state.identity.stepArguments !== JSON.stringify([locator])
          )
            refuse('selected-runtime-registration-mismatch');
          const invocation: SelectedInvocation = Object.freeze({
            deadline: state.deadline,
            async select(input) {
              if (state.phase !== 'new') refuse('selected-runtime-repeated-selection');
              scope(state, input);
              identity(state);
              state.phase = 'selecting';
              const fresh = await trackOperation(
                state,
                state.work.consumeSelectedExecutionAdmission(claim, state.pool),
              );
              const episode = await transaction(state, input, 'select', (tx) =>
                associateSelectedEpisode(tx, identity(state), input, fresh),
              );
              state.phase = episode.result ? 'applied' : 'selected';
              return episode;
            },
            async source<T>(read: (deadline: number) => Promise<T>) {
              if (state.phase !== 'selected' || state.busy || !declarations?.source)
                refuse('selected-runtime-source-declaration-unavailable');
              identity(state);
              state.phase = 'source';
              try {
                const result = await read(state.deadline);
                identity(state);
                state.phase = 'read';
                return result;
              } catch (error) {
                state.phase = 'read';
                throw error;
              }
            },
            async apply(episode, apply) {
              if (state.phase !== 'read') refuse('selected-runtime-apply-phase-unavailable');
              const result = await transaction(state, state.locator!, 'apply', (tx) =>
                finishSelectedEpisode(tx, identity(state), episode, 'apply', apply),
              );
              state.phase = 'applied';
              return result;
            },
            async failure(episode, fail) {
              if (!['selected', 'read'].includes(state.phase)) refuse('selected-runtime-failure-phase-unavailable');
              const result = await transaction(state, state.locator!, 'failure', (tx) =>
                finishSelectedEpisode(tx, identity(state), episode, 'failure', fail),
              );
              state.phase = 'failed';
              return result;
            },
          });
          const result = await body(invocation, locator);
          if (!['applied', 'failed'].includes(state.phase)) refuse('selected-runtime-incomplete-invocation');
          return result;
        },
        { name: 'library.membersPreparation.step' },
        lifecycle,
      );
    },
  });
}

/** Work-owned adapter installed on each native WorkClient by the Kernel composition roots. */
export const workExecutionPort: WorkExecutionPort = Object.freeze({
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
});
