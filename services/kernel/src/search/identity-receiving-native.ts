import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { currentCommandResources, runCommand } from '../command/command.ts';
import { createIdentitySourceSupportReader } from '../semantic/identity-source-support.ts';
import { serializeIdentityValue } from '../semantic/identity-epoch-store.ts';
import {
  PublicFilterSourceDefinitionError,
  readPublicFilterSourceDefinition,
} from '../semantic/public-filter-source-binding.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
import { readIdentitySourceProjection } from '../semantic/search-source.ts';
import { searchIdentityWriterChanged } from './identity-epoch-participant-events.ts';
import type { OpenSearch } from './opensearch.ts';
import type {
  SearchIdentityReceivingContext,
  SearchIdentityReceivingLocator,
  SearchIdentityReceivingNative,
  SearchIdentityReceivingResult,
} from './identity-receiving-native-contract.ts';
import { snapshotSearchIdentityReceivingFrontier } from './identity-receiving-native-contract.ts';
import {
  createSearchIdentityReceivingNativeStore,
  type SearchNativeReceivingReleaseObservation,
} from './identity-receiving-native-store.ts';
import type { SearchNativeReceivingPlan, SearchNativeReceivingStored } from './identity-receiving-native-internal.ts';
import { SearchNativeReceivingError, SearchNativeReceivingWork } from './identity-receiving-native-work.ts';

/** Derive the installed Source dependencies rather than maintaining a second configuration contract. */
export type SearchReceivingConfiguration = Parameters<typeof createIdentitySourceSupportReader>[0] &
  Readonly<{
    search: OpenSearch;
    consumer: string;
    index: string;
  }>;
type Invocation = {
  active: boolean;
  observations: Map<string, SearchNativeReceivingReleaseObservation>;
  reconciliations: Map<string, object>;
  releasing: Map<string, Set<SearchNativeReceivingReleaseObservation>>;
};
const invocations = new WeakMap<
  SearchIdentityReceivingNative,
  Readonly<{
    storage: AsyncLocalStorage<Invocation>;
    revoke: (observation: SearchNativeReceivingReleaseObservation) => void;
  }>
>();
const key = (locator: SearchIdentityReceivingLocator) => `${locator.partition}:${locator.planId}`;
const hash = (value: unknown) => createHash('sha256').update(serializeIdentityValue(value)).digest('hex');
const nativeDefinitionByteLimit = 20_480;
type Cursor = Readonly<{
  version: 1;
  identity: string;
  copy: number;
  terminal: boolean;
  support?: string;
}>;
function cursor(value: string | null): Cursor | null {
  if (value === null) return null;
  try {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) throw new TypeError('Invalid cursor');
    const c: Cursor = JSON.parse(value);
    const base = { version: 1, identity: c?.identity, copy: c?.copy, terminal: c?.terminal };
    const canonical =
      c &&
      (c.support === undefined || (typeof c.support === 'string' && Buffer.byteLength(c.support, 'utf8') <= 3500)) &&
      JSON.stringify({
        ...base,
        ...(c.support === undefined ? {} : { support: c.support }),
      }) === value;
    if (
      c &&
      c.version === 1 &&
      typeof c.identity === 'string' &&
      /^[a-f0-9]{64}$/.test(c.identity) &&
      Number.isSafeInteger(c.copy) &&
      c.copy >= -1 &&
      c.copy < 2147483647 &&
      typeof c.terminal === 'boolean' &&
      canonical
    )
      return c;
  } catch {
    /* Invalid scheduling state is a refusal, never release authority. */
  }
  throw new SearchNativeReceivingError('changed', 'Invalid original receiving continuation', {
    rows: 0,
    points: 0,
    statements: 0,
    bytes: 0,
    engineRequests: 0,
  });
}

/** Common composition owns the lifetime. Only a genuine factory instance has an invocation store.
 * Neither the caller nor a persisted continuation can provide the private release observation.
 */
export async function withSearchIdentityReceivingNativeInvocation<T>(
  native: SearchIdentityReceivingNative,
  body: () => Promise<T>,
): Promise<T> {
  const registered = invocations.get(native);
  const storage = registered?.storage;
  if (!registered || !storage || storage.getStore()) throw new TypeError('Invalid native receiving invocation');
  const invocation: Invocation = {
    active: true,
    observations: new Map(),
    reconciliations: new Map(),
    releasing: new Map(),
  };
  return storage.run(invocation, async () => {
    try {
      return await body();
    } finally {
      invocation.active = false;
      for (const observation of invocation.observations.values()) registered.revoke(observation);
      for (const observations of invocation.releasing.values())
        for (const observation of observations) registered.revoke(observation);
      invocation.observations.clear();
      invocation.reconciliations.clear();
      invocation.releasing.clear();
    }
  });
}

