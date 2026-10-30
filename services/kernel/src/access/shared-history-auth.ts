import type { AuthErasureBarrier, AuthErasureSource, AuthErasureProofPorts } from '@rezics/auth-contract';
import type { Pool, PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import proofRead from './shared-history-auth.sql';

export class AuthHistoryProofDenied extends Error {
  readonly status = 403;
  constructor() {
    super('Auth history proof denied');
  }
}
const deny = () => new AuthHistoryProofDenied();
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
function shape(value: AuthErasureBarrier | AuthErasureSource, source: boolean) {
  const keys = source ? 'accountId,at,continuationId,receiptId,version' : 'accountId,at,version';
  if (
    !value ||
    Object.keys(value).sort().join(',') !== keys ||
    !uuid(value.accountId) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.at !== 'string' ||
    value.at.length > 64 ||
    !Number.isFinite(Date.parse(value.at))
  )
    throw deny();
  if (source && (!uuid((value as AuthErasureSource).continuationId) || !uuid((value as AuthErasureSource).receiptId)))
    throw deny();
}
/** Anchored account-home read. No Auth database handle or maintenance capability crosses this seam. */
async function barrier(client: Pool | PoolClient, accountId: string): Promise<AuthErasureBarrier | null> {
  if (!uuid(accountId)) return null;
  const route = routeOf(accountId);
  if (route === null) return null;
  const result = await client.query<AuthErasureBarrier>(
    `SELECT e.account_id::text AS "accountId",e.version,e.at::text AS at
     FROM access.erasure e WHERE e.route=$1 AND e.account_id=$2
     AND EXISTS (SELECT 1 FROM access.account a WHERE a.route=$1 AND a.account_id=$2
                 AND a.state='deleted' AND a.authn_fenced)`,
    [route, accountId],
  );
  return result.rows[0] ?? null;
}
async function source(
  client: Pool | PoolClient,
  input: { accountId: string; receiptId: string },
): Promise<AuthErasureSource | null> {
  if (!uuid(input.receiptId)) return null;
  const root = await barrier(client, input.accountId);
  if (!root) return null;
  const result = await client.query<{ continuationId: string; receiptId: string }>(
    `SELECT continuation_id::text AS "continuationId",barrier_receipt_id::text AS "receiptId"
     FROM access.committed_continuation c WHERE route=$1 AND account_id=$2 AND barrier_receipt_id=$3
     AND allowlist @> '[{"step":"erase-auth-owner"}]'::jsonb
     AND allowlist @> jsonb_build_array(jsonb_build_object('step','erase-auth-owner','target',$2::text))
     AND EXISTS (SELECT 1 FROM access.committed_continuation_completion d
       WHERE d.route=c.route AND d.continuation_id=c.continuation_id
       AND d.step='erase-auth-owner' AND d.target=$2::text)`,
    [routeOf(input.accountId), input.accountId, input.receiptId],
  );
  const row = result.rows[0];
  return row ? { ...root, ...row } : null;
}
/** Possession of this fixed private binding is the Auth service capability. No principal/participant/scope is accepted. */
export function createAuthHistoryProofBindings(pool: Pool): Required<AuthErasureProofPorts> {
  async function record(value: AuthErasureBarrier | AuthErasureSource, native: boolean): Promise<void> {
    shape(value, native);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Permanent erasure is immutable; account lock orders the proof with home cleanup.
      await client.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE', [
        routeOf(value.accountId),
        value.accountId,
      ]);
      // Even a lost-reply redrive is anchored to the permanent committed
      // erasure and terminal account, never solely to a previously stored proof.
      const root = await barrier(client, value.accountId);
      if (!root || root.version !== value.version || root.at !== value.at) throw deny();
      const previous = (
        await client.query<{ version: number; at: string; continuation_id: string | null; receipt_id: string | null }>(
          'SELECT version,at::text,continuation_id,receipt_id FROM access.auth_history_proof WHERE route=$1 AND account_id=$2 AND phase=$3',
          [routeOf(value.accountId), value.accountId, native ? 'native-consumed' : 'copies-erased'],
        )
      ).rows[0];
      if (previous) {
        const proof = native ? (value as AuthErasureSource) : null;
        if (
          previous.version !== value.version ||
          previous.at !== value.at ||
          previous.continuation_id !== (proof?.continuationId ?? null) ||
          previous.receipt_id !== (proof?.receiptId ?? null)
        )
          throw deny();
        await client.query('COMMIT');
        return;
      }
      const expected = native
        ? await source(client, value as AuthErasureSource)
        : await barrier(client, value.accountId);
      if (
        !expected ||
        expected.version !== value.version ||
        expected.at !== value.at ||
        (native && (expected as AuthErasureSource).continuationId !== (value as AuthErasureSource).continuationId)
      )
        throw deny();
      if (!native) {
        const consumed = await client.query(
          `SELECT 1 FROM access.auth_history_proof WHERE route=$1 AND account_id=$2
           AND phase='native-consumed' AND version=$3 AND at=$4::timestamptz`,
          [routeOf(value.accountId), value.accountId, value.version, value.at],
        );
        if (!consumed.rowCount) throw deny();
      }
      const phase = native ? 'native-consumed' : 'copies-erased';
      const proof = native ? (value as AuthErasureSource) : null;
      await client.query(
        `INSERT INTO access.auth_history_proof(route,account_id,phase,version,at,continuation_id,receipt_id)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          routeOf(value.accountId),
          value.accountId,
          phase,
          value.version,
          value.at,
          proof?.continuationId ?? null,
          proof?.receiptId ?? null,
        ],
      );
      const stored = (
        await client.query<{ version: number; at: string; continuation_id: string | null; receipt_id: string | null }>(
          `SELECT version,at::text,continuation_id,receipt_id FROM access.auth_history_proof
         WHERE route=$1 AND account_id=$2 AND phase=$3`,
          [routeOf(value.accountId), value.accountId, phase],
        )
      ).rows[0];
      if (
        !stored ||
        stored.version !== value.version ||
        stored.at !== value.at ||
        stored.continuation_id !== (proof?.continuationId ?? null) ||
        stored.receipt_id !== (proof?.receiptId ?? null)
      )
        throw deny();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    readAuthErasureBarrier: (id) => barrier(pool, id),
    readAuthErasureSource: (input) => source(pool, input),
    recordAuthNativeConsumption: (input) => record(input, true),
    recordAuthHistoryCompletion: (input) => record(input, false),
  };
}
/** Phase-specific Access reader. Early native consumption never implies copy completion. */
export async function readAuthNativeConsumption(pool: Pool, expected: AuthErasureSource): Promise<boolean> {
  shape(expected, true);
  return (
    (await proofRead.run(pool, {
      route: routeOf(expected.accountId)!,
      account_id: expected.accountId,
      phase: 'native-consumed',
      version: expected.version,
      at: expected.at,
      continuation_id: expected.continuationId,
      receipt_id: expected.receiptId,
    })) !== null
  );
}

/** Final local-copy proof only. Kernel producer/minimizer closure is a separate prerequisite. */
export async function readAuthHistoryCompletion(pool: Pool, expected: AuthErasureBarrier): Promise<boolean> {
  shape(expected, false);
  return (
    (await proofRead.run(pool, {
      route: routeOf(expected.accountId)!,
      account_id: expected.accountId,
      phase: 'copies-erased',
      version: expected.version,
      at: expected.at,
      continuation_id: null,
      receipt_id: null,
    })) !== null
  );
}
