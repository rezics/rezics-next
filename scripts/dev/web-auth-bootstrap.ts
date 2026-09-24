import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createAccountAuth } from '../../services/account/src/auth.ts';
import { createAccountApp } from '../../services/account/src/app.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { appEnvironment, readEnv, savePrivate } from './config.ts';

const root = resolve(import.meta.dir, '../..');
const runIdPattern = /^[a-z0-9][a-z0-9-]{0,30}$/;
const scope = 'openid work:create work:read';

export interface WebAuthOptions { runId: string; redirectUris: string[] }

export function parseWebAuthOptions(args: string[]): WebAuthOptions {
  if (args.length < 4 || args.length % 2 !== 0 || args[0] !== '--run-id'
    || !runIdPattern.test(args[1] ?? '')) {
    throw new Error('Usage: bun scripts/dev/web-auth-bootstrap.ts --run-id <qa-run-id> --redirect-uri http://localhost:<port>/<callback> [--redirect-uri <second-loopback-callback>]');
  }
  const redirectUris: string[] = [];
  for (let i = 2; i < args.length; i += 2) {
    if (args[i] !== '--redirect-uri' || !args[i + 1]) throw new Error('Expected --redirect-uri <loopback-callback>');
    const redirectUri = args[i + 1]!;
    let url: URL;
    try { url = new URL(redirectUri); }
    catch { throw new Error('Redirect URI must be an absolute localhost HTTP URL'); }
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
      || !url.port || url.username || url.password || url.search || url.hash
      || url.origin + url.pathname !== redirectUri) {
      throw new Error('Redirect URI must be an exact localhost HTTP callback with an explicit port and no query or fragment');
    }
    if (redirectUris.includes(redirectUri)) throw new Error('Duplicate redirect URI');
    redirectUris.push(redirectUri);
  }
  if (redirectUris.length > 2) throw new Error('At most two local callbacks are supported');
  return { runId: args[1]!, redirectUris };
}

function requireLocalApps(apps: Record<string, string>): void {
  for (const name of ['ACCOUNT_BASE_URL', 'ACCOUNT_DATABASE_URL', 'ACCESS_DATABASE_URL', 'FUSEKI_URL']) {
    const value = apps[name];
    if (!value) throw new Error(`QA stack is missing ${name}`);
    const url = new URL(value);
    if (url.hostname !== '127.0.0.1' || !url.port) {
      throw new Error(`${name} must point to this host's loopback QA stack`);
    }
  }
  if (!apps.ACCOUNT_SECRET || !apps.ACCOUNT_MAIN_RESOURCE || !apps.MAIN_PORT
    || !apps.MAIN_DATA_EPOCH || !apps.MAIN_ROUTING_EPOCH) {
    throw new Error('QA stack is missing Account or Main configuration');
  }
}

