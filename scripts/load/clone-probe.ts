import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../services/content/src/core.ts';
import { ContentProjectionCursor } from '../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, type WorkActivationEnvironment }
  from '../../services/main/src/modules/work/activate.ts';
import { relayContentProjectionOnce } from '../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../../services/main/src/modules/content-publication/search.ts';
import { queryPublicMainPhrase, queryPublicRealmPhrase }
  from '../../services/main/src/modules/work/search-public.ts';
import { assertPublicTextReady } from '../../services/main/src/modules/work/search-readiness.ts';
import { seedPracticalCorpus } from './corpus.ts';
import { readEnv } from '../dev/config.ts';
import type { LoadCase } from '../../tests/qa/load/corpus.ts';

const root = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
if ((args.length !== 4 && (args.length !== 5 || args[4] !== '--read-only'))
  || args[0] !== '--source-run-id' || args[2] !== '--run-id'
  || !/^load-[a-z0-9-]{1,30}$/.test(args[1] ?? '')
  || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(args[3] ?? '')) {
  throw new Error('Usage: yarn load:clone-probe --source-run-id <load-id> --run-id <target-id>');
}
const sourceId = args[1]!;
const targetId = args[3]!;
const readOnly = args[4] === '--read-only';
const artifacts = join(root, '.artifacts', 'load-clone', targetId);
mkdirSync(artifacts, { recursive: true });
const fixture = JSON.parse(readFileSync(join(root, '.artifacts', 'load', sourceId, 'load-cases.json'), 'utf8')) as {
  realm: string; graphPopulation: number; contentPopulation: number; cases: LoadCase[] };
const sourceEvidence = JSON.parse(readFileSync(join(root, '.artifacts', 'load', sourceId, 'evidence.json'), 'utf8')) as {
  seed: { works: number }; sampled: { index: number; head: string; selection: string;
    receipt: string; exact: boolean }[] };
