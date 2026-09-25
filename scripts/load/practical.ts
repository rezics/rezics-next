import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, type WorkActivationEnvironment }
  from '../../services/main/src/modules/work/activate.ts';
import { editMetadataWork, metadataWorkEditDigest }
  from '../../services/main/src/modules/work/edit.ts';
import { activateTextContribution, textContributionDigest }
  from '../../services/main/src/modules/contribution/draft.ts';
import { editTextContributionDraft, textContributionEditDigest }
  from '../../services/main/src/modules/contribution/edit.ts';
import { privateDraftUnit } from '../../services/main/src/modules/contribution/private-projection.ts';
import { queryPrivateContributionPhrase }
  from '../../services/main/src/modules/contribution/search-private.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../services/main/src/modules/contribution/publish.ts';
import { selectMainDefault, mainSelectionDigest, PUBLIC_SEARCH_GRAPH }
  from '../../services/main/src/modules/work/select-main.ts';
import { setStandingRating, standingRatingDigest }
  from '../../services/main/src/modules/rating/observation.ts';
import { seedPracticalCorpus, type PracticalCorpus, type LoadAuthority, replacementContribution,
  writerCohorts, writerIndex }
  from './corpus.ts';
import { delta, laneReadLatencies, laneReadP95Within, parseCgroupMemory, percentile,
  processHighWaterKiB, relayBacklogTrend, searchProofDelta, selectPhraseQuery, startFusekiMeter }
  from './measurement.ts';
import { fusekiImageFromCompose } from './image.ts';
import type { LoadCase } from '../../tests/qa/load/corpus.ts';

const root = resolve(import.meta.dir, '../..');
const count = Number(process.argv[2]);
const durationSeconds = Number(process.argv[3]);
const artifacts = process.argv[4]!;
const seedWorkers = Number(process.argv[5]);
if (!Number.isInteger(count) || count < 10 || count > 10_000
  || !Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 180
  || !Number.isInteger(seedWorkers) || seedWorkers < 1 || seedWorkers > 4
  || !artifacts || !process.env.REZICS_LOAD_RUN_ID) throw new Error('Run through yarn load');
