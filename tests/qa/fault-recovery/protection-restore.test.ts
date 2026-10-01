import { provisionFixtureAuthor } from '../fixtures/authored-work.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { copyRecoveryTree } from '../support/recovery-copy.ts';
import { Pool } from 'pg';
import { projectName, readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence, releaseAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { ProtectionAdmissionSigner } from '../../../services/main/src/modules/access/protection-admission.ts';
import { PROTECTION_RULE } from '../../../services/main/src/modules/protection/schema.ts';
import { reconcileRetainedWorkProtection }
  from '../../../services/main/src/modules/protection/reconcile-restored.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead }
  from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { captureGraphRecoveryCoverage, cutoverRestoredGraphLineage,
  releaseRestoredGraphHold } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
const recoveryKey = '13'.repeat(32);
const id = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;

function stack(action: 'stack:up' | 'stack:down' | 'stack:reset', runId: string) {
  const result = spawnSync('bun', ['scripts/dev/cli.ts', action, '--profile', 'qa', '--run-id', runId,
    '--persistent'], { cwd: root, encoding: 'utf8', timeout: action === 'stack:reset' ? 45_000 : 180_000,
      maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) throw new Error(`${action}: ${(
    result.stderr || result.stdout || result.error?.message || '').slice(-2000)}`);
}
function backup(runId: string, directory: string): string {
  const project = projectName({ profile: 'qa', runId, persistent: true });
  const result = spawnSync('docker', ['ps', '-q', '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.service=postgres'],
  { cwd: root, env: loadDockerEnvironment(), encoding: 'utf8', timeout: 10_000 });
  const container = result.stdout.trim();
  if (result.status !== 0 || !container) throw new Error('PostgreSQL owner container is unavailable');
  const remote = `/tmp/rezics-sys13-${randomUUID()}`;
  const local = join(directory, 'backup');
  try {
    docker(['exec', '-u', 'postgres', container, 'sh', '-ec',
      `PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5 pg_basebackup -h 127.0.0.1 -p 5432 -U postgres -w -D ${remote} -Fp -Xs --checkpoint=fast`]);
    docker(['cp', `${container}:${remote}`, local]);
    if (!readFileSync(join(local, 'PG_VERSION'), 'utf8').trim()) throw new Error('empty PostgreSQL backup');
    return local;
  } finally { try { docker(['exec', container, 'rm', '-rf', remote]); } catch { /* backup error */ } }
}
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL port'));
      server.close(() => resolvePort(address.port));
    });
  });
}
function docker(args: string[]) {
  const result = spawnSync('docker', args,
  { cwd: root, env: loadDockerEnvironment(), encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) throw new Error(`docker ${args[0]}: ${(
    result.stderr || result.stdout || result.error?.message || '').slice(-2000)}`);
}
const copyImage = readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8')
  .match(/^  postgres:\n    image: (postgres:18\.6-trixie@sha256:[0-9a-f]{64})$/m)?.[1];
if (!copyImage) throw new Error('pinned PostgreSQL copy image is unavailable');
function copyVolume(from: string, to: string, replace = false) {
  docker(['run', '--rm', '--network', 'none', '--user', '0:0',
    '--volume', `${from}:/from:ro`, '--volume', `${to}:/to`,
    '--entrypoint', 'sh', copyImage!, '-ec',
    `${replace ? 'find /to -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; ' : ''}cp -a /from/. /to/`]);
}
function stopGraph(runId: string) {
  const project = projectName({ profile: 'qa', runId, persistent: true });
  const result = spawnSync('docker', ['ps', '-q', '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.service=fuseki'],
  { cwd: root, env: loadDockerEnvironment(), encoding: 'utf8', timeout: 10_000 });
  const container = result.stdout.trim();
  if (result.status !== 0 || !container) throw new Error('Fuseki owner container is unavailable');
  docker(['stop', container]);
}
async function migrate(pool: Pool, owner: 'access' | 'relay') {
  const directory = join(root, `services/main/migrations/${owner}`);
  for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
    await pool.query(readFileSync(join(directory, file), 'utf8'));
  }
}

