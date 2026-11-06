import canonicalize from 'canonicalize';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  SelectedEpisode,
  WorkApplicationPorts,
  WorkIntent,
  WorkPool,
  WorkQueryClient,
  WorkSdkClient,
  WorkSelectedChildren,
  WorkSelectedIdentity,
  WorkSelectedInvocation,
  WorkSelectedLocator,
  WorkSelectedOutcome,
  WorkSelectedRuntime,
} from '../contract/index.ts';
import { SELECTED_CONTINUATION_PAYLOAD_MAX_BYTES, SELECTED_ISSUE_DEADLINE_MS } from '../contract/index.ts';
import { assertSelectedNativeDeclarations, isSelectedCost, selectedContinuationInput } from '../core/index.ts';

export class SelectedRuntimeUnavailable extends Error {
  constructor(readonly gap: string) {
    super(gap);
    this.name = 'SelectedRuntimeUnavailable';
  }
}

function refuse(gap: string): never {
  throw new SelectedRuntimeUnavailable(gap);
}

type Original = {
  pool: WorkPool;
  client: WorkSdkClient;
  deadline: number;
  children: WorkSelectedChildren | undefined;
  counts: Map<string, number>;
  claim?: object;
  identity?: WorkSelectedIdentity;
  revoked: boolean;
  phase: 'new' | 'selecting' | 'selected' | 'source' | 'read' | 'applied' | 'failed';
  busy: boolean;
  operations: Set<Promise<unknown>>;
  nativeLifecycle: 'open' | 'issued' | 'closing' | 'closed' | 'released';
  closeDrain?: Promise<void>;
  localQuery?: string | undefined;
  continuation?: string;
  locator?: WorkSelectedLocator;
  attempted: Set<string>;
};

type Phase = { original: Original; locator: WorkSelectedLocator; kind: 'select' | 'apply' | 'failure'; used: boolean };

