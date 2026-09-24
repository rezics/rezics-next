import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { seedLoadCorpus, type LoadCase, type LoadCorpus } from './corpus.ts';

const root = resolve(import.meta.dir, '../../..');

async function ready(url: string, child: ReturnType<typeof spawn>): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until && child.exitCode === null) {
    try {
      const response = await fetch(`${url}/health/search-ready`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch { /* Main is still starting. */ }
    await Bun.sleep(250);
  }
  throw new Error('Main did not become search-ready within 30 seconds');
}

function queryBody(item: LoadCase, realm: string) {
  return { profile: item.lane === 'realm' ? 'public-realm-phrase-v1'
    : item.lane === 'content' ? 'public-content-phrase-v1' : 'public-main-phrase-v1',
    ...(item.lane === 'realm' ? { context: { kind: 'realm-local', id: realm } } : {}),
    phrase: item.phrase, language: item.language };
}

async function contentReady(baseUrl: string, item: LoadCase, realm: string) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const response = await fetch(`${baseUrl}/v1/queries`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(queryBody(item, realm)),
    });
    if (response.status === 200) return;
    if (response.status !== 503) throw new Error(`Content query returned ${response.status}`);
    await Bun.sleep(250);
  }
  throw new Error('Content projection did not become ready within 30 seconds');
}

function checkSnapshot(snapshot: Record<string, any>, item: LoadCase, corpus: LoadCorpus) {
  expect(snapshot.contractVersion).toBe('1');
  expect(snapshot.complete).toBe(true);
  expect(snapshot.population).toBe(item.lane === 'content'
    ? corpus.contentUnits : corpus.mainUnits + corpus.contentUnits);
  expect(snapshot.total).toBe(item.expectedWork === null ? 0 : 1);
  expect(snapshot.results).toHaveLength(snapshot.total);
  if (item.expectedWork !== null) {
    expect(snapshot.results[0][item.lane === 'content' ? 'resource' : 'work']).toBe(item.expectedWork);
    if (item.expectedContribution) expect(snapshot.results[0].contribution).toBe(item.expectedContribution);
    if (item.expectedReason) expect(snapshot.results[0].reason).toBe(item.expectedReason);
  }
}

function dockerEnvironment() {
  const socket = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, 'podman/podman.sock');
  return { ...process.env,
    ...(!process.env.DOCKER_HOST || process.env.DOCKER_HOST.includes('/.docker/desktop/')
      ? existsSync(socket) ? { DOCKER_HOST: `unix://${socket}` } : {} : {}) };
}

async function k6Run(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn('docker', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000);
  try {
    const status = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolveExit(code));
    });
    return { status, output };
  } finally { clearTimeout(timeout); }
}