test('SYS13: stopped graph cut retains old intent and delivery until protected correction reconciles', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the fault/recovery tier');
  const nonce = randomUUID().slice(0, 12);
  const sourceId = `owner-cut-sys13-${nonce}`;
  const sourceVolume = `${projectName({ profile: 'qa', runId: sourceId, persistent: true })}_fuseki_data`;
  const cutVolume = `rezics-sys13-${nonce}-cut`;
  const recoveryDir = join(root, '.temp', `sys13-pg-${nonce}`);
  const restoredData = join(recoveryDir, 'restored');
  const socketDir = join(root, '.temp', 's');
  mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  let restoredStarted = false;
  const started: string[] = [];
  const pools: Pool[] = [];
  let account: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  try {
    stack('stack:up', sourceId); started.push(sourceId);
    const apps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: sourceId,
      persistent: true }), 'apps.env'));
    const compose = readEnv(join(stackDirectory(root, { profile: 'qa', runId: sourceId,
      persistent: true }), 'compose.env'));
    const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    const relayPool = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
    const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
    const accountOwner = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
    pools.push(accessPool, relayPool, contentPool, accountOwner);
    for (const pool of pools) pool.on('error', () => { /* the stopped cut closes idle connections */ });
    await migrate(accessPool, 'access'); await migrate(relayPool, 'relay');
    await migrateContent(contentPool);
    account = await ratingAccount(apps,
      'openid work:create work:edit work:read work:protect work:correct work:review');
    const principal = randomUUID(), reviewer = randomUUID();
    const actor = id(), reviewerActor = id();
    await accessPool.query(`INSERT INTO access.principal (id,account_issuer,account_subject)
      VALUES ($1,$2,$3),($4,$2,$5)`, [principal, account.issuer, account.a.id,
        reviewer, account.b.id]);
    for (const subject of [actor, reviewerActor]) {
      await accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [subject]);
    }
    const grant = async (who: 0 | 1, scope: string, action: string) => {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool.query(`INSERT INTO access.representation
        (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), who ? reviewer : principal, who ? reviewerActor : actor, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), who ? reviewerActor : actor, scope, action]);
    };
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    await initializeFreshGraph(fuseki, lineage);
    const environment = { fuseki, lineage, objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
    const access = new AccessAdmissionRegistry(accessPool, apps.FUSEKI_TITLE_ADMISSION_KEY);
    const signer = new ProtectionAdmissionSigner(accessPool, apps.FUSEKI_TITLE_ADMISSION_KEY!);
    const app = createMainApp(fuseki, { environment, account: account.verifier,
      access, protectionSigner: signer });
    const call = (target: ReturnType<typeof createMainApp>, method: string, path: string,
      body?: object, key = randomUUID(), who: 0 | 1 = 0) => target.handle(new Request(
      `http://main.local${path}`, { method, headers: { authorization: `Bearer ${who
        ? account!.tokenB : account!.tokenA}`, 'idempotency-key': key,
      ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const read = async <T>(response: Response, status: number) => {
      const body = await response.json();
      if (response.status !== status) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
      return body as T;
    };
    await provisionFixtureAuthor(environment, actor);
    await grant(0, 'work:create:root', 'work.create');
    const created = await read<{ work: string; workRevision: string }>(await call(app, 'POST', '/v1/works',
      { profile: 'metadata-only-v1', authoring: 'own-work', language: 'en', title: 'Original protected title', actingSubject: actor }), 201);
    const work = created.work;
    await grant(0, `work:read:${work}`, 'work.read');
    // The graph owner cut is stopped and copied before the later correction commits.
    stopGraph(sourceId); docker(['volume', 'create', cutVolume]);
    copyVolume(sourceVolume, cutVolume); stack('stack:up', sourceId);
    await grant(0, `work:protect:${work}`, 'work.protection.tighten');
    await grant(0, `work:correct:${work}`, 'work.correction.propose');
    await grant(1, `work:review:${work}`, 'work.correction.review');
    const basis = { work, expectedHead: created.workRevision, expectedProtection: null,
      expectedControl: null, expectedControlEpoch: '0', expectedRuleRevision: PROTECTION_RULE,
      actingSubject: actor, reason: 'Correct the adopted title', evidence: [] };
    const protectionRequest = { profile: 'work-title-protection-v1', action: 'tighten', ...basis };
    const protection = await read<{ protectionRevision: string; receipt: string;
      sourcePosition: { sequence: string } }>(await call(app, 'POST', '/v1/work-title-protections',
        protectionRequest), 201);
    const proposalRequest = { profile: 'work-title-correction-v1', ...basis,
      expectedProtection: protection.protectionRevision, title: 'Reviewed replacement', predecessor: null };
    const proposal = await read<{ proposalRevision: string }>(await call(app,
      'POST', '/v1/work-title-corrections', proposalRequest), 201);
    const proposalRead = await read<{ proposal: { candidateDigest: string; candidate: string } }>(await call(app,
      'GET', `/v1/work-title-corrections/${proposal.proposalRevision.split('/').at(-1)}?actingSubject=${
        encodeURIComponent(actor)}`), 200);
    const reviewRequest = { profile: 'work-title-correction-review-v1', ...basis,
      expectedProtection: protection.protectionRevision, actingSubject: reviewerActor,
      candidateDigest: proposalRead.proposal.candidateDigest, expectedDecisionHead: null,
      outcome: 'approved' };
    const reviewPath = `/v1/work-title-corrections/${proposal.proposalRevision.split('/').at(-1)}/decisions`;
    const reviewKey = randomUUID();
    const approved = await read<{ receipt: string; decision: string; operation: string;
      sourcePosition: { sequence: string } }>(await call(app, 'POST', reviewPath,
        reviewRequest, reviewKey, 1), 201);
    const consumer = `sys13:${nonce}`;
    await initializeRelayCheckpoint(relayPool, consumer, lineage.dataEpoch);
    for (let position = 1; position <= Number(approved.sourcePosition.sequence); position++) {
      expect((await relayMainOutboxOnce(fuseki, relayPool, consumer))?.sequence).toBe(String(position));
    }
    const delivered = (await relayPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM relay.delivered_event WHERE data_epoch = $1`,
      [lineage.dataEpoch])).rows[0]!.count;
    const retained = (await relayPool.query<{ envelope: { data: { recovery: unknown[] } } }>(
      `SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1
        AND envelope->>'type' = 'com.rezics.protection.work-correction-reviewed.v1'`,
      [lineage.dataEpoch])).rows;
    expect(retained).toHaveLength(1);
    expect(retained[0]!.envelope.data.recovery.length).toBeGreaterThan(8);
    expect(retained[0]!.envelope.data.recovery.length).toBeLessThanOrEqual(192);
    const fenceGeneration = await engageAccessRecoveryFence(accessPool);
    let coverage: Awaited<ReturnType<typeof captureGraphRecoveryCoverage>> | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { coverage = await captureGraphRecoveryCoverage(fuseki, accountOwner, accessPool,
        relayPool, consumer, contentPool, { directory: environment.objectDirectory }); break; }
      catch (error) {
        if (attempt === 9 || !String(error).includes('Account WAL frontier')) throw error;
        await Bun.sleep(200);
      }
    }
    if (!coverage) throw new Error('SYS13 recovery coverage is unavailable');
    const sealedCoverage = JSON.stringify(sealRecoveryPayload(coverage, recoveryKey,
      'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relayPool, sealedCoverage, recoveryKey);
    stopGraph(sourceId); copyVolume(cutVolume, sourceVolume, true);
    stack('stack:up', sourceId);
    const graphOldReceipt = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH <urn:rezics:graph:receipts> { <${approved.receipt}> a rv:OperationReceipt } }`);
    expect(graphOldReceipt.boolean).toBe(false);
    const next = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(fuseki, { prior: { ...lineage, sequence: '1' }, next });
    const restored = { ...environment, lineage: next,
      titleAdmissionKey: apps.FUSEKI_TITLE_ADMISSION_KEY! };
    const restoredApp = createMainApp(fuseki, { environment: restored,
      account: account.verifier, access, protectionSigner: signer });
    expect((await call(restoredApp, 'POST', reviewPath, reviewRequest, reviewKey, 1)).status).toBe(503);
    const admissionBefore = (await accessPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM access.admission')).rows[0]!.count;
    const evidence = { sealedCoverage, hmacKey: recoveryKey, accountPool: accountOwner,
      contentPool, objectStore: { directory: environment.objectDirectory } };
    await expect(releaseRestoredGraphHold(fuseki, accessPool, relayPool, next, evidence))
      .rejects.toThrow('Account WAL differs from recovery coverage');
    const baseBackup = backup(sourceId, recoveryDir);
    execFileSync('pg_verifybackup', ['--no-parse-wal', baseBackup],
      { cwd: recoveryDir, timeout: 15_000 });
    copyRecoveryTree(baseBackup, restoredData);
    appendFileSync(join(restoredData, 'postgresql.auto.conf'),
      "\narchive_mode = off\nrestore_command = 'false'\n");
    writeFileSync(join(restoredData, 'recovery.signal'), '');
    const restoredPort = await freePort();
    execFileSync('pg_ctl', ['-D', restoredData, '-l', join(recoveryDir, 'postgres.log'),
      '-o', `-h 127.0.0.1 -p ${restoredPort} -k ${socketDir}`, '-t', '20', '-w', 'start'],
    { cwd: recoveryDir, timeout: 25_000 });
    restoredStarted = true;
    const restoredPool = (database: string, user: string, password: string) => new Pool({
      host: '127.0.0.1', port: restoredPort, database, user, password });
    const restoredAccount = restoredPool('account', 'postgres', compose.POSTGRES_PASSWORD!);
    const restoredAccess = restoredPool('access', 'access', compose.REZICS_ACCESS_PASSWORD!);
    const restoredContent = restoredPool('content', 'content', compose.REZICS_CONTENT_PASSWORD!);
    const restoredRelay = restoredPool('relay', 'relay', compose.REZICS_RELAY_PASSWORD!);
    pools.push(restoredAccount, restoredAccess, restoredContent, restoredRelay);
    let recovering = true;
    for (let attempt = 0; attempt < 100 && recovering; attempt++) {
      recovering = (await restoredAccount.query<{ recovering: boolean }>(
        'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering ?? true;
      if (recovering) await Bun.sleep(100);
    }
    expect(recovering).toBe(false);
    const restoredEvidence = { sealedCoverage, hmacKey: recoveryKey,
      accountPool: restoredAccount, contentPool: restoredContent,
      objectStore: { directory: environment.objectDirectory } };
    const restoredAccessRegistry = new AccessAdmissionRegistry(restoredAccess,
      apps.FUSEKI_TITLE_ADMISSION_KEY);
    const restoredSigner = new ProtectionAdmissionSigner(restoredAccess,
      apps.FUSEKI_TITLE_ADMISSION_KEY!);
    const restoredAppFromOwners = createMainApp(fuseki, { environment: restored,
      account: account.verifier, access: restoredAccessRegistry,
      protectionSigner: restoredSigner });
    expect((await call(restoredAppFromOwners, 'POST', reviewPath, reviewRequest, reviewKey, 1)).status).toBe(503);
    await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay, next,
      restoredEvidence)).rejects.toThrow(/graph (cut differs|or immutable objects differ) from recovery coverage/);
    await expect(reconcileRetainedWorkProtection(restored, restoredAccess,
      restoredRelay, coverage.relay, approved.sourcePosition.sequence))
      .rejects.toThrow('retained proposer admission is absent');
    const reviewAdmission = approved.operation.split('/').at(-1)!;
    await restoredAccess.query(`UPDATE access.admission SET request_digest = $1 WHERE id = $2`,
      ['0'.repeat(64), reviewAdmission]);
    await expect(reconcileRetainedWorkProtection(restored, restoredAccess,
      restoredRelay, coverage.relay, approved.sourcePosition.sequence))
      .rejects.toThrow('Access does not prove retained Work protection effect');
    await restoredAccess.query(`UPDATE access.admission SET request_digest = $1 WHERE id = $2`,
      [(await accessPool.query<{ request_digest: string }>(
        'SELECT request_digest FROM access.admission WHERE id = $1', [reviewAdmission])).rows[0]!.request_digest,
      reviewAdmission]);
    for (let position = 2; position <= Number(approved.sourcePosition.sequence); position++) {
      const reconciled = await reconcileRetainedWorkProtection(restored, restoredAccess,
        restoredRelay, coverage.relay, String(position));
      expect(reconciled.replayed).toBe(false);
      expect((await reconcileRetainedWorkProtection(restored, restoredAccess,
        restoredRelay, coverage.relay, String(position))).replayed).toBe(true);
    }
    await releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay, next, restoredEvidence);
    await releaseAccessRecoveryFence(restoredAccess, fenceGeneration);
    expect((await call(app, 'POST', reviewPath, reviewRequest, reviewKey, 1)).status).toBe(503);
    const retries = await Promise.all([call(restoredAppFromOwners,
      'POST', reviewPath, reviewRequest, reviewKey, 1), call(restoredAppFromOwners,
      'POST', reviewPath, reviewRequest, reviewKey, 1)]);
    for (const response of retries) {
      expect(await read<{ decision: string; replayed: boolean }>(response, 200))
        .toMatchObject({ decision: approved.decision, replayed: true });
    }
    expect((await call(restoredAppFromOwners, 'POST', reviewPath,
      reviewRequest, reviewKey, 0)).status).toBe(403);
    const conflict = await read<{ code: string }>(await call(restoredAppFromOwners,
      'POST', reviewPath, { ...reviewRequest, outcome: 'rejected' }, reviewKey, 1), 409);
    expect(conflict.code).toBe('idempotency_conflict');
    expect((await restoredAccess.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM access.admission')).rows[0]!.count).toBe(admissionBefore);
    expect((await restoredRelay.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM relay.delivered_event WHERE data_epoch = $1`,
      [lineage.dataEpoch])).rows[0]!.count).toBe(delivered);
    const newConsumer = `${consumer}:restored`;
    await initializeRelayCheckpoint(restoredRelay, newConsumer, next.dataEpoch);
    expect(await relayMainOutboxOnce(fuseki, restoredRelay, newConsumer)).toBeNull();
    const state = await read<{ contentHead: string; protectionHead: string }>(await call(restoredAppFromOwners,
      'GET', `/v1/works/${work.split('/').at(-1)}/editorial-state?actingSubject=${encodeURIComponent(actor)}`), 200);
    expect(state).toMatchObject({ contentHead: proposalRead.proposal.candidate,
      protectionHead: protection.protectionRevision });
  } finally {
    await account?.close();
    await Promise.all(pools.map(pool => pool.end()));
    if (restoredStarted) execFileSync('pg_ctl', ['-D', restoredData, '-m', 'immediate', '-w', 'stop'],
      { cwd: recoveryDir, timeout: 25_000 });
    for (const runId of started.reverse()) {
      try { stack('stack:reset', runId); }
      catch (error) { console.error('SYS13 stack cleanup failed:', error); }
    }
    try { docker(['volume', 'rm', '-f', cutVolume]); } catch { /* preserve test error */ }
    rmSync(recoveryDir, { recursive: true, force: true });
  }
}, 600_000);
