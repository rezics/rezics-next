import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './merge.ts';
import { promote } from './promotion.ts';
import { integrationHarness } from './test-support.ts';

const failure = { passed: false, output: 'AssertionError: incompatible fixture', timedOut: false };
const success = { passed: true, output: '', timedOut: false };

function createStabilize(h: ReturnType<typeof integrationHarness>, commit = h.head()): void {
  git(h.root, 'branch', 'stabilize', commit);
}

test('stabilize finishes its current gate, then gates the next green dev candidate', async () => {
  const h = integrationHarness();
  try {
    const stable = await h.seed('stable');
    const candidate = h.head();
    createStabilize(h, candidate);
    const later = await h.seed('later');
    const dev = h.head();
    const gated: string[] = [];

    await h.promote(async (command, cwd) => {
      if (command[0] === 'true') gated.push(git(cwd, 'rev-parse', 'HEAD'));
      return success;
    });

    expect(gated).toContain(candidate);
    expect(gated).toContain(dev);
    expect(h.head('main')).toBe(dev);
    expect(h.head('stabilize')).toBe(dev);
    expect(h.store.task(stable.id).state).toBe('merged');
    expect(h.store.task(later.id).state).toBe('merged');
  } finally {
    h.dispose();
  }
});

test('a failing stabilize gate blocks that candidate without bisecting or reverting and notifies once', async () => {
  const h = integrationHarness();
  try {
    await h.seed('stable');
    await h.seed('bad');
    const candidate = h.head();
    createStabilize(h, candidate);
    await h.seed('later');
    let gates = 0;

    const runGate = async (_command: readonly string[], _cwd: string, log: string) => {
      gates++;
      const output =
        'Workspace @fixture/kernel finished in 1.00s\n' +
        '$ bun run check  (services/kernel)\n' +
        'AssertionError: incompatible fixture\n' +
        'error: Kernel tests failed for 1 file(s):\n' +
        'test/bad.test.ts\n\nFailed workspaces: services/kernel\n';
      appendFileSync(log, output);
      return { ...failure, output };
    };
    await h.promote(runGate);
    const run = h.store.promotion()!;
    expect(run.phase).toBe('stabilize-blocked');
    expect(gates).toBe(1);
    expect(h.inbox).toHaveLength(1);
    expect(h.inbox[0]?.managerId).toBe(h.settings.integration.supermanager);
    expect(h.inbox[0]?.summary).toContain('services/kernel');
    expect(h.inbox[0]?.summary).toContain('test/bad.test.ts');
    expect(h.inbox[0]?.summary).toContain(`${h.settings.stateDirectory}/promotion-${run.id}-head-0.log`);
    expect(h.head('main')).not.toBe(candidate);
    expect(h.head('stabilize')).toBe(candidate);
  } finally {
    h.dispose();
  }
});

test('a blocked stabilize candidate waits until its head moves, then gates the new head', async () => {
  const h = integrationHarness();
  try {
    await h.seed('stable');
    const candidate = h.head();
    createStabilize(h, candidate);
    let gates = 0;
    const runGate = async () => {
      gates++;
      return gates === 1 ? failure : success;
    };

    await h.promote(runGate);
    await h.promote(runGate);
    expect(gates).toBe(1);

    const moved = h.advanceDev('later');
    git(h.root, 'update-ref', 'refs/heads/stabilize', moved, candidate);
    await h.promote(runGate);
    expect(gates).toBe(2);
  } finally {
    h.dispose();
  }
});

function commitOn(
  h: ReturnType<typeof integrationHarness>,
  branch: string,
  from: string,
  files: Record<string, string>,
): string {
  const tree = join(h.root, '..', `commit-${branch}-${Date.now()}`);
  git(h.root, 'worktree', 'add', '--detach', tree, from);
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(tree, path)), { recursive: true });
      writeFileSync(join(tree, path), content);
    }
    git(tree, 'add', '.');
    git(tree, 'commit', '-m', `Change on ${branch}`);
    const commit = git(tree, 'rev-parse', 'HEAD');
    git(h.root, 'update-ref', `refs/heads/${branch}`, commit);
    return commit;
  } finally {
    git(h.root, 'worktree', 'remove', '--force', tree);
  }
}

