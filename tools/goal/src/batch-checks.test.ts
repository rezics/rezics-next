import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import defaults from '../defaults.json';
import { packageManager } from '../../../package.json';
import { verifyDev } from './dev-verifier.ts';
import { createVerifierChecks, projectVerifierLandings } from './dev-verifier-plan.ts';
import { latestRound } from './dev-verifier-storage.ts';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

const firstFile = 'packages/ui/one.ts';
const secondFile = 'packages/ui/two.ts';

async function landBatch(h: ReturnType<typeof integrationHarness>) {
  h.ensureDev();
  h.settings.integration.batchSize = 2;
  const base = h.head('dev');
  const tasks = [h.dispatch(firstFile), h.dispatch(secondFile)];
  for (const task of tasks) await h.start(task);
  const landingChecks: string[][] = [];
  await h.train(async (command) => {
    landingChecks.push([...command]);
    return { passed: false, output: 'Unexpected dev landing check', timedOut: false };
  });
  const landed = h.head('dev');
  expect(landingChecks).toEqual([]);
  expect(h.outcomes.map(({ taskId, passed, mergedCommit }) => [taskId, passed, mergedCommit])).toEqual(
    tasks.map(({ id }) => [id, true, landed]),
  );
  return { base, landed };
}

test('default affected checks keep only the kernel entry', () => {
  expect(defaults.affectedTests).toEqual([
    {
      paths: ['services/kernel/**'],
      command: ['env', 'KERNEL_CHECK_AFFECTED_MAX=60', 'bun', 'run', '--cwd', 'services/kernel', 'check'],
    },
  ]);
});

test('the independent verifier selects a shared affected check once for both batch members', async () => {
  const h = integrationHarness();
  try {
    const marker = join(h.settings.stateDirectory, 'affected-check-ran');
    const check = {
      paths: ['packages/ui/**'],
      command: ['sh', '-c', 'touch "$1"', 'check-ui', marker],
    };
    h.settings.affectedTests = [check];
    h.settings.verifierChecks = [check];

    const { base, landed } = await landBatch(h);
    expect(existsSync(marker)).toBe(false);
    const history = projectVerifierLandings(h.root, h.store, base, landed);
    const checks = createVerifierChecks(h.settings, history);

    expect(checks.filter(({ command }) => command.includes(marker))).toEqual([
      { command: check.command, closure: check.paths },
    ]);
  } finally {
    h.dispose();
  }
});

test('the independent verifier selects checks that match either batch member and skips unmatched checks', async () => {
  const h = integrationHarness();
  try {
    h.settings.verifierChecks = [
      { paths: [firstFile], command: ['check-one'] },
      { paths: [secondFile], command: ['check-two'] },
      { paths: ['packages/filter/**'], command: ['check-unmatched'] },
    ];

    const { base, landed } = await landBatch(h);
    const history = projectVerifierLandings(h.root, h.store, base, landed);
    const selected = createVerifierChecks(h.settings, history)
      .map(({ command }) => command[0])
      .filter((command) => command?.startsWith('check-'));

    expect(selected).toEqual(['check-one', 'check-two']);
  } finally {
    h.dispose();
  }
});

test('a failed postintegration affected check leaves both batch members integrated', async () => {
  const h = integrationHarness();
  try {
    writeFileSync(
      join(h.root, 'package.json'),
      JSON.stringify({ packageManager, devDependencies: { bun: packageManager.slice('bun@'.length) } }),
    );
    const lock = spawnSync(process.execPath, ['install', '--lockfile-only', '--ignore-scripts'], {
      cwd: h.root,
      encoding: 'utf8',
    });
    if (lock.status !== 0) throw new Error(lock.stderr || 'could not lock the verifier fixture Bun pin');
    git(h.root, 'add', 'package.json', 'bun.lock');
    git(h.root, 'commit', '-m', 'Prepare verifier fixture');

    const check = { paths: ['packages/ui/**'], command: ['check-ui'] };
    h.settings.affectedTests = [check];
    h.settings.verifierChecks = [check];

    const { landed } = await landBatch(h);
    let affectedRuns = 0;
    await verifyDev({
      settings: h.settings,
      store: h.store,
      async runGate(command, cwd) {
        if (command[0] !== 'check-ui') return { passed: true, output: '', timedOut: false };
        affectedRuns++;
        expect(existsSync(join(cwd, firstFile))).toBe(true);
        expect(existsSync(join(cwd, secondFile))).toBe(true);
        return { passed: false, output: 'AssertionError: combined UI check failed', timedOut: false };
      },
    });

    expect(affectedRuns).toBe(1);
    expect(latestRound(h.store)?.round).toMatchObject({ headCommit: landed, failed: 1, unknown: 0 });
    expect(h.head('dev')).toBe(landed);
    expect(h.outcomes.map(({ passed }) => passed)).toEqual([true, true]);
  } finally {
    h.dispose();
  }
});
