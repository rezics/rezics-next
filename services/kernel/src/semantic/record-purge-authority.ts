import type { Pool } from 'pg';
import {
  authoritativeTimeValue, CommandUnavailableError, currentCommand, noEffect, runCommand, type CommandTransaction,
} from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';

export type RecordPurgeReference = Readonly<{
  subjectId: string; candidateId: string; revision: number; documentId: string | null;
  deletionGeneration: string;
}>;
declare const recordPurgeAuthority: unique symbol;
export type RecordPurgeAuthority = { readonly [recordPurgeAuthority]: true };
export type RecordPurgeSource = Readonly<{
  reference: RecordPurgeReference;
  disposition: 'ordinary-deletion'; sourceVersion: string;
  deletionTransactionId: string; deletionCommittedAt: string; purgeAfter: string;
}>;

type Binding = Readonly<{ source: RecordPurgeSource; partition: number; epoch: number }>;
const issued = new WeakMap<RecordPurgeAuthority, Binding>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function reference(value: RecordPurgeReference): RecordPurgeReference {
  if (!value || Object.keys(value).length !== 5 || routeOf(value.subjectId) === null ||
      routeOf(value.candidateId) !== routeOf(value.subjectId) ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      (value.documentId !== null && routeOf(value.documentId) !== routeOf(value.subjectId)) ||
      !uuid.test(value.deletionGeneration)) throw new TypeError('Invalid record purge reference');
  return Object.freeze({ subjectId: value.subjectId, candidateId: value.candidateId,
    revision: value.revision, documentId: value.documentId, deletionGeneration: value.deletionGeneration });
}
function binding(authority: RecordPurgeAuthority): Binding {
  const value = issued.get(authority);
  if (!value) throw new TypeError('Record purge authority was not issued by Semantic');
  return value;
}

/** Always rereads the native lifecycle, original command and current home under the same row locks. */
async function source(tx: CommandTransaction, ref: RecordPurgeReference): Promise<RecordPurgeSource | null> {
  const command = currentCommand(tx);
  const route = routeOf(ref.subjectId)!;
  if (command.partition !== partitionOf(route)) throw new RangeError('Record purge source is in another home');
  const result = await tx.query<{
    source_version: string; deletion_transaction_id: string; committed_transaction_id: string | null; deleted_at: string; purge_after: string;
  }>(`SELECT l.version::text AS source_version,l.deletion_transaction_id,b.transaction_id AS committed_transaction_id,
      to_char(l.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at,
      to_char(l.purge_after AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS purge_after
    FROM semantic.record_lifecycle l
    JOIN semantic.candidate c ON (c.route,c.subject_id,c.candidate_id)=(l.route,l.subject_id,l.candidate_id)
    JOIN semantic.subject s ON (s.route,s.subject_id)=(l.route,l.subject_id)
    LEFT JOIN semantic.record_retention_commit b ON (b.route,b.subject_id,b.candidate_id,b.deletion_generation)=
      (l.route,l.subject_id,l.candidate_id,l.deletion_generation) AND b.transaction_id=l.deletion_transaction_id
      AND b.deleted_at=l.deleted_at AND b.purge_after=l.purge_after
    WHERE $1::integer=l.route/16 AND l.route=$2 AND l.subject_id=$3 AND l.candidate_id=$4 AND l.revision=$5
      AND c.revision=l.revision AND ($6::uuid IS NULL OR EXISTS (
        SELECT 1 FROM semantic.record_retention_document d WHERE d.route=l.route AND d.subject_id=l.subject_id
        AND d.candidate_id=l.candidate_id AND d.deletion_generation=l.deletion_generation AND d.document_id=$6))
      AND l.deletion_generation=$7 AND l.state IN ('deleted','purging') AND NOT l.held
      AND l.deleted_at IS NOT NULL AND l.purge_after=l.deleted_at+interval '720 hours'
      AND l.purge_after <= $8::timestamptz
      AND NOT EXISTS (SELECT 1 FROM semantic.hidden_candidate h WHERE h.route=l.route
        AND h.subject_id=l.subject_id AND h.candidate_id=l.candidate_id AND h.visibility='taken_down')
    FOR UPDATE OF s,l,c`, [command.partition,route,ref.subjectId,ref.candidateId,ref.revision,ref.documentId,
      ref.deletionGeneration,authoritativeTimeValue(command.time)]);
  const row = result.rows[0];
  if (row && row.committed_transaction_id === null) throw new Error('record_purge_native_commit_unavailable');
  return row ? Object.freeze({ reference: ref, disposition: 'ordinary-deletion',
    sourceVersion: row.source_version, deletionTransactionId: row.deletion_transaction_id,
    deletionCommittedAt: row.deleted_at, purgeAfter: row.purge_after }) : null;
}

export async function prepareRecordPurgeAuthority(
  deps: Readonly<{ pool: Pool; clock?: () => Date }>, ref: RecordPurgeReference,
  context: Readonly<{ deadline: number }>,
): Promise<RecordPurgeAuthority | null> {
  const copied = reference(ref);
  const partition = partitionOf(routeOf(copied.subjectId)!);
  const read = await runCommand(deps.pool, { partition, deadline: context.deadline, clock: deps.clock },
    async (tx) => noEffect(await source(tx,copied)));
  if (!read.value) return null;
  const authority = Object.freeze(Object.create(null)) as RecordPurgeAuthority;
  issued.set(authority, Object.freeze({ source: read.value, partition, epoch: read.epoch }));
  return authority;
}
export async function readRecordPurgeAuthoritySource(
  deps: Readonly<{ pool: Pool; clock?: () => Date }>, authority: RecordPurgeAuthority,
  context: Readonly<{ deadline: number }>,
): Promise<RecordPurgeSource | null> {
  const saved = binding(authority);
  const read = await runCommand(deps.pool,
    { partition: saved.partition, deadline: context.deadline, clock: deps.clock },
    async (tx) => noEffect(await lockRecordPurgeAuthoritySource(tx,authority)));
  if (read.epoch !== saved.epoch) throw new CommandUnavailableError('moved',saved.partition);
  return read.value;
}
export async function lockRecordPurgeAuthoritySource(
  tx: CommandTransaction, authority: RecordPurgeAuthority,
): Promise<RecordPurgeSource | null> {
  const saved = binding(authority);
  const row = await source(tx,saved.source.reference);
  const home = await tx.query<{ epoch: number }>(
    "SELECT epoch FROM core.partition WHERE partition_no=$1 AND write_state='active' FOR SHARE",
    [saved.partition]);
  if (home.rows[0]?.epoch !== saved.epoch) throw new CommandUnavailableError('moved',saved.partition);
  return row && row.sourceVersion === saved.source.sourceVersion &&
    row.deletionTransactionId === saved.source.deletionTransactionId &&
    row.deletionCommittedAt === saved.source.deletionCommittedAt && row.purgeAfter === saved.source.purgeAfter
    ? row : null;
}
