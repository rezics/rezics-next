import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { withAgentAdapter } from './agents.ts';
import { codexAdapter } from './agents/codex.ts';
import { architectureRepairStatus, commitPublishedOn, dispatchArchitectureRepairs } from './architecture-repair.ts';
import { checkLandingArchitectureCandidate } from './landing-architecture.ts';
import { integrationHarness, temporaryDirectory } from './test-support.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const FILE = 'packages/fixture/architecture-boundary.ts';
const VIOLATING = "import 'node:fs';\nexport const value = true;\n";
const CLEAN = 'export const value = true;\n';
const VIOLATION = `rule 4: ${FILE}: value import "node:fs"`;

type Harness = ReturnType<typeof integrationHarness>;

/** Makes the fixture module a core, so a `node:fs` value import is a rule 4 violation. */
function makeFixtureCore(h: Harness): void {
  const manifestPath = 'docs/architecture/modules.json';
  const manifest = JSON.parse(readFileSync(join(h.root, manifestPath), 'utf8')) as {
    modules: { kind: string }[];
  };
  manifest.modules[0]!.kind = 'core';
  writeFileSync(join(h.root, manifestPath), `${JSON.stringify(manifest)}\n`);
  git(h.root, 'add', manifestPath);
  git(h.root, 'commit', '-m', 'Set fixture module as a core');
  h.ensureDev();
}

/** Starts a fixture task whose worker commits `content` to FILE. */
async function runFixtureWorker(h: Harness, content: string) {
  const task = h.dispatch(FILE);
  writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file: FILE, content }));
  await h.start(task);
  return task;
}

/** One controller tick of the daily repair, dispatching through the fixture's real task service. */
function repairTick(h: Harness, now = new Date()) {
  return dispatchArchitectureRepairs({
    db: h.store.db,
    unsettled: h.store.tasksInStates(['ready', 'held', 'running', 'landing', 'verified']),
    published: commitPublishedOn(h.root, 'refs/heads/dev'),
    dispatch: (briefFile) => h.tasks.dispatch(briefFile, null, true, 'verifier'),
    notify: () => {},
    reportFailure: (summary) => {
      throw new Error(summary);
    },
    stateDirectory: h.settings.stateDirectory,
    now,
  });
}

test('a final candidate returns only new architecture violations and lets existing base violations land', async () => {
  const fixture = temporaryDirectory();
  try {
    const root = fixture.path;
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    put(root, '.gitignore', '.temp/\n');
    put(
      root,
      'scripts/architecture.ts',
      readFileSync(resolve(import.meta.dir, '../../../scripts/architecture.ts'), 'utf8'),
    );
    put(
      root,
      'scripts/architecture-map.ts',
      readFileSync(resolve(import.meta.dir, '../../../scripts/architecture-map.ts'), 'utf8'),
    );
    put(
      root,
      'docs/architecture/modules.json',
      JSON.stringify({
        version: 1,
        sourceRoots: [{ path: 'packages/core', extensions: ['.ts'] }],
        modules: [
          {
            id: 'core',
            kind: 'core',
            owner: 'platform',
            paths: ['packages/core/**'],
            publicEntries: ['packages/core/index.ts'],
            allowedDependencies: [],
            capabilities: [],
          },
        ],
      }),
    );
    put(root, 'docs/architecture/boundary-baseline.json', JSON.stringify({ version: 1, modules: {} }));
    put(root, 'packages/core/index.ts', "import { join } from 'node:path';\nexport { join };\n");
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'Seed architecture fixture');
    const seed = git(root, 'rev-parse', 'HEAD');

    put(root, 'docs/notes.md', 'No architecture source changed.\n');
    git(root, 'add', 'docs/notes.md');
    git(root, 'commit', '-m', 'Change documentation only');
    const cleanCandidate = git(root, 'rev-parse', 'HEAD');
    const logPath = join(root, '.temp', 'architecture.log');
    const clean = await checkLandingArchitectureCandidate({
      cwd: root,
      base: seed,
      candidate: cleanCandidate,
      changedFiles: ['docs/notes.md'],
      logPath,
    });
    expect(clean).toMatchObject({ outcome: 'passed', base: seed, candidate: cleanCandidate, changedFileCount: 1 });
    expect(clean.elapsedMs).toEqual(expect.any(Number));

    put(root, 'packages/core/safe.ts', 'export const value = true;\n');
    put(
      root,
      'packages/core/index.ts',
      "import { value } from './safe';\nimport { join } from 'node:path';\nexport { join, value };\n",
    );
    git(root, 'add', 'packages/core/index.ts', 'packages/core/safe.ts');
    git(root, 'commit', '-m', 'Add an allowed core import before the existing violation');
    const safeCandidate = git(root, 'rev-parse', 'HEAD');
    const safeChange = await checkLandingArchitectureCandidate({
      cwd: root,
      base: cleanCandidate,
      candidate: safeCandidate,
      changedFiles: ['packages/core/index.ts', 'packages/core/safe.ts'],
      logPath,
    });
    expect(safeChange.outcome).toBe('passed');

    put(root, 'packages/core/new.ts', "import 'node:fs';\nexport const value = true;\n");
    git(root, 'add', 'packages/core/new.ts');
    git(root, 'commit', '-m', 'Add a forbidden core dependency');
    const violatingCandidate = git(root, 'rev-parse', 'HEAD');
    const violating = await checkLandingArchitectureCandidate({
      cwd: root,
      base: safeCandidate,
      candidate: violatingCandidate,
      changedFiles: ['packages/core/new.ts'],
      logPath,
    });
    expect(violating.outcome).toBe('diagnostic');
    expect(violating.diagnostics.join('\n')).toContain('rule 4: packages/core/new.ts: value import "node:fs"');
    expect(readFileSync(logPath, 'utf8').match(/Dev landing architecture candidate=/g)).toHaveLength(3);
    expect(readFileSync(logPath, 'utf8')).toContain('Dev landing architecture diagnostic');
  } finally {
    fixture.close();
  }
});

