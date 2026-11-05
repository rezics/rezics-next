import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESIDENT_CODE_UNITS } from '../src/service.ts';
import { residentRegression, restartResident, sync } from './cp-sync.ts';

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'cp-sync-resident-'));
  mkdirSync(join(root, '.temp/goal'), { recursive: true });
  writeFileSync(join(root, '.temp/goal/goal.env'), '');
  return root;
}

function loadState(argv: string[]): { code: number; output: string } | undefined {
  if (!argv.includes('--property=LoadState')) return undefined;
  return { code: 0, output: argv.at(-1) === 'rezics-goal-supervisor.service' ? 'not-found' : 'loaded' };
}

test("After publication, cp-sync restarts every resident service that runs tools/goal code (the manager host and the dev verifier), and verifies that each one's process started after the publication.", async () => {
  const root = checkout();
  const calls: string[][] = [];
  const startedAtSec = Math.floor(Date.now() / 1000) + 5;
  try {
    await restartResident(root, async (argv, cwd) => {
      expect(cwd).toBe(root);
      calls.push(argv);
      const loaded = loadState(argv);
      if (loaded) return loaded;
      if (argv.includes('restart')) return { code: 0, output: '' };
      return { code: 0, output: `ActiveState=active\nExecMainStartTimestamp=@${startedAtSec}\n` };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  expect(RESIDENT_CODE_UNITS).toEqual(['rezics-goal-host.service', 'rezics-goal-verifier.service']);
  for (const unit of RESIDENT_CODE_UNITS) {
    expect(calls).toContainEqual(['systemctl', '--user', 'restart', unit]);
    expect(
      calls.some(
        (call) =>
          call.includes('show') &&
          call.includes(unit) &&
          call.includes('--property=ActiveState,ExecMainStartTimestamp') &&
          call.includes('--timestamp=unix'),
      ),
    ).toBe(true);
  }
});

test('If a resident service cannot be restarted or does not come back, cp-sync reports it as a failure with the service name.', async () => {
  const root = checkout();
  const failed = RESIDENT_CODE_UNITS[1]!;
  const startedAtSec = Math.floor(Date.now() / 1000) + 5;
  try {
    await expect(
      restartResident(root, async (argv) => {
        const loaded = loadState(argv);
        if (loaded) return loaded;
        if (argv.includes('restart') && argv.includes(failed)) return { code: 1, output: 'Job failed' };
        if (argv.includes('restart')) return { code: 0, output: '' };
        return { code: 0, output: `ActiveState=active\nExecMainStartTimestamp=@${startedAtSec}\n` };
      }),
    ).rejects.toThrow(`${failed} failed to restart`);
    await expect(
      restartResident(root, async (argv) => {
        const loaded = loadState(argv);
        if (loaded) return loaded;
        if (argv.includes('restart')) return { code: 0, output: '' };
        if (argv.includes(failed)) return { code: 0, output: 'ActiveState=failed\nExecMainStartTimestamp=@0\n' };
        return { code: 0, output: `ActiveState=active\nExecMainStartTimestamp=@${startedAtSec}\n` };
      }),
    ).rejects.toThrow(`${failed} did not become ready.`);
    await expect(
      restartResident(root, async (argv) => {
        const loaded = loadState(argv);
        if (loaded) return loaded;
        if (argv.includes('restart')) return { code: 0, output: '' };
        const unit = RESIDENT_CODE_UNITS.find((name) => argv.includes(name));
        const started = unit === failed ? startedAtSec - 3600 : startedAtSec;
        return { code: 0, output: `ActiveState=active\nExecMainStartTimestamp=@${started}\n` };
      }),
    ).rejects.toThrow(`${failed} did not start after publication.`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A main checkout, and a dev branch one commit ahead in tools/goal. */
function syncRepository(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'tools/goal/src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, '.gitignore'), '.temp/\n');
  writeFileSync(join(repo, 'tools/goal/src/a.ts'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Initial');
  git(repo, 'checkout', '-q', '-b', 'dev');
  writeFileSync(join(repo, 'tools/goal/src/a.ts'), 'export const a = 2;\n');
  git(repo, 'commit', '-qam', 'Dev work');
  git(repo, 'checkout', '-q', 'main');
  return repo;
}

test('A cp-sync with passing checks publishes and restarts in under 8 minutes: no observation window before publication, and at most 3 minutes after it.', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-sync-timing-'));
  try {
    const repo = syncRepository(root);
    const main = git(repo, 'rev-parse', 'main');
    const observed: { windowMs: number; published: boolean }[] = [];
    let restarts = 0;
    const result = await sync({
      cwd: repo,
      worktreeRoot: join(root, 'worktrees'),
      print: () => {},
      checks: [{ name: 'check', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60_000 }],
      resident: {
        async observe(_checkout, sampling) {
          observed.push({
            windowMs: (sampling.samples - 1) * sampling.sampleMs,
            published: git(repo, 'rev-parse', 'main') !== main,
          });
          return { liveWorkers: 1, passedGates: 1, landings: 1 };
        },
        async restart() {
          restarts++;
        },
      },
    });
    expect(result).toBe(0);
    expect(git(repo, 'rev-parse', 'main')).not.toBe(main);
    expect(restarts).toBe(1);
    expect(observed.map((reading) => reading.published)).toEqual([false, true]);
    expect(observed[0]!.windowMs).toBe(0);
    expect(observed[1]!.windowMs).toBeGreaterThan(0);
    expect(observed[1]!.windowMs).toBeLessThanOrEqual(3 * 60_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('a release rolls back only when live workers fall by more than half or landings running before publication merge none', () => {
  const quiet = { liveWorkers: 4, passedGates: 0, landings: 0 };
  const running = { ...quiet, landingsRequested: true };
  expect(residentRegression(quiet, { liveWorkers: 2, passedGates: 1, landings: 0 })).toBe(false);
  expect(residentRegression(quiet, { liveWorkers: 1, passedGates: 1, landings: 0 })).toBe(true);
  expect(residentRegression(quiet, { liveWorkers: 4, passedGates: 0, landings: 0 })).toBe(false);
  expect(residentRegression({ ...quiet, liveWorkers: 0 }, { liveWorkers: 0, passedGates: 0, landings: 0 })).toBe(false);
  expect(residentRegression(running, { liveWorkers: 4, passedGates: 0, landings: 0 })).toBe(true);
  expect(residentRegression(running, { liveWorkers: 4, passedGates: 0, landings: 1 })).toBe(false);
});
