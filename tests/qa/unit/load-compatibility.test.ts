import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compatibleLoadStorage, loadCompatibility,
  preparedLoadSourceMode } from '../../../scripts/load/compatibility.ts';

const root = resolve(import.meta.dir, '../../..');

test('OPS05: a stopped-state load source rejects changed schema and analyzer inputs', () => {
  const source = loadCompatibility(root);
  const fixture = mkdtempSync(join(root, '.temp', 'load-compatibility-'));
  try {
    for (const path of Object.keys(source.files)) {
      const target = join(fixture, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(root, path)));
    }
    expect(loadCompatibility(fixture)).toEqual(source);
    const analyzer = join(fixture, 'infra/jena/fuseki-text.ttl');
    writeFileSync(analyzer, readFileSync(analyzer, 'utf8') + '\n# changed analyzer fixture\n');
    expect(loadCompatibility(fixture).digest).not.toBe(source.digest);
    writeFileSync(analyzer, readFileSync(join(root, 'infra/jena/fuseki-text.ttl')));
    const migration = join(fixture, 'services/content/migrations/001_core.sql');
    writeFileSync(migration, readFileSync(migration, 'utf8') + '\n-- changed schema fixture\n');
    expect(loadCompatibility(fixture).digest).not.toBe(source.digest);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('OPS05: code-only clone reuse requires explicit clean source and matching physical compatibility', () => {
  const original = { fingerprint: 'a'.repeat(64), clean: true };
  const current = { fingerprint: 'b'.repeat(64), clean: true };
  const physical = loadCompatibility(root);
  const legacy = { digest: 'c'.repeat(64), files: { ...physical.files,
    'services/account/src/auth.ts': 'd'.repeat(64),
    'services/account/src/migrate.ts': 'e'.repeat(64),
    'services/content/src/migrate.ts': 'f'.repeat(64) } };
  expect(compatibleLoadStorage(legacy, physical)).toBe(true);
  const run = { mode: 'prepare', sourceStable: true, works: 9_900,
    baselineDigest: 'manifest', compatibility: legacy, source: original };
  expect(preparedLoadSourceMode(run, original, 9_900, 'manifest', physical, false))
    .toBe('exact-source');
  expect(() => preparedLoadSourceMode(run, current, 9_900, 'manifest', physical, false))
    .toThrow('requires opt-in');
  expect(preparedLoadSourceMode(run, current, 9_900, 'manifest', physical, true))
    .toBe('compatible-source');
  for (const changed of [
    { ...run, sourceStable: false },
    { ...run, baselineDigest: 'other' },
    { ...run, compatibility: { ...legacy, files: { ...legacy.files,
      'services/content/migrations/001_core.sql': '0'.repeat(64) } } },
    { ...run, works: 9_899 },
  ]) {
    expect(() => preparedLoadSourceMode(changed, current, 9_900, 'manifest', physical, true))
      .toThrow();
  }
  expect(() => preparedLoadSourceMode({ ...run, source: { ...original, clean: false } },
    current, 9_900, 'manifest', physical, true)).toThrow('clean compatible source');
  expect(() => preparedLoadSourceMode(run, { ...current, clean: false },
    9_900, 'manifest', physical, true)).toThrow('clean compatible source');
});
