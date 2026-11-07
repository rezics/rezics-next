import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MAX_MODULE_MAP_CHARACTERS,
  MODULE_MAP_POINTER,
  MODULE_MAP_TRUNCATION,
  formatModuleMap,
  loadManifest,
  modulesForBriefPaths,
} from '../../../scripts/architecture-map.ts';
import { launchCommand, workerCheckProtocol, workerPrompt } from './launch.ts';
import { defaultPolicy } from './policy.ts';
import { renderCheckProtocol, renderManagerOpening, renderWorkerPrompt } from './prompts.ts';
import { prepareOwnerDecisionPrompt } from './owner-decisions.ts';
import type { Attempt, Brief, Task } from './types.ts';
import type { LaunchContext } from './launch-context.ts';
import { brief, fixturePool, temporaryDirectory } from './test-support.ts';
import type { ProofReservation } from './verification.ts';
import { storybookServers } from './storybook.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { runWorkerCommand } from './worker-commands.ts';
import { loadSettings } from './config.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const MAP_MAIN = '/repo/main';

function mapTask(paths: string[], extra: Partial<Brief> = {}): Task {
  return {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    brief: {
      markdown: 'Do the thing.',
      kind: 'implementation',
      paths,
      acceptance: { command: ['bun', 'test'], tests: ['x'] },
      ...extra,
    },
  } as unknown as Task;
}

function mapRows(prompt: string): string[] {
  const start = prompt.indexOf('row module|kind|public entries|allowed dependencies');
  const pointer = prompt.indexOf(MODULE_MAP_POINTER, start);
  return prompt
    .slice(start, pointer === -1 ? undefined : pointer)
    .split('\n')
    .slice(1)
    .filter(Boolean);
}

test('the worker prompt names the main checkout as read-only and asks for paths inside the worktree', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    mainCheckout: '/repo/main',
    brief: { markdown: 'Do the thing.', acceptance: { command: ['bun', 'test'], tests: ['x'] } },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('the main checkout /repo/main is read-only');
  expect(prompt).toContain('Work only in /work/trees/t1;');
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
  expect(prompt).toContain('Failures on base are not yours; name them.');
  expect(prompt).toContain('Fix tests that passed on base but fail now.');
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
  expect(prompt).toContain('AGENTS.md is loaded.');
  expect(prompt).not.toContain('Read and follow its AGENTS.md');
  expect(prompt).toContain('Search freely inside the worktree; outside it, only the directories named here.');
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
  expect(prompt).toContain('Leave containers, databases and processes this attempt did not start running');
  expect(prompt).toContain('do not prune Docker');
  // A diagnosis patched a hardlinked reylo file in place and every worktree and check host printed its trace.
  expect(prompt).toContain('Do not write under node_modules');
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
  expect(research).toContain(
    "write only inside /work/trees/t1 and the reference clones under that checkout's .reference/.",
  );
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
  expect(prompt).toContain('Write missing acceptance tests the contract names or implies');
  expect(prompt).not.toContain('never edit a frozen file');
  expect(prompt).not.toContain('must not be edited');
  expect(prompt).not.toContain('must not be edited');
  expect(prompt).toContain(
    'Update and list tests if a contract change alters asserted behaviour; keep unchanged assertions.',
  );
  expect(prompt).toContain(
    'fewest tests that pin user-visible behaviour and edge cases (fewer test lines than product lines)',
  );
  expect(prompt).toContain('Wait for a long command, even one queued for a test slot');
});

