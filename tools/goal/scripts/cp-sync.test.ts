import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESIDENT_CODE_UNITS } from '../src/service.ts';
import { restartResident } from './cp-sync.ts';

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

test('After publication, cp-sync restarts every resident service that runs tools/goal code (the manager host and the dev verifier), and verifies that each one\'s process started after the publication.', async () => {
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
