import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createAccountAuth } from '../../services/account/src/auth.ts';
import { createAccountApp } from '../../services/account/src/app.ts';
import { operatorRole, rolePermits } from '../../services/account/src/operators.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { createAgentGraph } from '../../services/main/src/modules/agent/graph.ts';
import { agentProvisionDigest } from '../../services/main/src/modules/agent/provision.ts';
import { MAIN_SITE_SCOPE, MAIN_SITE_SCOPES } from '../../apps/web/features/auth/scopes.ts';
import { appEnvironment, readEnv, savePrivate, stackDirectory } from './config.ts';

const root = resolve(import.meta.dir, '../..');
const runIdPattern = /^[a-z0-9][a-z0-9-]{0,30}$/;
// The web client's registration is its installation ceiling: the main site's
// scopes, and refresh tokens so a session outlives the access token.
const scope = MAIN_SITE_SCOPE;
const webGrantTypes = ['authorization_code', 'refresh_token'];

export function webClientRegistration(redirectUris: string[]) {
  return { client_name: 'REZICS', application_type: 'native' as const,
    redirect_uris: redirectUris, token_endpoint_auth_method: 'none' as const,
    grant_types: webGrantTypes, scope, skip_consent: true, require_pkce: true };
}

export interface WebAuthOptions { runId: string; redirectUris: string[]; profile?: 'dev' | 'qa' }

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

interface OperatorCredentials { id: string; email: string; password: string }

/** Retired fixtures are private siblings of web-auth, created when the issuer
 * changes. Only a still-authorized operator with working credentials is reused. */
export async function retiredOperator<T>(stackDir: string,
  accept: (operator: OperatorCredentials) => Promise<T | undefined>): Promise<T | undefined> {
  const recoveryPath = join(stackDir, 'web-auth-operator-recovery.json');
  const retiredPaths = readdirSync(stackDir, { withFileTypes: true })
    .filter(item => item.isDirectory() && item.name.startsWith('web-auth.retired-'))
    .sort((a, b) => b.name.localeCompare(a.name))
    .map(entry => join(stackDir, entry.name, 'private.json'));
  for (const path of [recoveryPath, ...retiredPaths]) {
    if (!existsSync(path)) continue;
    let operator: OperatorCredentials | undefined;
    try { operator = (JSON.parse(readFileSync(path, 'utf8')) as { operator?: OperatorCredentials }).operator; }
    catch { continue; }
    if (!operator || ![operator.id, operator.email, operator.password].every(value => typeof value === 'string')) continue;
    const result = await accept(operator);
    if (result !== undefined) return result;
  }
  return undefined;
}

