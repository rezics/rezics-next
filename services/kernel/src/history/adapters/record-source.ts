import {
  finalizeCommandRecordSourceSet,
  hasCommandRecordSourceSet,
  recordCommandRecordSourceSetCopy,
  releaseCommandRecordSourceSet,
  rememberCommandRecordSourceSet,
  type SemanticRecordSourceSet,
} from './record-source-set.ts';
import { currentCommand, type CommandTransaction } from '../../command/command.ts';
import { routeOf } from '../../route/route.ts';
import { beginAgentIdentitySerialization } from '../application/identity.ts';
import { type RecordHistorySourceReference, encodeLocator, recordHistorySourceKey } from '../contract/index.ts';

export const MAX_COMMAND_RECORD_SOURCES = 16;
const declarations = new WeakMap<CommandTransaction, readonly RecordHistorySourceReference[]>();
const serializing = new WeakSet<CommandTransaction>();

/** Native source writers call before serialization on the REAL command transaction. This is
 * ownership association only: neither permission, source validity nor historical completeness.
 * Declare old, new and current immutable references separately when the command copies each. */
export function declareCommandRecordSources(
  tx: CommandTransaction,
  sources: readonly RecordHistorySourceReference[],
): void {
  currentCommand(tx);
  if (
    declarations.has(tx) ||
    hasCommandRecordSourceSet(tx) ||
    serializing.has(tx) ||
    sources.length < 1 ||
    sources.length > MAX_COMMAND_RECORD_SOURCES
  )
    throw new TypeError('Invalid or repeated command record source declaration');
  const copied = sources.map((source) => Object.freeze({ ...source }));
  const keys = copied.map(recordHistorySourceKey);
  if (new Set(keys).size !== sources.length) throw new TypeError('Repeated original record source');
  declarations.set(tx, Object.freeze(copied));
}

/** Mutually exclusive alternative for one native set, including its same-command building phase.
 * Semantic owns issuance, exact term/old/current membership and the seal-before-commit guard. */
export function declareCommandRecordSourceSet(tx: CommandTransaction, sourceSet: SemanticRecordSourceSet): void {
  currentCommand(tx);
  if (declarations.has(tx) || hasCommandRecordSourceSet(tx) || serializing.has(tx))
    throw new TypeError('Invalid or repeated command record source declaration');
  rememberCommandRecordSourceSet(tx, sourceSet);
}

export function commandRecordSources(tx: CommandTransaction): readonly RecordHistorySourceReference[] {
  return declarations.get(tx) ?? [];
}

export function releaseCommandRecordSources(tx: CommandTransaction): void {
  declarations.delete(tx);
  releaseCommandRecordSourceSet(tx);
  serializing.delete(tx);
}

/** Called before any producer serializes a durable request or command history payload. */
export function beginRecordHistorySerialization(tx: CommandTransaction): void {
  currentCommand(tx);
  beginAgentIdentitySerialization(tx);
  serializing.add(tx);
}

/** Actual serializer hook; only the codec/SDK-generated locator is accepted here. */
export async function recordRecordHistoryCopy(
  tx: CommandTransaction,
  locator: import('../contract/locator.ts').HistoryLocator,
  position: bigint | null = null,
): Promise<void> {
  beginRecordHistorySerialization(tx);
  await recordCommandRecordSourceSetCopy(tx, locator, position);
  const command = currentCommand(tx);
  const { encodeLocator } = await import('../contract/locator.ts');
  const encoded = Buffer.from(encodeLocator(locator));
  for (const source of commandRecordSources(tx))
    await tx.query(
      `INSERT INTO core.record_history_locator
       (source_key,partition_no,artifact_type,locator,original_transaction,original_position,producer_version)
       VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT DO NOTHING`,
      [
        recordHistorySourceKey(source),
        command.partition,
        locator.artifactType,
        encoded,
        command.transactionId,
        position?.toString() ?? null,
      ],
    );
}

/** The fence closes native provenance for work staged before the generated log position existed. */
export async function finalizeCommandRecordSources(tx: CommandTransaction, position: bigint): Promise<void> {
  await finalizeCommandRecordSourceSet(tx, position);
  if (!commandRecordSources(tx).length) return;
  const command = currentCommand(tx);
  await tx.query(
    `UPDATE core.record_history_locator SET original_position=$3
     WHERE partition_no=$1 AND original_transaction=$2 AND original_position IS NULL`,
    [command.partition, command.transactionId, position.toString()],
  );
}
