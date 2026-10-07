// A public Realm that offers joining, and a Zone whose home and browse the launch
// walk can open. Created through the running Main: Realm settings at creation need
// its Realm administration, which the in-process fixture app does not carry.
// The owner is a separate account from the web member. Creation enrolls the founder,
// so the member would see Joined instead of Join if they owned the Realm.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { SeedApi, SeedApiError } from '../../../scripts/dev/seed/api.ts';

const HANDLE = 'launch-walk';
const ID = 'https://rezics.com/id/';
const iriPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface LaunchWalkFixture {
  /** Public key of the Space. Both the community and the site address use it. */
  handle: string;
  realm: string;
  zone: string;
}

interface WebAuthPublic {
  clientId: string;
  redirectUris: string[];
  resource?: string;
  scope?: string;
  mainBaseUrl?: string;
}

interface AgentProvision {
  agent: string;
  state: 'pending' | 'active' | 'compensating' | 'compensated';
}

interface SpaceReceipt { space: string; realm: string }
interface ZoneConfiguration {
  revision: string;
  configuration: { defaultRealm: string | null };
}
interface ResolvedAddress {
  status: string;
  capabilities?: { realm?: string; zone?: string };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to create the launch walk fixture`);
  return value;
}

function fixtureUuid(name: string): string {
  const hex = createHash('sha256').update(`launch-walk:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function accountOf(token: string): { iss: string; sub: string } {
  const segment = token.split('.')[1];
  if (!segment) throw new Error('Walk owner token is not a bearer assertion');
  const payload = JSON.parse(Buffer.from(segment, 'base64url').toString()) as { iss?: string; sub?: string };
  if (!payload.iss || !payload.sub) throw new Error('Walk owner token has no account');
  return { iss: payload.iss, sub: payload.sub };
}

/** Creation can stay pending while the graph settles. The same key is sent again. */
async function settled<T>(label: string, write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return await write();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!message.includes('pending after retries') || attempt === 11) throw error;
    }
  }
  throw new Error(`${label} stayed pending`);
}

