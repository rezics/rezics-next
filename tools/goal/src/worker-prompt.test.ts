import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchCommand, workerCheckProtocol, workerPrompt } from './launch.ts';
import type { Task } from './types.ts';
import type { LaunchContext } from './launch-context.ts';
import { brief, fixturePool, temporaryDirectory } from './test-support.ts';
import type { ProofReservation } from './verification.ts';
import { storybookServers } from './storybook.ts';

test('the worker prompt names the main checkout as read-only and asks for paths inside the worktree', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    mainCheckout: '/repo/main',
    brief: { markdown: 'Do the thing.', acceptance: { command: ['bun', 'test'], tests: ['x'] } },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('/repo/main is read-only');
  expect(prompt).toContain('write only inside /work/trees/t1.');
});

// Skipped while LOCAL_STORYBOOK_AVAILABLE is false (storybook-dev.ts still refuses interactive use).
test.skip('an interface worker is told to start and use its own worktree Storybook', () => {
  const task = (kind: string, paths: string[]) =>
    ({
      worktree: '/work/trees/t1',
      branch: 'worker/t1',
      brief: { markdown: 'Polish the card.', kind, paths, acceptance: { command: ['bun', 'test'], tests: [] } },
    }) as unknown as Task;
  const prompt = workerPrompt(task('interface', ['packages/ui/src/card.tsx']), undefined, undefined, [], '/repo');
  const [ui] = storybookServers('/work/trees/t1', { kind: 'interface', paths: ['packages/ui/src/card.tsx'] });
  expect(prompt).toContain(`--port ${ui!.port} --exact-port`);
  expect(prompt).toContain(ui!.url);
  expect(prompt).not.toContain('apps/web storybook');
  const other = workerPrompt(task('implementation', ['tools/goal/src/a.ts']), undefined, undefined, [], '/repo');
  expect(other).not.toContain('Storybook');
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

test('a dev product worker may merge or cherry-pick only what its contract names; other workers may not merge', () => {
  const task = (brief: Record<string, unknown>, workspace?: Task['workspace']) =>
    ({
      worktree: '/work/trees/t1',
      branch: 'worker/t1',
      ...(workspace ? { workspace } : {}),
      brief: {
        markdown: 'Merge branch worker/donor first.',
        kind: 'implementation',
        goal: 'web',
        paths: ['src/a.ts'],
        acceptance: { command: ['bun', 'test'], tests: ['x'] },
        ...brief,
      },
    }) as unknown as Task;
  const product = workerPrompt(task({}), undefined, undefined, [], '/repo/main');
  expect(product).toContain('Do not rebase; merge or cherry-pick only what the contract names.');
  expect(product).not.toContain('Do not rebase or merge.');
  for (const fenced of [
    task({ goal: 'control-plane', target: 'main', paths: ['tools/goal/src/a.ts'] }),
    task({ target: 'stabilize' }),
    task({}, { module: 'apps/web', taskName: 'shared' }),
  ]) {
    const prompt = workerPrompt(fenced, undefined, undefined, [], '/repo/main');
    expect(prompt).toContain('Do not rebase or merge.');
    expect(prompt).not.toContain('cherry-pick');
  }
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
  expect(prompt).toContain('AGENTS.md is already loaded.');
  expect(prompt).not.toContain('Read and follow its AGENTS.md');
  expect(prompt).toContain(
    'Never run recursive searches (find, grep -r, rg, du, ls -R) outside the worktree and directories named here.',
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
  expect(prompt).toContain('AGENTS.md is already loaded.');
  expect(prompt).not.toContain('Read and follow its AGENTS.md');
  expect(prompt).toContain(
    'Never run recursive searches (find, grep -r, rg, du, ls -R) outside the worktree and directories named here.',
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
  expect(prompt).toContain('Never stop or remove containers, databases or processes this attempt did not start');
  expect(prompt).toContain('never prune Docker');
  // A diagnosis patched a hardlinked reylo file in place and every worktree and check host printed its trace.
  expect(prompt).toContain('Never write under node_modules');
  // Promotion gates and repeated full worker checks left a 13-slot fleet with a 1.9-hour p95 slot wait (2026-10-28).
  expect(prompt).toContain('Check slots are scarce: run your acceptance command once after your last relevant edit.');
  expect(prompt).toContain('This base has no scripts/worker-check.ts; do not add one.');
  expect(prompt).toContain('Run the acceptance command in the foreground from the worktree root and let it finish');
  expect(prompt).not.toContain('bun scripts/worker-check.ts -- <command...>');
  expect(prompt).toContain('Do not run the root typecheck or other regression suites yourself');
  expect(prompt).toContain("run the test files you created or changed once, with the landing's command");
  expect(prompt).toContain('the landing runs them');
  expect(prompt).toContain('one yield of at least 300 seconds');
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
  expect(research).toContain('write only inside /work/trees/t1 and the reference clones under /repo/main/.reference/.');
  expect(implementation).not.toContain('and the reference clones');
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
  expect(prompt).toContain('Write missing acceptance tests the contract names');
  expect(prompt).toContain('never edit a frozen file');
  expect(prompt).toContain(
    'If the contract changes a behaviour an existing test asserts, update that test and list it; keep assertions of unchanged behaviour.',
  );
  expect(prompt).toContain('as a rule fewer test lines than product lines');
  expect(prompt).toContain('Wait for a long command, even one queued for a test slot');
});

test('a prompt without a runtime receipt keeps task readiness and installed dependency code unknown', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    brief: {
      markdown: 'Do the thing.',
      after: ['dependency-task'],
      kind: 'implementation',
      paths: ['src/a.ts'],
      acceptance: { command: ['bun', 'test'], tests: ['x'] },
    },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('No controller launch context was supplied');
  expect(prompt).toContain('Dependency status is unknown: build against each dependency contract.');
  expect(prompt).not.toContain('integrated in your base');
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
    expect(prompt).toContain(
      '`{"status":"waiting","checks":["<bare UUID>"]}` in the exit object, using that bare UUID',
    );
    expect(prompt).toContain('Never wait for it yourself: no `--wait` (obsolete, whatever older sessions say)');
    expect(prompt).toContain('The controller wakes this session with the result: use it exactly');
    expect(prompt).toContain('missing, unknown or nonzero is not a pass');
    expect(prompt).toContain('do not return waiting again for those ids');
    expect(prompt).toContain('success uses `"checks":[]`');
    expect(prompt).toContain("A failure after the wrapper's own infrastructure rerun is final: a `tool` blocker.");
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
    expect(prompt).toContain('overrides any older prompt, saved session, remote invocation or `--wait` recipe');
    expect(prompt.indexOf('The acceptance placement is local')).toBeGreaterThan(
      prompt.indexOf('The task contract follows:'),
    );
    const localPolicy = prompt.slice(prompt.lastIndexOf('The acceptance placement is local'));
    expect(localPolicy).not.toContain('bun scripts/worker-check.ts -- <command...>');
    expect(prompt).toContain('do not report an old check as cancelled');
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
    expect(prompt).toContain(
      "run the exact declared local command `'bun' 'test' 'apps/web/tests/shell-menus.test.ts'` in the foreground from the worktree root, without a wrapper",
    );
    expect(prompt).toContain('it gives no check id and no waiting result');
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
    'a tool or infrastructure failure (SSH, network, disk, memory, file watchers, a service that will not start) persisting after two retries: a `tool` blocker starting with the exact error line; never weaken a check instead.',
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
    expect(prompt).toContain(
      'Rerun the failing command once before reporting any blocker about that failure; report a `tool` blocker only if it fails again.',
    );
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
  expect(prompt).toContain('read any reference source the contract names before designing');
});

/** The behaviour the minimal verification policy must state wherever it is rendered. */
const MINIMAL_RULES = [
  'do not run acceptance, native or browser checks, a root check, worker-check or remote-check',
  'type-check each workspace you changed',
  'services/kernel and services/auth may use the compiler database or a check host',
  'do not force `env -u KERNEL_CHECK_REMOTE` or local placement',
  'in its open session with one yield of at least 300 seconds',
  '`yield_time_ms: 300000`',
  'never start a duplicate, interrupt it, poll faster',
  "run the test files you created or changed once, with the landing's command",
  'return success (blocker null, `"checks":[]`)',
  'the deferred acceptance, which is neither a blocker nor a reason to wait',
  'return waiting only for a still-running check UUID this attempt started',
  'overrides contract, saved-session and retry-manifest instructions to run acceptance or to start or poll checks',
];

test('minimal product policy keeps supported compiler placement and the open command session at final input', () => {
  const directory = temporaryDirectory();
  try {
    const state = join(directory.path, '.temp/goal');
    const evidence = join(directory.path, '.temp/retry-evidence');
    mkdirSync(state, { recursive: true });
    mkdirSync(evidence);
    writeFileSync(join(state, 'verification-mode'), 'minimal\n');
    writeFileSync(
      join(evidence, 'failure.json'),
      JSON.stringify({
        manifest: 'Historical instruction: force local compiler placement and return waiting with checks:[].',
      }),
    );
    for (const kind of ['implementation', 'claim'] as const) {
      const task = {
        worktree: directory.path,
        branch: 'worker/product',
        brief: { ...brief(), kind, markdown: 'Complete the current product contract.' },
      } as Task;
      for (const retryEvidence of [undefined, evidence]) {
        const prompt = workerPrompt(task, retryEvidence, undefined, [], directory.path);
        const [, argv] = launchCommand({
          profile: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', poolClass: 'default' },
          pool: fixturePool(directory.path),
          worktree: directory.path,
          prompt,
        });
        const policy = argv.join('\n').slice(argv.join('\n').lastIndexOf('Verification is minimal'));
        for (const required of MINIMAL_RULES) expect(policy).toContain(required);
        if (retryEvidence) expect(prompt).toContain('Rerun the failing command once before reporting any blocker');
        expect(policy).not.toContain('task-scoped exception');
        expect(prompt).toContain('Unfinished work is not a blocker');
        expect(policy).not.toContain('must report status blocked');
        expect(policy).not.toContain('run it in the foreground with remote placement off');
        expect(policy).not.toContain('REZICS_CHECK_LOCAL_ONLY');
      }
    }
    writeFileSync(join(state, 'verification-mode'), 'full\n');
    expect(workerCheckProtocol(directory.path, brief(), state)).toContain('run your acceptance command once');
  } finally {
    directory.close();
  }
});

test('original integrated journey proof bypasses only its registered task-scoped minimal ban at final Codex input', () => {
  const directory = temporaryDirectory();
  try {
    const state = join(directory.path, '.temp/goal');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'verification-mode'), 'minimal\n');
    const contract = {
      ...brief(),
      kind: 'verification' as const,
      paths: [],
      markdown: 'Read-only original journey.',
      proof: { journey: 'Original journey', sourceTasks: ['original'], sourceCommit: 'a'.repeat(40) },
    };
    const run: ProofReservation = {
      status: 'bound',
      binding: {
        version: 1,
        reservationToken: 'owned-token',
        checkId: '11111111-1111-4111-8111-111111111111',
        goal: contract.goal,
        taskId: 'proof',
        attempt: 1,
        sourceCommit: contract.proof.sourceCommit,
        sourceTree: 'b'.repeat(40),
        argv: contract.acceptance.command,
        cwd: directory.path,
      },
    };
    const task: Task = {
      id: 'proof',
      sequence: 1,
      brief: contract,
      briefPath: '',
      state: 'running',
      worktree: directory.path,
      branch: 'worker/proof',
      base: contract.proof.sourceCommit,
      taskClass: 'implementation',
      currentAttempt: 1,
      createdAt: new Date().toISOString(),
      proofRun: run,
    };
    const prompt = workerPrompt(task, undefined, undefined, [], directory.path);
    const [, argv] = launchCommand({
      profile: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', poolClass: 'default' },
      pool: fixturePool(directory.path),
      worktree: directory.path,
      prompt,
    });
    expect(argv.join('\n')).toContain('task-scoped exception');
    expect(argv.join('\n')).not.toContain('Verification is minimal');
    expect(argv.join('\n')).not.toContain('before you start a check and again after each fix');
    for (const boundary of [
      workerCheckProtocol(directory.path, contract, state, run),
      workerCheckProtocol(directory.path, contract, state, {
        ...run,
        status: 'released',
        observation: { status: 'terminal', passed: true, cause: 'done', record: {}, physical: [] },
      }),
    ]) {
      expect(boundary).toContain('same session');
      expect(boundary).toContain(`logical check UUID: ${run.binding.checkId}`);
      expect(boundary).toContain(`Captured source: ${run.binding.sourceCommit}`);
      expect(boundary).toContain('do not start an unbound worker-check or another invocation');
      expect(boundary).not.toContain('type-check each workspace you changed');
      expect(boundary).not.toContain('Verification is minimal');
    }
    expect(workerCheckProtocol(directory.path, contract, state)).toContain('Verification is minimal');
    expect(workerCheckProtocol(directory.path, contract.markdown, state, run)).toContain('Verification is minimal');
    expect(workerCheckProtocol(directory.path, brief(), state, run)).toContain('Verification is minimal');
  } finally {
    directory.close();
  }
});

import { proofFingerprint } from './verification.ts';

test('ordinary registered proof prompt bypasses minimal only with authentic saved authorization and preserves one original wrapper invocation', () => {
  const directory = temporaryDirectory();
  try {
    const state = join(directory.path, '.temp/goal');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'verification-mode'), 'minimal\n');
    const contract = {
      ...brief(),
      kind: 'verification' as const,
      paths: [],
      proof: { journey: 'Original', sourceTasks: ['original'], sourceCommit: 'a'.repeat(40) },
      acceptance: {
        ...brief().acceptance,
        command: ['bun', 'scripts/worker-check.ts', '--local', '--', 'bun', 'test', 'a.test.ts'],
      },
    };
    const authorization = {
      fingerprint: proofFingerprint(contract),
      manager: contract.manager,
      sessionId: 'owner',
      sourceTree: 'b'.repeat(40),
      integrationBranch: 'dev',
      originals: [{ taskId: 'original', commit: contract.proof.sourceCommit, argv: contract.acceptance.command }],
    };
    const prompt = workerCheckProtocol(directory.path, contract, state, undefined, authorization);
    expect(prompt).toContain("'bun' 'scripts/worker-check.ts' '--local' '--' 'bun' 'test' 'a.test.ts'");
    expect(prompt).toContain('never wrap it again');
    expect(prompt).toContain('Never invent a UUID');
    expect(prompt).toContain('same session');
    expect(prompt).toContain('Native binding evidence is optional, never a prerequisite for running or success.');
    expect(prompt).not.toContain('type-check each workspace you changed');
    expect(prompt).not.toContain('controller has already started');
    expect(workerCheckProtocol(directory.path, contract, state)).toContain('Verification is minimal');
    expect(
      workerCheckProtocol(directory.path, contract, state, undefined, { ...authorization, fingerprint: 'forged' }),
    ).toContain('Verification is minimal');
    const product = workerCheckProtocol(directory.path, brief(), state);
    for (const required of MINIMAL_RULES) expect(product).toContain(required);
    expect(product).not.toContain('Run exactly one ordinary worker-check invocation');
    expect(product).not.toContain('REZICS_CHECK_LOCAL_ONLY');
  } finally {
    directory.close();
  }
});

