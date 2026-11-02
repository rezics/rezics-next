import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  childEnvironment,
  cliSmoke,
  configSmoke,
  parseArguments,
  PROOF_CHECKS,
  readHistory,
  redact,
  Refusal,
  rollback,
  rootReferences,
  SMOKE_STATE,
  summarizeTests,
  sync,
  syncChecks,
  type Check,
} from '../scripts/cp-sync.ts';
import { CONTROL_PLANE_CHECKS } from './merge-train.ts';
import { temporaryDirectory } from './test-support.ts';

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

// The repository's own guard: main only moves forward.
const FORWARD_ONLY_HOOK = `#!/bin/sh
[ "$1" = prepared ] || exit 0
while read -r old new ref; do
  [ "$ref" = refs/heads/main ] || continue
  case "$old" in *[!0]*) ;; *) continue ;; esac
  git merge-base --is-ancestor "$old" "$new" || { echo 'main only moves forward' >&2; exit 1; }
done
`;

/** A main checkout with stabilize and dev cut from main, and dev ahead in tools/goal and in a root script. */
function fixture() {
  const temporary = temporaryDirectory();
  closers.push(temporary.close);
  const repo = join(temporary.path, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  write(repo, '.git/hooks/reference-transaction', FORWARD_ONLY_HOOK);
  chmodSync(join(repo, '.git/hooks/reference-transaction'), 0o755);
  write(repo, '.gitignore', '.temp/\nnode_modules/\n');
  write(repo, 'README.md', 'product\n');
  write(repo, 'scripts/x.ts', 'export const x = 1;\n');
  write(repo, 'tools/goal/src/a.ts', "import { x } from '../../../scripts/x.ts';\nexport const a = x;\n");
  write(repo, 'tools/goal/src/gone.ts', 'export {};\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Initial');
  git(repo, 'branch', 'stabilize');
  git(repo, 'branch', 'dev');
  const main = git(repo, 'rev-parse', 'main');
  const dev = join(temporary.path, 'dev');
  git(repo, 'worktree', 'add', '-q', dev, 'dev');
  write(dev, 'tools/goal/src/a.ts', "import { y } from '../../../scripts/x.ts';\nexport const a = y;\n");
  write(dev, 'tools/goal/src/new.ts', 'export const added = true;\n');
  rmSync(join(dev, 'tools/goal/src/gone.ts'));
  write(dev, 'scripts/x.ts', "export { y } from './y.ts';\n");
  write(dev, 'scripts/y.ts', 'export const y = 2;\n');
  write(dev, 'README.md', 'product on dev\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-qm', 'Dev work');
  const lines: string[] = [];
  return {
    root: temporary.path,
    repo,
    dev,
    main,
    source: git(repo, 'rev-parse', 'dev'),
    lines,
    options: {
      cwd: repo,
      worktreeRoot: join(temporary.path, 'worktrees'),
      print: (line: string) => lines.push(line),
      checks: [{ name: 'check', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60_000 }] as Check[],
    },
  };
}

const history = (repo: string) => readHistory(join(repo, '.temp/goal/cp-sync-history.log'));

test('cp-sync runs the main-release proof steps', () => {
  expect(PROOF_CHECKS.map((check) => [...check.argv])).toEqual(CONTROL_PLANE_CHECKS.map((command) => [...command]));
  expect(PROOF_CHECKS.find((check) => check.kind === 'suite')?.timeoutMs).toBe(30 * 60_000);
  // The default gate is the installs, the type check, live config/routing parse and the CLI smoke; --full adds the suite.
  expect(syncChecks('/live').map((check) => check.kind)).toEqual([
    'prepare',
    'prepare',
    'typecheck',
    'smoke',
    'smoke',
  ]);
  expect(syncChecks('/live', true).map((check) => check.kind)).toEqual([
    'prepare',
    'prepare',
    'typecheck',
    'smoke',
    'smoke',
    'suite',
  ]);
  expect(syncChecks('/live').map((check) => check.name)).toEqual([
    'root install',
    'tools/goal install',
    'type check',
    'config smoke',
    'cli smoke',
  ]);
  const config = configSmoke('/live');
  expect(config.argv).toEqual(['bun', 'tools/goal/scripts/cp-config-smoke.ts']);
  expect(config.env?.('/sync')).toEqual({
    GOAL_MAIN_CHECKOUT: '/live',
    GOAL_LOCAL_CONFIG: '/live/.temp/goal/local.json',
  });
  const smoke = cliSmoke('/live');
  expect(smoke.argv).toEqual(['bun', 'tools/goal/src/cli.ts', 'status']);
  expect(smoke.env?.('/sync')).toEqual({
    GOAL_MAIN_CHECKOUT: '/live',
    GOAL_LOCAL_CONFIG: '/live/.temp/goal/local.json',
    GOAL_STATE_DIRECTORY: `/sync/${SMOKE_STATE}`,
    GOAL_MANAGER: 'cp-sync-smoke',
  });
});

test('config smoke parses live numbered routing; status smoke misses a routing-shape mismatch and a refusal leaves live state', async () => {
  const f = fixture();
  const secret = 'sk-live-secret-value-1234';
  const localFile = join(f.repo, '.temp/goal/local.json');
  const routingFile = join(f.repo, '.temp/goal/routing.json');
  const routing = JSON.parse(readFileSync(join(import.meta.dir, '../routing.json'), 'utf8')) as Record<string, unknown>;
  const local = {
    version: 1,
    routingFile: '.temp/goal/routing.json',
    pools: [
      {
        name: 'fixture',
        cli: 'codex',
        classes: ['codex'],
        configDirectory: '.temp/goal/account',
        command: 'codex',
        allowanceKey: secret,
        policy: { weight: 1, reservePercent: 0, allowUnknown: true, maxAgeMs: 60_000 },
      },
    ],
  };
  const writeRouting = (version: unknown) => {
    mkdirSync(dirname(routingFile), { recursive: true });
    writeFileSync(routingFile, JSON.stringify({ ...routing, version }));
  };
  const writeLocal = (body: typeof local) => {
    mkdirSync(dirname(localFile), { recursive: true });
    writeFileSync(localFile, JSON.stringify(body));
  };
  writeLocal(local);
  writeRouting(24);
  const env = {
    ...childEnvironment(),
    GOAL_MAIN_CHECKOUT: f.repo,
    GOAL_LOCAL_CONFIG: localFile,
  };
  const smokeScript = join(import.meta.dir, '../scripts/cp-config-smoke.ts');
  const runSmoke = () => spawnSync(process.execPath, [smokeScript], { encoding: 'utf8', env, cwd: f.repo });
  const gate: Check = { ...configSmoke(f.repo), argv: [process.execPath, smokeScript] };

  const compatible = runSmoke();
  expect(compatible.status).toBe(0);
  expect(compatible.stdout).toContain(localFile);
  expect(compatible.stdout).toContain(routingFile);
  expect(existsSync(join(f.repo, '.temp/goal/configuration'))).toBe(false);
  expect(existsSync(join(f.repo, '.temp/goal/goal.sqlite'))).toBe(false);

  writeRouting(0);
  const statusOnly = spawnSync(
    process.execPath,
    ['-e', `import { loadSettings } from ${JSON.stringify(join(import.meta.dir, 'config.ts'))}; loadSettings();`],
    { encoding: 'utf8', env, cwd: f.repo },
  );
  expect(statusOnly.status).toBe(0);

  const refs = () => git(f.repo, 'rev-parse', 'main', 'stabilize', 'dev');
  const before = refs();
  const routingBefore = readFileSync(routingFile);
  const localBefore = readFileSync(localFile);
  const refused = runSmoke();
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain(routingFile);
  expect(refused.stderr).toContain('version');
  expect(refused.stderr).not.toContain(secret);
  expect(readFileSync(routingFile)).toEqual(routingBefore);
  expect(readFileSync(localFile)).toEqual(localBefore);
  expect(await sync({ ...f.options, checks: [gate] })).toBe(1);
  expect(refs()).toBe(before);
  expect(readFileSync(routingFile)).toEqual(routingBefore);

  writeRouting(24);
  writeLocal({ ...local, version: 2 });
  const badLocal = runSmoke();
  expect(badLocal.status).toBe(1);
  expect(badLocal.stderr).toContain(localFile);
  expect(badLocal.stderr).toMatch(/version/);
  expect(badLocal.stderr).not.toContain(secret);

  writeLocal(local);
  expect(await sync({ ...f.options, checks: [gate] })).toBe(0);
  expect(git(f.repo, 'rev-parse', 'main')).not.toBe(f.main);
});

test('the smoke reads a copy of the live Goal database and never writes the original', async () => {
  const f = fixture();
  const live = join(f.repo, '.temp/goal/goal.sqlite');
  mkdirSync(dirname(live), { recursive: true });
  const db = new Database(live);
  db.run('CREATE TABLE marker (value TEXT)');
  db.run("INSERT INTO marker VALUES ('live')");
  db.close();
  const before = createHash('sha256').update(readFileSync(live)).digest('hex');
  const probe = `const { Database } = require('bun:sqlite');
const db = new Database(require('path').join(process.env.GOAL_STATE_DIRECTORY, 'goal.sqlite'));
db.run("INSERT INTO marker VALUES ('copy')");
const ok = db.query('SELECT count(*) AS n FROM marker').get().n === 2 && process.env.GOAL_MAIN_CHECKOUT === ${JSON.stringify(f.repo)};
process.exit(ok && process.env.GOAL_MANAGER === 'cp-sync-smoke' ? 0 : 5);`;
  const smoke: Check = { ...cliSmoke(f.repo), argv: [process.execPath, '-e', probe] };
  expect(await sync({ ...f.options, checks: [smoke] })).toBe(0);
  expect(f.lines).toContain('cp-sync: smoke state: read-only copy of the live Goal database');
  expect(createHash('sha256').update(readFileSync(live)).digest('hex')).toBe(before);
});

test('a sync publishes only dev tools/goal to main, merges it into stabilize and dev, and updates the checkout', async () => {
  const f = fixture();
  const devTree = git(f.repo, 'rev-parse', 'dev^{tree}');
  // The checks see the committed candidate as HEAD, as the main-release proof does.
  const sourceGoal = git(f.repo, 'rev-parse', `${f.source}:tools/goal`);
  const headIsCandidate = `const r = require('child_process').spawnSync('git', ['rev-parse', 'HEAD:tools/goal'], { encoding: 'utf8' });
process.exit(r.stdout.trim() === ${JSON.stringify(sourceGoal)} && r.status === 0 ? 0 : 4);`;
  const checks = [{ name: 'check', argv: [process.execPath, '-e', headIsCandidate], timeoutMs: 60_000 }];
  expect(await sync({ ...f.options, checks })).toBe(0);

  const main = git(f.repo, 'rev-parse', 'main');
  expect(git(f.repo, 'rev-parse', 'main^')).toBe(f.main);
  expect(git(f.repo, 'log', '-1', '--format=%s', 'main')).toBe(
    `control-plane: sync tools/goal from dev ${f.source.slice(0, 10)}`,
  );
  expect(git(f.repo, 'rev-parse', 'main:tools/goal')).toBe(git(f.repo, 'rev-parse', `${f.source}:tools/goal`));
  expect(git(f.repo, 'show', 'main:scripts/x.ts')).toBe('export const x = 1;');
  expect(git(f.repo, 'show', 'main:README.md')).toBe('product');
  expect(readFileSync(join(f.repo, 'tools/goal/src/new.ts'), 'utf8')).toContain('added');
  expect(existsSync(join(f.repo, 'tools/goal/src/gone.ts'))).toBe(false);
  expect(git(f.repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');

  git(f.repo, 'merge-base', '--is-ancestor', main, 'stabilize');
  git(f.repo, 'merge-base', '--is-ancestor', 'stabilize', 'dev');
  expect(git(f.repo, 'rev-parse', 'stabilize:tools/goal')).toBe(git(f.repo, 'rev-parse', 'main:tools/goal'));
  expect(git(f.repo, 'show', 'stabilize:README.md')).toBe('product');
  expect(git(f.repo, 'rev-parse', 'dev^{tree}')).toBe(devTree);

  const [entry] = history(f.repo);
  expect(entry).toMatchObject({ action: 'sync', main: { previous: f.main, current: main }, source: f.source });
  expect(f.lines.some((line) => /runtime\s+differs\s+scripts\/x\.ts/.test(line))).toBe(true);
  expect(existsSync(f.options.worktreeRoot) && git(f.repo, 'worktree', 'list').includes('cp-sync-')).toBe(false);
  expect(await sync(f.options)).toBe(0);
  expect(git(f.repo, 'rev-parse', 'main')).toBe(main);
});

test('a failed check, a dry run and a dirty checkout leave every ref and the checkout alone', async () => {
  const f = fixture();
  const refs = () => git(f.repo, 'rev-parse', 'main', 'stabilize', 'dev');
  const before = refs();
  const failing = [{ name: 'check', argv: [process.execPath, '-e', 'process.exit(3)'], timeoutMs: 60_000 }];
  expect(await sync({ ...f.options, checks: failing })).toBe(1);
  expect(f.lines.some((line) => /check: exit 3/.test(line))).toBe(true);
  expect(await sync({ ...f.options, dryRun: true })).toBe(0);
  expect(f.lines.some((line) => line.startsWith('cp-sync: would move refs/heads/main'))).toBe(true);
  expect(refs()).toBe(before);
  expect(history(f.repo)).toEqual([]);

  const marker = join(f.repo, '.temp/ran');
  const marking = [
    {
      name: 'check',
      argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`],
      timeoutMs: 60_000,
    },
  ];
  write(f.repo, 'tools/goal/src/a.ts', 'local edit\n');
  await expect(sync({ ...f.options, checks: marking })).rejects.toThrow(/uncommitted changes under tools\/goal/);
  expect(existsSync(marker)).toBe(false);
  expect(await sync({ ...f.options, checks: marking, dryRun: true })).toBe(1);
  expect(refs()).toBe(before);
});

test('a dry run still reports the suite after a failed type check, but not after a failed install', async () => {
  const f = fixture();
  const marker = join(f.repo, '.temp/suite-ran');
  const suite = {
    name: 'test suite',
    argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`],
    timeoutMs: 60_000,
  };
  const fail = (prepares: boolean): Check => ({
    name: prepares ? 'install' : 'type check',
    argv: [process.execPath, '-e', 'process.exit(2)'],
    timeoutMs: 60_000,
    kind: prepares ? 'prepare' : 'typecheck',
  });
  expect(await sync({ ...f.options, dryRun: true, checks: [fail(true), suite] })).toBe(1);
  expect(existsSync(marker)).toBe(false);
  expect(await sync({ ...f.options, checks: [fail(false), suite] })).toBe(1);
  expect(existsSync(marker)).toBe(false);
  expect(await sync({ ...f.options, dryRun: true, checks: [fail(false), suite] })).toBe(1);
  expect(existsSync(marker)).toBe(true);
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.main);
});

// Fails `old` everywhere and, on the candidate (which has dev's new.ts), the configured `added` tests; a rerun of
// files fails only those also listed in `rerunFails`. Prints bun's layout, closing recap included.
const FAKE_SUITE = `const fs = require('fs');
const [config, runs, mode] = process.argv.slice(2);
const { added, rerunFails } = JSON.parse(fs.readFileSync(config, 'utf8'));
const candidate = fs.existsSync('tools/goal/src/new.ts');
let fails = ['old', ...(candidate ? added : [])];
if (mode === 'rerun') fails = fails.filter((name) => rerunFails.includes(name));
const out = ['tools/goal/src/s.test.ts:', ...fails.map((name) => '(fail) ' + name + ' [1.00ms]'), '(pass) fine [1.00ms]'];
out.push('', ' 1 pass', ' ' + fails.length + ' fail', 'Ran ' + (fails.length + 1) + ' tests across 1 file. [0.10s]');
if (fails.length) out.push('', fails.length + ' tests failed:', ...fails.map((name) => '(fail) ' + name));
console.log(out.join('\\n'));
fs.appendFileSync(runs, (candidate ? 'candidate ' : 'main ') + mode + '\\n');
process.exit(fails.length ? 1 : 0);
`;

test('a failing suite passes only where unmodified main fails the same tests, and main is checked once', async () => {
  const f = fixture();
  const script = join(f.root, 'fake-suite.js');
  const config = join(f.root, 'suite.json');
  const runs = join(f.root, 'runs.log');
  writeFileSync(script, FAKE_SUITE);
  const suite: Check = {
    name: 'test suite',
    argv: [process.execPath, script, config, runs, 'full'],
    timeoutMs: 60_000,
    kind: 'suite',
    rerun: (files) => [process.execPath, script, config, runs, 'rerun', ...files],
  };
  const configure = (added: string[], rerunFails: string[]) =>
    writeFileSync(config, JSON.stringify({ added, rerunFails }));

  configure(['new'], ['new']);
  expect(await sync({ ...f.options, dryRun: true, checks: [suite] })).toBe(1);
  expect(f.lines).toContain('  (NEW failure) tools/goal/src/s.test.ts > new');
  expect(f.lines).toContain('  (fail on main too) tools/goal/src/s.test.ts > old');

  configure(['new'], []);
  expect(await sync({ ...f.options, dryRun: true, checks: [suite] })).toBe(0);
  expect(f.lines).toContain('  (failed, then passed on rerun) tools/goal/src/s.test.ts > new');

  configure([], []);
  expect(await sync({ ...f.options, checks: [suite] })).toBe(0);
  expect(readFileSync(runs, 'utf8').trim().split('\n')).toEqual([
    'candidate full',
    'main full',
    'candidate rerun',
    'candidate full',
    'candidate rerun',
    'candidate full',
  ]);
  const published = git(f.repo, 'rev-parse', 'main');
  const states = join(f.repo, '.temp/goal/cp-sync');
  const next = readdirSync(states).find((name) => name.startsWith(`baseline-${published}-`));
  expect(JSON.parse(readFileSync(join(states, next!), 'utf8')).failures).toEqual(['tools/goal/src/s.test.ts > old']);
});

test('a timed-out check is stopped and refuses the sync', async () => {
  const f = fixture();
  const slow: Check[] = [
    {
      name: 'test suite',
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
      timeoutMs: 200,
      kind: 'suite',
    },
  ];
  const started = Date.now();
  expect(await sync({ ...f.options, checks: slow })).toBe(1);
  expect(Date.now() - started).toBeLessThan(30_000);
  expect(f.lines.some((line) => /TIMED OUT/.test(line))).toBe(true);
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.main);
});

test('an included root path is synced too', async () => {
  const f = fixture();
  expect(await sync({ ...f.options, includes: ['scripts'] })).toBe(0);
  expect(git(f.repo, 'show', 'main:scripts/y.ts')).toBe('export const y = 2;');
  expect(git(f.repo, 'show', 'main:README.md')).toBe('product');
  expect(history(f.repo)[0]?.paths).toEqual(['tools/goal', 'scripts']);
  await expect(sync({ ...f.options, includes: ['tools/goal/src'] })).rejects.toThrow(Refusal);
});

test('a rollback commits the previous tools/goal forward and refuses once main moved', async () => {
  const f = fixture();
  expect(await sync(f.options)).toBe(0);
  const synced = git(f.repo, 'rev-parse', 'main');
  expect(await rollback(f.options)).toBe(0);
  expect(git(f.repo, 'rev-parse', 'main^')).toBe(synced);
  expect(git(f.repo, 'rev-parse', 'main^{tree}')).toBe(git(f.repo, 'rev-parse', `${f.main}^{tree}`));
  expect(existsSync(join(f.repo, 'tools/goal/src/gone.ts'))).toBe(true);
  expect(existsSync(join(f.repo, 'tools/goal/src/new.ts'))).toBe(false);
  expect(git(f.repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  git(f.repo, 'merge-base', '--is-ancestor', 'main', 'stabilize');
  git(f.repo, 'merge-base', '--is-ancestor', 'main', 'dev');
  expect(history(f.repo).map((entry) => entry.action)).toEqual(['sync', 'rollback']);
  await expect(rollback(f.options)).rejects.toThrow(/already rolled back/);

  expect(await sync(f.options)).toBe(0);
  write(f.repo, 'README.md', 'main moved\n');
  git(f.repo, 'commit', '-qam', 'Move main');
  await expect(rollback(f.options)).rejects.toThrow(/moved since the last cp-sync/);
});

test('root references follow relative imports out of tools/goal', () => {
  const f = fixture();
  expect(rootReferences(f.repo, f.main, f.source)).toEqual([
    { path: 'scripts/x.ts', runtime: true, status: 'differs', from: 'tools/goal/src/a.ts' },
    { path: 'scripts/y.ts', runtime: true, status: 'dev only', from: 'scripts/x.ts' },
  ]);
});

test('secrets stay out of output and child environments', () => {
  const env = { API_TOKEN: 'abcdefgh12345678', GOAL_DB: '/live.sqlite', CODEX_THREAD_ID: 't', PATH: '/bin' };
  expect(redact('token abcdefgh12345678 and sk-0123456789abcdefghij', env)).toBe('token [redacted] and [redacted]');
  expect(childEnvironment(env)).toEqual({ PATH: '/bin' });
});

test('test output and arguments parse', () => {
  const output = [
    'src/one.test.ts:',
    '(pass) a [1.00ms]',
    '(fail) b > c [2.50ms]',
    '',
    'src/two.test.ts:',
    '(fail) d',
    '',
    ' 1 pass',
    ' 2 fail',
    'Ran 3 tests across 2 files. [1.20s]',
    '',
    '2 tests failed:',
    '(fail) b > c [2.50ms]',
    '(fail) d',
  ].join('\n');
  expect(summarizeTests(output)).toEqual({
    failures: ['src/one.test.ts > b > c', 'src/two.test.ts > d'],
    pass: 1,
    fail: 2,
    ran: 'Ran 3 tests across 2 files. [1.20s]',
  });
  expect(parseArguments(['--dry-run', '--include', 'scripts/a.ts'])).toEqual({
    dryRun: true,
    includes: ['scripts/a.ts'],
  });
  expect(parseArguments(['--rollback', '--include', 'x'])).toBeUndefined();
  expect(parseArguments(['--force'])).toBeUndefined();
});
