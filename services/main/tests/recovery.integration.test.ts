import { test, expect } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, copyFileSync, cpSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { createMainApp } from '../src/app.ts';
import { AccessAdmissionRegistry, AdmissionDenied, engageAccessRecoveryFence,
  releaseAccessRecoveryFence } from '../src/modules/access/admission.ts';
import { createAdmittedMetadataWork } from '../src/modules/work/create-admitted.ts';
import { editAdmittedMetadataWork } from '../src/modules/work/edit-admitted.ts';
import { editMetadataWork, metadataWorkEditDigest, StaleWorkHead } from '../src/modules/work/edit.ts';
import { sealMetadataWorkAdmission } from '../src/modules/work/seal.ts';
import { readExactWorkRevision, RevisionUnavailable } from '../src/modules/work/history.ts';
import { reconcileRetainedEmptyBatch, reconcileRetainedWorkCancellation,
  reconcileRetainedWorkCreate, reconcileRetainedWorkEdit,
  RetainedEffectConflict } from '../src/modules/work/reconcile-restored.ts';
import { CancelledActivation, initializeFreshGraph, metadataWorkRequestDigest,
  PendingActivation, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { accessOutboxCoverage, accessStateCoverage, cutoverRestoredGraphLineage,
  RecoveryHold, releaseRestoredGraphHold,
  RestoreLineageConflict } from '../src/modules/work/restore-lineage.ts';
import { initializeRelayCheckpoint, relayCoverage, relayMainOutboxOnce } from '../src/modules/outbox/relay.ts';

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

async function stopFuseki(process: ChildProcess): Promise<void> {
  process.kill('SIGTERM');
  if (process.exitCode === null) await new Promise<void>(resolveExit => process.once('exit', () => resolveExit()));
}

test('OPS03/SYS13 partial: stopped graph, Access and object restore with new lineage', async () => {
  const fusekiHome = Bun.env.REZICS_FUSEKI_HOME;
  const jenaHome = Bun.env.REZICS_JENA_HOME;
  const javaHome = Bun.env.REZICS_JAVA_HOME;
  if (!fusekiHome || !jenaHome || !javaHome) throw new Error('Set Jena/Fuseki/Java integration env');
  const state = join(root, '.temp', `work-recovery-${Bun.randomUUIDv7()}`);
  const liveBase = join(state, 'live', 'run');
  const savedBase = join(state, 'saved-cut', 'run');
  const savedObjects = join(state, 'saved-cut', 'objects');
  const savedPg = join(state, 'saved-cut', 'pgdata');
  const restoreBase = join(state, 'restore', 'run');
  const liveObjects = join(state, 'live', 'objects');
  const restoreObjects = join(state, 'restore', 'objects');
  const livePg = join(state, 'live', 'pgdata');
  const restorePg = join(state, 'restore', 'pgdata');
  const journalPg = join(state, 'journal', 'pgdata');
  mkdirSync(join(liveBase, 'databases/rezics/tdb2'), { recursive: true });
  mkdirSync(join(liveBase, 'databases/rezics/lucene'), { recursive: true });
  copyFileSync(join(root, 'docs/operations/examples/fuseki-text.ttl'), join(liveBase, 'fuseki-text.ttl'));
  mkdirSync(join(state, 'restore'), { recursive: true });
  mkdirSync(join(state, 'saved-cut'), { recursive: true });
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const startFuseki = async (base: string, label: string) => {
    const port = await freePort();
    const log = openSync(join(state, `${label}-fuseki.log`), 'w');
    const serverProcess = spawn(join(fusekiHome, 'fuseki-server'), [
      '--localhost', `--port=${port}`, '--no-cors', '--timeout=10000', `--config=${join(base, 'fuseki-text.ttl')}`,
    ], { cwd: base, env: { ...process.env, JAVA_HOME: javaHome, FUSEKI_HOME: fusekiHome,
      FUSEKI_BASE: base, MAIN: 'main', JVM_ARGS: '-Xms128m -Xmx1g' }, stdio: ['ignore', log, log] });
    closeSync(log);
    const fuseki = new FusekiClient(`http://127.0.0.1:${port}/rezics`);
    for (let i = 0; i < 120; i++) {
      try { if ((await fuseki.query('ASK {}')).boolean === true) return { process: serverProcess, fuseki, port }; }
      catch { /* starting */ }
      if (i === 119) throw new Error(`${label} Fuseki did not start`);
      await Bun.sleep(250);
    }
    throw new Error(`${label} Fuseki did not start`);
  };
  const startPg = async (data: string, label: string) => {
    const port = await freePort();
    execFileSync('pg_ctl', ['-D', data, '-l', join(state, `${label}-postgres.log`),
      '-o', `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
    return { pool: new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' }), data };
  };
  let graph: Awaited<ReturnType<typeof startFuseki>> | undefined;
  let database: Awaited<ReturnType<typeof startPg>> | undefined;
  let journal: Awaited<ReturnType<typeof startPg>> | undefined;
  let latestAccess: Awaited<ReturnType<typeof startPg>> | undefined;
  try {
    graph = await startFuseki(liveBase, 'live');
    execFileSync('initdb', ['-D', livePg, '-A', 'trust', '--no-instructions'], { cwd: state });
    database = await startPg(livePg, 'live');
    mkdirSync(join(state, 'journal'), { recursive: true });
    execFileSync('initdb', ['-D', journalPg, '-A', 'trust', '--no-instructions'], { cwd: state });
    journal = await startPg(journalPg, 'journal');
    let fuseki = graph.fuseki;
    let pool = database.pool;
    await journal.pool.query(readFileSync(join(root, 'services/main/migrations/relay/001_delivery.sql'), 'utf8'));
    await journal.pool.query(readFileSync(join(root, 'services/main/migrations/relay/002_coverage_scan.sql'), 'utf8'));
    await journal.pool.query(readFileSync(join(root, 'services/main/migrations/relay/003_retained_batches.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/001_admission.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/002_claim_and_seal.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/003_recovery_fence.sql'), 'utf8'));
    const principalId = Bun.randomUUIDv7();
    const actor = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const principal = { issuer: 'https://account.recovery.test', subject: 'recovery-user' };
    await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await pool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root')");
    await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    for (const action of ['work.create', 'work.edit']) {
      await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [Bun.randomUUIDv7(), principalId, actor, action]);
    }
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, 'work:create:root', 'work.create', now() + interval '1 hour')`, [Bun.randomUUIDv7(), actor]);
    const account = { async verify(request: Request, scopes: readonly string[]) {
      if (request.headers.get('authorization') !== 'Bearer recovery'
        || !['work:create', 'work:edit'].includes(scopes.join(' '))) throw new Error('invalid recovery fixture token');
      return principal;
    } };
    const request = new Request('https://main.rezics.test/v1/works', {
      method: 'POST', headers: { authorization: 'Bearer recovery' },
    });
    const oldLineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '1' };
    const liveEnv: WorkActivationEnvironment = { fuseki, lineage: oldLineage,
      objectDirectory: liveObjects, candidateDirectory: join(state, 'live', 'candidates'),
      repositoryRoot: root, jenaHome, javaHome, python: 'python3' };
    await initializeFreshGraph(fuseki, oldLineage);
    await initializeRelayCheckpoint(journal.pool, 'recovery-handoff', oldLineage.dataEpoch);
    let access = new AccessAdmissionRegistry(pool);
    const createInput = { actingSubject: actor, idempotencyKey: 'before-backup-create', title: 'Backup Work' };
    const created = await createAdmittedMetadataWork(liveEnv, account, access, request, createInput);
    expect(created.sequence).toBe('1');
    const editScope = `work:edit:${created.work}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [editScope]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.edit', now() + interval '1 hour')`, [Bun.randomUUIDv7(), actor, editScope]);
    const editInput = { work: created.work, expectedHead: created.workRevision,
      title: 'Backup edited Work', actingSubject: actor, idempotencyKey: 'before-backup-edit' };
    const edited = await editAdmittedMetadataWork(liveEnv, account, access, request, editInput);
    expect(edited.sequence).toBe('2');
    const externalAccessOutbox = await accessOutboxCoverage(pool);
    const externalAccessState = await accessStateCoverage(pool);
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('1');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('2');
    const externalRelay = await relayCoverage(journal.pool, 'recovery-handoff');
    await stopFuseki(graph.process);
    graph = undefined;
    await pool.end();
    execFileSync('pg_ctl', ['-D', livePg, '-m', 'fast', '-w', 'stop'], { cwd: state });
    database = undefined;
    cpSync(liveBase, savedBase, { recursive: true });
    cpSync(liveObjects, savedObjects, { recursive: true });
    execFileSync('cp', ['-a', livePg, savedPg], { cwd: state });
    cpSync(savedBase, restoreBase, { recursive: true });
    cpSync(savedObjects, restoreObjects, { recursive: true });
    execFileSync('cp', ['-a', savedPg, restorePg], { cwd: state });
    graph = await startFuseki(restoreBase, 'restore');
    database = await startPg(restorePg, 'restore');
    fuseki = graph.fuseki;
    pool = database.pool;
    access = new AccessAdmissionRegistry(pool);
    const nextLineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '2' };
    let accessFenceGeneration = await engageAccessRecoveryFence(pool);
    const restoredEnv: WorkActivationEnvironment = { ...liveEnv, fuseki,
      lineage: nextLineage, objectDirectory: restoreObjects,
      candidateDirectory: join(state, 'restore', 'candidates') };
    expect((await readExactWorkRevision(restoredEnv, created.workRevision, async () => true)).title).toBe('Backup Work');
    expect((await readExactWorkRevision(restoredEnv, edited.revision, async () => true)).title).toBe('Backup edited Work');
    expect((await pool.query<{ count: string }>('SELECT count(*) FROM access.admission WHERE state = \'sealed\''))
      .rows[0]!.count).toBe('2');
    const cutover = { prior: { ...oldLineage, sequence: '2' }, next: nextLineage };
    class LostCutoverResponseClient extends FusekiClient {
      override async update(sparql: string): Promise<void> {
        await super.update(sparql);
        throw new Error('simulated lost cutover response');
      }
    }
    expect(await cutoverRestoredGraphLineage(
      new LostCutoverResponseClient(`http://127.0.0.1:${graph.port}/rezics`), cutover)).toEqual({
      lineage: nextLineage, sequence: '0', replayed: false,
    });
    expect((await cutoverRestoredGraphLineage(fuseki, cutover)).replayed).toBe(true);
    const oldReadiness = await createMainApp(fuseki, { environment: { ...restoredEnv, lineage: oldLineage },
      account, access }).handle(new Request('http://localhost/health/ready'));
    expect(oldReadiness.status).toBe(503);
    const newReadiness = await createMainApp(fuseki, { environment: restoredEnv,
      account, access }).handle(new Request('http://localhost/health/ready'));
    expect(newReadiness.status).toBe(503);
    await releaseAccessRecoveryFence(pool, accessFenceGeneration);
    await expect(releaseRestoredGraphHold(fuseki, pool, journal.pool, nextLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: externalAccessState.count, accessStateDigest: externalAccessState.digest,
      relay: externalRelay,
    })).rejects.toThrow('Access recovery fence is not held');
    accessFenceGeneration = await engageAccessRecoveryFence(pool);
    await expect(createAdmittedMetadataWork(restoredEnv, account, access, request, createInput))
      .rejects.toBeInstanceOf(RecoveryHold);
    const heldApp = createMainApp(fuseki, { environment: restoredEnv, account, access });
    const heldResponse = await heldApp.handle(new Request('http://localhost/v1/works', {
      method: 'POST', headers: { authorization: 'Bearer recovery',
        'content-type': 'application/json', 'idempotency-key': createInput.idempotencyKey },
      body: JSON.stringify({ profile: 'metadata-only-v1', title: createInput.title, actingSubject: actor }),
    }));
    expect(heldResponse.status).toBe(503);
    expect((await heldResponse.json() as { code: string }).code).toBe('recovery_hold');
    const oldWorkerIntent = { admission: { id: Bun.randomUUIDv7(), scope: editScope,
      action: 'work.edit', requestDigest: metadataWorkEditDigest(created.work, edited.revision, 'Old worker title'),
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      work: created.work, expectedHead: edited.revision, title: 'Old worker title' };
    await expect(editMetadataWork({ ...restoredEnv, lineage: oldLineage }, oldWorkerIntent))
      .rejects.toBeInstanceOf(PendingActivation);
    await expect(releaseRestoredGraphHold(fuseki, pool, journal.pool, nextLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '3',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: externalAccessState.count, accessStateDigest: externalAccessState.digest,
      relay: externalRelay,
    })).rejects.toBeInstanceOf(RestoreLineageConflict);
    await expect(releaseRestoredGraphHold(fuseki, pool, journal.pool, nextLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: '0'.repeat(64),
      accessStateCount: externalAccessState.count, accessStateDigest: externalAccessState.digest,
      relay: externalRelay,
    })).rejects.toBeInstanceOf(RestoreLineageConflict);
    await expect(releaseRestoredGraphHold(fuseki, pool, journal.pool, nextLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: externalAccessState.count, accessStateDigest: '0'.repeat(64),
      relay: externalRelay,
    })).rejects.toThrow('Access state differs from recovery coverage');
    await releaseRestoredGraphHold(fuseki, pool, journal.pool, nextLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: externalAccessState.count, accessStateDigest: externalAccessState.digest,
      relay: externalRelay,
    });
    await expect(releaseRestoredGraphHold(fuseki, pool, journal.pool, nextLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: externalAccessState.count, accessStateDigest: externalAccessState.digest,
      relay: externalRelay,
    })).resolves.toBeUndefined();
    await expect(access.register({ principal, actingSubject: actor, scope: 'work:create:root',
      action: 'work.create', idempotencyKey: 'held-access',
      requestDigest: '0'.repeat(64) })).rejects.toThrow('Access is held for recovery');
    await releaseAccessRecoveryFence(pool, accessFenceGeneration);
    const releasedReadiness = await createMainApp(fuseki, { environment: restoredEnv,
      account, access }).handle(new Request('http://localhost/health/ready'));
    expect(releasedReadiness.status).toBe(200);
    const replayed = await createAdmittedMetadataWork(restoredEnv, account, access, request, createInput);
    expect(replayed).toEqual({ ...created, replayed: true });
    const newEditInput = { work: created.work, expectedHead: edited.revision,
      title: 'After restore Work', actingSubject: actor, idempotencyKey: 'after-restore-edit' };
    const afterRestore = await editAdmittedMetadataWork(restoredEnv, account, access, request, newEditInput);
    expect(afterRestore.dataEpoch).toBe(nextLineage.dataEpoch);
    expect(afterRestore.sequence).toBe('1');
    expect((await readExactWorkRevision(restoredEnv, created.workRevision, async () => true)).title).toBe('Backup Work');
    expect((await readExactWorkRevision(restoredEnv, edited.revision, async () => true)).title).toBe('Backup edited Work');
    const latest = await readExactWorkRevision(restoredEnv, afterRestore.revision, async () => true);
    expect(latest.title).toBe('After restore Work');
    expect(latest.sourcePosition).toEqual({ datasetId: 'product', dataEpoch: nextLineage.dataEpoch, sequence: '1' });
    expect((await pool.query<{ count: string }>('SELECT count(*) FROM access.admission WHERE state = \'sealed\''))
      .rows[0]!.count).toBe('3');
    const textMatch = await fuseki.query(`PREFIX text: <http://jena.apache.org/text#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?work WHERE { GRAPH <urn:rezics:graph:current> {
        (?work ?score ?literal) text:query (rdfs:label "After restore" 10) .
        ?work rdfs:label ?literal .
      } }`);
    expect(textMatch.results?.bindings.map(row => row.work?.value)).toContain(created.work);

    // A separate timeline commits after the saved cut. Restoring that older cut
    // cannot safely replay the later key without the authoritative journal.
    await stopFuseki(graph.process);
    graph = undefined;
    await pool.end();
    execFileSync('pg_ctl', ['-D', restorePg, '-m', 'fast', '-w', 'stop'], { cwd: state });
    database = undefined;
    graph = await startFuseki(liveBase, 'later-live');
    database = await startPg(livePg, 'later-live');
    fuseki = graph.fuseki;
    pool = database.pool;
    access = new AccessAdmissionRegistry(pool);
    const laterInput = { work: created.work, expectedHead: edited.revision,
      title: 'Effect after saved cut', actingSubject: actor, idempotencyKey: 'later-effect' };
    const laterEffect = await editAdmittedMetadataWork({ ...liveEnv, fuseki }, account, access, request, laterInput);
    expect(laterEffect.sequence).toBe('3');
    const laterCreateInput = { actingSubject: actor, idempotencyKey: 'later-create',
      title: 'Created after saved cut' };
    const laterCreate = await createAdmittedMetadataWork({ ...liveEnv, fuseki },
      account, access, request, laterCreateInput);
    expect(laterCreate.sequence).toBe('4');
    const cancelledInput = { actingSubject: actor, idempotencyKey: 'later-cancelled-create',
      title: 'Cancelled after saved cut' };
    const cancelledAdmission = await access.register({ principal,
      actingSubject: actor, scope: 'work:create:root', action: 'work.create',
      idempotencyKey: cancelledInput.idempotencyKey,
      requestDigest: metadataWorkRequestDigest(cancelledInput.title) });
    const cancelledReceipt = await sealMetadataWorkAdmission({ ...liveEnv, fuseki }, cancelledAdmission);
    await access.recordGraphOutcome(cancelledAdmission.id, cancelledReceipt);
    expect(cancelledReceipt.sequence).toBe('5');
    const staleInput = { work: created.work, expectedHead: created.workRevision,
      title: 'Rejected after saved cut', actingSubject: actor, idempotencyKey: 'later-stale-edit' };
    await expect(editAdmittedMetadataWork({ ...liveEnv, fuseki }, account, access, request, staleInput))
      .rejects.toBeInstanceOf(StaleWorkHead);
    const emptyBatch = `urn:rezics:outbox:${Bun.randomUUIDv7()}`;
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 6 } }
      INSERT { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 7 }
        GRAPH <urn:rezics:graph:outbox> { <${emptyBatch}> a rv:OutboxBatch ;
          rv:dataEpoch "${oldLineage.dataEpoch}" ; rv:sequence 7 ; rv:eventCount 0 . } }
      WHERE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 6 } }`);
    const laterClosure = await access.strongCloseScope('work:create:root', '0');
    expect(laterClosure.authorityEpoch).toBe('1');
    expect(laterClosure.pending).toBe(0);
    const laterAccessOutbox = await accessOutboxCoverage(pool);
    const laterAccessState = await accessStateCoverage(pool);
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('3');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('4');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('5');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('6');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('7');
    const laterRelay = await relayCoverage(journal.pool, 'recovery-handoff');
    expect(laterRelay.batchCount).toBe('7');
    expect(laterRelay.eventCount).toBe('6');
    await stopFuseki(graph.process);
    graph = undefined;
    await pool.end();
    execFileSync('pg_ctl', ['-D', livePg, '-m', 'fast', '-w', 'stop'], { cwd: state });
    database = undefined;
    const olderBase = join(state, 'older-restore', 'run');
    const olderPg = join(state, 'older-restore', 'pgdata');
    mkdirSync(join(state, 'older-restore'), { recursive: true });
    cpSync(savedBase, olderBase, { recursive: true });
    execFileSync('cp', ['-a', savedPg, olderPg], { cwd: state });
    graph = await startFuseki(olderBase, 'older-restore');
    database = await startPg(olderPg, 'older-restore');
    fuseki = graph.fuseki;
    pool = database.pool;
    access = new AccessAdmissionRegistry(pool);
    const olderLineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '2' };
    await engageAccessRecoveryFence(pool);
    await cutoverRestoredGraphLineage(fuseki, { prior: { ...oldLineage, sequence: '2' }, next: olderLineage });
    await expect(releaseRestoredGraphHold(fuseki, pool, journal.pool, olderLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '7',
      accessOutboxCount: laterAccessOutbox.count, accessOutboxDigest: laterAccessOutbox.digest,
      accessStateCount: laterAccessState.count, accessStateDigest: laterAccessState.digest,
      relay: laterRelay,
    })).rejects.toBeInstanceOf(RestoreLineageConflict);
    await expect(releaseRestoredGraphHold(fuseki, pool, journal.pool, olderLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: externalAccessState.count, accessStateDigest: externalAccessState.digest,
      relay: externalRelay,
    })).rejects.toThrow('relay handoff differs from recovery coverage');
    await expect(releaseRestoredGraphHold(fuseki, pool, journal.pool, olderLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: laterAccessState.count, accessStateDigest: laterAccessState.digest,
      relay: externalRelay,
    })).rejects.toThrow('Access state differs from recovery coverage');
    const olderEnv = { ...restoredEnv, fuseki, lineage: olderLineage };
    const heldOlderApp = createMainApp(fuseki, { environment: olderEnv, account, access });
    const laterReplay = await heldOlderApp.handle(new Request('http://localhost/v1/content-edits', {
      method: 'POST', headers: { authorization: 'Bearer recovery',
        'content-type': 'application/json', 'idempotency-key': laterInput.idempotencyKey },
      body: JSON.stringify({ profile: 'metadata-only-v1', work: laterInput.work,
        expectedHead: laterInput.expectedHead, title: laterInput.title, actingSubject: laterInput.actingSubject }),
    }));
    expect(laterReplay.status).toBe(503);
    expect((await laterReplay.json() as { code: string }).code).toBe('recovery_hold');
    expect((await pool.query<{ count: string }>('SELECT count(*) AS count FROM access.admission'))
      .rows[0]!.count).toBe('2');
    await expect(reconcileRetainedWorkEdit({ ...olderEnv, objectDirectory: liveObjects },
      pool, journal.pool, laterRelay, '3')).rejects.toBeInstanceOf(RetainedEffectConflict);
    latestAccess = await startPg(livePg, 'latest-access');
    await expect(reconcileRetainedWorkEdit({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '3')).rejects.toBeInstanceOf(RetainedEffectConflict);
    const latestFenceGeneration = await engageAccessRecoveryFence(latestAccess.pool);
    await expect(reconcileRetainedWorkEdit({ ...olderEnv, objectDirectory: restoreObjects },
      latestAccess.pool, journal.pool, laterRelay, '3')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replay = await reconcileRetainedWorkEdit({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '3');
    expect(replay.revision).toBe(laterEffect.revision);
    expect(replay.replayed).toBe(false);
    expect((await reconcileRetainedWorkEdit({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '3')).replayed).toBe(true);
    expect((await heldOlderApp.handle(new Request('http://localhost/health/ready'))).status).toBe(503);
    const recoveredRevision = await readExactWorkRevision(
      { ...olderEnv, objectDirectory: liveObjects }, laterEffect.revision, async () => true);
    expect(recoveredRevision.title).toBe('Effect after saved cut');
    expect(recoveredRevision.sourcePosition).toEqual({ datasetId: 'product',
      dataEpoch: oldLineage.dataEpoch, sequence: '3' });
    await expect(releaseRestoredGraphHold(fuseki, latestAccess.pool, journal.pool, olderLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '7',
      accessOutboxCount: laterAccessOutbox.count, accessOutboxDigest: laterAccessOutbox.digest,
      accessStateCount: laterAccessState.count, accessStateDigest: laterAccessState.digest,
      relay: laterRelay,
    })).rejects.toBeInstanceOf(RestoreLineageConflict);
    await expect(reconcileRetainedWorkCreate({ ...olderEnv, objectDirectory: restoreObjects },
      latestAccess.pool, journal.pool, laterRelay, '4')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replayCreate = await reconcileRetainedWorkCreate({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '4');
    expect(replayCreate.work).toBe(laterCreate.work);
    expect(replayCreate.workRevision).toBe(laterCreate.workRevision);
    expect(replayCreate.replayed).toBe(false);
    expect((await reconcileRetainedWorkCreate({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '4')).replayed).toBe(true);
    const recoveredCreate = await readExactWorkRevision(
      { ...olderEnv, objectDirectory: liveObjects }, laterCreate.workRevision, async () => true);
    expect(recoveredCreate.title).toBe('Created after saved cut');
    expect(recoveredCreate.sourcePosition).toEqual({ datasetId: 'product',
      dataEpoch: oldLineage.dataEpoch, sequence: '4' });
    await expect(releaseRestoredGraphHold(fuseki, latestAccess.pool, journal.pool, olderLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '7',
      accessOutboxCount: laterAccessOutbox.count, accessOutboxDigest: laterAccessOutbox.digest,
      accessStateCount: laterAccessState.count, accessStateDigest: laterAccessState.digest,
      relay: laterRelay,
    })).rejects.toBeInstanceOf(RestoreLineageConflict);
    expect((await reconcileRetainedWorkCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '5')).receipt).toBe(cancelledReceipt.receipt);
    expect((await reconcileRetainedWorkCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '5')).replayed).toBe(true);
    expect((await reconcileRetainedWorkCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '6')).reason).toBe('stale-head');
    expect((await reconcileRetainedWorkCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '6')).replayed).toBe(true);
    expect((await reconcileRetainedEmptyBatch(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '7')).batchId).toBe(emptyBatch);
    expect((await reconcileRetainedEmptyBatch(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '7')).replayed).toBe(true);
    expect((await reconcileRetainedWorkEdit({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '3')).replayed).toBe(true);
    expect((await reconcileRetainedWorkCreate({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '4')).replayed).toBe(true);
    expect((await reconcileRetainedWorkCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '5')).replayed).toBe(true);
    await releaseRestoredGraphHold(fuseki, latestAccess.pool, journal.pool, olderLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '7',
      accessOutboxCount: laterAccessOutbox.count, accessOutboxDigest: laterAccessOutbox.digest,
      accessStateCount: laterAccessState.count, accessStateDigest: laterAccessState.digest,
      relay: laterRelay,
    });
    await releaseAccessRecoveryFence(latestAccess.pool, latestFenceGeneration);
    const recoveredAccess = new AccessAdmissionRegistry(latestAccess.pool);
    const recoveredApp = createMainApp(fuseki, { environment: {
      ...olderEnv, objectDirectory: liveObjects }, account, access: recoveredAccess });
    expect((await recoveredApp.handle(new Request('http://localhost/health/ready'))).status).toBe(200);
    expect((await editAdmittedMetadataWork({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, laterInput)).revision).toBe(laterEffect.revision);
    expect((await createAdmittedMetadataWork({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, laterCreateInput)).work).toBe(laterCreate.work);
    await expect(createAdmittedMetadataWork({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, { actingSubject: actor,
        idempotencyKey: 'new-create-after-closure', title: 'Closed create scope' }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await expect(createAdmittedMetadataWork({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, cancelledInput)).rejects.toBeInstanceOf(CancelledActivation);
    await expect(editAdmittedMetadataWork({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, staleInput)).rejects.toBeInstanceOf(StaleWorkHead);
    const postReplayInput = { work: created.work, expectedHead: laterEffect.revision,
      title: 'New lineage after replay', actingSubject: actor, idempotencyKey: 'new-lineage-after-replay' };
    expect((await editAdmittedMetadataWork({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, postReplayInput)).sequence).toBe('1');
  } finally {
    await latestAccess?.pool.end();
    if (latestAccess) execFileSync('pg_ctl', ['-D', latestAccess.data, '-m', 'fast', '-w', 'stop'], { cwd: state });
    await database?.pool.end();
    if (database) execFileSync('pg_ctl', ['-D', database.data, '-m', 'fast', '-w', 'stop'], { cwd: state });
    await journal?.pool.end();
    if (journal) execFileSync('pg_ctl', ['-D', journal.data, '-m', 'fast', '-w', 'stop'], { cwd: state });
    if (graph) await stopFuseki(graph.process);
  }
}, 120_000);
