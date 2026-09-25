import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { accountAuthOptions, createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { installConsentRefreshFence } from '../../../services/account/src/consent-fence.ts';
import { assertDeletionRecoverySet, captureDeletionRecoverySet } from
  '../../../services/account/src/deletion-recovery-set.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence, releaseAccessRecoveryFence } from
  '../../../services/main/src/modules/access/admission.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { assertGraphAdmissionOpen, captureGraphRecoveryCoverage,
  cutoverRestoredGraphLineage, RecoveryHold, releaseRestoredGraphHold } from
  '../../../services/main/src/modules/work/restore-lineage.ts';
import { assertAccountDeletionJournalCoverage, mirrorAccountDeletionIntent } from
  '../../../services/main/src/modules/outbox/account-deletion-journal.ts';
import { assertAccountSubjectDeletionsAbsent, retainAccountSubjectDeletion } from
  '../../../services/main/src/modules/outbox/account-subject-deletion.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from
  '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';

const root = resolve(import.meta.dir, '../../..');
const recoveryKey = 'b7'.repeat(32);

function rootCommand(args: string[], timeout: number): string {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout
      || result.error?.message || '').slice(-2000)}`);
  }
  return result.stdout.trim();
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no fixture port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function migrate(pool: Pool, owner: 'access' | 'relay'): Promise<void> {
  const directory = join(root, `services/main/migrations/${owner}`);
  for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
    await pool.query(readFileSync(join(directory, file), 'utf8'));
  }
}

test('IAM11/OPS03: retained deletion frontiers reject an older Account and Access restore', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const runId = `owner-cut-${randomUUID().slice(0, 12)}`;
  const stackArgs = ['--profile', 'qa', '--run-id', runId];
  const state = join(root, '.temp', `account-erasure-${randomUUID()}`);
  const socketDirectory = join(root, '.temp', 's');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const pools: Pool[] = [];
  const replayData: string[] = [];
  let app: ReturnType<typeof createAccountApp> | undefined;
  let started = false;
  try {
    started = true;
    rootCommand(['stack:up', ...stackArgs], 180_000);
    const stack = stackDirectory(root, { profile: 'qa', runId });
    const apps = readEnv(join(stack, 'apps.env'));
    const compose = readEnv(join(stack, 'compose.env'));
    const account = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
    const access = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    const relay = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
    const owner = (database: string) => new Pool({ connectionString:
      `postgresql://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}`
        + `@127.0.0.1:${compose.POSTGRES_PORT}/${database}` });
    const accountOwner = owner('account');
    const accessOwner = owner('access');
    pools.push(account, access, relay, accountOwner, accessOwner);
    await migrate(access, 'access');
    await migrate(relay, 'relay');
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const issuer = `${baseURL}/api/auth`;
    const registry = new AccessAdmissionRegistry(access);
    const config = { baseURL, secret: apps.ACCOUNT_SECRET!,
      resource: apps.ACCOUNT_MAIN_RESOURCE!, pool: account,
      operatorUserIds: new Set<string>(),
      accessDeletionFence: async (subject: string) => {
        const fence = await registry.strongDeactivateAccountSubject(issuer, subject);
        if (fence) await mirrorAccountDeletionIntent(
          access, relay, fence.principalId, fence.enforcementEpoch);
        await retainAccountSubjectDeletion(relay, issuer, subject);
      } };
    await (await getMigrations(accountAuthOptions(config))).runMigrations();
    await installConsentRefreshFence(account);
    app = createAccountApp(createAccountAuth(config), account)
      .listen({ hostname: '127.0.0.1', port });
    const signUp = async (name: string) => {
      const password = 'correct horse battery staple';
      const response = await fetch(`${baseURL}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
        body: JSON.stringify({ name, email: `${name}-${randomUUID()}@example.test`, password }),
      });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        cookie: response.headers.get('set-cookie')!, password };
    };
    const deleted = await signUp('deleted');
    const unaffected = await signUp('unaffected');
    const principalId = randomUUID();
    await access.query(
      'INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, issuer, deleted.id]);
    const privateRows = async (pool: Pool, subject: string) => {
      const result = await pool.query<{ users: string; passwords: string; sessions: string }>(
        `SELECT (SELECT count(*) FROM "user" WHERE id = $1)::text AS users,
          (SELECT count(*) FROM "account" WHERE "userId" = $1)::text AS passwords,
          (SELECT count(*) FROM "session" WHERE "userId" = $1)::text AS sessions`,
        [subject]);
      return result.rows[0];
    };
    expect(await privateRows(account, deleted.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const initial = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    await initializeFreshGraph(fuseki, initial);
    const consumerBefore = `erasure-before-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumerBefore, initial.dataEpoch);

    const capture = async (consumer: string) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try { return await captureGraphRecoveryCoverage(fuseki, accountOwner,
          access, relay, consumer); }
        catch (error) {
          if (attempt === 4 || !String(error).includes('Account WAL frontier')) throw error;
          await Bun.sleep(200);
        }
      }
      throw new Error('Account recovery capture did not stabilize');
    };
    const restore = async (backup: string, name: string) => {
      const data = join(state, name);
      replayData.push(data);
      cpSync(backup, data, { recursive: true });
      appendFileSync(join(data, 'postgresql.auto.conf'),
        "\narchive_mode = off\nrestore_command = 'false'\n");
      writeFileSync(join(data, 'recovery.signal'), '');
      const replayPort = await freePort();
      execFileSync('pg_ctl', ['-D', data, '-l', join(state, `${name}.log`),
        '-o', `-h 127.0.0.1 -p ${replayPort} -k ${socketDirectory}`,
        '-t', '20', '-w', 'start'], { cwd: state, timeout: 25_000 });
      const restored = (database: string) => new Pool({ host: '127.0.0.1',
        port: replayPort, database, user: 'postgres', password: compose.POSTGRES_PASSWORD! });
      const restoredAccount = restored('account');
      const restoredAccess = restored('access');
      pools.push(restoredAccount, restoredAccess);
      expect((await restoredAccount.query<{ recovering: boolean }>(
        'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering).toBe(false);
      return { account: restoredAccount, access: restoredAccess };
    };

    // A source backup predating deletion is a readable but unsafe recovery cut.
    const firstFence = await engageAccessRecoveryFence(access);
    const before = await capture(consumerBefore);
    const firstLineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(fuseki, {
      prior: { ...initial, sequence: '0' }, next: firstLineage });
    const oldBackup = rootCommand(['stack:backup', ...stackArgs], 100_000);
    execFileSync('pg_verifybackup', ['--no-parse-wal', oldBackup],
      { cwd: state, timeout: 15_000 });
    const old = await restore(oldBackup, 'older');
    const beforeEnvelope = JSON.stringify(sealRecoveryPayload(
      before, recoveryKey, 'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relay, beforeEnvelope, recoveryKey);
    await releaseRestoredGraphHold(fuseki, old.access, relay, firstLineage, {
      sealedCoverage: beforeEnvelope, hmacKey: recoveryKey, accountPool: old.account });
    await releaseAccessRecoveryFence(old.access, firstFence);
    await releaseAccessRecoveryFence(access, firstFence);

    const deletion = await fetch(`${baseURL}/api/auth/delete-user`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        cookie: deleted.cookie, origin: baseURL },
      body: JSON.stringify({ password: deleted.password }),
    });
    expect(deletion.status).toBe(200);
    expect(await privateRows(account, deleted.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await privateRows(account, unaffected.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    expect((await access.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active).toBe(false);
    await expect(assertAccountDeletionJournalCoverage(access, relay)).resolves.toBeUndefined();
    await expect(assertAccountSubjectDeletionsAbsent(accountOwner, relay)).resolves.toBeUndefined();
    await app.stop();
    app = undefined;

    const finalFence = await engageAccessRecoveryFence(access);
    const consumerAfter = `erasure-after-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumerAfter, firstLineage.dataEpoch);
    const after = await capture(consumerAfter);
    const set = await captureDeletionRecoverySet(accountOwner, accessOwner, issuer, deleted.id);
    const sealedSet = JSON.stringify(sealRecoveryPayload(set,
      recoveryKey, 'deletion-recovery-set'));
    const finalLineage = { dataEpoch: randomUUID(), routingEpoch: '3' };
    await cutoverRestoredGraphLineage(fuseki, {
      prior: { ...firstLineage, sequence: '0' }, next: finalLineage });
    const finalBackup = rootCommand(['stack:backup', ...stackArgs], 100_000);
    execFileSync('pg_verifybackup', ['--no-parse-wal', finalBackup],
      { cwd: state, timeout: 15_000 });
    const current = await restore(finalBackup, 'current');
    expect(await privateRows(old.account, deleted.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    expect(await privateRows(current.account, deleted.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await privateRows(current.account, unaffected.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    expect((await old.access.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active).toBe(true);
    expect((await current.access.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active).toBe(false);
    await expect(assertAccountSubjectDeletionsAbsent(old.account, relay))
      .rejects.toThrow('retained Account deletion subject exists in restored Account');
    await expect(assertAccountDeletionJournalCoverage(old.access, relay))
      .rejects.toThrow('retained Account deletion journal differs from Access');
    await expect(assertDeletionRecoverySet(old.account, current.access, set)).rejects.toThrow();
    await expect(assertDeletionRecoverySet(current.account, old.access, set)).rejects.toThrow();
    await expect(assertDeletionRecoverySet(current.account, current.access, set))
      .resolves.toBeUndefined();

    const envelope = JSON.stringify(sealRecoveryPayload(
      after, recoveryKey, 'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relay, envelope, recoveryKey);
    await engageAccessRecoveryFence(old.access);
    await expect(releaseRestoredGraphHold(fuseki, old.access, relay, finalLineage, {
      sealedCoverage: envelope, hmacKey: recoveryKey, accountPool: current.account,
      deletions: { accountPool: current.account, hmacKey: recoveryKey,
        sealedSets: [sealedSet] } })).rejects.toThrow('Access outbox differs from recovery coverage');
    await expect(releaseRestoredGraphHold(fuseki, current.access, relay, finalLineage, {
      sealedCoverage: envelope, hmacKey: recoveryKey, accountPool: old.account,
      deletions: { accountPool: old.account, hmacKey: recoveryKey,
        sealedSets: [sealedSet] } })).rejects.toThrow('Account WAL differs from recovery coverage');
    await expect(releaseRestoredGraphHold(fuseki, current.access, relay, finalLineage, {
      sealedCoverage: envelope, hmacKey: recoveryKey, accountPool: current.account,
    })).rejects.toThrow('Account deletion recovery evidence is incomplete');
    await expect(assertGraphAdmissionOpen(fuseki, finalLineage))
      .rejects.toBeInstanceOf(RecoveryHold);
    await releaseRestoredGraphHold(fuseki, current.access, relay, finalLineage, {
      sealedCoverage: envelope, hmacKey: recoveryKey, accountPool: current.account,
      deletions: { accountPool: current.account, hmacKey: recoveryKey,
        sealedSets: [sealedSet] } });
    await releaseAccessRecoveryFence(current.access, finalFence);
    await expect(assertGraphAdmissionOpen(fuseki, finalLineage)).resolves.toBeUndefined();
    expect(await privateRows(current.account, deleted.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
  } finally {
    await app?.stop();
    await Promise.allSettled(pools.map(pool => pool.end()));
    for (const data of replayData) {
      if (spawnSync('pg_ctl', ['-D', data, 'status'], { cwd: state, timeout: 5_000 }).status === 0) {
        execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-t', '10', '-w', 'stop'],
          { cwd: state, timeout: 15_000 });
      }
    }
    try { if (started) rootCommand(['stack:reset', ...stackArgs], 120_000); }
    finally { rmSync(state, { recursive: true, force: true }); }
  }
}, 300_000);
