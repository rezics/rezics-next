import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

test('OPS05: bounded public Main phrase load returns real complete query snapshots', async () => {
  const artifacts = Bun.env.REZICS_QA_ARTIFACT_DIR;
  const port = Bun.env.MAIN_PORT;
  if (!Bun.env.REZICS_QA_RUN_ID || !artifacts || !port || !Bun.env.FUSEKI_URL) {
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
  const evidence: Record<string, unknown> = {
    acceptanceId: 'OPS05', scope: 'empty-corpus public query baseline',
    image: 'grafana/k6:2.3.0', vus: 2, durationSeconds: 20,
    minimumPaceSecondsPerIteration: 0.1,
    profile: 'public-main-phrase-v1', mainBaseUrl: baseUrl,
  };
  let passed = false;
  try {
    await ready(baseUrl, main);
    const probe = await fetch(`${baseUrl}/v1/queries`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-main-phrase-v1', phrase: 'cedar atlas', language: null }),
    });
    const snapshot = await probe.json() as Record<string, unknown>;
    evidence.preflight = { status: probe.status, snapshot };
    expect(probe.status).toBe(200);
    expect(snapshot.population).toBe(0);
    expect(snapshot.total).toBe(0);
    expect(snapshot.complete).toBe(true);

    const socket = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, 'podman/podman.sock');
    const dockerEnv = { ...process.env,
      ...(!process.env.DOCKER_HOST || process.env.DOCKER_HOST.includes('/.docker/desktop/')
        ? existsSync(socket) ? { DOCKER_HOST: `unix://${socket}` } : {} : {}) };
    const script = join(import.meta.dir, 'public-query.k6.js');
    const run = spawnSync('docker', ['run', '--rm', '--network', 'host',
      '--user', '0:0',
      '--volume', `${script}:/scripts/public-query.js:ro,Z`,
      '--volume', `${loadDir}:/artifacts:Z`,
      '--env', `MAIN_BASE_URL=${baseUrl}`,
      'grafana/k6:2.3.0', 'run', '--summary-export=/artifacts/k6-summary.json',
      '/scripts/public-query.js'], { cwd: root, env: dockerEnv,
      encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    evidence.k6Exit = run.status;
    evidence.k6Error = run.error?.message;
    const image = spawnSync('docker', ['image', 'inspect', 'grafana/k6:2.3.0',
      '--format', '{{.Id}}'], { cwd: root, env: dockerEnv, encoding: 'utf8', timeout: 5_000 });
    evidence.imageId = image.status === 0 ? image.stdout.trim() : undefined;
    const summaryPath = join(loadDir, 'k6-summary.json');
    if (run.status !== 0 || run.error || !existsSync(summaryPath)) {
      writeFileSync(join(loadDir, 'k6.log'), [run.stdout, run.stderr, run.error?.message]
        .filter(Boolean).join('\n'));
    }
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
      metrics?: Record<string, Record<string, number>> };
    const metrics = summary.metrics ?? {};
    evidence.metrics = {
      requests: metrics.http_reqs?.count,
      requestRatePerSecond: metrics.http_reqs?.rate,
      p95Ms: metrics.http_req_duration?.['p(95)'],
      failedRate: metrics.http_req_failed?.value,
      checkRate: metrics.checks?.value,
    };
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(metrics.http_reqs?.count).toBeGreaterThanOrEqual(20);
    expect(metrics.http_req_duration?.['p(95)']).toBeLessThan(1500);
    expect(metrics.http_req_failed?.value).toBe(0);
    expect(metrics.checks?.value).toBe(1);
    passed = true;
  } finally {
    main.kill('SIGTERM');
    await Promise.race([new Promise(resolve => main.once('exit', resolve)), Bun.sleep(5_000)]);
    if (main.exitCode === null) main.kill('SIGKILL');
    writeFileSync(join(loadDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    if (passed) unlinkSync(mainLog);
  }
}, 140_000);
