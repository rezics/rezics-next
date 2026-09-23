import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync,
  readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { accountAuthOptions, createAccountAuth } from '../src/auth.ts';
import { createAccountApp } from '../src/app.ts';
import { AccountAssertionDenied, AccountAssertionVerifier } from
  '../../main/src/modules/account/verify-assertion.ts';
import { assertPgRecoveryFrontier, PgRecoveryFrontierConflict,
  type PgRecoveryFrontier } from '../../main/src/modules/work/pg-recovery-frontier.ts';
import { accountRecoveryCoverage, assertAccountRecoveryCoverage,
  AccountRecoveryCoverageConflict, type AccountRecoveryCoverage } from '../src/recovery-coverage.ts';

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

test('OPS03/IAM10 partial: archived Account WAL retains sign-out enforcement', async () => {
  const state = join(root, '.temp', `account-pitr-${Bun.randomUUIDv7()}`);
  const primaryData = join(state, 'primary');
  const baseBackup = join(state, 'base-backup');
  const incompleteData = join(state, 'incomplete');
  const incompleteArchive = join(state, 'incomplete-wal');
  const restoredData = join(state, 'restored');
  const walArchive = join(state, 'wal-archive');
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(walArchive, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', primaryData, '-A', 'trust', '--no-instructions'], { cwd: state });
  appendFileSync(join(primaryData, 'postgresql.conf'), `\nwal_level = replica\narchive_mode = on\n` +
    `archive_command = 'test ! -e ${walArchive}/%f && cp %p ${walArchive}/%f'\n`);
  const primaryPort = await freePort();
  const accountPort = await freePort();
  const baseURL = `http://127.0.0.1:${accountPort}`;
  const operatorUserIds = new Set<string>();
  const secret = 'account-pitr-local-secret-value-at-least-32';
  let primaryStarted = false;
  let incompleteStarted = false;
  let restoredStarted = false;
  let primary: Pool | undefined;
  let incomplete: Pool | undefined;
  let restored: Pool | undefined;
  let app: ReturnType<typeof createAccountApp> | undefined;
  const startRecovery = async (data: string, archive: string, label: string): Promise<Pool> => {
    cpSync(baseBackup, data, { recursive: true });
    rmSync(join(data, 'pg_wal'), { recursive: true });
    mkdirSync(join(data, 'pg_wal'), { mode: 0o700 });
    appendFileSync(join(data, 'postgresql.auto.conf'),
      `\narchive_mode = off\nrestore_command = 'cp ${archive}/%f %p'\n`);
    writeFileSync(join(data, 'recovery.signal'), '');
    const port = await freePort();
    execFileSync('pg_ctl', ['-D', data, '-l', join(state, `${label}.log`),
      '-o', `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
    if (label === 'incomplete') incompleteStarted = true;
    else restoredStarted = true;
    const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' });
    for (let attempt = 0; attempt < 120; attempt++) {
      const recovering = (await pool.query<{ recovering: boolean }>(
        'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering;
      if (recovering === false) return pool;
      await Bun.sleep(100);
    }
    throw new Error(`${label} PostgreSQL did not complete recovery`);
  };
  const startAccount = (pool: Pool) => {
    const config = { baseURL, secret, resource: 'https://main.rezics.test', pool, operatorUserIds };
    const auth = createAccountAuth(config);
    app = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port: accountPort });
    return { auth, app };
  };
  try {
    execFileSync('pg_ctl', ['-D', primaryData, '-l', join(state, 'primary.log'),
      '-o', `-h 127.0.0.1 -p ${primaryPort} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
    primaryStarted = true;
    primary = new Pool({ host: '127.0.0.1', port: primaryPort, user: process.env.USER,
      database: 'postgres' });
    const config = { baseURL, secret, resource: 'https://main.rezics.test',
      pool: primary, operatorUserIds };
    const migration = await getMigrations(accountAuthOptions(config));
    expect(migration.schemaProblems).toEqual([]);
    await migration.runMigrations();
    const { auth } = startAccount(primary);
    const signUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ name: 'Recovery User', email: 'recovery@example.test',
        password: 'correct horse battery staple' }),
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers.get('set-cookie');
    const signedUp = await signUp.json() as { user?: { id?: string } };
    if (!cookie || !signedUp.user?.id) throw new Error('Account signup did not return a session');
    operatorUserIds.add(signedUp.user.id);
    const callback = 'https://rp.rezics.test/callback';
    const publicClient = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie, origin: baseURL }),
      body: { client_name: 'Recovery RP', redirect_uris: [callback],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
        scope: 'openid work:create', skip_consent: true, require_pkce: true },
    });
    const confidentialClient = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie, origin: baseURL }),
      body: { client_name: 'Recovery introspection', scope: 'work:create',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create'] },
    });
    const pkceVerifier = 'a'.repeat(64);
    const authorize = new URL(`${baseURL}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code',
      client_id: publicClient.client_id, redirect_uri: callback,
      scope: 'openid work:create', state: 'pitr-state',
      code_challenge: createHash('sha256').update(pkceVerifier).digest('base64url'),
      code_challenge_method: 'S256', resource: 'https://main.rezics.test' })) {
      authorize.searchParams.set(key, value);
    }
    const authorized = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code');
    if (!code) throw new Error('Account did not issue an authorization code');
    const exchanged = await fetch(`${baseURL}/api/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code',
        client_id: publicClient.client_id, code, redirect_uri: callback,
        code_verifier: pkceVerifier, resource: 'https://main.rezics.test' }),
    });
    expect(exchanged.status).toBe(200);
    const token = (await exchanged.json() as { access_token: string }).access_token;
    const discovery = await fetch(`${baseURL}/api/auth/.well-known/openid-configuration`);
    const metadata = await discovery.json() as { issuer: string; jwks_uri: string };
    const verifier = new AccountAssertionVerifier({ issuer: metadata.issuer,
      audience: 'https://main.rezics.test', jwksUrl: metadata.jwks_uri,
      introspectUrl: `${baseURL}/api/auth/oauth2/introspect`,
      clientId: confidentialClient.client_id, clientSecret: confidentialClient.client_secret! });
    const userRequest = new Request('https://main.rezics.test/works', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });
    expect((await verifier.verify(userRequest, ['work:create'])).subject).toBe(signedUp.user.id);

    execFileSync('pg_basebackup', ['-D', baseBackup, '-Fp', '-Xs', '--checkpoint=fast',
      '-h', '127.0.0.1', '-p', String(primaryPort), '-U', process.env.USER ?? 'edge'], { cwd: state });
    // The local package lacks pg_waldump; actual WAL replay is checked below.
    execFileSync('pg_verifybackup', ['--no-parse-wal', baseBackup], { cwd: state });
    const signOut = await fetch(`${baseURL}/api/auth/sign-out`, {
      method: 'POST', headers: { cookie, origin: baseURL },
    });
    expect(signOut.status).toBe(200);
    await expect(verifier.verify(userRequest, ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    await app?.stop();
    app = undefined;
    const manifestCommand = join(root, 'services/account/src/recovery-manifest.ts');
    const primaryUrl = `postgres://127.0.0.1:${primaryPort}/postgres?user=${process.env.USER}`;
    const captured = execFileSync(process.execPath, [manifestCommand, 'capture'], {
      cwd: root, env: { ...process.env, ACCOUNT_RECOVERY_DATABASE_URL: primaryUrl }, encoding: 'utf8' });
    const manifest = JSON.parse(captured) as { pg: PgRecoveryFrontier; account: AccountRecoveryCoverage };
    expect(manifest.account.rowCount).toMatch(/^[0-9]+$/);
    const manifestFile = join(state, 'account-manifest.json');
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const frontier = manifest.pg;
    const requiredWal = frontier.walFile;
    await primary.query('SELECT pg_switch_wal()');
    for (let attempt = 0; attempt < 120 && !existsSync(join(walArchive, requiredWal)); attempt++) {
      await Bun.sleep(100);
    }
    expect(existsSync(join(walArchive, requiredWal))).toBe(true);
    await primary.end();
    primary = undefined;
    execFileSync('pg_ctl', ['-D', primaryData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    primaryStarted = false;

    mkdirSync(incompleteArchive, { mode: 0o700 });
    for (const file of readdirSync(walArchive)) {
      if (file < requiredWal) copyFileSync(join(walArchive, file), join(incompleteArchive, file));
    }
    incomplete = await startRecovery(incompleteData, incompleteArchive, 'incomplete');
    await expect(assertPgRecoveryFrontier(incomplete, frontier))
      .rejects.toBeInstanceOf(PgRecoveryFrontierConflict);
    await expect(assertAccountRecoveryCoverage(incomplete, manifest.account))
      .rejects.toBeInstanceOf(AccountRecoveryCoverageConflict);
    const incompletePort = (await incomplete.query<{ port: string }>('SHOW port')).rows[0]!.port;
    expect(() => execFileSync(process.execPath, [manifestCommand, 'verify', manifestFile], {
      cwd: root, env: { ...process.env,
        ACCOUNT_RECOVERY_DATABASE_URL: `postgres://127.0.0.1:${incompletePort}/postgres?user=${process.env.USER}` },
      stdio: 'pipe',
    })).toThrow();
    const { app: incompleteApp } = startAccount(incomplete);
    expect((await verifier.verify(userRequest, ['work:create'])).subject).toBe(signedUp.user.id);
    await incompleteApp.stop();
    app = undefined;
    await incomplete.end();
    incomplete = undefined;
    execFileSync('pg_ctl', ['-D', incompleteData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    incompleteStarted = false;

    restored = await startRecovery(restoredData, walArchive, 'restored');
    await expect(assertPgRecoveryFrontier(restored, frontier)).resolves.toBeUndefined();
    expect(await accountRecoveryCoverage(restored)).toEqual(manifest.account);
    const restoredPort = (await restored.query<{ port: string }>('SHOW port')).rows[0]!.port;
    expect(execFileSync(process.execPath, [manifestCommand, 'verify', manifestFile], {
      cwd: root, env: { ...process.env,
        ACCOUNT_RECOVERY_DATABASE_URL: `postgres://127.0.0.1:${restoredPort}/postgres?user=${process.env.USER}` },
      encoding: 'utf8',
    })).toContain('matches retained WAL and row coverage');
    startAccount(restored);
    await expect(verifier.verify(userRequest, ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
  } finally {
    await app?.stop();
    await restored?.end();
    if (restoredStarted) execFileSync('pg_ctl', ['-D', restoredData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    await incomplete?.end();
    if (incompleteStarted) execFileSync('pg_ctl', ['-D', incompleteData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    await primary?.end();
    if (primaryStarted) execFileSync('pg_ctl', ['-D', primaryData, '-m', 'fast', '-w', 'stop'], { cwd: state });
  }
}, 120_000);
