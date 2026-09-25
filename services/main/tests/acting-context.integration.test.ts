import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { accountAuthOptions, createAccountAuth } from '../../account/src/auth.ts';
import { createAccountApp } from '../../account/src/app.ts';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { AccessActingContexts } from '../src/modules/access/contexts.ts';
import { AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('IAM01/IAM03/IAM04 partial: Account and Access check explicit Agents without pooling or tab state', async () => {
  const state = join(root, '.temp', `acting-context-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const pgPort = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${pgPort} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port: pgPort,
    user: process.env.USER, database: 'postgres', max: 8 });
  const accountPort = await freePort();
  const base = `http://127.0.0.1:${accountPort}`;
  const resource = 'https://main.rezics.test';
  const operators = new Set<string>();
  const config = { baseURL: base, secret: 'acting-context-local-secret-with-32-plus-chars',
    resource, pool, operatorUserIds: operators };
  let account: ReturnType<typeof createAccountApp> | undefined;
  try {
    const migration = await getMigrations(accountAuthOptions(config));
    expect(migration.unsafeChanges).toEqual([]);
    expect(migration.schemaProblems).toEqual([]);
    await migration.runMigrations();
    const accessMigrations = join(root, 'services/main/migrations/access');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const file of readdirSync(accessMigrations).filter(file => file.endsWith('.sql')).sort()) {
        await client.query(readFileSync(join(accessMigrations, file), 'utf8'));
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    const auth = createAccountAuth(config);
    account = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port: accountPort });
    const signUp = async (name: string) => {
      const email = `${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${base}/api/auth/sign-up/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email, password }) });
      expect(response.status).toBe(200);
      const body = await response.json() as { user: { id: string } };
      return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    const adminHeaders = new Headers({ cookie: operator.cookie, origin: base });
    const mainClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Acting context Main verifier', scope: 'work:create',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const webClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Acting context browser', application_type: 'native',
        redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid work:create',
        skip_consent: true, require_pkce: true } });
    const first = await signUp('first');
    const second = await signUp('second');
    const tokenFor = async (member: typeof first) => {
      const signedIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: member.email, password: member.password }) });
      expect(signedIn.status).toBe(200);
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: webClient.client_id, redirect_uri: redirectUri,
        scope: 'openid work:create', state: randomUUID(), resource,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })) authorize.searchParams.set(key, value);
      const approved = await fetch(authorize, {
        headers: { cookie: signedIn.headers.get('set-cookie')! }, redirect: 'manual' });
      expect(approved.status).toBe(302);
      const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
      const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code',
          client_id: webClient.client_id, code, redirect_uri: redirectUri,
          code_verifier: verifier, resource }) });
      expect(exchange.status).toBe(200);
      return (await exchange.json() as { access_token: string }).access_token;
    };
    const [firstToken, secondToken] = await Promise.all([tokenFor(first), tokenFor(second)]);
    const principalOne = randomUUID();
    const principalTwo = randomUUID();
    const agents = Array.from({ length: 4 }, () => `https://rezics.com/id/${randomUUID()}`);
    const [agentA, agentB, grantedOnly, representedOnly] = agents as [string, string, string, string];
    for (const [id, member] of [[principalOne, first], [principalTwo, second]] as const) {
      await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1,$2,$3)`, [id, `${base}/api/auth`, member.id]);
    }
    for (const agent of agents) {
      await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [agent]);
    }
    await pool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root')");
    const represent = async (principal: string, agent: string) => pool.query(`
      INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`,
    [randomUUID(), principal, agent]);
    const grant = async (agent: string) => pool.query(`
      INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','work.create',now() + interval '1 hour')`,
    [randomUUID(), agent]);
    await Promise.all([
      represent(principalOne, agentA), represent(principalOne, agentB),
      represent(principalOne, representedOnly), represent(principalTwo, agentA),
      grant(agentA), grant(agentB), grant(grantedOnly),
    ]);
    const fuseki = new FusekiClient('http://127.0.0.1:1/rezics');
    const access = new AccessAdmissionRegistry(pool);
    const main = createMainApp(fuseki, {
      environment: { fuseki, lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
        objectDirectory: state },
      account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`, audience: resource,
        jwksUrl: `${base}/api/auth/jwks`, introspectUrl: `${base}/api/auth/oauth2/introspect`,
        clientId: mainClient.client_id, clientSecret: mainClient.client_secret! }),
      access, actingContexts: new AccessActingContexts(pool),
    });
    const discover = (token: string) => main.handle(new Request(
      'http://main.local/v1/me/acting-contexts?task=work.create',
      { headers: { authorization: `Bearer ${token}` } }));
    expect((await main.handle(new Request(
      'http://main.local/v1/me/acting-contexts?task=work.create'))).status).toBe(401);
    const firstDiscovery = await discover(firstToken);
    expect(firstDiscovery.status).toBe(200);
    const firstBody = await firstDiscovery.json() as { authorityEpoch: string;
      contexts: Array<{ actingSubject: string }> };
    expect(firstBody.contexts.map(item => item.actingSubject).sort())
      .toEqual([agentA, agentB].sort());
    expect(JSON.stringify(firstBody)).not.toContain(principalOne);
    expect(JSON.stringify(firstBody)).not.toContain(principalTwo);
    expect(JSON.stringify(firstBody)).not.toContain(first.id);
    expect(JSON.stringify(firstBody)).not.toContain(second.id);
    const secondDiscovery = await discover(secondToken);
    expect(secondDiscovery.status).toBe(200);
    expect((await secondDiscovery.json() as { contexts: Array<{ actingSubject: string }> })
      .contexts).toEqual([{ actingSubject: agentA }]);
    const check = (token: string, actingSubject: string, expectedAuthorityEpoch = firstBody.authorityEpoch) =>
      main.handle(new Request('http://main.local/v1/me/acting-context-checks', {
        method: 'POST', headers: { 'content-type': 'application/json',
          authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile: 'work-create-acting-context-check-v1',
          task: 'work.create', actingSubject, expectedAuthorityEpoch }),
      }));
    const [tabA, tabB] = await Promise.all([
      check(firstToken, agentA), check(firstToken, agentB),
    ]);
    expect(tabA.status).toBe(200);
    expect(tabB.status).toBe(200);
    expect(await tabA.json()).toMatchObject({ actingSubject: agentA,
      decision: 'eligible-now', reusable: false });
    expect(await tabB.json()).toMatchObject({ actingSubject: agentB,
      decision: 'eligible-now', reusable: false });
    expect((await check(firstToken, agentA)).status).toBe(200);
    expect((await check(secondToken, agentA)).status).toBe(200);
    for (const unavailable of [grantedOnly, representedOnly, `https://rezics.com/id/${randomUUID()}`]) {
      expect((await check(firstToken, unavailable)).status).toBe(403);
    }
    expect((await check(secondToken, agentB)).status).toBe(403);
    // A discovery result is not a capability: both dependency types are read
    // again before a selected Agent can be used for a check.
    await pool.query(`UPDATE access.representation SET active = false, generation = generation + 1
      WHERE principal_id = $1 AND subject_id = $2 AND action = 'work.create'`,
    [principalOne, agentB]);
    expect((await check(firstToken, agentB)).status).toBe(403);
    expect((await check(firstToken, agentA)).status).toBe(200);
    await pool.query(`UPDATE access.permission_grant SET active = false, generation = generation + 1
      WHERE recipient_subject = $1 AND scope_id = 'work:create:root' AND action = 'work.create'`,
    [agentA]);
    expect((await check(firstToken, agentA)).status).toBe(403);
    expect((await check(secondToken, agentA)).status).toBe(403);
    await pool.query(`UPDATE access.permission_grant SET active = true, generation = generation + 1
      WHERE recipient_subject = $1 AND scope_id = 'work:create:root' AND action = 'work.create'`,
    [agentA]);
    expect((await check(firstToken, agentA)).status).toBe(200);
    const beforeClose = await discover(firstToken);
    expect(beforeClose.status).toBe(200);
    expect(await beforeClose.json()).toMatchObject({
      contexts: [{ actingSubject: agentA }],
    });
    const closed = await access.strongCloseScope('work:create:root', firstBody.authorityEpoch);
    expect(closed.authorityEpoch).not.toBe(firstBody.authorityEpoch);
    const fenced = await pool.query<{ open: boolean; dispatch_open: boolean }>(
      "SELECT open, dispatch_open FROM access.scope_gate WHERE id = 'work:create:root'");
    expect(fenced.rows[0]).toMatchObject({ open: false, dispatch_open: false });
    const stale = await check(firstToken, agentA);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'stale_context' });
    expect((await check(firstToken, agentA, closed.authorityEpoch)).status).toBe(403);
    const afterClose = await discover(firstToken);
    expect(afterClose.status).toBe(200);
    expect(await afterClose.json()).toMatchObject({ authorityEpoch: closed.authorityEpoch,
      contexts: [], complete: true });
  } finally {
    if (account) await account.stop();
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
