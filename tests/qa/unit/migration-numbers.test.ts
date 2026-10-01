import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// The release migrator refuses two files with one number in a directory, but QA
// bootstraps apply SQL files without that check, so a collision (two parallel
// tasks both taking Access 983) passed every QA run and failed only at release.
const root = join(import.meta.dir, '../../..');
const directories = [
  'services/main/migrations/access',
  'services/main/migrations/relay',
  'services/content/migrations',
  'services/account/migrations',
];

test('every migration directory numbers each file uniquely', () => {
  const duplicates = directories.flatMap(directory => {
    const seen = new Map<string, string[]>();
    for (const file of readdirSync(join(root, directory)).filter(name => name.endsWith('.sql'))) {
      const number = /^(\d+)_/.exec(file)?.[1];
      if (!number) continue;
      seen.set(number, [...seen.get(number) ?? [], file]);
    }
    return [...seen.entries()].filter(([, files]) => files.length > 1)
      .map(([number, files]) => `${directory} ${number}: ${files.join(', ')}`);
  });
  expect(duplicates).toEqual([]);
});
