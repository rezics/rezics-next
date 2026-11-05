import type { Pool } from 'pg';
import { admitFilter, parseFilter } from '@rezics/filter';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { authoritativeTimeValue, commandTime, type AuthoritativeTime } from '../command/command.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import { ProblemError } from '../http/problem.ts';
import {
  createMembersPreparation,
  type MembersPreparationWorkDefinition,
  type PreparationLocator,
} from '../library/members-preparation.ts';
import type { Access } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { isDeepStrictEqual } from 'node:util';
import { meterMembersDefinition } from './scope-members-work-cost.ts';
import {
  admitCollectionKindPreparationStep,
  bindCollectionKindPreparationStep,
  readCollectionKindWorkDefinition,
  type CollectionKindPreparationLocator,
  type CollectionKindWorkDefinition,
} from '../library/collection-kind-work-admission.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import {
  admitCollectionPublicationStep,
  readCollectionPublicationWorkDefinition,
  type CollectionPublicationLocator,
  type CollectionPublicationWorkDefinition,
} from '../library/collection-publication-work-admission.ts';

/** SERVER ONLY. A native lookup, never an Actor, permission, DTO or persisted cursor value. */
export type MembersPreparationWorkContext = Readonly<{
  kind: 'members-preparation';
  tx: OperationalTransaction;
  locator: PreparationLocator;
}>;

/** SERVER ONLY. A distinct native Kind episode, never a curated Members locator. */
export type CollectionKindPreparationWorkContext = Readonly<{
  kind: 'collection-kind-preparation';
  tx: OperationalTransaction;
  locator: CollectionKindPreparationLocator;
}>;
const kindContexts = new WeakMap<
  object,
  Readonly<{
    tx: OperationalTransaction;
    locator: CollectionKindPreparationLocator;
    work: NativeCollectionWork;
  }>
>();

/** Mint a context only from the live transaction's exact admitted native frame. */
export function bindCollectionKindPreparationWorkContext(
  tx: OperationalTransaction,
  locator: CollectionKindPreparationLocator,
  work: NativeCollectionWork,
): CollectionKindPreparationWorkContext {
  bindCollectionKindPreparationStep(tx, locator, work);
  const context = Object.freeze({
    kind: 'collection-kind-preparation' as const,
    tx,
    locator: Object.freeze({ ...locator }),
  });
  kindContexts.set(context, Object.freeze({ tx, locator: context.locator, work }));
  return context;
}

function isBoundCollectionKindPreparationWorkContext(context: CollectionKindPreparationWorkContext): boolean {
  const bound = kindContexts.get(context);
  return (
    !!bound &&
    bound.tx === context.tx &&
    bound.locator.route === context.locator.route &&
    bound.locator.ownerAccountId === context.locator.ownerAccountId &&
    bound.locator.collectionId === context.locator.collectionId &&
    bound.locator.preparationId === context.locator.preparationId
  );
}
/** Accounts consumes the same private original Kind frame, never a structural context. */
export function collectionKindPreparationNativeWork(
  context: CollectionKindPreparationWorkContext,
): NativeCollectionWork | undefined {
  return isBoundCollectionKindPreparationWorkContext(context) && hasLiveOperationalTransaction(context.tx)
    ? kindContexts.get(context)!.work
    : undefined;
}

/** SERVER ONLY. Whole-query publication B consumes its own Collection's private working input. */
export type CollectionPublicationWorkContext = Readonly<{
  kind: 'collection-publication';
  tx: OperationalTransaction;
  locator: CollectionPublicationLocator;
}>;
export type ScopeWorkContext =
  | MembersPreparationWorkContext
  | CollectionKindPreparationWorkContext
  | CollectionPublicationWorkContext;

type WorkOptions = Readonly<{ pool: Pool; access: Access; deadline: number }>;

