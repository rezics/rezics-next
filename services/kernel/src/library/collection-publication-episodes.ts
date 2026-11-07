/** Native immutable episode storage. Readers return evidence, never authority. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import type {
  DurableInitiatorReader,
  DurableInitiatorRecord,
  DurableOperationAnchor,
} from '../access/durable-initiator.ts';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  type CommandAuthorization,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { hasLiveOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import type { Access, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { requireLibraryDomain } from './domain-binding.ts';
import { collectionMutationApplication } from './collection-mutation.ts';
import type { BuiltinCollectionKey } from './builtin-identity.ts';
import { readCollection } from './collection-store.ts';
import type { Collection } from './collection-model.ts';
import { readSavedCollectionRule, type SavedCollectionRule } from './collection-rules.ts';
import type {
  CollectionPublicationBeginInput,
  CollectionPublicationCreation,
  CollectionPublicationEpisode,
  CollectionPublicationSource,
} from './collection-publication-episode-contract.ts';
import type { CollectionPublicationLocator } from './collection-publication-work-admission.ts';
import type { CollectionOutputPublication } from './collection-source-output.ts';
import erasureScope from './erasure-scope.sql';
import headQuery from './collection-source-output-head.sql';
import operationQuery from './collection-publication-episode-read.sql';
import receiptQuery from './collection-publication-episode-receipt.sql';

import { COLLECTION_PUBLICATION_COMMAND } from './contract/index.ts';
export { COLLECTION_PUBLICATION_COMMAND, COLLECTION_PUBLICATION_WORKFLOW } from './contract/index.ts';
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
export const canonicalPublicationData = (value: unknown): string => {
  const bytes = canonicalize(value);
  if (bytes === undefined) throw new TypeError('Noncanonical publication data');
  return bytes;
};
export const hashPublicationData = (value: unknown) =>
  createHash('sha256').update(canonicalPublicationData(value)).digest('hex');
function locatorValid(locator: CollectionPublicationLocator) {
  return (
    routeOf(locator.collectionId) === locator.route &&
    routeOf(locator.publicationId) === locator.route &&
    routeOf(locator.ownerAccountId) === locator.route
  );
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
export function exactPublicationObject(value: object, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function allowlisted(record: DurableInitiatorRecord) {
  return (
    exactPublicationObject(record, [
      'operation',
      'initiatorAccountId',
      'actor',
      'recordedTransactionId',
      'sourceDigest',
      'originalDelegation',
      'originalAccount',
      'creation',
    ]) &&
    exactPublicationObject(record.operation, ['route', 'id', 'kind', 'sourceId']) &&
    exactPublicationObject(record.actor, ['kind', 'accountId', 'clientId', 'scopes', 'requestedBy', 'authnEpoch']) &&
    exactPublicationObject(record.originalAccount, ['minimumAuthnEpoch', 'operatorAccountId']) &&
    (record.originalDelegation === null ||
      exactPublicationObject(record.originalDelegation, ['transactionId', 'issuedValid'])) &&
    exactPublicationObject(record.creation, ['commandKind', 'idempotencyKey', 'requestDigest', 'target']) &&
    exactPublicationObject(record.creation.target, ['route', 'id'])
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
export async function loadCollectionPublicationCreation(
  client: Client,
  operation: DurableOperationAnchor,
): Promise<Loaded | null> {
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
      canonicalPublicationData(source) !== row.sourceBytes ||
      !allowlisted(row.record) ||
      !isDeepStrictEqual(row.record.operation, operation) ||
      !sourceValid(source, row.record) ||
      row.owner !== source.locator.ownerAccountId ||
      row.collection !== source.locator.collectionId ||
      row.sourceId !== operation.sourceId ||
      row.sourceOperation !== operation.id ||
      row.transactionId !== row.sourceTransaction ||
      row.record.recordedTransactionId !== row.transactionId ||
      hashPublicationData(source) !== row.record.sourceDigest ||
      row.sourceDigest !== row.record.sourceDigest ||
      requireLibraryDomain().identityDisclosure.initiatorCommitment(row.record) !== row.commitment
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
  return (await loadCollectionPublicationCreation(client, operation))?.creation.initiator ?? null;
};
export async function loadCollectionPublicationLocator(client: Client, locator: CollectionPublicationLocator) {
  if (!locatorValid(locator)) return null;
  const row = (
    await client.query<{ sourceId: string }>(
      `SELECT source_id::text AS "sourceId" FROM library.collection_publication_episode
     WHERE route=$1 AND publication_id=$2 AND owner_account_id=$3 AND collection_id=$4`,
      [locator.route, locator.publicationId, locator.ownerAccountId, locator.collectionId],
    )
  ).rows[0];
  return row
    ? loadCollectionPublicationCreation(client, {
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
  const loaded = await loadCollectionPublicationLocator(client, locator);
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
  const loaded = await loadCollectionPublicationLocator(client, locator);
  if (!loaded) return null;
  const meaning = await readCollectionPublicationMeaning(client, locator.route, locator.collectionId);
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
    hashPublicationData({ filter: saved.filter, sort: saved.sort, releaseDigest: saved.releaseDigest }) !== ref.digest
  )
    return null;
  return saved;
}

export type CollectionPublicationMeaning = Readonly<{
  rule: SavedCollectionRule;
  key: Exclude<BuiltinCollectionKey, { kind: 'liked' }> | null;
}>;
export async function readCollectionPublicationMeaning(
  client: Client,
  route: number,
  collectionId: string,
): Promise<CollectionPublicationMeaning | null> {
  const saved = await readSavedCollectionRule(client, route, collectionId);
  if (saved) return { rule: saved, key: null };
  const builtin = (await publicationNative().readBuiltinRule(client, route, collectionId)) as Awaited<
    ReturnType<typeof import('./builtin-materialization.ts').readBuiltinPublicationRule>
  >;
  return builtin ? { rule: builtin.rule, key: builtin.key } : null;
}

function publicationNative() {
  const native = requireLibraryDomain().collectionPublicationNative;
  if (!native) throw new TypeError('Collection publication effects are not composed');
  return native;
}

export function createCollectionPublicationEpisodes(config: {
  pool: Pool;
  access: Access;
  clock?: KernelClock;
}): CollectionPublicationEpisodes {
  return {
    begin(...args) {
      const commands = publicationNative().createCommands(config) as CollectionPublicationEpisodes;
      return commands.begin(...args);
    },
  };
}

/** Version is mutable scheduling data, never an admission or a completion receipt. */
export async function readCollectionPublicationEpisodeVersion(
  client: Client,
  locator: CollectionPublicationLocator,
): Promise<string | null> {
  return (await loadCollectionPublicationLocator(client, locator))?.version ?? null;
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
  return collectionMutationApplication().advancePublication(tx, expected.phase, phase, {
    admit: () => publicationNative().admitStep(tx, locator),
    async current() {
      const episode = await readCollectionPublicationEpisode(tx, locator);
      if (!episode || episode.phase !== expected.phase || !(await readCollectionPublicationRule(tx, locator)))
        return null;
      return { generation: episode.output.ref.generation };
    },
    async compareAndSet() {
      const changed =
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
        ).rows.length === 1;
      return changed;
    },
    async cancel(generation) {
      await tx.query(
        `UPDATE library.collection_source_output SET state='cancelled'
         WHERE route=$1 AND collection_id=$2 AND generation=$3 AND state='building'`,
        [locator.route, locator.collectionId, generation],
      );
    },
  });
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
