import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { workEnvironment } from '../fixture/smoke.ts';
import { activateMetadataWork, DATASET, metadataWorkRequestDigest }
  from '../../services/main/src/modules/work/activate.ts';
import { activateTextContribution, textContributionDigest }
  from '../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../services/main/src/modules/contribution/publish.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../services/main/src/modules/work/select-main.ts';
import { MAX_SEARCH_FUSEKI_BYTES, MAX_SEARCH_FUSEKI_CALLS,
  MAX_SEARCH_RESPONSE_BYTES } from '../../services/main/src/modules/work/search-readiness.ts';
import { delta, searchProofDelta, startFusekiMeter } from './measurement.ts';
import { LoadAuthority } from './corpus.ts';
import { runQaStartupChildAsync } from '../qa/stack-startup.ts';

const root = resolve(import.meta.dir, '../..');
const artifacts = process.argv[2];
const fixtureRunId = process.argv[3];
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
if (!artifacts || !/^fixture-[a-z0-9-]{1,30}$/.test(fixtureRunId ?? '')
  || !process.env.REZICS_LOAD_RUN_ID) throw new Error('Run through task load -- --search-probe');

const upstream = required('FUSEKI_URL');
const expectedPublicUnits = Number(required('REZICS_LOAD_BACKGROUND_PUBLIC_UNITS'));
if (!Number.isSafeInteger(expectedPublicUnits) || expectedPublicUnits < 0) {
  throw new Error('fixture public MatchUnit count is invalid');
}
const meter = startFusekiMeter(upstream);
const environment = workEnvironment(process.env as Record<string, string>,
  { dataEpoch: required('MAIN_DATA_EPOCH'), routingEpoch: required('MAIN_ROUTING_EPOCH') });
const accessPool = new Pool({ connectionString: required('ACCESS_DATABASE_URL') });
const mainUrl = `http://127.0.0.1:${required('MAIN_PORT')}`;
const evidence: Record<string, unknown> = {
  acceptanceIds: ['SEARCH18'], fixtureRunId,
  searchLimits: { fusekiCalls: MAX_SEARCH_FUSEKI_CALLS,
    fusekiResponseBytes: MAX_SEARCH_FUSEKI_BYTES,
    perResponseBytes: MAX_SEARCH_RESPONSE_BYTES,
    totalRemoteAttempts: 90, requestDeadlineMs: 1500,
    phraseCandidates: 512, publicUnits: 20_000 },
  measurementScope: 'Public Main and Realm query routes; the deliberate Access-authorized selection mutation is setup for the movement trace, outside the query request.',
  startedAt: new Date().toISOString(),
};
let main: ChildProcess | undefined;
let authority: LoadAuthority | undefined;