async function grant(pool: Pool, principalId: string, actor: string, scope: string, action: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    const gate = await client.query<{ open: boolean }>(
      'SELECT open FROM access.scope_gate WHERE id = $1 AND dispatch_open', [scope]);
    if (gate.rows[0]?.open !== true) throw new Error(`${scope} is not open`);
    await client.query(
      "INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent') ON CONFLICT DO NOTHING", [actor]);
    const represented = await client.query(`SELECT id FROM access.representation
      WHERE principal_id = $1 AND subject_id = $2 AND action = $3 AND active AND valid_until > now()`,
    [principalId, actor, action]);
    if (!represented.rowCount) await client.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,now() + interval '8 hours')`,
    [fixtureUuid(`representation:${scope}`), principalId, actor, action]);
    const allowed = await client.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active AND valid_until > now()`,
    [actor, scope, action]);
    if (!allowed.rowCount) await client.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`,
    [fixtureUuid(`grant:${scope}`), actor, scope, action]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function resolveReady(main: string, handle: string, realm: string, zone: string): Promise<void> {
  const url = new URL('/v1/addresses/resolve', main);
  url.searchParams.set('scope', 'space');
  url.searchParams.set('key', handle);
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) {
      const body = await response.json() as ResolvedAddress;
      if (body.status === 'resolved' && body.capabilities?.realm === realm && body.capabilities.zone === zone) return;
    } else await response?.body?.cancel();
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`Launch walk address ${handle} did not resolve to its Realm and Zone`);
}

export async function createLaunchWalkFixture(): Promise<LaunchWalkFixture> {
  const runId = process.env.REZICS_QA_RUN_ID ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)) {
    throw new Error('The launch walk fixture writes only into an isolated QA run');
  }
  const published = JSON.parse(readFileSync(required('REZICS_WEB_AUTH_PUBLIC_PATH'), 'utf8')) as WebAuthPublic;
  const redirectUri = published.redirectUris[0];
  if (!published.clientId || !redirectUri || !published.resource || !published.scope || !published.mainBaseUrl) {
    throw new Error('The QA web-auth public fixture is missing its OAuth client or Main origin');
  }
  const api = new SeedApi({
    account: required('ACCOUNT_BASE_URL'),
    accountService: process.env.ACCOUNT_SERVICE_ORIGIN,
    main: published.mainBaseUrl,
    mailpit: required('MAILPIT_URL'),
    clientId: published.clientId,
    redirectUri,
    resource: published.resource,
    scope: published.scope,
    ...(process.env.ACCOUNT_ENROLLMENT_TOKEN ? { enrollmentToken: process.env.ACCOUNT_ENROLLMENT_TOKEN } : {}),
  });
  const owner = await api.signInOrUp({
    name: 'Launch walk owner',
    email: 'launch-walk@example.test',
    password: 'Launch-walk-fixture-password-1',
  });
  const token = await api.token(owner.cookie);
  const provision = await settled('Agent', () => api.post<AgentProvision>('/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Launch walk owner',
  }, token, 'launch-walk:agent'));
  if (provision.state !== 'active' || !iriPattern.test(provision.agent)) {
    throw new Error(`Walk owner agent is ${provision.state}`);
  }
  const actor = provision.agent;
  const account = accountOf(token);
  const pool = new Pool({ connectionString: required('ACCESS_DATABASE_URL') });
  const zone = `${ID}${fixtureUuid(`zone:${runId}`)}`;
  try {
    const principal = await pool.query<{ id: string }>(
      `SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2 AND active`,
      [account.iss, account.sub]);
    const principalId = principal.rows[0]?.id;
    if (!principalId) throw new Error('Walk owner has no Access principal');
    await grant(pool, principalId, actor, 'space:create:root', 'space.create');
    const space = await settled('Realm', () => api.post<SpaceReceipt>('/v1/spaces', {
      profile: 'space-realm-v2',
      name: 'Launch walk',
      handle: HANDLE,
      language: 'en',
      capabilities: ['realm'],
      actingSubject: actor,
      initialSettings: {
        visibility: 'public',
        reviewRequired: false,
        reviewMode: 'open',
        whoMaySubmit: 'members',
        selfJoin: true,
        rules: [{
          id: 'be-kind',
          title: { original: 'en', labels: { en: 'Be kind', ja: '親切に' } },
          body: { original: 'en', labels: {
            en: 'Treat other readers with care.',
            ja: 'ほかの読者に配慮する。',
          } },
          governanceRule: null,
        }],
      },
    }, token, 'launch-walk:space'));
    if (!iriPattern.test(space.space) || !iriPattern.test(space.realm)) {
      throw new Error('Realm creation did not return a Space and a Realm');
    }
    await grant(pool, principalId, actor, `zone:edit:${zone}`, 'zone.edit');
    await settled('Zone', () => api.post('/v1/zones', {
      zone, space: space.space, disclosure: 'public', name: 'Launch walk', language: 'en', actingSubject: actor,
    }, token, 'launch-walk:zone'));
    const zoneId = zone.slice(-36);
    const configuration = await api.get<ZoneConfiguration>(
      `/v1/zones/${zoneId}/configuration?actingSubject=${encodeURIComponent(actor)}`, token);
    if (!iriPattern.test(configuration.revision)) throw new Error('Zone configuration has no head');
    if (configuration.configuration.defaultRealm !== space.realm) {
      await settled('Zone configuration', () => api.put(`/v1/zones/${zoneId}/configuration`, {
        expectedHead: configuration.revision, actingSubject: actor, defaultRealm: space.realm,
      }, token, `launch-walk:config:${configuration.revision.slice(-12)}`));
    }
    await resolveReady(published.mainBaseUrl, HANDLE, space.realm, zone);
    return { handle: HANDLE, realm: space.realm, zone };
  } catch (error) {
    if (error instanceof SeedApiError) throw new Error(`${error.operation}: HTTP ${error.status} ${error.detail}`);
    throw error;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  createLaunchWalkFixture().then(fixture => {
    console.log(JSON.stringify(fixture));
  }).catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
