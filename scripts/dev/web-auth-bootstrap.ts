import { signupPolicyFixture } from './signup-policy-fixture.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createAccountAuth } from '../../services/account/src/auth.ts';
import { createAccountApp } from '../../services/account/src/app.ts';
import { installClient, revokeInstallation } from '../../services/account/src/installations.ts';
import { operatorRole, rolePermits } from '../../services/account/src/operators.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { createAgentGraph } from '../../services/main/src/modules/agent/graph.ts';
import { agentProvisionDigest } from '../../services/main/src/modules/agent/provision.ts';
import { repairJoiningFixtureConsent } from '../../services/main/src/modules/access/join-fixture-consent.ts';
import { MAIN_SITE_SCOPE, MAIN_SITE_SCOPES } from '../../apps/web/features/auth/scopes.ts';
import { appEnvironment, readEnv, replacePrivate, savePrivate, stackDirectory } from './config.ts';

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

export interface WebAuthOptions { runId: string; redirectUris: string[]; profile?: 'dev' | 'qa';
  /** An integration fixture owns its directory and already-authorized operator. */
  fixture?: { name: string; operator: OperatorCredentials } }

function authFixtureDirectory(stackDir: string, name = 'web-auth') {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(name)) throw new Error('Invalid web auth fixture name');
  return join(stackDir, name);
}

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
    body: JSON.stringify({ ...signupPolicyFixture, name: `Local ${role}`, email, password }),
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
  if (response.status !== 200 || !cookie) return undefined;
  const accepted = await app.handle(new Request(`${base}/api/account/policies/acceptance`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ acceptedPolicies: signupPolicyFixture.acceptedPolicies }),
  }));
  if (!accepted.ok) throw new Error(`Local operator policy acceptance failed with HTTP ${accepted.status}`);
  await accepted.body?.cancel();
  return { ...operator, cookie };
}