test('worker and manager prompts trust repository callers and let dev repair contradictory frozen tests', () => {
  const task = {
    id: 'task',
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    currentAttempt: 1,
    frozenFiles: [{ path: 'tests/acceptance.test.ts', hash: 'frozen-hash' }],
    brief: {
      goal: 'web',
      manager: 'web',
      kind: 'implementation',
      paths: ['src/a.ts', 'tests/acceptance.test.ts'],
      riskAreas: [],
      markdown: 'Implement the requested behavior.',
      acceptance: { command: ['bun', 'test'], tests: ['acceptance'], failing: true },
      estimate: { lines: 100, files: 2 },
      criticalPath: false,
      waiting: [],
      after: [],
    },
  } as unknown as Task;
  const rendered = renderWorkerPrompt({ task, mainCheckout: '/repo/main' });
  expect(rendered.prompt).toContain(
    "Frozen acceptance files hold the contract's tests: tests/acceptance.test.ts. If one contradicts the contract, an owner document or the delivered code it depends on, change the smallest assertion that makes them agree, list the file and the reason in your summary, and continue.",
  );
  expect(rendered.prompt).toContain(
    'When two requirements conflict, follow the owner documents and the delivered code, change the smaller side (a test, fixture or brief detail), list it and continue.',
  );
  expect(rendered.prompt).toContain(
    'Validate only where outside input enters: HTTP requests, imported records, external files and third-party responses.',
  );
  expect(rendered.prompt).toContain('Large surveys are `spec-conflict` blockers starting "Research needed:"');
  expect(rendered.prompt).not.toContain('must not be edited');
  expect(rendered.prompt).not.toContain('never edit a frozen file');
  expect(rendered.roleBytes).toBeLessThanOrEqual(defaultPolicy.prompt.workerRoleBytes);

  const directory = temporaryDirectory();
  try {
    const trustBlock =
      'Trust model for briefs. Agents and internal callers are trusted; REZICS is a community product, and a mistake on dev is caught and returned after integration. When an incident shows a wrong result, brief the repair that produces the right result where the problem appears (resolve, merge, regenerate, normalize), so the pipeline continues. Do not brief a new refusal, rejection, stop or failed attempt unless no agent could produce the correct result there; if you still need one, state the defect it prevents and the attempts and hours it will cost. Ask for validation only at system boundaries: HTTP input, imported records, external files and third-party responses. Acceptance covers the behaviour asked for; ask for refusal tests only for boundary input and authorization rules. Money movement (payments, payouts, balances) keeps strict guards.';
    const manager = renderManagerOpening({
      spec: { id: 'manager', goal: 'web', brief: '', cwd: directory.path, engine: 'codex' },
      backlogPath: 'backlog.md',
      command: 'bun tools/goal/src/cli.ts',
    });
    expect(manager.prompt).toContain(trustBlock);
    expect(manager.roleBytes).toBeLessThanOrEqual(defaultPolicy.prompt.managerRoleBytes);
    expect(manager.openingBytes).toBeLessThanOrEqual(defaultPolicy.prompt.managerOpeningBytes);
  } finally {
    directory.close();
  }
});

test('minimal verification keeps one wrapper budget and fail-fast dependency ordering', () => {
  const directory = temporaryDirectory();
  try {
    writeFileSync(join(directory.path, 'verification-mode'), 'minimal\n');
    const prompt = renderCheckProtocol('/work/trees/t1', 'Check the changed outcome.', directory.path);
    expect(prompt).toContain('Defer ordinary acceptance/native/browser/root/growth suites; run declared control-plane acceptance before exit');
    expect(prompt).toContain('Typecheck each changed workspace');
    expect(prompt).toContain('Order producers before consumers');
    expect(prompt).toContain('On prerequisite failure, stop and leave unreached checks unverified');
    expect(prompt).toContain('Use one wrapper submission for the pass');
    expect(prompt).toContain(
      'Parallel independent children require an existing entry point that admits and aggregates them under the same check/budget',
    );
    expect(prompt).toContain('No extra submissions or shell fanout');
    expect(prompt).toContain('Kernel/Auth/Web mapper typechecks stay within the per-run memory cap');
    expect(prompt).toContain("`sh -c 'cmd1 && cmd2 && cmd3'`");
    expect(prompt).not.toContain('never joins them with `&&`');
    expect(prompt).not.toContain("cmd1; s=$?; cmd2 || s=1");
    expect(prompt).toContain('All must pass for success; reuse unchanged passing evidence');
    expect(prompt).toContain('Run checks through the wrapper');
    expect(prompt).not.toContain("under a 'failing tests' label in the summary");
    expect(prompt).toContain('Fix each failure before one rerun of its chain');
    expect(prompt).not.toContain('overrides');
    expect(prompt).not.toMatch(/do not run|must not run|prohibit/i);
  } finally {
    directory.close();
  }
});

