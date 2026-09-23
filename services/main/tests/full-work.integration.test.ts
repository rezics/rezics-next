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
import { AccessAdmissionRegistry, AdmissionDenied } from '../src/modules/access/admission.ts';
import { mirrorAccountDeletionIntent } from '../src/modules/outbox/account-deletion-journal.ts';
import { AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';
import { initializeFreshGraph, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { metadataWorkEditDigest } from '../src/modules/work/edit.ts';
import { strongRevokeWorkPrincipal, strongRevokeWorkScope } from '../src/modules/work/strong-revoke.ts';

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
    const access = new AccessAdmissionRegistry(pool);
    const config = { baseURL: accountBase, secret: 'full-work-local-integration-secret-value-32',
      resource, pool, operatorUserIds: operators,
      accessDeletionFence: async (subject: string) => {
        const fence = await access.strongDeactivateAccountSubject(`${accountBase}/api/auth`, subject);
        if (fence) await mirrorAccountDeletionIntent(pool!, pool!, fence.principalId, fence.enforcementEpoch);
      } };
    await (await getMigrations(accountAuthOptions(config))).runMigrations();
    const auth = createAccountAuth(config);
    accountApp = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port: accountPort });
    const discovery = await fetch(`${accountBase}/api/auth/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    const metadata = await discovery.json() as { issuer: string; jwks_uri: string };
    const operatorSignUp = await fetch(`${accountBase}/api/auth/sign-up/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: accountBase },
      body: JSON.stringify({ name: 'Account Operator', email: 'operator@example.test',
        password: 'correct horse battery staple' }) });
    expect(operatorSignUp.status).toBe(200);
    const operatorCookie = operatorSignUp.headers.get('set-cookie')!;
    const operator = await operatorSignUp.json() as { user: { id: string } };
    operators.add(operator.user.id);
    const signUp = await fetch(`${accountBase}/api/auth/sign-up/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: accountBase },
      body: JSON.stringify({ name: 'Full Work User', email: 'full-work@example.test', password: 'correct horse battery staple' }) });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers.get('set-cookie')!;
    const user = await signUp.json() as { user: { id: string } };
    const confidential = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: operatorCookie, origin: accountBase }),
      body: { client_name: 'Main verifier', scope: 'work:create', token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['client_credentials'], client_credentials_scopes: ['work:create'] },
    });
    const callback = 'https://rp.rezics.test/callback';
    const publicClient = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: operatorCookie, origin: accountBase }),
      body: { client_name: 'Full Work RP', redirect_uris: [callback], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid work:create work:edit work:read', skip_consent: true, require_pkce: true },
    });
    const pkceVerifier = 'b'.repeat(64);
    const authorize = new URL(`${accountBase}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: publicClient.client_id,
      redirect_uri: callback, scope: 'openid work:create work:edit work:read', state: 'full-work-state',
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
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/003_recovery_fence.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/004_principal_fence.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/005_account_deletion_fence.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/006_account_deletion_journal_scan.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/relay/001_delivery.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/relay/004_account_deletion_journal.sql'), 'utf8'));
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
    mainApp = createMainApp(fuseki, { environment, account: verifier, access })
      .listen({ hostname: '127.0.0.1', port: mainPort });
    const body = { profile: 'metadata-only-v1', title: 'Real authenticated Work', actingSubject: actor };
    const command = (bearer: string, key: string) => fetch(`http://127.0.0.1:${mainPort}/v1/works`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': key,
        'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const created = await command(token, 'real-account-create');
    expect(created.status).toBe(201);
    const result = await created.json() as { work: string; mainVersion: string; workRevision: string;
      sourcePosition: { sequence: string } };
    expect(result.sourcePosition.sequence).toBe('1');
    expect(result.work).toMatch(/^https:\/\/rezics\.com\/id\//);
    const replay = await command(token, 'real-account-create');
    expect(replay.status).toBe(200);
    expect((await replay.json() as { work: string }).work).toBe(result.work);
    const editScope = `work:edit:${result.work}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [editScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.edit', now() + interval '1 hour')`, [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.edit', now() + interval '1 hour')`, [Bun.randomUUIDv7(), actor, editScope]);
    const editBody = { profile: 'metadata-only-v1', work: result.work, expectedHead: result.workRevision,
      title: 'Real authenticated updated Work', actingSubject: actor };
    const edit = (key: string, value = editBody) => fetch(`http://127.0.0.1:${mainPort}/v1/content-edits`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
        'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    const edited = await edit('real-account-edit');
    expect(edited.status).toBe(200);
    const editResult = await edited.json() as { revision: string; predecessor: string; replayed: boolean };
    expect(editResult.predecessor).toBe(result.workRevision);
    expect(editResult.revision).not.toBe(result.workRevision);
    expect(editResult.replayed).toBe(false);
    const editReplay = await edit('real-account-edit');
    expect(editReplay.status).toBe(200);
    expect((await editReplay.json() as { revision: string; replayed: boolean })).toMatchObject({
      revision: editResult.revision, replayed: true,
    });
    const stale = await edit('stale-head-edit', { ...editBody, title: 'Stale attempt' });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { code: string }).code).toBe('stale_head');
    const readScope = `work:read:${result.work}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [readScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.read', now() + interval '1 hour')`, [Bun.randomUUIDv7(), principalId, actor]);
    const readGrant = Bun.randomUUIDv7();
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.read', now() + interval '1 hour')`, [readGrant, actor, readScope]);
    const read = (revision: string) => fetch(`http://127.0.0.1:${mainPort}/v1/revisions/${revision.split('/').at(-1)}?actingSubject=${encodeURIComponent(actor)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const oldRevision = await read(result.workRevision);
    expect(oldRevision.status).toBe(200);
    expect((await oldRevision.json() as { title: string }).title).toBe('Real authenticated Work');
    const currentRevision = await read(editResult.revision);
    expect(currentRevision.status).toBe(200);
    expect((await currentRevision.json() as { title: string; predecessor: string })).toMatchObject({
      title: 'Real authenticated updated Work', predecessor: result.workRevision,
    });
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [readGrant]);
    const hidden = await read(result.workRevision);
    expect(hidden.status).toBe(404);
    await pool.query('UPDATE access.permission_grant SET active = true WHERE id = $1', [readGrant]);
    const pendingTitle = 'Cancelled before edit dispatch';
    const pendingEdit = await access.register({ principal: { issuer: metadata.issuer, subject: user.user.id },
      actingSubject: actor, scope: editScope, action: 'work.edit', idempotencyKey: 'fenced-edit',
      requestDigest: metadataWorkEditDigest(result.work, editResult.revision, pendingTitle) });
    await access.claim(pendingEdit.id, pendingEdit.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, editScope, '0')).toEqual({
      scope: editScope, authorityEpoch: '1', status: 'complete', pending: 0,
    });
    const cancelledEdit = await edit('fenced-edit', { ...editBody,
      expectedHead: editResult.revision, title: pendingTitle });
    expect(cancelledEdit.status).toBe(404);
    const newlyDenied = await edit('after-edit-fence', { ...editBody,
      expectedHead: editResult.revision, title: 'Must not commit' });
    expect(newlyDenied.status).toBe(403);
    const pendingCreate = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: 'work:create:root',
      action: 'work.create', idempotencyKey: 'before-principal-fence',
      requestDigest: metadataWorkRequestDigest('Principal fence pending Work') });
    const deleted = await fetch(`${accountBase}/api/auth/delete-user`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: accountBase },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    expect(deleted.status).toBe(200);
    const principalState = await pool.query<{ active: boolean; enforcement_epoch: string }>(
      'SELECT active, enforcement_epoch FROM access.principal WHERE id = $1', [principalId]);
    expect(principalState.rows[0]).toEqual({ active: false, enforcement_epoch: '1' });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM access.outbox
       WHERE kind = 'account.deletion_fenced' AND principal_id = $1`, [principalId]))
      .rows[0]?.count).toBe('1');
    expect((await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM relay.account_deletion_intent WHERE principal_id = $1',
      [principalId])).rows[0]?.count).toBe('1');
    await expect(access.claim(pendingCreate.id, pendingCreate.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect(await strongRevokeWorkPrincipal(environment, access, principalId, '1')).toEqual({
      principalId, enforcementEpoch: '1', status: 'complete', pending: 0,
    });
    expect(await access.canReadWork({ issuer: metadata.issuer, subject: user.user.id },
      actor, result.work)).toBe(false);
    expect((await pool.query('SELECT id FROM "user" WHERE id = $1', [user.user.id])).rowCount)
      .toBe(0);
    const inactive = await command(token, 'real-account-create');
    expect(inactive.status).toBe(401);
    expect((await inactive.json() as { code: string }).code).toBe('account_assertion_denied');
    expect((await read(result.workRevision)).status).toBe(401);
    const count = await pool.query<{ count: string }>('SELECT count(*) FROM access.admission');
    expect(count.rows[0]!.count).toBe('5');
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
