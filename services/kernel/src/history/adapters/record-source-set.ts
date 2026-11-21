import { currentCommand, type CommandTransaction } from '../../command/command.ts';
import {
  nativeRecordSourceSetProducer,
  type SemanticRecordSourceSet,
  type SemanticRecordSourceSetLocator,
  type SemanticRecordSourceSetSnapshot,
} from './record-source-set-native.ts';
import { type HistoryLocator, encodeLocator } from '../contract/index.ts';

export type { SemanticRecordSourceSet } from '../../semantic/record-source-set.ts';
export const MAX_NATIVE_RECORD_SOURCE_SET_MEMBERS = 512;
type Declaration = Readonly<{ handle: SemanticRecordSourceSet; locator: SemanticRecordSourceSetLocator }>;
const sets = new WeakMap<CommandTransaction, Declaration>();

export function validateNativeRecordSourceSetLocator(locator: SemanticRecordSourceSetLocator): void {
  if (
    Object.keys(locator).length !== 3 ||
    !Number.isInteger(locator.partition) ||
    locator.partition < 0 ||
    locator.partition > 4095 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(locator.transactionId) ||
    !Number.isSafeInteger(locator.revision) ||
    locator.revision < 1
  )
    throw new TypeError('Invalid native record source set locator');
}
export function validateNativeRecordSourceSetSnapshot(set: SemanticRecordSourceSetSnapshot): void {
  validateNativeRecordSourceSetLocator(set.locator);
  if (
    Object.keys(set).length !== 3 ||
    typeof set.digest !== 'string' ||
    !set.digest.length ||
    !Number.isInteger(set.members) ||
    set.members < 0 ||
    set.members > MAX_NATIVE_RECORD_SOURCE_SET_MEMBERS
  )
    throw new TypeError('Invalid native record source set snapshot');
}

/** History's existing byte keys encode the real structured locator. They are not Source IDs. */
export function recordSourceSetStorageKey(locator: SemanticRecordSourceSetLocator): [number, Buffer, Buffer] {
  validateNativeRecordSourceSetLocator(locator);
  return [locator.partition, Buffer.from(locator.transactionId, 'utf8'), Buffer.from(String(locator.revision), 'utf8')];
}
function commandLocator(tx: CommandTransaction, handle: SemanticRecordSourceSet): SemanticRecordSourceSetLocator {
  const locator = nativeRecordSourceSetProducer().semanticRecordSourceSetLocator(tx, handle);
  validateNativeRecordSourceSetLocator(locator);
  const command = currentCommand(tx);
  if (locator.partition !== command.partition || locator.transactionId !== command.transactionId)
    throw new TypeError('Native record source set belongs to another command');
  return Object.freeze({ ...locator });
}
function declaredLocator(tx: CommandTransaction, declaration: Declaration): SemanticRecordSourceSetLocator {
  const locator = commandLocator(tx, declaration.handle);
  if (locator.revision !== declaration.locator.revision)
    throw new TypeError('Native record source set revision changed');
  return locator;
}

// The real owner validates provenance synchronously, before any nested serialization.
export function rememberCommandRecordSourceSet(tx: CommandTransaction, sourceSet: SemanticRecordSourceSet): void {
  const locator = commandLocator(tx, sourceSet);
  sets.set(tx, { handle: sourceSet, locator });
}
export function hasCommandRecordSourceSet(tx: CommandTransaction): boolean {
  return sets.has(tx);
}
export function releaseCommandRecordSourceSet(tx: CommandTransaction): void {
  sets.delete(tx);
}

/** Validation of persisted provisional metadata only. Never used as native producer evidence. */
export function validateRecordSourceSetCommitment(
  set: Readonly<{
    sourcePartition: number;
    locator: Uint8Array;
    revision: Uint8Array;
    originalTransaction: string;
    memberCount: number;
  }>,
): void {
  if (
    Object.keys(set).length !== 5 ||
    !Number.isInteger(set.sourcePartition) ||
    set.sourcePartition < 0 ||
    set.sourcePartition > 4095 ||
    !(set.locator instanceof Uint8Array) ||
    set.locator.byteLength < 1 ||
    set.locator.byteLength > 256 ||
    !(set.revision instanceof Uint8Array) ||
    set.revision.byteLength < 1 ||
    set.revision.byteLength > 256 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(set.originalTransaction) ||
    !Number.isInteger(set.memberCount) ||
    set.memberCount < 1 ||
    set.memberCount > MAX_NATIVE_RECORD_SOURCE_SET_MEMBERS
  )
    throw new TypeError('Invalid native record source set commitment');
}

