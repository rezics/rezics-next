import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { withAgentAdapter } from './agents.ts';
import { codexAdapter } from './agents/codex.ts';
import { checkLandingArchitectureCandidate } from './landing-architecture.ts';
import { integrationHarness, temporaryDirectory } from './test-support.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

test('a final candidate returns only new architecture violations and lets existing base violations land', async () => {
  const fixture = temporaryDirectory();
  try {
    const root = fixture.path;
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    put(root, '.gitignore', '.temp/\n');
    put(root, 'scripts/architecture.ts', readFileSync(resolve(import.meta.dir, '../../../scripts/architecture.ts'), 'utf8'));
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

test("a new boundary violation returns to the author's session and the repaired candidate lands", async () => {
  const h = integrationHarness();
  const file = 'packages/fixture/architecture-boundary.ts';
  let resumedSession: string | undefined;
  let repairPrompt = '';
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const file = ${JSON.stringify(file)};
    const content = process.env.GOAL_ATTEMPT === '1'
      ? "import 'node:fs';\\nexport const value = true;\\n"
      : 'export const value = true;\\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const committed = spawnSync('git', ['add', '--', file], { stdio: 'ignore' });
    if (committed.status !== 0 || spawnSync('git', ['commit', '-qm', 'Worker architecture fixture']).status !== 0) process.exit(2);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'architecture-repair-session' }));
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
      repairPrompt = options.prompt;
      return [process.execPath, ['-e', script]] as [string, string[]];
    },
  };
  try {
    h.settings.integration.devLandingChecks = false;
    const manifestPath = 'docs/architecture/modules.json';
    const manifest = JSON.parse(readFileSync(join(h.root, manifestPath), 'utf8')) as {
      modules: { kind: string }[];
    };
    manifest.modules[0]!.kind = 'core';
    writeFileSync(join(h.root, manifestPath), `${JSON.stringify(manifest)}\n`);
    git(h.root, 'add', manifestPath);
    git(h.root, 'commit', '-m', 'Set fixture module as a core');
    h.ensureDev();
    const task = h.dispatch(file);
    await withAgentAdapter(adapter, async () => {
      await h.start(task);
      const rejectedSource = git(task.worktree, 'rev-parse', 'HEAD');
      await h.train();
      expect(resumedSession).toBe('architecture-repair-session');
      expect(repairPrompt).toContain('Architecture check rejected dev candidate');
      expect(repairPrompt).toContain(`rule 4: ${file}: value import "node:fs"`);
      expect(repairPrompt).toContain('Retained architecture log:');
      expect(git(task.worktree, 'rev-parse', 'HEAD')).not.toBe(rejectedSource);
      await h.train();
    });

    const handback = h.store.events(task.id, 1).find((event) => event.kind === 'dev-landing-transpile-returned');
    const details = JSON.parse(handback!.body) as { guard: string; diagnostic: string; logPath: string };
    expect(details.guard).toBe('dev-landing-architecture');
    expect(details.diagnostic).toContain(`rule 4: ${file}: value import "node:fs"`);
    expect(existsSync(details.logPath)).toBe(true);
    expect(h.store.record({ taskId: task.id, attempt: 1 })?.guardIds).toContain('dev-landing-architecture');
    expect(h.store.task(task.id).state).toBe('integrated');
    expect(git(h.root, 'show', `dev:${file}`)).toBe('export const value = true;');
  } finally {
    h.dispose();
  }
});
