import { memoizedValue } from '../memoized.ts';
import { isDeepStrictEqual } from 'node:util';
import type { OperationalTransaction } from '../command/operational.ts';
import { ProblemError } from '../http/problem.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  hasOperationalAdmission,
} from '../command/operational.ts';
import { commandTime } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { CollectionSourceObservation } from './collection-source.ts';
import type { WorkAllowance } from './contract/work-dimensions.ts';
import { NativeCollectionWork } from './collection-native-work.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceIdentity,
  type NativeSourceCustody,
} from './native-source-custody.ts';
import {
  COLLECTION_KIND_INPUT_TERMS,
  collectionKindInputWorkDimensions,
  invokeCollectionKindInput,
} from './collection-kind-input-bounds.ts';
import admitEpisode from './collection-kind-work-admit.sql';
import readSource from './collection-kind-work-source.sql';

export { collectionKindInputAdmissionWork } from './collection-kind-input-bounds.ts';

export type CollectionKindPreparationLocator = Readonly<{
  route: number;
  ownerAccountId: string;
  collectionId: string;
  preparationId: string;
}>;
export type CollectionKindWorkDefinition = Readonly<{
  releaseDigest: string;
  audience: string;
  sourceIdentity: NativeSourceIdentity;
  observation: CollectionSourceObservation;
  identityObservation: IdentityScopeObservation;
  repairReceipt: IdentityNativeReceipt;
  custody: NativeSourceCustody;
}>;

type ConsumerRow = (typeof admitEpisode)['~reylo']['element'];
type SourceRow = (typeof readSource)['~reylo']['element'];
type Invocation = Readonly<{
  tx: OperationalTransaction;
  locator: CollectionKindPreparationLocator;
  pool: ReturnType<typeof currentOperationalResources>['pool'];
  deadline: number;
}>;

const invocations = new WeakMap<NativeCollectionWork, Invocation>();
const localAdmissions = new WeakMap<
  NativeCollectionWork,
  Readonly<{
    tx: OperationalTransaction;
    locator: CollectionKindPreparationLocator;
    originId: string;
    referenceId: string;
    sourceIdentity: NativeSourceIdentity;
    custody: NativeSourceCustody;
  }>
>();

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decimal = /^(0|[1-9][0-9]{0,18})$/;
const sha256 = /^[0-9a-f]{64}$/;
const maxNativeInteger = 9_223_372_036_854_775_807n;

function exactLocator(locator: CollectionKindPreparationLocator): boolean {
  return (
    !!locator &&
    Object.keys(locator).sort().join(',') === 'collectionId,ownerAccountId,preparationId,route' &&
    Number.isInteger(locator.route) &&
    locator.route >= 0 &&
    locator.route <= 65535 &&
    routeOf(locator.collectionId) === locator.route &&
    routeOf(locator.ownerAccountId) === locator.route &&
    uuid.test(locator.preparationId)
  );
}

/** Bind one native frame to one live Core transaction and one immutable episode. */
export function bindCollectionKindPreparationStep(
  tx: OperationalTransaction,
  locator: CollectionKindPreparationLocator,
  work: NativeCollectionWork,
): void {
  if (
    !(work instanceof NativeCollectionWork) ||
    !hasLiveOperationalTransaction(tx) ||
    !hasOperationalAdmission(tx, work) ||
    !exactLocator(locator)
  )
    throw new ProblemError('semantic_not_ready');
  const resources = currentOperationalResources(tx);
  const deadline = work.deadlineAt;
  if (
    resources.mode !== 'work-step' ||
    resources.partition !== partitionOf(locator.route) ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== locator.ownerAccountId ||
    resources.deadline !== deadline ||
    Date.now() >= deadline ||
    !commandTime(tx)
  )
    throw new ProblemError('semantic_not_ready');
  const prior = invocations.get(work);
  if (
    prior &&
    ((prior.tx !== tx && hasLiveOperationalTransaction(prior.tx)) ||
      prior.pool !== resources.pool ||
      prior.deadline !== deadline ||
      prior.locator.route !== locator.route ||
      prior.locator.ownerAccountId !== locator.ownerAccountId ||
      prior.locator.collectionId !== locator.collectionId ||
      prior.locator.preparationId !== locator.preparationId)
  )
    throw new ProblemError('semantic_not_ready');
  invocations.set(
    work,
    Object.freeze({
      tx,
      locator: Object.freeze({ ...locator }),
      pool: resources.pool,
      deadline,
    }),
  );
}

