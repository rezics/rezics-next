import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { retainSharedSeedIntake } from './intake-cache.ts';

function fixture(operation: (root: string, source: string, file: string) => void) {
  const temporary = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'g-909-intake-'));
  const root = join(directory, 'worktree'), source = join(directory, 'source');
  const file = `${'a'.repeat(64)}.json`;
  for (const checkout of [root, source]) mkdirSync(join(checkout, '.temp/catalogue-intake'), { recursive: true });
  try { operation(root, source, file); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

const evidence = (candidateReceipt: string, fingerprint = 'b'.repeat(64)) =>
  JSON.stringify({ fingerprint, candidateReceipt });
const original = evidence('00000000-0000-4000-a000-000000000001');
const fresh = evidence('00000000-0000-4000-a000-000000000002');

test('G-909: a shared-stack seed reuses the original creation evidence and leaves the source untouched', () => {
  fixture((root, source, file) => {
    const sourcePath = join(source, '.temp/catalogue-intake', file);
    const destination = join(root, '.temp/catalogue-intake', file);
    writeFileSync(sourcePath, original);
    writeFileSync(destination, fresh);
    expect(retainSharedSeedIntake(root, source)).toBe(1);
    expect(readFileSync(destination, 'utf8')).toBe(original);
    expect(readFileSync(sourcePath, 'utf8')).toBe(original);
    expect(retainSharedSeedIntake(root, source)).toBe(0);
  });
});

test('G-909: a new worktree imports missing evidence, while a changed intent fails before replacing it', () => {
  fixture((root, source, file) => {
    const sourcePath = join(source, '.temp/catalogue-intake', file);
    const destination = join(root, '.temp/catalogue-intake', file);
    writeFileSync(sourcePath, original);
    expect(retainSharedSeedIntake(root, source)).toBe(1);
    const changed = evidence('00000000-0000-4000-a000-000000000002', 'c'.repeat(64));
    writeFileSync(destination, changed);
    expect(() => retainSharedSeedIntake(root, source)).toThrow('intent differs');
    expect(readFileSync(destination, 'utf8')).toBe(changed);
    expect(readFileSync(sourcePath, 'utf8')).toBe(original);
  });
});
