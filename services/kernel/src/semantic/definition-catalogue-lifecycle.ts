import {
  CATALOGUE_NATIVE_CONTROLS as nativeControl,
  catalogueLedgerCost,
  type CatalogueLedgerOperation,
} from './definition-catalogue-work-cost.ts';
import retirementOriginal from './definition-catalogue-retirement-original.sql';
import retirementProgress from './definition-catalogue-retirement-progress.sql';
import retirementProbe from './definition-catalogue-retirement-probe.sql';
import retirementPositions from './definition-catalogue-retirement-positions.sql';
import retirementTickets from './definition-catalogue-retirement-tickets.sql';
import retirementConsumers from './definition-catalogue-retirement-consumers.sql';
import retirementCaptures from './definition-catalogue-retirement-captures.sql';
import retirementRead from './definition-catalogue-retirement-read.sql';
import retirementStart from './definition-catalogue-retirement-start.sql';
import { assertKindCatalogueEnrollmentAdmission } from './definition-catalogue.ts';
import type { KindCatalogueNativeContext } from './definition-catalogue-types.ts';
import { assertCataloguePublisherFrame } from './definition-catalogue-publication-work.ts';
import { randomUUID } from 'node:crypto';
import type { KindCataloguePin } from '@rezics/definitions';
import type { CommandTransaction } from '../command/command.ts';
import { currentCommand, currentCommandResources } from '../command/command.ts';
import { hasLiveOperationalTransaction, currentOperationalResources } from '../command/operational.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import { GLOBAL_CONTEXT, StaleEditorialHeadError } from './definitions.ts';
import { CATALOGUE_BODY_COST as cost, catalogueBodyWork, catalogueSQLCost } from './definition-catalogue-work-cost.ts';
import registerRoot from './definition-catalogue-register-root.sql';
import headLock from './definition-catalogue-head-lock.sql';
import rootLock from './definition-catalogue-root-lock.sql';
import activationRead from './definition-catalogue-activation-read.sql';
import activationRequest from './definition-catalogue-activation-request.sql';
import activationClosing from './definition-catalogue-activation-closing.sql';
import closeRoot from './definition-catalogue-close.sql';
import activationCut from './definition-catalogue-activation-cut.sql';
import frontierPending from './definition-catalogue-frontier-pending.sql';
import frontierRead from './definition-catalogue-frontier-read.sql';
import frontierStage from './definition-catalogue-frontier-stage.sql';
import activationCAS from './definition-catalogue-activation-cas.sql';

type Activation = NonNullable<Awaited<ReturnType<typeof activationRead.run>>>;
export type CatalogueActivationProgress = Readonly<{
  activationId: string;
  state: 'ready' | 'closing' | 'invalidating' | 'active';
  pending: boolean;
}>;
const unavailable = (): never => {
  throw new AccessUnavailableError('overloaded');
};
function lifecycleBodyWork<T>(
  tx: CommandTransaction,
  work: NativeCollectionWork,
  cost: import('../library/collection-source.ts').WorkDimensions,
  operation: () => Promise<T>,
) {
  const resources = hasLiveOperationalTransaction(tx) ? currentOperationalResources(tx) : currentCommandResources(tx);
  return catalogueBodyWork(work, cost, operation, resources.deadline);
}

function admittedPublication(tx: CommandTransaction, action: string, transactionId: string) {
  const command = currentCommand(tx);
  const authorization = command.authorization;
  if (
    command.partition !== 0 ||
    command.transactionId !== transactionId ||
    !authorization ||
    authorization.action !== action ||
    authorization.mode !== 'execute' ||
    authorization.resource.route !== 0 ||
    authorization.resource.id !== GLOBAL_CONTEXT
  )
    return unavailable();
  if (Date.now() >= currentCommandResources(tx).deadline) return unavailable();
}

function assertFrame(
  tx: CommandTransaction,
  work: NativeCollectionWork,
  root: string,
  operation: Parameters<typeof assertCataloguePublisherFrame>[3],
) {
  // Kind work still requires Accounts' authentic original admission. Only the
  // separate private Semantic publisher receiving boundary is used here.
  if (hasLiveOperationalTransaction(tx)) return unavailable();
  assertCataloguePublisherFrame(tx, work, root, operation);
}

/** Fresh admitted publication may register an invisible post-migration build.
 * Historical roots already have protocol=0 and can never be upgraded by this operation.
 * Registration takes the head lock before checking invisibility or inserting the root.
 */
