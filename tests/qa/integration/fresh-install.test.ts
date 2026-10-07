import { qaStartupTestTimeout, runQaAdmissionChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { readEnv, stackDirectory, type StackOptions } from '../../../scripts/dev/config.ts';
import { readFormatMarker } from '../../../scripts/dev/install.ts';
import { assertReleasePins, releaseDigest, releaseManifest } from '../../../scripts/dev/release-manifest.ts';
import { verifyReleaseArtifact } from '../../../scripts/dev/release-artifact.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';

const root = resolve(import.meta.dir, '../../..');

function reset(options: StackOptions): void {
  const result = spawnSync('bun', ['scripts/dev/cli.ts', 'stack:reset', '--profile', 'qa', '--run-id', options.runId!, '--persistent'],
    { cwd: root, encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`install fixture cleanup failed: ${result.stderr}`);
}

async function release(args: string[], timeout = 240_000): Promise<string> {
  const result = await runQaAdmissionChildAsync(root, ...scriptCommand(args), timeout);
  if (!result.ok) throw new Error(`Release command failed: ${result.output.slice(-1500)}`);
  return result.output.replace(/^QA_MEMORY_WAIT_(?:BEGIN \d+-\d+|END \d+-\d+ \d+)\r?\n/gm, '').trim();
}

test('OPS01: pinned release provisions four owners and re-provisions without changing their data', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR) {
    throw new Error('Run through isolated integration QA');
  }
  const options: StackOptions = { profile: 'qa', runId: `${Bun.env.REZICS_QA_RUN_ID}-ins`, persistent: true };
  try {
    assertReleasePins();
    const artifact = await release(['release:build']);
    expect(verifyReleaseArtifact(artifact).digest).toBe(artifact.split('/').at(-1));
    expect(await release(['release:build'])).toBe(artifact);
    const installArgs = ['release:install', '--artifact', artifact, '--profile', 'qa',
      '--run-id', options.runId!, '--persistent'];
    const first = JSON.parse(await release(installArgs)) as Awaited<ReturnType<typeof import('../../../scripts/dev/install.ts').installRelease>>;
    expect(first.ready).toEqual(['account', 'access', 'content', 'relay', 'fuseki']);
    expect(first.appliedMigrations.length).toBeGreaterThan(0);
    expect(first.releaseDigest).toBe(releaseDigest());
    expect(first.formatVersion).toBe(releaseManifest.formatVersion);
    const saved = readFormatMarker(options);
    expect(saved?.state).toBe('ready');
    expect(saved?.artifactDigest).toBe(first.artifactDigest);
    expect(saved?.fusekiImageId).toBe(first.fusekiImageId);
    const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
    const access = new Client({ connectionString: apps.ACCESS_DATABASE_URL });
    await access.connect();
    const before = await access.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM public.rezics_local_migration');
    await access.end();
    const second = JSON.parse(await release(installArgs)) as typeof first;
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
    const account = spawn(join(artifact, 'bin/bun'), ['services/account/src/index.ts'], { cwd: artifact,
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
      const mainLog = join(logs, `${options.runId}-main.log`);
      const mainFd = openSync(mainLog, 'w');
      const main = spawn(join(artifact, 'bin/bun'), ['services/main/src/index.ts'], { cwd: artifact,
        env: { ...process.env, ...apps }, stdio: ['ignore', mainFd, mainFd] });
      closeSync(mainFd);
      try {
        let mainResponse: Response | undefined;
        for (let attempt = 0; attempt < 80; attempt++) {
          if (main.exitCode !== null) break;
          try {
            mainResponse = await fetch(`http://127.0.0.1:${apps.MAIN_PORT}/health/ready`,
              { signal: AbortSignal.timeout(1000) });
            if (mainResponse.ok) break;
          } catch { /* Main is starting. */ }
          await Bun.sleep(250);
        }
        expect(mainResponse?.status, readFileSync(mainLog, 'utf8').slice(-800)).toBe(200);
      } finally {
        main.kill('SIGTERM');
        await Promise.race([new Promise(resolveExit => main.once('exit', resolveExit)), Bun.sleep(5_000)]);
        if (main.exitCode === null) main.kill('SIGKILL');
      }
    } finally {
      account.kill('SIGTERM');
      await Promise.race([new Promise(resolveExit => account.once('exit', resolveExit)), Bun.sleep(5_000)]);
      if (account.exitCode === null) account.kill('SIGKILL');
    }
  } finally { reset(options); }
}, qaStartupTestTimeout(240_000));
