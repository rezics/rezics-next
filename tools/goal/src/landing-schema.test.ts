import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { regenerateLandingSchema } from './landing-schema.ts';
import { temporaryDirectory } from './test-support.ts';

// A stand-in for the Kernel dump command, which needs a throwaway Postgres: it derives the dump from the migrations and
// records each run outside the tree. The package script is the real route: `bun run --cwd services/kernel derived schema`.
const GENERATOR = [
  "import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';",
  "appendFileSync(process.env.DERIVED_RUN_LOG, process.argv.slice(2).join(' ') + ' in ' + process.cwd() + '\\n');",
  "const migrations = readdirSync('db/access/migrations').sort().map((name) => readFileSync('db/access/migrations/' + name, 'utf8'));",
  'const failure = migrations.join(\'\').match(/^-- fail: (.+)$/m);',
  'if (failure) {',
  "  console.error('ERROR: ' + failure[1]);",
  '  process.exit(1);',
  '}',
  "writeFileSync('db/access/schema.sql', '-- derived\\n' + migrations.join(''));",
].join('\n');

const FIRST_MIGRATION = 'create table accounts ();\n';
const RECOVERY_MIGRATION = 'alter table accounts add recovery text;\n';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(root: string, message: string): string {
  git(root, 'add', '--', '.');
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function kernelFixture() {
  const fixture = temporaryDirectory();
  const root = fixture.path;
  git(root, 'init', '-b', 'dev');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  put(root, '.gitignore', '.temp/\n');
  put(root, 'services/kernel/package.json', JSON.stringify({ private: true, scripts: { derived: 'bun scripts/derived.ts' } }));
  put(root, 'services/kernel/scripts/derived.ts', GENERATOR);
  put(root, 'services/kernel/db/access/migrations/001_accounts.sql', FIRST_MIGRATION);
  put(root, 'services/kernel/db/access/schema.sql', `-- derived\n${FIRST_MIGRATION}`);
  put(root, 'src/value.ts', 'export const value = 1;\n');
  const base = commit(root, 'Seed kernel fixture');
  return { root, base, close: fixture.close };
}

function regenerate(root: string, changedFiles: readonly string[]) {
  process.env.DERIVED_RUN_LOG = join(root, '.temp', 'derived-runs.log');
  return regenerateLandingSchema({
    cwd: root,
    changedFiles,
    taskId: 'task-1',
    logPath: join(root, '.temp', 'landing.log'),
  });
}

test('a candidate that changes a migration regenerates its schema dumps and commits the changed dump onto it', async () => {
  const fixture = kernelFixture();
  try {
    const { root, base } = fixture;
    put(root, 'services/kernel/db/access/migrations/002_recovery.sql', RECOVERY_MIGRATION);
    const candidate = commit(root, 'Add recovery to accounts');

    const result = await regenerate(root, git(root, 'diff', '--name-only', base, candidate).split('\n'));

    expect(result).toMatchObject({ outcome: 'committed', message: null });
    expect(result.candidate).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'rev-parse', 'HEAD^')).toBe(candidate);
    expect(git(root, 'log', '-1', '--format=%s')).toBe('chore(kernel): regenerate schema dumps for task-1');
    expect(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe(
      'services/kernel/db/access/schema.sql',
    );
    expect(readFileSync(join(root, 'services/kernel/db/access/schema.sql'), 'utf8')).toContain(RECOVERY_MIGRATION);
    expect(readFileSync(join(root, '.temp', 'derived-runs.log'), 'utf8')).toBe('schema in ' + join(root, 'services/kernel') + '\n');
    expect(readFileSync(join(root, '.temp', 'landing.log'), 'utf8')).toContain(
      '$ bun run --cwd services/kernel derived schema',
    );
  } finally {
    fixture.close();
  }
});

test('a candidate that changes no migration runs no regeneration', async () => {
  const fixture = kernelFixture();
  try {
    const { root, base } = fixture;
    put(root, 'src/value.ts', 'export const value = 2;\n');
    const candidate = commit(root, 'Change a source value');

    const result = await regenerate(root, git(root, 'diff', '--name-only', base, candidate).split('\n'));

    expect(result).toEqual({
      outcome: 'skipped',
      candidate,
      elapsedMs: null,
      logPath: join(root, '.temp', 'landing.log'),
      message: null,
    });
    expect(existsSync(join(root, '.temp', 'derived-runs.log'))).toBe(false);
  } finally {
    fixture.close();
  }
});

test('a failed regeneration returns its first error as a handback and commits nothing', async () => {
  const fixture = kernelFixture();
  try {
    const { root, base } = fixture;
    put(root, 'services/kernel/db/access/migrations/002_broken.sql', '-- fail: relation "accounts_missing" does not exist\n');
    const candidate = commit(root, 'Add a migration that does not apply');

    const result = await regenerate(root, git(root, 'diff', '--name-only', base, candidate).split('\n'));

    expect(result).toMatchObject({
      outcome: 'diagnostic',
      candidate,
      message: 'ERROR: relation "accounts_missing" does not exist',
    });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(candidate);
    expect(readFileSync(join(root, '.temp', 'landing.log'), 'utf8')).toContain(
      'Schema dump regeneration failed in',
    );
  } finally {
    fixture.close();
  }
});

test('dumps that the migrations already reproduce add no commit', async () => {
  const fixture = kernelFixture();
  try {
    const { root, base } = fixture;
    put(root, 'services/kernel/db/access/migrations/002_recovery.sql', RECOVERY_MIGRATION);
    put(root, 'services/kernel/db/access/schema.sql', `-- derived\n${FIRST_MIGRATION}${RECOVERY_MIGRATION}`);
    const candidate = commit(root, 'Add recovery with its dump');

    const result = await regenerate(root, git(root, 'diff', '--name-only', base, candidate).split('\n'));

    expect(result).toMatchObject({ outcome: 'unchanged', candidate, message: null });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(candidate);
  } finally {
    fixture.close();
  }
});
