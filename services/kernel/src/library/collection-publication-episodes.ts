/** Native whole-query operation storage. All exported readers return data, never authority. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { commandAccessContext } from '../access/command-admission.ts';
import { captureDurableInitiator, durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import type {
  DurableInitiatorReader,
  DurableInitiatorRecord,
  DurableOperationAnchor,
} from '../access/durable-initiator.ts';
import { shareAccount } from '../access/account-share.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  currentCommandReceipt,
  IdempotencyConflictError,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { hasLiveOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import erasureScope from './erasure-scope.sql';
import { admitCollectionPublicationStep } from './collection-publication-work-admission.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import { encodeRoles } from '../history/contracts.ts';
import { commandHistoryIdentityAccounts, unionHistoryScope } from '../history/record.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type AccountActor, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { stageHistoryWork } from '../work/history-enqueue.ts';
import { initializeCanonicalCollectionSource, nativeSourceFence } from './canonical-source-store.ts';
import { prepareBuiltinMaterialization, readBuiltinPublicationRule } from './builtin-materialization.ts';
import type { BuiltinCollectionKey } from './builtin-identity.ts';
import { readCollection } from './collection-store.ts';
import type { Collection } from './collection-model.ts';
import { readNativeCollectionWorkingMetadata } from './collection-source-native.ts';
import {
  authorizeCollectionRule,
  prepareCollectionRuleAuthority,
  readSavedCollectionRule,
  type SavedCollectionRule,
} from './collection-rules.ts';
import { admitSavedCollectionMemberQuery, prepareNativeCollectionMemberAuthority } from './owner-filter.ts';
import type {
  CollectionPublicationBeginInput,
  CollectionPublicationCreation,
  CollectionPublicationEpisode,
  CollectionPublicationSource,
  CollectionPublicationRuleRef,
} from './collection-publication-episode-contract.ts';
import type { CollectionPublicationLocator } from './collection-publication-work-admission.ts';
import type { CollectionOutputPublication } from './collection-source-output.ts';
import type { WorkAllowance } from './collection-source.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';
import headQuery from './collection-source-output-head.sql';
import operationQuery from './collection-publication-episode-read.sql';
import receiptQuery from './collection-publication-episode-receipt.sql';

export const COLLECTION_PUBLICATION_COMMAND = 'library.collection.publication.begin';
export const COLLECTION_PUBLICATION_WORKFLOW = 'library.collectionPublication';
type Client = Pick<PoolClient, 'query'>;
export type CollectionPublicationBeginResult = Readonly<{
  locator: CollectionPublicationLocator;
  durableInitiator: string;
  collection?: Collection;
}>;
/** Server-owned saved creation joins the ordinary Publication command, never a second transaction. */
export type SavedPublicationCreation = Readonly<{
  input: unknown;
  rule: SavedCollectionRule;
  authorization: CommandAuthorization;
  materialize(tx: CommandTransaction): Promise<Collection>;
}>;
export type CollectionPublicationEpisodes = Readonly<{
  begin(
    actor: Actor,
    input: CollectionPublicationBeginInput,
    requestKey: string,
    creation?: SavedPublicationCreation,
  ): Promise<CommandOutcome<CollectionPublicationBeginResult>>;
}>;
export type CollectionPublicationEpisodeReader = (
  client: Client,
  locator: CollectionPublicationLocator,
) => Promise<CollectionPublicationEpisode | null>;
const unavailable = () => new ProblemError('dependency_unavailable');
const conflict = () => new ProblemError('conflict');
const canonical = (value: unknown): string => {
  const bytes = canonicalize(value);
  if (bytes === undefined) throw new TypeError('Noncanonical publication data');
  return bytes;
};
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function locatorValid(locator: CollectionPublicationLocator) {
  return (
    routeOf(locator.collectionId) === locator.route &&
    routeOf(locator.publicationId) === locator.route &&
    routeOf(locator.ownerAccountId) === locator.route
  );
}
function privateWorkingIdentity(
  identity: NativeSourceIdentity,
): identity is CollectionPublicationSource['input']['identity'] {
  return identity.scope === 'private_builtin';
}
function sourceValid(source: CollectionPublicationSource, record: DurableInitiatorRecord) {
  const { locator, input, target, output, rule } = source;
  return (
    locatorValid(locator) &&
    record.operation.route === locator.route &&
    record.operation.id === locator.publicationId &&
    record.operation.kind === COLLECTION_PUBLICATION_COMMAND &&
    record.creation.commandKind === COLLECTION_PUBLICATION_COMMAND &&
    routeOf(record.operation.sourceId) === locator.route &&
    routeOf(record.recordedTransactionId) !== null &&
    record.initiatorAccountId === locator.ownerAccountId &&
    record.actor.kind === 'account' &&
    record.actor.accountId === record.initiatorAccountId &&
    input.kind === 'private_working_source' &&
    input.identity.scope === 'private_builtin' &&
    input.identity.route === locator.route &&
    input.identity.collectionId === locator.collectionId &&
    input.identity.accountId === locator.ownerAccountId &&
    input.identity.incarnation === rule.incarnation &&
    input.identity.generation === rule.sourceGeneration &&
    target.kind === 'collection_output' &&
    target.route === locator.route &&
    target.collectionId === locator.collectionId &&
    (target.visibility === 'public' || target.visibility === 'unlisted') &&
    record.creation.target.route === target.route &&
    record.creation.target.id === target.collectionId &&
    output.route === target.route &&
    output.collectionId === target.collectionId &&
    routeOf(output.generation) === locator.route
  );
}
function exact(value: object, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function allowlisted(record: DurableInitiatorRecord) {
  return (
    exact(record, [
      'operation',
      'initiatorAccountId',
      'actor',
      'recordedTransactionId',
      'sourceDigest',
      'originalDelegation',
      'originalAccount',
      'creation',
    ]) &&
    exact(record.operation, ['route', 'id', 'kind', 'sourceId']) &&
    exact(record.actor, ['kind', 'accountId', 'clientId', 'scopes', 'requestedBy', 'authnEpoch']) &&
    exact(record.originalAccount, ['minimumAuthnEpoch', 'operatorAccountId']) &&
    (record.originalDelegation === null || exact(record.originalDelegation, ['transactionId', 'issuedValid'])) &&
    exact(record.creation, ['commandKind', 'idempotencyKey', 'requestDigest', 'target']) &&
    exact(record.creation.target, ['route', 'id'])
  );
}
type Loaded = {
  creation: CollectionPublicationCreation;
  phase: 'staging' | 'awaiting_activation' | 'refused' | 'complete';
  version: string;
};
/** The owning header mutation already holds its ordinary Collection write lock. Retire only the
 * single pending episode (the native partial unique index enforces that bound). Immutable creation,
 * output, staging and custody rows remain available to their existing retention/disposition owners.
 * Cancel the exact pending output so its unique building slot can admit the next explicit publish.
 * Refusal is final: neither a receipt replay nor a late phase CAS can make this episode pending again.
 */
export async function retireCollectionPublicationWork(tx: CommandTransaction, route: number, collectionId: string) {
  await tx.query(
    `WITH retired AS (
       UPDATE library.collection_publication_episode SET phase='refused',version=version+1
       WHERE route=$1 AND collection_id=$2 AND phase IN ('staging','awaiting_activation')
       RETURNING route,collection_id,source_id,publication_id
     )
     UPDATE library.collection_source_output g SET state='cancelled'
     FROM retired e JOIN library.collection_publication_source s
       ON (s.route,s.source_id,s.publication_id)=(e.route,e.source_id,e.publication_id)
     WHERE (g.route,g.collection_id)=(e.route,e.collection_id)
       AND g.generation=(s.bytes::jsonb->'output'->>'generation')::uuid AND g.state='building'`,
    [route, collectionId],
  );
}
/** Exact immutable operation/source point, followed by its exact receipt PK. No history fallback. */
async function load(client: Client, operation: DurableOperationAnchor): Promise<Loaded | null> {
  if (
    operation.kind !== COLLECTION_PUBLICATION_COMMAND ||
    routeOf(operation.id) !== operation.route ||
    routeOf(operation.sourceId) !== operation.route
  )
    return null;
  const row = (
    await client.query<{
      owner: string;
      collection: string;
      sourceId: string;
      transactionId: string;
      sourceTransaction: string;
      sourceOperation: string;
      sourceBytes: string;
      record: DurableInitiatorRecord;
      phase: Loaded['phase'];
      version: string;
      commitment: string;
      sourceDigest: string;
      storageKey: string;
    }>(operationQuery.sql, [operation.route, operation.id, operation.sourceId])
  ).rows[0];
  if (!row) return null;
  // Decode only our native immutable bytes. Collected/malformed evidence cannot be rebuilt from current state.
  let source: CollectionPublicationSource;
  try {
    source = JSON.parse(row.sourceBytes);
    if (
      canonical(source) !== row.sourceBytes ||
      !allowlisted(row.record) ||
      !isDeepStrictEqual(row.record.operation, operation) ||
      !sourceValid(source, row.record) ||
      row.owner !== source.locator.ownerAccountId ||
      row.collection !== source.locator.collectionId ||
      row.sourceId !== operation.sourceId ||
      row.sourceOperation !== operation.id ||
      row.transactionId !== row.sourceTransaction ||
      row.record.recordedTransactionId !== row.transactionId ||
      hash(source) !== row.record.sourceDigest ||
      row.sourceDigest !== row.record.sourceDigest ||
      durableInitiatorCommitment(row.record) !== row.commitment
    )
      return null;
  } catch {
    return null;
  }
  const record = row.record;
  const keys = nativeReceiptKeyCandidates(
    client,
    record.creation.commandKind,
    record.initiatorAccountId,
    record.creation.idempotencyKey,
  );
  const receipt = (
    await client.query<{
      transactionId: string;
      digest: string;
      commitment: string | null;
      storageKey: string;
    }>(receiptQuery.sql, [
      partitionOf(operation.route),
      record.initiatorAccountId,
      record.creation.commandKind,
      keys,
      row.storageKey,
    ])
  ).rows[0];
  if (
    !receipt ||
    receipt.transactionId !== record.recordedTransactionId ||
    receipt.digest !== record.creation.requestDigest ||
    receipt.commitment !== row.commitment ||
    receipt.storageKey !== row.storageKey
  )
    return null;
  return {
    creation: { source, initiator: structuredClone(record), durableInitiator: row.commitment },
    phase: row.phase,
    version: row.version,
  };
}
/** Original native reader. Common Accounts restoration independently repeats receipt/commitment and current identity checks. */
export const readCollectionPublicationInitiator: DurableInitiatorReader = async (client, operation, time) => {
  authoritativeTimeValue(time);
  return (await load(client, operation))?.creation.initiator ?? null;
};
async function loadLocator(client: Client, locator: CollectionPublicationLocator) {
  if (!locatorValid(locator)) return null;
  const row = (
    await client.query<{ sourceId: string }>(
      `SELECT source_id::text AS "sourceId" FROM library.collection_publication_episode
     WHERE route=$1 AND publication_id=$2 AND owner_account_id=$3 AND collection_id=$4`,
      [locator.route, locator.publicationId, locator.ownerAccountId, locator.collectionId],
    )
  ).rows[0];
  return row
    ? load(client, {
        route: locator.route,
        id: locator.publicationId,
        kind: COLLECTION_PUBLICATION_COMMAND,
        sourceId: row.sourceId,
      })
    : null;
}
async function selected(client: Client, locator: CollectionPublicationLocator) {
  const collection = (
    await client.query<{ generation: string }>(
      'SELECT source_generation::text AS generation FROM library.collection WHERE route=$1 AND collection_id=$2',
      [locator.route, locator.collectionId],
    )
  ).rows[0];
  if (!collection) return null;
  const publication = (
    await client.query<CollectionOutputPublication>(headQuery.sql, [
      locator.route,
      locator.collectionId,
      collection.generation,
    ])
  ).rows[0];
  return publication
    ? {
        state: 'complete' as const,
        ref: { route: locator.route, collectionId: locator.collectionId, generation: publication.generation },
        publication,
      }
    : null;
}
/** Data only. Pending/refused B and selected complete A always have separate native references. */
export const readCollectionPublicationEpisode: CollectionPublicationEpisodeReader = async (client, locator) => {
  const loaded = await loadLocator(client, locator);
  if (!loaded) return null;
  const { creation, phase } = loaded;
  const output = (
    await client.query<{ state: 'building' | 'complete' | 'cancelled'; sourceGeneration: string }>(
      `SELECT state,source_generation::text AS "sourceGeneration" FROM library.collection_source_output
     WHERE route=$1 AND collection_id=$2 AND generation=$3`,
      [locator.route, locator.collectionId, creation.source.output.generation],
    )
  ).rows[0];
  if (!output || output.sourceGeneration !== creation.source.rule.sourceGeneration) return null;
  const a = await selected(client, locator);
  if (phase === 'complete') {
    if (!a || output.state !== 'complete' || !isDeepStrictEqual(a.ref, creation.source.output)) return null;
    return { ...creation, phase, output: a, selected: a };
  }
  if (phase === 'refused' && output.state !== 'complete')
    return { ...creation, phase, output: { state: output.state, ref: creation.source.output }, selected: a };
  if ((phase === 'staging' || phase === 'awaiting_activation') && output.state === 'building')
    return { ...creation, phase, output: { state: 'building', ref: creation.source.output }, selected: a };
  return null;
};

/** Current pinned meaning only, on the caller's SAME client. No re-admission at a later release/head. */
export async function readCollectionPublicationRule(
  client: Client,
  locator: CollectionPublicationLocator,
): Promise<SavedCollectionRule | null> {
  const loaded = await loadLocator(client, locator);
  if (!loaded) return null;
  const meaning = await readCurrentMeaning(client, locator.route, locator.collectionId);
  const saved = meaning?.rule;
  const ref = loaded.creation.source.rule;
  // Only the actual selected native publication permits its own final command's fence increment on replay.
  const complete =
    loaded.phase === 'complete' && (await readCollectionPublicationEpisode(client, locator))?.phase === 'complete';
  const collection = await readCollection(client, locator.route, locator.collectionId);
  const incarnation = (
    await client.query<{ incarnation: string }>(
      "SELECT collection_id::text || ':' || extract(epoch FROM created_at)::text AS incarnation FROM library.collection WHERE route=$1 AND collection_id=$2",
      [locator.route, locator.collectionId],
    )
  ).rows[0]?.incarnation;
  if (
    !collection ||
    collection.state !== 'active' ||
    collection.curatorAccountId !== locator.ownerAccountId ||
    incarnation !== ref.incarnation ||
    !saved ||
    (ref.kind === 'saved'
      ? meaning?.key !== null || saved.revision !== ref.revision
      : !isDeepStrictEqual(meaning?.key, ref.key)) ||
    saved.collectionRevision !== ref.collectionRevision + (complete ? 1 : 0) ||
    saved.sourceGeneration !== (BigInt(ref.sourceGeneration) + (complete ? 1n : 0n)).toString() ||
    saved.releaseDigest !== ref.releaseDigest ||
    hash({ filter: saved.filter, sort: saved.sort, releaseDigest: saved.releaseDigest }) !== ref.digest
  )
    return null;
  return saved;
}

type Meaning = Readonly<{ rule: SavedCollectionRule; key: Exclude<BuiltinCollectionKey, { kind: 'liked' }> | null }>;
async function readCurrentMeaning(client: Client, route: number, collectionId: string): Promise<Meaning | null> {
  const saved = await readSavedCollectionRule(client, route, collectionId);
  if (saved) return { rule: saved, key: null };
  const builtin = await readBuiltinPublicationRule(client, route, collectionId);
  return builtin ? { rule: builtin.rule, key: builtin.key } : null;
}

function metadataAllowance(): WorkAllowance {
  // Fixed metadata read only: no candidate/exhaustion budget or private fact hydration.
  return {
    reservationId: 'collection-publication-metadata',
    remaining: {
      candidateKeys: 0,
      nativeRows: 4096,
      nativePoints: 32,
      statements: 32,
      emptySeeks: 32,
      witnessKeys: 0,
      identityMetadataRows: 0,
      bytes: 128 * 1024,
    },
  };
}
/** Ordinary authenticated collection:update, including fresh admission BEFORE receipt lookup on every replay. */
export function createCollectionPublicationEpisodes(config: {
  pool: Pool;
  access: Access;
  clock?: KernelClock;
}): CollectionPublicationEpisodes {
  const { pool, access } = config;
  return {
    async begin(actor, request, requestKey, creation) {
      const input = structuredClone(request);
      if (
        actor.kind !== 'account' ||
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        !exact(input, ['collectionId', 'revision', 'visibility']) ||
        !Number.isSafeInteger(input.revision) ||
        input.revision < 0 ||
        typeof requestKey !== 'string' ||
        !/^[\x21-\x7e]{1,255}$/.test(requestKey) ||
        (input.visibility !== 'public' && input.visibility !== 'unlisted')
      )
        throw new ProblemError('invalid_request');
      const route = routeOf(input.collectionId);
      if (route === null || routeOf(actor.accountId) !== route) throw new GrantDeniedError();
      if (!actor.scopes.includes('collection:read') || (creation && !actor.scopes.includes('collection:update')))
        throw new GrantDeniedError();
      const identity = principalCommandIdentity(actor),
        deadline = deadlineFor(30000);
      const requestDigest = createHash('sha256')
        .update(canonical([identity, COLLECTION_PUBLICATION_COMMAND, creation ? { create: creation.input } : input]))
        .digest();
      const resource = { route, id: input.collectionId };
      const materialization = creation
        ? { ...creation, key: null }
        : await prepareBuiltinMaterialization(config, actor, input, deadline);
      const ordinary =
        materialization?.authorization ??
        resourceAuthorization({
          access,
          actor,
          action: 'collection:update',
          anchor: {
            resource,
            async validate(client) {
              const row = await readCollection(client, route, input.collectionId);
              return (
                row?.state === 'active' && row.curatorAccountId === actor.accountId && row.membershipKind === 'dynamic'
              );
            },
          },
          context: { pool, deadline, partition: partitionOf(route) },
        });
      const authorization: CommandAuthorization = {
        ...ordinary,
        async prepare(attempt) {
          const proof = await ordinary.prepare!(attempt);
          const meaning: Meaning | null = materialization
            ? { rule: materialization.rule, key: materialization.key }
            : await readCurrentMeaning(deadlineClient(pool, deadline), route, input.collectionId);
          if (!meaning) throw unavailable();
          const saved = meaning.rule;
          const admission = await admitSavedCollectionMemberQuery(
            { ...config, clock: () => new Date(authoritativeTimeValue(attempt.time)) },
            actor,
            saved,
            {},
            deadline,
          );
          const checks = [
            ...(await prepareCollectionRuleAuthority(config, actor, saved.filter, attempt, deadline)),
            ...(await prepareNativeCollectionMemberAuthority(
              config,
              actor,
              admission,
              attempt.time,
              deadline,
              attempt,
            )),
            ...(materialization
              ? []
              : [
                  await accessCheck(
                    access,
                    actor,
                    'collection:read',
                    resource,
                    commandAccessContext({ pool, deadline }, attempt),
                  ),
                ]),
          ];
          const capture = await captureDurableInitiator(commandAccessContext({ pool, deadline }, attempt), actor);
          const metadata = materialization
            ? null
            : (
                await readNativeCollectionWorkingMetadata(
                  pool,
                  { route, collectionId: input.collectionId },
                  { deadline, allowance: metadataAllowance() },
                )
              ).metadata;
          if (
            !materialization &&
            (!metadata ||
              metadata.authority !== 'private_builtin' ||
              metadata.curatorAccountId !== actor.accountId ||
              metadata.sourceGeneration !== saved.sourceGeneration ||
              metadata.revision !== saved.collectionRevision)
          )
            throw unavailable();
          return {
            proof,
            meaning,
            saved,
            checks,
            capture,
            metadata,
            actorSnapshot: {
              kind: 'account' as const,
              accountId: actor.accountId,
              clientId: actor.clientId,
              requestedBy: actor.requestedBy,
              authnEpoch: actor.authnEpoch,
              scopes: [...actor.scopes],
            },
          };
        },
        async authorize(tx, attempt, evidence) {
          const prepared = evidence as Prepared;
          // Evidence is produced only by the above prepare for this ordinary native attempt.
          const mode = await ordinary.authorize(tx, attempt, prepared.proof);
          await authorizeCollectionRule(tx, attempt, prepared.checks);
          await shareAccount(tx, actor.accountId);
          const prior = (
            await tx.query<{ sourceId: string; publicationId: string }>(
              `SELECT source_id::text AS "sourceId",publication_id::text AS "publicationId"
           FROM library.collection_publication_operation WHERE route=$1 AND owner_account_id=$2 AND creation_key=$3`,
              [route, actor.accountId, requestKey],
            )
          ).rows[0];
          const initialized =
            !prior &&
            (
              await tx.query(
                `INSERT INTO library.fact_source_head(route,account_id,generation)
          VALUES($1,$2,1) ON CONFLICT DO NOTHING RETURNING generation`,
                [route, actor.accountId],
              )
            ).rows.length === 1;
          const fact = (
            await tx.query<{ generation: string }>(
              'SELECT generation::text FROM library.fact_source_head WHERE route=$1 AND account_id=$2 FOR SHARE',
              [route, actor.accountId],
            )
          ).rows[0];
          if (
            !fact ||
            (prepared.metadata &&
              !(
                prepared.metadata.factFence === fact.generation ||
                (prepared.metadata.factFence === null && initialized && fact.generation === '1')
              ))
          )
            throw unavailable();
          if (prior) {
            const original = await load(tx, {
              route,
              id: prior.publicationId,
              kind: COLLECTION_PUBLICATION_COMMAND,
              sourceId: prior.sourceId,
            });
            if (!original || original.phase === 'refused') throw unavailable();
            if (original.creation.initiator.creation.requestDigest !== requestDigest.toString('hex'))
              throw new IdempotencyConflictError(partitionOf(route));
            if (creation) {
              // A concurrent retry may have allocated a different unused candidate ID before the receipt lock.
              const collection = await readCollection(tx, route, original.creation.source.locator.collectionId);
              if (!collection || collection.state !== 'active' || collection.curatorAccountId !== actor.accountId)
                throw new ProblemError('not_found');
            }
            const completed =
              original.phase === 'complete' &&
              (await readCollectionPublicationEpisode(tx, original.creation.source.locator))?.phase === 'complete';
            if (
              !creation &&
              (!(await readCollectionPublicationRule(tx, original.creation.source.locator)) ||
                !prepared.metadata ||
                (!completed &&
