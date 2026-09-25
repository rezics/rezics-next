import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expectedFusekiModuleVersion } from '../../../scripts/qa/core.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';

const root = resolve(import.meta.dir, '../../..');

test('OPS01: host Main work readiness accepts the pinned live command module', async () => {
  const artifacts = Bun.env.REZICS_QA_ARTIFACT_DIR;
  const port = Bun.env.MAIN_PORT;
  const fusekiUrl = Bun.env.FUSEKI_URL;
  if (!Bun.env.REZICS_QA_RUN_ID || !artifacts || !port || !fusekiUrl) {
    throw new Error('Run through the isolated integration QA tier');
  }
  const expected = expectedFusekiModuleVersion(
    readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8'));
  const actual = await new FusekiClient(fusekiUrl).commandHealth();
  expect(actual.moduleVersion).toBe(expected);
  expect(actual.publicSearchDeltaAvailable).toBe(false); // QA exposes a general update operation.

  const logs = join(artifacts, 'logs');
  mkdirSync(logs, { recursive: true });
  const logPath = join(logs, 'main-readiness.log');
  const fd = openSync(logPath, 'w');
  const main = spawn('bun', ['services/main/src/index.ts'], { cwd: root,
    env: process.env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  let passed = false;
  try {
    const base = `http://127.0.0.1:${port}`;
    let live: Response | undefined;
    const until = Date.now() + 30_000;
    while (Date.now() < until && main.exitCode === null) {
      try {
        live = await fetch(`${base}/health/live`, { signal: AbortSignal.timeout(1500) });
        if (live.ok) break;
      } catch { /* Main is still starting. */ }
      await Bun.sleep(250);
    }
    expect(live?.status).toBe(200);
    const ready = await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(10_000) });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
    passed = true;
  } finally {
    main.kill('SIGTERM');
    await Promise.race([new Promise(resolve => main.once('exit', resolve)), Bun.sleep(5_000)]);
    if (main.exitCode === null) main.kill('SIGKILL');
    if (passed) unlinkSync(logPath);
  }
}, 45_000);