const apps = readEnv(join(root, '.temp', 'stack', `rezics-qa-${targetId}`, 'apps.env'));
const env: WorkActivationEnvironment = { fuseki: new FusekiClient(apps.FUSEKI_URL,
  apps.FUSEKI_MAINTENANCE_TOKEN, apps.FUSEKI_COMMAND_TOKEN),
  lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
  objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
let contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
let accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
let cursor = new ContentProjectionCursor(contentPool);
let content = new ContentCore(contentPool);
const consumer = 'main-content-public-search-v1';
const evidence: Record<string, unknown> = { sourceId, targetId, startedAt: new Date().toISOString(),
  sourceWorks: sourceEvidence.seed.works, readOnly };

async function caseResult(item: LoadCase, realm: string) {
  const input = { phrase: item.phrase, language: item.language };
  const result = item.lane === 'main' ? await queryPublicMainPhrase(env, input)
    : item.lane === 'realm' ? await queryPublicRealmPhrase(env,
      { ...input, context: { kind: 'realm-local', id: realm } })
      : await queryPublicContentPhrase(env, content, cursor, consumer, input);
  const population = item.lane === 'content' ? fixture.contentPopulation : fixture.graphPopulation;
  const first = result.results[0];
  const work = first && ('resource' in first ? first.resource : first.work);
  const contribution = first && 'contribution' in first ? first.contribution : undefined;
  const reason = first && 'reason' in first ? first.reason : undefined;
  if (!result.complete || result.population !== population
    || result.total !== (item.expectedWork === null ? 0 : 1)
    || result.results.length !== result.total
    || item.expectedWork !== null && work !== item.expectedWork
    || item.expectedContribution && contribution !== item.expectedContribution
    || item.expectedReason && reason !== item.expectedReason) {
    throw new Error(`cloned ${item.name} differs from source fixture`);
  }
  return { name: item.name, total: result.total, population: result.population,
    indexGeneration: result.indexGeneration };
}

async function cases() {
  const results = [];
  for (const item of fixture.cases) results.push(await caseResult(item, fixture.realm));
  return results;
}

async function receipts() {
  for (const sample of sourceEvidence.sampled) {
    if (!sample.exact) throw new Error('source receipt sample was not exact');
    const result = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH <${GRAPHS.current}> { ?work rv:head <${sample.head}> .
        ?main rv:selectionHead <${sample.selection}> . }
      GRAPH <${GRAPHS.receipts}> { <${sample.receipt}> rv:selection <${sample.selection}> . }
    }`);
    if (result.boolean !== true) throw new Error(`cloned receipt sample ${sample.index} is absent`);
  }
  return sourceEvidence.sampled.length;
}

async function drainContent() {
  await cursor.initialize(consumer);
  for (let step = 0; step < 16; step++) {
    const [owner, checkpoint] = await Promise.all([content.ownerPosition(), cursor.read(consumer)]);
    if (owner.dataEpoch === checkpoint.dataEpoch && owner.sequence === checkpoint.sequence) return checkpoint;
    if (!await relayContentProjectionOnce(env, content, cursor, consumer)) {
      throw new Error('Content projection failed to advance');
    }
  }
  throw new Error('Content projection exceeded 16 bounded events');
}

function stack(action: 'stack:down' | 'stack:up') {
  const result = spawnSync('corepack', ['yarn', action, '--profile', 'qa',
    '--run-id', targetId, '--persistent'], { cwd: root, encoding: 'utf8', timeout: 180_000 });
  if (result.status !== 0) throw new Error(`${action} failed: ${result.stderr}`);
}

let failure: string | undefined;
try {
  const baseline = await assertPublicTextReady(env.fuseki, env.lineage);
  if (baseline.population !== fixture.graphPopulation) throw new Error('baseline public population differs');
  evidence.cold = await cases();
  evidence.receiptSamples = await receipts();
  const oldContent = fixture.cases.find(item => item.lane === 'content')!;
  const oldResult = await queryPublicContentPhrase(env, content, cursor, consumer,
    { phrase: oldContent.phrase, language: oldContent.language });
  const oldRevision = /^urn:rezics:content:revision:([0-9a-f-]{36})$/i
    .exec(oldResult.results[0]?.revision ?? '')?.[1];
  if (!oldRevision) throw new Error('cloned Content revision identity is invalid');
  const exact = (await content.readExactBatch([oldRevision], async ids => new Set(ids)))[0];
  if (exact?.status !== 'available') throw new Error('cloned Content bytes are missing');
  evidence.exactContentRevision = oldRevision;
  if (!readOnly) {
  const started = performance.now();
  const { corpus, authority } = await seedPracticalCorpus(env, contentPool, accessPool,
    10, () => {}, 1, sourceEvidence.seed.works);
  evidence.freshCohortMs = Math.round(performance.now() - started);
  evidence.freshWorks = corpus.works.length;
  await drainContent();
  const combined = await assertPublicTextReady(env.fuseki, env.lineage);
  const expectedPopulation = fixture.graphPopulation + corpus.mainUnits + corpus.contentUnits;
  if (combined.population !== expectedPopulation) throw new Error('fresh cohort population differs');
  const oldMain = fixture.cases.find(item => item.name === 'hot-main')!;
  const oldAfter = await queryPublicMainPhrase(env,
    { phrase: oldMain.phrase, language: oldMain.language });
  const freshAfter = await queryPublicMainPhrase(env,
    { phrase: corpus.cases[0]!.phrase, language: corpus.cases[0]!.language });
  if (oldAfter.total !== 1 || oldAfter.results[0]?.work !== oldMain.expectedWork
    || freshAfter.total !== 1 || freshAfter.results[0]?.work !== corpus.works[0]!.work) {
    throw new Error('old or fresh Work query changed after clone mutation');
  }
  const contentAfter = await queryPublicContentPhrase(env, content, cursor, consumer,
    { phrase: oldContent.phrase, language: oldContent.language });
  if (contentAfter.total !== 2 || contentAfter.population !== 2
    || !contentAfter.results.some(item => item.resource === oldMain.expectedWork)
    || !contentAfter.results.some(item => item.resource === corpus.works[0]!.work)) {
    throw new Error('old or fresh Content projection changed after clone mutation');
  }
  const admissions = await accessPool.query<{ sealed: string; total: string }>(`SELECT
    count(*) FILTER (WHERE state = 'sealed')::text AS sealed, count(*)::text AS total
    FROM access.admission WHERE acting_subject = $1`, [authority.actor]);
  if (admissions.rows[0]?.sealed !== admissions.rows[0]?.total
    || Number(admissions.rows[0]?.sealed) < 40) throw new Error('fresh admissions did not seal');
  evidence.afterFresh = { population: combined.population, contentPopulation: contentAfter.population,
    oldWork: oldAfter.results[0]?.work, freshWork: freshAfter.results[0]?.work,
    admissions: admissions.rows[0] };
  await Promise.all([contentPool.end(), accessPool.end()]);
  stack('stack:down');
  stack('stack:up');
  contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
  accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  content = new ContentCore(contentPool);
  cursor = new ContentProjectionCursor(contentPool);
  const afterRestart = await assertPublicTextReady(env.fuseki, env.lineage);
  if (afterRestart.population !== expectedPopulation) throw new Error('restart population differs');
  const afterContent = await queryPublicContentPhrase(env, content, cursor, consumer,
    { phrase: oldContent.phrase, language: oldContent.language });
  if (afterContent.total !== 2) throw new Error('restart Content query differs');
  evidence.afterRestart = { population: afterRestart.population,
    contentPopulation: afterContent.population, receiptSamples: await receipts() };
  }
  const sequence = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
    GRAPH <${GRAPHS.control}> { <${DATASET}> rv:sequence ?n } }`);
  evidence.graphSequence = sequence.results?.bindings?.[0]?.n?.value;
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  await Promise.allSettled([contentPool.end(), accessPool.end()]);
  evidence.completedAt = new Date().toISOString();
  if (failure) evidence.failure = failure;
  writeFileSync(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Clone probe artifacts: ${artifacts}`);
}
if (failure) throw new Error(failure);
