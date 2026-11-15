import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { nativeUnitContext, NATIVE_UNIT_CONTEXT_VARIABLE, NATIVE_UNIT_RUN_VARIABLE } from './native-unit-context.ts';
import {
  checkRunNativeReceiptDigest,
  validateCheckRunFinalSettlement,
  type CheckRunInvocationRecord,
} from '../../../scripts/check-run-settlement.ts';
import { parseRemotePhysicalRunReceipt } from '../../../scripts/remote-check.ts';
import { configureDatabaseBusyTimeout, databaseStage } from './db.ts';

/** Capture observations describe these receipts, never all code executed by an outer command. */
export function recordNativeUnitSourceObservation(
  environment: Record<string, string | undefined>,
  record: CheckRunInvocationRecord,
  physicalReceipt: unknown,
  priority: 'landing' | 'critical' | null = null,
): 'recorded' | 'unmatched' | 'unavailable' {
  let db: Database | undefined;
  try {
    const context = nativeUnitContext(environment);
    const runId = environment[NATIVE_UNIT_RUN_VARIABLE];
    if (!context || !runId || !record.final) return 'unmatched';
    const final = validateCheckRunFinalSettlement(record.final);
    const receipt = parseRemotePhysicalRunReceipt(physicalReceipt);
    const environmentHash = createHash('sha256')
      .update(
        JSON.stringify({
          values: Object.entries(environment)
            .filter((entry): entry is [string, string] => entry[1] !== undefined)
            .sort(([left], [right]) => left.localeCompare(right)),
          priority,
        }),
      )
      .digest('hex');
    if (
      !receipt ||
      !final.native ||
      final.binding.sourceMode !== 'committed' ||
      final.binding.sourceRevision !== context.sourceRevision ||
      final.invocationId !== record.invocationId ||
      final.nonce !== record.nonce ||
      final.binding.sourceSha256 !== record.binding.sourceSha256 ||
      final.binding.sourceRevision !== record.binding.sourceRevision ||
      final.binding.semanticEnvironmentSha256 !== environmentHash ||
      final.preparedInputs.status !== 'verified' ||
      final.preparedInputs.sourceSha256 !== final.binding.sourceSha256 ||
      final.cleanup.source !== 'verified' ||
      receipt.host !== final.physical.host ||
      receipt.run !== final.physical.run ||
      record.physical?.host !== receipt.host ||
      record.physical.run !== receipt.run ||
      receipt.exitCode !== final.native.exitCode ||
      checkRunNativeReceiptDigest(receipt) !== final.native.receiptSha256
    )
      return 'unmatched';
    db = new Database(context.registry, { readwrite: true, create: false });
    configureDatabaseBusyTimeout(db);
    const run = db
      .query('SELECT unit, requested_source_commit, context FROM native_unit_runs WHERE id=?')
      .get(runId) as {
      unit: string;
      requested_source_commit: string | null;
      context: string;
    } | null;
    if (!run || run.unit !== context.unit || run.requested_source_commit !== context.sourceRevision) return 'unmatched';
    const requested = nativeUnitContext({ [NATIVE_UNIT_CONTEXT_VARIABLE]: run.context });
    if (
      !requested ||
      [
        'unit',
        'threadId',
        'goalId',
        'worktree',
        'registry',
        'sourceRevision',
        'briefHash',
        'registeredAt',
        'goalObservedAt',
      ].some((field) => requested[field as keyof typeof requested] !== context[field as keyof typeof context])
    )
      return 'unmatched';
    if (JSON.stringify([...requested.requires].sort()) !== JSON.stringify([...context.requires].sort()))
      return 'unmatched';
    databaseStage(db, 'native capture observation commit', () => db!.transaction(() => {
      db!
        .query(`INSERT OR IGNORE INTO native_unit_run_sources(
        run_id, invocation_id, source_commit, source_sha256, host, physical_run, receipt_sha256, native_exit_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          runId,
          final.invocationId,
          final.binding.sourceRevision,
          final.binding.sourceSha256,
          receipt.host,
          receipt.run,
          final.native!.receiptSha256,
          receipt.exitCode,
        );
      db!.query('UPDATE native_unit_runs SET source_commit=? WHERE id=?').run(final.binding.sourceRevision, runId);
    }).immediate());
    return 'recorded';
  } catch (error) {
    // A telemetry failure leaves source unknown; it cannot reject or convert a command result.
    process.stderr.write(
      `native-unit source observation unavailable: ${error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 300) : 'unknown telemetry error'}\n`,
    );
    return 'unavailable';
  } finally {
    db?.close();
  }
}
