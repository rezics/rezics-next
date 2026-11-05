/** Current private working Source evidence for one already admitted publication episode. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { commandTime } from '../command/command.ts';
import { createIdentityScopedObservations, identityScopeAddress } from '../semantic/identity-scoped-observations.ts';
import type { IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { CanonicalBasis } from './canonical-source-store.ts';
import { nativeSourceFence } from './canonical-source-store.ts';
import type { CollectionPublicationEpisode } from './collection-publication-episode-contract.ts';
import type { SavedCollectionRule } from './collection-rules.ts';
import type { CollectionSourceObservation, WorkAllowance } from './collection-source.ts';
import { readNativeCollectionWorkingMetadata } from './collection-source-native.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceCustody,
  type NativeSourceIdentity,
} from './native-source-custody.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import { partitionOf } from '../route/route.ts';
import sourceQuery from './collection-publication-native-source.sql';

type NativeSourceEvidence = Readonly<{
  sourceIdentity: NativeSourceIdentity;
  observation: CollectionSourceObservation;
  identityObservation: IdentityScopeObservation;
  repairReceipt: IdentityNativeReceipt;
  custody: NativeSourceCustody;
}>;

type NativeRow = {
  identity: NativeSourceIdentity;
  frontier: { captureId: string; driver: string } | null;
  sourceCaptureId: string | null;
  sourceRevision: string | null;
  nativeCaptureId: string;
  nativeCollectionId: string;
  nativeAccountId: string;
  nativeIncarnation: string;
  nativeGeneration: string;
  nativeScope: string;
  nativeOwnerEpoch: number;
  nativeReceivingEpoch: string;
  nativeEffectKey: string;
  nativeDriver: string;
  nativeComplete: boolean;
  nativeCaptureTransactionId: string;
  nativeCaptureCommitted: boolean;
  repairTransactionId: string;
  repairEpoch: number;
  repairPosition: string;
  repairCommitted: boolean;
  identitySource: { kind: string; identity?: NativeSourceIdentity };
  holdId: string;
  identityCaptureId: string;
  identityState: string;
  identityRevision: string;
  identityActive: number;
  identityFrontier: { driver?: string } | null;
  identityScanComplete: boolean;
  canonicalGeneration: string;
  canonicalBasis: CanonicalBasis;
  canonicalState: string;
  canonicalExhausted: boolean;
  outputAccountId: string;
  outputSourceGeneration: string | null;
  outputExpectedMembers: string | null;
  outputMode: string | null;
  outputState: string | null;
  selectedGeneration: string | null;
};

const allowance = (): WorkAllowance => ({
  reservationId: 'collection-publication-current-source',
  remaining: {
    candidateKeys: 0,
    nativeRows: 4096,
    nativePoints: 32,
    statements: 32,
    emptySeeks: 32,
    witnessKeys: 0,
    identityMetadataRows: 16,
    bytes: 128 * 1024,
  },
});

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function sameRule(
  metadata: NonNullable<Awaited<ReturnType<typeof readNativeCollectionWorkingMetadata>>['metadata']>,
  rule: SavedCollectionRule,
  episode: CollectionPublicationEpisode,
) {
  const reference = episode.source.rule;
  return (
    metadata.state === 'active' &&
    metadata.authority === 'private_builtin' &&
    metadata.curatorAccountId === episode.source.locator.ownerAccountId &&
    metadata.incarnation === reference.incarnation &&
    metadata.revision === rule.collectionRevision &&
    metadata.sourceGeneration === rule.sourceGeneration &&
    metadata.factFence !== null &&
    rule.collectionRevision === reference.collectionRevision &&
    rule.sourceGeneration === reference.sourceGeneration &&
    rule.releaseDigest === reference.releaseDigest &&
    metadata.releaseDigest === reference.releaseDigest &&
    (reference.kind === 'saved'
      ? metadata.builtinKind === null &&
        metadata.ruleReady &&
        metadata.ruleRevision === String(reference.revision) &&
        metadata.ruleReleaseDigest === reference.releaseDigest &&
        rule.revision === reference.revision
      : metadata.builtinKind === reference.key.kind &&
        rule.revision === 0 &&
        (reference.key.kind !== 'state' ||
          (metadata.profileId === reference.key.profileId &&
            metadata.stateSetId === reference.key.stateSetId &&
            metadata.stateId === reference.key.stateId)))
  );
}

/**
 * Reads only current indexed native owner points from the same live Core client.
 * Capture/repair remains owned by the existing canonical and scoped-observation producers.
 */
