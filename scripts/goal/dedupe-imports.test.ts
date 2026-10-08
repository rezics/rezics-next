import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';
import { COMPOSITION_ROOTS } from './composition-roots.ts';

const roots = [...COMPOSITION_ROOTS];

test('import de-duplication preserves type/value kinds, aliases and hoisting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dedupe-imports-'));
  const imports = [
    "import type { A } from './module';",
    "import { A } from './module';",
    "import { type A, B } from './module';",
    "import { A, B } from './module';",
    "import { A as Alias } from './module';",
    "import type { A as Alias } from './module';",
    "import { type C, D } from './other';",
    "import { type C, D } from './other';",
    "import type { C } from './other';",
    "import { C } from './other';",
    "import { type as Alias } from './named-type';",
    "import type { type as Alias } from './named-type';",
    'const code = 1;',
    "import { E } from './stray';",
    '',
  ].join('\n');
  try {
    for (const root of roots) {
      mkdirSync(dirname(join(dir, root)), { recursive: true });
      writeFileSync(join(dir, root), imports);
    }
    const result = spawnSync('bun', [join(import.meta.dir, 'dedupe-imports.ts')], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    for (const root of roots) {
      expect(readFileSync(join(dir, root), 'utf8')).toBe([
        "import { type A, B } from './module';",
        "import { A, B } from './module';",
        "import { A as Alias } from './module';",
        "import type { A as Alias } from './module';",
        "import { type C, D } from './other';",
        "import { C } from './other';",
        "import { type as Alias } from './named-type';",
        "import type { type as Alias } from './named-type';",
        "import { E } from './stray';",
        'const code = 1;', '',
      ].join('\n'));
    }
    const again = spawnSync('bun', [join(import.meta.dir, 'dedupe-imports.ts')], { cwd: dir, encoding: 'utf8' });
    expect(again.status).toBe(0);
    expect(again.stdout).toBe('');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every composition root is a union-merge attribute', () => {
  const attributes = readFileSync(join(import.meta.dir, '../../.gitattributes'), 'utf8');
  const union = [...attributes.matchAll(/^(\S+) merge=union$/gm)].map(match => match[1]);
  const mainRoots = union.filter(path => path?.startsWith('services/main/'));
  expect(mainRoots.sort()).toEqual([...COMPOSITION_ROOTS].sort());
});
