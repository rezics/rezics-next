import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devDependencies, packageManager } from '../../../package.json';
import { runChecksAtHead } from './dev-verifier-comparison.ts';
import { verifyDev } from './dev-verifier.ts';
import { git, processGroupRunner } from './merge.ts';
import { readControlPolicy } from './policy.ts';
import { integrationHarness } from './test-support.ts';

const pass = { passed: true, output: '', timedOut: false };

test('a source-only batch publishes all members through one dev ref update without running their gates', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.batchSize = 2;
    const base = h.head();
    const updates = git(h.root, 'reflog', 'show', '--format=%H', 'dev').split('\n');
    const first = h.dispatch('atomic-first.ts', [], ['accept-first']);
    const second = h.dispatch('atomic-second.ts', [], ['accept-second']);
    await h.start(first);
    await h.start(second);
    const commands: string[][] = [];

    await h.train(async (command) => {
      commands.push([...command]);
      return { passed: false, output: 'unexpected prelanding acceptance', timedOut: false };
    });

    const landed = h.head();
    expect(commands).toEqual([]);
    expect(landed).not.toBe(base);
    expect(git(h.root, 'reflog', 'show', '--format=%H', 'dev').split('\n')).toEqual([landed, ...updates]);
    expect(h.outcomes).toMatchObject([
      { taskId: first.id, passed: true, mergedCommit: landed },
      { taskId: second.id, passed: true, mergedCommit: landed },
    ]);
    for (const file of ['atomic-first.ts', 'atomic-second.ts'])
      expect(git(h.root, 'show', `dev:${file}`)).toBe('export const fixture = true;');
  } finally {
    h.dispose();
  }
});

function pinFixtureBun(root: string): void {
  const { lockfileVersion, configVersion, packages } = Bun.JSON5.parse(
    readFileSync(join(import.meta.dir, '../../../bun.lock'), 'utf8'),
  ) as { lockfileVersion: number; configVersion?: number; packages: Record<string, unknown> };
  const bun = devDependencies.bun;
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager, devDependencies: { bun } }));
  writeFileSync(
    join(root, 'bun.lock'),
    JSON.stringify({
      lockfileVersion,
      configVersion,
      workspaces: { '': { devDependencies: { bun } } },
      packages: Object.fromEntries(
        Object.entries(packages).filter(([name]) => name === 'bun' || name.startsWith('@oven/bun-')),
      ),
    }),
  );
  git(root, 'add', '--', 'package.json', 'bun.lock');
  git(root, 'commit', '-m', 'Pin the verifier fixture Bun artifact');
}

test('the independent verifier checks the captured dev batch concurrently and attributes a failing member', async () => {
  const h = integrationHarness();
  try {
    pinFixtureBun(h.root);
    h.ensureDev();
    h.settings.integration.batchSize = 4;
    h.settings.policy = readControlPolicy({ verifier: { concurrency: 2, checkAttempts: 1, roundIntervalMs: 1 } });
    h.settings.verifierChecks = [];
    // The initial full round establishes the base for focused task acceptance.
    await verifyDev({ settings: h.settings, store: h.store, runGate: async () => pass });
    const files = ['first.test.ts', 'second.test.ts', 'third.test.ts', 'fourth.test.ts'];
    const members = files.map((file) => h.dispatch(file, [], ['bun', 'test', file]));
    const failingFile = files[1]!;
    for (const [index, member] of members.entries()) {
      const file = files[index]!;
      const expected = file === failingFile ? 'broken member' : 'passing member';
      const content = `import { expect, test } from 'bun:test';
test('member acceptance', () => expect('passing member').toBe(${JSON.stringify(expected)}));
`;
      writeFileSync(join(member.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content }));
      await h.start(member);
    }
    await h.train(async () => pass);

    const captured = h.head();
    const run = processGroupRunner(10_000, h.settings.stateDirectory);
    const started: { file: string; head: string; files: string[] }[] = [];
    let running = 0;
    let peak = 0;
    await verifyDev({
      settings: h.settings,
      store: h.store,
      async runGate(command, cwd, logPath, options) {
        if (!command.includes('test')) return pass;
        const file = command.at(-1)!;
        started.push({
          file,
          head: git(cwd, 'rev-parse', 'HEAD'),
          files: files.filter((path) => existsSync(join(cwd, path))),
        });
        running++;
        peak = Math.max(running, peak);
        try {
          return await run(command, cwd, logPath, options);
        } finally {
          running--;
        }
      },
    });

    expect(peak).toBe(2);
    expect(started.map(({ file }) => file).sort()).toEqual([...files].sort());
    expect(started.every((run) => run.head === captured)).toBe(true);
    for (const run of started) expect(run.files).toEqual(files);
    expect(h.store.devVerifierLatestRound()?.round).toMatchObject({
      headCommit: captured,
      fullSuite: false,
      passed: 4,
      failed: 1,
      unknown: 0,
    });
    expect(h.store.devVerifierFindings()).toMatchObject([
      {
        headCommit: captured,
        test: failingFile,
        head: { commit: captured, output: expect.stringContaining('Expected: "broken member"') },
        status: 'new',
        taskId: members[1]!.id,
        result: 'fail',
      },
    ]);
    expect(h.head()).toBe(captured);
    for (const { id } of members) expect(h.store.task(id).state).toBe('integrated');
  } finally {
    h.dispose();
  }
}, 30_000);

test('the verifier reuses passing batch evidence only for the same captured commit and check selection', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const checks = ['first', 'second'].map((file) => ({ command: ['fixture-acceptance', file], closure: [file] }));
    const calls: [string, string][] = [];
    const options = {
      settings: h.settings,
      store: h.store,
      async runGate(command: readonly string[], cwd: string) {
        calls.push([command[1]!, git(cwd, 'rev-parse', 'HEAD')]);
        return pass;
      },
    };
    const run = (selection = checks) =>
      runChecksAtHead(options, selection, h.head('main'), h.root, Date.now() + 10_000, new AbortController().signal);
    const original = h.head('main');
    const tree = h.head('HEAD^{tree}');
    const initial = await run();
    const repeated = await run();
    expect(calls).toEqual([
      ['first', original],
      ['second', original],
    ]);
    expect(repeated.results.map(({ evidence }) => evidence.commandRunIds)).toEqual(
      initial.results.map(({ evidence }) => evidence.commandRunIds),
    );
    await run(checks.slice(0, 1));
    expect(calls.slice(2)).toEqual([['first', original]]);

    git(h.root, 'commit', '--allow-empty', '-m', 'Advance candidate without changing its tree');
    const advanced = h.head('main');
    expect(advanced).not.toBe(original);
    expect(h.head('HEAD^{tree}')).toBe(tree);
    const fresh = await run();
    expect(calls.slice(3)).toEqual([
      ['first', advanced],
      ['second', advanced],
    ]);
    for (const { evidence } of fresh.results) expect(evidence).toMatchObject({ commit: advanced, result: 'pass' });
  } finally {
    h.dispose();
  }
});
