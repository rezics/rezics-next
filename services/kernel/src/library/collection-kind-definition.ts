/** Native definition operands only. Accounts and Semantic consume these before
 * producing audience closures and Type evidence; neither is an input here.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { commandTime } from '../command/command.ts';
import type { OperationalTransaction } from '../command/operational.ts';
import type { IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import { identityScopeAddress } from '../semantic/identity-scoped-observations.ts';
import {
  holdCommittedIdentityScopeReceipt,
  isHeldCommittedIdentityScopeReceipt,
  resolveCommittedIdentityScopeReceipt,
  type IdentityScopeCommittedLocator,
} from '../semantic/identity-scope-committed-receipt.ts';
import type { NativeCollectionWork } from './collection-native-work.ts';
import { COLLECTION_KIND_INPUT_TERMS, invokeCollectionKindInput } from './collection-kind-input-bounds.ts';
import {
  currentCollectionKindInputAdmission,
  type CollectionKindPreparationLocator,
  type CollectionKindWorkDefinition,
} from './collection-kind-work-admission.ts';
import readDefinition from './collection-kind-definition.sql';

type Row = NonNullable<(typeof readDefinition)['~reylo']['element']>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The native JSON codec stores bigint positions as decimal strings. This is
 * only a lookup operand; Semantic resolves its actual completion/receiving rows.
 */
function attempt(value: unknown): IdentityNativeReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.partition !== 'number' ||
    typeof receipt.epoch !== 'number' ||
    typeof receipt.transactionId !== 'string' ||
    typeof receipt.position !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(receipt.position)
  )
    return null;
  return {
    partition: receipt.partition,
    epoch: receipt.epoch,
    position: BigInt(receipt.position),
    transactionId: receipt.transactionId,
  };
}

function completion(row: Row): IdentityScopeCommittedLocator['completion'] | null {
  if (row.jobId === null) return row.scopeState === 'ready' ? { kind: 'initial' } : null;
  const native = attempt(row.attempt);
  if (
    !native ||
    row.jobEpoch === null ||
    row.directoryTransactionId === null ||
    row.pageId === null ||
    row.ordinal === null ||
    row.disposition !== 'unsafe'
  )
    return null;
  return {
    kind: 'repair',
    receiving: {
      job: { jobId: row.jobId, epoch: BigInt(row.jobEpoch) },
      directoryTransactionId: row.directoryTransactionId,
      pageId: row.pageId,
      ordinal: row.ordinal,
    },
    attempt: native,
  };
}

/** Every read borrows the admitted home. Returning releases no connection:
 * its caller must finish this transaction before any foreign IO and read again
 * in the final home, bound to the SAME original work and unchanged deadline.
 */
