import { DBOS } from '@dbos-inc/dbos-sdk';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { authoritativeTimeValue, commandTime } from '../command/command.ts';
import { enqueueIntent, runOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { partitionOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { workStepDeadline } from './command-support.ts';
import { preparationObservation, readPreparationStep, validPreparationLocator, type PreparationDefinition, type PreparationIntent,
  type PreparationLocator, type PreparationStepState } from './members-preparation.ts';
import type { CollectionSourceObservation, WorkReceipt } from './collection-source.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { SearchScopeOrder } from '../search/service-scope-order.ts';
import { createSearchScopeSource } from '../search/scope-source.ts';
import type { MembersPreparationWorkContext } from '../search/scope-work-context.ts';
import ownerLock from './members-preparation-owner-lock.sql';
import cleanup from './members-preparation-cleanup.sql';
import idle from './members-preparation-idle.sql';
import drainHeader from './members-preparation-drain.sql';
import drainResults from './members-preparation-results-drain.sql';
import reset from './members-preparation-reset.sql';
import repair from './members-preparation-repair.sql';
import failure from './members-preparation-failure.sql';
import apply from './members-preparation-apply.sql';
import selected from './members-preparation-selected.sql';
import step from './members-preparation-step.sql';
import original from './members-preparation-original.sql';
import sourceMetadata from './members-preparation-source.sql';
import ownerFence from './owner-filter-native-binding-fence.sql';
import { collectionPublicationScopeRuntime } from '../search/work.ts';
import { scopeAllowance } from '../search/scope-execution.ts';
import { MEMBERS_PREPARATION_STEP_CEILING, MEMBERS_PREPARATION_LOCAL_COST } from './members-preparation-cost.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import { readMembershipRouteKey } from '../access/membership-work-config.ts';
import { createMembersPreparation, readPreparationScope, readPreparationSource, readPreparationOwnerFence, checkMembersPreparationCompletion } from './members-preparation.ts';
import { isDeepStrictEqual } from 'node:util';
import { routeOf } from '../route/route.ts';
import { SelectedRuntimeUnavailable, type SelectedInvocation, type SelectedChildren } from '../work/selected-runtime.ts';
import type { SelectedOutcome } from '../history/operational-work-selected.ts';
import type { WorkDimensions } from './collection-source.ts';

type Dependencies = Pick<WorkContext, 'pool' | 'client' | 'clock'> & {
  runtime?: () => ReturnType<typeof collectionPublicationScopeRuntime>;
  authorization?: () => Pick<ReturnType<WorkContext['getAuthorization']>, 'access'>;
  routeKey?: Buffer;
};
type Input = PreparationIntent['input'];
type OrderedSource = ReturnType<typeof createSearchScopeSource>;
type OrderedRequest = Parameters<OrderedSource['sourcePrefix']>[1] | Parameters<OrderedSource['ordinalPrefix']>[1];

const nativeCost = (cost: Readonly<WorkDimensions>) => ({ ...cost, engineRequests: 0 });
/** Literal invocation-wide owned dispatch multiplicities. Native SQL performs no engine requests.
 * Source deliberately has no declaration: an inner allowance/receipt is not a complete child quote.
 * The runtime refuses that reached branch before dispatch, while permitting a real native failure result.
 */
export const MEMBERS_SELECTED_CHILDREN: SelectedChildren = {
  native: [
    { sql: step.sql, limit: 4, cost: nativeCost(MEMBERS_PREPARATION_LOCAL_COST.step) },
    { sql: sourceMetadata.sql, limit: 1, cost: nativeCost(MEMBERS_PREPARATION_LOCAL_COST.sourceMetadata) },
    { sql: ownerFence.sql, limit: 1, cost: nativeCost(MEMBERS_PREPARATION_LOCAL_COST.ownerFence) },
    { sql: original.sql, limit: 1, cost: nativeCost(MEMBERS_PREPARATION_LOCAL_COST.originalRead) },
    { sql: selected.sql, limit: 2, cost: nativeCost(MEMBERS_PREPARATION_LOCAL_COST.selectedAssociation) },
    { sql: apply.sql, limit: 1, cost: nativeCost(MEMBERS_PREPARATION_LOCAL_COST.apply) },
    { sql: drainResults.sql, limit: 1, cost: nativeCost(MEMBERS_PREPARATION_LOCAL_COST.resultDrain) },
    { sql: reset.sql, limit: 1, cost: nativeCost(MEMBERS_PREPARATION_LOCAL_COST.reset) },
    { sql: repair.sql, limit: 1, cost: nativeCost(MEMBERS_PREPARATION_LOCAL_COST.repair) },
    { sql: failure.sql, limit: 1, cost: nativeCost(MEMBERS_PREPARATION_LOCAL_COST.failure) },
  ],
};

const REPAIR_CHECKPOINT = '{"repair":true}';

function locators(input: Input): { episodes: PreparationLocator[]; cleanup: PreparationLocator[] } {
  if (!input || Object.keys(input).sort().join(',') !== 'accounts,cleanup,episodes,route' ||
      !Array.isArray(input.accounts) || input.accounts.length !== 1 ||
      !Array.isArray(input.episodes) || !Array.isArray(input.cleanup) ||
      !Number.isInteger(input.route) || input.route < 0 || input.route > 65535 ||
      input.episodes.length > 16 || input.cleanup.length > 32 ||
      Buffer.byteLength(JSON.stringify(input)) > 4096) throw new TypeError('Invalid members preparation intent');
  const convert = (entries: Input['episodes']) => entries.map((entry) => {
    if (!entry || Object.keys(entry).sort().join(',') !== 'collectionId,episodeId')
      throw new TypeError('Invalid members preparation locator');
    const locator = { ...entry, route: input.route, ownerAccountId: input.accounts[0] };
    if (!validPreparationLocator(locator)) throw new TypeError('Invalid members preparation locator');
    return locator;
  });
  const episodes = convert(input.episodes);
  const cleanup = convert(input.cleanup);
  for (const entries of [episodes, cleanup]) for (let index = 1; index < entries.length; index++) {
    const before = entries[index - 1]!, current = entries[index]!;
    if (before.collectionId > current.collectionId ||
        (before.collectionId === current.collectionId && before.episodeId >= current.episodeId))
      throw new TypeError('Unordered members preparation locators');
  }
  const keys = [...episodes, ...cleanup].map((entry) => `${entry.collectionId}:${entry.episodeId}`);
  if (new Set(keys).size !== keys.length) throw new TypeError('Duplicate members preparation locator');
  return { episodes, cleanup };
}

/** Library's storage delta from the installed Search adapter.
 * The ordered producer alone can supply canonical, fully evaluated rows and scoped exhaustion.
 */
type PreparationAdvance = Readonly<{
  status: 'advanced';
  checkpoint: string;
  source: CollectionSourceObservation;
  scope: IdentityScopeObservation;
  ownerFence: string | null;
  subjects: readonly string[];
  exhausted: boolean;
  work: WorkReceipt;
}>;
type PreparationRunnerInput = Readonly<{
  work: MembersPreparationWorkContext;
  definition: PreparationDefinition;
  retained: PreparationStepState;
  order: SearchScopeOrder['kind'];
  deadline: number;
  allowance?: OrderedRequest['allowance'];
}>;

/** Owned integration boundary. Ordinary Actor/LeafOptions execution cannot replace native work admission.
 * The installed sourcePrefix/ordinalPrefix/evaluate adapter owns execution and its native receipts.
 * No foreign checkout or ordinary reader Actor substitutes for this same-client work context.
 */
async function advancePreparation(
  deps: Dependencies, input: PreparationRunnerInput,
): Promise<PreparationAdvance | Readonly<{ status: 'unavailable' }> | Readonly<{ status: 'restart' }>> {
  const runtime = deps.runtime?.();
  const authorization = deps.authorization?.();
  if (!runtime || !authorization || !deps.routeKey) return { status: 'unavailable' };
  const service = createMembersPreparation({ pool: deps.pool, workClient: deps.client,
    access: authorization.access, clock: deps.clock });
  const native = await service.readWorkDefinition(input.work.tx, input.work.locator);
  const scope = await readPreparationScope(input.work.tx, input.work.locator);
  if (!native || !scope) return { status: 'unavailable' };
  const ownerFence = await readPreparationOwnerFence(input.work.tx, input.work.locator, input.definition);
  const work = new NativeCollectionWork(input.allowance ?? scopeAllowance(100,
    `${input.work.locator.episodeId}:${input.retained.version}`, MEMBERS_PREPARATION_STEP_CEILING), input.deadline);
  const source = createSearchScopeSource({ ...runtime, evidence: {
    work: input.work, access: authorization.access, routeKey: deps.routeKey, deadline: input.deadline,
  } });
  const prepared = await work.compose(async allowance => {
    const value = await source.prepare(input.definition.filter, { allowance,
      releaseDigest: input.definition.release.digest, order: { kind: input.order, source: native.sourceIdentity } });
    return { value, work: source.work(value) };
  });
  // Use the installed Search adapter, including its complete native evidence and local receipts.
  // No raw exhaustion, receipt or reservation alone is promoted to successful completion.
  type IdRequest = Parameters<OrderedSource['sourcePrefix']>[1];
  type OrdinalRequest = Parameters<OrderedSource['ordinalPrefix']>[1];
  type Evaluation = Parameters<OrderedSource['evaluate']>[2];
  type Checkpoint = { id: IdRequest['afterSubjectId']; ordinal: OrdinalRequest['after']; progress: Evaluation['progress'] };
  const checkpoint: Checkpoint = input.retained.checkpoint ? JSON.parse(input.retained.checkpoint) :
    { id: null, ordinal: null, progress: null };
  let subjects: readonly string[], exhausted: boolean;
  let observation: CollectionSourceObservation;
  if (input.order === 'ordinal') {
    const page = await work.compose(allowance => source.ordinalPrefix(prepared.value,
      { after: checkpoint.ordinal, quota: 1, allowance }));
    checkpoint.ordinal = page.frontier.after;
    subjects = page.subjects.map(row => row.subject);
    exhausted = page.exhausted;
    observation = page.observation;
  } else {
    const page = await work.compose(allowance => source.sourcePrefix(prepared.value,
      { afterSubjectId: checkpoint.id, allowance: { ...allowance, remaining: {
        ...allowance.remaining, candidateKeys: Math.min(2, allowance.remaining.candidateKeys) } } }));
    const candidate = page.candidates[0];
    subjects = [];
    exhausted = page.exhausted && page.candidates.length === 0;
    observation = page.observation;
    if (candidate) {
      const evaluated = await work.compose(async allowance => {
        const remaining = allowance.remaining;
        const value = await source.evaluate(prepared.value, [candidate.subjectId], {
          allowance, progress: checkpoint.progress ?? null, rawKeys: remaining.candidateKeys,
          native: { rows: remaining.nativeRows, points: remaining.nativePoints,
            witnesses: remaining.witnessKeys, bytes: remaining.bytes, emptySeeks: remaining.emptySeeks },
        });
        return { value, work: source.work(value) };
      });
      checkpoint.progress = evaluated.value.progress;
      const match = evaluated.value.values[0];
      if (match !== true && match !== false && match !== 'not_proven') throw new TypeError('Missing preparation evaluation');
      if (match !== 'not_proven') {
        if (match) subjects = [candidate.subjectId];
        checkpoint.id = candidate.subjectId;
        checkpoint.progress = null;
        exhausted = page.exhausted && page.candidates.length === 1;
      }
    }
  }
  const final = await service.readWorkDefinition(input.work.tx, input.work.locator);
  const finalScope = await readPreparationScope(input.work.tx, input.work.locator);
  if (!isDeepStrictEqual(native, final) || !isDeepStrictEqual(scope, finalScope) ||
      !isDeepStrictEqual(observation, native.observation) ||
      ownerFence !== await readPreparationOwnerFence(input.work.tx, input.work.locator, input.definition)) return { status: 'restart' };
  return { status: 'advanced', checkpoint: JSON.stringify(checkpoint), subjects, exhausted,
    source: observation, scope, ownerFence, work: work.receipt() };
}

function exactKey(locator: PreparationLocator) {
  return { route: locator.route, owner_account_id: locator.ownerAccountId,
    collection_id: locator.collectionId, episode_id: locator.episodeId };
}
function nativeTime(tx: OperationalTransaction): string {
  const time = commandTime(tx);
  if (!time) throw new TypeError('Missing preparation native time');
  return authoritativeTimeValue(time);
}
async function continueEpisode(tx: OperationalTransaction, locator: PreparationLocator, suffix: string, cleaning = false) {
  const entry = { collectionId: locator.collectionId, episodeId: locator.episodeId };
  const workflowId = `library:members-preparation:${locator.route}:${locator.ownerAccountId}:${locator.episodeId}:${suffix}`;
  await enqueueIntent(tx, {
    queue: 'workflows', workflowName: 'library.membersPreparation',
    workflowId,
    input: { accounts: [locator.ownerAccountId], route: locator.route,
      episodes: cleaning ? [] : [entry], cleanup: cleaning ? [entry] : [] },
  });
  return workflowId;
}

/** Drain at most 100 children. Every partial repair has a new version and deterministic continuation. */
async function restartPreparation(tx: OperationalTransaction, locator: PreparationLocator, state: PreparationStepState): Promise<SelectedOutcome> {
  const key = exactKey(locator);
  const removed = await drainResults.run(tx, key);
  const cleared = await reset.run(tx, { ...key, version: state.version });
  const next = cleared ?? await repair.run(tx, { ...key, version: state.version });
  if (!next || (!cleared && !removed.length)) throw new Error('Preparation repair made no progress');
  const continuation = await continueEpisode(tx, locator, `step:${next.version}`);
  return { kind: 'continue', version: next.version, continuation };
}

type SourceAdvance = Readonly<{
  state: PreparationStepState;
  definition: PreparationDefinition | null;
  advance: Awaited<ReturnType<typeof advancePreparation>>;
}>;

/** A complete Source child must be installed/priced before SelectedInvocation.source dispatches this body.
 * The selected transaction is already released. Search receives a NEW genuine native Source transaction,
 * under the selected invocation's unchanged absolute deadline, never a closed transaction or request token.
 */
async function readReleasedPreparationSource(deps: Dependencies, locator: PreparationLocator, deadline: number): Promise<SourceAdvance> {
  return runOperationalTransaction(deps.pool, {
    mode: 'work-step', partition: partitionOf(locator.route), kind: 'library.membersPreparation.source',
    accounts: [locator.ownerAccountId], workClient: deps.client, clock: deps.clock, deadline,
  }, async tx => {
    const state = await readPreparationStep(tx, locator);
    if (!state) throw new ProblemError('dependency_unavailable', { detail: 'Members Source episode is obsolete' });
    if (state.checkpoint === REPAIR_CHECKPOINT || (state.preparedIncarnation !== null &&
        (state.preparedIncarnation !== state.incarnation || state.preparedGeneration !== state.generation)))
      return { state, definition: null, advance: { status: 'restart' } };
    const authorization = deps.authorization?.();
    if (!authorization) throw new ProblemError('dependency_unavailable');
    const service = createMembersPreparation({ pool: deps.pool, workClient: deps.client,
      access: authorization.access, clock: deps.clock });
    // Immutable release and exact expanded basis are re-read on the actual Source client.
    const native = await service.readWorkDefinition(tx, locator);
    if (!native) throw new ProblemError('dependency_unavailable', { detail: 'Members Source definition is unavailable' });
    const advance = await advancePreparation(deps, { work: { kind: 'members-preparation', tx, locator },
      definition: native.definition, retained: state, order: native.definition.sort, deadline });
    return { state, definition: native.definition, advance };
  });
}

/** These are authentic SDK coordinates used only as point locators. History's selected native association
 * and same-transaction held-owner checks independently establish authority; neither scalar is a capability.
 */
async function associateSelectedPreparation(tx: OperationalTransaction, locator: PreparationLocator) {
  const workflow = DBOS.workflowID, functionId = DBOS.stepID;
  if (workflow === undefined || functionId === undefined) throw new ProblemError('dependency_unavailable', {
    detail: 'Members selected execution coordinates are unavailable',
  });
  const associated = await selected.run(tx, { ...exactKey(locator), workflow_id: workflow, function_id: functionId });
  if (associated.length !== 1) throw new ProblemError('dependency_unavailable', {
    detail: 'Members native selected association differs from the current invocation',
  });
}

/** Conditional native apply uses fresh Source/Scope/order and owner evidence after the Source client releases. */
async function applyPreparationAdvance(tx: OperationalTransaction, locator: PreparationLocator, source: SourceAdvance): Promise<SelectedOutcome> {
  const state = await readPreparationStep(tx, locator);
  if (!state) return { kind: 'obsolete', version: source.state.version };
  if (!isDeepStrictEqual(state, source.state)) throw new ProblemError('dependency_unavailable', {
    detail: 'Members version or source generation changed during the released Source phase',
  });
  await associateSelectedPreparation(tx, locator);
  const result = source.advance;
  if (result.status === 'unavailable') throw new ProblemError('dependency_unavailable', {
    detail: 'Search scope source execution for members-preparation is unavailable',
  });
  if (result.status === 'restart') return restartPreparation(tx, locator, state);
  if (!source.definition) throw new Error('Missing immutable Members definition');
  const current = await readPreparationSource(tx, locator);
  if (!current || !isDeepStrictEqual(current.source, result.source) || !isDeepStrictEqual(current.scope, result.scope) ||
      result.ownerFence !== await readPreparationOwnerFence(tx, locator, source.definition))
    return restartPreparation(tx, locator, state);
  const observation = preparationObservation(result.source, result.scope, result.ownerFence);
  if (state.observation !== null && state.observation !== observation) return restartPreparation(tx, locator, state);
  let completionOperand: string | null = null;
  if (state.complete || result.exhausted) {
    const completion = await checkMembersPreparationCompletion(tx, locator);
    if (completion.status === 'obsolete') return { kind: 'obsolete', version: state.version };
    completionOperand = completion.operand;
    if (state.complete) throw new ProblemError('dependency_unavailable', { detail: completionOperand });
  }
  if (Buffer.byteLength(result.checkpoint) > 4096 || result.subjects.length > 100 ||
      result.subjects.some(id => routeOf(id) === null) || result.work.used.candidateKeys > 100 ||
      (!result.exhausted && result.subjects.length === 0 && result.checkpoint === state.checkpoint))
    throw new Error('Invalid ordered preparation advance');
  const [applied] = await apply.run(tx, { ...exactKey(locator), version: state.version, at: nativeTime(tx),
    incarnation: state.incarnation, source_generation: state.generation,
    checkpoint: result.checkpoint, observation, subjects: [...result.subjects],
    exhausted: result.exhausted, complete: false, failure: completionOperand ? 'dependency_unavailable' : null });
  if (!applied) throw new ProblemError('dependency_unavailable', { detail: 'Members native apply raced' });
  // Actual Source progress and the precise failed completion outcome commit atomically. No empty ready result.
  if (completionOperand) return { kind: 'failure', version: applied.version };
  const continuation = await continueEpisode(tx, locator, `step:${applied.version}`);
  return { kind: 'continue', version: applied.version, continuation };
}

/** One authentic selected invocation: committed replay is data, never a renewed admission. */
export async function runMembersPreparationStep(deps: Dependencies, invocation: SelectedInvocation,
  locator: PreparationLocator): Promise<SelectedOutcome> {
  if (!validPreparationLocator(locator)) throw new TypeError('Invalid members preparation locator');
  const episode = await invocation.select(locator);
  if (episode.result) return episode.result;
  try {
    const source = await invocation.source(deadline => readReleasedPreparationSource(deps, locator, deadline));
    return await invocation.apply(episode, tx => applyPreparationAdvance(tx, locator, source));
  } catch (error) {
    if (error instanceof LifecycleDeniedError) throw error;
    // This is the producer's separately held reached-failure phase on the SAME balance/deadline.
    // Unknown Source pricing refuses before dispatch and can still record an honest native failure.
    return invocation.failure(episode, async tx => {
      const state = await readPreparationStep(tx, locator);
      if (!state) throw error;
      await associateSelectedPreparation(tx, locator);
      await failure.run(tx, { ...exactKey(locator), version: state.version, at: nativeTime(tx),
        failure: error instanceof SelectedRuntimeUnavailable ||
          (error instanceof ProblemError && error.code === 'dependency_unavailable') ? 'dependency_unavailable' : 'failed' });
      return { kind: 'failure', version: state.version };
    });
  }
}

async function cleanupEpisode(deps: Dependencies, locator: PreparationLocator): Promise<void> {
  if (!validPreparationLocator(locator)) throw new TypeError('Invalid members preparation locator');
  try {
    await runOperationalTransaction(deps.pool, {
      mode: 'work-step', partition: partitionOf(locator.route), kind: 'library.membersPreparation.cleanup',
      accounts: [locator.ownerAccountId], workClient: deps.client, clock: deps.clock, deadline: workStepDeadline(),
    }, async (tx) => {
      const key = { route: locator.route, owner_account_id: locator.ownerAccountId };
      if (!(await ownerLock.run(tx, key))) return;
      const time = commandTime(tx);
      if (!time) throw new TypeError('Missing cleanup native time');
      const exact = { ...key, collection_id: locator.collectionId, episode_id: locator.episodeId };
      const [retired] = await cleanup.run(tx, { ...exact, at: authoritativeTimeValue(time) });
      if (!retired?.retired) return;
      const removed = await drainResults.run(tx, exact);
      const [drained] = await drainHeader.run(tx, exact);
      if (!drained) {
        if (!removed.length) throw new Error('Retired preparation cleanup made no progress');
        await continueEpisode(tx, locator, `cleanup:${removed.at(-1)!.subjectId}`, true);
      }
    });
  } catch (error) {
    // Terminal disposal belongs to the existing Library A5 participant, never an impersonated active step.
    if (!(error instanceof LifecycleDeniedError)) throw error;
  }
}

export async function registerMembersPreparationWork(context: WorkContext): Promise<void> {
  const deps: Dependencies = { pool: context.pool, client: context.client, clock: context.clock,
    runtime: () => collectionPublicationScopeRuntime(context), authorization: () => context.getAuthorization(),
    routeKey: readMembershipRouteKey(context.env) };
  const runtime = context.getSelectedRuntime?.();
  if (!runtime) throw new ProblemError('dependency_unavailable', { detail: 'Members selected runtime is unavailable' });
  const prepare = runtime.registerMembersStep((invocation, locator) => runMembersPreparationStep(deps, invocation, locator),
    MEMBERS_SELECTED_CHILDREN);
  const drain = DBOS.registerStep((locator: PreparationLocator) => cleanupEpisode(deps, locator),
    { name: 'library.membersPreparation.cleanup', ...COMMAND_STEP_RETRIES });
  DBOS.registerWorkflow(async (input: Input) => {
    const work = locators(input);
    for (const locator of work.cleanup) await drain(locator);
    const outcomes: SelectedOutcome[] = [];
    for (const locator of work.episodes) outcomes.push(await prepare(locator));
    // SDK workflow completion is not Members readiness. Preserve actual per-episode outcomes as data.
    return { episodes: outcomes };
  }, { name: 'library.membersPreparation' });

  type After = PreparationLocator & { lastReadAt: string };
  const sweepPage = DBOS.registerStep(async (partition: number, cutoff: string, after: After | null) =>
    withConnection(deps.pool, (connection) => idle.run(connection, {
      partition, cutoff, after_at: after?.lastReadAt ?? null, after_route: after?.route ?? null,
      after_owner: after?.ownerAccountId ?? null, after_collection: after?.collectionId ?? null,
      after_episode: after?.episodeId ?? null,
    })),
  { name: 'library.membersPreparation.idlePage', ...COMMAND_STEP_RETRIES });
  type Sweep = { root: string; segment: number; partition: number; cutoff: string; after: After | null };
  const resume = DBOS.registerStep(async (input: Sweep) => {
    await deps.client.enqueue({ workflowName: 'library.membersPreparation.idleSegment', queueName: 'maintenance',
      workflowID: `${input.root}:${input.segment}`, workflowIDReusePolicy: 'return-existing' }, input);
  }, { name: 'library.membersPreparation.idleContinue', ...COMMAND_STEP_RETRIES });
  const segment = async (input: Sweep) => {
    let { partition, after } = input;
    for (let pages = 0; pages < 8 && partition < 4096; pages++) {
      const page = await sweepPage(partition, input.cutoff, after);
      for (const locator of page) await drain(locator);
      after = page.at(-1) ?? null;
      if (page.length < 8) { partition++; after = null; }
    }
    if (partition < 4096) await resume({ ...input, partition, after, segment: input.segment + 1 });
  };
  DBOS.registerWorkflow(segment, { name: 'library.membersPreparation.idleSegment' });
  const captureCutoff = DBOS.registerStep(async () => deps.clock().toISOString(),
    { name: 'library.membersPreparation.idleCutoff' });
  DBOS.registerWorkflow(async () => segment({ root: DBOS.workflowID!, segment: 0, partition: 0, after: null, cutoff: await captureCutoff() }),
    { name: 'library.membersPreparation.idle' });
  await deps.client.applySchedules([{ scheduleName: 'library.membersPreparation.every-10-minutes',
    workflowName: 'library.membersPreparation.idle', schedule: '*/10 * * * *', cronTimezone: 'UTC',
    automaticBackfill: false, queueName: 'maintenance' }]);
}