test('a new boundary violation lands and is recorded against its Goal instead of returning to the author', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    makeFixtureCore(h);
    const task = await runFixtureWorker(h, VIOLATING);
    await h.train();
    expect(h.store.task(task.id).state).toBe('integrated');
    expect(git(h.root, 'show', `dev:${FILE}`)).toBe(VIOLATING.trim());
    expect(h.store.events(task.id, 1).some((event) => event.kind === 'dev-landing-transpile-returned')).toBe(false);
    const statuses = architectureRepairStatus(h.store.db, (id) => h.store.task(id).state);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ goal: 'fixture', openViolations: 1, repair: null });
    expect(statuses[0]!.violations[0]).toContain(VIOLATION);
  } finally {
    h.dispose();
  }
});

test('a landed violation gets one urgent repair and resolves once a later candidate on dev no longer reports it', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    makeFixtureCore(h);
    await runFixtureWorker(h, VIOLATING);
    await h.train();
    const [repair] = repairTick(h);
    expect(repair).toBeDefined();
    expect(h.store.task(repair!.id).brief).toMatchObject({
      goal: 'fixture',
      manager: 'fixture',
      urgent: true,
      estimate: { lines: 15, files: 1 },
    });
    expect(repairTick(h)).toEqual([]);
    const fix = await runFixtureWorker(h, CLEAN);
    await h.train();
    expect(h.store.task(fix.id).state).toBe('integrated');
    expect(git(h.root, 'show', `dev:${FILE}`)).toBe(CLEAN.trim());
    expect(repairTick(h)).toEqual([]);
    expect(architectureRepairStatus(h.store.db, (id) => h.store.task(id).state)).toEqual([]);
    expect(
      h.store.db.query('SELECT resolved_at FROM architecture_repair_runs WHERE task_id = ?').get(repair!.id),
    ).toMatchObject({
      resolved_at: expect.any(String),
    });
  } finally {
    h.dispose();
  }
});

test('a transpile failure still returns to the author and records no boundary violation', async () => {
  const h = integrationHarness();
  const file = FILE;
  let resumedSession: string | undefined;
  // The first attempt commits invalid TypeScript; the resumed session commits the repaired file.
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const file = ${JSON.stringify(file)};
    const content = process.env.GOAL_ATTEMPT === '1' ? 'export const value: = ;\\n' : 'export const value = true;\\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const committed = spawnSync('git', ['add', '--', file], { stdio: 'ignore' });
    if (committed.status !== 0 || spawnSync('git', ['commit', '-qm', 'Worker transpile fixture']).status !== 0) process.exit(2);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'transpile-repair-session' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'RESULT: success' } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }));
  `;
  const adapter = {
    ...codexAdapter,
    start() {
      return [process.execPath, ['-e', script]] as [string, string[]];
    },
    resume(options: Parameters<NonNullable<typeof codexAdapter.resume>>[0]) {
      resumedSession = options.session;
      return [process.execPath, ['-e', script]] as [string, string[]];
    },
  };
  try {
    h.settings.integration.devLandingChecks = false;
    makeFixtureCore(h);
    const task = h.dispatch(file);
    await withAgentAdapter(adapter, async () => {
      await h.start(task);
      await h.train();
      expect(resumedSession).toBe('transpile-repair-session');
      await h.train();
    });
    const handback = h.store.events(task.id, 1).find((event) => event.kind === 'dev-landing-transpile-returned');
    expect(JSON.parse(handback!.body)).toMatchObject({ guard: 'dev-landing-transpile' });
    expect(h.store.task(task.id).state).toBe('integrated');
    expect(git(h.root, 'show', `dev:${file}`)).toBe(CLEAN.trim());
    expect(architectureRepairStatus(h.store.db, (id) => h.store.task(id).state)).toEqual([]);
  } finally {
    h.dispose();
  }
});
