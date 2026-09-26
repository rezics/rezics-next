import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { readEnv, stackDirectory, type StackOptions } from '../../../scripts/dev/config.ts';
import { installRelease, readFormatMarker } from '../../../scripts/dev/install.ts';
import { assertReleasePins, releaseDigest, releaseManifest } from '../../../scripts/dev/release-manifest.ts';

const root = resolve(import.meta.dir, '../../..');

function reset(options: StackOptions): void {
  const result = spawnSync('corepack', ['yarn', 'stack:reset', '--profile', 'qa', '--run-id', options.runId!, '--persistent'],
    { cwd: root, encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`install fixture cleanup failed: ${result.stderr}`);
}

test('OPS01: pinned release provisions four owners and re-provisions without changing their data', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR) {
    throw new Error('Run through isolated integration QA');
  }
  const options: StackOptions = { profile: 'qa', runId: `${Bun.env.REZICS_QA_RUN_ID}-ins`, persistent: true };
  try {
    assertReleasePins();
    const first = await installRelease(options);
    expect(first.ready).toEqual(['account', 'access', 'content', 'relay', 'fuseki']);
    expect(first.appliedMigrations.length).toBeGreaterThan(0);
    expect(first.releaseDigest).toBe(releaseDigest());
    expect(first.formatVersion).toBe(releaseManifest.formatVersion);
    const saved = readFormatMarker(options);
    expect(saved?.state).toBe('ready');
    expect(saved?.fusekiImageId).toBe(first.fusekiImageId);
    const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
    const access = new Client({ connectionString: apps.ACCESS_DATABASE_URL });
    await access.connect();
    const before = await access.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM public.rezics_local_migration');
    await access.end();
    const second = await installRelease(options);
    expect(second.appliedMigrations).toEqual([]);
    expect(readFormatMarker(options)).toEqual(saved);
    const accessAgain = new Client({ connectionString: apps.ACCESS_DATABASE_URL });
    await accessAgain.connect();
    try {
      const after = await accessAgain.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM public.rezics_local_migration');
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    } finally { await accessAgain.end(); }

    const logs = join(Bun.env.REZICS_QA_ARTIFACT_DIR!, 'logs');
    mkdirSync(logs, { recursive: true });
    const accountLog = join(logs, `${options.runId}-account.log`);
    const fd = openSync(accountLog, 'w');
    const account = spawn('bun', ['services/account/src/index.ts'], { cwd: root,
      env: { ...process.env, ...apps }, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (account.exitCode !== null) break;
        try {
          response = await fetch(`${apps.ACCOUNT_BASE_URL}/health/ready`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) break;
        } catch { /* Account is starting. */ }
        await Bun.sleep(250);
      }
      expect(response?.status, readFileSync(accountLog, 'utf8').slice(-500)).toBe(200);
    } finally {
      account.kill('SIGTERM');
      await Promise.race([new Promise(resolveExit => account.once('exit', resolveExit)), Bun.sleep(5_000)]);
      if (account.exitCode === null) account.kill('SIGKILL');
    }
  } finally { reset(options); }
}, 240_000);