/** Bind the actual codec/SDK-generated artifact inside the native command transaction.
 * Membership and digest are unknown while Source is building. Its native commit guard must
 * seal or roll back this transaction, including all these associations. No second checkout. */
export async function recordCommandRecordSourceSetCopy(
  tx: CommandTransaction,
  locator: HistoryLocator,
  position: bigint | null,
): Promise<void> {
  return recordCommandRecordSourceSetCopies(tx, [locator], position);
}

export async function recordCommandRecordSourceSetCopies(
  tx: CommandTransaction,
  locators: readonly HistoryLocator[],
  position: bigint | null,
): Promise<void> {
  const declaration = sets.get(tx);
  if (!declaration) return;
  const set = declaredLocator(tx, declaration);
  const command = currentCommand(tx);
  const key = recordSourceSetStorageKey(set);
  // A just-inserted row is already owned by this transaction. For a prior
  // association, keep its share lock until the command commits.
  const accepted = await tx.query<{ original_ok: boolean; copy_ok: boolean }>(
    `WITH inserted AS (
       INSERT INTO core.record_history_source_set
         (source_partition,set_locator,set_revision,original_transaction,original_position,member_count,
          producer_version,native_revision,snapshot_digest,metadata_state)
       VALUES($1,$2,$3,$4,$5,NULL,1,$6,NULL,'building') ON CONFLICT DO NOTHING
       RETURNING original_transaction,original_position,native_revision,metadata_state
     ), existing AS (
       SELECT original_transaction,original_position,native_revision,metadata_state
       FROM core.record_history_source_set
       WHERE (source_partition,set_locator,set_revision)=($1,$2,$3) AND NOT EXISTS (SELECT 1 FROM inserted)
       FOR SHARE
     ), original AS (
       SELECT * FROM inserted UNION ALL SELECT * FROM existing
     ), eligible AS MATERIALIZED (
       SELECT 1 FROM original WHERE original_transaction=$4 AND native_revision=$6 AND metadata_state<>'legacy'
         AND (original_position IS NULL OR $5::bigint IS NULL OR original_position=$5)
     ), copy AS (
       INSERT INTO core.record_history_source_set_copy
         (source_partition,set_locator,set_revision,partition_no,artifact_type,locator,
          original_transaction,original_position,producer_version)
       SELECT $1,$2,$3,$7,input.kind,input.locator,$4,$5,1 FROM eligible
       CROSS JOIN unnest($8::text[], $9::bytea[]) AS input(kind,locator)
       ON CONFLICT (partition_no,artifact_type,locator) DO SELECT FOR SHARE
       RETURNING source_partition,set_locator,set_revision,original_transaction,original_position,producer_version
     )
     SELECT EXISTS (SELECT 1 FROM eligible) AS original_ok,
       (SELECT count(*) FROM copy WHERE (source_partition,set_locator,set_revision)=($1,$2,$3)
         AND original_transaction=$4 AND producer_version=1
         AND (original_position IS NULL OR $5::bigint IS NULL OR original_position=$5)) = cardinality($8::text[]) AS copy_ok`,
    [
      ...key,
      set.transactionId,
      position?.toString() ?? null,
      set.revision,
      command.partition,
      locators.map((locator) => locator.artifactType),
      locators.map((locator) => Buffer.from(encodeLocator(locator))),
    ],
  );
  if (!accepted.rows[0]?.original_ok) throw new TypeError('Conflicting immutable native record source set');
  if (!accepted.rows[0].copy_ok) throw new TypeError('Conflicting native record source set copy');
}

export async function finalizeCommandRecordSourceSet(tx: CommandTransaction, position: bigint): Promise<void> {
  const declaration = sets.get(tx);
  if (!declaration) return;
  const locator = declaredLocator(tx, declaration);
  // Existing finalization order remains after generated coordinates, before native COMMIT.
  // Locator validation is not a seal or an immutable membership assertion.
  const command = currentCommand(tx);
  await tx.query(
    `WITH positioned AS (
       UPDATE core.record_history_source_set SET original_position=$4
       WHERE (source_partition,set_locator,set_revision)=($1,$2,$3) AND original_position IS NULL
     )
     UPDATE core.record_history_source_set_copy SET original_position=$4
     WHERE partition_no=$5 AND original_transaction=$6 AND original_position IS NULL`,
    [...recordSourceSetStorageKey(locator), position.toString(), command.partition, command.transactionId],
  );
}