test('a stabilize publish that does not merge into dev leaves the branch and notifies', async () => {
  const h = integrationHarness();
  try {
    await h.seed('stable');
    const candidate = h.head();
    createStabilize(h, candidate);
    commitOn(h, 'dev', h.head('main'), { stable: 'dev side\n' });

    await h.promote(async () => success);

    expect(h.head('main')).toBe(candidate);
    expect(h.head('stabilize')).toBe(candidate);
    expect(h.inbox).toHaveLength(1);
    expect(h.inbox[0]?.managerId).toBe(h.settings.integration.supermanager);
    expect(h.inbox[0]?.summary).toContain('does not merge into dev');
  } finally {
    h.dispose();
  }
});

test('a stabilize publish merges main into dev, keeping dev for derived files, and then advances', async () => {
  const h = integrationHarness();
  try {
    const declaration = 'packages/client/src/kernel/fixture.d.ts';
    const base = commitOn(h, 'main', h.head('main'), {
      [declaration]: 'base\n',
      'services/kernel/package.json': JSON.stringify({ private: true, scripts: { derived: 'true' } }),
    });
    git(h.root, 'reset', '-q', '--hard', base);
    commitOn(h, 'stabilize', base, { [declaration]: 'stabilize side\n', fix: 'fix\n' });
    const dev = commitOn(h, 'dev', base, { [declaration]: 'dev side\n', feature: 'feature\n' });

    await h.promote(async () => success);

    const main = h.head('main');
    expect(git(h.root, 'merge-base', '--is-ancestor', main, 'dev')).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', dev, 'dev')).toBe('');
    expect(git(h.root, 'show', `dev:${declaration}`)).toBe('dev side');
    expect(git(h.root, 'show', 'dev:fix')).toBe('fix');
    expect(h.head('stabilize')).toBe(h.head('dev'));
    expect(h.inbox).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

test('promotion without a stabilize branch does not cut from a dev commit that fails its quick gate', async () => {
  const h = integrationHarness();
  try {
    const first = await h.seed('first');
    const bad = await h.seed('bad');
    const dev = h.head();
    await h.seed('last');

    await promote({
      settings: h.settings,
      job: h.job,
      runGate: async (_command, cwd) => (existsSync(join(cwd, 'bad')) ? failure : success),
    });
    await h.job.drain();

    expect(h.store.task(first.id).state).toBe('integrated');
    expect(h.store.task(bad.id).currentAttempt).toBe(1);
    expect(h.head('main')).not.toBe(dev);
    expect(git(h.root, 'branch', '--list', 'stabilize')).toBe('');
  } finally {
    h.dispose();
  }
});

function contains(h: ReturnType<typeof integrationHarness>, ancestor: string, descendant: string): boolean {
  try {
    git(h.root, 'merge-base', '--is-ancestor', ancestor, descendant);
    return true;
  } catch {
    return false;
  }
}

/** Commit on main in the main checkout while the gate runs, as a control-plane hotfix does. */
function commitOnMain(h: ReturnType<typeof integrationHarness>, path: string): string {
  mkdirSync(dirname(join(h.root, path)), { recursive: true });
  writeFileSync(join(h.root, path), 'export {};\n');
  git(h.root, 'add', path);
  git(h.root, 'commit', '-m', `Change ${path} on main`);
  return h.head('main');
}

test('a snapshot gated while main took control-plane commits is published merged with them', async () => {
  const h = integrationHarness();
  try {
    const stable = await h.seed('stable');
    const candidate = h.head();
    createStabilize(h, candidate);
    let hotfix = '';
    await h.promote(async () => {
      hotfix ||= commitOnMain(h, 'tools/goal/src/hotfix.ts');
      return success;
    });

    const main = h.head('main');
    expect(contains(h, candidate, main)).toBe(true);
    expect(contains(h, hotfix, main)).toBe(true);
    expect(contains(h, main, h.head('stabilize'))).toBe(true);
    expect(h.store.task(stable.id).state).toBe('merged');
    expect(h.store.promotion()).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('a snapshot gated while main took any other commit is dropped for a fresh gate', async () => {
  const h = integrationHarness();
  try {
    const stable = await h.seed('stable');
    const candidate = h.head();
    createStabilize(h, candidate);
    let other = '';
    await h.promote(async () => {
      other ||= commitOnMain(h, 'services/kernel/src/other.ts');
      return success;
    });

    expect(contains(h, candidate, h.head('main'))).toBe(false);
    expect(h.head('main')).toBe(other);
    expect(h.store.task(stable.id).state).toBe('integrated');
  } finally {
    h.dispose();
  }
});
