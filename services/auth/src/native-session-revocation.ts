import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { NativeSessionRevocationBinding, NativeSessionRevocationResultPort } from '@rezics/auth-contract';

const hex = (value: string) => /^[0-9a-f]{64}$/.test(value);
const bounded = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 240 && !value.includes('\0');

function capture(value: NativeSessionRevocationBinding): NativeSessionRevocationBinding {
  const binding = structuredClone(value);
  if (
    Object.keys(binding).sort().join(',') !==
      'accountId,authorizationReceiptId,barrierReceiptId,barrierTransactionId,commandKeyPrefix,continuationDigest,continuationId,minimumAuthnEpoch,operationDigest,operationKey,stepDigest,stepKey' ||
    !Object.values(binding).every(bounded) ||
    !hex(binding.continuationDigest) ||
    !hex(binding.operationDigest) ||
    !hex(binding.stepDigest) ||
    !/^wf:[0-9a-f]{64}$/.test(binding.commandKeyPrefix) ||
    binding.stepKey !== `${binding.commandKeyPrefix}:revoke-auth-sessions` ||
    !/^[1-9][0-9]{0,9}$/.test(binding.minimumAuthnEpoch) ||
    BigInt(binding.minimumAuthnEpoch) > 2147483647n
  )
    throw new Error('Native session revocation binding unavailable');
  return binding;
}

type Query = <Row extends QueryResultRow = QueryResultRow>(
  sql: string,
  values?: unknown[],
) => Promise<QueryResult<Row>>;

/** One physical lease under the caller's original deadline, including acquisition
 * and the Auth producer's release/reset. A late checkout or uncertain query is
 * destroyed; it cannot run a late read or return a busy socket to the pool. */
async function transaction<T>(
  database: Pool,
  deadline: number,
  readOnly: boolean,
  work: (query: Query) => Promise<T>,
): Promise<T> {
  const expired = () => new Error('Native session revocation deadline exceeded');
  const remaining = () => {
    const ms = Math.ceil(deadline - Date.now());
    if (!Number.isFinite(ms) || ms <= 0 || ms > 2147483647) throw expired();
    return ms;
  };
  const budget = remaining();
  let client: PoolClient | undefined;
  let retired = false;
  let releasing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const discard = () => {
    if (!client) return;
    if (releasing) void client.end().catch(() => undefined);
    else client.release(true);
    client = undefined;
  };
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      retired = true;
      discard();
      reject(expired());
    }, budget);
  });
  const run = async () => {
    const connection = await database.connect();
    if (retired) {
      connection.release(true);
      throw expired();
    }
    client = connection;
    const query: Query = (text, values) => {
      if (retired) return Promise.reject(expired());
      return connection.query({ text, values, query_timeout: remaining() });
    };
    await query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
      `${remaining()}ms`,
    ]);
    const result = await work(query);
    await query('COMMIT');
    remaining();
    releasing = true;
    await connection.release();
    client = undefined;
    remaining();
    return result;
  };
  try {
    return await Promise.race([run(), limit]);
  } finally {
    retired = true;
    clearTimeout(timer);
    // Closing the lease also rolls back any interrupted transaction. No cleanup
    // statement is queued behind a query whose wire completion is unknown.
    discard();
  }
}

const receiptId = (binding: NativeSessionRevocationBinding) => `session-revocation:${binding.continuationId}`;
const matches = `account_id=$2 AND purpose='session-revocation' AND minimum_authn_epoch=$3::integer
  AND session_revocation_binding=$4::jsonb AND session_revocation_completed_at IS NOT NULL`;
const operands = (binding: NativeSessionRevocationBinding) => [
  receiptId(binding),
  binding.accountId,
  binding.minimumAuthnEpoch,
  JSON.stringify(binding),
];

/** Native effect and its terminal evidence commit together. Replays first read
 * that original result while holding the same owner lock used by session writes.
 * Later-floor sessions are outside this original revocation's liability. */
export async function revokeNativeSessions(
  database: Pool,
  input: NativeSessionRevocationBinding,
  deadline: number,
): Promise<void> {
  const binding = capture(input);
  await transaction(database, deadline, false, async (query) => {
    await query('SELECT auth_assert_session_capacity($1,true)', [binding.accountId]);
    const existing = await query<{ complete: boolean }>(
      `SELECT (${matches}) AS complete FROM auth_effect_receipt WHERE receipt_id=$1 FOR UPDATE`,
      operands(binding),
    );
    if (existing.rows[0]) {
      if (existing.rows[0].complete !== true) throw new Error('Native session revocation result conflict');
      return;
    }
    await query('DELETE FROM session WHERE "userId"=$1 AND "authnEpoch"<$2::integer', [
      binding.accountId,
      binding.minimumAuthnEpoch,
    ]);
    await query(
      `INSERT INTO auth_effect_receipt
       (receipt_id,account_id,purpose,minimum_authn_epoch,session_revocation_binding,session_revocation_completed_at)
       VALUES ($1,$2,'session-revocation',$3::integer,$4::jsonb,statement_timestamp())`,
      operands(binding),
    );
  });
}

/** Exactly one existing effect-receipt primary key, one boolean, no session read.
 * SQL compares the complete binding before anything crosses the native boundary. */
export function createSessionRevocationResultReader({
  database,
}: {
  database: Pool;
}): NativeSessionRevocationResultPort {
  return {
    async readSessionRevocationResult(input, { deadline }) {
      const binding = capture(input);
      return transaction<'complete' | 'unknown'>(database, deadline, true, async (query) => {
        const result = await query<{ complete: boolean }>(
          `SELECT true AS complete FROM auth_effect_receipt WHERE receipt_id=$1 AND ${matches}`,
          operands(binding),
        );
        return result.rows[0]?.complete === true ? 'complete' : 'unknown';
      });
    },
  };
}
