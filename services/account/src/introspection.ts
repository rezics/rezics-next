import { decodeProtectedHeader } from 'jose';
import type { Pool } from 'pg';
import { consentBasisActive, tokenScopes } from './consent-fence.ts';
import { installationBasisActive } from './installations.ts';
import { signingKeyAccepts } from './signing-keys.ts';

/** The provider authenticates the introspection caller and verifies the token
 * against its JWKS cache first; that cache can hold a retired key for minutes.
 * This second decision makes the token's signing key generation, installation
 * and consent current at the resource boundary in one read-committed
 * transaction. Each read observes every rotation, retirement, revocation or
 * consent change committed before it; none becomes a serialization failure for
 * live traffic, and the key and installation reads never delay a lifecycle
 * change. Missing database evidence is unavailable, never an allow. Cost:
 * three primary-key reads and one client read, independent of retained key,
 * installation, consent and token history. */
export async function currentIntrospection(pool: Pool, presented: string | null,
  provider: Response): Promise<Response> {
  if (!provider.ok) return provider;
  let payload: Record<string, unknown>;
  try { payload = await provider.clone().json() as Record<string, unknown>; }
  catch { return unavailable(); }
  if (payload.active !== true) return provider;
  const clientId = payload.client_id;
  if (typeof clientId !== 'string' || !presented) return inactive();
  // The pinned provider re-derives custom claims on opaque introspection, which
  // loses the issuance consent and installation. Only signed JWTs carry them.
  let kid: unknown;
  try { kid = decodeProtectedHeader(presented).kid; }
  catch { return inactive(); }
  if (typeof kid !== 'string' || typeof payload.jti !== 'string'
    || !Number.isSafeInteger(payload.iat)) return inactive();
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const active = await signingKeyAccepts(client, kid, payload.iat as number)
        && await installationBasisActive(client, payload, clientId, tokenScopes(payload))
        && await consentBasisActive(client, payload, clientId);
      return active ? provider : inactive();
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  } catch {
    return unavailable();
  }
}

/** RFC 7662 sends the token as a form parameter; the provider also accepts JSON. */
export async function presentedToken(request: Request): Promise<string | null> {
  const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim();
  try {
    if (type === 'application/x-www-form-urlencoded') {
      const tokens = new URLSearchParams(await request.text()).getAll('token');
      return tokens.length === 1 && tokens[0] ? tokens[0] : null;
    }
    if (type === 'application/json') {
      const token = (await request.json() as { token?: unknown } | null)?.token;
      return typeof token === 'string' && token ? token : null;
    }
  } catch { /* an unreadable request has no presented token */ }
  return null;
}

function inactive(): Response {
  return Response.json({ active: false }, { headers: { 'cache-control': 'no-store' } });
}

function unavailable(): Response {
  return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
}