export async function registerCatalogueRoot(
  tx: CommandTransaction,
  root: string,
  transactionId: string,
  work: NativeCollectionWork,
) {
  await lifecycleBodyWork(tx, work, nativeControl.lifecycleIdentity, async () => undefined);
  admittedPublication(tx, 'definitions:publish', transactionId);
  assertFrame(tx, work, root, 'register');
  const head = await lifecycleBodyWork(tx, work, catalogueSQLCost(cost.headLock, headLock.sql, {}), () =>
    headLock.run(tx),
  );
  if (!head || head.root_digest === root) return unavailable();
  const params = { root, transaction_id: transactionId };
  const saved = await lifecycleBodyWork(tx, work, catalogueSQLCost(cost.registerRoot, registerRoot.sql, params), () =>
    registerRoot.run(tx, params),
  );
  if (!saved) return unavailable();
}

/** All head/root lock order is head then root, including enrollment. */
export async function lockCatalogueEnrollment(tx: CommandTransaction, root: string, work: NativeCollectionWork) {
  assertFrame(tx, work, root, 'lock');
  return lockEnrollmentRows(tx, root, work);
}

/** Kind authority is verified by the actual Kind receiving boundary, independently
 * of publisher authority. A structural context, publisher grant or ALS presence
 * cannot satisfy it. Missing Accounts admission refuses before either row lock. */
export async function lockKindCatalogueEnrollment(context: KindCatalogueNativeContext, root: string) {
  assertKindCatalogueEnrollmentAdmission(context);
  return lockEnrollmentRows(context.tx, root, context.work);
}

// Common physical primitive. Neither caller is allowed to bypass its own original guard.
async function lockEnrollmentRows(tx: CommandTransaction, root: string, work: NativeCollectionWork) {
  const head = await lifecycleBodyWork(tx, work, catalogueSQLCost(cost.headLock, headLock.sql, {}), () =>
    headLock.run(tx),
  );
  const params = { root };
  const enrollment = await lifecycleBodyWork(tx, work, catalogueSQLCost(cost.rootLock, rootLock.sql, params), () =>
    rootLock.run(tx, params),
  );
  if (!head || !enrollment) return unavailable();
  return { head, enrollment };
}

async function readActivation(tx: CommandTransaction, root: string, work: NativeCollectionWork) {
  const params = { root };
  return lifecycleBodyWork(tx, work, catalogueSQLCost(cost.activationRead, activationRead.sql, params), () =>
    activationRead.run(tx, params),
  );
}

/** Fresh native command authorization has already run. Its committed intent authorizes only mechanical close work. */
export async function requestCatalogueActivation(
  tx: CommandTransaction,
  pin: KindCataloguePin,
  expectedHead: number,
  transactionId: string,
  work: NativeCollectionWork,
): Promise<Activation> {
  await lifecycleBodyWork(tx, work, nativeControl.lifecycleIdentity, async () => undefined);
  admittedPublication(tx, 'definitions:activate', transactionId);
  assertFrame(tx, work, pin.rootDigest, 'request');
  // Lock head first everywhere; an activation row is never acquired in the opposite order.
  const { head, enrollment } = await lockCatalogueEnrollment(tx, pin.rootDigest, work);
  if (
    !Number.isSafeInteger(expectedHead) ||
    expectedHead < 0 ||
    head.head !== expectedHead ||
    head.root_digest === pin.rootDigest
  )
    throw new StaleEditorialHeadError();
  if (enrollment.protocol !== 1 || enrollment.state !== 'open') return unavailable();
  if (head.root_digest !== null) {
    const params = { root: head.root_digest };
    const previous = await lifecycleBodyWork(tx, work, catalogueSQLCost(cost.rootLock, rootLock.sql, params), () =>
      rootLock.run(tx, params),
    );
    // Migration absence/unknown coverage is never interpreted as a genuinely empty frontier.
    if (!previous || previous.protocol !== 1 || previous.state === 'unproven') return unavailable();
  }
  const existing = await readActivation(tx, pin.rootDigest, work);
  if (existing) {
    if (existing.expected_head !== head.head || existing.previous_root !== head.root_digest)
      throw new StaleEditorialHeadError();
    return existing;
  }
  const params = {
    root: pin.rootDigest,
    activation_id: randomUUID(),
    previous: head.root_digest,
    head: head.head,
    transaction_id: transactionId,
  };
  const requested = await lifecycleBodyWork(
    tx,
    work,
    catalogueSQLCost(cost.activationRequest, activationRequest.sql, params),
    () => activationRequest.run(tx, params),
  );
  if (!requested) throw new StaleEditorialHeadError();
  return (await readActivation(tx, pin.rootDigest, work)) ?? unavailable();
}