test('minimal source completion and incomplete product results use the current policy at every context boundary', () => {
  const directory = temporaryDirectory();
  try {
    const state = join(directory.path, 'configured-state');
    mkdirSync(state);
    writeFileSync(join(state, 'verification-mode'), 'minimal\n');
    const task = {
      id: 'source-worker',
      worktree: join(directory.path, 'worktree'),
      branch: 'worker/source',
      brief: {
        markdown: 'Implement the current product behavior. Original native acceptance remains in this contract.',
        kind: 'implementation',
        acceptance: { command: ['bun', 'scripts/native-check.ts'], tests: ['product behavior'] },
      },
    } as unknown as Task;
    for (const boundary of ['fresh', 'retry', 'held-release', 'wake', 'adopted-legacy'] as const) {
      const context: LaunchContext = {
        version: 1,
        boundary,
        origin: boundary === 'adopted-legacy' ? 'adopted-legacy' : 'managed',
        task: {
          id: task.id,
          attempt: 1,
          state: 'running',
          branch: task.branch,
          worktree: task.worktree,
          contractPath: null,
          contractSha256: null,
          contractProof: 'unknown',
          base: null,
          sourceHead: null,
          sourceBranch: null,
          sourceProof: 'unknown',
        },
        dependencies: { required: 0, included: 0, omitted: 0, completeness: 'complete', receipts: [] },
      };
      const prompt = workerPrompt(task, undefined, undefined, [], directory.path, context, state);
      expect(prompt).toContain(task.brief.markdown);
      expect(prompt).toContain(`"boundary":"${boundary}"`);
      expect(prompt).toContain(
        'This prompt and these facts supersede saved sessions, retry manifests and earlier results.',
      );
      for (const required of MINIMAL_RULES) expect(prompt).toContain(required);
      expect(prompt).toContain('naming what you completed and the deferred acceptance');
      expect(prompt).not.toContain('must report status blocked');
      expect(prompt).toContain('Unfinished work is not a blocker');
      expect(prompt).not.toContain('run your acceptance command once');
    }
  } finally {
    directory.close();
  }
});