/** Compare owner data, never manufacture an episode, capture, Actor or final command authority. */
export async function readCollectionPublicationScopeWorkDefinition(
  work: CollectionPublicationWorkContext,
  options: WorkOptions,
): Promise<CollectionPublicationWorkDefinition> {
  const { tx } = work;
  if (work.kind !== 'collection-publication' || !hasLiveOperationalTransaction(tx))
    throw new ProblemError('semantic_not_ready');
  const resources = currentOperationalResources(tx);
  const locator = Object.freeze({
    route: work.locator.route,
    ownerAccountId: work.locator.ownerAccountId,
    collectionId: work.locator.collectionId,
    publicationId: work.locator.publicationId,
  });
  const route = routeOf(locator.collectionId);
  const deadline = Math.min(options.deadline, resources.deadline);
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (
    route === null ||
    locator.route !== route ||
    routeOf(locator.ownerAccountId) !== route ||
    !uuid.test(locator.publicationId) ||
    !isDeepStrictEqual(work.locator, locator) ||
    resources.pool !== options.pool ||
    resources.mode !== 'work-step' ||
    resources.partition !== partitionOf(route) ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== locator.ownerAccountId ||
    !Number.isFinite(options.deadline) ||
    options.deadline > resources.deadline ||
    Date.now() >= deadline
  )
    throw new ProblemError('semantic_not_ready');
  const time = commandTime(tx);
  if (!time) throw new ProblemError('semantic_not_ready');
  authoritativeTimeValue(time);
  function current() {
    if (
      !hasLiveOperationalTransaction(tx) ||
      Date.now() >= deadline ||
      commandTime(tx) !== time ||
      !isDeepStrictEqual(work.locator, locator)
    )
      throw new ProblemError('semantic_not_ready');
    authoritativeTimeValue(time!);
  }
  // Library alone resolves the original committed episode and current immutable rule/fences.
  if ((await admitCollectionPublicationStep(tx, locator)) !== true) throw new ProblemError('semantic_not_ready');
  current();
  const native = await readCollectionPublicationWorkDefinition(tx, locator);
  current();
  if (!native) throw new ProblemError('semantic_not_ready');
  const { input, target, rule, creation, sourceIdentity: source, observation, identityObservation, custody } = native;
  const { repairReceipt, definition, output, selected } = native;
  // These are relationships between the actual native fields. In particular, no output
  // generation (including selected A) can replace B's private input or its Source generation.
  if (
    !isDeepStrictEqual(native.locator, locator) ||
    input.kind !== 'private_working_source' ||
    input.identity.scope !== 'private_builtin' ||
    source.scope !== 'private_builtin' ||
    !isDeepStrictEqual(source, input.identity) ||
    source.route !== route ||
    source.collectionId !== locator.collectionId ||
    source.accountId !== locator.ownerAccountId ||
    !source.incarnation ||
    !source.generation ||
    !source.receivingEpoch ||
    !source.effectKey ||
    target.kind !== 'collection_output' ||
    target.route !== route ||
    target.collectionId !== locator.collectionId ||
    (target.visibility !== 'public' && target.visibility !== 'unlisted') ||
    definition.sort !== 'id' ||
    !native.releaseDigest ||
    !native.audience ||
    !rule.digest ||
    definition.release.digest !== native.releaseDigest ||
    rule.releaseDigest !== native.releaseDigest ||
    rule.incarnation !== source.incarnation ||
    rule.collectionRevision !== observation.revision ||
    rule.sourceGeneration !== source.generation ||
    (rule.kind !== 'saved' && rule.kind !== 'builtin') ||
    (rule.kind === 'saved' && (!Number.isSafeInteger(rule.revision) || rule.revision < 1)) ||
    (rule.kind === 'builtin' && rule.key.kind !== 'everything' && rule.key.kind !== 'state') ||
    observation.collectionId !== source.collectionId ||
    observation.route !== source.route ||
    observation.incarnation !== source.incarnation ||
    observation.authority.kind !== 'private_builtin' ||
    observation.authority.curatorAccountId !== locator.ownerAccountId ||
    observation.stamp.partition !== resources.partition ||
    observation.stamp.epoch !== source.ownerEpoch ||
    !observation.basis.profilePins.includes(native.releaseDigest) ||
    identityObservation.key.source.kind !== 'library' ||
    !isDeepStrictEqual(identityObservation.key.source.identity, source) ||
    !identityObservation.key.scopeId ||
    !identityObservation.captureId ||
    identityObservation.committedRevision < 0n ||
    identityObservation.captureId !== custody.captureId ||
    !isDeepStrictEqual(custody.identity, source) ||
    !custody.holdId ||
    !custody.transactionId ||
    repairReceipt.partition !== resources.partition ||
    repairReceipt.epoch !== source.ownerEpoch ||
    !repairReceipt.transactionId ||
    repairReceipt.position < 0n ||
    (native.phase !== 'staging' && native.phase !== 'awaiting_activation') ||
    output.state !== 'building' ||
    'publication' in output ||
    output.ref.route !== target.route ||
    output.ref.collectionId !== target.collectionId ||
    !uuid.test(output.ref.generation) ||
    !isDeepStrictEqual(creation.source.locator, locator) ||
    !isDeepStrictEqual(creation.source.input, input) ||
    !isDeepStrictEqual(creation.source.target, target) ||
    !isDeepStrictEqual(creation.source.rule, rule) ||
    !isDeepStrictEqual(creation.source.output, output.ref) ||
    creation.initiator.creation.target.route !== route ||
    creation.initiator.creation.target.id !== locator.collectionId ||
    (selected !== null &&
      (selected.state !== 'complete' ||
        selected.ref.route !== route ||
        selected.ref.collectionId !== locator.collectionId ||
        !uuid.test(selected.ref.generation) ||
        selected.ref.generation === output.ref.generation ||
        selected.publication.generation !== selected.ref.generation ||
        !selected.publication.transactionId ||
        !selected.publication.nativeXid ||
        !selected.publication.sourceGeneration ||
        !selected.publication.memberFence ||
        !/^(0|[1-9][0-9]*)$/.test(selected.publication.position) ||
        !/^(0|[1-9][0-9]*)$/.test(selected.publication.members)))
  )
    throw new ProblemError('semantic_not_ready');
  // Re-admission checks the expanded pinned meaning, not just a copied release scalar.
  // Creation is compared as committed data; its initiator is never restored as an Actor.
  try {
    if (
      !isDeepStrictEqual(
        admitFilter(parseFilter(definition.filter), definition.release.value, { owner: true }),
        definition.filter,
      ) ||
      creation.initiator.sourceDigest !== createHash('sha256').update(canonicalize(creation.source)!).digest('hex') ||
      creation.durableInitiator !== createHash('sha256').update(canonicalize(creation.initiator)!).digest('hex')
    )
      throw new ProblemError('semantic_not_ready');
  } catch {
    throw new ProblemError('semantic_not_ready');
  }
  current();
  return native;
}