test('the documented dependency chain stops at a failed prerequisite and reaches all checks on success', () => {
  const directory = temporaryDirectory();
  try {
    writeFileSync(join(directory.path, 'verification-mode'), 'minimal\n');
    const prompt = renderCheckProtocol('/work/trees/t1', 'Check the changed outcome.', directory.path);
    const script = /sh -c '([^']+)'/.exec(prompt)![1]!;
    const failed = spawnSync(
      'sh',
      ['-c', script.replace('cmd1', 'echo producer').replace('cmd2', 'false').replace('cmd3', 'echo consumer')],
      { encoding: 'utf8' },
    );
    expect(failed.stdout).toBe('producer\n');
    expect(failed.status).toBe(1);

    const succeeded = spawnSync(
      'sh',
      ['-c', script.replace('cmd1', 'echo producer').replace('cmd2', 'echo middle').replace('cmd3', 'echo consumer')],
      { encoding: 'utf8' },
    );
    expect(succeeded.stdout).toBe('producer\nmiddle\nconsumer\n');
    expect(succeeded.status).toBe(0);
  } finally {
    directory.close();
  }
});

test('minimal verification parks check-host commands on the wrapper and keeps short local commands in session', () => {
  const directory = temporaryDirectory();
  try {
    writeFileSync(join(directory.path, 'verification-mode'), 'minimal\n');
    mkdirSync(join(directory.path, 'scripts'), { recursive: true });
    writeFileSync(join(directory.path, 'scripts/worker-check.ts'), '');
    const prompt = renderCheckProtocol(directory.path, 'Check the changed outcome.', directory.path);
    expect(prompt).toContain('Run checks through the wrapper (`bun scripts/worker-check.ts -- <command...>`)');
    expect(prompt).toContain('Kernel/Auth may use compiler DB/host');
    expect(prompt).toContain(
      'include payment, payout, order settlement, points or balance tests when changed',
    );
    expect(prompt).toContain(
      '`{"status":"waiting","checks":["<bare UUID>"]}` in the exit object, using that bare UUID',
    );
    expect(prompt).toContain('Never wait for it yourself: no `--wait`');
    expect(prompt).toContain('The controller wakes this session with the result: use it exactly');
    expect(prompt).toContain(
      'Commands that finish locally in under a minute (oxfmt, tsc on tools/goal) still run in the session.',
    );
    expect(prompt).not.toContain('Wait for a long command, even one queued for a test slot');
    expect(prompt).not.toContain('in its open session with one yield of at least 300 seconds');
  } finally {
    directory.close();
  }
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
      brief: {
        markdown: 'Do the thing.',
        kind: 'implementation',
        acceptance: { command: ['bun', 'test'], tests: ['x'] },
      },
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
    expect(prompt).toContain('Ignore older prompt, saved session, remote invocation or `--wait` recipes');
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
    'a tool or infrastructure failure persisting after two retries, reported as a `tool` blocker starting with the exact error line.',
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
  expect(prompt).toContain('/repo/main');
  expect(prompt).toContain("the main checkout's .reference/");
  expect(prompt).toContain('list contract-named sources read before design');
});

