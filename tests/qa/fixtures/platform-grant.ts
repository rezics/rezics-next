import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const groupId = /^[a-z][a-z0-9-]{0,63}$/;
const principalIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agentIri = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** The public permission that opens one exposure group. It never grants
 * platform:grant or a platform resource. */
export function platformUsePermission(group: string): string {
  if (!groupId.test(group)) throw new Error('Platform use names an exposure group');
  return `platform:use:${group}`;
}

export interface PlatformGrantSession {
  mainOrigin: string;
  token: string;
  actingSubject: string;
  principalId: string;
}

export interface PlatformUseGrant {
  grantId: string;
  generation: string;
  authorityEpoch: string;
  permission: string;
  principalId: string;
  group: string;
}

interface WebAuthPublic {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUris: string[];
  resource?: string;
  mainBaseUrl?: string;
}

interface WebAuthPrivate {
  member: { email: string; password: string };
  principalId: string;
  actingSubject: string;
}

async function grantBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Platform grant failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) as unknown : {};
}

async function authorityEpoch(session: PlatformGrantSession): Promise<string> {
  const url = new URL('/v1/access/grants', session.mainOrigin);
  url.searchParams.set('issuerSubject', session.actingSubject);
  url.searchParams.set('profile', 'platform-grants-v1');
  const response = await fetch(url, { headers: { authorization: `Bearer ${session.token}` } });
  const body = await grantBody(response) as { authorityEpoch?: string };
  if (!body.authorityEpoch) throw new Error('Platform grant page has no authority epoch');
  return body.authorityEpoch;
}