function currentInvocation(
  tx: OperationalTransaction,
  locator: CollectionKindPreparationLocator,
  work: NativeCollectionWork,
): Invocation | null {
  if (
    !(work instanceof NativeCollectionWork) ||
    !hasLiveOperationalTransaction(tx) ||
    !hasOperationalAdmission(tx, work)
  )
    return null;
  const invocation = invocations.get(work);
  const resources = currentOperationalResources(tx);
  if (
    !invocation ||
    invocation.tx !== tx ||
    !exactLocator(locator) ||
    invocation.pool !== resources.pool ||
    invocation.deadline !== work.deadlineAt ||
    invocation.deadline !== resources.deadline ||
    Date.now() >= invocation.deadline ||
    invocation.locator.route !== locator.route ||
    invocation.locator.ownerAccountId !== locator.ownerAccountId ||
    invocation.locator.collectionId !== locator.collectionId ||
    invocation.locator.preparationId !== locator.preparationId ||
    resources.mode !== 'work-step' ||
    resources.partition !== partitionOf(locator.route) ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== locator.ownerAccountId ||
    !commandTime(tx)
  )
    return null;
  return invocation;
}

function captureToken(value: string): Readonly<{
  fence: string;
  captureId: string;
  holdId: string;
  scopeCaptureId: string;
  revision: string;
}> | null {
  if (Buffer.byteLength(value, 'utf8') > 512) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 6 ||
      parsed[0] !== 1 ||
      typeof parsed[1] !== 'string' ||
      !sha256.test(parsed[1]) ||
      typeof parsed[2] !== 'string' ||
      !uuid.test(parsed[2]) ||
      typeof parsed[3] !== 'string' ||
      !uuid.test(parsed[3]) ||
      typeof parsed[4] !== 'string' ||
      !uuid.test(parsed[4]) ||
      typeof parsed[5] !== 'string' ||
      !decimal.test(parsed[5]) ||
      BigInt(parsed[5]) > maxNativeInteger ||
      JSON.stringify(parsed) !== value
    )
      return null;
    return Object.freeze({
      fence: parsed[1],
      captureId: parsed[2],
      holdId: parsed[3],
      scopeCaptureId: parsed[4],
      revision: parsed[5],
    });
  } catch {
    return null;
  }
}

function sourceIdentity(
  value: unknown,
  locator: CollectionKindPreparationLocator,
  generation: string,
): NativeSourceIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  const expectedKeys = [
    'accountId',
    'collectionId',
    'effectKey',
    'generation',
    'incarnation',
    'ownerEpoch',
    'receivingEpoch',
    'route',
    'scope',
  ];
  if (
    Object.keys(identity).sort().join(',') !== expectedKeys.join(',') ||
    (identity.scope !== 'curated' && identity.scope !== 'private_builtin')
  )
    return null;
  const scope = identity.scope;
  const incarnation = identity.incarnation;
  const ownerEpoch = identity.ownerEpoch;
  const receivingEpoch = identity.receivingEpoch;
  const effectKey = identity.effectKey;
  if (
    identity.route !== locator.route ||
    identity.collectionId !== locator.collectionId ||
    identity.accountId !== locator.ownerAccountId ||
    identity.generation !== generation ||
    !decimal.test(generation) ||
    BigInt(generation) > maxNativeInteger ||
    typeof incarnation !== 'string' ||
    Buffer.byteLength(incarnation) < 1 ||
    Buffer.byteLength(incarnation) > 128 ||
    typeof ownerEpoch !== 'number' ||
    !Number.isSafeInteger(ownerEpoch) ||
    ownerEpoch < 1 ||
    typeof receivingEpoch !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(receivingEpoch) ||
    BigInt(receivingEpoch) > maxNativeInteger ||
    typeof effectKey !== 'string' ||
    Buffer.byteLength(effectKey) < 1 ||
    Buffer.byteLength(effectKey) > 256
  )
    return null;
  return Object.freeze({
    scope,
    route: locator.route,
    collectionId: locator.collectionId,
    accountId: locator.ownerAccountId,
    incarnation,
    generation,
    ownerEpoch,
    receivingEpoch,
    effectKey,
  });
}

