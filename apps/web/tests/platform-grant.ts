import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Opens one `platform:use:<group>` for the QA web member through the platform
// grant API. The work runs under Bun: Playwright collects this file with Node,
// and the seed client loads the model manifest as JSON, which Node rejects.
// A fresh browser stack never sets PLATFORM_FIRST_ADMIN_ACCOUNT, so nobody
// holds `platform:grant` until the child provisions the fixture operator's
// agent and runs the startup designation. Provision comes first: the
// designation's assignment ceiling attaches to that agent's control subject,
// and with no agent it would sit on an institution the operator cannot issue from.

const groupName = /^[a-z][a-z0-9-]*$/;

/** Grants `platform:use:<group>` to the QA web member. Other journeys call this the same way. */
export async function openPlatformGroup(group: string): Promise<void> {
  if (!groupName.test(group)) throw new Error(`A platform group is a lowercase word: ${group}`);
  const result = spawnSync('bun', [import.meta.filename, group], {
    env: process.env, encoding: 'utf8', timeout: 90_000,
  });
  if (result.status === 0 && !result.error) return;
  const detail = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim();
  throw new Error(detail || `Opening platform group ${group} failed (${result.status})`);
}

const operatorAgentKey = 'platform-grant:operator-person';

interface WebAuthPublic {
  issuer: string;
  clientId: string;
  redirectUris: string[];
  resource: string;
  scope: string;
  mainBaseUrl: string;
}

interface WebAuthPrivate {
  operator: { id: string; email: string; password: string };
  principalId: string;
}

interface AgentProvision {
  agent: string;
  state: 'pending' | 'active' | 'compensating' | 'compensated';
}

interface PlatformGrantRow {
  permission: string;
  active: boolean;
  recipient: { principalId?: string; groupId?: string };
}

interface PlatformGrantPage {
  authorityEpoch: string;
  grants: PlatformGrantRow[];
  nextCursor: string | null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to open a platform group`);
  return value;
}

function readJson<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function grantsPath(issuerSubject: string, after?: string): string {
  const query = new URLSearchParams({ profile: 'platform-grants-v1', issuerSubject });
  if (after) query.set('after', after);
  return `/v1/access/grants?${query}`;
}

function problemCode(detail: string): string {
  try {
    const body = JSON.parse(detail) as { code?: string };
    return body.code ?? '';
  } catch {
    return '';
  }
}

async function openGroup(group: string): Promise<void> {
  const { Pool } = await import('pg');
  const { SeedApi, SeedApiError } = await import('../../../scripts/dev/seed/api.ts');
  const { AccessPlatformAdministrators } = await import(
    '../../../services/main/src/modules/access/platform-administrator.ts');
  const permission = `platform:use:${group}`;
  const web = readJson<WebAuthPublic>('REZICS_WEB_AUTH_PUBLIC_PATH');
  const fixture = readJson<WebAuthPrivate>('REZICS_WEB_AUTH_PRIVATE_PATH');
  const redirectUri = web.redirectUris[0];
  if (!web.issuer || !web.clientId || !redirectUri || !web.resource || !web.scope || !web.mainBaseUrl) {
    throw new Error('The QA web-auth public fixture is missing its OAuth client or Main origin');
  }
  if (!fixture.operator?.id || !fixture.operator.email || !fixture.operator.password || !fixture.principalId) {
    throw new Error('The QA web-auth private fixture is missing the operator or the member principal');
  }
  const api = new SeedApi({
    account: requiredEnv('ACCOUNT_BASE_URL'),
    accountService: requiredEnv('ACCOUNT_SERVICE_ORIGIN'),
    main: web.mainBaseUrl,
    mailpit: requiredEnv('MAILPIT_URL'),
    clientId: web.clientId,
    redirectUri,
    resource: web.resource,
    scope: web.scope,
    ...(process.env.ACCOUNT_ENROLLMENT_TOKEN ? { enrollmentToken: process.env.ACCOUNT_ENROLLMENT_TOKEN } : {}),
  });
  const session = await api.signInOrUp(fixture.operator);
  if (session.id !== fixture.operator.id) {
    throw new Error('The fixture operator signed in as a different account than the QA web-auth fixture records');
  }
  const token = await api.token(session.cookie);
  const provision = await api.post<AgentProvision>('/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Local administrator',
  }, token, operatorAgentKey);
  if (provision.state !== 'active') {
    throw new Error(`The fixture operator's agent is ${provision.state}; platform grants need an active agent`);
  }
  const page = await grantPage(api, token, provision.agent, web.issuer, fixture.operator.id, Pool, AccessPlatformAdministrators);
  let after: string | null = null;
  let authorityEpoch = page.authorityEpoch;
  for (;;) {
    const current: PlatformGrantPage = after
      ? await api.get<PlatformGrantPage>(grantsPath(provision.agent, after), token)
      : page;
    authorityEpoch = current.authorityEpoch;
    if (current.grants.some(grant => grant.active && grant.permission === permission
      && grant.recipient.principalId === fixture.principalId)) return;
    after = current.nextCursor;
    if (!after) break;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const grantId = randomUUID();
    try {
      await api.post('/v1/access/grant-changes', {
        profile: 'platform-grant-change-v1',
        issuerSubject: provision.agent,
        expectedAuthorityEpoch: authorityEpoch,
        action: 'create',
        grantId,
        permission,
        recipient: { principalId: fixture.principalId },
        validUntil: null,
      }, token, grantId);
      return;
    } catch (error) {
      if (!(error instanceof SeedApiError) || error.status !== 409 || problemCode(error.detail) !== 'grant_stale'
        || attempt === 1) throw error;
      authorityEpoch = (await api.get<PlatformGrantPage>(grantsPath(provision.agent), token)).authorityEpoch;
    }
  }
}

/** The operator can read grants only while holding `platform:grant`. A fresh stack has no holder. */
async function grantPage(api: { get<T>(path: string, token: string): Promise<T> }, token: string,
  issuerSubject: string, accountIssuer: string, operatorId: string,
  Pool: typeof import('pg').Pool,
  Administrators: typeof import('../../../services/main/src/modules/access/platform-administrator.ts').AccessPlatformAdministrators,
): Promise<PlatformGrantPage> {
  const { SeedApiError } = await import('../../../scripts/dev/seed/api.ts');
  const path = grantsPath(issuerSubject);
  try {
    return await api.get<PlatformGrantPage>(path, token);
  } catch (error) {
    if (!(error instanceof SeedApiError) || error.status !== 403) throw error;
    await designateFixtureOperator(accountIssuer, operatorId, Pool, Administrators);
    try {
      return await api.get<PlatformGrantPage>(path, token);
    } catch (again) {
      if (again instanceof SeedApiError && again.status === 403) {
        throw new Error(`The fixture operator still cannot read platform grants after designation. ${again.detail}`);
      }
      throw again;
    }
  }
}

async function designateFixtureOperator(accountIssuer: string, operatorId: string,
  Pool: typeof import('pg').Pool,
  Administrators: typeof import('../../../services/main/src/modules/access/platform-administrator.ts').AccessPlatformAdministrators,
): Promise<void> {
  const pool = new Pool({ connectionString: requiredEnv('ACCESS_DATABASE_URL') });
  try {
    const result = await new Administrators(pool).designateFirst(accountIssuer, operatorId, () => {});
    if (result.status === 'unconfigured') {
      throw new Error('The fixture operator has no account subject to designate as platform administrator');
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  const group = process.argv[2] ?? '';
  if (!groupName.test(group)) throw new Error(`A platform group is a lowercase word: ${group}`);
  await openGroup(group);
}