test('OPS05/SEARCH18/SEARCH19: bounded skewed Main, Realm and Content phrase load stays complete', async () => {
  const artifacts = Bun.env.REZICS_QA_ARTIFACT_DIR;
  const port = Bun.env.MAIN_PORT;
  if (!Bun.env.REZICS_QA_RUN_ID || !artifacts || !port || !Bun.env.FUSEKI_URL
    || !Bun.env.CONTENT_DATABASE_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated load QA tier');
  }
  const loadDir = join(artifacts, 'load');
  mkdirSync(loadDir, { recursive: true });
  const mainLog = join(loadDir, 'main.log');
  const logFd = openSync(mainLog, 'w');
  const main = spawn('bun', ['services/main/src/index.ts'], { cwd: root,
    env: process.env, stdio: ['ignore', logFd, logFd] });
  closeSync(logFd);
  const baseUrl = `http://127.0.0.1:${port}`;
  const env: WorkActivationEnvironment = {
    fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: Bun.env.MAIN_OBJECT_DIRECTORY!,
  };
  const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const evidence: Record<string, unknown> = {
    acceptanceIds: ['OPS05', 'SEARCH18', 'SEARCH19'], scope: 'admitted bounded mixed public corpus',
    image: 'grafana/k6:2.3.0', vus: 2, durationSeconds: 20, paceSeconds: 0.1,
    offeredMix: { hotWork: 0.5, otherMain: 0.2, realm: 0.2, content: 0.1 },
    fullHostObjective: { works: 10_000, concurrentClients: 10, durationSeconds: 180 },
  };
  let passed = false;
  try {
    await ready(baseUrl, main);
    const emptyProbe = await fetch(`${baseUrl}/v1/queries`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-main-phrase-v1',
        phrase: 'cedar atlas', language: null }),
    });
    const empty = await emptyProbe.json() as Record<string, unknown>;
    evidence.emptyPreflight = { status: emptyProbe.status, population: empty.population,
      total: empty.total, complete: empty.complete };
    expect(emptyProbe.status).toBe(200);
    expect(empty.population).toBe(0);
    expect(empty.total).toBe(0);
    expect(empty.complete).toBe(true);
    const corpus = await seedLoadCorpus(env, pool);
    evidence.corpus = { works: corpus.works.length, mainUnits: corpus.mainUnits,
      contentUnits: corpus.contentUnits, languages: ['en', 'zh', 'ja'],
      realm: corpus.realm, rejectedCandidate: true, cases: corpus.cases };
    await contentReady(baseUrl, corpus.cases.find(item => item.lane === 'content')!, corpus.realm);
    const preflight: Record<string, unknown> = {};
    evidence.preflight = preflight;
    for (const item of corpus.cases) {
      const response = await fetch(`${baseUrl}/v1/queries`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(queryBody(item, corpus.realm)),
      });
      const snapshot = await response.json() as Record<string, any>;
      preflight[item.name] = { status: response.status, total: snapshot.total,
        population: snapshot.population, indexGeneration: snapshot.indexGeneration,
        sourcePosition: snapshot.sourcePosition ?? snapshot.contentPosition };
      expect(response.status).toBe(200);
      checkSnapshot(snapshot, item, corpus);
    }
    writeFileSync(join(loadDir, 'load-cases.json'), JSON.stringify({ realm: corpus.realm,
      graphPopulation: corpus.mainUnits + corpus.contentUnits, contentPopulation: corpus.contentUnits,
      cases: corpus.cases }, null, 2) + '\n');
    const dockerEnv = dockerEnvironment();
    const script = join(import.meta.dir, 'public-query.k6.js');
    const run = await k6Run(['run', '--rm', '--network', 'host', '--user', '0:0',
      '--volume', `${script}:/scripts/public-query.js:ro,Z`,
      '--volume', `${loadDir}:/artifacts:Z`, '--env', `MAIN_BASE_URL=${baseUrl}`,
      'grafana/k6:2.3.0', 'run', '--summary-export=/artifacts/k6-summary.json',
      '/scripts/public-query.js'], dockerEnv);
    evidence.k6Exit = run.status;
    const image = spawnSync('docker', ['image', 'inspect', 'grafana/k6:2.3.0',
      '--format', '{{.Id}}'], { cwd: root, env: dockerEnv, encoding: 'utf8', timeout: 5_000 });
    evidence.imageId = image.status === 0 ? image.stdout.trim() : undefined;
    const summaryPath = join(loadDir, 'k6-summary.json');
    if (run.status !== 0 || !existsSync(summaryPath)) writeFileSync(join(loadDir, 'k6.log'), run.output);
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
      metrics?: Record<string, Record<string, number>> };
    const metrics = summary.metrics ?? {};
    evidence.metrics = {
      requests: metrics.http_reqs?.count,
      requestRatePerSecond: metrics.http_reqs?.rate,
      p95Ms: metrics.http_req_duration?.['p(95)'],
      p99Ms: metrics.http_req_duration?.['p(99)'],
      failedRate: metrics.http_req_failed?.value,
      checkRate: metrics.checks?.value,
      mainReads: metrics.load_main_reads?.count,
      realmReads: metrics.load_realm_reads?.count,
      contentReads: metrics.load_content_reads?.count,
      hotReads: metrics.load_hot_reads?.count,
      serverErrorRate: metrics.load_server_errors?.value,
    };
    expect(run.status).toBe(0);
    expect(metrics.http_reqs?.count).toBeGreaterThanOrEqual(20);
    expect(metrics.load_main_reads?.count).toBeGreaterThanOrEqual(10);
    expect(metrics.load_realm_reads?.count).toBeGreaterThanOrEqual(3);
    expect(metrics.load_content_reads?.count).toBeGreaterThanOrEqual(1);
    expect(metrics.load_hot_reads?.count).toBeGreaterThanOrEqual(8);
    expect(metrics.http_req_duration?.['p(95)']).toBeLessThan(2500);
    expect(metrics.http_req_failed?.value).toBe(0);
    expect(metrics.checks?.value).toBe(1);
    passed = true;
  } finally {
    await pool.end();
    main.kill('SIGTERM');
    await Promise.race([new Promise(resolve => main.once('exit', resolve)), Bun.sleep(5_000)]);
    if (main.exitCode === null) main.kill('SIGKILL');
    writeFileSync(join(loadDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    if (passed) unlinkSync(mainLog);
  }
}, 180_000);
