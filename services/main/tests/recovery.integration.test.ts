import { test, expect } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, copyFileSync, cpSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { createMainApp } from '../src/app.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { createAdmittedMetadataWork } from '../src/modules/work/create-admitted.ts';
import { editAdmittedMetadataWork } from '../src/modules/work/edit-admitted.ts';
import { editMetadataWork, metadataWorkEditDigest } from '../src/modules/work/edit.ts';
import { readExactWorkRevision } from '../src/modules/work/history.ts';
import { initializeFreshGraph, PendingActivation, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { cutoverRestoredGraphLineage } from '../src/modules/work/restore-lineage.ts';

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
  const restoreBase = join(state, 'restore', 'run');
  const liveObjects = join(state, 'live', 'objects');
  const restoreObjects = join(state, 'restore', 'objects');
  const livePg = join(state, 'live', 'pgdata');
  const restorePg = join(state, 'restore', 'pgdata');
  mkdirSync(join(liveBase, 'databases/rezics/tdb2'), { recursive: true });
  mkdirSync(join(liveBase, 'databases/rezics/lucene'), { recursive: true });
  copyFileSync(join(root, 'docs/operations/examples/fuseki-text.ttl'), join(liveBase, 'fuseki-text.ttl'));
  mkdirSync(join(state, 'restore'), { recursive: true });
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
  try {
    graph = await startFuseki(liveBase, 'live');
    execFileSync('initdb', ['-D', livePg, '-A', 'trust', '--no-instructions'], { cwd: state });
    database = await startPg(livePg, 'live');
    let fuseki = graph.fuseki;
    let pool = database.pool;
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/001_admission.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/002_claim_and_seal.sql'), 'utf8'));
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
    await stopFuseki(graph.process);
    graph = undefined;
    await pool.end();
    execFileSync('pg_ctl', ['-D', livePg, '-m', 'fast', '-w', 'stop'], { cwd: state });
    database = undefined;
    cpSync(liveBase, restoreBase, { recursive: true });
    cpSync(liveObjects, restoreObjects, { recursive: true });
    execFileSync('cp', ['-a', livePg, restorePg], { cwd: state });
    graph = await startFuseki(restoreBase, 'restore');
    database = await startPg(restorePg, 'restore');
    fuseki = graph.fuseki;
    pool = database.pool;
    access = new AccessAdmissionRegistry(pool);
    const nextLineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '2' };
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
    expect(newReadiness.status).toBe(200);
    const oldWorkerIntent = { admission: { id: Bun.randomUUIDv7(), scope: editScope,
      action: 'work.edit', requestDigest: metadataWorkEditDigest(created.work, edited.revision, 'Old worker title'),
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      work: created.work, expectedHead: edited.revision, title: 'Old worker title' };
    await expect(editMetadataWork({ ...restoredEnv, lineage: oldLineage }, oldWorkerIntent))
      .rejects.toBeInstanceOf(PendingActivation);
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
  } finally {
    await database?.pool.end();
    if (database) execFileSync('pg_ctl', ['-D', database.data, '-m', 'fast', '-w', 'stop'], { cwd: state });
    if (graph) await stopFuseki(graph.process);
  }
}, 120_000);