function completeSourceFrontier(value: unknown, captureId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frontier = value as Record<string, unknown>;
  return (
    Object.keys(frontier).sort().join(',') === 'after,captureId,driver,scanned,sessionId,tie,version' &&
    frontier.captureId === captureId &&
    frontier.driver === 'done' &&
    typeof frontier.after === 'string' &&
    Buffer.byteLength(frontier.after) <= 512 &&
    typeof frontier.tie === 'string' &&
    Buffer.byteLength(frontier.tie) <= 64 &&
    (frontier.sessionId === null || (typeof frontier.sessionId === 'string' && uuid.test(frontier.sessionId))) &&
    typeof frontier.scanned === 'string' &&
    decimal.test(frontier.scanned) &&
    BigInt(frontier.scanned) <= maxNativeInteger &&
    typeof frontier.version === 'number' &&
    Number.isSafeInteger(frontier.version) &&
    frontier.version >= 0
  );
}

/** The caller already holds the genuine home. Named plan terms reserve before IO. */
function terms() {
  return memoizedValue(terms, () => COLLECTION_KIND_INPUT_TERMS());
}

/** Locks the exact current enrolled episode, committed Source scope and retained custody. */
export async function admitCollectionKindPreparationStep(
  tx: OperationalTransaction,
  locator: CollectionKindPreparationLocator,
  work: NativeCollectionWork,
): Promise<boolean> {
  const invocation = currentInvocation(tx, locator, work);
  if (!invocation) throw new ProblemError('semantic_not_ready');
  localAdmissions.delete(work);
  const time = commandTime(tx);
  if (!time) throw new ProblemError('semantic_not_ready');
  const result = await (async () => {
    const episodeInput = {
      route: locator.route,
      owner_account_id: locator.ownerAccountId,
      collection_id: locator.collectionId,
      preparation_id: locator.preparationId,
      deadline_at: String(invocation.deadline),
    };
    const consumers: ConsumerRow[] = await invokeCollectionKindInput(work, terms().admissionEpisode, () =>
      admitEpisode.run(tx, episodeInput),
    );
    if (!currentInvocation(tx, locator, work) || commandTime(tx) !== time) return null;
    if (consumers.length !== 1) return null;
    const consumer = consumers[0]!;
    const token = captureToken(consumer.sourceCapture);
    if (
      !token ||
      consumer.collectionState !== 'active' ||
      consumer.currentSourceGeneration !== consumer.sourceGeneration ||
      !decimal.test(consumer.sourceGeneration) ||
      BigInt(consumer.sourceGeneration) > maxNativeInteger ||
      !uuid.test(consumer.captureGeneration) ||
      !uuid.test(consumer.enrollmentGeneration) ||
      typeof consumer.referenceId !== 'string' ||
      Buffer.byteLength(consumer.referenceId) < 1 ||
      Buffer.byteLength(consumer.referenceId) > 255 ||
      typeof consumer.originId !== 'string' ||
      Buffer.byteLength(consumer.originId) < 1 ||
      Buffer.byteLength(consumer.originId) > 255 ||
      !/^sha256:[0-9a-f]{64}$/.test(consumer.catalogueRoot) ||
      !decimal.test(consumer.restoreGeneration) ||
      BigInt(consumer.restoreGeneration) > maxNativeInteger
    )
      return null;
    const sourceInput = {
      route: locator.route,
      collection_id: locator.collectionId,
      source_fence: token.fence,
      capture_id: token.captureId,
    };
    const scope: SourceRow | null | undefined = await invokeCollectionKindInput(work, terms().admissionSource, () =>
      readSource.run(tx, sourceInput),
    );
    if (!currentInvocation(tx, locator, work) || commandTime(tx) !== time) return null;
    if (
      !scope ||
      !scope.complete ||
      !scope.committed ||
      scope.nativeCaptureId !== token.captureId ||
      scope.capture !== token.scopeCaptureId ||
      scope.revision !== token.revision ||
      !completeSourceFrontier(scope.frontier, token.captureId)
    )
      return null;
    const identity = sourceIdentity(scope.identity, locator, consumer.sourceGeneration);
    if (!identity) return null;
    // This call revalidates the exact current owner/capture/receipt/hold in the same live T and
    // transfers only the already-reserved remainder of this original frame to Native custody.
    const held = await work.compose(
      (allowance: WorkAllowance) =>
        createNativeLibrarySourceCustody({ pool: invocation.pool }).readAndHold({
          client: tx,
          at: time,
          identity,
          captureId: token.captureId,
          holdId: token.holdId,
          allowance,
          deadline: invocation.deadline,
        }),
      collectionKindInputWorkDimensions(terms().custody),
    );
    if (
      held.status !== 'held' ||
      !currentInvocation(tx, locator, work) ||
      !hasLiveOperationalTransaction(tx) ||
      commandTime(tx) !== time ||
      Date.now() >= invocation.deadline
    )
      return null;
    localAdmissions.set(
      work,
      Object.freeze({
        tx,
        locator: Object.freeze({ ...locator }),
        originId: consumer.originId,
        referenceId: consumer.referenceId,
        sourceIdentity: identity,
        custody: held.custody,
      }),
    );
    return true;
  })();
  return result === true;
}

