import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context';
import type { BetterAuthOptions } from 'better-auth';
import type { Pool, PoolClient } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

type NativeDatabase = Extract<BetterAuthOptions['database'], { db: unknown }>['db'];
export const RECOVERY_COPY_PAGE_SIZE = 48;
export const recoveryCopyRoles = [
  'account_id',
  'erasure_human_id',
  'erasure_operator_id',
  'erasure_client_owner_id',
  'erasure_source_client_owner_id',
] as const;
export type RecoveryCopyRole = (typeof recoveryCopyRoles)[number];
export type RecoveryCopyStatus = 'intent' | 'in-flight' | 'unknown';
export type RecoveryCopyPending = 'recovery-copy-custody' | 'recovery-copy-coverage';
export type RecoveryCopyCode =
  | 'receiving-adapter-unavailable'
  | 'receiving-result-unavailable'
  | 'legacy-void'
  | 'unsupported-result'
  | 'callback-failed'
  | 'callback-timeout';
export type RecoveryCopySource = {
  deliveryId: string;
  producer: 'better-auth-reset/1.8.0-beta.2/source-v1';
  sourceComponent: 'verification';
  createdAt: Date;
  expiresAt: Date;
  roles: Record<RecoveryCopyRole, string | null>;
  sinkGeneration: null;
  custody: 'unknown';
  status: RecoveryCopyStatus;
  code: RecoveryCopyCode;
  attempts: number;
};
export type RecoveryCopyLocator = Pick<RecoveryCopySource, 'deliveryId' | 'status' | 'code' | 'custody'>;
// Original producer identity for the native request only. Durable custody is
// exclusively the committed SQL row, never this ephemeral provenance binding.
export const nativeRecoverySource = new AsyncLocalStorage<{
  accountId: string;
  live: boolean;
  sourceId?: string;
  sourceAmbiguous?: boolean;
}>();

/** Called only inside the supported native adapter's actual INSERT transaction,
 * after its typed role projection and before createWithHooks returns. The SQL
 * trigger reads that very transaction's native row; no hook/caller assertion is
 * accepted as a source. No secret or payload crosses this recording boundary. */
export async function recordNativeRecoveryCopySource(transaction: NativeDatabase, deliveryId: string) {
  if (tryGetCurrentAuthEndpointContext()?.path !== '/request-password-reset') return;
  await transaction.insertInto('auth_recovery_copy_source').values({ delivery_id: deliveryId }).execute();
  const request = nativeRecoverySource.getStore();
  if (request?.live) {
    if (request.sourceId || request.sourceAmbiguous) {
      delete request.sourceId;
      request.sourceAmbiguous = true;
    } else request.sourceId = deliveryId;
  }
}

/** Native exact-key read, deliberately absent from public account routes. */
export async function readRecoveryCopySource(database: Pool, deliveryId: string): Promise<RecoveryCopySource | null> {
  const row = (await database.query('SELECT * FROM auth_recovery_copy_source WHERE delivery_id=$1', [deliveryId]))
    .rows[0];
  if (!row) return null;
  return {
    deliveryId: row.delivery_id,
    producer: row.producer,
    sourceComponent: row.source_component,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    roles: Object.fromEntries(recoveryCopyRoles.map((role) => [role, row[role]])) as RecoveryCopySource['roles'],
    sinkGeneration: null,
    custody: 'unknown',
    status: row.status,
    code: row.code,
    attempts: row.attempts,
  };
}

/** One role and immutable key prefix, <=48 <=1KiB locators / <64KiB.
 * Empty pages are traversal results, never historical or receiving coverage. */
export async function readRecoveryCopySourcePage(
  database: Pool,
  selection: { accountId: string; role: RecoveryCopyRole; after?: string },
): Promise<RecoveryCopyLocator[]> {
  if (!recoveryCopyRoles.includes(selection.role)) throw new Error('Invalid recovery copy role');
  const rows = (
    await database.query(
      `SELECT delivery_id,status,code FROM auth_recovery_copy_source
       WHERE "${selection.role}"=$1 AND delivery_id>$2 ORDER BY delivery_id LIMIT ${RECOVERY_COPY_PAGE_SIZE}`,
      [selection.accountId, selection.after ?? ''],
    )
  ).rows;
  const page: RecoveryCopyLocator[] = [];
  let bytes = 2;
  for (const row of rows) {
    const locator: RecoveryCopyLocator = {
      deliveryId: row.delivery_id,
      status: row.status,
      code: row.code,
      custody: 'unknown',
    };
    // Bound encoded bytes too, including escaping of an unusual native ID.
    bytes += Buffer.byteLength(JSON.stringify(locator)) + (page.length ? 1 : 0);
    if (bytes > 65536) break;
    page.push(locator);
  }
  return page;
}

/** Commit the sole legacy attempt BEFORE I/O. Trigger admission serializes with
 * current erasure. A crash/in-flight callback remains unknown indefinitely;
 * there is no automatic resend without genuine receiving idempotence/lookup. */
export async function beginRecoveryCopyDisclosure(database: Pool, deliveryId: string, accountId: string) {
  const connection = await database.connect();
  try {
    const result = await connection.query(
      `UPDATE auth_recovery_copy_source SET status='in-flight',code='receiving-result-unavailable',
       attempts=1,attempted_at=clock_timestamp()
     WHERE delivery_id=$1 AND account_id=$2 AND status='intent' AND attempts=0
       AND expires_at>clock_timestamp() RETURNING delivery_id`,
      [deliveryId, accountId],
    );
    if (result.rowCount !== 1) throw new Error('Recovery delivery provenance unavailable');
  } finally {
    // The native role lease resets before its real release. Await that promise
    // as well, so the callback cannot retain even this housekeeping lease.
    await connection.release();
  }
}

export async function finishRecoveryCopyDisclosure(database: Pool, deliveryId: string, code: RecoveryCopyCode) {
  await database.query(
    `UPDATE auth_recovery_copy_source SET status='unknown',code=$2
     WHERE delivery_id=$1 AND status='in-flight' AND attempts=1`,
    [deliveryId, code],
  );
}

/** Same native obligation, independent of shared history. Known copies survive
 * verification/proof TTL and erasure; historical sends are never guessed from
 * an empty inventory or absent callback. Each probe uses one role/key index. */
export async function recoveryCopyPendingCode(connection: PoolClient, accountId: string): Promise<RecoveryCopyPending> {
  for (const role of recoveryCopyRoles) {
    if (
      (await connection.query(`SELECT 1 FROM auth_recovery_copy_source WHERE "${role}"=$1 LIMIT 1`, [accountId]))
        .rowCount
    )
      return 'recovery-copy-custody';
  }
  // No historical conversion/receiving closure authority is installed. Missing
  // configuration or even missing coverage storage would still mean unknown.
  return 'recovery-copy-coverage';
}