async function signInOperator(app: ReturnType<typeof createAccountApp>, base: string,
  operator: OperatorCredentials): Promise<(OperatorCredentials & { cookie: string }) | undefined> {
  const response = await app.handle(new Request(`${base}/api/auth/sign-in/email`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: operator.email, password: operator.password }),
  }));
  const cookie = response.headers.get('set-cookie');
  await response.body?.cancel();
  return response.status === 200 && cookie ? { ...operator, cookie } : undefined;
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
  const profile = options.profile ?? 'qa';
  const stackDir = stackDirectory(root, profile === 'dev' ? { profile } : { profile, runId });
  const appsPath = join(stackDir, 'apps.env');
  const composePath = join(stackDir, 'compose.env');
  if (!existsSync(appsPath) || !existsSync(composePath)) {
    throw new Error(`Stack ${stackDir} is absent; run stack:up first`);
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
  const recoveryPath = join(stackDir, 'web-auth-operator-recovery.json');
  if (existsSync(outputDir)) {
    if (readdirSync(outputDir).length === 0) rmSync(outputDir, { recursive: true });
    else throw new Error('Web auth already attempted for this QA project; inspect its private files before retrying');
  }
  mkdirSync(outputDir, { mode: 0o700 });
  try {
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
      writeFileSync(join(stackDir, 'web-auth-bootstrap.log'),
        [bootstrap.stdout, bootstrap.stderr, bootstrap.error?.message].filter(Boolean).join('\n'),
        { mode: 0o600 });
      throw new Error('QA owner/graph bootstrap failed; inspect private web-auth-bootstrap.log, then reset this project');
    }
  }

  const accountPool = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  try {
    const operatorIds = new Set<string>();
    const auth = createAccountAuth({ baseURL: apps.ACCOUNT_BASE_URL!, secret: apps.ACCOUNT_SECRET!,
      resource: apps.ACCOUNT_MAIN_RESOURCE!, pool: accountPool, operatorUserIds: operatorIds });
    const app = createAccountApp(auth, accountPool);
    const bootstrapped = await accountPool.query('SELECT 1 FROM rezics_account_operator_bootstrap');
    const operator = bootstrapped.rowCount
      ? await retiredOperator(stackDir, async credentials => {
        const role = await operatorRole(accountPool, credentials.id);
        return role && rolePermits(role, 'clients:manage')
          ? signInOperator(app, apps.ACCOUNT_BASE_URL!, credentials) : undefined;
      })
      : await signUp(app, apps.ACCOUNT_BASE_URL!, 'operator');
    if (!operator) throw new Error('No retired local operator can register the web client; restore its private credentials or use the Account operator API');
    if (!bootstrapped.rowCount) {
      writeFileSync(recoveryPath, JSON.stringify({ operator: { id: operator.id,
        email: operator.email, password: operator.password } }), { mode: 0o600 });
    }
    operatorIds.add(operator.id);
    const headers = new Headers({ cookie: operator.cookie, origin: apps.ACCOUNT_BASE_URL! });
    const mainClient = await auth.api.adminCreateOAuthClient({ headers,
      body: { client_name: 'Local Main introspection', scope: 'work:create',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create'] } });
    if (!mainClient.client_secret) throw new Error('Account did not issue a Main client secret');
    const webClient = await auth.api.adminCreateOAuthClient({ headers,
      body: webClientRegistration(redirectUris) });
    await accountPool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [webClient.client_id]);
    const member = await signUp(app, apps.ACCOUNT_BASE_URL!, 'member');
    // The running Account requires a verified email to sign in; the fixture's own people are verified.
    await accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = ANY($1::text[])',
      [[operator.id, member.id]]);
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
    const agent = { kind: 'person' as const, displayName: 'Local author' };
    await createAgentGraph({ fuseki: new FusekiClient(apps.FUSEKI_URL!,
      apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!),
      lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
      objectDirectory: join(outputDir, 'objects') },
    { id: randomUUID(), agent: actor, ...agent, digest: agentProvisionDigest(agent) });
    const principalId = await grantWorkCreation(accessPool, discovery.issuer, member.id, actor);
    const publicConfigPath = join(outputDir, 'public.json');
    const privateConfigPath = join(outputDir, 'private.json');
    const runtimeEnvPath = join(outputDir, 'runtime.env');
    writeFileSync(publicConfigPath, JSON.stringify({
      issuer: discovery.issuer, authorizationEndpoint: discovery.authorization_endpoint,
      tokenEndpoint: discovery.token_endpoint, resource: apps.ACCOUNT_MAIN_RESOURCE,
      clientId: webClient.client_id, applicationType: 'native', redirectUris,
      scope, grantTypes: webGrantTypes, actingSubject: actor,
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
    rmSync(recoveryPath, { force: true });
    return { publicConfigPath, privateConfigPath, runtimeEnvPath,
      clientId: webClient.client_id, actingSubject: actor };
  } finally {
    await accountPool.end();
    await accessPool.end();
  }
  } catch (error) {
    rmSync(outputDir, { recursive: true, force: true });
    throw error;
  }
}

/** Whether a stack's registered web client already has today's scopes and grants. */
export function webClientCurrent(registered: { scope: string; grantTypes?: string[]; name?: string;
  installationScopes?: string[]; installationState?: string; firstParty?: boolean }): boolean {
  const requested = new Set(scope.split(' '));
  const declared = new Set(registered.scope.split(' '));
  return declared.size === requested.size && [...requested].every(grant => declared.has(grant))
    && registered.name === 'REZICS' && registered.firstParty === true
    && registered.installationState === 'active'
    && requested.size === registered.installationScopes?.length
    && registered.installationScopes.every(grant => requested.has(grant))
    && webGrantTypes.every(grant => registered.grantTypes?.includes(grant));
}

/** A missing or stale installation stops local startup before a browser sees invalid_scope. */
export async function assertWebInstallationReady(apps: Record<string, string>, publicPath: string): Promise<void> {
  const saved = JSON.parse(readFileSync(publicPath, 'utf8')) as { clientId?: string };
  if (!saved.clientId) throw new Error('Web auth public.json has no client ID; run task dev:prepare');
  const account = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
  try {
    const installation = await account.query<{ installationScopes: string[]; registeredScopes: string[];
      grantTypes: string[] }>(`SELECT i.scopes AS "installationScopes", c.scopes AS "registeredScopes",
      c."grantTypes" AS "grantTypes" FROM rezics_oauth_installation i
      JOIN "oauthClient" c ON c."clientId" = i.client_id
      WHERE i.client_id = $1 AND i.state = 'active' AND c.disabled IS NOT TRUE`, [saved.clientId]);
    const installed = installation.rows[0];
    const admitted = new Set(installed?.installationScopes ?? []);
    const registered = new Set(installed?.registeredScopes ?? []);
    const missing = MAIN_SITE_SCOPES.filter(scope => !admitted.has(scope) || !registered.has(scope));
    if (!installed || missing.length || !webGrantTypes.every(grant => installed.grantTypes?.includes(grant))) {
      throw new Error(`Web OAuth client registration or installation does not cover the site's scopes and grants${missing.length
        ? `: ${missing.join(', ')}` : ''}; run task dev:prepare`);
    }
  } finally { await account.end(); }
}

/** A stack prepared before the main site's current scopes or refresh grant
 * keeps a web client whose installation ceiling refuses them. Register a new
 * client with the fixture's operator and point the public config at it; the
 * old client stays installed until the stack is reset. Returns whether it did. */
export async function upgradeWebClient(options: { runId: string; profile?: 'dev' | 'qa' }): Promise<boolean> {
  const profile = options.profile ?? 'qa';
  const stackDir = stackDirectory(root, profile === 'dev' ? { profile } : { profile, runId: options.runId });
  const publicPath = join(stackDir, 'web-auth', 'public.json');
  const current = JSON.parse(readFileSync(publicPath, 'utf8')) as {
    clientId: string; redirectUris: string[]; scope: string; grantTypes?: string[] };
  const { operator } = JSON.parse(readFileSync(join(stackDir, 'web-auth', 'private.json'), 'utf8')) as {
    operator: { id: string; email: string; password: string } };
  const apps = readEnv(join(stackDir, 'apps.env'));
  requireLocalApps(apps);
  const pool = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
  try {
    const registered = await pool.query<{ name: string; scopes: string[]; grantTypes: string[];
      installationScopes: string[] | null; installationState: string | null; firstParty: boolean }>(`
      SELECT c.name, c.scopes, c."grantTypes", i.scopes AS "installationScopes",
        i.state AS "installationState", fp.client_id IS NOT NULL AS "firstParty"
      FROM "oauthClient" c
      LEFT JOIN rezics_oauth_installation i ON i.client_id = c."clientId" AND i.state = 'active'
      LEFT JOIN rezics_oauth_first_party_client fp ON fp.client_id = c."clientId"
      WHERE c."clientId" = $1`, [current.clientId]);
    const installed = registered.rows[0];
    if (installed && webClientCurrent({ scope: installed.scopes.join(' '), name: installed.name,
      grantTypes: installed.grantTypes, installationScopes: installed.installationScopes ?? undefined,
      installationState: installed.installationState ?? undefined, firstParty: installed.firstParty })) return false;
    const auth = createAccountAuth({ baseURL: apps.ACCOUNT_BASE_URL!, secret: apps.ACCOUNT_SECRET!,
      resource: apps.ACCOUNT_MAIN_RESOURCE!, pool, operatorUserIds: new Set([operator.id]) });
    const signIn = await createAccountApp(auth, pool).handle(new Request(
      `${apps.ACCOUNT_BASE_URL}/api/auth/sign-in/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: apps.ACCOUNT_BASE_URL! },
        body: JSON.stringify({ email: operator.email, password: operator.password }) }));
    const cookie = signIn.headers.get('set-cookie');
    await signIn.body?.cancel();
    if (signIn.status !== 200 || !cookie) throw new Error(`Local operator sign-in failed with HTTP ${signIn.status}`);
    const webClient = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie, origin: apps.ACCOUNT_BASE_URL! }),
      body: webClientRegistration(current.redirectUris) });
    await pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [webClient.client_id]);
    if (installed?.name === 'QA-only loopback PKCE') {
      await pool.query('UPDATE "oauthClient" SET name = $1 WHERE "clientId" = $2', ['REZICS', current.clientId]);
      await pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [current.clientId]);
    }
    writeFileSync(publicPath, JSON.stringify({ ...current, clientId: webClient.client_id, scope,
      grantTypes: webGrantTypes }, null, 2) + '\n', { mode: 0o600 });
    return true;
  } finally { await pool.end(); }
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
