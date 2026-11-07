import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb } from '../src/db.ts';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkpointFastPublication, preserveMainHotfixes, type PreservationConflict } from './cp-fast-preserve.ts';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture() {
  const temporaryRoot = join(import.meta.dir, '../../../.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const checkout = mkdtempSync(join(temporaryRoot, 'cp-fast-preserve-test-'));
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.email', 'test@example.invalid');
  git(checkout, 'config', 'user.name', 'Test');
  writeFileSync(join(checkout, '.gitignore'), '.temp/\n');
  writeFileSync(join(checkout, 'resident.ts'), 'const resident = "old";\n');
  writeFileSync(join(checkout, 'product.ts'), 'const product = "old";\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-qm', 'Initial');
  git(checkout, 'branch', 'dev');
  // A full snapshot deliberately has a separate commit from the source dev history.
  const source = git(checkout, 'rev-parse', 'dev');
  git(checkout, 'commit', '--allow-empty', '-qm', `control-plane: fast sync from dev ${source.slice(0, 10)}`);
  const published = git(checkout, 'rev-parse', 'main');
  const stateFile = join(checkout, '.temp/goal/watch/cp-fast-state.json');
  const notices: PreservationConflict[] = [];
  const options = { checkout, stateFile, notify: (conflict: PreservationConflict) => { notices.push(conflict); } };
  return {
    ...options, options, notices, published, source,
    commit(branch: string, file: string, contents: string) {
      git(checkout, 'checkout', '-q', branch);
      writeFileSync(join(checkout, file), contents);
      git(checkout, 'add', file);
      git(checkout, 'commit', '-qm', `Update ${file}`);
      git(checkout, 'checkout', '-q', 'main');
    },
    publish(source: string) {
      git(checkout, 'restore', `--source=${source}`, '--staged', '--worktree', '--', '.');
      git(checkout, 'commit', '-qm', `control-plane: fast sync from dev ${source.slice(0, 10)}`);
      checkpointFastPublication(checkout, stateFile, 'main', source);
    },
    dispose() { rmSync(checkout, { recursive: true, force: true }); },
  };
}

test('a main-only hotfix survives the next full snapshot alongside concurrent disjoint dev work, and adoption is idempotent', async () => {
  const f = fixture();
  try {
    f.commit('main', 'resident.ts', 'const resident = "paste fixed";\n');
    const hotfix = git(f.checkout, 'rev-parse', 'main');
    f.commit('dev', 'product.ts', 'const product = "new feature";\n');
    const result = await preserveMainHotfixes(f.options);
    expect(result.status).toBe('ready');
    expect(result.main).toBe(hotfix);
    expect(git(f.checkout, 'show', 'dev:resident.ts')).toContain('paste fixed');
    expect(git(f.checkout, 'show', 'dev:product.ts')).toContain('new feature');
    expect(git(f.checkout, 'show', 'main:product.ts')).toContain('old');
    expect(await preserveMainHotfixes(f.options)).toEqual(result);
    expect(git(f.checkout, 'rev-parse', 'dev')).toBe(result.dev);
    f.publish(result.dev);
    expect(readFileSync(join(f.checkout, 'resident.ts'), 'utf8')).toContain('paste fixed');
    const afterPublish = await preserveMainHotfixes(f.options);
    expect(afterPublish.dev).toBe(result.dev);
    expect(f.notices).toEqual([]);
    // A later main fix is a delta against the successful checkpoint, not against old shared ancestry.
    f.commit('main', 'resident.ts', 'const resident = "second fix";\n');
    f.commit('dev', 'product.ts', 'const product = "another feature";\n');
    const later = await preserveMainHotfixes(f.options);
    f.publish(later.dev);
    expect(readFileSync(join(f.checkout, 'resident.ts'), 'utf8')).toContain('second fix');
    expect(readFileSync(join(f.checkout, 'product.ts'), 'utf8')).toContain('another feature');
  } finally { f.dispose(); }
});

test('a genuine overlap holds only publication, leaves current main/dev intact, and asks the owner once until reconciled', async () => {
  const f = fixture();
  try {
    f.commit('main', 'resident.ts', 'const resident = "hotfix";\n');
    f.commit('dev', 'resident.ts', 'const resident = "dev implementation";\n');
    const main = git(f.checkout, 'rev-parse', 'main');
    const dev = git(f.checkout, 'rev-parse', 'dev');
    expect(await preserveMainHotfixes(f.options)).toEqual({ status: 'conflict', main, dev });
    expect(await preserveMainHotfixes(f.options)).toEqual({ status: 'conflict', main, dev });
    expect(f.notices).toEqual([{ base: f.published, main, dev, paths: ['resident.ts'] }]);
    // Unrelated product work does not create another repeated wake-up or become a failed task.
    f.commit('dev', 'product.ts', 'const product = "work continues";\n');
    expect((await preserveMainHotfixes(f.options)).status).toBe('conflict');
    expect(f.notices).toHaveLength(1);
    expect(git(f.checkout, 'rev-parse', 'main')).toBe(main);
    expect(readFileSync(join(f.checkout, 'resident.ts'), 'utf8')).toContain('hotfix');
    f.commit('dev', 'resident.ts', 'const resident = "hotfix";\n');
    const reconciledDev = git(f.checkout, 'rev-parse', 'dev');
    const reconciled = await preserveMainHotfixes(f.options);
    expect(reconciled.status).toBe('ready');
    expect(reconciled.dev).toBe(reconciledDev);
    f.publish(reconciled.dev);
    expect(readFileSync(join(f.checkout, 'resident.ts'), 'utf8')).toContain('hotfix');
    expect(readFileSync(join(f.checkout, 'product.ts'), 'utf8')).toContain('work continues');
  } finally { f.dispose(); }
});

test('checkpoint verifies the entire source tree and bootstrap rejects forged snapshot metadata', async () => {
  const f = fixture();
  try {
    f.commit('main', 'resident.ts', 'const resident = "hotfix";\n');
    expect(() => checkpointFastPublication(f.checkout, f.stateFile, 'main', 'dev')).toThrow('source tree');
    git(f.checkout, 'commit', '--allow-empty', '-qm', `control-plane: fast sync from dev ${f.source.slice(0, 10)}`);
    await expect(preserveMainHotfixes(f.options)).rejects.toThrow('source tree');
    expect(git(f.checkout, 'show', 'main:resident.ts')).toContain('hotfix');
  } finally { f.dispose(); }
});

test('a crash after the adoption ref update can replay without making a duplicate commit', async () => {
  const f = fixture();
  try {
    checkpointFastPublication(f.checkout, f.stateFile, f.published, f.source);
    const before = readFileSync(f.stateFile, 'utf8');
    f.commit('main', 'resident.ts', 'const resident = "hotfix";\n');
    const result = await preserveMainHotfixes(f.options);
    writeFileSync(f.stateFile, before);
    expect(await preserveMainHotfixes(f.options)).toEqual(result);
    expect(git(f.checkout, 'rev-parse', 'dev')).toBe(result.dev);
  } finally { f.dispose(); }
});

test('the timer CLI surfaces an overlap once through the native owner inbox without a manager login', () => {
  const f = fixture();
  try {
    f.commit('main', 'resident.ts', 'const resident = "hotfix";\n');
    f.commit('dev', 'resident.ts', 'const resident = "overlap";\n');
    const stateDirectory = join(f.checkout, '.temp/goal');
    mkdirSync(stateDirectory, { recursive: true });
    const databasePath = join(stateDirectory, 'goal.sqlite');
    openDb(databasePath).close();
    for (let call = 0; call < 2; call++) {
      const result = spawnSync(process.execPath, [join(import.meta.dir, 'cp-fast-preserve.ts'), 'prepare', 'fixture-owner'], {
        cwd: f.checkout, encoding: 'utf8',
        env: { ...process.env, GOAL_MAIN_CHECKOUT: f.checkout, GOAL_STATE_DIRECTORY: stateDirectory },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
    }
    const db = new Database(databasePath, { readonly: true });
    try {
      const rows = db.query('SELECT event, delivery_count FROM manager_inbox').all() as { event: string; delivery_count: number }[];
      expect(rows).toHaveLength(1);
      const event = JSON.parse(rows[0]!.event);
      expect(event.managerId).toBe('fixture-owner');
      expect(event.kind).toBe('question');
      expect(event.summary).toContain('resident.ts');
      expect(event.evidencePath).toBe(join(stateDirectory, 'watch/cp-fast-conflict.json'));
      expect(rows[0]!.delivery_count).toBe(1);
    } finally { db.close(); }
    expect(git(f.checkout, 'show', 'main:resident.ts')).toContain('hotfix');
  } finally { f.dispose(); }
});