function grantChange(session: PlatformGrantSession, body: Record<string, unknown>): Promise<Response> {
  return fetch(new URL('/v1/access/grant-changes', session.mainOrigin), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
}

/** Give one principal platform:use for an exposure group, as the stack's
 * first platform administrator. Permanent when validUntil is null. */
export async function grantPlatformUse(session: PlatformGrantSession, principalId: string,
  group: string, validUntil: string | null = null): Promise<PlatformUseGrant> {
  const permission = platformUsePermission(group);
  if (!principalIdPattern.test(principalId)) throw new Error('Platform use recipient must be a principal id');
  if (!agentIri.test(session.actingSubject)) throw new Error('Platform grant issuer must be an agent');
  const grantId = randomUUID();
  const response = await grantChange(session, {
    profile: 'platform-grant-change-v1',
    issuerSubject: session.actingSubject,
    expectedAuthorityEpoch: await authorityEpoch(session),
    action: 'create',
    grantId,
    permission,
    recipient: { principalId },
    validUntil,
  });
  const result = await grantBody(response) as {
    authorityEpoch?: string; grant?: { id?: string; generation?: string };
  };
  if (result.grant?.id !== grantId || !result.grant.generation || !result.authorityEpoch) {
    throw new Error('Platform grant response did not confirm the issued grant');
  }
  return { grantId, generation: result.grant.generation, authorityEpoch: result.authorityEpoch,
    permission, principalId, group };
}

/** Revoke a platform:use grant issued by grantPlatformUse. The authority epoch
 * is read again so a later change is not written over. */
export async function revokePlatformUse(session: PlatformGrantSession,
  grant: { grantId: string; generation: string }): Promise<void> {
  if (!principalIdPattern.test(grant.grantId)) throw new Error('Platform revoke needs the issued grant id');
  const response = await grantChange(session, {
    profile: 'platform-grant-change-v1',
    issuerSubject: session.actingSubject,
    expectedAuthorityEpoch: await authorityEpoch(session),
    action: 'revoke',
    grantId: grant.grantId,
    expectedObjectGeneration: grant.generation,
  });
  const result = await grantBody(response) as { grant?: { id?: string } };
  if (result.grant?.id !== grant.grantId) throw new Error('Platform revoke response did not confirm the grant');
}

/** Sign in the recorded local member and take an access token for the public
 * grant API. The same token can carry follow:read when the caller asks for it. */
export async function platformAdministratorSession(env: NodeJS.ProcessEnv = process.env,
  scope = 'openid access:grant'): Promise<PlatformGrantSession> {
  const publicPath = env.REZICS_WEB_AUTH_PUBLIC_PATH;
  const privatePath = env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!publicPath || !privatePath) {
    throw new Error('Platform administrator session needs the web auth public and private paths');
  }
  const published = JSON.parse(readFileSync(publicPath, 'utf8')) as WebAuthPublic;
  const saved = JSON.parse(readFileSync(privatePath, 'utf8')) as WebAuthPrivate;
  const accountBase = env.ACCOUNT_BASE_URL;
  const resource = env.ACCOUNT_MAIN_RESOURCE ?? published.resource;
  const mainOrigin = env.MAIN_ORIGIN ?? published.mainBaseUrl;
  const redirectUri = published.redirectUris[0];
  if (!accountBase || !resource || !mainOrigin || !redirectUri) {
    throw new Error('Platform administrator session needs Account, Main and a redirect URI');
  }
  if (!agentIri.test(saved.actingSubject) || !principalIdPattern.test(saved.principalId)) {
    throw new Error('Web auth private.json has no platform administrator principal');
  }
  const signIn = await fetch(`${accountBase}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: accountBase },
    body: JSON.stringify({ email: saved.member.email, password: saved.member.password }),
  });
  const cookie = signIn.headers.get('set-cookie');
  if (signIn.status !== 200 || !cookie) {
    const detail = await signIn.text();
    throw new Error(`Platform administrator sign-in failed with HTTP ${signIn.status}: ${detail.slice(0, 300)}`);
  }
  await signIn.body?.cancel();
  const verifier = randomBytes(32).toString('base64url');
  const state = randomUUID();
  const authorize = new URL(published.authorizationEndpoint);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: published.clientId, redirect_uri: redirectUri, scope, state,
    resource, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  })) authorize.searchParams.set(key, value);
  const authorized = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
  const location = authorized.headers.get('location');
  if (authorized.status !== 302 || !location) {
    const detail = await authorized.text();
    throw new Error(`Platform administrator authorization failed with HTTP ${authorized.status}: ${detail.slice(0, 300)}`);
  }
  await authorized.body?.cancel();
  const redirected = new URL(location);
  const code = redirected.searchParams.get('code');
  if (redirected.origin + redirected.pathname !== redirectUri || !code) {
    throw new Error('Platform administrator authorization returned no code');
  }
  const exchange = await fetch(published.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: published.clientId, code,
      redirect_uri: redirectUri, code_verifier: verifier, resource,
    }),
  });
  if (exchange.status !== 200) {
    const detail = await exchange.text();
    throw new Error(`Platform administrator token exchange failed with HTTP ${exchange.status}: ${detail.slice(0, 300)}`);
  }
  const token = (await exchange.json() as { access_token?: string }).access_token;
  if (!token) throw new Error('Platform administrator token exchange returned no access token');
  return { mainOrigin, token, actingSubject: saved.actingSubject, principalId: saved.principalId };
}

/** Issuer recorded for in-process grants. It is an agent the proof can join. */
const recordedIssuer = 'https://rezics.com/id/00000000-0000-4000-8000-000000001328';

export interface PlatformGrantQuerier {
  query(text: string, values?: readonly unknown[]): Promise<{ rows?: readonly unknown[] }>;
}

export interface PlatformGrantDb extends PlatformGrantQuerier {
  connect?(): Promise<PlatformGrantQuerier & { release(): void }>;
}

function missingPrincipal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== '23503') return false;
  const detail = 'detail' in error && typeof error.detail === 'string' ? error.detail : '';
  return detail.includes('principal_id') || detail.includes('assigned_by_principal');
}

async function withGrantClient(db: PlatformGrantDb,
  write: (sql: PlatformGrantQuerier) => Promise<void>): Promise<void> {
  if (!db.connect) {
    await write(db);
    return;
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await write(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Record platform:use for a principal an in-process test already inserted.
 * The exposure proof reads the live permission and its episode, so the test
 * passes AccessExposure on that same access pool to createMainApp. An active
 * unexpired row for the same group is left in place. The principal row is not
 * updated, so an exposure summary cached before this grant stays stale. */
export async function grantRecordedPlatformUse(db: PlatformGrantDb, principalId: string,
  groups: readonly string[], issuerSubject = recordedIssuer): Promise<void> {
  if (groups.length === 0) throw new Error('Platform use names an exposure group');
  const permissions = [...new Set(groups.map(platformUsePermission))];
  if (!principalIdPattern.test(principalId)) throw new Error('Platform use recipient must be a principal id');
  if (!agentIri.test(issuerSubject)) throw new Error('Platform grant issuer must be an agent');
  try {
    await withGrantClient(db, async sql => {
      await sql.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')
        ON CONFLICT DO NOTHING`, [issuerSubject]);
      await sql.query(`INSERT INTO access.scope_gate (id) VALUES ('platform:access') ON CONFLICT DO NOTHING`);
      for (const permission of permissions) {
        const existing = await sql.query(
          `SELECT id FROM access.principal_permission_grant
           WHERE principal_id = $1 AND scope_id = 'platform:access' AND action = $2
             AND active AND valid_until > clock_timestamp()
           LIMIT 1`,
          [principalId, permission]);
        if ((existing.rows?.length ?? 0) > 0) continue;
        const id = randomUUID();
        const receipt = `urn:rezics:access-receipt:${randomBytes(32).toString('hex')}`;
        await sql.query(
          `INSERT INTO access.principal_permission_grant
             (id, issuer_subject, principal_id, scope_id, action, valid_until)
           VALUES ($1, $2, $3, 'platform:access', $4, 'infinity')`,
          [id, issuerSubject, principalId, permission]);
        await sql.query(
          `INSERT INTO access.platform_grant_episode
             (id, principal_grant_id, issuer_subject, permission, scope_id, assigned_by_principal, receipt)
           VALUES ($1, $1, $2, $3, 'platform:access', $4, $5)`,
          [id, issuerSubject, permission, principalId, receipt]);
      }
    });
  } catch (error) {
    if (missingPrincipal(error)) throw new Error('Platform use recipient is not an access principal');
    throw error;
  }
}
