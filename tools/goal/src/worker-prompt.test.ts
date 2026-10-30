import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerPrompt } from './launch.ts';
import type { Task } from './types.ts';

test('the worker prompt names the main checkout as read-only and asks for paths inside the worktree', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    mainCheckout: '/repo/main',
    brief: { markdown: 'Do the thing.', acceptance: { command: ['bun', 'test'], tests: ['x'] } },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('/repo/main is read-only');
  expect(prompt).toContain('Write files only by paths inside /work/trees/t1');
});

test('the worker prompt says failures outside the declared paths are reported, not blocking', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    mainCheckout: '/repo/main',
    brief: {
      markdown: 'Do the thing.',
      paths: ['src/a.ts'],
      acceptance: { command: ['bun', 'test', 'a.test.ts'], tests: ['x'] },
    },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('A failure that also occurs on your base commit is not your blocker');
  expect(prompt).toContain('A test that passes on your base and fails after your change is yours');
});

test('an implementation worker is told the applicable AGENTS.md is already loaded and to keep recursive searches in scope', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    brief: {
      markdown: 'Do the thing.',
      kind: 'implementation',
      paths: ['src/a.ts'],
      acceptance: { command: ['bun', 'test'], tests: ['x'] },
    },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('The AGENTS.md that applies is already in your instructions; follow it.');
  expect(prompt).not.toContain('Read and follow its AGENTS.md');
  expect(prompt).toContain(
    "Keep recursive searches and listings (find, grep -r, rg, du, ls -R and the like) inside the worktree or a directory this prompt names (the reference directory or a retry evidence directory); never run them on the worktree's parent, the main checkout's root or .temp, or the home directory, which hold every other task's worktree; read files outside the worktree by exact path.",
  );
});

test('a research worker is told the applicable AGENTS.md is already loaded and to keep recursive searches in scope', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    brief: {
      markdown: 'Do the thing.',
      kind: 'research',
      paths: ['docs/research/x.md'],
      acceptance: { command: ['test', '-s', 'docs/research/x.md'], tests: ['x'] },
    },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('The AGENTS.md that applies is already in your instructions; follow it.');
  expect(prompt).not.toContain('Read and follow its AGENTS.md');
  expect(prompt).toContain(
    "Keep recursive searches and listings (find, grep -r, rg, du, ls -R and the like) inside the worktree or a directory this prompt names (the reference directory or a retry evidence directory); never run them on the worktree's parent, the main checkout's root or .temp, or the home directory, which hold every other task's worktree; read files outside the worktree by exact path.",
  );
});

test('the worker prompt forbids touching resources the attempt did not start', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    mainCheckout: '/repo/main',
    brief: {
      markdown: 'Do the thing.',
      paths: ['src/a.ts'],
      acceptance: { command: ['bun', 'test', 'a.test.ts'], tests: ['x'] },
    },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('Never stop or remove containers, databases or processes you did not start in this attempt');
  // A diagnosis patched a hardlinked reylo file in place and every worktree and check host printed its trace.
  expect(prompt).toContain('Never write under node_modules');
  // Promotion gates and repeated full worker checks left a 13-slot fleet with a 1.9-hour p95 slot wait (2026-10-28).
  expect(prompt).toContain('Check slots are the scarce shared resource');
  expect(prompt).toContain('run your acceptance command once after your last relevant edit');
  expect(prompt).toContain('This base has no scripts/worker-check.ts; do not add one.');
  expect(prompt).toContain('Run the acceptance command in the foreground from the worktree root and let it finish');
  expect(prompt).not.toContain('bun scripts/worker-check.ts -- <command...>');
  expect(prompt).toContain('Do not run the root typecheck, affected checks or other regression checks yourself');
  expect(prompt).toContain(
    'The landing batch runs the root typecheck, affected checks for every changed path, and matching sibling tests',
  );
  expect(prompt).toContain('a regression found there comes back as a retry with the failing log');
  expect(prompt).not.toMatch(/plus the root typecheck|run the tests that cover every file/i);
});

test('every worker can ask for research, and a research worker is told how to do it', () => {
  const brief = (kind: string) => ({
    markdown: 'Do the thing.',
    kind,
    paths: ['docs/research/x.md'],
    acceptance: { command: ['test', '-s', 'docs/research/x.md'], tests: ['x'] },
  });
  const task = (kind: string) =>
    ({ worktree: '/work/trees/t1', branch: 'worker/t1', brief: brief(kind) }) as unknown as Task;
  const implementation = workerPrompt(task('implementation'), undefined, undefined, [], '/repo/main');
  expect(implementation).toContain('Research needed:');
  expect(implementation).not.toContain('This is a research task');
  const research = workerPrompt(task('research'), undefined, undefined, [], '/repo/main');
  expect(research).toContain('This is a research task');
  expect(research).toContain('.reference/<topic>/<project>/');
  expect(research).toContain('never install, build or run anything from them');
  expect(research).toContain('except the reference clones this research task keeps under /repo/main/.reference/');
  expect(implementation).not.toContain('except the reference clones');
});

