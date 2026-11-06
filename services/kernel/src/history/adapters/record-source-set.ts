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
  const declaration = sets.get(tx);
  if (!declaration) return;
  const set = declaredLocator(tx, declaration);
  const command = currentCommand(tx);
  const key = recordSourceSetStorageKey(set);
  await tx.query(
    `INSERT INTO core.record_history_source_set
     (source_partition,set_locator,set_revision,original_transaction,original_position,member_count,producer_version,
      native_revision,snapshot_digest,metadata_state)
     VALUES($1,$2,$3,$4,$5,NULL,1,$6,NULL,'building') ON CONFLICT DO NOTHING`,
    [...key, set.transactionId, position?.toString() ?? null, set.revision],
  );
  const original = await tx.query(
    `SELECT original_transaction,original_position,native_revision,metadata_state FROM core.record_history_source_set
     WHERE source_partition=$1 AND set_locator=$2 AND set_revision=$3 FOR SHARE`,
    key,
  );
  const row = original.rows[0];
  if (
    !row ||
    row.original_transaction !== set.transactionId ||
    row.native_revision !== set.revision ||
    row.metadata_state === 'legacy' ||
    (row.original_position !== null && position !== null && BigInt(row.original_position) !== position)
  )
    throw new TypeError('Conflicting immutable native record source set');
  const encoded = Buffer.from(encodeLocator(locator));
  await tx.query(
    `INSERT INTO core.record_history_source_set_copy
     (source_partition,set_locator,set_revision,partition_no,artifact_type,locator,original_transaction,original_position,producer_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,1) ON CONFLICT DO NOTHING`,
    [...key, command.partition, locator.artifactType, encoded, command.transactionId, position?.toString() ?? null],
  );
  const accepted = await tx.query(
    `SELECT source_partition,set_locator,set_revision,original_transaction,original_position,producer_version
     FROM core.record_history_source_set_copy
     WHERE partition_no=$1 AND artifact_type=$2 AND locator=$3 FOR SHARE`,
    [command.partition, locator.artifactType, encoded],
  );
  const copy = accepted.rows[0];
  if (
    !copy ||
    copy.source_partition !== key[0] ||
    !Buffer.from(copy.set_locator).equals(key[1]) ||
    !Buffer.from(copy.set_revision).equals(key[2]) ||
    copy.original_transaction !== command.transactionId ||
    copy.producer_version !== 1 ||
    (copy.original_position !== null && position !== null && BigInt(copy.original_position) !== position)
  )
    throw new TypeError('Conflicting native record source set copy');
}

export async function finalizeCommandRecordSourceSet(tx: CommandTransaction, position: bigint): Promise<void> {
  const declaration = sets.get(tx);
  if (!declaration) return;
  const locator = declaredLocator(tx, declaration);
  // Existing finalization order remains after generated coordinates, before native COMMIT.
  // Locator validation is not a seal or an immutable membership assertion.
  await tx.query(
    `UPDATE core.record_history_source_set SET original_position=$4
     WHERE source_partition=$1 AND set_locator=$2 AND set_revision=$3 AND original_position IS NULL`,
    [...recordSourceSetStorageKey(locator), position.toString()],
  );
  const command = currentCommand(tx);
  await tx.query(
    `UPDATE core.record_history_source_set_copy SET original_position=$3
     WHERE partition_no=$1 AND original_transaction=$2 AND original_position IS NULL`,
    [command.partition, command.transactionId, position.toString()],
  );
}
