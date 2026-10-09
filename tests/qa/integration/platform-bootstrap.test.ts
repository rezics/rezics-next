import { expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { bootstrapWebAuth } from '../../../scripts/dev/web-auth-bootstrap.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { grantPlatformUse, platformAdministratorSession, revokePlatformUse } from '../fixtures/platform-grant.ts';

const root = resolve(import.meta.dir, '../../..');

function tail(path: string): string {
  try { return readFileSync(path, 'utf8').slice(-4000); }
  catch { return `no log at ${path}`; }
}

async function ready(name: string, url: string, child: ChildProcess, logPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${name} exited before readiness (code ${child.exitCode}, signal ${child.signalCode})\n${tail(logPath)}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) { await response.body?.cancel(); return; }
      last = `HTTP ${response.status}`;
      await response.body?.cancel();
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await Bun.sleep(400);
  }
  throw new Error(`${name} did not become ready at ${url} (${last})\n${tail(logPath)}`);
}

function launch(args: string[], env: NodeJS.ProcessEnv, logPath: string): ChildProcess {
  const fd = openSync(logPath, 'w');
  try {
    return spawn('bun', args, { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] });
  } finally { closeSync(fd); }
}

function stop(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); }
  catch { child.kill('SIGTERM'); }
}

test('a fresh QA stack opens a closed group only through the platform grant helper', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  const artifacts = Bun.env.REZICS_QA_ARTIFACT_DIR;
  if (!runId || !artifacts) throw new Error('Run through the isolated integration QA tier');
  const auth = await bootstrapWebAuth({ profile: 'qa', runId,
    redirectUris: ['http://127.0.0.1:3000/auth/callback'] });
  const runtime = readEnv(auth.runtimeEnvPath);
  const saved = JSON.parse(readFileSync(auth.privateConfigPath, 'utf8')) as {
    member: { id: string }; principalId: string; actingSubject: string };
  const apps = readEnv(join(stackDirectory(root, { profile: 'qa', runId }), 'apps.env'));
  expect(runtime.PLATFORM_FIRST_ADMIN_ACCOUNT).toBe(saved.member.id);
  expect(apps.PLATFORM_FIRST_ADMIN_ACCOUNT).toBe(saved.member.id);

  const relay = new Pool({ connectionString: runtime.MAIN_RELAY_DATABASE_URL });
  try { await initializeRelayCheckpoint(relay, runtime.MAIN_RELAY_CONSUMER!, runtime.MAIN_DATA_EPOCH!); }
  finally { await relay.end(); }

  const logs = join(artifacts, 'logs');
  mkdirSync(logs, { recursive: true });
  const accountLog = join(logs, 'platform-bootstrap-account.log');
  const mainLog = join(logs, 'platform-bootstrap-main.log');
  // This stack proves a grant is the only way to open saved-views. The QA
  // stack otherwise opens every platform group.
  const env = { ...process.env, ...runtime, REZICS_PLATFORM_OPEN_GROUPS: '' };
  let account: ChildProcess | undefined;
  let main: ChildProcess | undefined;
  try {
    account = launch(['services/account/src/index.ts'], env, accountLog);
    await ready('Account', `http://127.0.0.1:${runtime.ACCOUNT_PORT}/health/ready`, account, accountLog, 45_000);
    main = launch(['services/main/src/index.ts'], env, mainLog);
    await ready('Main', `http://127.0.0.1:${runtime.MAIN_PORT}/health/ready`, main, mainLog, 120_000);

    const access = new Pool({ connectionString: runtime.ACCESS_DATABASE_URL });
    try {
      const grants = await access.query<{ action: string }>(
        `SELECT g.action FROM access.principal_permission_grant g
         JOIN access.principal p ON p.id = g.principal_id
         WHERE p.account_issuer = $1 AND p.account_subject = $2 AND g.active
           AND g.action IN ('platform:grant', 'platform:use:saved-views')`,
        [runtime.ACCOUNT_ISSUER, saved.member.id]);
      const actions = grants.rows.map(row => row.action);
      expect(actions).toContain('platform:grant');
      expect(actions).not.toContain('platform:use:saved-views');
    } finally { await access.end(); }

    const session = await platformAdministratorSession({ ...runtime,
      REZICS_WEB_AUTH_PUBLIC_PATH: auth.publicConfigPath,
      REZICS_WEB_AUTH_PRIVATE_PATH: auth.privateConfigPath,
    }, 'openid access:grant follow:read');
    expect(session.principalId).toBe(saved.principalId);
    const filters = new URL('/v1/me/saved-filters', session.mainOrigin);
    filters.searchParams.set('actingSubject', saved.actingSubject);
    const headers = { authorization: `Bearer ${session.token}` };
    const closed = await fetch(filters, { headers });
    expect(closed.status).toBe(403);
    expect(await closed.json()).toMatchObject({ code: 'platform_closed' });
    const before = await fetch(new URL('/v1/me/platform-access', session.mainOrigin), { headers });
    expect(before.status).toBe(200);
    expect((await before.json() as { groups: string[] }).groups).not.toContain('saved-views');

    const issued = await grantPlatformUse(session, session.principalId, 'saved-views');
    expect(issued.permission).toBe('platform:use:saved-views');
    const opened = await fetch(filters, { headers });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ profile: 'saved-filters-v1' });
    const during = await fetch(new URL('/v1/me/platform-access', session.mainOrigin), { headers });
    expect((await during.json() as { groups: string[] }).groups).toContain('saved-views');

    await revokePlatformUse(session, issued);
    const refused = await fetch(filters, { headers });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'platform_closed' });
  } finally {
    stop(main);
    stop(account);
    await Promise.race([
      Promise.all([
        account ? new Promise(resolve => account.once('exit', resolve)) : Promise.resolve(),
        main ? new Promise(resolve => main.once('exit', resolve)) : Promise.resolve(),
      ]),
      Bun.sleep(8_000),
    ]);
    if (account && account.exitCode === null) {
      try { process.kill(-account.pid!, 'SIGKILL'); } catch { account.kill('SIGKILL'); }
    }
    if (main && main.exitCode === null) {
      try { process.kill(-main.pid!, 'SIGKILL'); } catch { main.kill('SIGKILL'); }
    }
  }
}, 240_000);