const fusekiImage = fusekiImageFromCompose(readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8'));

const needed = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const upstream = needed('FUSEKI_URL');
const meter = startFusekiMeter(upstream);
const env: WorkActivationEnvironment = { fuseki: new FusekiClient(upstream),
  lineage: { dataEpoch: needed('MAIN_DATA_EPOCH'), routingEpoch: needed('MAIN_ROUTING_EPOCH') },
  objectDirectory: needed('MAIN_OBJECT_DIRECTORY') };
let contentPool = new Pool({ connectionString: needed('CONTENT_DATABASE_URL') });
let accessPool = new Pool({ connectionString: needed('ACCESS_DATABASE_URL') });
let relayPool = new Pool({ connectionString: needed('ACCOUNT_RELAY_DATABASE_URL') });
let poolsOpen = true;
const relayEnvironment = { ...process.env, MAIN_RELAY_DATABASE_URL: needed('ACCOUNT_RELAY_DATABASE_URL'),
  MAIN_RELAY_CONSUMER: 'practical-load', MAIN_RELAY_INTERVAL_MS: '100' };
const mainUrl = `http://127.0.0.1:${needed('MAIN_PORT')}`;
const evidence: Record<string, unknown> = { acceptanceIds: ['OPS05', 'SEARCH18', 'SEARCH19'],
  works: count, durationSeconds, seedWorkers,
  images: { k6: 'grafana/k6:2.3.0', fuseki: fusekiImage.image }, clients: 10,
  offeredMix: { publicReads: 0.8, admittedWrites: 0.2, hotWorkCohort: 0.1,
    hotReadShare: 0.5, hotRequestShare: 0.5 },
  source: 'authorized product commands with Access register/claim/seal',
  startedAt: new Date().toISOString() };
let main: ChildProcess | undefined, relay: ChildProcess | undefined;
let highWaterKiB = 0;
const sampleMemory = setInterval(() => {
  if (main?.pid) highWaterKiB = Math.max(highWaterKiB, processHighWaterKiB(main.pid) ?? 0);
}, 1000);

function service(name: string, script: string, extra: NodeJS.ProcessEnv = {}): ChildProcess {
  const fd = openSync(join(artifacts, `${name}.log`), 'a');
  const child = spawn('bun', [script], { cwd: root, env: { ...process.env, ...extra },
    stdio: ['ignore', fd, fd] });
  closeSync(fd);
  return child;
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child!.once('exit', resolve)), Bun.sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function ready(search = true): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until && main?.exitCode === null) {
    try {
      const response = await fetch(`${mainUrl}/health/${search ? 'search-ready' : 'ready'}`,
        { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch { /* startup */ }
    await Bun.sleep(250);
  }
  throw new Error(`Main ${search ? 'search' : 'service'} readiness timed out`);
}

function body(item: LoadCase, realm: string) {
  return { profile: item.lane === 'realm' ? 'public-realm-phrase-v1'
    : item.lane === 'content' ? 'public-content-phrase-v1' : 'public-main-phrase-v1',
    ...(item.lane === 'realm' ? { context: { kind: 'realm-local', id: realm } } : {}),
    phrase: item.phrase, language: item.language };
}

async function query(item: LoadCase, corpus: PracticalCorpus) {
  const before = meter.snapshot();
  const started = performance.now();
  const request = JSON.stringify(body(item, corpus.realm));
  const response = await fetch(`${mainUrl}/v1/queries`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: request,
    signal: AbortSignal.timeout(10_000) });
  const bytes = await response.arrayBuffer();
  const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>;
  const expectedPopulation = item.lane === 'content' ? corpus.contentUnits
    : corpus.mainUnits + corpus.contentUnits;
  if (response.status !== 200 || snapshot.contractVersion !== '1' || snapshot.complete !== true
    || snapshot.population !== expectedPopulation
    || snapshot.total !== (item.expectedWork === null ? 0 : 1)
    || snapshot.results?.length !== snapshot.total
    || item.expectedWork !== null && snapshot.results?.[0]?.[
      item.lane === 'content' ? 'resource' : 'work'] !== item.expectedWork
    || item.expectedContribution && snapshot.results?.[0]?.contribution !== item.expectedContribution
    || item.expectedReason && snapshot.results?.[0]?.reason !== item.expectedReason) {
    throw new Error(`${item.name} returned an incomplete or incorrect ${response.status} snapshot: ${JSON.stringify(snapshot).slice(0, 500)}`);
  }
  return { status: response.status, latencyMs: performance.now() - started,
    requestBytes: Buffer.byteLength(request), responseBytes: bytes.byteLength,
    remote: delta(meter.snapshot(), before), total: snapshot.total,
    population: snapshot.population, indexGeneration: snapshot.indexGeneration,
    sourcePosition: snapshot.sourcePosition ?? snapshot.contentPosition };
}

async function queryCases(corpus: PracticalCorpus) {
  const results: Record<string, Awaited<ReturnType<typeof query>>> = {};
  for (const item of corpus.cases) results[item.name] = await query(item, corpus);
  return results;
}

async function waitContent(corpus: PracticalCorpus): Promise<void> {
  const item = corpus.cases.find(value => value.lane === 'content')!;
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try { await query(item, corpus); return; }
    catch { await Bun.sleep(500); }
  }
  throw new Error('Content projection did not become complete in 60 seconds');
}

async function graphSequence(): Promise<bigint> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE { GRAPH <${GRAPHS.control}> {
    <${DATASET}> rv:sequence ?n } }`);
  const value = result.results?.bindings?.[0]?.n?.value;
  if (!value) throw new Error('graph sequence missing');
  return BigInt(value);
}

async function relayLag() {
  const graph = await graphSequence();
  const result = await relayPool.query<{ sequence: string }>(
    'SELECT sequence::text FROM relay.checkpoint WHERE consumer = $1', ['practical-load']);
  const checkpoint = BigInt(result.rows[0]?.sequence ?? '-1');
  return { graph: graph.toString(), checkpoint: checkpoint.toString(),
    lag: (graph - checkpoint).toString() };
}

async function waitRelay() {
  const started = Date.now();
  const until = Date.now() + 120_000;
  let last = await relayLag();
  while (BigInt(last.lag) > 0n && Date.now() < until) {
    await Bun.sleep(1000);
    last = await relayLag();
  }
  if (BigInt(last.lag) !== 0n) throw new Error(`Main relay backlog remained at ${last.lag}`);
  return { ...last, drainMs: Date.now() - started };
}

async function verifySamples(corpus: PracticalCorpus) {
  const indices = [...new Set([0, 1, 3, 4, 5, 6, 8,
    Math.floor(corpus.works.length / 2), corpus.works.length - 1])];
  const results: { index: number; head: string; selection: string; receipt: string;
    editReceipt?: string; exact: boolean }[] = [];
  for (const index of indices) {
    const item = corpus.works[index]!;
    const answer = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH <${GRAPHS.current}> {
        <${item.work}> rv:head <${item.head}> .
        <${item.main}> rv:selectionHead <${item.selection}> .
      }
      GRAPH <${GRAPHS.receipts}> {
        <${item.createReceipt}> rv:work <${item.work}> .
        <${item.selectionReceipt}> rv:selection <${item.selection}> .
        ${item.editReceipt ? `<${item.editReceipt}> rv:workRevision <${item.head}> .` : ''}
      }
    }`);
    results.push({ index, head: item.head, selection: item.selection,
      receipt: item.selectionReceipt, editReceipt: item.editReceipt,
      exact: answer.boolean === true });
  }
  if (results.some(result => !result.exact)) throw new Error('sampled receipt or head differs after restart');
  return results;
}

