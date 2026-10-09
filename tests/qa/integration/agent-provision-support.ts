import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { signIn } from '../../../scripts/lib/oauth-client.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect } from 'bun:test';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Account port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

export async function agentProvisionHarness(scopes: readonly string[] = ['agent:create', 'work:create']) {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.ACCOUNT_DATABASE_URL
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration or fault/recovery tier');
  }
  const root = resolve(import.meta.dir, '../../..');
  const state = join(root, '.temp', `agent-provision-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
  const accountApp = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });

  async function signUp(name: string) {
    const email = `agent-${name}-${randomUUID()}@example.test`;
    const password = randomBytes(24).toString('base64url');
    const response = await accountApp.handle(new Request(`${base}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ ...signupPolicyFixture, name, email, password }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { user: { id: string } };
    return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
  }
  const operator = await signUp('operator');
  operators.add(operator.id);
  // This QA database outlives each harness; one-time Account bootstrap cannot
  // promote the next test's operator. Seed its durable fixture role explicitly.
  await accountPool.query(`INSERT INTO rezics_account_operator (user_id, role)
    VALUES ($1, 'owner')`, [operator.id]);
  const headers = new Headers({ cookie: operator.cookie, origin: base });
  const verifierClient = await auth.api.adminCreateOAuthClient({ headers, body: {
    client_name: 'Agent provision verifier', scope: scopes.join(' '),
    token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
    client_credentials_scopes: [...scopes] } });
  const redirectUri = 'http://localhost:3000/auth/callback';
  const client = await auth.api.adminCreateOAuthClient({ headers, body: {
    client_name: 'Agent provision native client', application_type: 'native',
    redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'], scope: `openid ${scopes.join(' ')}`,
    skip_consent: true, require_pkce: true } });

  async function tokenFor(user: { email: string; password: string }, scope: string) {
    const signedIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: user.email, password: user.password }) });
    expect(signedIn.status).toBe(200);
    return (await signIn({
      account: base, clientId: client.client_id, redirectUri, scope,
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
    }, signedIn.headers.get('set-cookie')!)).accessToken;
  }
  const user = await signUp('owner');
  const token = await tokenFor(user, 'openid agent:create');
  const wrongScopeToken = await tokenFor(user, 'openid work:create');
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const env: WorkActivationEnvironment = { fuseki,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
      routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects') };
  const verifier = new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
    audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
    introspectUrl: `${base}/api/auth/oauth2/introspect`,
    clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });
  function main(provisioning = new AgentProvisioning(accessPool, env),
    accountVerifier: Pick<AccountAssertionVerifier, 'verify'> = verifier) {
    return createMainApp(fuseki, { environment: env, account: accountVerifier,
      access: new AccessAdmissionRegistry(accessPool), agentProvisioning: provisioning });
  }
  function call(app: ReturnType<typeof main>, bearer: string, key: string,
    body: object) {
    return app.handle(new Request('http://main.local/v1/agents', { method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json',
        'idempotency-key': key }, body: JSON.stringify(body) }));
  }
  return { accountPool, accessPool, accountApp, auth, base, user, token, client, verifierClient, redirectUri,
    wrongScopeToken, fuseki, env, verifier, main, call,
    close: async () => { await accountApp.stop();
      await Promise.all([accountPool.end(), accessPool.end()]);
      rmSync(state, { recursive: true, force: true }); },
  };
}
