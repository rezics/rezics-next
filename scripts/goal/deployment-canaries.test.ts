import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dependencyInstallIsStale, recordDependencyInstall } from './dependencies.ts';
import { repositoryGuards, selectRepositoryGuards } from '../qa/repository-guards.ts';

const root = resolve(import.meta.dir, '../..');
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function write(root: string, file: string, content: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function fixture() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp/deployment-canary-'));
  temporary.push(directory);
  git(directory, 'init', '-qb', 'main');
  git(directory, 'config', 'user.name', 'Deployment canary');
  git(directory, 'config', 'user.email', 'canary@example.invalid');
  write(directory, '.gitignore', '.temp/\nnode_modules/\n.goalctl/settings.user.json\n');
  write(directory, '.goalctl/settings.json', '{"version":1}');
  return directory;
}
function environment(directory: string): NodeJS.ProcessEnv {
  // A child must never inherit a live manager's bookkeeping or another test's settings.
  return { ...process.env, GOAL_TURN_TOKEN: '', GOAL_TURN_STATE_DIR: '', GOAL_TASK_ID: '',
    GOAL_SETTINGS_DIRECTORY: join(directory, '.goalctl'), GOAL_IN_SLOT: '1', GOAL_QA_HEAVY_RUN: '0' };
}
async function cli(cwd: string, script: string, args: string[], directory = cwd, expectedCode = 0) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd, env: environment(directory), stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stdout + stderr).toBe(expectedCode);
  return stdout;
}

test('an older worktree goalctl reads current machine settings and the current shared ledger', async () => {
  const directory = fixture();
  // Freeze the deployed CLI and its schema before a field is introduced. Only
  // product source is shared; no code is loaded from the newer goalctl tree.
  cpSync(join(root, 'scripts'), join(directory, 'scripts'), { recursive: true });
  for (const path of ['packages', 'services', 'apps', 'tests', 'generated', 'infra', 'model'])
    symlinkSync(join(root, path), join(directory, path));
  const schema = JSON.parse(readFileSync(join(root, '.goalctl/settings.schema.json'), 'utf8'));
  delete schema.properties.codexCompactTokens;
  write(directory, '.goalctl/settings.schema.json', JSON.stringify(schema));
  const config = readFileSync(join(directory, 'scripts/goal/config.ts'), 'utf8');
  const older = config.replace(/  codexCompactTokens: \{ sol: 160_000, luna: 200_000 \},\n/, '');
  expect(older).not.toBe(config);
  write(directory, 'scripts/goal/config.ts', older);
  git(directory, 'add', '.'); git(directory, 'commit', '-qm', 'Older deployed tooling');
  const worktree = join(directory, '.temp/older');
  git(directory, 'worktree', 'add', '-qb', 'older', worktree);
  const revision = git(worktree, 'rev-parse', 'HEAD');

  write(directory, '.goalctl/settings.json', readFileSync(join(root, '.goalctl/settings.json'), 'utf8'));
  write(directory, '.goalctl/settings.schema.json', readFileSync(join(root, '.goalctl/settings.schema.json'), 'utf8'));
  write(directory, '.goalctl/settings.user.json', JSON.stringify({ version: 1, qaSlots: 7,
    codexCompactTokens: { sol: 180000, luna: 210000 }, futureSetting: { enabled: true } }));
  const ledger = JSON.stringify({ tasks: { 'fixture-worker': {
    id: 'fixture-worker', state: 'running', branch: 'older', worktree, paths: ['canary.ts'],
  } }, futureLedgerField: { retained: true } });
  write(directory, '.temp/goal-orchestration/ledger.json', ledger);
  git(directory, 'add', '.goalctl'); git(directory, 'commit', '-qm', 'Current settings');
  expect(git(directory, 'rev-parse', 'HEAD')).not.toBe(revision);
  const script = join(worktree, 'scripts/goal/goalctl.ts');
  const loaded = JSON.parse(await cli(worktree, script, ['config'], directory));
  expect(loaded.settings.qaSlots).toBe(7);
  expect(loaded.settings).not.toHaveProperty('codexCompactTokens');
  expect(loaded.sources.qaSlots).toBe(join(directory, '.goalctl/settings.user.json'));
  expect(await cli(worktree, script, ['owner', 'canary.ts'], directory, 1)).toContain('claimed by fixture-worker (running)');
  expect(readFileSync(join(directory, '.temp/goal-orchestration/ledger.json'), 'utf8')).toBe(ledger);
  expect(git(worktree, 'rev-parse', 'HEAD')).toBe(revision);
}, 30_000);

test('the CLI refreshes a stale main and a stale older worktree before starting an admitted command', async () => {
  const directory = fixture();
  write(directory, 'yarn.lock', 'old installation');
  write(directory, 'package.json', '{}');
  write(directory, 'install.ts', "import { writeFileSync } from 'node:fs'; writeFileSync('.temp/installed', 'current');\n");
  write(directory, 'Taskfile.yml', `version: '3'\ntasks:\n  install:\n    cmds:\n      - '${process.execPath} install.ts'\n`);
  git(directory, 'add', '.'); git(directory, 'commit', '-qm', 'Installed revision');
  const worktree = join(directory, '.temp/older');
  git(directory, 'worktree', 'add', '-qb', 'older', worktree);
  recordDependencyInstall(directory); recordDependencyInstall(worktree);
  write(directory, 'yarn.lock', 'dependency upgrade');
  git(directory, 'commit', '-am', 'Upgrade dependencies');
  git(worktree, 'rebase', 'main');
  for (const cwd of [directory, worktree]) {
    expect(dependencyInstallIsStale(cwd)).toBe(true);
    await cli(cwd, join(root, 'scripts/goal/goalctl.ts'), ['slot', '--', process.execPath, '-e',
      "import { readFileSync } from 'node:fs'; if (readFileSync('.temp/installed', 'utf8') !== 'current') process.exit(3);"]);
    expect(dependencyInstallIsStale(cwd)).toBe(false);
  }
}, 30_000);

test('every deployment boundary canary is selected for each tooling and retained-adapter input', () => {
  const canaries = ['scripts/goal/deployment-canaries.test.ts', 'scripts/goal/dependencies.test.ts',
    'scripts/qa/retained-preflight.test.ts', 'scripts/qa/retained-source-inputs.test.ts'];
  for (const path of ['scripts/goal/new-command.ts', 'scripts/qa/new-harness.ts', '.goalctl/settings.json',
    '.goalctl/settings.schema.json', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
    'tests/qa/support/realm-discussion-source.ts', 'tests/qa/support/realm-discussion-source-runtime.ts',
    'tests/qa/support/seed-checkpoints.ts', 'tests/qa/support/seed-specification.ts',
    'scripts/fixture/owners/graph.ts', 'scripts/load/compatibility.ts', 'scripts/load/work-profile-corpus.ts',
    'tests/qa/fault-recovery/retained-content-source-support.ts',
    'tests/qa/fault-recovery/owner-restore-erasure-fixture.ts', 'tests/qa/fault-recovery/independent-restore-support.ts']) {
    const selected = selectRepositoryGuards([path]).map(guard => guard.file);
    for (const file of canaries) expect(selected, `${path} must select ${file}`).toContain(file);
  }
  for (const file of canaries) {
    expect(repositoryGuards.filter(guard => guard.file === file)).toHaveLength(1);
    expect(selectRepositoryGuards(['apps/web/app/page.tsx']).map(guard => guard.file)).not.toContain(file);
  }
});