/** Admission and the whole native result are reread on every use, before any Source I/O. */
export async function readCollectionKindPreparationWorkDefinition(
  work: CollectionKindPreparationWorkContext,
  options: WorkOptions,
): Promise<CollectionKindWorkDefinition> {
  const { tx } = work;
  if (
    work.kind !== 'collection-kind-preparation' ||
    !isBoundCollectionKindPreparationWorkContext(work) ||
    !hasLiveOperationalTransaction(tx)
  )
    throw new ProblemError('semantic_not_ready');
  const resources = currentOperationalResources(tx);
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
    !locator.preparationId ||
    !Number.isFinite(options.deadline) ||
    Date.now() >= Math.min(options.deadline, resources.deadline)
  )
    throw new ProblemError('semantic_not_ready');
  const time = commandTime(tx);
  if (!time) throw new ProblemError('semantic_not_ready');
  authoritativeTimeValue(time);
  // Library verifies the COMMITTED prepare/repair intent, current audience and exact custody.
  // Neither the Core fence nor the returned definition is a substitute for this admission.
  if ((await admitCollectionKindPreparationStep(tx, locator, kindContexts.get(work)!.work)) !== true)
    throw new ProblemError('semantic_not_ready');
  const native = await readCollectionKindWorkDefinition(tx, locator, kindContexts.get(work)!.work);
  if (!hasLiveOperationalTransaction(tx) || Date.now() >= Math.min(options.deadline, resources.deadline))
    throw new ProblemError('semantic_not_ready');
  authoritativeTimeValue(time);
  if (!native) throw new ProblemError('semantic_not_ready');
  const { sourceIdentity: source, observation, identityObservation, custody, repairReceipt } = native;
  if (
    source.route !== locator.route ||
    source.collectionId !== locator.collectionId ||
    (source.scope !== 'public_output' && source.accountId !== locator.ownerAccountId) ||
    observation.collectionId !== source.collectionId ||
    observation.route !== source.route ||
    observation.incarnation !== source.incarnation ||
    observation.stamp.partition !== resources.partition ||
    observation.stamp.epoch !== source.ownerEpoch ||
    !native.releaseDigest ||
    !native.audience ||
    !observation.basis.profilePins.includes(native.releaseDigest) ||
    identityObservation.key.source.kind !== 'library' ||
    !isDeepStrictEqual(identityObservation.key.source.identity, source) ||
    identityObservation.captureId !== custody.captureId ||
    !isDeepStrictEqual(custody.identity, source) ||
    !custody.holdId ||
    !custody.transactionId ||
    repairReceipt.partition !== resources.partition ||
    !repairReceipt.transactionId ||
    repairReceipt.position < 0n ||
    (source.scope === 'public_output'
      ? (observation.authority.kind !== 'activated_output' && observation.authority.kind !== 'frozen_output') ||
        observation.authority.generation !== source.outputGeneration
      : source.scope === 'curated'
        ? observation.authority.kind !== 'curated'
        : observation.authority.kind !== 'private_builtin' ||
          observation.authority.curatorAccountId !== locator.ownerAccountId)
  )
    throw new ProblemError('semantic_not_ready');
  return native;
}

