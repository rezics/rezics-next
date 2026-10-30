import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import type { BetterAuthOptions } from 'better-auth';
import type { Pool } from 'pg';

export const attemptStatement = readFileSync(new URL('./rate-limit.sql', import.meta.url), 'utf8');
const transport = new AsyncLocalStorage<string>();
const peerHeader = 'x-rezics-auth-peer';

/** Host transport adapter: peer must come from the socket or a verified proxy,
 * never from public HTTP headers. Missing context uses the native shared bucket.
 * This context is operational abuse protection, never authentication evidence.
 */
export function withAuthTransport<T>(peer: string, action: () => T): T {
  if (!isIP(peer)) throw new Error('Auth transport requires a valid peer IP');
  return transport.run(peer, action);
}

/** Strip public identity headers before entering Better Auth's native router. */
export function nativeAttemptRequest(request: Request, issuer: string, path: string): Request {
  const headers = new Headers(request.headers);
  headers.delete(peerHeader);
  const peer = transport.getStore();
  if (peer) headers.set(peerHeader, peer);
  return new Request(`${issuer}/api/auth${path}`, {
    method: request.method,
    headers,
    // The native dispatch hook consumes the original bounded body after charging.
    body: '{}',
  });
}

/** Better Auth owns enablement (production), path resolution, policy selection
 * and admission. Its locked 1.7.12 API calls consume once before plugin hooks.
 * Keep native rolling-window semantics; do not use get/set or a request sweep.
 */
export function nativeAttemptOptions(database: Pool, issuer: string, secret: string) {
  return {
    advanced: { ipAddress: { ipAddressHeaders: [peerHeader] } },
    rateLimit: {
      customRules: {
        '/reset-password': { window: 60, max: 3 },
        '/verify-password': { window: 300, max: 5 },
        '/two-factor/*': { window: 300, max: 5 },
      },
      customStorage: {
        async consume(key: string, rule: { window: number; max: number }) {
          const opaque = createHmac('sha256', secret)
            .update(JSON.stringify([issuer, key]))
            .digest('hex');
          const result = await database.query<{ allowed: boolean; retryAfter: number | null }>(attemptStatement, [
            opaque,
            rule.window,
            rule.max,
          ]);
          if (!result.rows[0]) throw new Error('Auth attempt counter unavailable');
          return result.rows[0];
        },
      },
    },
  } satisfies Pick<BetterAuthOptions, 'advanced' | 'rateLimit'>;
}

/** Invoke from existing bounded maintenance, never from a request. Counter state
 * is retained for 48 hours after the last accepted attempt. UNLOGGED state may
 * disappear after a database crash and is never account/session authority.
 */
export async function pruneAuthAttempts(database: Pool, batch = 1000): Promise<number> {
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 1000) throw new Error('Invalid counter maintenance batch');
  const result = await database.query(
    `WITH expired AS MATERIALIZED (
    SELECT ctid FROM auth_attempt_counter
    WHERE last_request < statement_timestamp() - interval '48 hours'
    ORDER BY last_request, key LIMIT $1 FOR UPDATE SKIP LOCKED
  ) DELETE FROM auth_attempt_counter AS counter USING expired WHERE counter.ctid=expired.ctid`,
    [batch],
  );
  return result.rowCount ?? 0;
}

/** The verified recovery account, never its network address, owns this exact
 * counter association. Both writes and the erasure fence share one transaction;
 * the key remains attributable after an Auth secret generation retires. */
export async function chargeAccountAttempt(
  database: Pool,
  accountId: string,
  key: string,
  window: number,
  maximum: number,
) {
  const connection = await database.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('INSERT INTO auth_attempt_account(account_id,key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
      accountId,
      key,
    ]);
    const result = await connection.query<{ allowed: boolean }>(attemptStatement, [key, window, maximum]);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}
