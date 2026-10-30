/** Explicit membership Publication storage. It never evaluates personal predicates or grants read authority. */
import type { PoolClient } from 'pg';
import { shareAccount } from '../access/account-share.ts';
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import lock from './collection-source-output-lock.sql';

export type CollectionOutputRef = Readonly<{ route: number; collectionId: string; generation: string }>;
type Client = Pick<PoolClient, 'query'>;
type Build = {
  source_generation: string;
  expected_members: string;
  written_members: string;
  after_subject_id: string | null;
  state: 'building' | 'complete' | 'cancelled';
};
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
async function writer(tx: CommandTransaction, input: CollectionOutputRef) {
  ref(input);
  const command = currentCommand(tx);
  if (
    command.partition !== partitionOf(input.route) ||
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
      visibility: string;
      sourceGeneration: string;
    }>(lock.sql, [input.route, input.collectionId])
  ).rows[0];
  if (!row || row.state !== 'active') throw new ProblemError('not_found');
  // Hold the real curator fence through commit. Late uploads/completion cannot cross terminal T.
  await shareAccount(tx, row.accountId);
  if (row.visibility === 'private') throw conflict();
  return row;
}

async function build(tx: Client, input: CollectionOutputRef): Promise<Build> {
  const row = (
    await tx.query<Build>(
      `SELECT source_generation::text,expected_members::text,written_members::text,after_subject_id::text,state
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
     (route,collection_id,generation,source_generation,expected_members)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [input.route, input.collectionId, input.generation, source.sourceGeneration, input.expectedMembers],
  );
  const current = await build(tx, input);
  if (
    current.state !== 'building' ||
    current.source_generation !== source.sourceGeneration ||
    BigInt(current.expected_members) !== BigInt(input.expectedMembers)
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
): Promise<void> {
  const source = await writer(tx, input),
    current = await build(tx, input);
  if (
    current.state !== 'building' ||
    current.source_generation !== source.sourceGeneration ||
    current.written_members !== current.expected_members
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
    }>(
      `SELECT generation::text,state,written_members::text AS members FROM library.collection_source_output
     WHERE route=$1 AND collection_id=$2 ORDER BY generation LIMIT 2`,
      [input.route, input.collectionId],
    )
  ).rows;
}