async function privateNativeProof(corpus: PracticalCorpus, authority: LoadAuthority) {
  const work = corpus.works[0]!.work;
  const originalTerm = `hidden${randomUUID().replaceAll('-', '')}`;
  const currentTerm = `revised${randomUUID().replaceAll('-', '')}`;
  const draftInput = { work, language: 'en',
    body: `Private ${originalTerm} corpus canary`, actingSubject: authority.actor };
  const created = await authority.run(`contribution:create:${work}`, 'contribution.create',
    textContributionDigest(draftInput),
    admission => activateTextContribution(env, admission, draftInput));
  if (!created.contribution || !created.draftRevision)
    throw new Error('private load canary lacks its exact draft');
  const first = await queryPrivateContributionPhrase(env,
    { contribution: created.contribution, phrase: originalTerm });
  if (first.total !== 1 || first.results[0]?.matchUnit !== privateDraftUnit(created.draftRevision))
    throw new Error('private load canary did not match its first head');
  const editInput = { contribution: created.contribution, expectedHead: created.draftRevision,
    body: `Private ${currentTerm} corpus canary`, actingSubject: authority.actor };
  const edited = await authority.run(`contribution:edit:${created.contribution}`, 'contribution.edit',
    textContributionEditDigest(editInput),
    admission => editTextContributionDraft(env, admission, editInput));
  if (!edited.draftRevision) throw new Error('private load canary edit lacks its exact head');
  const old = await queryPrivateContributionPhrase(env,
    { contribution: created.contribution, phrase: originalTerm });
  const current = await queryPrivateContributionPhrase(env,
    { contribution: created.contribution, phrase: currentTerm });
  if (old.total !== 0 || current.total !== 1
    || current.results[0]?.matchUnit !== privateDraftUnit(edited.draftRevision)) {
    throw new Error('private load canary did not replace the old posting');
  }
  const publicResult = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?unit WHERE { GRAPH <${PUBLIC_SEARCH_GRAPH}> {
      (?unit ?score) text:query (rv:searchBody ${JSON.stringify(currentTerm)} 2) .
    } }`);
  if (publicResult.results?.bindings?.length) throw new Error('private load canary reached the public field');
  return { contribution: created.contribution, firstHead: created.draftRevision,
    currentHead: edited.draftRevision, firstUnit: first.results[0]!.matchUnit,
    currentUnit: current.results[0]!.matchUnit, originalTerm, currentTerm,
    indexGeneration: current.indexGeneration,
    sourcePosition: current.sourcePosition };
}

async function graphSize() {
  const graphs = [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.outbox,
    PUBLIC_SEARCH_GRAPH];
  const counts: Record<string, number> = {};
  for (const graph of graphs) {
    const result = await env.fuseki.query(`SELECT (COUNT(*) AS ?n) WHERE {
      GRAPH <${graph}> { ?s ?p ?o } }`);
    counts[graph] = Number(result.results?.bindings?.[0]?.n?.value ?? NaN);
    if (!Number.isSafeInteger(counts[graph])) throw new Error(`invalid triple count in ${graph}`);
  }
  return counts;
}

function containerId(service: 'fuseki' | 'postgres'): string {
  const project = `rezics-qa-${needed('REZICS_LOAD_RUN_ID')}`;
  const id = spawnSync('docker', ['ps', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}'],
  { cwd: root, env: dockerEnv(), encoding: 'utf8', timeout: 5000 });
  const container = id.stdout.trim().split('\n')[0];
  if (id.status !== 0 || !container) throw new Error(`${service} container unavailable: ${id.stderr}`);
  return container;
}

function containerMemory(service: 'fuseki' | 'postgres') {
  const container = containerId(service);
  const result = spawnSync('docker', ['exec', container, 'sh', '-c',
    'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.stat'],
  { cwd: root, env: dockerEnv(), encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0)
    throw new Error(`${service} memory counters unavailable: ${result.stderr}`);
  return { containerId: container, ...parseCgroupMemory(result.stdout),
    basis: service === 'fuseki' ? 'Fuseki single JVM container cgroup' : 'PostgreSQL container cgroup' };
}

function storageSizes() {
  const container = containerId('fuseki');
  const size = spawnSync('docker', ['exec', container, 'du', '-sb',
    '/fuseki/databases/rezics/tdb2', '/fuseki/databases/rezics/lucene'],
  { cwd: root, env: dockerEnv(), encoding: 'utf8', timeout: 15_000 });
  if (size.status !== 0) throw new Error(`Fuseki storage byte sizes unavailable: ${size.stderr}`);
  const rows = size.stdout.trim().split('\n').map(line => line.split(/\s+/));
  const tdb2Bytes = Number(rows[0]?.[0]), luceneBytes = Number(rows[1]?.[0]);
  if (!Number.isSafeInteger(tdb2Bytes) || !Number.isSafeInteger(luceneBytes))
    throw new Error('Fuseki storage byte counts are invalid');
  return { tdb2Bytes, luceneBytes, containerId: container };
}

function queryPlan(lane: string, captured: { sparql: string }[]) {
  const selected = selectPhraseQuery(captured);
  const queryFile = `${lane}-phrase.sparql`, planFile = `${lane}-phrase.plan.txt`;
  writeFileSync(join(artifacts, queryFile), selected + '\n');
  const command = spawnSync('docker', ['run', '--rm', '--network', 'none',
    '--volume', `${artifacts}:/artifacts:ro,Z`, '--entrypoint', 'java',
    fusekiImage.image, '-cp', `/opt/apache-jena-fuseki-${fusekiImage.jenaVersion}/fuseki-server.jar`,
    'arq.qparse', '--explain', '--query', `/artifacts/${queryFile}`],
  { cwd: root, env: dockerEnv(), encoding: 'utf8', timeout: 30_000 });
  writeFileSync(join(artifacts, planFile), command.stdout + command.stderr);
  if (command.status !== 0 || !command.stdout.trim())
    throw new Error(`Jena optimized algebra failed for ${lane}: ${command.stderr}`);
  return { queryFile, planFile, bytes: Buffer.byteLength(command.stdout),
    basis: 'Jena ARQ optimized algebra for the captured product phrase query; not a runtime TDB2 cost plan' };
}

function stackCommand(action: 'stack:down' | 'stack:up', name: string) {
  const result = spawnSync('corepack', ['yarn', action, '--profile', 'qa',
    '--run-id', needed('REZICS_LOAD_RUN_ID'), '--persistent'],
  { cwd: root, env: process.env, encoding: 'utf8', timeout: 180_000 });
  writeFileSync(join(artifacts, `${name}.log`), result.stdout + result.stderr);
  if (result.status !== 0) throw new Error(`${action} failed during storage cold restart: ${result.stderr}`);
}

async function writeSelection(corpus: PracticalCorpus, authority: LoadAuthority,
  index: number, iteration: number) {
  const item = corpus.works[index]!;
  const draftInput = { ...replacementContribution(item, iteration), actingSubject: authority.actor };
  const draft = await authority.run(`contribution:create:${item.work}`, 'contribution.create',
    textContributionDigest(draftInput), admission => activateTextContribution(env, admission, draftInput));
  if (!draft.contribution || !draft.draftRevision) throw new Error('mixed Contribution draft missing');
  const publishInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
    disclosure: 'public' as const, actingSubject: authority.actor };
  const published = await authority.run(`contribution:publish:${draft.contribution}`,
    'contribution.publish', textPublicationDigest(publishInput),
    admission => publishTextContribution(env, admission, publishInput));
  if (!published.publicationDecision) throw new Error('mixed Contribution publication missing');
  const selectionInput = { context: { kind: 'main-version-default' as const, id: item.main },
    work: item.work, contribution: draft.contribution,
    publicationDecision: published.publicationDecision, expectedSelectionHead: item.selection,
    selectionBasis: 'main-maintainer' as const, actingSubject: authority.actor };
  const selected = await authority.run(`publication:select:${item.main}`, 'publication.select',
    mainSelectionDigest(selectionInput), admission => selectMainDefault(env, admission, selectionInput));
  if (!selected.selection) throw new Error('mixed Main selection missing');
  item.selection = selected.selection;
  item.selectionReceipt = selected.receipt;
  return { selection: selected.selection, contribution: draft.contribution };
}

async function mixedWriters(corpus: PracticalCorpus, authority: LoadAuthority, until: number) {
  const candidates = corpus.works.map((_, index) => index).filter(index => index >= 4 && index !== 7);
  const samples = { edit: [] as number[], selection: [] as number[], rating: [] as number[],
    errors: [] as string[], receipts: 0, hotWrites: 0 };
  const ratingHeads = new Map<number, string>();
  const runWorker = async (worker: number) => {
    const own = writerCohorts(candidates.filter((_, offset) => offset % 2 === worker),
      Math.max(1, Math.floor(count / 10)));
    let iteration = 0;
    while (Date.now() < until) {
      const choice = writerIndex(own, iteration);
      const index = choice.index;
      const item = corpus.works[index]!;
      const kind = iteration % 20 === 0 ? 'selection'
        : iteration % 10 === 0 ? 'rating' : 'edit';
      const start = performance.now();
      try {
        if (kind === 'selection') await writeSelection(corpus, authority, index, worker * 100_000 + iteration);
        else if (kind === 'rating') {
          const input = { context: corpus.ratingContext, work: item.work,
            mainVersion: item.main, expectedRevisionHead: ratingHeads.get(index) ?? null,
            value: 1 + iteration % 10, actingSubject: authority.actor };
          const receipt = await authority.run(`rating:observe:${corpus.ratingContext}`,
            'rating.observation.set', standingRatingDigest(input),
            admission => setStandingRating(env, admission, input));
          if (!receipt.revision) throw new Error('mixed rating lacks revision');
          ratingHeads.set(index, receipt.revision);
        } else {
          const title = `Load Work ${index} edit ${worker}-${iteration}`;
          const head = item.head;
          const receipt = await authority.run(`work:edit:${item.work}`, 'work.edit',
            metadataWorkEditDigest(item.work, head, title),
            admission => editMetadataWork(env, { work: item.work, expectedHead: head,
              title, admission }));
          item.head = receipt.revision;
          item.editReceipt = receipt.receipt;
        }
        samples[kind].push(performance.now() - start);
        samples.receipts++;
        if (choice.hot) samples.hotWrites++;
      } catch (error) {
        samples.errors.push(error instanceof Error ? error.message : String(error));
      }
      iteration++;
      await Bun.sleep(550);
    }
  };
  await Promise.all([runWorker(0), runWorker(1)]);
  return { counts: { edit: samples.edit.length, selection: samples.selection.length,
    rating: samples.rating.length, errors: samples.errors.length, hotWrites: samples.hotWrites },
    errorSamples: samples.errors.slice(0, 10),
    latencyMs: { edit: { p95: percentile(samples.edit, 0.95), p99: percentile(samples.edit, 0.99) },
      selection: { p95: percentile(samples.selection, 0.95), p99: percentile(samples.selection, 0.99) },
      rating: { p95: percentile(samples.rating, 0.95), p99: percentile(samples.rating, 0.99) } } };
}

function dockerEnv() {
  const socket = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`, 'podman/podman.sock');
  return { ...process.env,
    ...(!process.env.DOCKER_HOST || process.env.DOCKER_HOST.includes('/.docker/desktop/')
      ? existsSync(socket) ? { DOCKER_HOST: `unix://${socket}` } : {} : {}) };
}