async function grantWorkCreation(pool: Pool, issuer: string, memberId: string,
  actor: string, provision: { id: string; digest: string; dataEpoch: string; sequence: string }): Promise<string> {
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
    const control = randomUUID();
    await client.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity')`, [control, principalId, actor]);
    await client.query(`INSERT INTO access.agent_provision (id, principal_id, idempotency_key,
      request_digest, agent_id, agent_kind, display_name, principal_epoch, state,
      graph_data_epoch, graph_sequence, representation_id)
      VALUES ($1::uuid,$2,$1::text,$3,$4,'person','Local author',0,'active',$5,$6,$7)`,
    [provision.id, principalId, provision.digest, actor, provision.dataEpoch, provision.sequence, control]);
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

/** The primary local member becomes this stack's first platform administrator.
 * Main applies the subject only after that Account principal exists. A caller
 * names the dev or QA profile; a joining fixture must not replace the member. */
function recordStackPlatformAdministrator(stackDir: string, subject: string): Record<string, string> {
  if (!/^[^\s\0]{1,256}$/.test(subject)) throw new Error('Invalid PLATFORM_FIRST_ADMIN_ACCOUNT');
  const composePath = join(stackDir, 'compose.env');
  const compose = readEnv(composePath);
  if (compose.REZICS_STACK_PROFILE !== 'dev' && compose.REZICS_STACK_PROFILE !== 'qa') {
    throw new Error('A first platform administrator is recorded only for a local dev or QA stack');
  }
  if (compose.PLATFORM_FIRST_ADMIN_ACCOUNT && compose.PLATFORM_FIRST_ADMIN_ACCOUNT !== subject) {
    throw new Error('This stack already designates a different first platform administrator');
  }
  if (compose.PLATFORM_FIRST_ADMIN_ACCOUNT !== subject) {
    compose.PLATFORM_FIRST_ADMIN_ACCOUNT = subject;
    replacePrivate(composePath, compose);
  }
  const apps = appEnvironment(compose, stackDir);
  replacePrivate(join(stackDir, 'apps.env'), apps);
  const runtimePath = join(stackDir, 'web-auth', 'runtime.env');
  if (existsSync(runtimePath)) {
    const runtime = readEnv(runtimePath);
    if (runtime.PLATFORM_FIRST_ADMIN_ACCOUNT !== apps.PLATFORM_FIRST_ADMIN_ACCOUNT) {
      replacePrivate(runtimePath, { ...runtime,
        PLATFORM_FIRST_ADMIN_ACCOUNT: apps.PLATFORM_FIRST_ADMIN_ACCOUNT! });
    }
  }
  return apps;
}

/** One-time fixture for a fresh, disposable QA project. Never accepts a production URL. */
export async function bootstrapWebAuth(options: WebAuthOptions): Promise<WebAuthResult> {
  const { runId, redirectUris } = parseWebAuthOptions([
    '--run-id', options.runId, ...options.redirectUris.flatMap(uri => ['--redirect-uri', uri])]);
  const profile = options.profile ?? 'qa';
  if (options.fixture && profile !== 'qa') throw new Error('Named auth fixtures require a QA stack');
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
  const outputDir = authFixtureDirectory(stackDir, options.fixture?.name);
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
    const operator = options.fixture
      ? await signInOperator(app, apps.ACCOUNT_BASE_URL!, options.fixture.operator)
      : bootstrapped.rowCount
      ? await retiredOperator(stackDir, async credentials => {
        const role = await operatorRole(accountPool, credentials.id);
        return role && rolePermits(role, 'clients:manage')
          ? signInOperator(app, apps.ACCOUNT_BASE_URL!, credentials) : undefined;
      })
      : await signUp(app, apps.ACCOUNT_BASE_URL!, 'operator');
    if (!operator) throw new Error('No retired local operator can register the web client; restore its private credentials or use the Account operator API');
    if (!options.fixture && !bootstrapped.rowCount) {
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
    const provisionId = randomUUID();
    const digest = agentProvisionDigest(agent);
    const receipt = await createAgentGraph({ fuseki: new FusekiClient(apps.FUSEKI_URL!,
      apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!),
      lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
      objectDirectory: join(outputDir, 'objects') },
    { id: provisionId, agent: actor, ...agent, digest });
    const principalId = await grantWorkCreation(accessPool, discovery.issuer, member.id, actor,
      { id: provisionId, digest, dataEpoch: receipt.dataEpoch, sequence: receipt.sequence });
    await repairJoiningFixtureConsent(accessPool, principalId, actor);
    // The runtime file is written below, after this subject is on the derived environment.
    const designated = options.profile && !options.fixture
      ? recordStackPlatformAdministrator(stackDir, member.id) : apps;
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
    savePrivate(runtimeEnvPath, { ...designated, ACCOUNT_OPERATOR_USER_IDS: operator.id,
      ACCOUNT_MAIN_CLIENT_ID: mainClient.client_id,
      ACCOUNT_MAIN_CLIENT_SECRET: mainClient.client_secret });
    if (!options.fixture) rmSync(recoveryPath, { force: true });
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

/** Whether the active installation ceiling is exactly the main site's scopes. */
function webInstallationCurrent(registered: { installationScopes?: string[]; installationState?: string }): boolean {
  const requested = new Set(scope.split(' '));
  return registered.installationState === 'active'
    && requested.size === registered.installationScopes?.length
    && (registered.installationScopes?.every(grant => requested.has(grant)) ?? false);
}

/** Whether a stack's registered web client already has today's scopes and grants. */
export function webClientCurrent(registered: { scope: string; grantTypes?: string[]; name?: string;
  installationScopes?: string[]; installationState?: string; firstParty?: boolean; skipConsent?: boolean }): boolean {
  const requested = new Set(scope.split(' '));
  const declared = new Set(registered.scope.split(' '));
  return declared.size === requested.size && [...requested].every(grant => declared.has(grant))
    && registered.name === 'REZICS' && registered.firstParty === true && registered.skipConsent === true
    && webInstallationCurrent(registered)
    && webGrantTypes.every(grant => registered.grantTypes?.includes(grant));
}

/** Fields the client-update API may change. The auth method is omitted so Account keeps any client secret. */
function webClientUpdate(redirectUris: string[]) {
  const registration = webClientRegistration(redirectUris);
  return { client_name: registration.client_name, redirect_uris: registration.redirect_uris,
    grant_types: [...registration.grant_types], scope: registration.scope, skip_consent: registration.skip_consent };
}

export interface WebClientRegistrationState {
  name: string;
  scopes: string[];
  grantTypes: string[];
  installationScopes?: string[];
  installationState?: string;
  installationId?: string;
  firstParty: boolean;
  skipConsent?: boolean;
  disabled?: boolean;
}

export type WebClientReconcileOutcome =
  | { case: 'current' | 'updated'; clientId: string }
  | { case: 'registered'; clientId: string }
  | { case: 'reregistered'; clientId: string; previousClientId: string; reason: string };

/** The Account update path refused this client, so the caller registers another. */
export class WebClientNotUpdatable extends Error {
  constructor(readonly reason: string) {
    super(`Web OAuth client cannot be updated (${reason})`);
    this.name = 'WebClientNotUpdatable';
  }
}

export interface WebClientAccount {
  updateClient(clientId: string, update: ReturnType<typeof webClientUpdate>): Promise<{ client_id: string }>;
  registerClient(registration: ReturnType<typeof webClientRegistration>): Promise<{ client_id: string }>;
  markFirstParty(clientId: string): Promise<void>;
  replaceInstallation(clientId: string, installationId: string | undefined, scopes: readonly string[]): Promise<void>;
}

type WebClientPlan =
  | { action: 'current' }
  | { action: 'update' }
  | { action: 'register' }
  | { action: 'reregister'; reason: string };

function registrationView(registered: WebClientRegistrationState) {
  return { scope: registered.scopes.join(' '), name: registered.name, grantTypes: registered.grantTypes,
    installationScopes: registered.installationScopes, installationState: registered.installationState,
    firstParty: registered.firstParty, skipConsent: registered.skipConsent };
}

function webClientPlan(registered: WebClientRegistrationState | undefined): WebClientPlan {
  if (!registered) return { action: 'register' };
  // A revoked installation cannot take a new ceiling on the same client. A
  // disabled client cannot be re-enabled through the client-update API.
  if (registered.installationState === 'revoked') return { action: 'reregister', reason: 'its installation was revoked' };
  if (registered.disabled) return { action: 'reregister', reason: 'it is disabled' };
  if (webClientCurrent(registrationView(registered))) return { action: 'current' };
  return { action: 'update' };
}

export function webClientReconcileMessage(outcome: WebClientReconcileOutcome): string {
  switch (outcome.case) {
    case 'current': return `Web OAuth client is current: ${outcome.clientId}`;
    case 'updated': return `Web OAuth client updated in place: ${outcome.clientId}`;
    case 'registered': return `Web OAuth client registered: ${outcome.clientId}`;
    case 'reregistered': return `Web OAuth client re-registered because ${outcome.reason}: ${outcome.clientId} (was ${outcome.previousClientId})`;
  }
}

async function registerWebClient(account: WebClientAccount, saved: { clientId: string; redirectUris: string[] },
  reason?: string): Promise<WebClientReconcileOutcome> {
  const created = await account.registerClient(webClientRegistration(saved.redirectUris));
  if (!created.client_id) throw new Error('Account did not issue a web client id');
  await account.markFirstParty(created.client_id);
  return reason
    ? { case: 'reregistered', clientId: created.client_id, previousClientId: saved.clientId, reason }
    : { case: 'registered', clientId: created.client_id };
}

export interface WebClientInstallationChanges {
  declaredScopes(clientId: string): Promise<readonly string[]>;
  revoke(installationId: string): Promise<void>;
  install(clientId: string, scopes: readonly string[], changeKey: string): Promise<void>;
}

const installationScopeToken = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/** Replace the active ceiling with `scopes`. The operator installation route
 * accepts at most 64 scopes, and the site list is longer, so that request is
 * rejected after a revocation would already have committed. `installClient`
 * is the function the route calls once the body is accepted, and it admits
 * every scope the registration declares, which is the ceiling a new client's
 * insert trigger installs. Token and declaration checks run before revocation,
 * so a list the installation would reject does not revoke. */
export async function replaceWebClientInstallation(changes: WebClientInstallationChanges,
  clientId: string, installationId: string | undefined, scopes: readonly string[]): Promise<void> {
  if (!scopes.length || new Set(scopes).size !== scopes.length
    || scopes.some(token => !installationScopeToken.test(token))) {
    throw new Error('installation scopes must be distinct OAuth scope tokens');
  }
  const declared = new Set(await changes.declaredScopes(clientId));
  if (scopes.some(token => !declared.has(token))) {
    throw new Error('installation scopes exceed the App registration');
  }
  if (installationId) await changes.revoke(installationId);
  await changes.install(clientId, [...scopes], randomUUID());
}

async function declaredWebClientScopes(pool: Pool, clientId: string): Promise<string[]> {
  const registered = await pool.query<{ declared: string[] }>(`SELECT
      public.rezics_declared_scopes(scopes, "clientCredentialsScopes") AS declared
    FROM public."oauthClient" WHERE "clientId" = $1`, [clientId]);
  const declared = registered.rows[0]?.declared;
  if (!declared) throw new Error('Web client installation requires a registered client');
  return declared;
}

function webClientInstallationChanges(pool: Pool, operatorUserId: string): WebClientInstallationChanges {
  return {
    declaredScopes: clientId => declaredWebClientScopes(pool, clientId),
    async revoke(installationId) {
      await revokeInstallation(pool, { installationId, operatorUserId });
    },
    async install(clientId, scopes, changeKey) {
      await installClient(pool, { clientId, scopes, changeKey, operatorUserId });
    },
  };
}

/** Bring a dev web client up to the site's scopes and grants. A client update
 * never moves the installation ceiling, so an active ceiling that differs is
 * revoked and installed again. That keeps the client id and any secret. */
export async function reconcileWebClient(account: WebClientAccount,
  saved: { clientId: string; redirectUris: string[] },
  registered: WebClientRegistrationState | undefined): Promise<WebClientReconcileOutcome> {
  const plan = webClientPlan(registered);
  if (plan.action === 'current') return { case: 'current', clientId: saved.clientId };
  if (plan.action === 'register') return registerWebClient(account, saved);
  if (plan.action === 'reregister') return registerWebClient(account, saved, plan.reason);
  if (!registered) throw new Error('Web client update requires a registered client');
  try {
    const updated = await account.updateClient(saved.clientId, webClientUpdate(saved.redirectUris));
    if (updated.client_id !== saved.clientId) {
      throw new Error(`Account changed the web client id from ${saved.clientId} to ${updated.client_id}`);
    }
    await account.markFirstParty(saved.clientId);
    if (!webInstallationCurrent(registered)) {
      if (registered.installationState === 'active' && !registered.installationId) {
        throw new Error('Active web client installation has no id');
      }
      await account.replaceInstallation(saved.clientId, registered.installationId, MAIN_SITE_SCOPES);
    }
    return { case: 'updated', clientId: saved.clientId };
  } catch (error) {
    if (!(error instanceof WebClientNotUpdatable)) throw error;
    return registerWebClient(account, saved, `it cannot be updated (${error.reason})`);
  }
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

async function readWebClientRegistration(pool: Pool, clientId: string): Promise<WebClientRegistrationState | undefined> {
  const registered = await pool.query<{ name: string; scopes: string[] | null; grantTypes: string[] | null;
    skipConsent: boolean | null; disabled: boolean | null; installationId: string | null;
    installationScopes: string[] | null; installationState: string | null; firstParty: boolean }>(`
    SELECT c.name, c.scopes, c."grantTypes", c."skipConsent", c.disabled,
      active.id AS "installationId", active.scopes AS "installationScopes",
      CASE WHEN active.id IS NOT NULL THEN 'active'
           WHEN revoked.id IS NOT NULL THEN 'revoked'
           ELSE NULL END AS "installationState",
      fp.client_id IS NOT NULL AS "firstParty"
    FROM "oauthClient" c
    LEFT JOIN rezics_oauth_installation active
      ON active.client_id = c."clientId" AND active.state = 'active'
    LEFT JOIN LATERAL (
      SELECT id FROM rezics_oauth_installation
      WHERE client_id = c."clientId" AND state = 'revoked' LIMIT 1) revoked ON true
    LEFT JOIN rezics_oauth_first_party_client fp ON fp.client_id = c."clientId"
    WHERE c."clientId" = $1`, [clientId]);
  const row = registered.rows[0];
  if (!row) return undefined;
  return { name: row.name, scopes: row.scopes ?? [], grantTypes: row.grantTypes ?? [],
    skipConsent: row.skipConsent ?? undefined, disabled: row.disabled === true,
    installationId: row.installationId ?? undefined,
    installationScopes: row.installationScopes ?? undefined,
    installationState: row.installationState ?? undefined, firstParty: row.firstParty };
}

/** In-process Account, the same way registration calls the client API. A client
 * update does not move the installation ceiling, and widening it in place would
 * let old tokens gain scopes. The replacement uses the installation functions:
 * the operator route cannot carry the site scope list. */
async function openWebClientAccount(pool: Pool, apps: Record<string, string>,
  operator: { id: string; email: string; password: string }): Promise<WebClientAccount> {
  const operatorIds = new Set([operator.id]);
  const auth = createAccountAuth({ baseURL: apps.ACCOUNT_BASE_URL!, secret: apps.ACCOUNT_SECRET!,
    resource: apps.ACCOUNT_MAIN_RESOURCE!, pool, operatorUserIds: operatorIds });
  const app = createAccountApp(auth, pool, { operatorUserIds: operatorIds });
  const signIn = await app.handle(new Request(`${apps.ACCOUNT_BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: apps.ACCOUNT_BASE_URL! },
    body: JSON.stringify({ email: operator.email, password: operator.password }) }));
  const cookie = signIn.headers.get('set-cookie');
  await signIn.body?.cancel();
  if (signIn.status !== 200 || !cookie) throw new Error(`Local operator sign-in failed with HTTP ${signIn.status}`);
  const headers = new Headers({ cookie, origin: apps.ACCOUNT_BASE_URL! });
  const installation = webClientInstallationChanges(pool, operator.id);
  return {
    async updateClient(clientId, update) {
      let updated: { client_id?: string };
      try {
        updated = await auth.api.adminUpdateOAuthClient({ headers, body: { client_id: clientId, update } });
      } catch (error) {
        const status = typeof error === 'object' && error && 'status' in error
          ? String((error as { status?: unknown }).status) : '';
        // Not the owner, or the row disappeared. Permission and validation
        // failures stay errors so a refused update does not change the client id.
        if (status === 'UNAUTHORIZED' || status === 'NOT_FOUND') throw new WebClientNotUpdatable(status);
        throw error;
      }
      if (!updated?.client_id) throw new Error('Account did not return the web client id');
      if (updated.client_id !== clientId) {
        throw new Error(`Account changed the web client id from ${clientId} to ${updated.client_id}`);
      }
      return { client_id: updated.client_id };
    },
    async registerClient(registration) {
      const created = await auth.api.adminCreateOAuthClient({ headers, body: registration });
      if (!created.client_id) throw new Error('Account did not issue a web client id');
      return { client_id: created.client_id };
    },
    async markFirstParty(clientId) {
      await pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [clientId]);
    },
    async replaceInstallation(clientId, installationId, scopes) {
      await replaceWebClientInstallation(installation, clientId, installationId, scopes);
    },
  };
}

function webClientFileDiffers(saved: { clientId: string; scope: string; grantTypes?: string[] }, clientId: string): boolean {
  const grantsMatch = webGrantTypes.length === (saved.grantTypes?.length ?? 0)
    && webGrantTypes.every(grant => saved.grantTypes?.includes(grant));
  return saved.clientId !== clientId || saved.scope !== scope || !grantsMatch;
}

/** A stack prepared before the main site's current scopes or grants keeps its
 * web client id. The fixture operator updates that client's scopes, grants and
 * first-party installation. A missing client is registered. A revoked or
 * otherwise unupdatable client is registered again, and the log says which.
 * The local person's consent grant is aligned either way.
 * Returns whether the public client id changed. */
export async function upgradeWebClient(options: { runId: string; profile?: 'dev' | 'qa'; fixtureName?: string }): Promise<boolean> {
  const profile = options.profile ?? 'qa';
  const stackDir = stackDirectory(root, profile === 'dev' ? { profile } : { profile, runId: options.runId });
  if (options.fixtureName && profile !== 'qa') throw new Error('Named auth fixtures require a QA stack');
  const authDir = authFixtureDirectory(stackDir, options.fixtureName);
  const publicPath = join(authDir, 'public.json');
  const current = JSON.parse(readFileSync(publicPath, 'utf8')) as {
    clientId: string; redirectUris: string[]; scope: string; grantTypes?: string[] };
  const { operator, principalId, actingSubject, member } = JSON.parse(readFileSync(join(authDir, 'private.json'), 'utf8')) as {
    operator: { id: string; email: string; password: string }; principalId: string; actingSubject: string;
    member?: { id: string } };
  if (options.profile && !options.fixtureName) {
    if (!member?.id) throw new Error('Web auth private.json has no member; the stack cannot designate its first platform administrator');
    recordStackPlatformAdministrator(stackDir, member.id);
  }
  const apps = readEnv(join(stackDir, 'apps.env'));
  requireLocalApps(apps);
  const access = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  try { await repairJoiningFixtureConsent(access, principalId, actingSubject); }
  finally { await access.end(); }
  const pool = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
  try {
    const registered = await readWebClientRegistration(pool, current.clientId);
    const outcome = webClientPlan(registered).action === 'current'
      ? { case: 'current' as const, clientId: current.clientId }
      : await reconcileWebClient(await openWebClientAccount(pool, apps, operator),
        { clientId: current.clientId, redirectUris: current.redirectUris }, registered);
    if (webClientFileDiffers(current, outcome.clientId)) {
      writeFileSync(publicPath, JSON.stringify({ ...current, clientId: outcome.clientId, scope,
        grantTypes: webGrantTypes }, null, 2) + '\n', { mode: 0o600 });
    }
    console.log(webClientReconcileMessage(outcome));
    return outcome.clientId !== current.clientId;
  } finally { await pool.end(); }
}

if (import.meta.main) {
  try {
    const result = await bootstrapWebAuth({ ...parseWebAuthOptions(process.argv.slice(2)), profile: 'qa' });
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
