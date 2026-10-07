import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { testArgs, unitHarnessFiles } from '../../../scripts/qa/acceptance.ts';
import { expandTestPaths, splitTestArgs } from '../../../scripts/qa/core.ts';
import { repositoryGuards } from '../../../scripts/qa/repository-guards.ts';

const root = resolve(import.meta.dir, '../../..');

test('repository guards are unique, reasoned, existing backend unit or owner tests', () => {
  const registered = new Set(unitHarnessFiles);
  for (const tier of ['unit', 'owner'] as const) {
    for (const file of expandTestPaths(root, splitTestArgs(testArgs(tier)).paths))
      registered.add(file);
  }
  const files = repositoryGuards.map((guard) => guard.file);
  expect(files).toEqual([...new Set(files)]);
  for (const guard of repositoryGuards) {
    expect(guard.reason.trim().length, guard.file).toBeGreaterThan(0);
    expect(existsSync(join(root, guard.file)), guard.file).toBe(true);
    expect(registered.has(guard.file), guard.file).toBe(true);
    expect(guard.file).toMatch(/\.test\.ts$/);
  }
});

test('both static modes run the Node-typed AppHost task, including SDK restoration', () => {
  const gate = readFileSync(join(root, 'scripts/research/storage_architecture/check.ts'), 'utf8');
  expect(gate.slice(0, gate.indexOf('...(!backend'))).toContain("['task', 'apphost:typecheck']");
  const tasks = readFileSync(join(root, 'Taskfile.yml'), 'utf8');
  const task = /\n  apphost:typecheck:\n([\s\S]*?)(?=\n  \S)/.exec(tasks)?.[1];
  expect(task).toContain('deps: [aspire:restore]');
  expect(task).toContain('tsc --project apphost/tsconfig.apphost.json');
});

test('the merge Task command executes mixed unit and owner files and retains guard failure attribution', () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const fixture = mkdtempSync(join(root, '.temp/merge-unit-files-'));
  try {
    copyFileSync(join(root, 'Taskfile.yml'), join(fixture, 'Taskfile.yml'));
    const unit = 'tests/qa/unit/operation.test.ts';
    const guard = 'scripts/inventory.test.ts';
    for (const file of [unit, guard]) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      writeFileSync(
        join(fixture, file),
        "import { expect, test } from 'bun:test';\ntest('valid', () => expect(true).toBe(true));\n",
      );
    }
    const run = () =>
      spawnSync('task', ['goal:unit-files', '--', `./${unit}`, `./${guard}`], {
        cwd: fixture,
        encoding: 'utf8',
        env: { ...process.env, AGENT: '1' },
        timeout: 10_000,
      });
    const passing = run();
    expect(passing.status, `${passing.stdout}\n${passing.stderr}`).toBe(0);
    expect(`${passing.stdout}\n${passing.stderr}`).toContain('2 pass');
    writeFileSync(
      join(fixture, guard),
      "import { expect, test } from 'bun:test';\ntest('invalid inventory', () => expect(false).toBe(true));\n",
    );
    const failing = run();
    expect(failing.status).not.toBe(0);
    expect(`${failing.stdout}\n${failing.stderr}`).toContain(`${guard}:`);
    expect(`${failing.stdout}\n${failing.stderr}`).toContain('1 pass');
    expect(`${failing.stdout}\n${failing.stderr}`).toContain('1 fail');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the real AppHost type check passes and rejects Bun.file through Main configuration imports', () => {
  const passing = spawnSync('task', ['apphost:typecheck'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  expect(passing.status, `${passing.stdout}\n${passing.stderr}`).toBe(0);

  mkdirSync(join(root, '.temp'), { recursive: true });
  const fixture = mkdtempSync(join(root, '.temp/apphost-types-'));
  try {
    for (const file of [
      'apphost/apphost.mts',
      'apphost/package.json',
      'apphost/tsconfig.apphost.json',
      'services/main/package.json',
      'services/main/src/config.ts',
      'services/main/src/modules/media-screen/required-matcher.ts',
    ]) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      copyFileSync(join(root, file), join(fixture, file));
    }
    for (const path of ['node_modules', 'apps', 'services/account', 'apphost/.aspire']) {
      symlinkSync(join(root, path), join(fixture, path), 'dir');
    }
    const compiler = () =>
      spawnSync(
        'bun',
        [
          join(root, 'node_modules/typescript/bin/tsc'),
          '--project',
          join(fixture, 'apphost/tsconfig.apphost.json'),
        ],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
    const clean = compiler();
    expect(clean.status, `${clean.stdout}\n${clean.stderr}`).toBe(0);
    const dependency = join(fixture, 'services/main/src/modules/media-screen/required-matcher.ts');
    writeFileSync(
      dependency,
      `${readFileSync(dependency, 'utf8')}\nvoid Bun.file('synthetic-corpus.json');\n`,
    );
    const broken = compiler();
    expect(broken.status).not.toBe(0);
    expect(broken.stdout).toContain('required-matcher.ts');
    expect(broken.stdout).toContain("Cannot find name 'Bun'");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 180_000);