/** One Global continuation; no Source checkout, callback or synthetic ACK. */
export async function advanceCatalogueActivation(
  tx: CommandTransaction,
  root: string,
  activationId: string,
  work: NativeCollectionWork,
): Promise<CatalogueActivationProgress> {
  await lifecycleBodyWork(tx, work, nativeControl.lifecycleIdentity, async () => undefined);
  assertFrame(tx, work, root, 'advance');
  const command = currentCommand(tx);
  if (command.partition !== 0 || Date.now() >= currentCommandResources(tx).deadline) return unavailable();
  // Hold the head through the root close. Enrollment takes these same actual row locks.
  const { head } = await lockCatalogueEnrollment(tx, root, work);
  let state = await readActivation(tx, root, work);
  if (!state || state.activation_id !== activationId) return unavailable();
  if (state.state === 'active') return { activationId, state: 'active', pending: false };
  if (head.head !== state.expected_head || head.root_digest !== state.previous_root)
    throw new StaleEditorialHeadError();
  const params = { root, activation_id: activationId };
  if (state.state === 'ready') {
    if (state.previous_root !== null) {
      const previousParams = { root: state.previous_root };
      const previous = await lifecycleBodyWork(
        tx,
        work,
        catalogueSQLCost(cost.rootLock, rootLock.sql, previousParams),
        () => rootLock.run(tx, previousParams),
      );
      if (!previous || previous.protocol !== 1 || previous.state === 'unproven') return unavailable();
      if (previous.state === 'open') {
        const closeParams = { root: state.previous_root, generation: previous.generation };
        const closed = await lifecycleBodyWork(
          tx,
          work,
          catalogueSQLCost(cost.closeRoot, closeRoot.sql, closeParams),
          () => closeRoot.run(tx, closeParams),
        );
        if (!closed) return unavailable();
      }
    }
    await lifecycleBodyWork(tx, work, catalogueSQLCost(cost.activationClosing, activationClosing.sql, params), () =>
      activationClosing.run(tx, params),
    );
    // This is a durable interruption boundary; the ordinary request may take the next bounded continuation.
    return { activationId, state: 'closing', pending: true };
  }
  if (state.state === 'closing') {
    let generation = '0',
      sequence = '0';
    if (state.previous_root !== null) {
      const previousParams = { root: state.previous_root };
      const previous = await lifecycleBodyWork(
        tx,
        work,
        catalogueSQLCost(cost.rootLock, rootLock.sql, previousParams),
        () => rootLock.run(tx, previousParams),
      );
      if (!previous || previous.protocol !== 1 || previous.state === 'unproven') return unavailable();
      if (previous.state === 'open') {
        const closeParams = { root: state.previous_root, generation: previous.generation };
        const closed = await lifecycleBodyWork(
          tx,
          work,
          catalogueSQLCost(cost.closeRoot, closeRoot.sql, closeParams),
          () => closeRoot.run(tx, closeParams),
        );
        if (!closed) return unavailable();
        generation = closed.closed_generation!;
        sequence = closed.closed_sequence!;
      } else {
        generation = previous.closed_generation ?? unavailable();
        sequence = previous.closed_sequence ?? unavailable();
      }
    }
    const cutParams = { ...params, generation, sequence };
    await lifecycleBodyWork(tx, work, catalogueSQLCost(cost.activationCut, activationCut.sql, cutParams), () =>
      activationCut.run(tx, cutParams),
    );
    state = (await readActivation(tx, root, work)) ?? unavailable();
  }
  if (state.state !== 'invalidating') return unavailable();
  const pending = await lifecycleBodyWork(
    tx,
    work,
    catalogueSQLCost(cost.frontierPoint, frontierPending.sql, { root }),
    () => frontierPending.run(tx, { root }),
  );
  if (pending) {
    const page = { root, previous: state.previous_root ?? unavailable() };
    // A LEFT JOIN preserves missing/uncertain consumers as retained obligations. No Source proof is synthesized.
    await lifecycleBodyWork(tx, work, catalogueSQLCost(cost.frontierRead, frontierRead.sql, page), () =>
      frontierRead.run(tx, page),
    );
    return { activationId, state: 'invalidating', pending: true };
  }
  if (state.previous_root !== null && state.staged_sequence !== state.closed_sequence) {
    const page = {
      ...params,
      previous: state.previous_root,
      after: state.staged_sequence,
      through: state.closed_sequence ?? unavailable(),
      generation: state.closed_generation ?? unavailable(),
    };
    await lifecycleBodyWork(tx, work, catalogueSQLCost(cost.frontierStage, frontierStage.sql, page), () =>
      frontierStage.run(tx, page),
    );
  }
  // Nonempty cuts require the original Source invalidation + current-owner/nonrevival producer.
  // It is absent. Retain every pending/negative/in-flight/uncertain obligation without dispatch or pruning.
  return { activationId, state: 'invalidating', pending: state.closed_sequence !== '0' };
}