/** The behaviour the minimal verification policy must state wherever it is rendered. */
const MINIMAL_RULES = [
  'Typecheck each changed workspace',
  'Order producers before consumers',
  'chain them fail-fast with `&&`',
  "`sh -c 'cmd1 && cmd2 && cmd3'`",
  'On prerequisite failure, stop and leave unreached checks unverified',
  'Use one wrapper submission for the pass',
  'Parallel independent children require an existing entry point that admits and aggregates them under the same check/budget',
  'No extra submissions or shell fanout',
  'Kernel/Auth/Web mapper typechecks stay within the per-run memory cap',
  'reuse unchanged passing evidence',
  'All must pass for success; reuse unchanged passing evidence',
  'Fix each failure before one rerun of its chain',
  'Defer ordinary acceptance/native/browser/root/growth suites; run declared control-plane acceptance before exit',
  'a type error is not a pass; a failing payment, payout, order settlement, points or balance test is not a pass',
  'a `tool` blocker; type and test failures are not infrastructure failures',
  'Typecheck each changed workspace',
  'include payment, payout, order settlement, points or balance tests when changed',
  'Kernel/Auth may use compiler DB/host',
  "don't unset KERNEL_CHECK_REMOTE or force local",
  'Run checks through the wrapper (`bun scripts/worker-check.ts -- <command...>`)',
  '`{"status":"waiting","checks":["<bare UUID>"]}` in the exit object, using that bare UUID',
  'Never wait for it yourself: no `--wait`',
  'Commands that finish locally in under a minute',
  'oxfmt, tsc on tools/goal',
  'return success (blocker null, `"checks":[]`)',
  'the deferred acceptance, which is neither a blocker nor a reason to wait',
  'return waiting only for a still-running check UUID this attempt started',
];
const MINIMAL_FORBIDDEN = [
  'never joins them with `&&`',
  "`sh -c 'cmd1; s=$?; cmd2 || s=1; cmd3 || s=1; exit $s'`",
  'Wait for a long command, even one queued for a test slot',
  'in its open session with one yield of at least 300 seconds',
  "under a 'failing tests' label in the summary",
  'the changed test files',
  'A failing test blocks success only when the outcome changes payment, payout, order settlement, points or balance code',
  '`yield_time_ms: 300000`',
  'Run a focused check yourself only when you cannot finish the outcome without seeing it',
  "run the test files you created or changed once, with the landing's command",
];

test('minimal product policy keeps supported compiler placement and parks check-host commands on the wrapper', () => {
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
        for (const forbidden of MINIMAL_FORBIDDEN) expect(policy).not.toContain(forbidden);
        if (retryEvidence) expect(prompt).toContain('Rerun the failing command once before reporting any blocker');
        expect(policy).not.toContain('task-scoped exception');
        expect(prompt).toContain('Build the whole outcome in this attempt');
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

test('original integrated journey proof bypasses only its registered task-scoped minimal mode at final Codex input', () => {
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
    for (const forbidden of MINIMAL_FORBIDDEN) expect(product).not.toContain(forbidden);
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
      for (const forbidden of MINIMAL_FORBIDDEN) expect(prompt).not.toContain(forbidden);
      expect(prompt).toContain('naming what you completed and the deferred acceptance');
      expect(prompt).not.toContain('must report status blocked');
      expect(prompt).toContain('Build the whole outcome in this attempt');
      expect(prompt).not.toContain('run your acceptance command once');
    }
  } finally {
    directory.close();
  }
});

test('the configured minimal policy parks check-host commands on the wrapper even for report-only retries', () => {
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
        acceptance: { command: ['bun', 'test'], tests: ['x'] },
      },
    } as unknown as Task;
    const prompt = workerPrompt(task, evidence, undefined, [], directory.path, undefined, state);
    const policy = prompt.slice(prompt.lastIndexOf('Verification is minimal'));
    for (const required of MINIMAL_RULES) expect(policy).toContain(required);
    for (const forbidden of MINIMAL_FORBIDDEN) expect(policy).not.toContain(forbidden);
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

