import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyseStatements, releaseCheck } from '../scripts/analyse.ts';

const KERNEL_ROOT = resolve(import.meta.dir, '..');

function temporaryDirectory(): string {
  const root = resolve(KERNEL_ROOT, '.temp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(resolve(root, 'analyse-'));
}

test('a release analysis serves every .sql statement with no database connection', async () => {
  const directory = temporaryDirectory();
  try {
    const statements = await analyseStatements(process.env.DATABASE_URL!, directory);
    expect(statements).toBe(Array.from(new Bun.Glob('src/**/*.sql').scanSync({ cwd: KERNEL_ROOT })).length);
    expect(readdirSync(resolve(directory, '.reylo/queries')).length).toBeGreaterThan(0);
    await releaseCheck(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 600_000);

test('the release check fails naming a statement without an entry', async () => {
  const directory = temporaryDirectory();
  try {
    await analyseStatements(process.env.DATABASE_URL!, directory);
    const queries = resolve(directory, '.reylo/queries');
    const [entry] = readdirSync(queries).filter((name) => name.endsWith('.json'));
    expect(entry).toBeDefined();
    rmSync(resolve(queries, entry!));

    const error = await releaseCheck(directory).then(
      () => null,
      (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
    );
    expect(error).not.toBeNull();
    // Statements with identical text share an entry, so the message may name several files; each must be real.
    const named = error!.message.match(/src\/\S+\.sql/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const file of named) expect(existsSync(resolve(KERNEL_ROOT, file))).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 600_000);
