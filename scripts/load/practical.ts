import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { captureFusekiQueryPlan } from './fuseki-plan.ts';
import type { CapturedFusekiQuery } from './fuseki-candidates.ts';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../services/content/src/core.ts';
import { ContentProjectionCursor } from '../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { MAX_SEARCH_FUSEKI_BYTES, MAX_SEARCH_FUSEKI_CALLS,
  MAX_SEARCH_RESPONSE_BYTES } from '../../services/main/src/modules/work/search-readiness.ts';
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
import { combineLoadCorpus, validateLoadBaseline, type LoadBaseline } from './baseline.ts';
import { hostLoopbackAccess, loadDockerEnvironment } from './docker-env.ts';
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
const prepare = process.env.REZICS_LOAD_PREPARE === '1';
const phaseD = process.env.REZICS_LOAD_PHASE_D === '1';
const cohort = Number(process.env.REZICS_LOAD_COHORT ?? count);
const baselineFile = process.env.REZICS_LOAD_BASELINE_FILE;
if (!Number.isInteger(count) || count < 10 || count > 10_000
  || !Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 180
  || !Number.isInteger(seedWorkers) || seedWorkers < 1 || seedWorkers > 4
  || !Number.isInteger(cohort) || cohort < 10 || cohort > count
  || (prepare && (baselineFile || cohort !== count))
  || (baselineFile && cohort === count)
  || !artifacts || !process.env.REZICS_LOAD_RUN_ID) throw new Error('Run through task load');
const baseline: LoadBaseline | undefined = baselineFile
  ? validateLoadBaseline(JSON.parse(readFileSync(baselineFile, 'utf8')),
    process.env.REZICS_LOAD_SOURCE_RUN_ID!, count - cohort) : undefined;
const backgroundWorks = process.env.REZICS_LOAD_SOURCE_FIXTURE
  ? Number(process.env.REZICS_LOAD_BACKGROUND_WORKS ?? NaN) : baseline?.works ?? 0;
const backgroundPublicUnits = process.env.REZICS_LOAD_SOURCE_FIXTURE
  ? Number(process.env.REZICS_LOAD_BACKGROUND_PUBLIC_UNITS ?? NaN) : 0;
if (!Number.isSafeInteger(backgroundWorks) || backgroundWorks < 0) {
  throw new Error('fixture/load background Work count is invalid');
}
if (!Number.isSafeInteger(backgroundPublicUnits) || backgroundPublicUnits < 0
  || backgroundPublicUnits > backgroundWorks) {
  throw new Error('fixture background public MatchUnit count is invalid');
}
const corpusWorkCount = process.env.REZICS_LOAD_SOURCE_FIXTURE ? backgroundWorks + count : count;
const fusekiImage = fusekiImageFromCompose(readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8'));

const needed = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const stackRunId = () => process.env.REZICS_LOAD_STACK_RUN_ID ?? needed('REZICS_LOAD_RUN_ID');
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
const evidence: Record<string, unknown> = { acceptanceIds: ['OPS05', 'SEARCH18'],
  works: count, durationSeconds, seedWorkers,
  ...(process.env.REZICS_LOAD_SOURCE_FIXTURE ? { sourceFixture: process.env.REZICS_LOAD_SOURCE_FIXTURE,
    backgroundWorks, backgroundPublicUnits } : {}),
  searchLimits: { fusekiCalls: MAX_SEARCH_FUSEKI_CALLS, fusekiResponseBytes: MAX_SEARCH_FUSEKI_BYTES,
    perResponseBytes: MAX_SEARCH_RESPONSE_BYTES, totalRemoteAttempts: 90,
    requestDeadlineMs: 1500, phraseCandidates: 512, publicUnits: 20_000 },
  images: { k6: 'grafana/k6:2.3.0', fuseki: fusekiImage.image }, clients: phaseD ? 16 : 10,
  offeredMix: { publicReads: 0.8, admittedWrites: 0.2,
    ...(phaseD ? { readRatePerSecond: 4, writeRatePerSecond: 1,
      writeKindCycle: ['selection', 'edit', 'rating'] } : {}),
    hotWorkCohort: 0.1, hotReadShare: 0.5,
    ...(!phaseD ? { hotRequestShare: 0.5 } : {}) },
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
  const remote = delta(meter.snapshot(), before);
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
  if (remote.calls > MAX_SEARCH_FUSEKI_CALLS || remote.receivedBytes > MAX_SEARCH_FUSEKI_BYTES
    || bytes.byteLength > MAX_SEARCH_RESPONSE_BYTES) {
    throw new Error(`${item.name} exceeded its declared SEARCH18 call or byte ceiling: ${JSON.stringify(remote)}`);
  }
  return { status: response.status, latencyMs: performance.now() - started,
    requestBytes: Buffer.byteLength(request), responseBytes: bytes.byteLength,
    remote, total: snapshot.total,
    population: snapshot.population, indexGeneration: snapshot.indexGeneration,
    sourcePosition: snapshot.sourcePosition ?? snapshot.contentPosition,
    resultContribution: snapshot.results?.[0]?.contribution };
}

async function queryPage(corpus: PracticalCorpus, continuation?: Record<string, unknown>) {
  const request = JSON.stringify({ profile: 'public-main-phrase-page-v1', phrase: 'public load',
    language: null, pageSize: 1, ...(continuation ? { continuation } : {}) });
  const before = meter.snapshot();
  const started = performance.now();
  const response = await fetch(`${mainUrl}/v1/queries/page`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: request,
    signal: AbortSignal.timeout(10_000) });
  const bytes = await response.arrayBuffer();
  const remote = delta(meter.snapshot(), before);
  const result = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>;
  if (remote.calls > MAX_SEARCH_FUSEKI_CALLS || remote.receivedBytes > MAX_SEARCH_FUSEKI_BYTES
    || bytes.byteLength > MAX_SEARCH_RESPONSE_BYTES) {
    throw new Error(`SEARCH18 page exceeded its declared call or byte ceiling: ${JSON.stringify(remote)}`);
  }
  return { status: response.status, latencyMs: performance.now() - started,
    requestBytes: Buffer.byteLength(request), responseBytes: bytes.byteLength,
    remote, result, population: corpus.mainUnits + corpus.contentUnits };
}