export async function readAdmittedCollectionKindDefinition(
  tx: OperationalTransaction,
  preparation: CollectionKindPreparationLocator,
  work: NativeCollectionWork,
): Promise<CollectionKindWorkDefinition | null> {
  const admitted = currentCollectionKindInputAdmission(tx, preparation, work);
  const time = commandTime(tx);
  if (!admitted?.committed || !time) return null;
  const { sourceIdentity: source, identityObservation, custody } = admitted;
  if (
    (source.scope !== 'curated' && source.scope !== 'private_builtin') ||
    identityObservation.captureId !== custody.captureId ||
    identityObservation.committedRevision <= 0n
  )
    return null;
  function current() {
    const now = currentCollectionKindInputAdmission(tx, preparation, work);
    return (
      !!now?.committed &&
      commandTime(tx) === time &&
      now.originId === admitted!.originId &&
      now.referenceId === admitted!.referenceId &&
      now.releaseDigest === admitted!.releaseDigest &&
      now.audience === admitted!.audience &&
      now.sourceFence === admitted!.sourceFence &&
      isDeepStrictEqual(now.sourceIdentity, source) &&
      isDeepStrictEqual(now.identityObservation, identityObservation) &&
      isDeepStrictEqual(now.custody, custody)
    );
  }
  const address = identityScopeAddress(identityObservation.key);
  const row = await invokeCollectionKindInput(work, COLLECTION_KIND_INPUT_TERMS().definition, () =>
    readDefinition.run(tx, {
      route: preparation.route,
      collection_id: preparation.collectionId,
      owner_account_id: preparation.ownerAccountId,
      partition_no: address.partition,
      source_key: address.source,
      scope_id: address.scope,
      capture_id: identityObservation.captureId,
      revision: identityObservation.committedRevision.toString(),
      source: identityObservation.key.source,
    }),
  );
  if (!row || !current()) return null;
  if (
    row.incarnation !== source.incarnation ||
    row.sourceGeneration !== source.generation ||
    row.ownerEpoch !== source.ownerEpoch ||
    (source.scope === 'curated'
      ? row.membershipKind !== 'curated'
      : row.membershipKind !== 'dynamic' || row.ruleSource === 'catalogue' || row.factGeneration === null)
  )
    return null;

  // The SAME native Source references used by canonical-source-store.observe
  // and nativeSourceFence. A definition does not require a completed canonical
  // population or Type vote. These structural hashes supply no receipt tuple.
  const authority =
    source.scope === 'curated'
      ? { kind: 'curated' as const }
      : { kind: 'private_builtin' as const, curatorAccountId: source.accountId };
  const sourceFence = hash([
    source.incarnation,
    source.ownerEpoch,
    source.scope,
    source.generation,
    source.scope === 'curated' ? null : row.factGeneration,
    null,
  ]);
  const components = {
    incarnation: source.incarnation,
    authority,
    sourceFence,
    identity: { digest: hash([identityObservation.captureId, identityObservation.committedRevision.toString()]) },
    meaning:
      source.scope === 'curated'
        ? null
        : hash([
            row.builtinKind,
            row.sourceRelease,
            row.profileId,
            row.stateSetId,
            row.stateId,
            ...(row.ruleReady ? [row.ruleRevision, row.ruleRelease] : []),
          ]),
    ...(source.scope === 'private_builtin' ? { originalCoverage: 'owner-facts-v2' as const } : {}),
  };
  if (sourceFence !== admitted.sourceFence) return null;
  const completed = completion(row);
  if (!completed) return null;
  const context = { kind: 'collection-kind' as const, tx, preparation, work, deadline: admitted.deadline };
  const resolved = await resolveCommittedIdentityScopeReceipt(admitted.pool, {
    locator: { expected: identityObservation, registration: row.registration, completion: completed },
    context,
  });
  if (resolved.status !== 'observed' || !current()) return null;
  const held = await holdCommittedIdentityScopeReceipt(tx, admitted.pool, { evidence: resolved.evidence, context });
  // Both Semantic receipts are cumulative on work. Never compose or debit them
  // again. Holding on every use includes the final Search read before adoption.
  if (held.status !== 'held' || !current() || !isHeldCommittedIdentityScopeReceipt(tx, held)) return null;
  work.assertReady();
  const profilePins = Object.freeze([
    ...new Set([...(row.sourceRelease ? [row.sourceRelease] : []), admitted.releaseDigest]),
  ]);
  return Object.freeze({
    releaseDigest: admitted.releaseDigest,
    audience: admitted.audience,
    sourceIdentity: source,
    observation: Object.freeze({
      route: preparation.route,
      collectionId: preparation.collectionId,
      sourceIdentity: source,
      incarnation: source.incarnation,
      revision: row.revision,
      authority: Object.freeze(authority),
      // This is the Source observation stamp, never the identity native receipt.
      stamp: Object.freeze({
        partition: address.partition,
        epoch: row.ownerEpoch,
        position: BigInt(row.partitionPosition),
      }),
      basis: Object.freeze({
        digest: hash(components),
        identity: Object.freeze(components.identity),
        query: components.meaning,
        profilePins,
        projection: null,
      }),
    }),
    identityObservation,
    repairReceipt: held.evidence.native,
    custody,
  });
}
