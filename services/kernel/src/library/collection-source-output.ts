/** Explicit membership Publication storage. It never evaluates personal predicates or grants read authority. */
import type { PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { shareAccount } from '../access/account-share.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  registerCommandCallback,
  type CommandTransaction,
} from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import lock from './collection-source-output-lock.sql';
import { readCollectionPublicationStagingSeal } from './collection-publication-staging.ts';
import {
  readCollectionPublicationEpisode,
  readCollectionPublicationEpisodeVersion,
  readCollectionPublicationRule,
} from './collection-publication-episodes.ts';
import type { CollectionPublicationEpisode } from './collection-publication-episode-contract.ts';
import type { CollectionPublicationLocator } from './collection-publication-work-admission.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';
import { readCollection } from './collection-store.ts';
import { captureCollectionMetadataHistory } from './collection-metadata-history.ts';

/** Native receipt locator/provenance only. It carries no viewer or subject permission. */
export type CollectionOutputPublication = Readonly<{
  generation: string;
  transactionId: string;
  position: string;
  nativeXid: string;
  sourceGeneration: string;
  memberFence: string;
  members: string;
}>;
export type CollectionOutputRef = Readonly<{ route: number; collectionId: string; generation: string }>;
type Client = Pick<PoolClient, 'query'>;
type Build = {
  account_id: string | null;
  source_generation: string;
  expected_members: string | null;
  output_mode: 'selected' | 'whole_query';
  written_members: string;
  member_count: string;
  after_subject_id: string | null;
  state: 'building' | 'complete' | 'cancelled';
};
type OutputOwner = Readonly<{
  accountId: string;
  state: string;
  membershipKind: string;
  visibility: string;
  revision: number;
  sourceGeneration: string;
  incarnation: string;
}>;
type StagingActivation = Readonly<{
  locator: CollectionPublicationLocator;
  work: NativeCollectionWork;
  version: string;
  phase: Extract<CollectionPublicationEpisode['phase'], 'staging' | 'awaiting_activation'>;
  selected: CollectionPublicationEpisode['selected'];
}>;
const conflict = () => new ProblemError('conflict');
const uuid = (id: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
function ref(input: CollectionOutputRef) {
  if (routeOf(input.collectionId) !== input.route || !uuid(input.generation))
    throw new TypeError('Invalid explicit Collection publication reference');
}

/** These hooks belong inside an already authorized native Collection update command, including its event.
 * They do not create a resource, fabricate a transaction, or turn a work callback into publication authority.
 * The caller admits explicit membership through its ordinary Source/subject boundary BEFORE calling append.
 * A complete generation contains only subject IDs; predicates, pins, notes and private facts are never copied.
 */
async function writer(tx: CommandTransaction, input: CollectionOutputRef, allowPrivate = false): Promise<OutputOwner> {
  ref(input);
  const command = currentCommand(tx);
  if (
    command.partition !== partitionOf(input.route) ||
    command.basis === null ||
    command.authorization?.mode !== 'execute' ||
    command.authorization.action !== 'collection:update' ||
    command.authorization.resource.route !== input.route ||
    command.authorization.resource.id !== input.collectionId
  )
    throw new TypeError('Explicit output requires the live Collection update authority');
  const row = (
    await tx.query<{
      accountId: string;
      state: string;
      membershipKind: string;
      visibility: string;
      revision: number;
      sourceGeneration: string;
      incarnation: string;
    }>(lock.sql, [input.route, input.collectionId])
  ).rows[0];
  if (!row || row.state !== 'active' || row.membershipKind !== 'dynamic') throw new ProblemError('not_found');
  // Hold the real curator fence through commit. Late uploads/completion cannot cross terminal T.
  await shareAccount(tx, row.accountId);
  if (row.visibility === 'private' && !allowPrivate) throw conflict();
  return row;
}

async function build(tx: Client, input: CollectionOutputRef): Promise<Build> {
  const row = (
    await tx.query<Build>(
      `SELECT account_id::text,source_generation::text,expected_members::text,output_mode,written_members::text,member_count::text,after_subject_id::text,state
     FROM library.collection_source_output
     WHERE route=$1 AND collection_id=$2 AND generation=$3 FOR UPDATE`,
      [input.route, input.collectionId, input.generation],
    )
  ).rows[0];
  if (!row) throw conflict();
  return row;
}

export async function beginCollectionSourceOutput(
  tx: CommandTransaction,
  input: CollectionOutputRef & { readonly expectedMembers: number },
): Promise<void> {
  if (!Number.isSafeInteger(input.expectedMembers) || input.expectedMembers < 0)
    throw new RangeError('Invalid output size');
  await allocate(tx, input, input.expectedMembers);
}

/** The episode's ordinary admitted begin command allocates UNKNOWN cardinality in the same native namespace.
 * This shares the original allocator/capacity rules. It neither selects B nor creates another generation ID.
 */
export async function beginWholeQueryCollectionSourceOutput(
  tx: CommandTransaction,
  input: CollectionOutputRef,
): Promise<void> {
  await allocate(tx, input, null);
}

async function allocate(tx: CommandTransaction, input: CollectionOutputRef, expectedMembers: number | null) {
  const source = await writer(tx, input);
  // A current A and a building B fit two retained generations. Until actual disposition is bound,
  // old/cancelled copies still occupy capacity; an unbounded sequence of abandoned builds is not admitted.
  const retained = await tx.query<{ generation: string }>(
    `SELECT generation::text FROM library.collection_source_output
     WHERE route=$1 AND collection_id=$2 ORDER BY generation LIMIT 2`,
    [input.route, input.collectionId],
  );
  if (retained.rows.length === 2 && !retained.rows.some((row) => row.generation === input.generation))
    throw new ProblemError('dependency_unavailable');
  await tx.query(
    `INSERT INTO library.collection_source_output
     (route,collection_id,generation,source_generation,expected_members,account_id,output_mode)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [
      input.route,
      input.collectionId,
      input.generation,
      source.sourceGeneration,
      expectedMembers,
      source.accountId,
      expectedMembers === null ? 'whole_query' : 'selected',
    ],
  );
  const current = await build(tx, input);
  // Whole-query allocation keeps cardinality unknown; match its mode and nullable size together.
  if (
    current.state !== 'building' ||
    current.account_id !== source.accountId ||
    current.source_generation !== source.sourceGeneration ||
    current.output_mode !== (expectedMembers === null ? 'whole_query' : 'selected') ||
    current.expected_members !== (expectedMembers === null ? null : String(expectedMembers))
  )
    throw conflict();
}

/** Strict sorted chunks are the explicit selection, not a partial query result. Source admission is caller-owned.
 * Checkpoint and rows share the native transaction. Replayed Core receipts skip this hook entirely.
 */
export async function appendCollectionSourceOutput(
  tx: CommandTransaction,
  input: CollectionOutputRef & { readonly after: string | null; readonly subjectIds: readonly string[] },
): Promise<void> {
  if (
    input.subjectIds.length < 1 ||
    input.subjectIds.length > 100 ||
    Buffer.byteLength(JSON.stringify([input.after, input.subjectIds])) > 4096 ||
    (input.after !== null && !uuid(input.after))
  )
    throw new RangeError('Output chunks require 1..100 keys and at most 4096 bytes');
  let previous = input.after;
  for (const id of input.subjectIds) {
    if (!uuid(id) || (previous !== null && id <= previous))
      throw new TypeError('Output keys must be strictly increasing UUIDs');
    previous = id;
  }
  const source = await writer(tx, input),
    current = await build(tx, input);
  if (
    current.state !== 'building' ||
    current.output_mode !== 'selected' ||
    current.expected_members === null ||
    current.account_id !== source.accountId ||
    current.source_generation !== source.sourceGeneration ||
    current.after_subject_id !== input.after ||
    BigInt(current.written_members) + BigInt(input.subjectIds.length) > BigInt(current.expected_members)
  )
    throw conflict();
  await tx.query(
    `INSERT INTO library.collection_source_output_member(route,collection_id,generation,subject_id)
     SELECT $1,$2,$3,subject_id FROM unnest($4::uuid[]) AS subjects(subject_id)`,
    [input.route, input.collectionId, input.generation, [...input.subjectIds]],
  );
  await tx.query(
    `UPDATE library.collection_source_output SET written_members=written_members+$4,after_subject_id=$5
     WHERE route=$1 AND collection_id=$2 AND generation=$3`,
    [input.route, input.collectionId, input.generation, input.subjectIds.length, previous],
  );
}

/** Atomic COMPLETE activation. A pending B never replaces completed A, including an explicitly empty A. */
export async function completeCollectionSourceOutput(
  tx: CommandTransaction,
  input: CollectionOutputRef,
  staging?: StagingActivation,
): Promise<void> {
  let source: OutputOwner;
  let current: Build;
  let sealedMembers: string | null = null;
  if (staging) {
    // Re-read the actual native full-query seal before the fresh local owner/rule/header compare.
    // No caller count, phase, checkpoint JSON or selected A may stand in for this receipt.
    const seal = await readCollectionPublicationStagingSeal(tx, staging.locator, staging.work);
    if (
      !seal ||
      seal.publicationId !== staging.locator.publicationId ||
      seal.output.route !== input.route ||
      seal.output.collectionId !== input.collectionId ||
      seal.output.generation !== input.generation
    )
      throw conflict();
    const episode = await readCollectionPublicationEpisode(tx, staging.locator);
    const rule = await readCollectionPublicationRule(tx, staging.locator);
    const version = await readCollectionPublicationEpisodeVersion(tx, staging.locator);
    if (
      !episode ||
      !rule ||
      !version ||
      episode.phase !== staging.phase ||
      version !== staging.version ||
      !isDeepStrictEqual(episode.selected, staging.selected) ||
      (episode.phase !== 'staging' && episode.phase !== 'awaiting_activation') ||
      episode.output.state !== 'building' ||
      episode.source.output.route !== input.route ||
      episode.source.output.collectionId !== input.collectionId ||
      episode.source.output.generation !== input.generation ||
      episode.source.locator.route !== staging.locator.route ||
      episode.source.locator.collectionId !== staging.locator.collectionId ||
      episode.source.locator.ownerAccountId !== staging.locator.ownerAccountId ||
      episode.source.target.route !== input.route ||
      episode.source.target.collectionId !== input.collectionId ||
      (episode.source.target.visibility !== 'public' && episode.source.target.visibility !== 'unlisted') ||
      episode.source.input.kind !== 'private_working_source' ||
      episode.source.input.identity.scope !== 'private_builtin' ||
      episode.source.input.identity.route !== input.route ||
      episode.source.input.identity.collectionId !== input.collectionId ||
      episode.source.input.identity.accountId !== staging.locator.ownerAccountId ||
      episode.source.rule.collectionRevision !== rule.collectionRevision ||
      episode.source.rule.sourceGeneration !== rule.sourceGeneration
    )
      throw conflict();

    // The exact Collection row is re-locked only after Source seal verification, immediately before
    // the single visibility/output switch. This leaves private working authority private until then.
    source = await writer(tx, input, true);
    if (
      source.accountId !== staging.locator.ownerAccountId ||
      source.revision !== episode.source.rule.collectionRevision ||
      source.sourceGeneration !== episode.source.rule.sourceGeneration ||
      source.incarnation !== episode.source.rule.incarnation
    )
      throw conflict();
    current = await build(tx, input);
    if (
      current.output_mode !== 'whole_query' ||
      current.state !== 'building' ||
      current.expected_members !== null ||
      current.account_id !== source.accountId ||
      current.source_generation !== source.sourceGeneration ||
      current.written_members !== seal.members ||
      current.member_count !== seal.members
    )
      throw conflict();
    const command = currentCommand(tx);
    const before = await readCollection(tx, input.route, input.collectionId);
    if (!before || before.revision !== source.revision || before.curatorAccountId !== source.accountId)
      throw conflict();
    const changed = await tx.query(
      `UPDATE library.collection SET visibility=$5,revision=revision+1,
         updated_at=$6::timestamptz,transaction_id=$7
       WHERE route=$1 AND collection_id=$2 AND curator_account_id=$3 AND revision=$4
         AND source_generation=$8 AND state='active' AND membership_kind='dynamic'
         AND collection_id::text || ':' || extract(epoch FROM created_at)::text=$9`,
      [
        input.route,
        input.collectionId,
        source.accountId,
        source.revision,
        episode.source.target.visibility,
        authoritativeTimeValue(command.time),
        command.transactionId,
        source.sourceGeneration,
        source.incarnation,
      ],
    );
    if (changed.rowCount !== 1) throw conflict();
    const after = await readCollection(tx, input.route, input.collectionId);
    if (!after) throw conflict();
    await captureCollectionMetadataHistory(tx, {
      route: input.route,
      before,
      after,
      transactionId: command.transactionId,
      time: authoritativeTimeValue(command.time),
    });
    sealedMembers = seal.members;
  } else {
    source = await writer(tx, input);
    current = await build(tx, input);
    if (current.output_mode === 'whole_query') throw conflict();
  }
  if (current.output_mode === 'whole_query') {
    if (!staging || sealedMembers === null) throw conflict();
    await tx.query(
      `UPDATE library.collection_source_output SET expected_members=$4
       WHERE route=$1 AND collection_id=$2 AND generation=$3 AND output_mode='whole_query' AND expected_members IS NULL`,
      [input.route, input.collectionId, input.generation, sealedMembers],
    );
    current = await build(tx, input);
  }
  if (
    current.state !== 'building' ||
    current.expected_members === null ||
    current.account_id !== source.accountId ||
    current.source_generation !== source.sourceGeneration ||
    current.written_members !== current.expected_members ||
    current.member_count !== current.expected_members
  )
    throw conflict();
  await tx.query(
    `UPDATE library.collection_source_output SET state='complete'
     WHERE route=$1 AND collection_id=$2 AND generation=$3`,
    [input.route, input.collectionId, input.generation],
  );
  await tx.query(
    `INSERT INTO library.collection_source_output_head(route,collection_id,generation,source_generation) VALUES($1,$2,$3,$4)
     ON CONFLICT(route,collection_id) DO UPDATE SET generation=EXCLUDED.generation,source_generation=EXCLUDED.source_generation`,
    [input.route, input.collectionId, input.generation, (BigInt(source.sourceGeneration) + 1n).toString()],
  );
  await tx.query(
    `UPDATE library.collection SET source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2`,
    [input.route, input.collectionId],
  );
  const sourceGeneration = (BigInt(source.sourceGeneration) + 1n).toString();
  // After the authorized body's finalizer, before Core's actual fence/basis and COMMIT. The deferred native
  // constraint requires that exact Core transaction and xid; a random UUID or process capability cannot seal it.
  registerCommandCallback(tx, async (transactionId) => {
    const publication = await tx.query(
      `INSERT INTO library.collection_source_output_publication
       (route,collection_id,generation,account_id,incarnation,source_generation,expected_members,member_fence,collection_fence,transaction_id)
       SELECT g.route,g.collection_id,g.generation,s.curator_account_id,
              s.collection_id::text || ':' || extract(epoch FROM s.created_at)::text,h.source_generation,
              g.expected_members,g.member_fence,f.generation,$5
       FROM library.collection_source_output g
       JOIN library.collection_source_output_head h USING(route,collection_id,generation)
       JOIN library.collection s ON s.route=g.route AND s.collection_id=g.collection_id
       JOIN library.native_source_fence f ON f.route=g.route AND f.kind='collection' AND f.owner_id=g.collection_id
       WHERE g.route=$1 AND g.collection_id=$2 AND g.generation=$3 AND h.source_generation=$4
         AND s.source_generation=$4 AND s.curator_account_id=$6 AND s.state='active' AND s.visibility<>'private'
         AND g.source_generation+1=$4 AND g.state='complete' AND g.account_id=s.curator_account_id
         AND g.expected_members=g.written_members AND g.member_count=g.expected_members
       RETURNING transaction_id`,
      [input.route, input.collectionId, input.generation, sourceGeneration, transactionId, source.accountId],
    );
    if (publication.rows.length !== 1) throw conflict();
  });
}

export async function cancelCollectionSourceOutput(tx: CommandTransaction, input: CollectionOutputRef): Promise<void> {
  await writer(tx, input);
  // Cancellation retains the exact generation and children for the shared disposition authority.
  await tx.query(
    `UPDATE library.collection_source_output SET state='cancelled'
     WHERE route=$1 AND collection_id=$2 AND generation=$3 AND state='building'`,
    [input.route, input.collectionId, input.generation],
  );
}

/** Source-local exact inventory only. It proves neither destination disposition nor global account erasure. */
export async function readCollectionSourceOutputInventory(
  client: Client,
  input: Readonly<{ route: number; collectionId: string }>,
) {
  if (routeOf(input.collectionId) !== input.route) throw new TypeError('Invalid Collection output inventory source');
  return (
    await client.query<{
      generation: string;
      state: 'building' | 'complete' | 'cancelled';
      members: string;
      publicationTransactionId: string | null;
      nativeXid: string | null;
    }>(
      `SELECT g.generation::text,g.state,g.written_members::text AS members,
             r.transaction_id::text AS "publicationTransactionId",r.native_xid::text AS "nativeXid"
      FROM library.collection_source_output g
      LEFT JOIN library.collection_source_output_publication r USING(route,collection_id,generation)
      WHERE g.route=$1 AND g.collection_id=$2 ORDER BY g.generation LIMIT 2`,
      [input.route, input.collectionId],
    )
  ).rows;
}
