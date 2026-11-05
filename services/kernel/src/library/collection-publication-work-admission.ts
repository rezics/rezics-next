/** SERVER ONLY. Original Library whole-query publication seam, distinct from Members and Kind. */
import type { FilterDocument, FilterRelease } from '@rezics/filter';
import { admitFilter, parseFilter } from '@rezics/filter';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fenceOperationalAccount } from '../access/account-share.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { authoritativeTimeValue, commandTime } from '../command/command.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import { readRelease } from '../semantic/definitions.ts';
import {
  readCollectionPublicationEpisode,
  readCollectionPublicationInitiator,
  readCollectionPublicationRule,
} from './collection-publication-episodes.ts';
import { readCollectionPublicationNativeSource } from './collection-publication-native-source.ts';
import type { IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type {
  CollectionPublicationCreation,
  CollectionPublicationInputRef,
  CollectionPublicationPhase,
  CollectionPublicationRuleRef,
  CollectionPublicationTargetRef,
} from './collection-publication-episode-contract.ts';
import type { CollectionSourceObservation } from './collection-source.ts';
import type { NativeSourceCustody, NativeSourceIdentity } from './native-source-custody.ts';

/** Exact native lookup fields only. Possession grants neither admission nor final command authority. */
export type CollectionPublicationLocator = Readonly<{
  route: number;
  ownerAccountId: string;
  collectionId: string;
  publicationId: string;
}>;

/** Actual expanded, pinned whole-query meaning read from native state, never request JSON.
 * This transient result is not a second retained AST on an episode or work payload.
 */
export type CollectionPublicationDefinition = Readonly<{
  filter: FilterDocument;
  sort: 'id';
  release: Readonly<{ digest: string; value: FilterRelease }>;
}>;

/** Data on the SAME live Core client after independent native admission, not a completion receipt.
 * input and target MUST name the SAME actual Collection explicitly; input remains private working
 * Source even while target serves selected A. output names pending native B, never a borrowed A.
 * Compare the WHOLE result again after foreign staging and before settling progress.
 */
export type CollectionPublicationWorkDefinition = Readonly<{
  locator: CollectionPublicationLocator;
  definition: CollectionPublicationDefinition;
  input: CollectionPublicationInputRef;
  target: CollectionPublicationTargetRef;
  rule: CollectionPublicationRuleRef;
  creation: CollectionPublicationCreation;
  sourceIdentity: NativeSourceIdentity;
  observation: CollectionSourceObservation;
  identityObservation: IdentityScopeObservation;
  repairReceipt: IdentityNativeReceipt;
  custody: NativeSourceCustody;
  releaseDigest: string;
  audience: string;
}> &
  Extract<CollectionPublicationPhase, { phase: 'staging' | 'awaiting_activation' }>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const locatorKeys = ['route', 'ownerAccountId', 'collectionId', 'publicationId'] as const;

/** Reject accessors and extra properties before reading locator values from the native boundary. */
function exactLocator(value: unknown): value is CollectionPublicationLocator {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length !== locatorKeys.length ||
      locatorKeys.some((key) => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]!))
    )
      return false;
    const route = descriptors.route!.value;
    const ownerAccountId = descriptors.ownerAccountId!.value;
    const collectionId = descriptors.collectionId!.value;
    const publicationId = descriptors.publicationId!.value;
    return (
      typeof route === 'number' &&
      Number.isSafeInteger(route) &&
      typeof collectionId === 'string' &&
      typeof ownerAccountId === 'string' &&
      typeof publicationId === 'string' &&
      routeOf(collectionId) === route &&
      routeOf(ownerAccountId) === route &&
      routeOf(publicationId) === route &&
      uuid.test(collectionId) &&
      uuid.test(ownerAccountId) &&
      uuid.test(publicationId)
    );
  } catch {
    return false;
  }
}

/** Core executor and exact owner namespace checks only; native episode admission follows. */
function livePublicationNamespace(
  tx: OperationalTransaction,
  locator: unknown,
): locator is CollectionPublicationLocator {
  if (!hasLiveOperationalTransaction(tx)) return false;
  const resources = currentOperationalResources(tx);
  if (!exactLocator(locator)) return false;
  const ownerRoute = routeOf(locator.ownerAccountId);
  if (
    resources.mode !== 'work-step' ||
    routeOf(locator.collectionId) !== locator.route ||
    ownerRoute === null ||
    resources.partition !== partitionOf(locator.route) ||
    resources.partition !== partitionOf(ownerRoute) ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== locator.ownerAccountId ||
    resources.pool === undefined ||
    !Number.isFinite(resources.deadline) ||
    Date.now() >= resources.deadline
  )
    return false;
  const time = commandTime(tx);
  if (!time) return false;
  authoritativeTimeValue(time);
  return true;
}

function digest(value: unknown): string | null {
  const bytes = canonicalize(value);
  return bytes === undefined ? null : createHash('sha256').update(bytes).digest('hex');
}