test('a normal prompt boundary includes a persisted owner decision on the same worker attempt', async () => {
  const directory = temporaryDirectory();
  const db = openDb(join(directory.path, 'goal.sqlite'));
  let store = new WorkerStore(db);
  try {
    const ownerBrief = { ...brief(), goal: 'accounts', manager: 'accounts' };
    const task = store.createTask(
      ownerBrief,
      { briefPath: join(directory.path, 'brief.md'), worktree: directory.path, branch: 'worker/task-a', base: 'base' },
      'implementation',
      'task-a',
    );
    db.query("UPDATE worker_tasks SET current_attempt=1, body=json_set(body, '$.currentAttempt', 1) WHERE id=?").run(
      task.id,
    );
    const attempt = {
      taskId: task.id,
      attempt: 1,
      state: 'waiting',
      session: 'existing-worker-session',
      checks: ['existing-check-identity'],
    } as Attempt;
    db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)').run(
      task.id,
      1,
      JSON.stringify(attempt),
    );
    store = new WorkerStore(db);
    db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    db.query('INSERT INTO manager_sessions VALUES (?, ?)').run(
      'accounts',
      JSON.stringify({
        status: 'running',
        threadId: 'authenticated-owner-session',
      }),
    );
    await runWorkerCommand(
      'event',
      [
        task.id,
        '1',
        'owner-contract-decision',
        JSON.stringify({
          decisionId: 'clarification-1',
          summary: 'Use the existing contributor-to-work composition rule.',
          documentRefs: [{ path: 'docs/composition.md', change: 'Clarified contributor ownership.' }],
        }),
      ],
      {
        settings: loadSettings({ cwd: directory.path, env: { GOAL_MAIN_CHECKOUT: directory.path } }),
        store,
        env: { CODEX_THREAD_ID: 'authenticated-owner-session' },
      },
    );
    store = new WorkerStore(db);
    mkdirSync(join(directory.path, 'docs'), { recursive: true });
    writeFileSync(join(directory.path, 'docs/composition.md'), 'Composition rules.');

    const currentTask = store.task(task.id);
    const prompt = workerPrompt(currentTask, undefined, undefined, [], directory.path);
    const prepared = prepareOwnerDecisionPrompt(store, currentTask, attempt, prompt);
    const delivered =
      prepared.prompt.includes('Use the existing contributor-to-work composition rule.') ||
      (prepared.file?.content.includes('Use the existing contributor-to-work composition rule.') ?? false);
    expect(delivered).toBe(true);
    expect(prepared.prompt).toMatch(/docs\/composition\.md|owner-decisions\/1\.md/);
    expect(store.task(task.id).currentAttempt).toBe(1);
    expect(store.attempts(task.id)).toMatchObject([
      { attempt: 1, session: 'existing-worker-session', checks: ['existing-check-identity'] },
    ]);
    expect(store.attempts(task.id)).toHaveLength(1);

    if (prepared.delivery) store.recordOwnerDecisionDelivery({ taskId: task.id, attempt: 1 }, prepared.delivery);
    expect(store.task(task.id).currentAttempt).toBe(1);
  } finally {
    db.close();
    directory.close();
  }
});

test("a worker prompt carries only the modules that own the brief's paths and those they may depend on", () => {
  const manifest = loadManifest(REPOSITORY_ROOT);
  const kernelPaths = ['services/kernel/src/search/query.ts'];
  const kernel = renderWorkerPrompt({ task: mapTask(kernelPaths), mainCheckout: MAP_MAIN }).prompt;
  const selected = modulesForBriefPaths(manifest, kernelPaths);
  const expected = formatModuleMap(manifest, kernelPaths);
  expect(kernel).toContain(expected);
  expect(selected.map((module) => module.id)).toContain('kernel-search');
  expect(selected.map((module) => module.id).sort()).toEqual(
    ['kernel-search', ...manifest.modules.find((module) => module.id === 'kernel-search')!.allowedDependencies].sort(),
  );
  expect(kernel).toContain(MODULE_MAP_POINTER);
  expect(kernel).not.toContain(MODULE_MAP_TRUNCATION);
  expect(mapRows(kernel).some((row) => row.startsWith('wapp|') || row.startsWith('wsearch|'))).toBe(false);
  expect(mapRows(kernel).some((row) => row.startsWith('auth-pages|'))).toBe(false);

  const nested = renderWorkerPrompt({
    task: mapTask(['services/kernel/src/access/contract/bounds.ts']),
    mainCheckout: MAP_MAIN,
  }).prompt;
  expect(mapRows(nested).some((row) => row.startsWith('kaccess-contract|'))).toBe(true);
  expect(mapRows(nested).some((row) => row.startsWith('kaccess|'))).toBe(false);
  expect(mapRows(nested).some((row) => row.startsWith('wsearch|'))).toBe(false);
});

