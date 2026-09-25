import { test, expect } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync,
  openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { AccessAdmissionRegistry, engageAccessRecoveryFence,
  releaseAccessRecoveryFence } from '../../main/src/modules/access/admission.ts';
import { FusekiClient } from '../../main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph } from '../../main/src/modules/work/activate.ts';
import type { GraphLineage } from '../../main/src/modules/work/activate.ts';
import { accessOutboxCoverage, accessStateCoverage,
  assertGraphAdmissionOpen, assertGraphDeletionEvidence,
  cutoverRestoredGraphLineage, releaseRestoredGraphHold,
  RecoveryHold, RestoreLineageConflict, type RecoveryCoverage,
  type DeletionReleaseEvidence } from '../../main/src/modules/work/restore-lineage.ts';
import { initializeRelayCheckpoint, relayCoverage } from '../../main/src/modules/outbox/relay.ts';
import { assertAccountDeletionJournalCoverage, mirrorAccountDeletionIntent,
  mirrorAccountDeletionIntents } from
  '../../main/src/modules/outbox/account-deletion-journal.ts';
import { retainRecoveryCoverageHead } from
  '../../main/src/modules/outbox/recovery-coverage-head.ts';
import { assertAccountSubjectDeletionsAbsent, backfillAccountSubjectDeletions,
  retainAccountSubjectDeletion } from
  '../../main/src/modules/outbox/account-subject-deletion.ts';
import { sealRecoveryPayload } from '../src/recovery-envelope.ts';