/** Only the freshly authorized activation command may publish; actorless work cannot publish a head. */
export async function finishCatalogueActivation(
  tx: CommandTransaction,
  pin: KindCataloguePin,
  activationId: string,
  transactionId: string,
  work: NativeCollectionWork,
): Promise<number | null> {
  await lifecycleBodyWork(tx, work, nativeControl.lifecycleIdentity, async () => undefined);
  admittedPublication(tx, 'definitions:activate', transactionId);
  assertFrame(tx, work, pin.rootDigest, 'finish');
  const { head } = await lockCatalogueEnrollment(tx, pin.rootDigest, work);
  const state = await readActivation(tx, pin.rootDigest, work);
  if (!state || state.activation_id !== activationId) return unavailable();
  if (head.root_digest === pin.rootDigest && state.state === 'active') return head.head;
  if (head.head !== state.expected_head || head.root_digest !== state.previous_root)
    throw new StaleEditorialHeadError();
  if (state.state !== 'invalidating' || state.closed_sequence !== '0') return null;
  // The SQL rechecks the genuine closed frontier, not this local branch, counters supplied by a caller, or a complete bit.
  const params = {
    root: pin.rootDigest,
    activation_id: activationId,
    previous: state.previous_root,
    head: head.head,
    transaction_id: transactionId,
  };
  const saved = await lifecycleBodyWork(tx, work, catalogueSQLCost(cost.activationCAS, activationCAS.sql, params), () =>
    activationCAS.run(tx, params),
  );
  return saved?.head ?? null;
}

/** Retained bounded withdrawal obligations, including a vanished current consumer.
 * Snapshot bytes are immutable even when the Source consumer or its owner disappears.
 */
export async function readCatalogueActivationFrontier(
  tx: CommandTransaction,
  root: string,
  activationId: string,
  work: NativeCollectionWork,
) {
  await lifecycleBodyWork(tx, work, nativeControl.lifecycleIdentity, async () => undefined);
  assertFrame(tx, work, root, 'frontier');
  await lockCatalogueEnrollment(tx, root, work);
  const state = await readActivation(tx, root, work);
  if (!state || state.activation_id !== activationId || state.state !== 'invalidating') return unavailable();
  if (state.previous_root === null) return [];
  const params = { root, previous: state.previous_root };
  return lifecycleBodyWork(tx, work, catalogueSQLCost(cost.frontierRead, frontierRead.sql, params), () =>
    frontierRead.run(tx, params),
  );
}

/** No exported Source producer currently returns a committed catalogue dependency
 * withdrawal/nonrevival acknowledgement with a current owner/restore generation verifier.
 * readAndHold/revalidateHold prove a live read; releaseHold and retireCapture do not
 * withdraw a Kind consumer. An arbitrary object, old revision or precommit locator
 * cannot be consumed here. Keep the durable obligation and fail before foreign IO.
 */
export async function consumeCatalogueWithdrawalAcknowledgement(
  tx: CommandTransaction,
  input: Readonly<{ root: string; activationId: string; slot: number; acknowledgement: unknown }>,
  work: NativeCollectionWork,
): Promise<never> {
  const rows = await readCatalogueActivationFrontier(tx, input.root, input.activationId, work);
  if (!Number.isSafeInteger(input.slot) || !rows.some((row) => row.slot === input.slot)) return unavailable();
  return unavailable();
}