function startMain(): ChildProcess {
  const fd = openSync(join(artifacts, 'search-probe-main.log'), 'w');
  const child = spawn('bun', ['services/main/src/index.ts'], { cwd: root,
    env: { ...process.env, FUSEKI_URL: meter.url }, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  return child;
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), Bun.sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function ready(): Promise<void> {
  const until = Date.now() + 30_000;
  const started = performance.now();
  const before = meter.snapshot();
  let attempts = 0;
  while (Date.now() < until && main?.exitCode === null) {
    try {
      attempts++;
      if ((await fetch(`${mainUrl}/health/search-ready`, { signal: AbortSignal.timeout(10_000) })).ok) {
        evidence.coldReadiness = { elapsedMs: performance.now() - started, attempts,
          remote: delta(meter.snapshot(), before) };
        return;
      }
    } catch { /* Main is still starting. */ }
    await Bun.sleep(250);
  }
  throw new Error('Main search readiness timed out');
}

async function coldStorageRestart(): Promise<number> {
  const started = Date.now();
  let admissionWaitMs = 0;
  for (const action of ['stack:down', 'stack:up'] as const) {
    const args = [action, '--profile', 'qa', '--run-id', fixtureRunId, '--persistent'];
    const result = action === 'stack:up' ? await runQaStartupChildAsync(root, args, 180_000)
      : spawnSync('bun', ['scripts/dev/cli.ts', ...args],
        { cwd: root, env: process.env, encoding: 'utf8', timeout: 180_000 });
    if ('admissionWaitMs' in result) admissionWaitMs += result.admissionWaitMs;
    writeFileSync(join(artifacts, `search-probe-${action.slice(6)}.log`),
      [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'));
    if (result.error || result.status !== 0) {
      throw new Error(`${action} failed during Search cold-cache restart`);
    }
  }
  return Date.now() - started - admissionWaitMs;
}

async function post(path: '/v1/queries' | '/v1/queries/page', body: Record<string, unknown>) {
  const request = JSON.stringify(body);
  const before = meter.snapshot();
  const started = performance.now();
  const response = await fetch(`${mainUrl}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: request,
    signal: AbortSignal.timeout(10_000) });
  const bytes = await response.arrayBuffer();
  const remote = delta(meter.snapshot(), before);
  let result: Record<string, any>;
  try { result = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>; }
  catch { result = { body: new TextDecoder().decode(bytes).slice(0, 500) }; }
  if (remote.calls > MAX_SEARCH_FUSEKI_CALLS || remote.receivedBytes > MAX_SEARCH_FUSEKI_BYTES
    || bytes.byteLength > MAX_SEARCH_RESPONSE_BYTES) {
    throw new Error(`SEARCH18 request exceeded its declared call or byte ceiling: ${JSON.stringify(remote)}`);
  }
  return { status: response.status, latencyMs: performance.now() - started,
    requestBytes: Buffer.byteLength(request), responseBytes: bytes.byteLength, remote, result };
}

function assertCompleteRead(trace: Awaited<ReturnType<typeof post>>, label: string) {
  if (trace.status !== 200 || trace.result.complete !== true
    || trace.latencyMs > 1500 || typeof trace.result.population !== 'number') {
    throw new Error(`${label} did not return a bounded complete phrase snapshot: ${JSON.stringify({
      status: trace.status, latencyMs: trace.latencyMs, population: trace.result.population,
      remote: trace.remote, result: trace.result })}`);
  }
}

interface CommandReceipt { receipt: string; dataEpoch: string; sequence: string;
  outcome?: 'succeeded' | 'cancelled' }

async function accessWrite<T extends CommandReceipt>(scope: string, action: string, digest: string,
  execute: Parameters<LoadAuthority['run']>[3]): Promise<T> {
  const result = await authority!.run(scope, action, digest, execute as never) as T;
  return result;
}

let failure: string | undefined;
try {
  evidence.storageColdRestartMs = await coldStorageRestart();
  await environment.workObjects.initialize();
  // The meter has a fresh loopback port on each diagnostic run. Rebind only
  // this isolated fixture copy's test endpoint before Main takes its route lease.
  await accessPool.query(`UPDATE access.owner_partition_route
    SET location = $1, lease_epoch = lease_epoch + 1
    WHERE owner = 'graph' AND dataset_id = $2 AND routing_epoch = $3`,
  [meter.url, DATASET, required('MAIN_ROUTING_EPOCH')]);
  main = startMain();
  await ready();
  const common = { profile: 'public-main-phrase-v1', phrase: 'public load', language: null };
  // Search readiness qualified the cold 10k index before admitting requests.
  // A one-hit query then isolates request latency from response-size cost;
  // the following 64-hit and 512-candidate queries exercise larger relations.
  const cold = await post('/v1/queries', { profile: 'public-main-phrase-v1',
    phrase: 'loadtokenaaah', language: 'zh' });
  evidence.cold = cold;
  assertCompleteRead(cold, 'Cold Main query');
  if (!Number.isSafeInteger(cold.result.population) || cold.result.population < 1
    || cold.result.population !== expectedPublicUnits
    || cold.result.total !== 1) {
    throw new Error(`Current fixture copy has too few indexed phrase units for cursor traces: ${JSON.stringify({
      population: cold.result.population, total: cold.result.total })}`);
  }
  const warm = await post('/v1/queries', common);
  evidence.warm = warm;
  assertCompleteRead(warm, 'Warm Main query');
  if (warm.result.population !== cold.result.population || warm.result.total < 2) {
    throw new Error('Warm Main query lacks the cursor population');
  }
  const degree = await post('/v1/queries', { profile: 'public-main-phrase-v1',
    phrase: 'candidate degree', language: null });
  assertCompleteRead(degree, '512-candidate Main query');
  if (degree.result.total !== 512 || degree.result.results?.length !== 512) {
    throw new Error(`SEARCH18 admitted candidate degree was truncated: ${JSON.stringify({
      status: degree.status, total: degree.result.total, returned: degree.result.results?.length })}`);
  }
  const overflow = await post('/v1/queries', { profile: 'public-main-phrase-v1',
    phrase: 'overflow degree', language: null });
  if (overflow.status !== 422 || overflow.result.code !== 'query_budget_exceeded') {
    throw new Error(`SEARCH18 over-cap candidate degree was not explicitly routed: ${JSON.stringify({
      status: overflow.status, code: overflow.result.code })}`);
  }
  evidence.candidateDegree = { admitted: { status: degree.status, total: degree.result.total,
    latencyMs: degree.latencyMs, remote: degree.remote },
  refused: { status: overflow.status, code: overflow.result.code,
    latencyMs: overflow.latencyMs, remote: overflow.remote } };

  const payload = (phrase: string) => ({ profile: 'public-main-phrase-v1', phrase, language: null });
  const accepted = await post('/v1/queries', payload('x'.repeat(80)));
  const rejected = await post('/v1/queries', payload('x'.repeat(81)));
  evidence.payloadBoundary = { maxAcceptedCharacters: accepted,
    firstRejectedCharacters: rejected };
  if (accepted.status !== 200 || accepted.result.complete !== true || accepted.result.total !== 0
    || rejected.status !== 400 || rejected.remote.calls !== 0) {
    throw new Error(`SEARCH18 phrase payload boundary differs: ${JSON.stringify({
      accepted: { status: accepted.status, total: accepted.result.total },
      rejected: { status: rejected.status, calls: rejected.remote.calls,
        code: rejected.result.code ?? rejected.result.error } })}`);
  }

  // Imported public Works qualify read/index scale but have no authorial command
  // history. Create the movement target through the real admission/command path.
  authority = new LoadAuthority(accessPool);
  await authority.initialize();
  const title = `Search movement ${crypto.randomUUID()}`;
  const created = await accessWrite<CommandReceipt & { work: string; mainVersion: string }>(
    'work:create:root', 'work.create', metadataWorkRequestDigest(title),
    admission => activateMetadataWork(environment, { title, admission }));
  const initialInput = { work: created.work, language: 'en',
    body: `public load freshsearch${crypto.randomUUID().replaceAll('-', '')}`,
    actingSubject: authority.actor };
  const initialDraft = await accessWrite<CommandReceipt & { contribution: string; draftRevision: string }>(
    `contribution:create:${created.work}`, 'contribution.create', textContributionDigest(initialInput),
    admission => activateTextContribution(environment, admission, initialInput));
  const initialPublication = { contribution: initialDraft.contribution,
    expectedDraftHead: initialDraft.draftRevision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution' as const, disclosure: 'public' as const,
    actingSubject: authority.actor };
  const initialPublished = await accessWrite<CommandReceipt & { publicationDecision: string }>(
    `contribution:publish:${initialDraft.contribution}`, 'contribution.publish',
    textPublicationDigest(initialPublication),
    admission => publishTextContribution(environment, admission, initialPublication));
  const initialSelection = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
    work: created.work, contribution: initialDraft.contribution,
    publicationDecision: initialPublished.publicationDecision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: authority.actor };
  const selected = await accessWrite<CommandReceipt & { selection: string }>(
    `publication:select:${created.mainVersion}`, 'publication.select',
    mainSelectionDigest(initialSelection),
    admission => selectMainDefault(environment, admission, initialSelection));
  const target = { work: created.work, mainVersion: created.mainVersion,
    selection: selected.selection, language: 'en' };
  evidence.freshMovementTarget = { work: target.work, mainVersion: target.mainVersion };

  const pageBody = (continuation?: Record<string, unknown>) => ({
    profile: 'public-main-phrase-page-v1', phrase: 'public load', language: null, pageSize: 1,
    ...(continuation ? { continuation } : {}),
  });
  const first = await post('/v1/queries/page', pageBody());
  if (first.status !== 200 || first.result.relationComplete !== true
    || first.result.population !== cold.result.population + 1 || first.result.total < 2
    || first.result.results?.length !== 1 || !first.result.next) {
    throw new Error(`SEARCH18 first page did not create a complete bounded continuation: ${JSON.stringify({
      status: first.status, total: first.result.total, next: first.result.next })}`);
  }
  const second = await post('/v1/queries/page', pageBody(first.result.next));
  if (second.status !== 200 || second.result.relationComplete !== true
    || second.result.results?.length !== 1
    || second.result.results[0]?.work === first.result.results[0]?.work) {
    throw new Error(`SEARCH18 continuation did not advance: ${JSON.stringify({
      status: second.status, first: first.result.results?.[0]?.work,
      second: second.result.results?.[0]?.work })}`);
  }
  evidence.cursor = { first: { ...first, result: { total: first.result.total,
    nextOffset: first.result.next.nextOffset, work: first.result.results[0].work } },
  second: { ...second, result: { total: second.result.total,
    nextOffset: second.result.next?.nextOffset, work: second.result.results[0].work } } };

  const languages: Record<string, unknown> = {};
  for (const language of ['zh', 'ja']) {
    const trace = await post('/v1/queries', { profile: 'public-main-phrase-v1',
      phrase: language === 'zh' ? 'loadtokenaaah' : 'loadtokenaaaj', language });
    assertCompleteRead(trace, `${language} Main query`);
    languages[language] = { ...trace, result: { total: trace.result.total,
      population: trace.result.population, indexGeneration: trace.result.indexGeneration,
      languages: [...new Set((trace.result.results ?? []).map((item: { language: string }) => item.language))] } };
  }
  evidence.languageTraces = languages;

  const realms = await environment.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?realm WHERE { GRAPH <urn:rezics:graph:current> { ?realm a rv:Realm ; rv:space ?space . } } LIMIT 10`);
  const realm = realms.results?.bindings?.[0]?.realm?.value;
  if (!realm) throw new Error('Fixture trace has no Realm for rejected-candidate coverage');
  const rejectedCandidate = await post('/v1/queries', { profile: 'public-realm-phrase-v1',
    context: { kind: 'realm-local', id: realm }, phrase: 'rejected sapphire harbor', language: 'en' });
  assertCompleteRead(rejectedCandidate, 'Rejected Realm candidate query');
  evidence.rejectedCandidate = { ...rejectedCandidate, realm };

  const body = `public load movementtrace${crypto.randomUUID().replaceAll('-', '')}`;
  const draftInput = { work: target.work, language: target.language, body,
    actingSubject: authority.actor };
  const draft = await accessWrite<CommandReceipt & { contribution: string; draftRevision: string }>(
    `contribution:create:${target.work}`, 'contribution.create', textContributionDigest(draftInput),
    admission => activateTextContribution(environment, admission, draftInput));
  const publishInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
    disclosure: 'public' as const, actingSubject: authority.actor };
  const published = await accessWrite<CommandReceipt & { publicationDecision: string }>(
    `contribution:publish:${draft.contribution}`, 'contribution.publish',
    textPublicationDigest(publishInput),
    admission => publishTextContribution(environment, admission, publishInput));
  const selectionInput = { context: { kind: 'main-version-default' as const, id: target.mainVersion },
    work: target.work, contribution: draft.contribution,
    publicationDecision: published.publicationDecision, expectedSelectionHead: target.selection,
    selectionBasis: 'main-maintainer' as const, actingSubject: authority.actor };
  const digest = mainSelectionDigest(selectionInput);
  const stable = await post('/v1/queries', common);
  assertCompleteRead(stable, 'Stable Main baseline');
  const proofBeforeMovement = meter.searchProofSnapshot();
  let selection: string | undefined;
  let movementFailure: string | undefined;
  meter.beforeNextPhrase(async () => {
    try {
      const selected = await accessWrite<CommandReceipt & { selection: string }>(
        `publication:select:${target.mainVersion}`, 'publication.select', digest,
        admission => selectMainDefault(environment, admission, selectionInput));
      selection = selected.selection;
    } catch (error) {
      movementFailure = error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
    }
  });
  const moved = await post('/v1/queries', common);
  evidence.movementRetry = { stable, moved,
    changedWork: target.work, contribution: draft.contribution, selection, movementFailure,
    searchProof: searchProofDelta(meter.searchProofSnapshot(), proofBeforeMovement),
    additionalFusekiCallsOverStableBaseline: moved.remote.calls - stable.remote.calls,
    bounds: { calls: MAX_SEARCH_FUSEKI_CALLS, responseBytes: MAX_SEARCH_FUSEKI_BYTES,
      perResponseBytes: MAX_SEARCH_RESPONSE_BYTES, deadlineMs: 1500 } };
  if (movementFailure) throw new Error(`Movement setup failed: ${movementFailure}`);
  assertCompleteRead(moved, 'Search movement retry');
  const movedWork = moved.result.results?.find((item: { work: string }) => item.work === target.work);
  if (!selection || !movedWork || movedWork.contribution !== draft.contribution
    || moved.remote.calls <= stable.remote.calls) {
    throw new Error(`SEARCH18 movement was not retried to a stable new selection: ${JSON.stringify({
      selection, movedContribution: movedWork?.contribution,
      expectedContribution: draft.contribution, stableCalls: stable.remote.calls,
      movedCalls: moved.remote.calls })}`);
  }
  const stale = await post('/v1/queries/page', pageBody(first.result.next));
  evidence.staleContinuation = { ...stale,
    restartProblem: JSON.stringify(stale.result).includes('search_restart_required') };
  if (stale.status !== 409 || !JSON.stringify(stale.result).includes('search_restart_required')) {
    throw new Error(`SEARCH18 stale continuation was not explicitly refused: ${JSON.stringify({
      status: stale.status, result: stale.result })}`);
  }
  evidence.publicUnitPopulation = cold.result.population;
  evidence.remoteTotal = meter.snapshot();
  evidence.searchProofTotal = meter.searchProofSnapshot();
  evidence.completedAt = new Date().toISOString();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  evidence.failure = failure;
} finally {
  await stop(main);
  await accessPool.end();
  evidence.remoteTotal = meter.snapshot();
  evidence.searchProofTotal = meter.searchProofSnapshot();
  await meter.stop();
  evidence.completedAt ??= new Date().toISOString();
  writeFileSync(join(artifacts, 'search-probe-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
if (failure) throw new Error(failure);