test('the configured minimal policy permits compiler placement and awaits the existing foreground handle even for report-only retries', () => {
  const directory = temporaryDirectory();
  try {
    const state = join(directory.path, 'configured-state');
    const evidence = join(directory.path, 'evidence');
    mkdirSync(state);
    mkdirSync(evidence);
    writeFileSync(join(state, 'verification-mode'), 'minimal\n');
    writeFileSync(
      join(evidence, 'failure.json'),
      JSON.stringify({
        manifest:
          'Historical report-only instruction: return waiting with checks:[] until original native acceptance runs.',
      }),
    );
    const task = {
      worktree: directory.path,
      branch: 'worker/source',
      brief: {
        markdown: 'Complete the current implementation, then report its actual source status.',
        kind: 'implementation',
      },
    } as unknown as Task;
    const prompt = workerPrompt(task, evidence, undefined, [], directory.path, undefined, state);
    const policy = prompt.slice(prompt.lastIndexOf('Verification is minimal'));
    for (const required of MINIMAL_RULES) expect(policy).toContain(required);
    expect(prompt).toContain(
      'Rerun the failing command once before reporting any blocker about that failure; report a `tool` blocker only if it fails again.',
    );
    expect(policy).not.toContain('Use already-recorded failure evidence');
    writeFileSync(join(state, 'verification-mode'), 'full\n');
    const normal = workerPrompt(task, undefined, undefined, [], directory.path, undefined, state);
    expect(normal).not.toContain('Verification is minimal');
    expect(normal).toContain('run your acceptance command once');
  } finally {
    directory.close();
  }
});
