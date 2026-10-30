import type { Pool } from 'pg';
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
import {
  admitCollectionKindPreparationStep,
  readCollectionKindWorkDefinition,
  type CollectionKindPreparationLocator,
  type CollectionKindWorkDefinition,
} from '../library/collection-kind-work-admission.ts';

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
export type ScopeWorkContext = MembersPreparationWorkContext | CollectionKindPreparationWorkContext;

type WorkOptions = Readonly<{ pool: Pool; access: Access; deadline: number }>;

/** Admission and the whole native result are reread on every use, before any Source I/O. */
export async function readCollectionKindPreparationWorkDefinition(
  work: CollectionKindPreparationWorkContext,
  options: WorkOptions,
): Promise<CollectionKindWorkDefinition> {
  const { tx } = work;
  if (work.kind !== 'collection-kind-preparation' || !hasLiveOperationalTransaction(tx))
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
  if ((await admitCollectionKindPreparationStep(tx, locator)) !== true) throw new ProblemError('semantic_not_ready');
  const native = await readCollectionKindWorkDefinition(tx, locator);
  if (!hasLiveOperationalTransaction(tx) || Date.now() >= Math.min(options.deadline, resources.deadline))
    throw new ProblemError('semantic_not_ready');
  authoritativeTimeValue(time);
  if (!native) throw new ProblemError('semantic_not_ready');
  const { sourceIdentity: source, observation, identityObservation, custody, repairReceipt } = native;
  if (
    source.scope === 'curated' ||
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
      : observation.authority.kind !== 'private_builtin' ||
        observation.authority.curatorAccountId !== locator.ownerAccountId)
  )
    throw new ProblemError('semantic_not_ready');
  return native;
}

/** Dispatch only; the original native modules remain the sole episode and result authorities. */
export async function readScopeWorkDefinition(work: ScopeWorkContext, options: WorkOptions) {
  switch (work.kind) {
    case 'members-preparation':
      return readMembersPreparationWorkDefinition(work, options);
    case 'collection-kind-preparation':
      return readCollectionKindPreparationWorkDefinition(work, options);
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
  const { tx } = work;
  if (work.kind !== 'members-preparation' || !hasLiveOperationalTransaction(tx))
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
    !Number.isFinite(options.deadline) ||
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
  // Library alone locks the current namespace/owner/episode and immutable definition.
  // Its unavailable native producer must propagate; no local permission or fabricated episode substitutes.
  if ((await preparation.admitStep(tx, locator)) !== true) throw new ProblemError('semantic_not_ready');
  const native = await preparation.readWorkDefinition(tx, locator);
  if (!hasLiveOperationalTransaction(tx) || Date.now() >= Math.min(options.deadline, resources.deadline))
    throw new ProblemError('semantic_not_ready');
  authoritativeTimeValue(time);
  if (!native) throw new ProblemError('semantic_not_ready');
  const { sourceIdentity: source, observation } = native;
  if (
    source.scope !== 'curated' ||
    source.route !== locator.route ||
    source.collectionId !== locator.collectionId ||
    source.accountId !== locator.ownerAccountId ||
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