test('a worker starts only below the worker cap and above the memory floor', async () => {
  const { hasCapacity } = await import('./launch.ts');
  const capacity = { maxWorkers: 32, minAvailableMiB: 6144 };
  expect(hasCapacity(31, 8000, capacity)).toBe(true);
  expect(hasCapacity(32, 8000, capacity)).toBe(false);
  expect(hasCapacity(10, 4000, capacity)).toBe(false);
});

test('a worker writes acceptance tests the contract names and waits for queued checks', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    brief: {
      markdown: 'Do the thing.',
      kind: 'implementation',
      acceptance: { command: ['bun', 'test'], tests: ['x'] },
    },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('Write every acceptance test the contract names that does not exist yet');
  expect(prompt).toContain('never weaken or edit an existing acceptance test');
  expect(prompt).toContain('queued, not stuck');
});

test('a resumed prompt supersedes a saved legacy check wait and states the bare UUID handoff', async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const worktree = mkdtempSync(join(tmpdir(), 'goal-current-check-protocol-'));
  try {
    mkdirSync(join(worktree, 'scripts'), { recursive: true });
    writeFileSync(join(worktree, 'scripts/worker-check.ts'), '');
    const task = {
      worktree,
      branch: 'worker/protocol',
      brief: { markdown: 'Do the thing.', kind: 'implementation' },
    } as unknown as Task;
    const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
    expect(prompt).toContain('bun scripts/worker-check.ts -- <command...>');
    expect(prompt).toContain('`{"status":"waiting","checks":["<bare UUID>"]}`');
    expect(prompt).toContain('bare UUID string printed by the wrapper');
    expect(prompt).toContain('"checks":["00000000-0000-4000-8000-000000000000"]');
    expect(prompt).toContain('superseded instruction to wait on that same check');
    expect(prompt).toContain('do not follow it or invoke `--wait`');
    expect(prompt).toContain('The controller waits for the terminal result');
    expect(prompt).toContain('use the supplied result records exactly');
    expect(prompt).toContain('Do not return another waiting result for those same check ids');
    expect(prompt).toContain('A terminal success result must use `"checks":[]`');
    expect(prompt).toContain('one automatic infrastructure rerun');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('local placement renders the concrete declared argv, overrides saved remote instructions, and keeps wrapper options quoted', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'goal-local-check-protocol-'));
  try {
    mkdirSync(join(worktree, 'scripts'), { recursive: true });
    writeFileSync(join(worktree, 'scripts/worker-check.ts'), '');
    const task = {
      worktree,
      branch: 'worker/local',
      brief: {
        markdown: 'Old session said `bun scripts/worker-check.ts -- <command...>` and `--wait`.',
        kind: 'implementation',
        acceptance: {
          command: ['bun', 'test', 'apps/web/tests/shell-menus.test.ts', '-t', "filter's phrase"],
          tests: ['local test'],
          failing: true,
          placement: 'local',
        },
      },
    } as unknown as Task;
    const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
    expect(prompt).toContain(
      "bun scripts/worker-check.ts --local -- 'bun' 'test' 'apps/web/tests/shell-menus.test.ts' '-t' 'filter'\\''s phrase'",
    );
    expect(prompt).toContain('overrides any older prompt, saved-session instruction, remote invocation, or `--wait` recipe');
    expect(prompt.indexOf('registered acceptance placement is local')).toBeGreaterThan(
      prompt.indexOf('The task contract follows:'),
    );
    const localPolicy = prompt.slice(prompt.lastIndexOf('The registered acceptance placement is local'));
    expect(localPolicy).not.toContain('bun scripts/worker-check.ts -- <command...>');
    expect(prompt).toContain('Do not report an old check as cancelled');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('local placement without a worktree wrapper uses the exact foreground command', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'goal-local-foreground-'));
  try {
    const command = ['bun', 'test', 'apps/web/tests/shell-menus.test.ts'];
    const task = {
      worktree,
      branch: 'worker/local',
      brief: {
        markdown: 'Use the current placement.',
        kind: 'implementation',
        acceptance: { command, tests: ['local test'], failing: true, placement: 'local' },
      },
    } as unknown as Task;
    const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
    expect(prompt).toContain("Run the exact declared pure local command `'bun' 'test' 'apps/web/tests/shell-menus.test.ts'`");
    expect(prompt).toContain('in the foreground from the worktree root');
    expect(prompt).toContain('does not create a detached check id or a waiting result');
    expect(prompt).not.toContain('bun scripts/worker-check.ts -- <command...>');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('a named absolute wrapper keeps the local route and safely quotes a path with spaces', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'goal-local-named-wrapper-'));
  try {
    const runner = join(worktree, 'dev tools/scripts/worker-check.ts');
    mkdirSync(join(worktree, 'dev tools/scripts'), { recursive: true });
    writeFileSync(runner, '');
    const command = ['bun', 'test', 'apps/web/tests/shell-menus.test.ts'];
    const task = {
      worktree,
      branch: 'worker/local',
      brief: {
        markdown: `Existing wrapper: bun ${JSON.stringify(runner)}\n`,
        kind: 'implementation',
        acceptance: { command, tests: ['local test'], failing: true, placement: 'local' },
      },
    } as unknown as Task;
    const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
    expect(prompt).toContain(`bun '${runner}' --local -- 'bun' 'test' 'apps/web/tests/shell-menus.test.ts'`);
    expect(prompt).not.toContain('bun scripts/worker-check.ts -- <command...>');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('a worker reports persistent tool and infrastructure failures as a tool blocker with the exact error', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    brief: {
      markdown: 'Do the thing.',
      kind: 'implementation',
      acceptance: { command: ['bun', 'test'], tests: ['x'] },
    },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain(
    'When a tool or infrastructure failure blocks the work (SSH or rsync to a check host, network, out of disk or memory, file watchers, a service that will not start), retry it at most twice, then finish with a `tool` blocker whose detail starts with the exact error line; do not work around it by weakening the check.',
  );
});

test('the retry prompt says a manifest failure is history and must be rerun before reporting it as a blocker', () => {
  const evidence = mkdtempSync(join(tmpdir(), 'goal-retry-prompt-'));
  try {
    writeFileSync(
      join(evidence, 'failure.json'),
      JSON.stringify({ manifest: 'First failing command: bun test broken.test.ts' }),
    );
    const task = {
      worktree: '/work/trees/t1',
      branch: 'worker/t1',
      brief: { markdown: 'Do the thing.', acceptance: { command: ['bun', 'test'], tests: ['x'] } },
    } as unknown as Task;
    const prompt = workerPrompt(task, evidence, undefined, [], '/repo/main');
    expect(prompt).toContain('The retry manifest records a failure from an earlier attempt');
    expect(prompt).toContain('Hosts and tools may have been fixed since then');
    expect(prompt).toContain('Rerun the failing command before reporting any blocker');
  } finally {
    rmSync(evidence, { recursive: true, force: true });
  }
});

test('stabilize and critical-path starts skip the worker cap but not the memory floor', async () => {
  const { startsFirst } = await import('./launch.ts');
  expect(startsFirst({ taskClass: 'claim', brief: { target: 'stabilize' } } as never)).toBe(true);
  expect(startsFirst({ taskClass: 'critical-path', brief: {} } as never)).toBe(true);
  expect(startsFirst({ taskClass: 'claim', brief: { criticalPath: true } } as never)).toBe(true);
  expect(startsFirst({ taskClass: 'implementation', brief: {} } as never)).toBe(false);
});

test('a capacity waiter counts only live, older tickets ahead of it and clears ended ones', async () => {
  const { waitersAhead } = await import('./launch.ts');
  const { mkdtempSync, writeFileSync: write, existsSync: exists } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const queue = mkdtempSync(joinPath(tmpdir(), 'capacity-queue-'));
  const live = `${'1'.padStart(15, '0')}-${process.pid}-a`;
  const ended = `${'2'.padStart(15, '0')}-2147483646-b`;
  const mine = `${'3'.padStart(15, '0')}-${process.pid}-c`;
  const newer = `${'4'.padStart(15, '0')}-${process.pid}-d`;
  for (const name of [live, ended, mine, newer]) write(joinPath(queue, name), '');
  expect(waitersAhead(queue, mine)).toBe(1);
  expect(exists(joinPath(queue, ended))).toBe(false);
  expect(waitersAhead(queue, live)).toBe(0);
});

test('a worker is told where reference projects are and to read the ones its contract names', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    brief: {
      markdown: 'Do the thing.',
      kind: 'implementation',
      acceptance: { command: ['bun', 'test'], tests: ['x'] },
    },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('/repo/main/.reference/');
  expect(prompt).toContain('read that source for the surface you build before you design it');
});