async function searchPayloadBoundaries(corpus: PracticalCorpus) {
  const request = (phrase: string) => JSON.stringify({ profile: 'public-main-phrase-v1', phrase,
    language: null });
  const probe = async (phrase: string) => {
    const body = request(phrase);
    const before = meter.snapshot();
    const response = await fetch(`${mainUrl}/v1/queries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body,
      signal: AbortSignal.timeout(10_000) });
    const bytes = await response.arrayBuffer();
    const remote = delta(meter.snapshot(), before);
    if (remote.calls > MAX_SEARCH_FUSEKI_CALLS || remote.receivedBytes > MAX_SEARCH_FUSEKI_BYTES
      || bytes.byteLength > MAX_SEARCH_RESPONSE_BYTES) {
      throw new Error(`SEARCH18 payload probe exceeded a declared call or byte ceiling: ${JSON.stringify(remote)}`);
    }
    return { status: response.status, requestBytes: Buffer.byteLength(body),
      responseBytes: bytes.byteLength, remote,
      body: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any> };
  };
  const accepted = await probe('x'.repeat(80));
  const rejected = await probe('x'.repeat(81));
  if (accepted.status !== 200 || accepted.body.complete !== true || accepted.body.total !== 0
    || accepted.body.population !== corpus.mainUnits + corpus.contentUnits
    || rejected.status !== 400 || rejected.remote.calls !== 0) {
    throw new Error(`SEARCH18 phrase length boundary differs: ${JSON.stringify({
      accepted: { status: accepted.status, total: accepted.body.total },
      rejected: { status: rejected.status, calls: rejected.remote.calls } })}`);
  }
  return { maxAcceptedCharacters: accepted, firstRejectedCharacters: rejected };
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
  const project = `rezics-qa-${stackRunId()}`;
  const id = spawnSync('docker', ['ps', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}'],
  { cwd: root, env: loadDockerEnvironment(), encoding: 'utf8', timeout: 5000 });
  const container = id.stdout.trim().split('\n')[0];
  if (id.status !== 0 || !container) throw new Error(`${service} container unavailable: ${id.stderr}`);
  return container;
}

function containerMemory(service: 'fuseki' | 'postgres') {
  const container = containerId(service);
  const result = spawnSync('docker', ['exec', container, 'sh', '-c',
    'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.stat'],
  { cwd: root, env: loadDockerEnvironment(), encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0)
    throw new Error(`${service} memory counters unavailable: ${result.stderr}`);
  return { containerId: container, ...parseCgroupMemory(result.stdout),
    basis: service === 'fuseki' ? 'Fuseki single JVM container cgroup' : 'PostgreSQL container cgroup' };
}

function storageSizes() {
  const container = containerId('fuseki');
  const size = spawnSync('docker', ['exec', container, 'du', '-sb',
    '/fuseki/databases/rezics/tdb2', '/fuseki/databases/rezics/lucene'],
  { cwd: root, env: loadDockerEnvironment(), encoding: 'utf8', timeout: 15_000 });
  if (size.status !== 0) throw new Error(`Fuseki storage byte sizes unavailable: ${size.stderr}`);
  const rows = size.stdout.trim().split('\n').map(line => line.split(/\s+/));
  const tdb2Bytes = Number(rows[0]?.[0]), luceneBytes = Number(rows[1]?.[0]);
  if (!Number.isSafeInteger(tdb2Bytes) || !Number.isSafeInteger(luceneBytes))
    throw new Error('Fuseki storage byte counts are invalid');
  return { tdb2Bytes, luceneBytes, containerId: container };
}

function queryPlan(lane: string, captured: CapturedFusekiQuery[]) {
  const selected = selectPhraseQuery(captured);
  return captureFusekiQueryPlan(captured.find(entry => entry.sparql === selected)!, { label: `${lane}-phrase`,
    directory: artifacts, image: fusekiImage, dockerEnv: loadDockerEnvironment() });
}

function stackCommand(action: 'stack:down' | 'stack:up', name: string) {
  const result = spawnSync('bun', ['scripts/dev/cli.ts', action, '--profile', 'qa',
    '--run-id', stackRunId(), '--persistent'],
  { cwd: root, env: process.env, encoding: 'utf8', timeout: 180_000 });
  writeFileSync(join(artifacts, `${name}.log`), result.stdout + result.stderr);
  if (result.status !== 0) throw new Error(`${action} failed during storage cold restart: ${result.stderr}`);
}

interface PreparedSelection { contribution: string; publicationDecision: string }
interface SelectionTrace { accessBeforeMs: number; selectionMs: number; accessAfterMs: number;
  fuseki: { operation: 'query' | 'command'; ms: number }[] }

async function prepareSelection(authority: LoadAuthority, item: PracticalCorpus['works'][number],
  iteration: number): Promise<PreparedSelection> {
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
  return { contribution: draft.contribution, publicationDecision: published.publicationDecision };
}

async function selectPreparedContribution(corpus: PracticalCorpus, authority: LoadAuthority,
  index: number, prepared: PreparedSelection, trace?: SelectionTrace) {
  const item = corpus.works[index]!;
  const selectionInput = { context: { kind: 'main-version-default' as const, id: item.main },
    work: item.work, contribution: prepared.contribution,
    publicationDecision: prepared.publicationDecision, expectedSelectionHead: item.selection,
    selectionBasis: 'main-maintainer' as const, actingSubject: authority.actor };
  const started = performance.now();
  let selectedAt = 0;
  let selectionDoneAt = 0;
  const tracedFuseki = Object.create(env.fuseki) as FusekiClient;
  if (trace) {
    tracedFuseki.query = async (sparql, maxResponseBytes) => {
      const before = performance.now();
      try { return await env.fuseki.query(sparql, maxResponseBytes); }
      finally { trace.fuseki.push({ operation: 'query', ms: performance.now() - before }); }
    };
    tracedFuseki.commandWithReceipt = async envelope => {
      const before = performance.now();
      try { return await env.fuseki.commandWithReceipt(envelope); }
      finally { trace.fuseki.push({ operation: 'command', ms: performance.now() - before }); }
    };
  }
  const selected = await authority.run(`publication:select:${item.main}`, 'publication.select',
    mainSelectionDigest(selectionInput), async admission => {
      selectedAt = performance.now();
      try { return await selectMainDefault(trace ? { ...env, fuseki: tracedFuseki } : env,
        admission, selectionInput); }
      finally { selectionDoneAt = performance.now(); }
    });
  if (trace) {
    trace.accessBeforeMs = selectedAt - started;
    trace.selectionMs = selectionDoneAt - selectedAt;
    trace.accessAfterMs = performance.now() - selectionDoneAt;
  }
  if (!selected.selection) throw new Error('mixed Main selection missing');
  item.selection = selected.selection;
  item.selectionReceipt = selected.receipt;
  return { selection: selected.selection, contribution: prepared.contribution };
}

async function writeSelection(corpus: PracticalCorpus, authority: LoadAuthority,
  index: number, iteration: number) {
  const prepared = await prepareSelection(authority, corpus.works[index]!, iteration);
  return selectPreparedContribution(corpus, authority, index, prepared);
}

async function prepareMixedSelections(corpus: PracticalCorpus, authority: LoadAuthority) {
  const prepared = new Map<string, PreparedSelection>();
  if (!phaseD) return prepared;
  const started = performance.now();
  const candidates = (corpus.writableIndices ?? corpus.works.map((_, index) => index))
    .filter(index => index >= 4 && index !== 7);
  // One write arrival per second, with each kind offered every third slot.
  // All prerequisites are created before the measured interval.
  const offers = durationSeconds;
  for (let slot = 0; slot < offers; slot += 3) {
    const index = candidates[slot % candidates.length]!;
    prepared.set(String(slot), await prepareSelection(authority,
      corpus.works[index]!, slot));
  }
  await waitRelay();
  evidence.selectionPreparation = { contributions: prepared.size,
    elapsedMs: performance.now() - started, outsideMix: true };
  return prepared;
}

async function mixedWriters(corpus: PracticalCorpus, authority: LoadAuthority, until: number,
  preparedSelections: ReadonlyMap<string, PreparedSelection>) {
  const candidates = (corpus.writableIndices ?? corpus.works.map((_, index) => index))
    .filter(index => index >= 4 && index !== 7);
  const samples = { edit: [] as number[], selection: [] as number[], rating: [] as number[],
    errors: [] as string[], receipts: 0, hotWrites: 0 };
  const selectionTraces: (SelectionTrace & { totalMs: number })[] = [];
  let offered = 0;
  let maxScheduleLagMs = 0;
  let maxQueueMs = 0;
  const ratingHeads = new Map<number, string>();
  const runOperation = async (worker: number, iteration: number, index: number,
    kind: 'edit' | 'selection' | 'rating', hot: boolean, offeredAt: number) => {
    const item = corpus.works[index]!;
    maxQueueMs = Math.max(maxQueueMs, performance.now() - offeredAt);
    try {
      if (kind === 'selection') {
        const prepared = preparedSelections.get(phaseD ? String(iteration) : `${worker}:${iteration}`);
        if (phaseD && !prepared) throw new Error('Phase-D selection prerequisite was not prepared');
        if (prepared) {
          const trace: SelectionTrace = { accessBeforeMs: 0, selectionMs: 0,
            accessAfterMs: 0, fuseki: [] };
          await selectPreparedContribution(corpus, authority, index, prepared, phaseD ? trace : undefined);
          if (phaseD) selectionTraces.push({ ...trace, totalMs: performance.now() - offeredAt });
        } else await writeSelection(corpus, authority, index, worker * 100_000 + iteration);
      } else if (kind === 'rating') {
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
      samples[kind].push(performance.now() - offeredAt);
      samples.receipts++;
      if (hot) samples.hotWrites++;
    } catch (error) {
      samples.errors.push(error instanceof Error ? error.message : String(error));
    }
  };
  if (phaseD) {
    const start = performance.now();
    const pending: Promise<void>[] = [];
    const perWork = new Map<number, Promise<void>>();
    for (let slot = 0; slot < durationSeconds; slot++) {
      const due = start + slot * 1000;
      await Bun.sleep(Math.max(0, due - performance.now()));
      const offeredAt = performance.now();
      maxScheduleLagMs = Math.max(maxScheduleLagMs, offeredAt - due);
      const index = candidates[slot % candidates.length]!;
      const kind = slot % 3 === 0 ? 'selection' : slot % 3 === 1 ? 'edit' : 'rating';
      const prior = perWork.get(index) ?? Promise.resolve();
      const next = prior.then(() => runOperation(slot % 2, slot, index, kind,
        index < Math.max(1, Math.floor(count / 10)), offeredAt));
      perWork.set(index, next);
      pending.push(next);
      offered++;
    }
    await Promise.all(pending);
  } else {
  const runWorker = async (worker: number) => {
    const own = writerCohorts(candidates.filter((_, offset) => offset % 2 === worker),
      Math.max(1, Math.floor(count / 10)));
    let iteration = 0;
    while (Date.now() < until) {
      const choice = writerIndex(own, iteration);
      const kind = iteration % 20 === 0 ? 'selection'
        : iteration % 10 === 0 ? 'rating' : 'edit';
      await runOperation(worker, iteration, choice.index, kind, choice.hot, performance.now());
      iteration++;
      await Bun.sleep(550);
    }
  };
  await Promise.all([runWorker(0), runWorker(1)]);
  }
  return { counts: { edit: samples.edit.length, selection: samples.selection.length,
    rating: samples.rating.length, errors: samples.errors.length, hotWrites: samples.hotWrites },
    arrival: { offered, ratePerSecond: phaseD ? 1 : null, maxScheduleLagMs, maxQueueMs },
    selectionTraces,
    errorSamples: samples.errors.slice(0, 10),
    latencyMs: Object.fromEntries((['edit', 'selection', 'rating'] as const).map(kind =>
      [kind, { count: samples[kind].length, min: Math.min(...samples[kind]),
        median: percentile(samples[kind], 0.5), p95: percentile(samples[kind], 0.95),
        p99: percentile(samples[kind], 0.99), max: Math.max(...samples[kind]) }])) as Record<
          'edit' | 'selection' | 'rating', { count: number; min: number; median: number;
            p95: number | null; p99: number | null; max: number }> };
}

async function runK6(corpus: PracticalCorpus, authority: LoadAuthority) {
  const preparedSelections = await prepareMixedSelections(corpus, authority);
  const hotCount = Math.max(1, Math.floor(count / 10));
  const writableHotWorks = (corpus.writableIndices ?? corpus.works.map((_, index) => index))
    .filter(index => index < hotCount && index >= 4 && index !== 7).length;
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
  const docker = loadDockerEnvironment();
  const loopback = hostLoopbackAccess(docker);
  const child = spawn('docker', ['run', '--rm', ...loopback.args, '--user', '0:0',
    '--volume', `${script}:/scripts/practical.js:ro,Z`,
    '--volume', `${artifacts}:/artifacts:Z`,
    '--env', `MAIN_BASE_URL=http://${loopback.host}:${needed('MAIN_PORT')}`,
    '--env', `DURATION_SECONDS=${durationSeconds}`, '--env', `WORKS=${count}`,
    '--env', `PHASE_D=${phaseD ? 1 : 0}`,
    'grafana/k6:2.3.0', 'run', '--summary-export=/artifacts/k6-summary.json',
    '/scripts/practical.js'], { cwd: root, env: docker, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const until = Date.now() + durationSeconds * 1000;
  const writes = mixedWriters(corpus, authority, until, preparedSelections);
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
    droppedReadArrivals: m.dropped_iterations?.count ?? 0,
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
  const hostThresholds = (count === 10_000 && durationSeconds === 180)
    || (backgroundPublicUnits + count >= 10_000 && durationSeconds === 180);
  evidence.hostThresholds = { enabled: hostThresholds || phaseD,
    readP95Ms: 1500, laneReadP95Ms: 1500, writeP95Ms: 2500,
    minimumCompleted: 300, minimumSamplesPerWriteKind: phaseD ? 20 : 1,
    failedHttpRate: 0, checkRate: 1,
    serverErrorRate: 0, relayBacklogMustNotGrow: true };
  const recordedLatency = [metrics.readP95Ms, metrics.readP99Ms,
    ...[writer.latencyMs.edit, writer.latencyMs.selection, writer.latencyMs.rating]
      .flatMap(value => [value.p95, value.p99])]
    .every(value => typeof value === 'number' && Number.isFinite(value));
  evidence.mixed = { ...metrics, k6Exit: status };
  if (status !== 0 || writer.counts.errors || lagErrors.length
    || metrics.failedHttpRate !== 0 || metrics.checkRate !== 1
    || metrics.serverErrorRate !== 0 || !completed || metrics.readShare === null
    || phaseD && (metrics.droppedReadArrivals !== 0 || writer.arrival.offered !== durationSeconds
      || Math.abs(reads - durationSeconds * 4) > 1 || writeCount !== durationSeconds
      || writer.counts.edit < 20 || writer.counts.selection < 20 || writer.counts.rating < 20)
    || metrics.readShare < 0.7 || metrics.readShare > 0.9
    || metrics.hotReadShare === null || metrics.hotReadShare < 0.45 || metrics.hotReadShare > 0.55
    || hostThresholds && (metrics.hotRequestShare === null
      || metrics.hotRequestShare < 0.45 || metrics.hotRequestShare > 0.55)
    || (hostThresholds || phaseD) && (!recordedLatency || !writer.counts.edit || !writer.counts.selection
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
  if (phaseD) await accessPool.query(`UPDATE access.owner_partition_route
    SET location = $1, lease_epoch = lease_epoch + 1
    WHERE owner = 'graph' AND dataset_id = $2 AND routing_epoch = $3`,
  [meter.url, DATASET, needed('MAIN_ROUTING_EPOCH')]);
  const initialized = spawnSync('bun', ['services/main/src/relay-init.ts'], {
    cwd: root, env: relayEnvironment, encoding: 'utf8', timeout: 15_000 });
  if (initialized.status !== 0) throw new Error(`relay init failed: ${initialized.stderr}`);
  main = service('main', 'services/main/src/index.ts', { FUSEKI_URL: meter.url });
  relay = service('relay', 'services/main/src/relay.ts', relayEnvironment);
  await ready();
  if (baseline) {
    const actualGraph = await graphSequence();
    const content = new ContentCore(contentPool);
    const owner = await content.ownerPosition();
    if (actualGraph.toString() !== baseline.graphSequence
      || owner.dataEpoch !== baseline.contentPosition.dataEpoch
      || owner.sequence !== baseline.contentPosition.sequence) {
      throw new Error('cloned baseline owner positions differ from its manifest');
    }
    const oldCases = await queryCases(baseline.corpus);
    if (oldCases['hot-main']?.indexGeneration !== baseline.indexGeneration)
      throw new Error('cloned baseline native index generation differs');
    evidence.baseline = { sourceRunId: baseline.runId, works: baseline.works,
      graphSequence: baseline.graphSequence, contentPosition: baseline.contentPosition,
      indexGeneration: baseline.indexGeneration, cold: oldCases };
  }
  const seededAt = performance.now();
  // The retained fixture owns the low load-token canaries. Use a disjoint
  // fresh cohort so exact hot and language reads cannot match imported Works.
  const startIndex = baseline?.works ?? (phaseD ? 1_000 : 0);
  const fresh = await seedPracticalCorpus(env, contentPool, accessPool,
    cohort, completed => { console.log(`Seeded ${completed}/${cohort} fresh Works`); },
    seedWorkers, startIndex);
  const { authority } = fresh;
  const corpus = baseline ? combineLoadCorpus(baseline.corpus, fresh.corpus, count) : fresh.corpus;
  corpus.mainUnits += backgroundPublicUnits;
  evidence.seedMs = performance.now() - seededAt;
  evidence.seed = { works: corpus.works.length, mainUnits: corpus.mainUnits,
    contentUnits: corpus.contentUnits, realm: corpus.realm, ratingContext: corpus.ratingContext,
    graphSequence: (await graphSequence()).toString(), freshWorks: cohort,
    backgroundWorks, startIndex };
  if (phaseD) {
    evidence.qualification = {
      scope: '100,000 restored Works, 10,000 restored public units, ten fresh command Works, four scheduled reads and one admitted write per second',
      durationSeconds, host: 'development host; observed resources and latency only',
      excludes: '180-second sustained profile and 20,000-unit public search scale',
    };
    await waitContent(corpus);
    evidence.relayAfterSeed = await waitRelay();
    evidence.beforeMix = await queryCases(corpus);
    evidence.relayBeforeMix = await relayLag();
    let mixedFailure: unknown;
    try { evidence.mixed = await runK6(corpus, authority); }
    catch (error) { mixedFailure = error; }
    let relayFailure: unknown;
    try { evidence.relayAfterMix = await waitRelay(); }
    catch (error) { relayFailure = error; evidence.relayAfterMixError = String(error); }
    evidence.memoryBeforeRecovery = { mainHighWaterKiB: highWaterKiB,
      fuseki: containerMemory('fuseki'), postgres: containerMemory('postgres') };
    const mixed = evidence.mixed as Awaited<ReturnType<typeof runK6>> | undefined;
    const lag = evidence.relayDuringMix as { trend: { growingAtEnd: boolean } } | undefined;
    const profileFailed = !mixed || (mixed.readP95Ms ?? Infinity) > 1500
      || !laneReadP95Within(mixed.laneLatency, 1500)
      || Math.max(mixed.writer.latencyMs.edit.p95 ?? Infinity,
        mixed.writer.latencyMs.selection.p95 ?? Infinity,
        mixed.writer.latencyMs.rating.p95 ?? Infinity) > 2500
      || (lag?.trend.growingAtEnd ?? true) || highWaterKiB <= 0;
    const sequenceBeforeRecovery = await graphSequence();
    await stop(main);
    await stop(relay);
    await Promise.all([contentPool.end(), accessPool.end(), relayPool.end()]);
    poolsOpen = false;
    const recoveryStarted = Date.now();
    stackCommand('stack:down', 'phase-d-storage-down');
    stackCommand('stack:up', 'phase-d-storage-up');
    contentPool = new Pool({ connectionString: needed('CONTENT_DATABASE_URL') });
    accessPool = new Pool({ connectionString: needed('ACCESS_DATABASE_URL') });
    relayPool = new Pool({ connectionString: needed('ACCOUNT_RELAY_DATABASE_URL') });
    poolsOpen = true;
    if (await graphSequence() !== sequenceBeforeRecovery) {
      throw new Error('Phase-D graph sequence changed across storage recovery');
    }
    main = service('main-phase-d-restarted', 'services/main/src/index.ts', { FUSEKI_URL: meter.url });
    relay = service('relay-phase-d-restarted', 'services/main/src/relay.ts', relayEnvironment);
    await ready();
    evidence.afterRecovery = await queryCases(corpus);
    evidence.relayAfterRecovery = await waitRelay();
    evidence.storageRecoveryMs = Date.now() - recoveryStarted;
    if ((evidence.storageRecoveryMs as number) > 90_000) {
      throw new Error('Phase-D persistent storage recovery exceeded 90 seconds');
    }
    evidence.memoryAfterRecovery = { mainHighWaterKiB: highWaterKiB,
      fuseki: containerMemory('fuseki'), postgres: containerMemory('postgres') };
    if (mixedFailure) throw mixedFailure;
    if (relayFailure) throw relayFailure;
    if (profileFailed) throw new Error('Phase-D named host latency, lag or Main memory objective failed');
  } else if (prepare) {
    await waitContent(corpus);
    evidence.relayAfterSeed = await waitRelay();
    evidence.cold = await queryCases(corpus);
    evidence.sampled = await verifySamples(corpus);
    const admissions = await accessPool.query<{ sealed: string; total: string }>(`SELECT
      count(*) FILTER (WHERE state = 'sealed')::text AS sealed, count(*)::text AS total
      FROM access.admission WHERE acting_subject = $1`, [authority.actor]);
    evidence.accessAdmissions = admissions.rows[0];
    if (!admissions.rows[0] || admissions.rows[0].sealed !== admissions.rows[0].total
      || Number(admissions.rows[0].sealed) < count * 4)
      throw new Error('baseline Access admissions did not all seal');
    await accessPool.query(`UPDATE access.representation SET valid_until = now() - interval '1 second'
      WHERE subject_id = $1 AND valid_until > now()`, [authority.actor]);
    await accessPool.query(`UPDATE access.permission_grant SET valid_until = now() - interval '1 second'
      WHERE issuer_subject = $1 AND valid_until > now()`, [authority.actor]);
    const remaining = await accessPool.query<{ reps: string; grants: string }>(`SELECT
      (SELECT count(*)::text FROM access.representation WHERE subject_id = $1 AND valid_until > now()) AS reps,
      (SELECT count(*)::text FROM access.permission_grant WHERE issuer_subject = $1 AND valid_until > now()) AS grants`,
    [authority.actor]);
    if (remaining.rows[0]?.reps !== '0' || remaining.rows[0]?.grants !== '0')
      throw new Error('baseline actor still has live grants');
    evidence.afterGrantExpiry = await queryCases(corpus);
    const owner = await new ContentCore(contentPool).ownerPosition();
    const position = await new ContentProjectionCursor(contentPool).read('main-content-public-search-v1');
    if (position.dataEpoch !== owner.dataEpoch || position.sequence !== owner.sequence)
      throw new Error('baseline Content projection is behind its owner');
    const manifest: LoadBaseline = { version: 1, runId: needed('REZICS_LOAD_RUN_ID'),
      works: count, corpus, actor: authority.actor,
      graphSequence: (await graphSequence()).toString(),
      contentPosition: { dataEpoch: owner.dataEpoch, sequence: owner.sequence },
      indexGeneration: (evidence.cold as Record<string, { indexGeneration: string }>)['hot-main']!.indexGeneration,
      baselineGrantsExpired: true };
    validateLoadBaseline(manifest, manifest.runId, count);
    writeFileSync(join(artifacts, 'baseline.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(artifacts, 'load-cases.json'), JSON.stringify({ realm: corpus.realm,
      graphPopulation: corpus.mainUnits + corpus.contentUnits,
      contentPopulation: corpus.contentUnits, cases: corpus.cases }, null, 2) + '\n');
    evidence.prepared = true;
  } else {
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
  evidence.searchPayloadBoundaries = await searchPayloadBoundaries(corpus);
  const firstPage = await queryPage(corpus);
  if (firstPage.status !== 200 || firstPage.result.relationComplete !== true
    || firstPage.result.population !== corpus.mainUnits + corpus.contentUnits
    || firstPage.result.total < 2 || firstPage.result.results?.length !== 1
    || !firstPage.result.next) {
    throw new Error(`SEARCH18 page one did not create a bounded continuation: ${JSON.stringify({
      status: firstPage.status, total: firstPage.result.total, next: firstPage.result.next })}`);
  }
  const secondPage = await queryPage(corpus, firstPage.result.next);
  if (secondPage.status !== 200 || secondPage.result.relationComplete !== true
    || secondPage.result.results?.length !== 1
    || secondPage.result.results[0]?.work === firstPage.result.results[0]?.work) {
    throw new Error(`SEARCH18 continuation repeated or omitted its first result: ${JSON.stringify({
      status: secondPage.status, first: firstPage.result.results?.[0]?.work,
      second: secondPage.result.results?.[0]?.work })}`);
  }
  evidence.searchPages = { first: { ...firstPage, result: {
    total: firstPage.result.total, nextOffset: firstPage.result.next.nextOffset,
    firstWork: firstPage.result.results?.[0]?.work } },
  second: { ...secondPage, result: { total: secondPage.result.total,
    nextOffset: secondPage.result.next?.nextOffset,
    secondWork: secondPage.result.results?.[0]?.work } } };
  // A full inventory qualified the running Main reader above. One actual
  // selection replacement at corpus scale must now use the native bounded
  // journal and return the newly selected Contribution without another scan.
  const eligible = (corpus.writableIndices ?? corpus.works.map((_, index) => index))
    .filter(index => index >= 4 && index !== 7);
  const changedIndex = eligible[Math.floor(eligible.length / 2)]!;
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
  const stalePage = await queryPage(corpus, firstPage.result.next);
  const restartProblem = JSON.stringify(stalePage.result).includes('search_restart_required');
  evidence.searchContinuationAfterSelection = { status: stalePage.status,
    requestBytes: stalePage.requestBytes, responseBytes: stalePage.responseBytes,
    remote: stalePage.remote, restartProblem };
  if (stalePage.status !== 409 || !restartProblem) {
    throw new Error(`SEARCH18 stale continuation was not explicitly rejected: ${JSON.stringify({
      status: stalePage.status, result: stalePage.result })}`);
  }
  const retryIndex = changedIndex;
  const retryWork = corpus.works[retryIndex]!;
  const stableBeforeMovement = await query({ name: 'retry-stable-baseline', lane: 'main',
    phrase: retryWork.token, language: retryWork.language, expectedWork: retryWork.work }, corpus);
  const preparedMovement = await prepareSelection(authority, retryWork, 900_001);
  let movement: Awaited<ReturnType<typeof writeSelection>> | undefined;
  meter.beforeNextPhrase(async () => {
    movement = await selectPreparedContribution(corpus, authority, retryIndex, preparedMovement);
  });
  const movedDuringPhrase = await query({ name: 'retry-moved-during-phrase', lane: 'main',
    phrase: retryWork.token, language: retryWork.language, expectedWork: retryWork.work }, corpus);
  if (!movement || movedDuringPhrase.resultContribution !== movement.contribution
    || movedDuringPhrase.remote.calls <= stableBeforeMovement.remote.calls
    || movedDuringPhrase.latencyMs > 1500) {
    throw new Error(`SEARCH18 movement retry did not show a stable new result and extra bounded read: ${JSON.stringify({
      movement, baselineCalls: stableBeforeMovement.remote.calls,
      movedCalls: movedDuringPhrase.remote.calls,
      movedLatencyMs: movedDuringPhrase.latencyMs,
      resultContribution: movedDuringPhrase.resultContribution })}`);
  }
  evidence.searchMovementRetry = { changedWork: retryWork.work,
    stableBaseline: stableBeforeMovement, movedDuringPhrase,
    movement: { selection: movement.selection, contribution: movement.contribution },
    additionalFusekiCallsOverStableBaseline:
      movedDuringPhrase.remote.calls - stableBeforeMovement.remote.calls,
    bounds: { calls: MAX_SEARCH_FUSEKI_CALLS, responseBytes: MAX_SEARCH_FUSEKI_BYTES,
      perResponseBytes: MAX_SEARCH_RESPONSE_BYTES, deadlineMs: 1500 },
    interpretation: 'Measured extra Main-to-Fuseki calls after a deterministic public selection/index movement; the server retries only a proven moved snapshot.' };
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
  const recoveryStarted = Date.now();
  poolsOpen = false;
  stackCommand('stack:down', 'storage-cold-down');
  stackCommand('stack:up', 'storage-cold-up');
  const storageRecoveryMs = Date.now() - recoveryStarted;
  evidence.storageRecoveryMs = storageRecoveryMs;
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
    || Number(admissions.rows[0].sealed) < cohort * 4)
    throw new Error('Access load admissions did not all seal');
  evidence.updateAmplification = {
    graphCommandsPerFreshWork: Number(await graphSequence()) / count,
    currentTriplesPerCorpusWork: (evidence.graphTriples as Record<string, number>)[GRAPHS.current]!
      / corpusWorkCount,
    revisionTriplesPerCorpusWork: (evidence.graphTriples as Record<string, number>)[GRAPHS.revisions]!
      / corpusWorkCount,
    publicSearchTriplesPerCorpusWork: (evidence.graphTriples as Record<string, number>)[PUBLIC_SEARCH_GRAPH]!
      / corpusWorkCount,
  };
  evidence.mainHighWaterKiB = highWaterKiB;
  if (count === 10_000 && durationSeconds === 180 && highWaterKiB <= 0)
    throw new Error('Main process memory high-water measurement is unavailable');
  }
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
  await meter.stop();
  writeFileSync(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
if (failure) throw new Error(failure);