async function runK6(corpus: PracticalCorpus, authority: LoadAuthority) {
  const hotCount = Math.max(1, Math.floor(count / 10));
  const writableHotWorks = corpus.works.slice(0, hotCount)
    .filter((_, index) => index >= 4 && index !== 7).length;
  evidence.hotCohort = { works: hotCount, writableHotWorks,
    note: writableHotWorks ? 'Half of admitted writes target hot writable Works'
      : 'Diagnostic has no writable Work in its one-Work hot cohort' };
  const hot = corpus.works.slice(0, hotCount).map(item => ({
    work: item.work, token: item.token, language: item.language }));
  // Hot query items must use their stored language and are validated before the run.
  const fixture = { realm: corpus.realm, graphPopulation: corpus.mainUnits + corpus.contentUnits,
    contentPopulation: corpus.contentUnits, cases: corpus.cases, hot };
  writeFileSync(join(artifacts, 'load-cases.json'), JSON.stringify(fixture, null, 2) + '\n');
  const script = join(import.meta.dir, 'practical.k6.js');
  const fd = openSync(join(artifacts, 'k6.log'), 'w');
  const child = spawn('docker', ['run', '--rm', '--network', 'host', '--user', '0:0',
    '--volume', `${script}:/scripts/practical.js:ro,Z`,
    '--volume', `${artifacts}:/artifacts:Z`, '--env', `MAIN_BASE_URL=${mainUrl}`,
    '--env', `DURATION_SECONDS=${durationSeconds}`, '--env', `WORKS=${count}`,
    'grafana/k6:2.3.0', 'run', '--summary-export=/artifacts/k6-summary.json',
    '/scripts/practical.js'], { cwd: root, env: dockerEnv(), stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const until = Date.now() + durationSeconds * 1000;
  const writes = mixedWriters(corpus, authority, until);
  const lagSamples: { atMs: number; lag: string }[] = [];
  const lagErrors: string[] = [];
  const lagStart = Date.now();
  let sampling = Promise.resolve();
  const sampleLag = () => {
    sampling = sampling.then(async () => {
      const position = await relayLag();
      lagSamples.push({ atMs: Date.now() - lagStart, lag: position.lag });
    }).catch(error => { lagErrors.push(error instanceof Error ? error.message : String(error)); });
  };
  sampleLag();
  const interval = setInterval(sampleLag, 1000);
  const status = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject); child.once('exit', resolveExit);
  });
  const writer = await writes;
  clearInterval(interval);
  sampleLag();
  await sampling;
  const trend = relayBacklogTrend(lagSamples.map(item => Number(item.lag)));
  evidence.relayDuringMix = { samples: lagSamples,
    maxLag: lagSamples.reduce((max, item) => Math.max(max, Number(item.lag)), 0),
    trend, errors: lagErrors };
  if (!existsSync(join(artifacts, 'k6-summary.json')))
    throw new Error(`k6 exited ${status} without a summary; see k6.log`);
  const summary = JSON.parse(readFileSync(join(artifacts, 'k6-summary.json'), 'utf8')) as {
    metrics: Record<string, Record<string, number>> };
  const m = summary.metrics;
  const laneLatency = laneReadLatencies(m);
  const reads = m.http_reqs?.count ?? 0;
  const hotReads = m.practical_hot_reads?.count ?? 0;
  const writeCount = writer.counts.edit + writer.counts.selection + writer.counts.rating;
  const completed = reads + writeCount;
  const metrics = { reads, writes: writeCount, completed,
    readShare: completed ? reads / completed : null,
    hotReadShare: reads ? hotReads / reads : null,
    hotRequests: hotReads + writer.counts.hotWrites,
    hotRequestShare: completed ? (hotReads + writer.counts.hotWrites) / completed : null,
    throughputPerSecond: completed / durationSeconds,
    readP95Ms: m.http_req_duration?.['p(95)'], readP99Ms: m.http_req_duration?.['p(99)'],
    laneLatency,
    failedHttpRate: m.http_req_failed?.value, checkRate: m.checks?.value,
    serverErrorRate: m.practical_server_errors?.value,
    httpSentBytes: m.data_sent?.count, httpReceivedBytes: m.data_received?.count,
    writer };
  const full = count === 10_000 && durationSeconds === 180;
  const recordedLatency = [metrics.readP95Ms, metrics.readP99Ms,
    ...[writer.latencyMs.edit, writer.latencyMs.selection, writer.latencyMs.rating]
      .flatMap(value => [value.p95, value.p99])]
    .every(value => typeof value === 'number' && Number.isFinite(value));
  evidence.mixed = { ...metrics, k6Exit: status };
  if (status !== 0 || writer.counts.errors || lagErrors.length
    || metrics.failedHttpRate !== 0 || metrics.checkRate !== 1
    || metrics.serverErrorRate !== 0 || !completed || metrics.readShare === null
    || metrics.readShare < 0.7 || metrics.readShare > 0.9
    || metrics.hotReadShare === null || metrics.hotReadShare < 0.45 || metrics.hotReadShare > 0.55
    || full && (metrics.hotRequestShare === null
      || metrics.hotRequestShare < 0.45 || metrics.hotRequestShare > 0.55)
    || full && (!recordedLatency || !writer.counts.edit || !writer.counts.selection
      || !writer.counts.rating || trend.growingAtEnd || completed < 300
      || (metrics.readP95Ms ?? Infinity) > 1500
      || !laneReadP95Within(metrics.laneLatency, 1500)
      || Math.max(writer.latencyMs.edit.p95 ?? 0, writer.latencyMs.selection.p95 ?? 0,
        writer.latencyMs.rating.p95 ?? 0) > 2500)) {
    throw new Error(`practical load thresholds failed: ${JSON.stringify(metrics)}`);
  }
  return metrics;
}

