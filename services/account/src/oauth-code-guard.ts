import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/** Better Auth 1.7.5 deletes tokens linked to a code when that code is replayed,
 * and consumes a pending code before it checks the presenting client, redirect,
 * resource and PKCE verifier. Serialize the Account code boundary, reject a
 * consumed code before that cleanup runs, and restore the exact pending code
 * after any exchange that issued no tokens. The transaction lock spans the
 * provider exchange, including its verification consumption and token write,
 * and the restore, across Account replicas. The form parse is O(request bytes);
 * the lock, verification snapshot and restore are O(1) indexed owner operations,
 * independent of retained account/token history. */
export async function guardedAuthorizationCodeExchange(pool: Pool, request: Request,
  exchange: () => Promise<Response>): Promise<Response> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim();
  let grantType: unknown;
  let code: unknown;
  try {
    if (contentType === 'application/x-www-form-urlencoded') {
      const form = new URLSearchParams(await request.clone().text());
      if (form.getAll('grant_type').length !== 1 || form.getAll('code').length > 1) {
        return invalidRequest();
      }
      grantType = form.get('grant_type');
      code = form.get('code');
    } else if (contentType === 'application/json') {
      const json = await request.clone().json();
      if (!json || typeof json !== 'object' || Array.isArray(json)) return invalidRequest();
      grantType = (json as Record<string, unknown>).grant_type;
      code = (json as Record<string, unknown>).code;
    } else {
      return invalidRequest();
    }
  } catch { return invalidRequest(); }
  if (grantType !== 'authorization_code') return exchange();
  if (typeof code !== 'string' || !code) return invalidRequest();
  const identifier = createHash('sha256').update(code).digest('base64url');
  let client;
  try { client = await pool.connect(); }
  catch { return unavailable(); }
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [identifier]);
    const pending = await client.query<{ rows: unknown[] | null }>(
      `SELECT jsonb_agg(to_jsonb(v)) AS rows FROM public.verification v
       WHERE identifier = $1 AND "expiresAt" > now()`, [identifier]);
    const snapshot = pending.rows[0]?.rows;
    if (!snapshot) return invalidGrant();
    let response: Response | undefined;
    try { response = await exchange(); }
    catch { /* restore the pending code below */ }
    if (response?.ok) return response;
    await restorePendingCode(client, identifier, snapshot);
    await client.query('COMMIT');
    committed = true;
    return response ?? unavailable();
  } catch { return unavailable(); }
  finally {
    if (!committed) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the exchange result */ }
    }
    client.release();
  }
}

/** A pending code has no tokens: the provider writes them only while redeeming
 * it, and a rejected exchange never delivered those it wrote before failing.
 * The code returns only while its issuance basis is retained; migration 002
 * keeps that basis instead of rebinding the code to current consent. A lost
 * restore leaves the code consumed, which fails closed. */
async function restorePendingCode(client: PoolClient, identifier: string,
  snapshot: unknown[]): Promise<void> {
  await client.query('DELETE FROM public."oauthAccessToken" WHERE "authorizationCodeId" = $1',
    [identifier]);
  await client.query('DELETE FROM public."oauthRefreshToken" WHERE "authorizationCodeId" = $1',
    [identifier]);
  const basis = await client.query(
    'SELECT 1 FROM public.rezics_oauth_code_basis WHERE id = $1 FOR SHARE', [identifier]);
  if (!basis.rowCount) return;
  await client.query(`INSERT INTO public.verification
    SELECT r.* FROM jsonb_populate_recordset(NULL::public.verification, $1::jsonb) AS r
    WHERE r."expiresAt" > clock_timestamp()
    ON CONFLICT (id) DO NOTHING`, [JSON.stringify(snapshot)]);
}

function invalidRequest(): Response {
  return Response.json({ error: 'invalid_request' }, { status: 400,
    headers: { 'cache-control': 'no-store' } });
}

function invalidGrant(): Response {
  return Response.json({ error: 'invalid_grant' }, { status: 400,
    headers: { 'cache-control': 'no-store' } });
}

function unavailable(): Response {
  return Response.json({ error: 'temporarily_unavailable' }, { status: 503,
    headers: { 'cache-control': 'no-store' } });
}