export function createSelectedRuntime(ports: WorkApplicationPorts) {
  const active = new AsyncLocalStorage<Original>();
  const phases = new WeakMap<object, Phase>();
  const transactionSelections = new WeakMap<WorkQueryClient, Original>();

  function live(state: Original): void {
    if (state.revoked || ports.now() >= state.deadline) refuse('selected-runtime-not-live');
  }

  function identity(state: Original): WorkSelectedIdentity {
    if (!state.claim || state.revoked || ports.now() >= state.deadline) refuse('selected-runtime-not-live');
    const observed = ports.sdkSelected.selectedExecutionIdentity(state.claim, state.pool, state.client);
    return state.identity ?? observed;
  }

  function scope(state: Original, locator: WorkSelectedLocator): void {
    if (
      ports.route.routeOf(locator.ownerAccountId) !== locator.route ||
      ports.route.routeOf(locator.collectionId) !== locator.route ||
      ports.route.routeOf(locator.episodeId) !== locator.route
    )
      throw new TypeError('Invalid selected episode locator');
    if (state.locator && canonicalize(state.locator) !== canonicalize(locator))
      refuse('selected-runtime-episode-changed');
    state.locator ??= Object.freeze({ ...locator });
  }

  function selectedOperationalEnqueue(tx: WorkQueryClient, intent: WorkIntent): ((created: boolean) => void) | undefined {
    const state = transactionSelections.get(tx);
    if (!state) return;
    identity(state);
    const locator = state.locator!;
    if (
      state.counts.has('sdk-enqueue') ||
      intent.workflowName !== 'library.membersPreparation' ||
      intent.queue !== 'workflows' ||
      intent.arguments ||
      Buffer.byteLength(JSON.stringify(intent.input)) > SELECTED_CONTINUATION_PAYLOAD_MAX_BYTES ||
      JSON.stringify(intent.input) !== selectedContinuationInput(locator)
    )
      refuse('selected-runtime-continuation-enqueue-refused');
    state.counts.set('sdk-enqueue', 1);
    return (created) => {
      identity(state);
      if (!created) refuse('selected-runtime-continuation-not-new');
      state.continuation = intent.workflowId;
    };
  }

  function assertSelectedOperationalTransaction(tx: WorkQueryClient, expected: WorkSelectedIdentity): void {
    const state = transactionSelections.get(tx);
    if (!state || state.identity !== expected) refuse('selected-runtime-forged-association');
    identity(state);
    ports.operational.currentResources(tx);
  }

  function selectedLocalQuery(tx: WorkQueryClient, expected: WorkSelectedIdentity, sql: string, values?: unknown[]) {
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

  function assertSelectedContinuation(tx: WorkQueryClient, expected: WorkSelectedIdentity, workflow: string): void {
    assertSelectedOperationalTransaction(tx, expected);
    if (transactionSelections.get(tx)!.continuation !== workflow)
      refuse('selected-runtime-continuation-not-enqueued-here');
  }

  function phaseToken(state: Original, locator: WorkSelectedLocator, kind: Phase['kind']): object {
    identity(state);
    scope(state, locator);
    if (state.busy || state.attempted.has(kind)) refuse('selected-runtime-repeated-phase');
    state.attempted.add(kind);
    const token = Object.freeze({});
    phases.set(token, { original: state, locator, kind, used: false });
    return token;
  }

  function openSelectedOperationalPhase(
    pool: WorkPool,
    options: {
      selectedRuntime?: object;
      workClient: WorkSdkClient;
      mode: string;
      operationalHistory?: unknown;
      partition: number;
      kind: string;
      accounts: readonly string[];
      deadline?: number;
    },
  ) {
    const binding = options.selectedRuntime && phases.get(options.selectedRuntime);
    if (!binding || binding.used) refuse('selected-runtime-forged-phase');
    const { original: state, locator, kind } = binding;
    identity(state);
    if (
      pool !== state.pool ||
      options.workClient !== state.client ||
      options.mode !== 'work-step' ||
      options.operationalHistory ||
      options.partition !== ports.route.partitionOf(locator.route) ||
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
    let held: WorkQueryClient | undefined;
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
      async hold(tx: WorkQueryClient, raw: WorkQueryClient) {
        held = tx;
        transactionSelections.set(tx, state);
        const current = ports.operational.currentResources(tx);
        if (current.pool !== state.pool || current.workClient !== state.client || current.deadline !== state.deadline)
          refuse('selected-runtime-foreign-client');
        await ports.sdkSelected.checkSelectedExecutionInTransaction(raw, state.pool, state.claim!, state.client);
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
    locator: WorkSelectedLocator,
    kind: Phase['kind'],
    body: (tx: WorkQueryClient) => Promise<T>,
  ): Promise<T> {
    const selectedRuntime = phaseToken(state, locator, kind);
    const operation = ports.operational.runTransaction(
      state.pool,
      {
        mode: 'work-step',
        partition: ports.route.partitionOf(locator.route),
        kind: `library.membersPreparation.${kind === 'select' ? 'step' : kind}`,
        accounts: [locator.ownerAccountId],
        workClient: state.client,
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

  function composeSelectedRuntime(pool: WorkPool, client: WorkSdkClient): WorkSelectedRuntime {
    ports.sdkEnqueue.assertClient?.(client, pool);
    if (
      typeof ports.sdkSelected.registerSelectedStep !== 'function' ||
      typeof ports.sdkSelected.getSelectedExecution !== 'function' ||
      !ports.sdkSelected.isSelectedClient(client)
    )
      refuse('selected-runtime-sdk-extension-unavailable');
    return Object.freeze({
      registerMembersStep<R>(
        body: (invocation: WorkSelectedInvocation, locator: WorkSelectedLocator) => Promise<R>,
        children?: WorkSelectedChildren,
      ) {
        const declarations = children && structuredClone(children);
        if (declarations) assertSelectedNativeDeclarations(declarations.native);
        if (
          declarations &&
          (declarations.native.some((item) => !isSelectedCost(item.cost)) ||
            (declarations.source && !isSelectedCost(declarations.source)))
        )
          throw new TypeError('Invalid selected native declaration');
        const lifecycle = {
          async open() {
            const state: Original = {
              pool,
              client,
              deadline: ports.now() + SELECTED_ISSUE_DEADLINE_MS,
              children: declarations,
              counts: new Map(),
              nativeLifecycle: 'open',
              revoked: false,
              phase: 'new',
              busy: false,
              operations: new Set(),
              attempted: new Set(),
            };
            return {
              deadline: state.deadline,
              run<T>(run: () => Promise<T>) {
                return active.run(state, run);
              },
              async reserve(dispatch: 'issue' | 'release') {
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
        return ports.sdkSelected.registerSelectedStep(
          async (locator: WorkSelectedLocator) => {
            const state = active.getStore();
            const claim = ports.sdkSelected.getSelectedExecution();
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
            const invocation: WorkSelectedInvocation = Object.freeze({
              deadline: state.deadline,
              async select(input) {
                if (state.phase !== 'new') refuse('selected-runtime-repeated-selection');
                scope(state, input);
                identity(state);
                state.phase = 'selecting';
                const fresh = await trackOperation(
                  state,
                  ports.sdkSelected.consumeSelectedExecutionAdmission(claim, state.pool, state.client),
                );
                const episode = await transaction(state, input, 'select', (tx) =>
                  ports.selectedAssociation.associateEpisode(tx, identity(state), input, fresh),
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
              async apply(episode: SelectedEpisode, apply: (tx: WorkQueryClient) => Promise<WorkSelectedOutcome>) {
                if (state.phase !== 'read') refuse('selected-runtime-apply-phase-unavailable');
                const result = await transaction(state, state.locator!, 'apply', (tx) =>
                  ports.selectedAssociation.finishEpisode(tx, identity(state), episode, 'apply', apply),
                );
                state.phase = 'applied';
                return result;
              },
              async failure(episode: SelectedEpisode, fail: (tx: WorkQueryClient) => Promise<WorkSelectedOutcome>) {
                if (!['selected', 'read'].includes(state.phase)) refuse('selected-runtime-failure-phase-unavailable');
                const result = await transaction(state, state.locator!, 'failure', (tx) =>
                  ports.selectedAssociation.finishEpisode(tx, identity(state), episode, 'failure', fail),
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

  return Object.assign(composeSelectedRuntime, {
    selectedOperationalEnqueue,
    assertSelectedOperationalTransaction,
    selectedLocalQuery,
    assertSelectedContinuation,
    openSelectedOperationalPhase,
  });
}