let failure: string | undefined;
try {
  const initialized = spawnSync('bun', ['services/main/src/relay-init.ts'], {
    cwd: root, env: relayEnvironment, encoding: 'utf8', timeout: 15_000 });
  if (initialized.status !== 0) throw new Error(`relay init failed: ${initialized.stderr}`);
  main = service('main', 'services/main/src/index.ts', { FUSEKI_URL: meter.url });
  relay = service('relay', 'services/main/src/relay.ts', relayEnvironment);
  await ready();
  const seededAt = performance.now();
  const { corpus, authority } = await seedPracticalCorpus(env, contentPool, accessPool,
    count, completed => { console.log(`Seeded ${completed}/${count} Works`); }, seedWorkers);
  evidence.seedMs = performance.now() - seededAt;
  evidence.seed = { works: corpus.works.length, mainUnits: corpus.mainUnits,
    contentUnits: corpus.contentUnits, realm: corpus.realm, ratingContext: corpus.ratingContext,
    graphSequence: (await graphSequence()).toString() };
  const privateNative = await privateNativeProof(corpus, authority);
  evidence.privateNative = privateNative;
  await waitContent(corpus);
  evidence.relayAfterSeed = await waitRelay();
  await stop(main);
  main = service('main-restarted', 'services/main/src/index.ts', { FUSEKI_URL: meter.url });
  await ready(false);
  const cold: Record<string, unknown> = {}, warm: Record<string, unknown> = {};
  const plans: Record<string, unknown> = {};
  for (const item of corpus.cases) {
    const planLane = item.name === 'hot-main' ? 'main'
      : item.name === 'realm-adoption' ? 'realm'
      : item.name === 'content' ? 'content' : undefined;
    if (planLane) meter.beginCapture();
    try { cold[item.name] = await query(item, corpus); }
    finally {
      if (planLane) plans[planLane] = queryPlan(planLane, meter.endCapture());
    }
    warm[item.name] = await query(item, corpus);
  }
  evidence.cold = cold;
  evidence.warm = warm;
  evidence.queryPlans = plans;
  // A full inventory qualified the running Main reader above. One actual
  // selection replacement at corpus scale must now use the native bounded
  // journal and return the newly selected Contribution without another scan.
  const changedIndex = Math.max(5, Math.floor(corpus.works.length / 2));
  const changedWork = corpus.works[changedIndex]!;
  const beforeSearchProof = meter.searchProofSnapshot();
  const replacement = await writeSelection(corpus, authority, changedIndex, 900_000);
  const changedResult = await query({ name: 'selection-delta', lane: 'main',
    phrase: changedWork.token, language: changedWork.language,
    expectedWork: changedWork.work, expectedContribution: replacement.contribution }, corpus);
  const changedProof = searchProofDelta(meter.searchProofSnapshot(), beforeSearchProof);
  evidence.searchDeltaAtCorpus = { works: corpus.works.length,
    changedWork: changedWork.work, selection: replacement.selection,
    proof: changedProof, query: changedResult };
  if (changedProof.fullInventories !== 0 || changedProof.deltaRequests < 1
    || changedProof.deltaAvailable < 1) {
    throw new Error(`selection change did not use bounded native search delta: ${JSON.stringify(changedProof)}`);
  }
  const beforeMix = meter.snapshot();
  evidence.relayBeforeMix = await relayLag();
  let loadFailure: unknown;
  try { evidence.mixed = await runK6(corpus, authority); }
  catch (error) { loadFailure = error; }
  evidence.remoteMix = delta(meter.snapshot(), beforeMix);
  evidence.relayAfterMix = await waitRelay();
  evidence.memoryBeforeStorageRestart = {
    fuseki: containerMemory('fuseki'), postgres: containerMemory('postgres') };
  if (loadFailure) throw loadFailure;
  const sequenceBeforeStorageRestart = await graphSequence();
  await stop(main);
  await stop(relay);
  await Promise.all([contentPool.end(), accessPool.end(), relayPool.end()]);
  poolsOpen = false;
  stackCommand('stack:down', 'storage-cold-down');
  stackCommand('stack:up', 'storage-cold-up');
  contentPool = new Pool({ connectionString: needed('CONTENT_DATABASE_URL') });
  accessPool = new Pool({ connectionString: needed('ACCESS_DATABASE_URL') });
  relayPool = new Pool({ connectionString: needed('ACCOUNT_RELAY_DATABASE_URL') });
  poolsOpen = true;
  const sequenceAfterStorageRestart = await graphSequence();
  if (sequenceAfterStorageRestart !== sequenceBeforeStorageRestart)
    throw new Error('Graph sequence changed across persistent Fuseki/PostgreSQL restart');
  evidence.storageRestart = { sequence: sequenceAfterStorageRestart.toString(),
    services: ['Fuseki', 'PostgreSQL', 'Main', 'Main outbox relay'] };
  main = service('main-final-restart', 'services/main/src/index.ts', { FUSEKI_URL: meter.url });
  relay = service('relay-restarted', 'services/main/src/relay.ts', relayEnvironment);
  await ready(false);
  const restoredPrivate = await queryPrivateContributionPhrase(env,
    { contribution: privateNative.contribution, phrase: privateNative.currentTerm });
  const restoredOldPrivate = await queryPrivateContributionPhrase(env,
    { contribution: privateNative.contribution, phrase: privateNative.originalTerm });
  if (restoredPrivate.total !== 1 || restoredPrivate.results[0]?.matchUnit !== privateNative.currentUnit
    || restoredOldPrivate.total !== 0) throw new Error('private load canary changed across storage restart');
  evidence.privateAfterStorageCold = { currentUnit: restoredPrivate.results[0]!.matchUnit,
    oldTotal: restoredOldPrivate.total, indexGeneration: restoredPrivate.indexGeneration,
    sourcePosition: restoredPrivate.sourcePosition };
  evidence.afterStorageCold = await queryCases(corpus);
  evidence.afterStorageWarm = await queryCases(corpus);
  evidence.relayAfterRestart = await waitRelay();
  evidence.sampled = await verifySamples(corpus);
  evidence.graphTriples = await graphSize();
  const units = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT (COUNT(DISTINCT ?unit) AS ?n) WHERE {
    GRAPH <${PUBLIC_SEARCH_GRAPH}> { ?unit a rv:MatchUnit }
  }`);
  const matchUnits = Number(units.results?.bindings?.[0]?.n?.value ?? NaN);
  if (matchUnits !== corpus.mainUnits + corpus.contentUnits)
    throw new Error(`Retained public MatchUnit inventory differs: ${matchUnits}`);
  evidence.matchUnits = matchUnits;
  evidence.storage = storageSizes();
  evidence.memoryAfterStorageRestart = {
    fuseki: containerMemory('fuseki'), postgres: containerMemory('postgres') };
  const admissions = await accessPool.query<{ sealed: string; total: string }>(`SELECT
    count(*) FILTER (WHERE state = 'sealed')::text AS sealed, count(*)::text AS total
    FROM access.admission WHERE acting_subject = $1`, [authority.actor]);
  evidence.accessAdmissions = admissions.rows[0];
  if (!admissions.rows[0] || admissions.rows[0].sealed !== admissions.rows[0].total
    || Number(admissions.rows[0].sealed) < count * 4)
    throw new Error('Access load admissions did not all seal');
  evidence.updateAmplification = {
    graphCommandsPerWork: Number(await graphSequence()) / count,
    currentTriplesPerWork: (evidence.graphTriples as Record<string, number>)[GRAPHS.current]! / count,
    revisionTriplesPerWork: (evidence.graphTriples as Record<string, number>)[GRAPHS.revisions]! / count,
    publicSearchTriplesPerWork: (evidence.graphTriples as Record<string, number>)[PUBLIC_SEARCH_GRAPH]! / count,
  };
  evidence.mainHighWaterKiB = highWaterKiB;
  if (count === 10_000 && durationSeconds === 180 && highWaterKiB <= 0)
    throw new Error('Main process memory high-water measurement is unavailable');
  evidence.completedAt = new Date().toISOString();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  evidence.failure = failure;
} finally {
  clearInterval(sampleMemory);
  await stop(main);
  await stop(relay);
  if (poolsOpen) await Promise.all([contentPool.end(), accessPool.end(), relayPool.end()]);
  evidence.mainHighWaterKiB = highWaterKiB;
  evidence.remoteTotal = meter.snapshot();
  meter.stop();
  writeFileSync(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
if (failure) throw new Error(failure);