test('golden worker prompts stay within the worker role budget and do not truncate a map that fits', () => {
  const proofRun: ProofReservation = {
    status: 'bound',
    binding: {
      version: 1,
      reservationToken: 'token',
      checkId: '11111111-1111-4111-8111-111111111111',
      goal: 'web',
      taskId: 'task',
      attempt: 1,
      sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceTree: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      argv: ['bun', 'test'],
      cwd: '/work/t',
    },
  };
  const rendered = [
    renderWorkerPrompt({ task: mapTask(['src/a.ts']), mainCheckout: MAP_MAIN }),
    renderWorkerPrompt({
      task: mapTask(['apps/web/src/stories/card.stories.tsx'], { kind: 'interface', markdown: 'Polish the card.' }),
      mainCheckout: MAP_MAIN,
    }),
    renderWorkerPrompt({
      task: mapTask(['docs/research/x.md'], { kind: 'research', markdown: 'Survey the sources.' }),
      mainCheckout: MAP_MAIN,
    }),
    renderWorkerPrompt({
      task: mapTask([], { kind: 'verification', markdown: 'Read-only original journey.' }),
      mainCheckout: MAP_MAIN,
      proofRun,
    }),
    renderWorkerPrompt({ task: mapTask(['services/kernel/src/search/query.ts']), mainCheckout: MAP_MAIN }),
    renderWorkerPrompt({ task: mapTask(['apps/web/src/search/search.tsx']), mainCheckout: MAP_MAIN }),
  ];
  const kernelMap = formatModuleMap(loadManifest(REPOSITORY_ROOT), ['services/kernel/src/search/query.ts']);
  const kernelMapFits = kernelMap.length <= MAX_MODULE_MAP_CHARACTERS;
  for (const item of rendered) {
    const roleBudget = item.prompt.includes('This is a research task')
      ? defaultPolicy.prompt.researchRoleBytes
      : defaultPolicy.prompt.workerRoleBytes;
    const kernelPrompt = item.prompt.includes('ksearch|');
    if (!kernelPrompt || kernelMapFits) {
      expect(item.roleBytes).toBeLessThanOrEqual(roleBudget);
      expect(item.prompt).not.toContain(MODULE_MAP_TRUNCATION);
    }
    expect(item.prompt).toContain(MODULE_MAP_POINTER);
  }
  const kernelPrompt = rendered[4]!.prompt;
  if (kernelMapFits) {
    for (const row of kernelMap.split('\n').slice(1, -1)) expect(kernelPrompt).toContain(row);
  }
});

test('the map is computed from scripts/architecture-map.ts without loading oxc-parser', () => {
  const mapSource = readFileSync(join(REPOSITORY_ROOT, 'scripts/architecture-map.ts'), 'utf8');
  const promptSource = readFileSync(join(REPOSITORY_ROOT, 'tools/goal/src/prompts.ts'), 'utf8');
  expect(mapSource).not.toMatch(/['"]oxc-parser['"]/);
  expect(mapSource).toMatch(/import type \{[^}]+\} from ['"]\.\/architecture\.ts['"]/);
  expect(mapSource).not.toMatch(/^import (?!type ).*from ['"]\.\/architecture\.ts['"]/m);
  expect(promptSource).toContain("from '../../../scripts/architecture-map.ts'");
  expect(promptSource).not.toContain("from '../../../scripts/architecture.ts'");
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `import { formatModuleMap, loadManifest } from ${JSON.stringify(join(REPOSITORY_ROOT, 'scripts/architecture-map.ts'))};
       const map = formatModuleMap(loadManifest(${JSON.stringify(REPOSITORY_ROOT)}), ['services/kernel/src/search/query.ts']);
       if (!map.includes('ksearch|')) throw new Error('missing ksearch');
       if (/^wsearch\\|/m.test(map)) throw new Error('web row');
       console.log('ok');`,
    ],
    { encoding: 'utf8', cwd: REPOSITORY_ROOT },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('ok');
});
