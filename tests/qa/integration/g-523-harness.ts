import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect } from 'bun:test';
import { AuthorityValues } from './g-903-api-values.ts';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { AccessGrants } from '../../../services/main/src/modules/access/grants.ts';
import { AccessGroups } from '../../../services/main/src/modules/access/groups.ts';
import { AccessRepresentations } from '../../../services/main/src/modules/access/representations.ts';
import { AccessRoles } from '../../../services/main/src/modules/access/roles.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

const root = resolve(import.meta.dir, '../../..');
const scopes =
  'agent:create space:create governance:decide work:read work:edit openid access:manage access:approve access:grant access:represent ' +
  'access:representation-manage access:role work:create';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Account test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

export interface AuthorityUser {
  name: string;
  accountId: string;
  principalId: string;
  token: string;
  sessionCookie: string;
  email: string;
  password: string;
}
export type AuthorityHarness = Awaited<ReturnType<typeof startAgentControlHarness>>;

/** Real Account OAuth, Main routes and cloned Account/Access owners for the
 * G-523 authority-control API tests. Authority facts outside the tested
 * operation are seeded directly as owner rows, as the other Access fixtures do. */
export async function startAgentControlHarness(label: string) {
  if (
    !Bun.env.REZICS_QA_RUN_ID ||
    !Bun.env.FUSEKI_URL ||
    !Bun.env.MAIN_DATA_EPOCH ||
    !Bun.env.MAIN_ROUTING_EPOCH ||
    !Bun.env.ACCOUNT_MAIN_RESOURCE
  ) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `${label}-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access', 'content']);
  const contentPool = new Pool({ connectionString: databases.urls.content });
  const accountPool = new Pool({ connectionString: databases.urls.account });
  let accountClosed = false;
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 8 });
  let accessClosed = false;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({
    baseURL: base,
    secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
    pool: accountPool,
    operatorUserIds: operators,
  });
  const account = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  const signUp = async (name: string) => {
    const email = `${label}-${randomUUID()}@example.test`;
    const password = randomBytes(24).toString('base64url');
    const response = await account.handle(
      new Request(`${base}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email, password }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
  };
  const operator = await signUp('operator');
  operators.add(operator.id);
  const headers = new Headers({ cookie: operator.cookie, origin: base });
  const verifierClient = await auth.api.adminCreateOAuthClient({
    headers,
    body: {
      client_name: `${label} verifier`,
      scope: 'access:grant',
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['client_credentials'],
      client_credentials_scopes: ['access:grant'],
    },
  });
  const redirectUri = 'http://localhost:3000/auth/callback';
  const client = await auth.api.adminCreateOAuthClient({
    headers,
    body: {
      client_name: `${label} native client`,
      application_type: 'native',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      scope: `${scopes} offline_access`,
      skip_consent: true,
      require_pkce: true,
    },
  });
  const codeFor = async (user: { email: string; password: string }, scope: string) => {
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    expect(signIn.status).toBe(200);
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope,
      state: randomUUID(),
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }))
      authorize.searchParams.set(key, value);
    const authorized = await fetch(authorize, {
      headers: { cookie: signIn.headers.get('set-cookie')! },
      redirect: 'manual',
    });
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
    return { code, verifier };
  };
  const exchangeCode = (code: string, verifier: string) =>
    fetch(`${base}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
      }),
    });
  const tokenFor = async (user: { email: string; password: string }, scope: string) => {
    const { code, verifier } = await codeFor(user, scope);
    const exchange = await exchangeCode(code, verifier);
    expect(exchange.status).toBe(200);
    return ((await exchange.json()) as { access_token: string }).access_token;
  };
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const grants = new AccessGrants(accessPool);
  const environment = {
    fuseki,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects'),
  };
  const registry = new AccessAdmissionRegistry(accessPool);
  registry.configureBaseline(fuseki);
  const accountVerifier = new AccountAssertionVerifier({
    issuer: `${base}/api/auth`, audience: Bun.env.ACCOUNT_MAIN_RESOURCE,
    jwksUrl: `${base}/api/auth/jwks`, introspectUrl: `${base}/api/auth/oauth2/introspect`,
    clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret!,
  });
  const admissions = new Map<string, RegisteredAdmission>();
  const register = registry.register.bind(registry);
  registry.register = async input => {
    const admission = await register(input);
    admissions.set(admission.id, admission);
    return admission;
  };
  const pauses: { phase: 'registered' | 'claimed'; ready: (a: RegisteredAdmission) => void;
    released: Promise<void> }[] = [];
  const claim = registry.claim.bind(registry);
  registry.claim = async (id, digest, principal) => {
    const admission = admissions.get(id);
    const pause = admission?.action === 'work.create' ? pauses.shift() : undefined;
    if (!pause) return claim(id, digest, principal);
    const claimed = pause.phase === 'claimed' ? await claim(id, digest, principal) : null;
    pause.ready(admission!);
    await pause.released;
    return claimed ?? claim(id, digest, principal);
  };
  const main = createMainApp(fuseki, {
    environment,
    agentProvisioning: new AgentProvisioning(accessPool, environment),
    realmAdmin: new AccessRealmManagement(accessPool),
    accessPolicy: new AccessPolicyOwner(accessPool),
    libraryStatus: new ReaderLibraryStatusStore(contentPool),
    profiles: new ProfilesAccess(accessPool),
    account: accountVerifier,
    access: registry,
    actingContexts: new AccessActingContexts(accessPool),
    grants,
    groups: new AccessGroups(accessPool),
    roles: new AccessRoles(accessPool),
    representations: new AccessRepresentations(accessPool),
  });
  await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ('work:create:root')
    ON CONFLICT DO NOTHING`);

  const values = new AuthorityValues(main);
  const harness = {
    accessPool,
    accountPool,
    grants,
    accountBase: base,
    accountIssuer: `${base}/api/auth`,
    registry,
    environment,
    accountVerifier,
    /** Pause a real publishing request at a deterministic owner handoff. */
    pauseWorkClaim(phase: 'registered' | 'claimed') {
      let ready!: (a: RegisteredAdmission) => void;
      let resume!: () => void;
      const entered = new Promise<RegisteredAdmission>(resolve => { ready = resolve; });
      const released = new Promise<void>(resolve => { resume = resolve; });
      pauses.push({ phase, ready, released });
      return { entered, resume };
    },
    async user(name: string, scope = scopes, admitted = true): Promise<AuthorityUser> {
      const account = await signUp(name);
      await accountPool.query('UPDATE public."user" SET "emailVerified" = true WHERE id = $1', [account.id]);
      const principalId = randomUUID();
      if (admitted) {
        await accessPool.query(
          `INSERT INTO access.principal (id, account_issuer, account_subject)
          VALUES ($1,$2,$3)`,
          [principalId, `${base}/api/auth`, account.id],
        );
      }
      const token = await tokenFor(account, scope);
      values.user(principalId, token, scope);
      return {
        name,
        accountId: account.id,
        principalId,
        token,
        sessionCookie: account.cookie,
        email: account.email,
        password: account.password,
      };
    },
    tokenFor(user: { email: string; password: string }, scope = scopes): Promise<string> {
      return tokenFor(user, scope);
    },
    codeFor(user: { email: string; password: string }, scope = scopes) {
      return codeFor(user, scope);
    },
    exchangeCode,
    refreshToken(refreshToken: string): Promise<Response> {
      return fetch(`${base}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: client.client_id,
          refresh_token: refreshToken,
          resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
        }),
      });
    },
    accountRequest(path: string, body: object, cookie?: string): Promise<Response> {
      return account.handle(
        new Request(`${base}${path}`, {
          method: 'POST',
          headers: {
            origin: base,
            'content-type': 'application/json',
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
    },
    async renameAccount(user: AuthorityUser, name: string): Promise<number> {
      const response = await account.handle(
        new Request(`${base}/api/auth/update-user`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: user.sessionCookie, origin: base },
          body: JSON.stringify({ name }),
        }),
      );
      return response.status;
    },
    async principalOf(user: AuthorityUser): Promise<string> {
      return (
        await accessPool.query<{ id: string }>(
          `SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2`,
          [`${base}/api/auth`, user.accountId],
        )
      ).rows[0]!.id;
    },
    async agent(): Promise<string> {
      const id = `https://rezics.com/id/${randomUUID()}`;
      await accessPool.query(
        "INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')",
        [id],
      );
      return id;
    },
    async mandate(
      principalId: string,
      subject: string,
      action: string,
      options: { maxPathEdges?: number; until?: string } = {},
    ): Promise<string> {
      const id = randomUUID();
      await accessPool.query(
        `INSERT INTO access.representation (id, principal_id, subject_id,
        action, valid_until, max_path_edges) VALUES ($1,$2,$3,$4,
          CASE WHEN $5 = 'infinity' THEN 'infinity'::timestamptz ELSE now() + $5::interval END, $6)`,
        [id, principalId, subject, action, options.until ?? '2 hours', options.maxPathEdges ?? 0],
      );
      values.mandate(principalId, subject, action);
      return id;
    },
    async grant(
      issuer: string,
      recipient: string,
      action: string,
      until = '2 hours',
    ): Promise<string> {
      const id = randomUUID();
      await accessPool.query(
        `INSERT INTO access.permission_grant (id, issuer_subject,
        recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$3,'work:create:root',$4, now() + $5::interval)`,
        [id, issuer, recipient, action, until],
      );
      return id;
    },
    async epoch(scope = 'work:create:root'): Promise<string> {
      return values.epoch(scope);
    },
    request(
      method: string,
      path: string,
      token: string,
      body?: object,
      key = `${label}-${randomUUID()}`,
    ): Promise<Response> {
      return main.handle(
        new Request(`http://main.local${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    },
    /** Sends a request and returns status plus JSON body. */
    async call<T = Record<string, unknown>>(
      method: string,
      path: string,
      token: string,
      body?: object,
      key?: string,
    ): Promise<{ status: number; body: T }> {
      const response = await harness.request(method, path, token, body, key);
      const result = (await response.json()) as T;
      if (response.status < 300 && result && typeof result === 'object') {
        const value = result as { agent?: string; issuerSubject?: string };
        if (typeof value.agent === 'string') values.created(token, value.agent);
        if (typeof value.issuerSubject === 'string') values.created(token, value.issuerSubject);
      }
      if (response.status === 401) {
        throw new Error(
          `fixture Account token rejected at ${method} ${path}: ${JSON.stringify(result)}`,
        );
      }
      return { status: response.status, body: result };
    },
    /** Copies the isolated Access owner after closing writers, then opens the
     * copy as a recovered owner for exact retained-state assertions. */
    async snapshotAccess(): Promise<Pool> {
      const url = await databases.snapshot('access', async () => {
        await accessPool.end();
        accessClosed = true;
      });
      return new Pool({ connectionString: url, max: 2 });
    },
    async snapshotAccount(): Promise<Pool> {
      const url = await databases.snapshot('account', async () => {
        await account.stop();
        await accountPool.end();
        accountClosed = true;
      });
      return new Pool({ connectionString: url, max: 2 });
    },
    async close(): Promise<void> {
      if (!accountClosed) {
        await account.stop();
        await accountPool.end();
      }
      if (!accessClosed) await accessPool.end();
      await contentPool.end();
      await databases.close();
      rmSync(state, { recursive: true, force: true });
    },
  };
  return harness;
}