const root = resolve(import.meta.dir, '../../..');
const coverageKey = 'ab'.repeat(32);

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
  let graphProcess: ChildProcess | undefined;
  const startFuseki = async (base: string, label: string): Promise<FusekiClient> => {
    const fusekiHome = Bun.env.REZICS_FUSEKI_HOME;
    const javaHome = Bun.env.REZICS_JAVA_HOME;
    if (!fusekiHome || !javaHome) throw new Error('Set REZICS_FUSEKI_HOME and REZICS_JAVA_HOME');
    const port = await freePort();
    const log = openSync(join(state, `${label}-fuseki.log`), 'w');
    graphProcess = spawn(join(fusekiHome, 'fuseki-server'), [
      '--localhost', `--port=${port}`, '--no-cors', '--timeout=10000',
      `--config=${join(base, 'fuseki-text.ttl')}`,
    ], { cwd: base, env: { ...process.env, JAVA_HOME: javaHome, FUSEKI_HOME: fusekiHome,
      FUSEKI_BASE: base, MAIN: 'main', JVM_ARGS: '-Xms128m -Xmx1g' },
    stdio: ['ignore', log, log] });
    closeSync(log);
    const fuseki = new FusekiClient(`http://127.0.0.1:${port}/rezics`);
    for (let attempt = 0; attempt < 120; attempt++) {
      try { if ((await fuseki.query('ASK {}')).boolean === true) return fuseki; }
      catch { /* starting */ }
      await Bun.sleep(250);
    }
    throw new Error(`${label} Fuseki did not start`);
  };
  const stopFuseki = async () => {
    if (!graphProcess) return;
    const process = graphProcess;
    graphProcess = undefined;
    process.kill('SIGTERM');
    if (process.exitCode === null) await new Promise<void>(resolveExit => process.once('exit', () => resolveExit()));
  };
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
    const graphEnabled = Boolean(Bun.env.REZICS_FUSEKI_HOME);
    const relay = await init('relay');
    const priorLineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '1' };
    for (const file of ['001_delivery.sql', '002_coverage_scan.sql',
      '003_retained_batches.sql', '004_account_deletion_journal.sql',
      '005_recovery_coverage_head.sql', '006_account_subject_deletion.sql']) {
      await relay.pool.query(readFileSync(join(root, 'services/main/migrations/relay', file), 'utf8'));
    }
    await initializeRelayCheckpoint(relay.pool, 'deleted-member-release', priorLineage.dataEpoch);
    if (graphEnabled) {
      const graphBase = join(state, 'graph-live');
      mkdirSync(join(graphBase, 'databases/rezics/tdb2'), { recursive: true });
      mkdirSync(join(graphBase, 'databases/rezics/lucene'), { recursive: true });
      copyFileSync(join(root, 'docs/operations/examples/fuseki-text.ttl'),
        join(graphBase, 'fuseki-text.ttl'));
      await initializeFreshGraph(await startFuseki(graphBase, 'graph-live'), priorLineage);
      await stopFuseki();
      cpSync(graphBase, join(state, 'graph-saved'), { recursive: true });
    }
    const accountPort = await freePort();
    const baseURL = `http://127.0.0.1:${accountPort}`;
    const issuer = `${baseURL}/api/auth`;
    const registry = new AccessAdmissionRegistry(access.pool);
    let failRelayOnce = true;
    const config = { baseURL, secret: 'two-owner-recovery-local-secret-value-32',
      resource: 'https://main.rezics.test', pool: account.pool,
      operatorUserIds: new Set<string>(),
      accessDeletionFence: async (subject: string) => {
        const fence = await registry.strongDeactivateAccountSubject(issuer, subject);
        if (fence) {
          if (failRelayOnce) {
            failRelayOnce = false;
            throw new Error('simulated relay outage after Access fence');
          }
          await mirrorAccountDeletionIntent(access.pool, relay.pool,
            fence.principalId, fence.enforcementEpoch);
        }
        await retainAccountSubjectDeletion(relay.pool, issuer, subject);
      } };
    await (await getMigrations(accountAuthOptions(config))).runMigrations();
    for (const file of ['001_admission.sql', '002_claim_and_seal.sql',
      '003_recovery_fence.sql', '004_principal_fence.sql',
      '005_account_deletion_fence.sql', '006_account_deletion_journal_scan.sql',
      '007_reader_variant_preference.sql', '008_realm_native_variant_recommendation.sql',
      '009_search_read_lease.sql']) {
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
    const unboundSignUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ name: 'Unbound member', email: 'unbound@example.test',
        password: 'correct horse battery staple' }),
    });
    expect(unboundSignUp.status).toBe(200);
    const unboundCookie = unboundSignUp.headers.get('set-cookie')!;
    const unboundSubject = (await unboundSignUp.json() as { user: { id: string } }).user.id;
    const principalId = Bun.randomUUIDv7();
    await access.pool.query(
      'INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, issuer, subject]);
    await expect(captureDeletionRecoverySet(account.pool, access.pool, issuer, subject))
      .rejects.toBeInstanceOf(DeletionRecoveryConflict);
    backup(account);
    backup(access);
    const deleteUser = () => fetch(`${baseURL}/api/auth/delete-user`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: baseURL },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    const withheld = await deleteUser();
    expect(withheld.status).toBe(503);
    expect((await account.pool.query('SELECT id FROM "user" WHERE id = $1', [subject])).rowCount)
      .toBe(1);
    expect((await access.pool.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active)
      .toBe(false);
    await expect(backfillAccountSubjectDeletions(account.pool, access.pool, relay.pool))
      .rejects.toThrow('Account deletion intent still has a live user');
    await expect(assertAccountDeletionJournalCoverage(access.pool, relay.pool)).rejects.toThrow();
    const deleted = await deleteUser();
    expect(deleted.status).toBe(200);
    const unboundDeleted = await fetch(`${baseURL}/api/auth/delete-user`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: unboundCookie,
        origin: baseURL },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    expect(unboundDeleted.status).toBe(200);
    expect((await access.pool.query('SELECT id FROM access.principal WHERE account_subject = $1',
      [unboundSubject])).rowCount).toBe(0);
    expect((await relay.pool.query('SELECT account_subject FROM relay.account_subject_deletion'))
      .rows.map(row => row.account_subject).sort()).toEqual([subject, unboundSubject].sort());
    await relay.pool.query('DELETE FROM relay.account_subject_deletion WHERE account_subject = $1',
      [subject]);
    expect((await relay.pool.query('SELECT account_subject FROM relay.account_subject_deletion'))
      .rows.map(row => row.account_subject)).toEqual([unboundSubject]);
    await expect(assertAccountSubjectDeletionsAbsent(account.pool, relay.pool))
      .resolves.toBeUndefined();
    expect((await account.pool.query('SELECT id FROM "user" WHERE id = $1', [subject])).rowCount)
      .toBe(0);
    await app.stop();
    app = undefined;
    const cli = join(root, 'services/account/src/deletion-recovery-set-cli.ts');
    const accountUrl = `postgres://127.0.0.1:${account.port}/postgres?user=${process.env.USER}`;
    const accessUrl = `postgres://127.0.0.1:${access.port}/postgres?user=${process.env.USER}`;
    const relayUrl = `postgres://127.0.0.1:${relay.port}/postgres?user=${process.env.USER}`;
    expect(execFileSync(process.execPath,
      [join(root, 'services/main/src/relay-account-subject-backfill.ts'), 'once'], {
        cwd: root, env: { ...process.env, ACCOUNT_RECOVERY_DATABASE_URL: accountUrl,
          ACCESS_RECOVERY_DATABASE_URL: accessUrl,
          RELAY_RECOVERY_DATABASE_URL: relayUrl }, encoding: 'utf8',
      })).toContain('retained 1 Account subject tombstones');
    expect(await backfillAccountSubjectDeletions(account.pool, access.pool, relay.pool)).toBe(0);
    await expect(assertAccountSubjectDeletionsAbsent(account.pool, relay.pool))
      .resolves.toBeUndefined();
    const captured = execFileSync(process.execPath, [cli, 'capture', issuer, subject], {
      cwd: root, env: { ...process.env, ACCOUNT_RECOVERY_DATABASE_URL: accountUrl,
        ACCESS_RECOVERY_DATABASE_URL: accessUrl,
        RECOVERY_MANIFEST_HMAC_KEY: manifestKey }, encoding: 'utf8' });
    const retained = openRecoveryPayload<DeletionRecoverySet>(
      captured, manifestKey, 'deletion-recovery-set');
    expect(retained.deletion).toEqual({ issuer, accountSubject: subject,
      accessPrincipalId: principalId, enforcementEpoch: '1' });
    expect((await access.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM access.outbox
       WHERE kind = 'account.deletion_fenced' AND principal_id = $1`, [principalId]))
      .rows[0]?.count).toBe('1');
    await expect(assertAccountDeletionJournalCoverage(access.pool, relay.pool))
      .resolves.toBeUndefined();
    expect(execFileSync(process.execPath,
      [join(root, 'services/main/src/relay-account-deletions.ts'), 'once'], {
        cwd: root, env: { ...process.env, ACCESS_DATABASE_URL: accessUrl,
          MAIN_RELAY_DATABASE_URL: relayUrl }, encoding: 'utf8',
      })).toContain('retained 0 Account deletion intents');
    expect(await mirrorAccountDeletionIntents(access.pool, relay.pool)).toBe(0);
    await expect(assertAccountDeletionJournalCoverage(access.pool, relay.pool))
      .resolves.toBeUndefined();
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
    await expect(assertAccountSubjectDeletionsAbsent(accountOlder.pool, relay.pool))
      .rejects.toThrow('retained Account deletion subject exists in restored Account');
    await expect(assertAccountSubjectDeletionsAbsent(accountFull.pool, relay.pool))
      .resolves.toBeUndefined();
    const releaseGraphHold = async (
      graphClient: FusekiClient, accessPool: Pool, relayPool: Pool, lineage: GraphLineage,
      coverage: Omit<RecoveryCoverage, 'account' | 'accountPg'>,
      deletions?: DeletionReleaseEvidence,
      accountPool: Pool = accountFull.pool,
    ): Promise<void> => {
      await releaseRestoredGraphHold(graphClient, accessPool, relayPool, lineage, {
        sealedCoverage: JSON.stringify(sealRecoveryPayload(
          { ...coverage, accountPg: retained.account.pg,
            account: retained.account.rows }, coverageKey,
          'graph-recovery-coverage')),
        hmacKey: coverageKey, accountPool, deletions,
      });
    };
    await expect(assertAccountDeletionJournalCoverage(accessOlder.pool, relay.pool))
      .rejects.toThrow('retained Account deletion journal differs from Access');
    await expect(assertAccountDeletionJournalCoverage(accessFull.pool, relay.pool))
      .resolves.toBeUndefined();
    const olderFence = await engageAccessRecoveryFence(accessOlder.pool);
    const oldOutbox = await accessOutboxCoverage(accessOlder.pool);
    const oldState = await accessStateCoverage(accessOlder.pool);
    await expect(releaseGraphHold(new FusekiClient('http://127.0.0.1:1/rezics'),
      accessOlder.pool, relay.pool,
      { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '2' }, {
        priorDataEpoch: priorLineage.dataEpoch, priorSequence: '0',
        accessOutboxCount: oldOutbox.count, accessOutboxDigest: oldOutbox.digest,
        accessStateCount: oldState.count, accessStateDigest: oldState.digest,
        relay: await relayCoverage(relay.pool, 'deleted-member-release'),
      })).rejects.toThrow('retained Account deletion journal differs from Access');
    await releaseAccessRecoveryFence(accessOlder.pool, olderFence);
    const fullOutbox = await accessOutboxCoverage(accessFull.pool);
    const fullState = await accessStateCoverage(accessFull.pool);
    const olderAccountFence = await engageAccessRecoveryFence(accessFull.pool);
    await expect(releaseGraphHold(new FusekiClient('http://127.0.0.1:1/rezics'),
      accessFull.pool, relay.pool,
      { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '2' }, {
        priorDataEpoch: priorLineage.dataEpoch, priorSequence: '0',
        accessOutboxCount: fullOutbox.count, accessOutboxDigest: fullOutbox.digest,
        accessStateCount: fullState.count, accessStateDigest: fullState.digest,
        relay: await relayCoverage(relay.pool, 'deleted-member-release'),
      }, undefined, accountOlder.pool)).rejects.toThrow('Account WAL differs from recovery coverage');
    await releaseAccessRecoveryFence(accessFull.pool, olderAccountFence);
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
    const recoveryGeneration = await engageAccessRecoveryFence(accessFull.pool);
    await expect(assertGraphDeletionEvidence(accessFull.pool))
      .rejects.toThrow('Account deletion recovery evidence is incomplete');
    await expect(assertGraphDeletionEvidence(accessFull.pool, {
      accountPool: accountOlder.pool, hmacKey: manifestKey, sealedSets: [captured],
    })).rejects.toBeInstanceOf(RestoreLineageConflict);
    await expect(assertGraphDeletionEvidence(accessFull.pool, {
      accountPool: accountFull.pool, hmacKey: 'cd'.repeat(32), sealedSets: [captured],
    })).rejects.toBeInstanceOf(RestoreLineageConflict);
    await expect(assertGraphDeletionEvidence(accessFull.pool, {
      accountPool: accountFull.pool, hmacKey: manifestKey, sealedSets: [captured],
    })).resolves.toBeUndefined();
    const graphEpoch = Bun.randomUUIDv7();
    await expect(releaseGraphHold(
      new FusekiClient('http://127.0.0.1:1/rezics'), accessFull.pool, relay.pool,
      { dataEpoch: graphEpoch, routingEpoch: '2' }, {
        priorDataEpoch: graphEpoch, priorSequence: '0',
        accessOutboxCount: retained.access.outbox.count,
        accessOutboxDigest: retained.access.outbox.digest,
        accessStateCount: retained.access.state.count,
        accessStateDigest: retained.access.state.digest,
        relay: { consumer: 'held-graph', dataEpoch: graphEpoch, sequence: '0',
          batchCount: '0', batchDigest: '0'.repeat(64),
          eventCount: '0', eventDigest: '0'.repeat(64) },
      })).rejects.toThrow('Account deletion recovery evidence is incomplete');
    if (graphEnabled) {
      const graphBase = join(state, 'graph-restored');
      cpSync(join(state, 'graph-saved'), graphBase, { recursive: true });
      const fuseki = await startFuseki(graphBase, 'graph-restored');
      const nextLineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '2' };
      expect(await cutoverRestoredGraphLineage(fuseki, {
        prior: { ...priorLineage, sequence: '0' }, next: nextLineage,
      })).toMatchObject({ lineage: nextLineage, sequence: '0' });
      await expect(assertGraphAdmissionOpen(fuseki, nextLineage))
        .rejects.toBeInstanceOf(RecoveryHold);
      const coverage: RecoveryCoverage = {
        priorDataEpoch: priorLineage.dataEpoch, priorSequence: '0',
        accountPg: retained.account.pg,
        account: retained.account.rows,
        accessOutboxCount: retained.access.outbox.count,
        accessOutboxDigest: retained.access.outbox.digest,
        accessStateCount: retained.access.state.count,
        accessStateDigest: retained.access.state.digest,
        relay: await relayCoverage(relay.pool, 'deleted-member-release'),
      };
      const sealedCoverage = JSON.stringify(sealRecoveryPayload(
        coverage, coverageKey, 'graph-recovery-coverage'));
      await retainRecoveryCoverageHead(relay.pool, sealedCoverage, coverageKey);
      await expect(releaseRestoredGraphHold(fuseki, accessFull.pool, relay.pool,
        nextLineage, { sealedCoverage, hmacKey: 'cd'.repeat(32), accountPool: accountFull.pool,
          deletions: {
          accountPool: accountFull.pool, hmacKey: manifestKey, sealedSets: [captured],
        } })).rejects.toThrow('recovery coverage envelope is invalid');
      const newerCoverage = JSON.stringify(sealRecoveryPayload({ ...coverage,
        account: { ...coverage.account, rowDigest: '0'.repeat(64) } },
      coverageKey, 'graph-recovery-coverage'));
      await retainRecoveryCoverageHead(relay.pool, newerCoverage, coverageKey);
      await expect(releaseRestoredGraphHold(fuseki, accessFull.pool, relay.pool,
        nextLineage, { sealedCoverage, hmacKey: coverageKey, accountPool: accountFull.pool,
          deletions: { accountPool: accountFull.pool, hmacKey: manifestKey,
            sealedSets: [captured] },
        })).rejects.toThrow('signed recovery coverage is not the retained current capture');
      await retainRecoveryCoverageHead(relay.pool, sealedCoverage, coverageKey);
      await releaseRestoredGraphHold(fuseki, accessFull.pool, relay.pool,
        nextLineage, { sealedCoverage, hmacKey: coverageKey, accountPool: accountFull.pool,
          deletions: {
          accountPool: accountFull.pool, hmacKey: manifestKey, sealedSets: [captured],
        } });
      await expect(assertGraphAdmissionOpen(fuseki, nextLineage)).resolves.toBeUndefined();
      await stopFuseki();
    }
    await releaseAccessRecoveryFence(accessFull.pool, recoveryGeneration);
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
    await stopFuseki();
    for (const owner of [...recovered, ...owners]) {
      try { await owner.pool.end(); } catch { /* pool may already be closed */ }
      if (owner.started) execFileSync('pg_ctl', ['-D', owner.data, '-m', 'fast', '-w', 'stop'], { cwd: state });
    }
  }
}, 120_000);
