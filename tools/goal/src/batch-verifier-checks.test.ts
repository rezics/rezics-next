import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyDev } from './dev-verifier.ts';
import { git, processGroupRunner } from './merge.ts';
import { integrationHarness } from './test-support.ts';
import { typecheck } from '../../../scripts/typecheck.ts';

const rootTypecheck = readFileSync(resolve(import.meta.dir, '../../../scripts/typecheck.ts'), 'utf8');
const rootGate = `export function resolveBunCommand(command: string[], _directory?: string): string[] { return command; }\n`;
const compiler = resolve(import.meta.dir, '../../../node_modules/.bin/tsc');
const sourceFile = 'apps/widget/src/value.ts';

function setupCompilerFixture(h: ReturnType<typeof integrationHarness>): void {
  mkdirSync(join(h.root, 'scripts'), { recursive: true });
  writeFileSync(join(h.root, 'package.json'), JSON.stringify({ packageManager: `bun@${Bun.version}` }));
  writeFileSync(join(h.root, '.gitignore'), '.temp/\nnode_modules/\n');
  writeFileSync(join(h.root, 'scripts/typecheck.ts'), rootTypecheck);
  writeFileSync(join(h.root, 'scripts/gate.ts'), rootGate);
  mkdirSync(join(h.root, 'apps/widget/src'), { recursive: true });
  writeFileSync(
    join(h.root, 'apps/widget/package.json'),
    JSON.stringify({
      name: '@fixture/widget',
      scripts: { check: 'true', typecheck: `${compiler} --noEmit -p tsconfig.json` },
    }),
  );
  writeFileSync(
    join(h.root, 'apps/widget/tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
  );
  mkdirSync(join(h.root, 'apps/other/src'), { recursive: true });
  writeFileSync(
    join(h.root, 'apps/other/package.json'),
    JSON.stringify({
      name: '@fixture/other',
      scripts: { check: 'true', typecheck: `${compiler} --noEmit -p tsconfig.json` },
    }),
  );
  writeFileSync(
    join(h.root, 'apps/other/tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(join(h.root, 'apps/other/src/unrelated.ts'), 'export const unrelated = false;\n');
  writeFileSync(join(h.root, 'apps/widget/src/source.ts'), 'export const source = 1;\n');
  writeFileSync(join(h.root, sourceFile), 'export const value = 1;\n');
  const staged = spawnSync(
    'git',
    ['add', '.gitignore', 'package.json', 'scripts/typecheck.ts', 'scripts/gate.ts', 'apps/widget', 'apps/other'],
    { cwd: h.root, encoding: 'utf8' },
  );
  if (staged.status !== 0) throw new Error(staged.stderr || 'could not stage compiler fixture');
  const committed = spawnSync('git', ['commit', '-m', 'Prepare compiler fixture'], { cwd: h.root, encoding: 'utf8' });
  if (committed.status !== 0) throw new Error(committed.stderr || 'could not commit compiler fixture');
  h.ensureDev();
  h.settings.integration.batchSize = 2;
  h.settings.integration.devLandingChecks = false;
  h.settings.affectedTests = [];
  h.settings.verifierChecks = [];
}

function writeSelectionWorkspace(
  root: string,
  directory: string,
  name: string,
  dependencies?: Record<string, string>,
): void {
  const workspace = join(root, directory);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({
      name,
      scripts: { check: 'true', typecheck: 'bun check.ts' },
      ...(dependencies ? { dependencies } : {}),
    }),
  );
  writeFileSync(
    join(workspace, 'check.ts'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync('ran', ${JSON.stringify(name)});\n`,
  );
}

async function compileTrain(h: ReturnType<typeof integrationHarness>) {
  const commands: string[][] = [];
  const run = processGroupRunner(120_000);
  await h.train(async (command, cwd, logPath) => {
    commands.push([...command]);
    if (!command.some((part) => part.includes('scripts/typecheck.ts')))
      return { passed: false, output: `Unexpected preintegration check: ${command.join(' ')}`, timedOut: false };
    installFixtureBun(cwd);
    return run(command, cwd, logPath);
  });
  return commands;
}

function installFixtureBun(root: string): void {
  const bin = join(root, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  const pinned = join(bin, 'bun');
  if (!existsSync(pinned)) symlinkSync(process.execPath, pinned);
}

function setPlan(
  h: ReturnType<typeof integrationHarness>,
  task: { worktree: string },
  content: string,
  file = sourceFile,
): void {
  writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content }));
}

test('the combined candidate compiler catches duplicate imports and leaves dev unchanged', async () => {
  const h = integrationHarness();
  try {
    setupCompilerFixture(h);
    h.settings.integration.batchSize = 3;
    const first = h.dispatch(sourceFile);
    const second = h.dispatch(sourceFile);
    const unrelatedFile = 'apps/other/src/unrelated.ts';
    const unrelated = h.dispatch(unrelatedFile);
    setPlan(h, first, "import { source as loaded } from './source.js';\nexport const value = 1;\n");
    setPlan(h, second, "export const value = 1;\nimport { source as loaded } from './source.js';\n");
    setPlan(h, unrelated, 'export const unrelated = true;\n', unrelatedFile);
    await Promise.all([h.start(first), h.start(second), h.start(unrelated)]);
    const dev = h.head('dev');

    const commands = await compileTrain(h);

    expect(commands).toHaveLength(1);
    const changed = commands[0]?.find((part) => part.startsWith('TYPECHECK_CHANGED='));
    expect(changed?.slice('TYPECHECK_CHANGED='.length).split('\n')).toContain(sourceFile);
    expect(changed?.slice('TYPECHECK_CHANGED='.length).split('\n')).toContain(unrelatedFile);
    expect(h.head('dev')).toBe(dev);
    expect(h.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([
      [first.id, false],
      [second.id, false],
    ]);
    expect(h.outcomes.some(({ taskId }) => taskId === unrelated.id)).toBe(false);
    const log = readFileSync(h.outcomes.find(({ taskId }) => taskId === first.id)!.logPath, 'utf8');
    expect(log).toContain("Duplicate identifier 'loaded'");
    expect(log).toContain('Required root typecheck failed');
    expect(h.inbox.some(({ kind }) => kind === 'spec-conflict')).toBe(false);
  } finally {
    h.dispose();
  }
}, 120_000);

test('a repaired combined compiler candidate advances dev after one mandatory typecheck', async () => {
  const h = integrationHarness();
  try {
    setupCompilerFixture(h);
    const first = h.dispatch(sourceFile);
    const second = h.dispatch(sourceFile);
    setPlan(h, first, "import { source as loadedOne } from './source.js';\nexport const value = 1;\n");
    setPlan(h, second, "export const value = 1;\nimport { source as loadedTwo } from './source.js';\n");
    await h.start(first);
    await h.start(second);
    const base = h.head('dev');

    const commands = await compileTrain(h);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(`TYPECHECK_CHANGED=${sourceFile}`);
    expect(h.head('dev')).not.toBe(base);
    expect(h.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([
      [first.id, true],
      [second.id, true],
    ]);
  } finally {
    h.dispose();
  }
}, 120_000);

test('a single landing keeps the mandatory typecheck when optional landing checks are disabled', async () => {
  const h = integrationHarness();
  try {
    setupCompilerFixture(h);
    h.settings.integration.batchSize = 1;
    const task = h.dispatch(sourceFile);
    setPlan(h, task, 'export const value = 2;\n');
    await h.start(task);
    const base = h.head('dev');

    const commands = await compileTrain(h);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(`TYPECHECK_CHANGED=${sourceFile}`);
    expect(h.head('dev')).not.toBe(base);
    expect(h.outcomes).toMatchObject([{ taskId: task.id, passed: true }]);
  } finally {
    h.dispose();
  }
}, 120_000);

test('a dev ref move during typecheck discards the receipt and checks the rebased candidate', async () => {
  const h = integrationHarness();
  let movedDev = false;
  let typecheckRuns = 0;
  try {
    setupCompilerFixture(h);
    h.settings.integration.batchSize = 1;
    const task = h.dispatch(sourceFile);
    setPlan(h, task, 'export const value = 2;\n');
    await h.start(task);
    const base = h.head('dev');
    const run = processGroupRunner(120_000);

    await h.train(async (command, cwd, logPath) => {
      if (!command.some((part) => part.includes('scripts/typecheck.ts')))
        return { passed: false, output: `Unexpected preintegration check: ${command.join(' ')}`, timedOut: false };
      typecheckRuns++;
      installFixtureBun(cwd);
      const result = await run(command, cwd, logPath);
      if (!movedDev) {
        movedDev = true;
        h.advanceDev('apps/widget/src/concurrent.ts', 'export const concurrent = true;\n');
      }
      return result;
    });

    expect(typecheckRuns).toBe(2);
    expect(h.head('dev')).not.toBe(base);
    expect(git(h.root, 'show', 'dev:apps/widget/src/concurrent.ts')).toContain('concurrent');
    expect(h.outcomes).toMatchObject([{ taskId: task.id, passed: true }]);
  } finally {
    h.dispose();
  }
}, 120_000);

test('a candidate mutated after typecheck cannot advance dev', async () => {
  const h = integrationHarness();
  try {
    setupCompilerFixture(h);
    h.settings.integration.batchSize = 1;
    const task = h.dispatch(sourceFile);
    setPlan(h, task, 'export const value = 2;\n');
    await h.start(task);
    const base = h.head('dev');
    const run = processGroupRunner(120_000);

    await h.train(async (command, cwd, logPath) => {
      if (!command.some((part) => part.includes('scripts/typecheck.ts')))
        return { passed: false, output: `Unexpected preintegration check: ${command.join(' ')}`, timedOut: false };
      installFixtureBun(cwd);
      const result = await run(command, cwd, logPath);
      writeFileSync(join(cwd, sourceFile), 'export const value = 3;\n');
      return result;
    });

    expect(h.head('dev')).toBe(base);
    expect(h.outcomes).toMatchObject([{ taskId: task.id, passed: false }]);
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('Candidate integrity violation');
  } finally {
    h.dispose();
  }
}, 120_000);

test('a shared-workspace landing uses the same mandatory root typecheck guard', async () => {
  const h = integrationHarness();
  try {
    setupCompilerFixture(h);
    h.settings.sharedWebModules = { widget: ['apps/widget/src/**'] };
    const task = h.dispatch(sourceFile);
    expect(task.workspace?.module).toBe('widget');
    setPlan(h, task, 'export const value = 2;\n');
    await h.start(task);
    git(task.worktree, 'commit', '--amend', '-m', 'Complete fixture', '-m', `Goal-Task: ${task.id}`);
    const base = h.head('dev');

    const commands = await compileTrain(h);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(`TYPECHECK_CHANGED=${sourceFile}`);
    expect(h.head('dev')).not.toBe(base);
    expect(h.outcomes).toMatchObject([{ taskId: task.id, passed: true }]);
  } finally {
    h.dispose();
  }
}, 120_000);

test('23 ready landings advance while the independent verifier waits on an affected kernel check', async () => {
  const h = integrationHarness();
  let releaseRemote!: () => void;
  let announceRemote!: () => void;
  const remote = new Promise<void>((resolve) => (releaseRemote = resolve));
  const remoteStarted = new Promise<void>((resolve) => (announceRemote = resolve));
  let verifier: Promise<void> | undefined;
  try {
    setupCompilerFixture(h);
    const verifiedBase = h.head('dev');
    git(h.root, 'branch', 'dev-verified', verifiedBase);
    h.advanceDev('apps/widget/src/initial.ts', 'export const initial = true;\n');
    h.settings.integration.batchSize = 23;
    h.settings.verifierChecks = [
      {
        paths: ['apps/widget/**'],
        command: ['bun', 'run', '--cwd', 'services/kernel', 'check'],
      },
    ];
    verifier = verifyDev({
      settings: h.settings,
      store: h.store,
      inbox: { deliver() {} },
      runGate: async (command) => {
        if (command.includes('services/kernel')) {
          announceRemote();
          await remote;
        }
        return { passed: true, output: '', timedOut: false };
      },
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        remoteStarted,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('verifier did not reach the held kernel check')), 10_000);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    const tasks = Array.from({ length: 23 }, (_, index) => {
      const file = `apps/widget/src/ready-${index}.ts`;
      const task = h.dispatch(file);
      setPlan(h, task, `export const ready${index} = ${index};\n`, file);
      return task;
    });
    await Promise.all(tasks.map((task) => h.start(task)));
    const commands = await compileTrain(h);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('scripts/typecheck.ts');
    expect(h.outcomes.filter(({ passed }) => passed)).toHaveLength(23);
    expect(tasks.every((task) => h.store.task(task.id).state === 'integrated')).toBe(true);
    expect(h.head('dev')).not.toBe(h.head('dev-verified'));
  } finally {
    releaseRemote();
    await verifier;
    h.dispose();
  }
}, 120_000);

test('changed workspace selection includes dependents and global inputs while excluding unrelated workspaces', async () => {
  const root = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(root, { recursive: true });
  const fixture = mkdtempSync(join(root, 'typecheck-closure-'));
  const previous = process.env.TYPECHECK_CHANGED;
  try {
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ packageManager: `bun@${Bun.version}` }));
    mkdirSync(join(fixture, 'node_modules/.bin'), { recursive: true });
    symlinkSync(process.execPath, join(fixture, 'node_modules/.bin/bun'));
    writeSelectionWorkspace(fixture, 'packages/base', '@fixture/base');
    writeSelectionWorkspace(fixture, 'apps/consumer', '@fixture/consumer', {
      '@fixture/base': 'workspace:*',
    });
    writeSelectionWorkspace(fixture, 'apps/unrelated', '@fixture/unrelated');
    let output = '';
    process.env.TYPECHECK_CHANGED = 'packages/base/src/base.ts';
    expect(await typecheck({ root: fixture, stdout: { write: (chunk) => (output += chunk) } })).toBe(0);
    expect(readFileSync(join(fixture, 'packages/base/ran'), 'utf8')).toBe('@fixture/base');
    expect(readFileSync(join(fixture, 'apps/consumer/ran'), 'utf8')).toBe('@fixture/consumer');
    expect(() => readFileSync(join(fixture, 'apps/unrelated/ran'), 'utf8')).toThrow();
    expect(output).not.toContain('@fixture/unrelated');

    for (const workspace of ['packages/base', 'apps/consumer', 'apps/unrelated'])
      rmSync(join(fixture, workspace, 'ran'), { force: true });
    process.env.TYPECHECK_CHANGED = 'scripts/typecheck.ts';
    expect(await typecheck({ root: fixture, stdout: { write: (chunk) => (output += chunk) } })).toBe(0);
    for (const workspace of ['packages/base', 'apps/consumer', 'apps/unrelated'])
      expect(readFileSync(join(fixture, workspace, 'ran'), 'utf8')).not.toBe('');
  } finally {
    if (previous === undefined) delete process.env.TYPECHECK_CHANGED;
    else process.env.TYPECHECK_CHANGED = previous;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('postintegration verifier selects explicit affected, sibling and task acceptance checks', async () => {
  const h = integrationHarness();
  try {
    setupCompilerFixture(h);
    const base = h.head('dev');
    h.ensureDev();
    const candidateTree = join(h.settings.stateDirectory, 'verifier-candidate');
    mkdirSync(h.settings.stateDirectory, { recursive: true });
    git(h.root, 'branch', 'dev-verified', base);
    git(h.root, 'worktree', 'add', '--detach', candidateTree, base);
    let landing: string;
    try {
      mkdirSync(join(candidateTree, 'apps/widget/src'), { recursive: true });
      writeFileSync(join(candidateTree, sourceFile), 'export const value = 2;\n');
      writeFileSync(join(candidateTree, 'apps/widget/src/value.test.ts'), 'export const testFixture = true;\n');
      git(candidateTree, 'add', '--', sourceFile, 'apps/widget/src/value.test.ts');
      git(candidateTree, 'commit', '-m', 'Land verifier fixture');
      landing = git(candidateTree, 'rev-parse', 'HEAD');
      git(h.root, 'update-ref', 'refs/heads/dev', landing, base);
    } finally {
      git(h.root, 'worktree', 'remove', '--force', candidateTree);
    }
    const task = h.tasks.dispatch(h.briefFile);
    h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
      current.state = 'integrated';
      current.integratedBase = base;
      current.integratedCommit = landing;
      current.integratedCommits = [landing];
      current.brief.paths = ['apps/widget/**'];
      current.brief.acceptance.command = ['acceptance-check'];
    });
    h.settings.verifierChecks = [{ paths: ['apps/widget/**'], command: ['affected-widget'] }];
    h.settings.affectedTests = [{ paths: ['apps/**'], command: ['legacy-affected'] }];
    h.settings.siblingTests = { command: ['bun', 'test'] };

    const commands: string[][] = [];
    await verifyDev({
      settings: h.settings,
      store: h.store,
      inbox: { deliver() {} },
      runGate: async (command) => {
        commands.push([...command]);
        return { passed: true, output: '', timedOut: false };
      },
    });

    expect(
      commands.some(
        (command) =>
          command[0] === 'env' &&
          command.some((part) => part.startsWith('TYPECHECK_CHANGED=') && part.includes(sourceFile)),
      ),
    ).toBe(true);
    expect(commands).toContainEqual(['affected-widget']);
    expect(commands).toContainEqual(['bun', 'test', 'apps/widget/src/value.test.ts']);
    expect(commands).toContainEqual(['acceptance-check']);
    expect(commands).not.toContainEqual(['legacy-affected']);
    expect(h.head('dev-verified')).toBe(landing);
  } finally {
    h.dispose();
  }
}, 120_000);

test('forced root compiler shutdown removes only its labeled database before returning', async () => {
  const tempRoot = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(tempRoot, { recursive: true });
  const directory = mkdtempSync(join(tempRoot, 'compiler-cleanup-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin, { recursive: true });
  const dockerLog = join(directory, 'docker.log');
  const runner = join(bin, 'docker');
  const previousPath = process.env.PATH;
  const previousLog = process.env.REZICS_TEST_DOCKER_LOG;
  try {
    writeFileSync(
      runner,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$REZICS_TEST_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  count=0
  [ -f "$REZICS_TEST_DOCKER_LOG.count" ] && count=$(cat "$REZICS_TEST_DOCKER_LOG.count")
  count=$((count + 1))
  printf '%s' "$count" > "$REZICS_TEST_DOCKER_LOG.count"
  if [ "$count" -eq 1 ]; then printf 'owned-compiler-db\\n'; fi
fi
`,
    );
    chmodSync(runner, 0o755);
    process.env.PATH = `${bin}:${previousPath ?? '/usr/bin:/bin'}`;
    process.env.REZICS_TEST_DOCKER_LOG = dockerLog;
    const pidFile = join(directory, 'pid');
    const result = await processGroupRunner(50, undefined, process.env, false)(
      [
        'sh',
        '-c',
        `echo $$ > ${JSON.stringify(pidFile)}; echo "Compiler database owner PID=$$"; trap '' TERM; while :; do sleep 1; done`,
        'bun',
        'scripts/typecheck.ts',
      ],
      directory,
      join(directory, 'compiler.log'),
    );
    const pid = readFileSync(pidFile, 'utf8').trim();
    const dockerCalls = readFileSync(dockerLog, 'utf8').trim().split('\n');
    expect(result.timedOut).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.output).not.toContain('Compiler database cleanup could not be proven');
    expect(dockerCalls).toEqual([
      `ps -aq --filter label=rezics.compiler.pid=${pid}`,
      'rm -f -v owned-compiler-db',
      `ps -aq --filter label=rezics.compiler.pid=${pid}`,
    ]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.REZICS_TEST_DOCKER_LOG;
    else process.env.REZICS_TEST_DOCKER_LOG = previousLog;
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