/** Reread Source custody; missing independent audience/identity results remain unavailable. */
export async function readCollectionKindWorkDefinition(
  tx: OperationalTransaction,
  locator: CollectionKindPreparationLocator,
  work: NativeCollectionWork,
): Promise<CollectionKindWorkDefinition | null> {
  const invocation = currentInvocation(tx, locator, work);
  if (!invocation || !(await admitCollectionKindPreparationStep(tx, locator, work))) return null;
  const admitted = localAdmissions.get(work);
  if (
    !admitted ||
    admitted.tx !== tx ||
    admitted.locator.route !== locator.route ||
    admitted.locator.ownerAccountId !== locator.ownerAccountId ||
    admitted.locator.collectionId !== locator.collectionId ||
    admitted.locator.preparationId !== locator.preparationId ||
    !isDeepStrictEqual(admitted.custody.identity, admitted.sourceIdentity)
  )
    return null;
  // Exact foreign producer gap: createIdentityScopedObservations(...).revalidate
  // in semantic/identity-scoped-observations.ts returns IdentityScopeRevalidateResult
  // (current observation and work only). It provides neither IdentityNativeReceipt
  // nor the five audience dependency closures. NativeDefinitionCatalogue.head,
  // kinds, kindPage and kindCandidates supply pins/declarations, not that receipt
  // or current Source-local audience proof. Source custody and consent cannot
  // construct any of these operands. Keep only the complete-definition dispatch
  // unavailable; admission above is independent of completed Type evidence.
  return null;
}

/** Pre-Type owner operands only. No repair receipt, release or disclosure closure. */
export function currentCollectionKindInputAdmission(
  tx: OperationalTransaction,
  locator: CollectionKindPreparationLocator,
  work: NativeCollectionWork,
) {
  const invocation = currentInvocation(tx, locator, work);
  const held = localAdmissions.get(work);
  return invocation && held?.tx === tx && isDeepStrictEqual(held.locator, locator)
    ? Object.freeze({ ...held, pool: invocation.pool, deadline: invocation.deadline })
    : undefined;
}