export async function readCollectionPublicationNativeSource(
  tx: OperationalTransaction,
  input: Readonly<{
    pool: Pool;
    deadline: number;
    locator: CollectionPublicationEpisode['source']['locator'];
    episode: CollectionPublicationEpisode;
    rule: SavedCollectionRule;
  }>,
): Promise<NativeSourceEvidence | null> {
  if (!hasLiveOperationalTransaction(tx)) return null;
  const resources = currentOperationalResources(tx);
  const at = commandTime(tx);
  const current = () =>
    hasLiveOperationalTransaction(tx) &&
    currentOperationalResources(tx).pool === input.pool &&
    currentOperationalResources(tx).workClient === resources.workClient &&
    currentOperationalResources(tx).mode === 'work-step' &&
    currentOperationalResources(tx).partition === resources.partition &&
    currentOperationalResources(tx).accounts.length === 1 &&
    currentOperationalResources(tx).accounts[0] === input.locator.ownerAccountId &&
    currentOperationalResources(tx).deadline === input.deadline &&
    commandTime(tx) === at &&
    Date.now() < input.deadline;
  if (
    resources.pool !== input.pool ||
    resources.mode !== 'work-step' ||
    resources.partition !== partitionOf(input.locator.route) ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== input.locator.ownerAccountId ||
    resources.deadline !== input.deadline ||
    input.deadline <= Date.now() ||
    !at
  )
    return null;

  const { metadata } = await readNativeCollectionWorkingMetadata(
    input.pool,
    { route: input.locator.route, collectionId: input.locator.collectionId },
    { tx, deadline: input.deadline, allowance: allowance() },
  );
  if (!current() || !metadata || !sameRule(metadata, input.rule, input.episode)) return null;
  const identity = input.episode.source.input.identity;
  if (
    identity.scope !== 'private_builtin' ||
    identity.route !== metadata.route ||
    identity.collectionId !== metadata.collectionId ||
    identity.accountId !== metadata.curatorAccountId ||
    identity.incarnation !== metadata.incarnation ||
    identity.generation !== metadata.sourceGeneration ||
    identity.ownerEpoch !== metadata.stamp.epoch ||
    identity.effectKey !== `collection-source:${nativeSourceFence(metadata)}`
  )
    return null;

  let address: ReturnType<typeof identityScopeAddress>;
  try {
    address = identityScopeAddress({ source: { kind: 'library', identity }, scopeId: 'collection-source' });
  } catch {
    return null;
  }
  const values: Record<string, unknown> = {
    route: input.locator.route,
    collection_id: input.locator.collectionId,
    source_fence: nativeSourceFence(metadata),
    owner_account_id: input.locator.ownerAccountId,
    partition: address.partition,
    source_key: address.source,
    scope_id: address.scope,
    owner_epoch: identity.ownerEpoch,
    output_generation: input.episode.output.ref.generation,
    source_generation: identity.generation,
  };
  const rows = (
    await tx.query<NativeRow>(
      sourceQuery.sql,
      sourceQuery.params.map((name) => values[name]),
    )
  ).rows;
  const row = rows[0];
  if (
    !current() ||
    rows.length !== 1 ||
    !row ||
    !isDeepStrictEqual(row.identity, identity) ||
    row.sourceCaptureId === null ||
    row.sourceRevision === null ||
    !row.frontier ||
    row.frontier.driver !== 'done' ||
    row.frontier.captureId !== row.nativeCaptureId ||
    row.nativeCaptureId !== row.sourceCaptureId ||
    row.nativeCollectionId !== identity.collectionId ||
    row.nativeAccountId !== identity.accountId ||
    row.nativeIncarnation !== identity.incarnation ||
    row.nativeGeneration !== identity.generation ||
    row.nativeScope !== identity.scope ||
    row.nativeOwnerEpoch !== identity.ownerEpoch ||
    row.nativeReceivingEpoch !== identity.receivingEpoch ||
    row.nativeEffectKey !== identity.effectKey ||
    row.nativeDriver !== 'done' ||
    !row.nativeComplete ||
    !row.nativeCaptureCommitted ||
    !row.nativeCaptureTransactionId ||
    !row.repairCommitted ||
    row.repairEpoch !== identity.ownerEpoch ||
    !/^[1-9][0-9]{0,18}$/.test(row.repairPosition) ||
    !row.repairTransactionId ||
    row.identitySource.kind !== 'library' ||
    !isDeepStrictEqual(row.identitySource.identity, identity) ||
    row.identityCaptureId !== row.sourceCaptureId ||
    row.identityRevision !== row.sourceRevision ||
    row.identityState !== 'ready' ||
    row.identityActive !== 0 ||
    !row.identityScanComplete ||
    row.identityFrontier?.driver !== 'done' ||
    !/^(0|[1-9][0-9]*)$/.test(row.identityRevision) ||
    row.canonicalState !== 'complete' ||
    !row.canonicalExhausted ||
    row.outputAccountId !== input.locator.ownerAccountId ||
    row.outputSourceGeneration !== identity.generation ||
    row.outputExpectedMembers !== null ||
    row.outputMode !== 'whole_query' ||
    row.outputState !== 'building' ||
    row.canonicalGeneration.length === 0 ||
    row.selectedGeneration !== (input.episode.selected?.ref.generation ?? null)
  )
    return null;

  const identityObservation: IdentityScopeObservation = {
    key: { source: { kind: 'library', identity }, scopeId: 'collection-source' },
    captureId: row.identityCaptureId,
    committedRevision: BigInt(row.sourceRevision),
  };
  const identityCurrent = await createIdentityScopedObservations(input.pool).revalidate({
    key: identityObservation.key,
    expected: identityObservation,
    tx,
    deadline: input.deadline,
  });
  if (
    !current() ||
    identityCurrent.status !== 'current' ||
    !isDeepStrictEqual(identityCurrent.observation, identityObservation)
  )
    return null;
  const identityDigest = hash([identityObservation.captureId, identityObservation.committedRevision.toString()]);
  const meaning = hash([
    metadata.builtinKind,
    metadata.releaseDigest,
    metadata.profileId,
    metadata.stateSetId,
    metadata.stateId,
    ...(metadata.ruleReady ? [metadata.ruleRevision, metadata.ruleReleaseDigest] : []),
  ]);
  const authority = { kind: 'private_builtin' as const, curatorAccountId: metadata.curatorAccountId };
  const components = {
    incarnation: metadata.incarnation,
    authority,
    sourceFence: nativeSourceFence(metadata),
    identity: { digest: identityDigest },
    meaning,
    ...(metadata.builtinKind === 'state' ? { originalCoverage: 'owner-facts-v1' as const } : {}),
  };
  const expectedBasis: CanonicalBasis = { ...components, digest: hash(components) };
  if (!isDeepStrictEqual(row.canonicalBasis, expectedBasis)) return null;

  const observation: CollectionSourceObservation = {
    route: metadata.route,
    collectionId: metadata.collectionId,
    incarnation: metadata.incarnation,
    revision: metadata.revision,
    authority,
    // The retained native proof is stable across operational checkpoints and the seal
    // advancing the partition head. Current source/fact/identity fences are checked above.
    stamp: { ...metadata.stamp, position: BigInt(row.repairPosition) },
    basis: {
      digest: row.canonicalBasis.digest,
      identity: row.canonicalBasis.identity,
      query: row.canonicalBasis.meaning,
      profilePins: metadata.releaseDigest ? [metadata.releaseDigest] : [],
      projection: null,
    },
  };
  const repairReceipt: IdentityNativeReceipt = {
    partition: address.partition,
    epoch: row.repairEpoch,
    position: BigInt(row.repairPosition),
    transactionId: row.repairTransactionId,
  };
  const retained = await createNativeLibrarySourceCustody({ pool: input.pool }).revalidateHold({
    client: tx,
    at,
    identity,
    captureId: row.nativeCaptureId,
    holdId: row.holdId,
    allowance: allowance(),
    deadline: input.deadline,
  });
  if (
    !current() ||
    retained.status !== 'held' ||
    !isDeepStrictEqual(retained.custody.identity, identity) ||
    retained.custody.captureId !== identityObservation.captureId ||
    retained.custody.holdId !== row.holdId ||
    retained.custody.transactionId !== row.nativeCaptureTransactionId ||
    !hasLiveOperationalTransaction(tx) ||
    currentOperationalResources(tx).pool !== input.pool ||
    commandTime(tx) !== at
  )
    return null;
  return {
    sourceIdentity: identity,
    observation,
    identityObservation,
    repairReceipt,
    custody: retained.custody,
  };
}
