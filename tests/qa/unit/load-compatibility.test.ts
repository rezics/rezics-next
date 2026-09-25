import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadCompatibility } from '../../../scripts/load/compatibility.ts';

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