/** Dispatch only; the original native modules remain the sole episode and result authorities. */
export async function readScopeWorkDefinition(
  work: ScopeWorkContext,
  options: WorkOptions,
): Promise<MembersPreparationWorkDefinition | CollectionKindWorkDefinition | CollectionPublicationWorkDefinition> {
  switch (work.kind) {
    case 'members-preparation':
      return readMembersPreparationWorkDefinition(work, options);
    case 'collection-kind-preparation':
      return readCollectionKindPreparationWorkDefinition(work, options);
    case 'collection-publication':
      return readCollectionPublicationScopeWorkDefinition(work, options);
    default:
      throw new ProblemError('semantic_not_ready');
  }
}

export async function admitScopeWork(work: ScopeWorkContext, options: WorkOptions): Promise<AuthoritativeTime> {
  await readScopeWorkDefinition(work, options);
  const time = commandTime(work.tx);
  if (!time) throw new ProblemError('semantic_not_ready');
  authoritativeTimeValue(time);
  return time;
}

/** Read the actual immutable producer inputs on each use, with no retained admission verdict. */
export async function readMembersPreparationWorkDefinition(
  work: MembersPreparationWorkContext,
  options: Readonly<{ pool: Pool; access: Access; deadline: number }>,
): Promise<MembersPreparationWorkDefinition> {
  return meterMembersDefinition(work.tx, () => readMembersDefinition(work, options));
}
async function readMembersDefinition(
  work: MembersPreparationWorkContext,
  options: Readonly<{ pool: Pool; access: Access; deadline: number }>,
): Promise<MembersPreparationWorkDefinition> {
  const { tx } = work;
  if (work.kind !== 'members-preparation' || !hasLiveOperationalTransaction(tx))
    throw new ProblemError('semantic_not_ready');
  const resources = currentOperationalResources(tx);
  const locator = Object.freeze({
    route: work.locator.route,
    ownerAccountId: work.locator.ownerAccountId,
    collectionId: work.locator.collectionId,
    episodeId: work.locator.episodeId,
  });
  const route = routeOf(locator.collectionId);
  if (
    route === null ||
    locator.route !== route ||
    routeOf(locator.ownerAccountId) !== route ||
    routeOf(locator.episodeId) !== route ||
    !isDeepStrictEqual(work.locator, locator) ||
    resources.pool !== options.pool ||
    resources.mode !== 'work-step' ||
    resources.partition !== partitionOf(route) ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== locator.ownerAccountId ||
    !Number.isFinite(options.deadline) ||
    options.deadline > resources.deadline ||
    Date.now() >= Math.min(options.deadline, resources.deadline)
  )
    throw new ProblemError('semantic_not_ready');
  const time = commandTime(tx);
  if (!time) throw new ProblemError('semantic_not_ready');
  authoritativeTimeValue(time);
  const preparation = createMembersPreparation({
    pool: resources.pool,
    workClient: resources.workClient,
    access: options.access,
  });
  // The same-client getter locks and checks the current episode, Collection and Source in this Work phase.
  // No request-side permission or fabricated episode substitutes for that native state.
  const native = await preparation.readWorkDefinition(tx, locator);
  if (
    !hasLiveOperationalTransaction(tx) ||
    Date.now() >= Math.min(options.deadline, resources.deadline) ||
    commandTime(tx) !== time ||
    !isDeepStrictEqual(work.locator, locator)
  )
    throw new ProblemError('semantic_not_ready');
  authoritativeTimeValue(time);
  if (!native) throw new ProblemError('semantic_not_ready');
  const { sourceIdentity: source, observation } = native;
  if (
    source.scope !== 'curated' ||
    source.route !== locator.route ||
    source.collectionId !== locator.collectionId ||
    source.accountId !== locator.ownerAccountId ||
    !source.incarnation ||
    !source.generation ||
    !source.receivingEpoch ||
    !source.effectKey ||
    (native.definition.sort !== 'id' && native.definition.sort !== 'ordinal') ||
    !/^sha256:[0-9a-f]{64}$/.test(native.definition.release.digest) ||
    observation.collectionId !== source.collectionId ||
    observation.route !== source.route ||
    observation.incarnation !== source.incarnation ||
    observation.authority.kind !== 'curated' ||
    observation.stamp.partition !== resources.partition ||
    observation.stamp.epoch !== source.ownerEpoch
  )
    throw new ProblemError('semantic_not_ready');
  return native;
}

/** Trusted time comes only from the live Core attempt, after native immutable episode admission. */
export async function admitMembersPreparationWork(
  work: MembersPreparationWorkContext,
  options: Readonly<{ pool: Pool; access: Access; deadline: number }>,
): Promise<AuthoritativeTime> {
  const { tx, kind, locator } = work;
  await readMembersPreparationWorkDefinition({ tx, kind, locator }, options);
  const time = commandTime(tx);
  if (!time) throw new ProblemError('semantic_not_ready');
  authoritativeTimeValue(time);
  return time;
}
