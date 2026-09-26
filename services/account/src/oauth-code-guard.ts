import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

/** Better Auth 1.7.5 deletes tokens linked to a code when that code is replayed.
 * Serialize the Account code boundary and reject a consumed code before that
 * cleanup runs. The transaction lock spans the provider exchange, including its
 * verification consumption and token write, across Account replicas. The form
 * parse is O(request bytes); the lock and verification index lookup are O(1)
 * owner operations, independent of retained account/token history. */
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
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [identifier]);
    const pending = await client.query('SELECT 1 FROM public.verification WHERE identifier = $1',
      [identifier]);
    if (!pending.rowCount) return invalidGrant();
    return await exchange();
  } catch { return unavailable(); }
  finally {
    try { await client.query('ROLLBACK'); } catch { /* preserve the exchange result */ }
    client.release();
  }
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
