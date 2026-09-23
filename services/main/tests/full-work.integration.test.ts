import { test, expect } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { accountAuthOptions, createAccountAuth } from '../../account/src/auth.ts';
import { createAccountApp } from '../../account/src/app.ts';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';
import { initializeFreshGraph, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no free port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('IAM01/IAM07/IAM10/SYS02/G3 partial: real Account to Access to Main HTTP to Fuseki', async () => {
  const fusekiHome = Bun.env.REZICS_FUSEKI_HOME;
  const jenaHome = Bun.env.REZICS_JENA_HOME;
  const javaHome = Bun.env.REZICS_JAVA_HOME;
  if (!fusekiHome || !jenaHome || !javaHome) throw new Error('Set REZICS_FUSEKI_HOME, REZICS_JENA_HOME and REZICS_JAVA_HOME');
  const state = join(root, '.temp', `full-work-${Bun.randomUUIDv7()}`);
  const base = join(state, 'fuseki');
  mkdirSync(join(base, 'databases/rezics/tdb2'), { recursive: true });
  mkdirSync(join(base, 'databases/rezics/lucene'), { recursive: true });
  copyFileSync(join(root, 'docs/operations/examples/fuseki-text.ttl'), join(base, 'fuseki-text.ttl'));
  const fusekiPort = await freePort();
  const fusekiLog = openSync(join(state, 'fuseki.log'), 'w');
  const fusekiProcess = spawn(join(fusekiHome, 'fuseki-server'), [
    '--localhost', `--port=${fusekiPort}`, '--no-cors', '--timeout=10000', `--config=${join(base, 'fuseki-text.ttl')}`,
  ], { cwd: base, env: { ...process.env, JAVA_HOME: javaHome, FUSEKI_HOME: fusekiHome,
    FUSEKI_BASE: base, MAIN: 'main', JVM_ARGS: '-Xms128m -Xmx1g' }, stdio: ['ignore', fusekiLog, fusekiLog] });
  closeSync(fusekiLog);
  const fuseki = new FusekiClient(`http://127.0.0.1:${fusekiPort}/rezics`);
  const pgData = join(state, 'pgdata');
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  let postgresStarted = false;
  let pool: Pool | undefined;
  let accountApp: ReturnType<typeof createAccountApp> | undefined;
  let mainApp: ReturnType<typeof createMainApp> | undefined;
  try {
    for (let i = 0; i < 120; i++) {
      try { if ((await fuseki.query('ASK {}')).boolean === true) break; } catch { /* starting */ }
      if (i === 119) throw new Error('Fuseki did not start');
      await Bun.sleep(250);
    }
    execFileSync('initdb', ['-D', pgData, '-A', 'trust', '--no-instructions'], { cwd: state });
    const pgPort = await freePort();
    execFileSync('pg_ctl', ['-D', pgData, '-l', join(state, 'postgres.log'),
      '-o', `-h 127.0.0.1 -p ${pgPort} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
    postgresStarted = true;
    pool = new Pool({ host: '127.0.0.1', port: pgPort, user: process.env.USER, database: 'postgres' });
    const accountPort = await freePort();
    const accountBase = `http://127.0.0.1:${accountPort}`;
    const resource = 'https://main.rezics.test';
    const operators = new Set<string>();
    const config = { baseURL: accountBase, secret: 'full-work-local-integration-secret-value-32',
      resource, pool, operatorUserIds: operators };
    await (await getMigrations(accountAuthOptions(config))).runMigrations();
    const auth = createAccountAuth(config);
    accountApp = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port: accountPort });
    const discovery = await fetch(`${accountBase}/api/auth/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    const metadata = await discovery.json() as { issuer: string; jwks_uri: string };
    const signUp = await fetch(`${accountBase}/api/auth/sign-up/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: accountBase },
      body: JSON.stringify({ name: 'Full Work User', email: 'full-work@example.test', password: 'correct horse battery staple' }) });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers.get('set-cookie')!;
    const user = await signUp.json() as { user: { id: string } };
    operators.add(user.user.id);
    const confidential = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie, origin: accountBase }),
      body: { client_name: 'Main verifier', scope: 'work:create', token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['client_credentials'], client_credentials_scopes: ['work:create'] },
    });
    const callback = 'https://rp.rezics.test/callback';
    const publicClient = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie, origin: accountBase }),
      body: { client_name: 'Full Work RP', redirect_uris: [callback], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid work:create', skip_consent: true, require_pkce: true },
    });
    const pkceVerifier = 'b'.repeat(64);
    const authorize = new URL(`${accountBase}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: publicClient.client_id,
      redirect_uri: callback, scope: 'openid work:create', state: 'full-work-state',
      code_challenge: createHash('sha256').update(pkceVerifier).digest('base64url'),
      code_challenge_method: 'S256', resource })) authorize.searchParams.set(key, value);
    const authorization = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
    expect(authorization.status).toBe(302);
    const code = new URL(authorization.headers.get('location')!).searchParams.get('code')!;
    const exchange = await fetch(`${accountBase}/api/auth/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: publicClient.client_id,
        code, redirect_uri: callback, code_verifier: pkceVerifier, resource }) });
    expect(exchange.status).toBe(200);
    const token = (await exchange.json() as { access_token: string }).access_token;
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/001_admission.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/002_claim_and_seal.sql'), 'utf8'));
    const principalId = Bun.randomUUIDv7();
    const actor = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)`,
      [principalId, metadata.issuer, user.user.id]);
    await pool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root')");
    await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.create', now() + interval '1 hour')`, [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, 'work:create:root', 'work.create', now() + interval '1 hour')`, [Bun.randomUUIDv7(), actor]);
    const lineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '1' };
    await initializeFreshGraph(fuseki, lineage);
    const environment: WorkActivationEnvironment = { fuseki, lineage,
      objectDirectory: join(state, 'objects'), candidateDirectory: join(state, 'candidates'),
      repositoryRoot: root, jenaHome, javaHome, python: 'python3' };
    const verifier = new AccountAssertionVerifier({ issuer: metadata.issuer, audience: resource,
      jwksUrl: metadata.jwks_uri, introspectUrl: `${accountBase}/api/auth/oauth2/introspect`,
      clientId: confidential.client_id, clientSecret: confidential.client_secret! });
    const mainPort = await freePort();
    mainApp = createMainApp(fuseki, { environment, account: verifier, access: new AccessAdmissionRegistry(pool) })
      .listen({ hostname: '127.0.0.1', port: mainPort });
    const body = { profile: 'metadata-only-v1', title: 'Real authenticated Work', actingSubject: actor };
    const command = (bearer: string, key: string) => fetch(`http://127.0.0.1:${mainPort}/v1/works`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': key,
        'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const created = await command(token, 'real-account-create');
    expect(created.status).toBe(201);
    const result = await created.json() as { work: string; mainVersion: string; sourcePosition: { sequence: string } };
    expect(result.sourcePosition.sequence).toBe('1');
    expect(result.work).toMatch(/^https:\/\/rezics\.com\/id\//);
    const replay = await command(token, 'real-account-create');
    expect(replay.status).toBe(200);
    expect((await replay.json() as { work: string }).work).toBe(result.work);
    const logout = await fetch(`${accountBase}/api/auth/sign-out`, {
      method: 'POST', headers: { cookie, origin: accountBase },
    });
    expect(logout.status).toBe(200);
    const inactive = await command(token, 'real-account-create');
    expect(inactive.status).toBe(401);
    expect((await inactive.json() as { code: string }).code).toBe('account_assertion_denied');
    const count = await pool.query<{ count: string }>('SELECT count(*) FROM access.admission');
    expect(count.rows[0]!.count).toBe('1');
  } finally {
    await mainApp?.stop();
    await accountApp?.stop();
    await pool?.end();
    if (postgresStarted) execFileSync('pg_ctl', ['-D', pgData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    fusekiProcess.kill('SIGTERM');
    if (fusekiProcess.exitCode === null) {
      await new Promise<void>(resolveExit => fusekiProcess.once('exit', () => resolveExit()));
    }
  }
}, 120_000);
