import { test, expect } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { createMainApp } from '../src/app.ts';
import { AccessAdmissionRegistry, AdmissionConflict, AdmissionDenied } from '../src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { createAdmittedMetadataWork } from '../src/modules/work/create-admitted.ts';
import {
  activateMetadataWork, CancelledActivation, IdempotencyConflict, initializeFreshGraph,
  metadataWorkRequestDigest, PendingActivation,
  type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';
import { strongRevokeMetadataWorkScope } from '../src/modules/work/strong-revoke.ts';

const root = resolve(import.meta.dir, '../../..');
const fusekiHome = Bun.env.REZICS_FUSEKI_HOME;
const javaHome = Bun.env.REZICS_JAVA_HOME;
const jenaHome = Bun.env.REZICS_JENA_HOME;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function ready(fuseki: FusekiClient): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fuseki.query('ASK {}')).boolean === true) return;
    } catch { /* process may still be starting */ }
    await Bun.sleep(250);
  }
  throw new Error('Fuseki did not start within 30 seconds');
}

test('IAM07/SYS02/SYS10/SYS14 partial: Work receipt and strong seal races', async () => {
  if (!fusekiHome || !javaHome || !jenaHome) throw new Error('Set REZICS_FUSEKI_HOME, REZICS_JAVA_HOME and REZICS_JENA_HOME');
  const state = join(root, '.temp', `main-integration-${Bun.randomUUIDv7()}`);
  const base = join(state, 'run');
  mkdirSync(join(base, 'databases/rezics/tdb2'), { recursive: true });
  mkdirSync(join(base, 'databases/rezics/lucene'), { recursive: true });
  copyFileSync(join(root, 'docs/operations/examples/fuseki-text.ttl'), join(base, 'fuseki-text.ttl'));
  const port = await freePort();
  const log = openSync(join(state, 'fuseki.log'), 'w');
  const serverProcess = spawn(join(fusekiHome, 'fuseki-server'), [
    '--localhost', `--port=${port}`, '--no-cors', '--timeout=10000', `--config=${join(base, 'fuseki-text.ttl')}`,
  ], {
    cwd: base,
    env: { ...process.env, JAVA_HOME: javaHome, FUSEKI_HOME: fusekiHome, FUSEKI_BASE: base, MAIN: 'main', JVM_ARGS: '-Xms128m -Xmx1g' },
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  const fuseki = new FusekiClient(`http://127.0.0.1:${port}/rezics`);
  const lineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '1' };
  const env: WorkActivationEnvironment = {
    fuseki, lineage,
    objectDirectory: join(state, 'objects'), candidateDirectory: join(state, 'candidates'),
    repositoryRoot: root, jenaHome, javaHome, python: 'python3',
  };
  let accessPool: Pool | undefined;
  let accessData: string | undefined;
  try {
    await ready(fuseki);
    const pgData = join(state, 'access-pgdata');
    const socketDirectory = join(root, '.temp', 'pg-sock');
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
    execFileSync('initdb', ['-D', pgData, '-A', 'trust', '--no-instructions'], { cwd: state });
    const pgPort = await freePort();
    execFileSync('pg_ctl', ['-D', pgData, '-l', join(state, 'access-postgres.log'),
      '-o', `-h 127.0.0.1 -p ${pgPort} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
    accessData = pgData;
    accessPool = new Pool({ host: '127.0.0.1', port: pgPort, user: process.env.USER, database: 'postgres' });
    await accessPool.query(readFileSync(join(root, 'services/main/migrations/access/001_admission.sql'), 'utf8'));
    await accessPool.query(readFileSync(join(root, 'services/main/migrations/access/002_claim_and_seal.sql'), 'utf8'));
    const app = createMainApp(fuseki);
    const mainPort = await freePort();
    app.listen({ hostname: '127.0.0.1', port: mainPort });
    try {
      const readyResponse = await fetch(`http://127.0.0.1:${mainPort}/health/ready`);
      expect(readyResponse.status).toBe(200);
      expect(await readyResponse.json()).toEqual({ status: 'ready' });
    } finally {
      await app.stop();
    }
    const unavailablePort = await freePort();
    const unavailable = await createMainApp(new FusekiClient(`http://127.0.0.1:${unavailablePort}/rezics`))
      .handle(new Request('http://localhost/health/ready'));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: 'unavailable' });
    await initializeFreshGraph(fuseki, lineage);

    const admissions = new Map<string, {
      id: string; scope: string; action: string; idempotencyKey: string;
      requestDigest: string; authorityEpoch: string; expiresAt: string;
    }>();
    const admit = (key: string, title: string) => {
      let value = admissions.get(key);
      if (!value) {
        value = { id: Bun.randomUUIDv7(), scope: 'work:create:root', action: 'work.create',
          idempotencyKey: key, requestDigest: metadataWorkRequestDigest(title),
          authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() };
        admissions.set(key, value);
      }
      return value;
    };
    const intent = { admission: admit('create-1', 'First metadata Work'), title: 'First metadata Work' };
    const created = await activateMetadataWork(env, intent);
    expect(created.replayed).toBe(false);
    expect(created.sequence).toBe('1');
    expect(created.dataEpoch).toBe(lineage.dataEpoch);
    expect(created.admissionId).toBe(intent.admission.id);
    expect(created.work).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]+$/);
    const replay = await activateMetadataWork(env, intent);
    expect(replay).toEqual({ ...created, replayed: true });
    await expect(activateMetadataWork(env, { ...intent, title: 'Other title' })).rejects.toBeInstanceOf(IdempotencyConflict);

    const graph = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?main ?workRevision ?mainRevision WHERE {
      GRAPH <urn:rezics:graph:current> {
        <${created.work}> rv:mainVersion ?main ; rv:head ?workRevision .
        ?main rv:work <${created.work}> ; rv:head ?mainRevision .
      }
    }`);
    const current = graph.results?.bindings;
    expect(current?.length).toBe(1);
    expect(current?.[0]?.main?.value).toBe(created.mainVersion);
    const textMatch = await fuseki.query(`PREFIX text: <http://jena.apache.org/text#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?work WHERE { GRAPH <urn:rezics:graph:current> {
        (?work ?score ?literal) text:query (rdfs:label "First" 10) .
        ?work rdfs:label ?literal .
      } }`);
    expect(textMatch.results?.bindings.map((row) => row.work?.value)).toContain(created.work);
    const revision = current?.[0]?.workRevision?.value;
    expect(revision).toBeDefined();
    const manifestResult = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?manifest WHERE {
      GRAPH <urn:rezics:graph:revisions> { <${revision}> rv:manifest ?manifest }
    }`);
    const manifestIri = manifestResult.results?.bindings[0]?.manifest?.value;
    expect(manifestIri).toMatch(/^urn:rezics:sha256:[0-9a-f]{64}$/);
    const manifestHash = manifestIri!.split(':').at(-1)!;
    const manifest = JSON.parse(readFileSync(join(env.objectDirectory, manifestHash), 'utf8'));
    expect(manifest.component).toBe(created.work);
    expect(manifest.payload).toMatch(/^sha256:[0-9a-f]{64}$/);
    const payloadHash = manifest.payload.split(':').at(-1);
    const payload = readFileSync(join(env.objectDirectory, payloadHash));
    expect(createHash('sha256').update(payload).digest('hex')).toBe(payloadHash);

    class LostResponseClient extends FusekiClient {
      override async update(sparql: string): Promise<void> {
        await super.update(sparql);
        throw new Error('simulated lost response');
      }
    }
    const lost = await activateMetadataWork({ ...env, fuseki: new LostResponseClient(`http://127.0.0.1:${port}/rezics`) },
      { admission: admit('lost-response', 'Recovered Work'), title: 'Recovered Work' });
    expect(lost.sequence).toBe('2');

    const sameKey = { admission: admit('race', 'Racing Work'), title: 'Racing Work' };
    const raced = await Promise.all([activateMetadataWork(env, sameKey), activateMetadataWork(env, sameKey)]);
    expect(raced[0]?.work).toBe(raced[1]?.work);
    expect(raced[0]?.sequence).toBe('3');
    expect(raced[1]?.sequence).toBe('3');

    await expect(activateMetadataWork({ ...env, lineage: { ...lineage, dataEpoch: Bun.randomUUIDv7() } },
      { admission: admit('stale-epoch', 'Must not exist'), title: 'Must not exist' })).rejects.toBeInstanceOf(PendingActivation);
    await expect(activateMetadataWork(env,
      { admission: admit('invalid-title', 'placeholder'), title: '' })).rejects.toThrow('invalid title');
    await expect(activateMetadataWork(env,
      { admission: { ...admit('expired-admission', 'Expired Work'),
        expiresAt: new Date(Date.now() - 1000).toISOString() }, title: 'Expired Work' }))
      .rejects.toBeInstanceOf(PendingActivation);
    const position = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?sequence WHERE {
      GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?sequence }
    }`);
    expect(position.results?.bindings[0]?.sequence?.value).toBe('3');
    const outbox = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT (COUNT(?batch) AS ?count) WHERE {
      GRAPH <urn:rezics:graph:outbox> { ?batch a rv:OutboxBatch }
    }`);
    expect(outbox.results?.bindings[0]?.count?.value).toBe('3');

    const pool = accessPool!;
    const principalId = Bun.randomUUIDv7();
    const actingSubject = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, 'https://account.fixture', 'fixture-account')`, [principalId]);
    await pool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root')");
    await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actingSubject]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actingSubject]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, 'work:create:root', 'work.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actingSubject]);
    const account = {
      async verify(request: Request, scopes: readonly string[]) {
        if (request.headers.get('authorization') !== 'Bearer verified-fixture'
          || scopes.join(' ') !== 'work:create') throw new AccountAssertionDenied('bad fixture assertion');
        return { issuer: 'https://account.fixture', subject: 'fixture-account' };
      },
    };
    const access = new AccessAdmissionRegistry(pool);
    const request = new Request('https://main.rezics.test/works', {
      method: 'POST', headers: { authorization: 'Bearer verified-fixture' },
    });
    const input = { actingSubject, idempotencyKey: 'bridged-create', title: 'Access admitted Work' };
    const bridged = await createAdmittedMetadataWork(env, account, access, request, input);
    expect(bridged.sequence).toBe('4');
    const admission = await pool.query<{ id: string; request_digest: string; authority_epoch: string;
      state: string; graph_outcome: string }>(
      "SELECT id, request_digest, authority_epoch, state, graph_outcome FROM access.admission WHERE idempotency_key = 'bridged-create'");
    expect(admission.rows).toHaveLength(1);
    expect(bridged.admissionId).toBe(admission.rows[0]!.id);
    expect(admission.rows[0]!.request_digest).toBe(metadataWorkRequestDigest(input.title));
    expect(admission.rows[0]!.state).toBe('sealed');
    expect(admission.rows[0]!.graph_outcome).toBe('succeeded');
    const bound = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?id ?epoch ?scope WHERE {
      GRAPH <urn:rezics:graph:receipts> {
        <${bridged.receipt}> rv:admissionId ?id ; rv:authorityEpoch ?epoch ; rv:admittedScope ?scope .
      }
    }`);
    expect(bound.results?.bindings[0]?.id?.value).toBe(bridged.admissionId);
    expect(bound.results?.bindings[0]?.epoch?.value).toBe(admission.rows[0]!.authority_epoch);
    expect(bound.results?.bindings[0]?.scope?.value).toBe('work:create:root');
    expect(await createAdmittedMetadataWork(env, account, access, request, input))
      .toEqual({ ...bridged, replayed: true });
    await expect(createAdmittedMetadataWork(env, account, access, request,
      { ...input, title: 'Conflicting title' })).rejects.toBeInstanceOf(AdmissionConflict);
    await expect(createAdmittedMetadataWork(env, account, access,
      new Request(request.url, { method: 'POST' }), { ...input, idempotencyKey: 'unauthenticated' }))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    await expect(createAdmittedMetadataWork(env, account, access, request,
      { ...input, idempotencyKey: 'wrong-actor', actingSubject: `https://rezics.com/id/${Bun.randomUUIDv7()}` }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const after = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?sequence WHERE {
      GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?sequence }
    }`);
    expect(after.results?.bindings[0]?.sequence?.value).toBe('4');

    const delayedTitle = 'Cancelled before delayed graph dispatch';
    const pending = await access.register({ principal: { issuer: 'https://account.fixture',
      subject: 'fixture-account' }, actingSubject, scope: 'work:create:root', action: 'work.create',
      idempotencyKey: 'delayed-dispatch', requestDigest: metadataWorkRequestDigest(delayedTitle) });
    const claimedPending = await access.claim(pending.id, pending.requestDigest);
    const winningTitle = 'Claimed work wins before cancellation seal';
    const winning = await access.register({ principal: { issuer: 'https://account.fixture',
      subject: 'fixture-account' }, actingSubject, scope: 'work:create:root', action: 'work.create',
      idempotencyKey: 'wins-after-close', requestDigest: metadataWorkRequestDigest(winningTitle) });
    const claimedWinning = await access.claim(winning.id, winning.requestDigest);
    let signalUpdate!: () => void;
    let releaseUpdate!: () => void;
    const updateStarted = new Promise<void>(resolveStart => { signalUpdate = resolveStart; });
    const updateReleased = new Promise<void>(resolveRelease => { releaseUpdate = resolveRelease; });
    class DelayedUpdateClient extends FusekiClient {
      override async update(sparql: string): Promise<void> {
        signalUpdate();
        await updateReleased;
        return super.update(sparql);
      }
    }
    const delayed = activateMetadataWork({ ...env,
      fuseki: new DelayedUpdateClient(`http://127.0.0.1:${port}/rezics`) },
    { admission: claimedPending, title: delayedTitle }).then(() => null, error => error);
    await Promise.race([updateStarted, Bun.sleep(10_000).then(() => {
      throw new Error('delayed graph update never reached dispatch');
    })]);
    const fence = await access.strongCloseScope('work:create:root', '0');
    expect(fence.pending).toBe(2);
    const unavailableSealPort = await freePort();
    const unavailableSeal = await strongRevokeMetadataWorkScope({ ...env,
      fuseki: new FusekiClient(`http://127.0.0.1:${unavailableSealPort}/rezics`) },
    access, fence.authorityEpoch);
    expect(unavailableSeal).toEqual({ scope: 'work:create:root', authorityEpoch: '1',
      status: 'pending', pending: 2 });
    const wonAfterFence = await activateMetadataWork(env, { admission: claimedWinning, title: winningTitle });
    expect(wonAfterFence.sequence).toBe('5');
    const revoked = await strongRevokeMetadataWorkScope(env, access, fence.authorityEpoch);
    expect(revoked).toEqual({ scope: 'work:create:root', authorityEpoch: '1',
      status: 'complete', pending: 0 });
    releaseUpdate();
    expect(await delayed).toBeInstanceOf(CancelledActivation);
    const sealed = await pool.query<{ state: string; graph_outcome: string; graph_sequence: string }>(
      'SELECT state, graph_outcome, graph_sequence FROM access.admission WHERE id = $1', [pending.id]);
    expect(sealed.rows[0]).toEqual({ state: 'sealed', graph_outcome: 'cancelled', graph_sequence: '6' });
    const winningSeal = await pool.query<{ state: string; graph_outcome: string; graph_sequence: string }>(
      'SELECT state, graph_outcome, graph_sequence FROM access.admission WHERE id = $1', [winning.id]);
    expect(winningSeal.rows[0]).toEqual({ state: 'sealed', graph_outcome: 'succeeded', graph_sequence: '5' });
    await expect(access.claim(pending.id, pending.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    expect(await createAdmittedMetadataWork(env, account, access, request, input))
      .toEqual({ ...bridged, replayed: true });
    await expect(createAdmittedMetadataWork(env, account, access, request,
      { ...input, idempotencyKey: 'after-strong-close' })).rejects.toBeInstanceOf(AdmissionDenied);
    await pool.query("UPDATE access.permission_grant SET active = false WHERE scope_id = 'work:create:root'");
    await expect(createAdmittedMetadataWork(env, account, access, request, input))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const finalPosition = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?sequence WHERE {
      GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?sequence }
    }`);
    expect(finalPosition.results?.bindings[0]?.sequence?.value).toBe('6');
  } finally {
    await accessPool?.end();
    if (accessData) execFileSync('pg_ctl', ['-D', accessData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    serverProcess.kill('SIGTERM');
    if (serverProcess.exitCode === null) {
      await new Promise<void>((resolveExit) => serverProcess.once('exit', () => resolveExit()));
    }
  }
}, 120_000);
