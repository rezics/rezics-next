import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync,
  readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { accountAuthOptions, createAccountAuth } from '../src/auth.ts';
import { createAccountApp } from '../src/app.ts';
import { assertDeletionRecoverySet, captureDeletionRecoverySet,
  DeletionRecoveryConflict, type DeletionRecoverySet } from '../src/deletion-recovery-set.ts';
import { openRecoveryPayload, RecoveryEnvelopeConflict,
  type RecoveryEnvelope } from '../src/recovery-envelope.ts';
import { AccessAdmissionRegistry } from '../../main/src/modules/access/admission.ts';

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

test('OPS03/IAM10 partial: two-owner deletion cut rejects either missing WAL frontier', async () => {
  const state = join(root, '.temp', `account-access-recovery-${Bun.randomUUIDv7()}`);
  const manifestKey = 'ab'.repeat(32);
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  type Owner = { name: string; data: string; backup: string; archive: string;
    port: number; pool: Pool; started: boolean };
  const owners: Owner[] = [];
  const recovered: Owner[] = [];
  const start = async (name: string, data: string): Promise<Owner> => {
    const port = await freePort();
    execFileSync('pg_ctl', ['-D', data, '-l', join(state, `${name}.log`),
      '-o', `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
    return { name, data, backup: '', archive: '', port,
      pool: new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' }),
      started: true };
  };
  const init = async (name: string): Promise<Owner> => {
    const data = join(state, `${name}-primary`);
    const backup = join(state, `${name}-backup`);
    const archive = join(state, `${name}-archive`);
    mkdirSync(archive, { mode: 0o700 });
    execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
    appendFileSync(join(data, 'postgresql.conf'), `\nwal_level = replica\narchive_mode = on\n` +
      `archive_command = 'test ! -e ${archive}/%f && cp %p ${archive}/%f'\n`);
    const owner = await start(name, data);
    owner.backup = backup;
    owner.archive = archive;
    owners.push(owner);
    return owner;
  };
  const backup = (owner: Owner) => {
    execFileSync('pg_basebackup', ['-D', owner.backup, '-Fp', '-Xs', '--checkpoint=fast',
      '-h', '127.0.0.1', '-p', String(owner.port), '-U', process.env.USER ?? 'edge'], { cwd: state });
    execFileSync('pg_verifybackup', ['--no-parse-wal', owner.backup], { cwd: state });
  };
  const archive = async (owner: Owner, requiredWal: string) => {
    await owner.pool.query('SELECT pg_switch_wal()');
    for (let attempt = 0; attempt < 120 && !existsSync(join(owner.archive, requiredWal)); attempt++) {
      await Bun.sleep(100);
    }
    expect(existsSync(join(owner.archive, requiredWal))).toBe(true);
    await owner.pool.end();
    execFileSync('pg_ctl', ['-D', owner.data, '-m', 'fast', '-w', 'stop'], { cwd: state });
    owner.started = false;
  };
  const restore = async (owner: Owner, complete: boolean, requiredWal: string): Promise<Owner> => {
    const label = `${owner.name}-${complete ? 'full' : 'older'}`;
    const data = join(state, label);
    const source = complete ? owner.archive : join(state, `${label}-wal`);
    if (!complete) {
      mkdirSync(source, { mode: 0o700 });
      for (const file of readdirSync(owner.archive)) {
        if (file < requiredWal) copyFileSync(join(owner.archive, file), join(source, file));
      }
    }
    cpSync(owner.backup, data, { recursive: true });
    rmSync(join(data, 'pg_wal'), { recursive: true });
    mkdirSync(join(data, 'pg_wal'), { mode: 0o700 });
    appendFileSync(join(data, 'postgresql.auto.conf'),
      `\narchive_mode = off\nrestore_command = 'cp ${source}/%f %p'\n`);
    writeFileSync(join(data, 'recovery.signal'), '');
    const restored = await start(label, data);
    recovered.push(restored);
    for (let attempt = 0; attempt < 120; attempt++) {
      if ((await restored.pool.query<{ recovering: boolean }>(
        'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering === false) return restored;
      await Bun.sleep(100);
    }
    throw new Error(`${label} did not complete recovery`);
  };
  let app: ReturnType<typeof createAccountApp> | undefined;
  try {
    const account = await init('account');
    const access = await init('access');
    const accountPort = await freePort();
    const baseURL = `http://127.0.0.1:${accountPort}`;
    const issuer = `${baseURL}/api/auth`;
    const registry = new AccessAdmissionRegistry(access.pool);
    const config = { baseURL, secret: 'two-owner-recovery-local-secret-value-32',
      resource: 'https://main.rezics.test', pool: account.pool,
      operatorUserIds: new Set<string>(),
      accessDeletionFence: async (subject: string) => {
        await registry.strongDeactivateAccountSubject(issuer, subject);
      } };
    await (await getMigrations(accountAuthOptions(config))).runMigrations();
    for (const file of ['001_admission.sql', '002_claim_and_seal.sql',
      '003_recovery_fence.sql', '004_principal_fence.sql']) {
      await access.pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    app = createAccountApp(createAccountAuth(config), account.pool)
      .listen({ hostname: '127.0.0.1', port: accountPort });
    const signUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ name: 'Two-owner member', email: 'two-owner@example.test',
        password: 'correct horse battery staple' }),
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers.get('set-cookie')!;
    const subject = (await signUp.json() as { user: { id: string } }).user.id;
    const principalId = Bun.randomUUIDv7();
    await access.pool.query(
      'INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, issuer, subject]);
    await expect(captureDeletionRecoverySet(account.pool, access.pool, issuer, subject))
      .rejects.toBeInstanceOf(DeletionRecoveryConflict);
    backup(account);
    backup(access);
    const deleted = await fetch(`${baseURL}/api/auth/delete-user`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: baseURL },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    expect(deleted.status).toBe(200);
    await app.stop();
    app = undefined;
    const cli = join(root, 'services/account/src/deletion-recovery-set-cli.ts');
    const accountUrl = `postgres://127.0.0.1:${account.port}/postgres?user=${process.env.USER}`;
    const accessUrl = `postgres://127.0.0.1:${access.port}/postgres?user=${process.env.USER}`;
    const captured = execFileSync(process.execPath, [cli, 'capture', issuer, subject], {
      cwd: root, env: { ...process.env, ACCOUNT_RECOVERY_DATABASE_URL: accountUrl,
        ACCESS_RECOVERY_DATABASE_URL: accessUrl,
        RECOVERY_MANIFEST_HMAC_KEY: manifestKey }, encoding: 'utf8' });
    const retained = openRecoveryPayload<DeletionRecoverySet>(
      captured, manifestKey, 'deletion-recovery-set');
    expect(retained.deletion).toEqual({ issuer, accountSubject: subject,
      accessPrincipalId: principalId, enforcementEpoch: '1' });
    const envelope = JSON.parse(captured) as RecoveryEnvelope;
    await expect(() => openRecoveryPayload<DeletionRecoverySet>(JSON.stringify({
      ...envelope, payload: `A${envelope.payload.slice(1)}`,
    }), manifestKey, 'deletion-recovery-set')).toThrow(RecoveryEnvelopeConflict);
    await expect(() => openRecoveryPayload<DeletionRecoverySet>(
      captured, 'cd'.repeat(32), 'deletion-recovery-set')).toThrow(RecoveryEnvelopeConflict);
    const setFile = join(state, 'deletion-recovery-set.json');
    writeFileSync(setFile, captured);
    await archive(account, retained.account.pg.walFile);
    await archive(access, retained.access.pg.walFile);
    const accountOlder = await restore(account, false, retained.account.pg.walFile);
    const accountFull = await restore(account, true, retained.account.pg.walFile);
    const accessOlder = await restore(access, false, retained.access.pg.walFile);
    const accessFull = await restore(access, true, retained.access.pg.walFile);
    expect((await accountOlder.pool.query('SELECT id FROM "user" WHERE id = $1', [subject])).rowCount)
      .toBe(1);
    expect((await accessOlder.pool.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active).toBe(true);
    await expect(assertDeletionRecoverySet(accountOlder.pool, accessFull.pool, retained))
      .rejects.toThrow();
    await expect(assertDeletionRecoverySet(accountFull.pool, accessOlder.pool, retained))
      .rejects.toThrow();
    expect((await accountFull.pool.query('SELECT id FROM "user" WHERE id = $1', [subject])).rowCount)
      .toBe(0);
    expect((await accessFull.pool.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active).toBe(false);
    await expect(assertDeletionRecoverySet(accountFull.pool, accessFull.pool, retained))
      .resolves.toBeUndefined();
    const verified = execFileSync(process.execPath, [cli, 'verify', setFile], {
      cwd: root, env: { ...process.env,
        ACCOUNT_RECOVERY_DATABASE_URL: `postgres://127.0.0.1:${accountFull.port}/postgres?user=${process.env.USER}`,
        ACCESS_RECOVERY_DATABASE_URL: `postgres://127.0.0.1:${accessFull.port}/postgres?user=${process.env.USER}`,
        RECOVERY_MANIFEST_HMAC_KEY: manifestKey },
      encoding: 'utf8' });
    expect(verified).toContain('matches both restored owners');
    await expect(assertDeletionRecoverySet(accountFull.pool, accessFull.pool, {
      ...retained, deletion: { ...retained.deletion, accessPrincipalId: Bun.randomUUIDv7() },
    })).rejects.toBeInstanceOf(DeletionRecoveryConflict);
  } finally {
    await app?.stop();
    for (const owner of [...recovered, ...owners]) {
      try { await owner.pool.end(); } catch { /* pool may already be closed */ }
      if (owner.started) execFileSync('pg_ctl', ['-D', owner.data, '-m', 'fast', '-w', 'stop'], { cwd: state });
    }
  }
}, 120_000);