async function initializationState(apps: Record<string, string>): Promise<'fresh' | 'ready'> {
  const account = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
  const access = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  try {
    const [accountTable, accessTable, graph] = await Promise.all([
      account.query<{ name: string | null }>('SELECT to_regclass(\'public."user"\') AS name'),
      access.query<{ name: string | null }>('SELECT to_regclass(\'access.principal\') AS name'),
      new FusekiClient(apps.FUSEKI_URL!).query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
        GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product>
          rv:dataEpoch ${JSON.stringify(apps.MAIN_DATA_EPOCH)} ;
          rv:routingEpoch ${JSON.stringify(apps.MAIN_ROUTING_EPOCH)} . } }`),
    ]);
    const states = [Boolean(accountTable.rows[0]?.name), Boolean(accessTable.rows[0]?.name),
      graph.boolean === true];
    if (states.every(Boolean)) return 'ready';
    if (states.every(value => !value)) return 'fresh';
    throw new Error('QA project is partly initialized or has a different graph epoch; reset it');
  } finally {
    await account.end();
    await access.end();
  }
}

async function signUp(app: ReturnType<typeof createAccountApp>, base: string,
  role: string): Promise<{ id: string; email: string; password: string; cookie: string }> {
  const email = `local-${role}-${randomBytes(8).toString('hex')}@example.test`;
  const password = randomBytes(32).toString('base64url');
  const response = await app.handle(new Request(`${base}/api/auth/sign-up/email`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ name: `Local ${role}`, email, password }),
  }));
  const cookie = response.headers.get('set-cookie');
  const body = await response.json() as { user?: { id?: string } };
  if (response.status !== 200 || !body.user?.id || !cookie) {
    throw new Error(`Local ${role} signup failed with HTTP ${response.status}`);
  }
  return { id: body.user.id, email, password, cookie };
}

async function grantWorkCreation(pool: Pool, issuer: string, memberId: string,
  actor: string): Promise<string> {
  const principalId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== true) throw new Error('Access recovery fence is closed');
    await client.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [principalId, issuer, memberId]);
    await client.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT (id) DO NOTHING");
    const gate = await client.query<{ open: boolean }>(
      "SELECT open FROM access.scope_gate WHERE id = 'work:create:root' FOR SHARE");
    if (gate.rows[0]?.open !== true) throw new Error('Work creation gate is closed');
    await client.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    await client.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.create', now() + interval '8 hours')`,
    [randomUUID(), principalId, actor]);
    await client.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, 'work:create:root', 'work.create', now() + interval '8 hours')`,
    [randomUUID(), actor]);
    await client.query('COMMIT');
    return principalId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export interface WebAuthResult {
  publicConfigPath: string;
  privateConfigPath: string;
  runtimeEnvPath: string;
  clientId: string;
  actingSubject: string;
}

/** One-time fixture for a fresh, disposable QA project. Never accepts a production URL. */
export async function bootstrapWebAuth(options: WebAuthOptions): Promise<WebAuthResult> {
  const { runId, redirectUris } = parseWebAuthOptions([
    '--run-id', options.runId, ...options.redirectUris.flatMap(uri => ['--redirect-uri', uri])]);
  const stackDir = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
  const appsPath = join(stackDir, 'apps.env');
  const composePath = join(stackDir, 'compose.env');
  if (!existsSync(appsPath) || !existsSync(composePath)) {
    throw new Error(`QA project rezics-qa-${runId} is absent; run stack:up --profile qa first`);
  }
  const apps = readEnv(appsPath);
  const compose = readEnv(composePath);
  requireLocalApps(apps);
  const expected = appEnvironment(compose, stackDir);
  for (const name of ['ACCOUNT_BASE_URL', 'ACCOUNT_DATABASE_URL', 'ACCESS_DATABASE_URL',
    'FUSEKI_URL', 'ACCOUNT_SECRET', 'ACCOUNT_MAIN_RESOURCE', 'MAIN_DATA_EPOCH',
    'MAIN_ROUTING_EPOCH'] as const) {
    if (apps[name] !== expected[name]) {
      throw new Error(`QA stack ${name} differs from its generated Compose configuration`);
    }
  }
  const outputDir = join(stackDir, 'web-auth');
  if (existsSync(outputDir)) {
    throw new Error('Web auth already attempted for this QA project; reset it and remove its private stack directory before retrying');
  }
  mkdirSync(outputDir, { mode: 0o700 });
  if (await initializationState(apps) === 'fresh') {
    const bootstrapApps = join(outputDir, 'qa-apps.json');
    const bootstrapCompose = join(outputDir, 'qa-compose.json');
    writeFileSync(bootstrapApps, JSON.stringify(apps), { mode: 0o600 });
    writeFileSync(bootstrapCompose, JSON.stringify(compose), { mode: 0o600 });
    const bootstrap = spawnSync('bun', ['scripts/qa/bootstrap.ts', bootstrapApps, bootstrapCompose],
      { cwd: root, encoding: 'utf8', timeout: 180_000 });
    rmSync(bootstrapApps);
    rmSync(bootstrapCompose);
    if (bootstrap.status !== 0 || bootstrap.error) {
      writeFileSync(join(outputDir, 'bootstrap.log'),
        [bootstrap.stdout, bootstrap.stderr, bootstrap.error?.message].filter(Boolean).join('\n'),
        { mode: 0o600 });
      throw new Error('QA owner/graph bootstrap failed; inspect private web-auth/bootstrap.log, then reset and remove this project');
    }
  }

  const accountPool = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  try {
    const operatorIds = new Set<string>();
    const auth = createAccountAuth({ baseURL: apps.ACCOUNT_BASE_URL!, secret: apps.ACCOUNT_SECRET!,
      resource: apps.ACCOUNT_MAIN_RESOURCE!, pool: accountPool, operatorUserIds: operatorIds });
    const app = createAccountApp(auth, accountPool);
    const operator = await signUp(app, apps.ACCOUNT_BASE_URL!, 'operator');
    operatorIds.add(operator.id);
    const headers = new Headers({ cookie: operator.cookie, origin: apps.ACCOUNT_BASE_URL! });
    const mainClient = await auth.api.adminCreateOAuthClient({ headers,
      body: { client_name: 'Local Main introspection', scope: 'work:create',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create'] } });
    if (!mainClient.client_secret) throw new Error('Account did not issue a Main client secret');
    const webClient = await auth.api.adminCreateOAuthClient({ headers,
      body: { client_name: 'QA-only loopback PKCE', application_type: 'native',
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
        scope, skip_consent: true, require_pkce: true } });
    const member = await signUp(app, apps.ACCOUNT_BASE_URL!, 'member');
    const discoveryResponse = await app.handle(new Request(
      `${apps.ACCOUNT_BASE_URL}/api/auth/.well-known/openid-configuration`));
    if (discoveryResponse.status !== 200) throw new Error('Account discovery is unavailable');
    const discovery = await discoveryResponse.json() as { issuer?: string;
      authorization_endpoint?: string; token_endpoint?: string };
    if (discovery.issuer !== `${apps.ACCOUNT_BASE_URL}/api/auth`
      || !discovery.authorization_endpoint || !discovery.token_endpoint) {
      throw new Error('Account discovery differs from the QA issuer');
    }
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const principalId = await grantWorkCreation(accessPool, discovery.issuer, member.id, actor);
    const publicConfigPath = join(outputDir, 'public.json');
    const privateConfigPath = join(outputDir, 'private.json');
    const runtimeEnvPath = join(outputDir, 'runtime.env');
    writeFileSync(publicConfigPath, JSON.stringify({
      issuer: discovery.issuer, authorizationEndpoint: discovery.authorization_endpoint,
      tokenEndpoint: discovery.token_endpoint, resource: apps.ACCOUNT_MAIN_RESOURCE,
      clientId: webClient.client_id, applicationType: 'native', redirectUris,
      scope, actingSubject: actor,
      mainBaseUrl: `http://127.0.0.1:${apps.MAIN_PORT}`,
    }, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(privateConfigPath, JSON.stringify({
      operator: { id: operator.id, email: operator.email, password: operator.password },
      member: { id: member.id, email: member.email, password: member.password },
      principalId, actingSubject: actor,
      mainClient: { id: mainClient.client_id, secret: mainClient.client_secret },
    }, null, 2) + '\n', { mode: 0o600 });
    savePrivate(runtimeEnvPath, { ...apps, ACCOUNT_OPERATOR_USER_IDS: operator.id,
      ACCOUNT_MAIN_CLIENT_ID: mainClient.client_id,
      ACCOUNT_MAIN_CLIENT_SECRET: mainClient.client_secret });
    return { publicConfigPath, privateConfigPath, runtimeEnvPath,
      clientId: webClient.client_id, actingSubject: actor };
  } finally {
    await accountPool.end();
    await accessPool.end();
  }
}

if (import.meta.main) {
  try {
    const result = await bootstrapWebAuth(parseWebAuthOptions(process.argv.slice(2)));
    console.log(`Local public client: ${result.clientId}`);
    console.log(`Acting subject: ${result.actingSubject}`);
    console.log(`Public web config: ${result.publicConfigPath}`);
    console.log(`Private local credentials: ${result.privateConfigPath}`);
    console.log(`Main and Account process environment: ${result.runtimeEnvPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
