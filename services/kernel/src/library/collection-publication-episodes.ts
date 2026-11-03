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
    saved.collectionRevision !== ref.collectionRevision ||
    saved.sourceGeneration !== ref.sourceGeneration ||
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
            if (!original) throw unavailable();
            if (original.creation.initiator.creation.requestDigest !== requestDigest.toString('hex'))
              throw new IdempotencyConflictError(partitionOf(route));
            if (
              !creation && (
              !(await readCollectionPublicationRule(tx, original.creation.source.locator)) ||
              !prepared.metadata ||
              !isDeepStrictEqual(original.creation.source.input.identity, await readCurrentInput(tx, prepared.metadata)))
            )
              throw unavailable();
          }
          const current = await readCurrentMeaning(tx, route, input.collectionId);
          if (creation) {
            if (prior) {
              const collection = await readCollection(tx, route, input.collectionId);
              if (!collection || collection.state !== 'active' || collection.curatorAccountId !== actor.accountId)
                throw new ProblemError('not_found');
            } else if (current !== null) throw conflict();
          } else if (materialization ? current !== null : !isDeepStrictEqual(current, prepared.meaning)) throw conflict();
          return mode;
        },
        async finalize(tx, attempt, evidence) {
          const prepared = evidence as Prepared;
          await ordinary.finalize?.(tx, attempt, prepared.proof);
        },
      };
      type Prepared = {
        actorSnapshot: AccountActor;
        proof: unknown;
        saved: SavedCollectionRule;
        meaning: Meaning;
        checks: Awaited<ReturnType<typeof prepareCollectionRuleAuthority>>;
        capture: Awaited<ReturnType<typeof captureDurableInitiator>>;
        metadata: Awaited<ReturnType<typeof readNativeCollectionWorkingMetadata>>['metadata'];
      };
      // Invocation-local evidence; not serialized work authority or a durable actor cache.
      let prepared: Prepared | undefined;
      const prepare = authorization.prepare!;
      authorization.prepare = async (attempt) => (prepared = (await prepare(attempt)) as Prepared);
      return runCommand(
        pool,
        {
          ...identity,
          partition: partitionOf(route),
          deadline,
          ...(config.clock ? { clock: config.clock } : {}),
          receipt: { kind: COLLECTION_PUBLICATION_COMMAND, key: requestKey, digest: requestDigest },
          authorization,
        },
        async (tx, command) => {
          if (!prepared || currentCommand(tx).time !== command.time) throw unavailable();
          const collection = creation ? await creation.materialize(tx) : undefined;
          if (materialization) {
            if (!creation) await materialization.materialize(tx);
          } else {
            // CAS holds the actual header through commit without rewriting A's native Source fence.
            const current = (
              await tx.query<{ revision: number }>(
                `SELECT revision FROM library.collection
          WHERE route=$1 AND collection_id=$2 AND state='active' FOR UPDATE`,
                [route, input.collectionId],
              )
            ).rows[0];
            if (!current || current.revision !== input.revision) throw conflict();
            if (!isDeepStrictEqual(await readCurrentMeaning(tx, route, input.collectionId), prepared.meaning))
              throw conflict();
          }
          const metadata = (
            await readNativeCollectionWorkingMetadata(
              pool,
              { route, collectionId: input.collectionId },
              { commandTx: tx, deadline, allowance: metadataAllowance() },
            )
          ).metadata;
          if (
            !metadata ||
            metadata.curatorAccountId !== actor.accountId ||
            metadata.authority !== 'private_builtin' ||
            metadata.sourceGeneration !== prepared.saved.sourceGeneration ||
            metadata.revision !== (materialization ? 1 : input.revision)
          )
            throw unavailable();
          const identity = await initializeCanonicalCollectionSource(tx, {
            pool,
            route,
            collectionId: input.collectionId,
            deadline,
            allowance: metadataAllowance(),
          });
          // Allocation is real native Source storage, with no capture/observation/repair/complete evidence yet.
          if (!identity || !privateWorkingIdentity(identity)) throw unavailable();
          const locator: CollectionPublicationLocator = {
            route,
            ownerAccountId: actor.accountId,
            collectionId: input.collectionId,
            publicationId: newId(route),
          };
          const sourceId = newId(route),
            output = { route, collectionId: input.collectionId, generation: newId(route) };
          const rule: CollectionPublicationRuleRef = {
            ...(prepared.meaning.key
              ? { kind: 'builtin' as const, key: prepared.meaning.key }
              : { kind: 'saved' as const, revision: prepared.saved.revision }),
            collectionRevision: metadata.revision,
            sourceGeneration: prepared.saved.sourceGeneration,
            releaseDigest: prepared.saved.releaseDigest,
            incarnation: metadata.incarnation,
            digest: hash({
              filter: prepared.saved.filter,
              sort: prepared.saved.sort,
              releaseDigest: prepared.saved.releaseDigest,
            }),
          };
          const source: CollectionPublicationSource = {
            locator,
            input: { kind: 'private_working_source', identity },
            target: {
              kind: 'collection_output',
              route,
              collectionId: input.collectionId,
              visibility: input.visibility,
            },
            rule,
            output,
          };
          const record: DurableInitiatorRecord = {
            operation: { route, id: locator.publicationId, kind: COLLECTION_PUBLICATION_COMMAND, sourceId },
            initiatorAccountId: actor.accountId,
            actor: prepared.actorSnapshot,
            ...prepared.capture,
            sourceDigest: hash(source),
            recordedTransactionId: command.transactionId,
            creation: {
              commandKind: COLLECTION_PUBLICATION_COMMAND,
              idempotencyKey: requestKey,
              requestDigest: requestDigest.toString('hex'),
              target: resource,
            },
          };
          const commitment = durableInitiatorCommitment(record),
            receipt = currentCommandReceipt(tx);
          if (
            receipt.principal.kind !== 'account' ||
            receipt.principal.id !== actor.accountId ||
            receipt.kind !== COLLECTION_PUBLICATION_COMMAND ||
            receipt.key !== requestKey
          )
            throw unavailable();
          const pending = await tx.query(
            "SELECT publication_id FROM library.collection_publication_episode WHERE route=$1 AND collection_id=$2 AND phase IN ('staging','awaiting_activation') LIMIT 1",
            [route, input.collectionId],
          );
          if (pending.rows.length) throw conflict();
          const retained = await tx.query(
            'SELECT generation FROM library.collection_source_output WHERE route=$1 AND collection_id=$2 ORDER BY generation LIMIT 2',
            [route, input.collectionId],
          );
          if (retained.rows.length >= 2) throw unavailable();
          // Unknown whole-query cardinality stays NULL until real exhaustion. No selected-set count or complete receipt.
          await tx.query(
            `INSERT INTO library.collection_source_output(route,collection_id,generation,source_generation,account_id,expected_members,output_mode)
        VALUES($1,$2,$3,$4,$5,NULL,'whole_query')`,
            [route, input.collectionId, output.generation, rule.sourceGeneration, actor.accountId],
          );
          await tx.query(
            `INSERT INTO library.collection_publication_operation
        (route,publication_id,source_id,collection_id,owner_account_id,transaction_id,record,source_digest,commitment,creation_storage_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              route,
              locator.publicationId,
              sourceId,
              input.collectionId,
              actor.accountId,
              command.transactionId,
              record,
              record.sourceDigest,
              commitment,
              receipt.storageKey,
            ],
          );
          await tx.query(
            `INSERT INTO library.collection_publication_source(route,source_id,publication_id,transaction_id,bytes)
        VALUES($1,$2,$3,$4,$5)`,
            [route, sourceId, locator.publicationId, command.transactionId, canonical(source)],
          );
          await tx.query(
            `INSERT INTO library.collection_publication_episode(route,publication_id,source_id,collection_id,owner_account_id)
        VALUES($1,$2,$3,$4,$5)`,
            [route, locator.publicationId, sourceId, input.collectionId, actor.accountId],
          );
          await stageHistoryWork(tx, {
            owner: 'library',
            intent: {
              queue: 'workflows',
              workflowName: COLLECTION_PUBLICATION_WORKFLOW,
              workflowId: locator.publicationId,
              input: { accounts: [actor.accountId], ...locator },
            },
            scope: unionHistoryScope('durable-work/v1', commandHistoryIdentityAccounts(tx), [
              {
                accountRoute: route,
                accountId: actor.accountId,
                roles: encodeRoles(['owner', 'actor', 'durable-initiator']),
              },
            ]),
          });
          return {
            value: { locator, durableInitiator: commitment, ...(collection ? { collection } : {}) },
            events: [
              {
                type: 'com.rezics.library.collection.updated.v1',
                subject: input.collectionId,
                data: { collectionId: input.collectionId },
              },
            ],
          };
        },
      );
    },
  };
}
/** Actual sole Source producer's existing row, selected by its native metadata fence. */
async function readCurrentInput(
  client: Client,
  metadata: NonNullable<Awaited<ReturnType<typeof readNativeCollectionWorkingMetadata>>['metadata']>,
) {
  return (
    (
      await client.query<{ identity: CollectionPublicationSource['input']['identity'] }>(
        `SELECT identity FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 AND source_fence=$3`,
        [metadata.route, metadata.collectionId, nativeSourceFence(metadata)],
      )
    ).rows[0]?.identity ?? null
  );
}

/** Version is mutable scheduling data, never an admission or a completion receipt. */
export async function readCollectionPublicationEpisodeVersion(
  client: Client,
  locator: CollectionPublicationLocator,
): Promise<string | null> {
  return (await loadLocator(client, locator))?.version ?? null;
}

/** Bounded mechanical phase CAS uses the actual live Core step and its owning admission port.
 * Final activation owns the complete transition; this helper cannot manufacture completion.
 */
export async function advanceCollectionPublicationEpisodePhase(
  tx: OperationalTransaction,
  locator: CollectionPublicationLocator,
  expected: Readonly<{ version: string; phase: 'staging' | 'awaiting_activation' }>,
  phase: 'awaiting_activation' | 'refused',
): Promise<boolean> {
  if (
    !hasLiveOperationalTransaction(tx) ||
    !/^(0|[1-9][0-9]*)$/.test(expected.version) ||
    (expected.phase !== 'staging' && expected.phase !== 'awaiting_activation') ||
    (phase !== 'awaiting_activation' && phase !== 'refused') ||
    expected.phase === phase
  )
    throw new TypeError('Invalid native publication phase transition');
  if (!(await admitCollectionPublicationStep(tx, locator))) return false;
  const episode = await readCollectionPublicationEpisode(tx, locator);
  if (!episode || episode.phase !== expected.phase || !(await readCollectionPublicationRule(tx, locator))) return false;
  return (
    (
      await tx.query(
        `UPDATE library.collection_publication_episode SET phase=$7,version=version+1
     WHERE route=$1 AND publication_id=$2 AND owner_account_id=$3 AND collection_id=$4 AND version=$5 AND phase=$6
     RETURNING publication_id`,
        [
          locator.route,
          locator.publicationId,
          locator.ownerAccountId,
          locator.collectionId,
          expected.version,
          expected.phase,
          phase,
        ],
      )
    ).rows.length === 1
  );
}

/** Existing terminal participant only. Erase private operation/actor/rule refs even when selected A survives.
 * SDK/receiving/core history custody remains a separate pending obligation, never a NoData assertion.
 */
export async function purgeCollectionPublicationEpisodes(
  tx: CommandTransaction,
  input: Readonly<{ accountId: string; limit: number }>,
): Promise<Readonly<{ removed: number; exhausted: boolean }>> {
  const route = routeOf(input.accountId);
  if (
    route === null ||
    currentCommand(tx).partition !== partitionOf(route) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    throw new TypeError('Invalid native publication cleanup');
  const terminal = await erasureScope.run(tx, { route, account_id: input.accountId });
  if (!terminal || terminal.version !== 1 || terminal.outcome !== null)
    throw new Error('Publication cleanup requires the current unacknowledged terminal obligation');
  const rows = (
    await tx.query<{ id: string }>(
      `SELECT publication_id::text AS id FROM library.collection_publication_operation
     WHERE route=$1 AND owner_account_id=$2 ORDER BY publication_id LIMIT $3 FOR UPDATE`,
      [route, input.accountId, input.limit],
    )
  ).rows;
  const ids = rows.map((row) => row.id);
  if (ids.length) {
    await tx.query(
      'DELETE FROM library.collection_publication_episode WHERE route=$1 AND publication_id=ANY($2::uuid[])',
      [route, ids],
    );
    await tx.query(
      'DELETE FROM library.collection_publication_source WHERE route=$1 AND publication_id=ANY($2::uuid[])',
      [route, ids],
    );
    await tx.query(
      'DELETE FROM library.collection_publication_operation WHERE route=$1 AND publication_id=ANY($2::uuid[])',
      [route, ids],
    );
  }
  return { removed: ids.length, exhausted: ids.length < input.limit };
}