/** Six-method adapter over genuine native storage and installed Source readers. It never takes an
 * operation ID, closure boolean, caller receipt or alternate Pool as release/application authority.
 */
export function createSearchIdentityReceivingNative(
  configuration: SearchReceivingConfiguration,
): SearchIdentityReceivingNative {
  const config = Object.freeze({ ...configuration, routeKey: new Uint8Array(configuration.routeKey) });
  const sourceSupport = createIdentitySourceSupportReader(config);
  if (!config.search || typeof config.search.request !== 'function') throw new TypeError('Search is not configured');
  const store = createSearchIdentityReceivingNativeStore(config);
  const source = publicFilterSource(config);
  const storage = new AsyncLocalStorage<Invocation>();

  async function perform<T>(
    context: SearchIdentityReceivingContext,
    body: (
      work: SearchNativeReceivingWork,
      call: <V>(
        run: (context: SearchIdentityReceivingContext) => Promise<SearchNativeReceivingStored<V>>,
      ) => Promise<V>,
    ) => Promise<T>,
  ): Promise<SearchIdentityReceivingResult<T>> {
    const work = new SearchNativeReceivingWork(context);
    const call = async <V>(
      run: (context: SearchIdentityReceivingContext) => Promise<SearchNativeReceivingStored<V>>,
    ) => {
      const used = work.snapshot();
      const allowance = Object.fromEntries(
        Object.entries(work.context.allowance).map(([axis, bound]) => [axis, bound - used[axis as keyof typeof used]]),
      ) as typeof used;
      let result: SearchNativeReceivingStored<V>;
      try {
        result = await run({ deadline: work.context.deadline, allowance });
      } catch (error) {
        if (error instanceof SearchNativeReceivingError) work.settle(error.work);
        throw error;
      }
      work.settle(result.work);
      return result.value;
    };
    try {
      return { status: 'ready', value: await body(work, call), work: work.snapshot() };
    } catch (error) {
      if (error instanceof SearchNativeReceivingError) return { status: error.status, work: work.snapshot() };
      throw new SearchNativeReceivingError('unavailable', 'Native receiving owner failed', work.snapshot(), {
        cause: error,
      });
    }
  }
  async function definition(id: string, releaseDigest: string, work: SearchNativeReceivingWork) {
    // The retained capture and keys are capped in SQL and charged at their maximum before loading.
    work.reserve({ rows: 3, points: 3, statements: 1, bytes: nativeDefinitionByteLimit + 4096, engineRequests: 0 });
    let loaded: Awaited<ReturnType<typeof readPublicFilterSourceDefinition>>;
    try {
      requireAccessDeadline(work.context.deadline);
      loaded = await withRequestDeadline(work.context.deadline, () =>
        readPublicFilterSourceDefinition(
          id,
          config.pool,
          createHash('sha256').update(config.routeKey).digest('hex'),
          nativeDefinitionByteLimit,
        ),
      );
      requireAccessDeadline(work.context.deadline);
    } catch (error) {
      if (error instanceof PublicFilterSourceDefinitionError) {
        const status = ['definition_missing', 'configuration_changed', 'binding_mismatch', 'source_missing'].includes(
          error.reason,
        )
          ? 'changed'
          : 'unavailable';
        work.fail(status, 'Original Source definition is missing or changed');
      }
      throw error;
    }
    if (loaded.definition.meaning.digest !== releaseDigest) work.fail('changed', 'Original Source release changed');
    // Release loading and Source reads are additionally charged by the enclosing exact SQL inventory.
    return loaded.definition;
  }
  async function requireCompleteOriginalSource(
    plan: SearchNativeReceivingPlan,
    work: SearchNativeReceivingWork,
    supportFrontier: string | null,
  ): Promise<string | null> {
    const own = await definition(plan.references.definition, plan.references.release, work);
    const directory = await sourceSupport.readPage({
      job: plan.selection.job,
      definition: own,
      frontier: supportFrontier,
      inputLimit: 1000,
      context: { deadline: work.context.deadline },
    });
    if (directory.status !== 'progress' && directory.status !== 'complete')
      work.fail(
        directory.status === 'changed' ? 'changed' : 'unavailable',
        'Complete Source original directory is unavailable',
      );
    const selectedRecords = directory.records.filter((record) => record.original === plan.source.original);
    if (selectedRecords.some((record) => record.terminal !== plan.source.terminal))
      work.fail('changed', 'Complete Source directory changed the selected origin mapping');
    if (directory.status === 'progress') {
      if (Buffer.byteLength(directory.frontier, 'utf8') > 3500)
        work.fail('unavailable', 'Complete Source directory frontier exceeds its bound');
      return directory.frontier;
    }
    for (const [original, frontier] of [
      [plan.source.original, plan.references.originalSupport],
      [plan.source.terminal, plan.references.terminalSupport],
    ] as const) {
      const projection = await readIdentitySourceProjection(config, source, {
        job: plan.selection.job,
        original,
        terminal: plan.source.terminal,
        meaning: own.meaning,
        frontier,
        inputLimit: 1,
        context: { deadline: work.context.deadline },
      });
      if (projection.status !== 'projected')
        work.fail(
          projection.status === 'changed' ? 'changed' : 'unavailable',
          'Complete Source original-support closure is unavailable',
        );
      if (projection.projection?.status === 'progress')
        work.fail('draining', 'Complete Source original-support closure is incomplete');
      if (frontier && projection.projection && !isDeepStrictEqual(projection.projection.frontier, frontier))
        work.fail('changed', 'Complete Source original-support frontier changed');
    }
    return null;
  }
  const native = Object.freeze<SearchIdentityReceivingNative>({
    resolvePlanned(selection, context) {
      return perform(context, async (work: SearchNativeReceivingWork, call) => {
        const plan = await call((c) => store.readPlan(selection.native, c));
        if (!isDeepStrictEqual(plan.selection, selection)) work.fail('changed', 'Exact native selection changed');
        await call((c) => store.observeOriginalFence(plan, c));
        const own = await definition(plan.references.definition, plan.references.release, work);
        for (const [original, frontier] of [
          [plan.source.original, plan.references.originalSupport],
          [plan.source.terminal, plan.references.terminalSupport],
        ] as const) {
          const projection = await readIdentitySourceProjection(config, source, {
            job: selection.job,
            original,
            terminal: plan.source.terminal,
            meaning: own.meaning,
            frontier,
            inputLimit: 1,
            context: { deadline: work.context.deadline },
          });
          if (projection.status !== 'projected')
            work.fail(
              projection.status === 'changed' ? 'changed' : 'unavailable',
              'Original Source projection is unavailable',
            );
          if (projection.projection?.status === 'progress')
            work.fail('draining', 'Original Source projection is incomplete');
          if (frontier && projection.projection && !isDeepStrictEqual(projection.projection.frontier, frontier))
            work.fail('changed', 'Original Source projection frontier changed');
        }
        // Source reads run on released homes. Reestablish the actual receiving owner's immutable
        // component after those reads rather than returning a plan captured before relocation.
        const current = await call((c) => store.readPlan(selection.native, c));
        if (!isDeepStrictEqual(current, plan)) work.fail('changed', 'Native plan changed during Source resolution');
        return plan.source;
      });
    },
    readAndHold(tx, binding, context) {
      return perform(context, (_work, call) => call((c) => store.readAndHold(tx, binding.source.locator, c, binding)));
    },
    revalidateHold(tx, record, context) {
      return perform(context, (_work, call) =>
        call((c) => store.revalidateHold(tx, record.source.locator, record.nativeHold.holdId, c, record)),
      );
    },
    recordApplied(tx, record, frontier, context) {
      return perform(context, async (work: SearchNativeReceivingWork, call) => {
        const savedFrontier = snapshotSearchIdentityReceivingFrontier(frontier);
        if (!savedFrontier) work.fail('changed', 'Invalid Search receiving frontier');
        await call((c) =>
          store.recordApplied(tx, record.source.locator, record.nativeHold.holdId, null, savedFrontier, c, record),
        );
        return { holdId: record.nativeHold.holdId };
      });
    },
    reconcileOriginal(locator, after, context) {
      // A new reconciliation invalidates even an unused observation from an earlier call.
      const invocation = storage.getStore();
      const locatorKey = key(locator);
      const reconciliation = {};
      const superseded = invocation?.observations.get(locatorKey);
      if (superseded) store.revokeRelease(superseded);
      for (const observation of invocation?.releasing.get(locatorKey) ?? []) store.revokeRelease(observation);
      invocation?.observations.delete(locatorKey);
      invocation?.reconciliations.set(locatorKey, reconciliation);
      return perform(context, async (work: SearchNativeReceivingWork, call) => {
        const retained = cursor(after);
        const state = await call((c) => store.readOriginalState(locator, c));
        const identity = hash({
          plan: state.plan,
          holdId: state.holdId,
          accepted: state.accepted,
          applied: state.operation.applied,
          frontier: state.operation.frontier,
        });
        if (retained && retained.identity !== identity)
          work.fail('changed', 'Original reconciliation identity changed');
        await call((c) => store.observeOriginalFence(state.plan, c));
        if (retained?.terminal) {
          if (state.pending) work.fail('draining', 'Original copies prevent terminal revalidation');
          const support = await requireCompleteOriginalSource(state.plan, work, retained?.support ?? null);
          if (support !== null)
            return {
              after: JSON.stringify({
                version: 1,
                identity,
                copy: retained.copy,
                terminal: false,
                support,
              } satisfies Cursor),
              state: 'progress' as const,
            };
          const current = await call((c) => store.readOriginalState(locator, c));
          if (
            hash({
              plan: current.plan,
              holdId: current.holdId,
              accepted: current.accepted,
              applied: current.operation.applied,
              frontier: current.operation.frontier,
            }) !== identity
          )
            work.fail('changed', 'Original custody changed during Source closure');
          if (current.pending) work.fail('draining', 'Original copies prevent terminal revalidation');
          await call((c) => store.observeOriginalFence(current.plan, c));
          if (!invocation?.active) work.fail('unavailable', 'Terminal release requires its active common invocation');
          const observation = await call((c) => store.observeRelease(locator, c));
          if (!invocation.active || invocation.reconciliations.get(locatorKey) !== reconciliation)
            work.fail('changed', 'Terminal reconciliation was superseded');
          invocation.observations.set(locatorKey, observation);
          return { after, state: 'settled' as const };
        }
        const page = await call((c) => store.readOriginalCopies(locator, retained?.copy ?? -1, 1, c));
        let last = retained?.copy ?? -1;
        for (const item of page) {
          const observation = await call((c) => store.observeOriginalCopy(locator, item.copyNo, c));
          // The actual executor's SQL is separately instrumented in the original eight-axis frame.
          work.reserve({ rows: 3, points: 3, statements: 14, bytes: 1024, engineRequests: 0 });
          await runCommand(
            config.pool,
            { partition: locator.partition, deadline: work.context.deadline, clock: config.clock },
            async (tx) => {
              await call((c) => store.reconcileOriginal(tx, locator, [observation], c));
              return { value: null, events: searchIdentityWriterChanged() };
            },
          );
          last = item.copyNo;
        }
        const current = await call((c) => store.readOriginalState(locator, c));
        if (
          hash({
            plan: current.plan,
            holdId: current.holdId,
            accepted: current.accepted,
            applied: current.operation.applied,
            frontier: current.operation.frontier,
          }) !== identity
        )
          work.fail('changed', 'Original custody changed during reconciliation');
        if (!page.length && current.pending)
          work.fail('draining', 'Original copy continuation has unresolved obligations');
        // Commit every advancing copy page before attempting terminal Source closure. A missing
        // closure operand must not discard the last durable copy continuation and repeat its work.
        const terminal = page.length === 0 && !current.pending;
        if (terminal) {
          const support = await requireCompleteOriginalSource(current.plan, work, retained?.support ?? null);
          if (support !== null)
            return {
              after: JSON.stringify({
                version: 1,
                identity,
                copy: last,
                terminal: false,
                support,
              } satisfies Cursor),
              state: 'progress' as const,
            };
          const closed = await call((c) => store.readOriginalState(locator, c));
          if (
            hash({
              plan: closed.plan,
              holdId: closed.holdId,
              accepted: closed.accepted,
              applied: closed.operation.applied,
              frontier: closed.operation.frontier,
            }) !== identity
          )
            work.fail('changed', 'Original custody changed during Source closure');
          if (closed.pending) work.fail('draining', 'Original copies prevent terminal Source closure');
          await call((c) => store.observeOriginalFence(closed.plan, c));
        }
        return {
          after: JSON.stringify({ version: 1, identity, copy: last, terminal } satisfies Cursor),
          state: terminal ? ('settled' as const) : ('progress' as const),
        };
      });
    },
    releaseHold(tx, record, context) {
      // Consume before any validation, including invalid Pool, exhausted frame and thrown SQL.
      const invocation = storage.getStore();
      const locatorKey = key(record.source.locator);
      const observation = invocation?.observations.get(locatorKey);
      invocation?.observations.delete(locatorKey);
      invocation?.reconciliations.delete(locatorKey);
      if (observation && invocation) {
        let releasing = invocation.releasing.get(locatorKey);
        if (!releasing) invocation.releasing.set(locatorKey, (releasing = new Set()));
        releasing.add(observation);
      }
      return perform(context, async (work: SearchNativeReceivingWork, call) => {
        if (!invocation?.active || !observation || currentCommandResources(tx).pool !== config.pool)
          work.fail('changed', 'Fresh invocation-bound release observation required');
        await call((c) =>
          store.releaseHold(tx, record.source.locator, record.nativeHold.holdId, observation, c, record),
        );
        return { holdId: record.nativeHold.holdId };
      });
    },
  });
  invocations.set(native, { storage, revoke: store.revokeRelease });
  return native;
}