export type CatalogueRetirementProgress = Readonly<{
  phase: 'captures' | 'consumers' | 'tickets' | 'positions' | 'terminal';
  removed: number;
  retained: 'source-current-owner-nonrevival' | 'committed-native-settlement' | 'audit' | null;
}>;
/** One retained component, never a guessed whole cleanup job. Roots/builds,
 * immutable artifacts, activation/head history and terminal spent identities are
 * audit records and are deliberately retained. Their reverse references are not
 * interpreted as absence, refunds, or permission to recreate an original.
 */
export async function advanceCatalogueRetirement(
  tx: CommandTransaction,
  activatedRoot: string,
  work: NativeCollectionWork,
): Promise<CatalogueRetirementProgress> {
  assertFrame(tx, work, activatedRoot, 'retire');
  // Authority selects an actual activated intent, never a caller-supplied old root.
  // The intent is immutable after activation. Head lock precedes both root locks.
  await lockCatalogueEnrollment(tx, activatedRoot, work);
  const activation = await readActivation(tx, activatedRoot, work);
  if (!activation || activation.state !== 'active') return unavailable();
  if (activation.previous_root === null) return { phase: 'terminal', removed: 0, retained: 'audit' };
  const root = activation.previous_root;
  const { head, enrollment } = await lockEnrollmentRows(tx, root, work);
  if (head.root_digest === root || enrollment.protocol !== 1 || enrollment.state !== 'closed') return unavailable();
  const run = <T>(id: CatalogueLedgerOperation, params: Readonly<Record<string, unknown>>, body: () => Promise<T>) =>
    lifecycleBodyWork(tx, work, catalogueLedgerCost(id, params), body);
  const start = { root, transaction_id: currentCommand(tx).transactionId };
  await run('retirementStart', start, () => retirementStart.run(tx, start));
  const params = { root };
  const state = await run('retirementRead', params, () => retirementRead.run(tx, params));
  if (!state) return unavailable();
  const phase = state.phase as CatalogueRetirementProgress['phase'];
  if (!['captures', 'consumers', 'tickets', 'positions', 'terminal'].includes(phase)) return unavailable();
  if (phase === 'terminal') return { phase, removed: 0, retained: 'audit' };
  const progress = async (next: CatalogueRetirementProgress['phase'], after = state.after_original) => {
    const params = { root, expected: phase, next, after, sequence: state.after_sequence };
    if (!(await run('retirementProgress', params, () => retirementProgress.run(tx, params)))) return unavailable();
    return next;
  };
  if (phase === 'captures') {
    const captures = await run('retirementCaptures', params, () => retirementCaptures.run(tx, params));
    if (captures.length || enrollment.closed_sequence !== '0')
      return { phase, removed: 0, retained: 'source-current-owner-nonrevival' };
    return { phase: await progress('consumers'), removed: 0, retained: null };
  }
  if (phase === 'consumers') {
    const references = await run('retirementProbe', params, () => retirementProbe.run(tx, params));
    if (!references) return unavailable();
    if (references.consumers || references.captures || enrollment.closed_sequence !== '0') {
      // Source's CURRENT owner/restore and committed nonrevival verifier is missing.
      // The SQL deletion body exists, but a stored receipt/text generation is not its guard.
      void retirementConsumers;
      return { phase, removed: 0, retained: 'source-current-owner-nonrevival' };
    }
    return { phase: await progress('tickets'), removed: 0, retained: null };
  }
  if (phase === 'tickets') {
    const point = { root, after: state.after_original };
    const original = await run('retirementOriginal', point, () => retirementOriginal.run(tx, point));
    if (!original) return { phase: await progress('positions'), removed: 0, retained: null };
    if (original.state !== 'terminal') return { phase, removed: 0, retained: 'committed-native-settlement' };
    const page = { root, original_key: original.original_key };
    const removed = await run('retirementTickets', page, () => retirementTickets.run(tx, page));
    // The cursor commits with deletion. Lost responses repeat either the old complete
    // component or the new position; an empty already-cleaned original still advances.
    return { phase: await progress('tickets', original.original_key), removed: removed.length, retained: null };
  }
  const removed = await run('retirementPositions', params, () => retirementPositions.run(tx, params));
  if (removed.length) return { phase, removed: removed.length, retained: null };
  const references = await run('retirementProbe', params, () => retirementProbe.run(tx, params));
  if (!references) return unavailable();
  if (references.consumers || references.captures)
    return { phase, removed: 0, retained: 'source-current-owner-nonrevival' };
  if (references.unsettled || references.positions)
    return { phase, removed: 0, retained: 'committed-native-settlement' };
  return { phase: await progress('terminal'), removed: 0, retained: 'audit' };
}