async function currentPublicationInput(tx: OperationalTransaction, locator: CollectionPublicationLocator) {
  if (!livePublicationNamespace(tx, locator)) return null;
  const resources = currentOperationalResources(tx);
  const at = commandTime(tx);
  if (!at) return null;
  authoritativeTimeValue(at);
  const current = () =>
    hasLiveOperationalTransaction(tx) &&
    currentOperationalResources(tx).pool === resources.pool &&
    currentOperationalResources(tx).workClient === resources.workClient &&
    currentOperationalResources(tx).deadline === resources.deadline &&
    currentOperationalResources(tx).partition === resources.partition &&
    currentOperationalResources(tx).accounts.length === 1 &&
    currentOperationalResources(tx).accounts[0] === locator.ownerAccountId &&
    currentOperationalResources(tx).mode === 'work-step' &&
    commandTime(tx) === at &&
    Date.now() < resources.deadline;

  try {
    await fenceOperationalAccount(tx, locator.ownerAccountId);
  } catch (error) {
    if (error instanceof LifecycleDeniedError) return null;
    throw error;
  }
  if (!current()) return null;

  // The real episode reader independently resolves immutable operation, source, and exact creation receipt.
  const episode = await readCollectionPublicationEpisode(tx, locator);
  if (
    !episode ||
    (episode.phase !== 'staging' && episode.phase !== 'awaiting_activation') ||
    !isDeepStrictEqual(episode.source.locator, locator) ||
    episode.source.input.kind !== 'private_working_source' ||
    episode.source.input.identity.scope !== 'private_builtin' ||
    episode.source.input.identity.route !== locator.route ||
    episode.source.input.identity.collectionId !== locator.collectionId ||
    episode.source.input.identity.accountId !== locator.ownerAccountId ||
    episode.source.target.kind !== 'collection_output' ||
    episode.source.target.route !== locator.route ||
    episode.source.target.collectionId !== locator.collectionId ||
    (episode.source.target.visibility !== 'public' && episode.source.target.visibility !== 'unlisted') ||
    !isDeepStrictEqual(episode.source.output, episode.output.ref) ||
    episode.output.state !== 'building' ||
    episode.output.ref.route !== locator.route ||
    episode.output.ref.collectionId !== locator.collectionId ||
    episode.output.ref.generation === episode.selected?.ref.generation
  )
    return null;
  const original = await readCollectionPublicationInitiator(tx, episode.initiator.operation, at);
  if (
    !original ||
    !isDeepStrictEqual(original, episode.initiator) ||
    original.operation.id !== locator.publicationId ||
    original.operation.route !== locator.route ||
    original.initiatorAccountId !== locator.ownerAccountId ||
    original.actor.kind !== 'account' ||
    original.actor.accountId !== locator.ownerAccountId ||
    original.sourceDigest !== digest(episode.source) ||
    episode.durableInitiator !== durableInitiatorCommitment(original)
  )
    return null;
  if (!current()) return null;

  const rule = await readCollectionPublicationRule(tx, locator);
  const ruleRef = episode.source.rule;
  if (
    !rule ||
    (ruleRef.kind === 'saved' ? rule.revision !== ruleRef.revision : rule.revision !== 0) ||
    rule.collectionRevision !== ruleRef.collectionRevision ||
    rule.sourceGeneration !== ruleRef.sourceGeneration ||
    rule.releaseDigest !== ruleRef.releaseDigest ||
    digest({ filter: rule.filter, sort: rule.sort, releaseDigest: rule.releaseDigest }) !== ruleRef.digest
  )
    return null;

  const release = await readRelease(tx, rule.releaseDigest);
  if (!release || !current()) return null;
  let expanded: FilterDocument;
  try {
    expanded = admitFilter(parseFilter(rule.filter), release, { owner: true });
  } catch {
    return null;
  }
  if (!isDeepStrictEqual(expanded, rule.filter)) return null;

  const definition: CollectionPublicationDefinition = {
    filter: expanded,
    sort: 'id',
    release: { digest: rule.releaseDigest, value: release as FilterRelease },
  };
  if (!current()) return null;
  return { episode, rule, definition };
}

/** Preparation may advance only an original committed episode, before any private Source IO. */
export async function admitCollectionPublicationSourcePreparation(
  tx: OperationalTransaction,
  locator: CollectionPublicationLocator,
): Promise<boolean> {
  return (await currentPublicationInput(tx, locator)) !== null;
}

async function currentPublicationWork(
  tx: OperationalTransaction,
  locator: CollectionPublicationLocator,
): Promise<CollectionPublicationWorkDefinition | null> {
  const input = await currentPublicationInput(tx, locator);
  if (!input) return null;
  const { episode, rule, definition } = input;
  const resources = currentOperationalResources(tx);
  const native = await readCollectionPublicationNativeSource(tx, {
    pool: resources.pool,
    deadline: resources.deadline,
    locator,
    episode,
    rule,
  });
  if (!native || !livePublicationNamespace(tx, locator)) return null;
  const ruleRef = episode.source.rule;
  return {
    locator: Object.freeze({ ...locator }),
    definition,
    input: episode.source.input,
    target: episode.source.target,
    rule: ruleRef,
    creation: {
      source: episode.source,
      initiator: episode.initiator,
      durableInitiator: episode.durableInitiator,
    },
    sourceIdentity: native.sourceIdentity,
    observation: native.observation,
    identityObservation: native.identityObservation,
    repairReceipt: native.repairReceipt,
    custody: native.custody,
    releaseDigest: rule.releaseDigest,
    audience: `collection-publication:${locator.publicationId}`,
    phase: episode.phase,
    output: episode.output,
    selected: episode.selected,
  };
}

/** Getter data alone is never admission or completion. Recheck the SAME native client on each use.
 * Missing original provenance is unavailable, never ready-empty. Source initialization cannot
 * start from a bare locator while its owning episode reader is absent.
 */
export async function readCollectionPublicationWorkDefinition(
  tx: OperationalTransaction,
  locator: CollectionPublicationLocator,
): Promise<CollectionPublicationWorkDefinition | null> {
  if (!livePublicationNamespace(tx, locator)) return null;
  return currentPublicationWork(tx, locator);
}

/** Mechanical admission only. The result is never viewer permission or final activation authority. */
export async function admitCollectionPublicationStep(
  tx: OperationalTransaction,
  locator: CollectionPublicationLocator,
): Promise<boolean> {
  if (!livePublicationNamespace(tx, locator)) return false;
  return (await currentPublicationWork(tx, locator)) !== null;
}
