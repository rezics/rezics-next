import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cycleDomains, importCycles, readImportGraph } from './import-cycles';

const scriptPath = path.join(import.meta.dir, 'import-cycles.ts');
const fixture = mkdtempSync(path.join(os.tmpdir(), 'import-cycles-'));

function write(relative: string, content: string): void {
  const file = path.join(fixture, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

// a <-> b is a runtime cycle. d <-> e is cut by the type-only edge; f -> g -> f is cut by the dynamic import; h is
// alone. The g -> f edge only makes a cycle through a dynamic import, which is lazy and does not count.
write('library/a.ts', "import { b } from './b.ts';\nexport const a = () => b;\n");
write('library/b.ts', "import { a } from './a.ts';\nexport const b = () => a;\n");
write('library/d.ts', "import type { e } from './e.ts';\nexport const d: typeof e | undefined = undefined;\n");
write('library/e.ts', "import { d } from './d.ts';\nexport const e = d;\n");
write('semantic/f.ts', "import { g } from '../library/g.ts';\nexport const f = () => g;\n");
write('library/g.ts', "export const g = () => import('../semantic/f.ts');\n");
write('library/h.ts', "export const h = 1;\n");

describe('import cycle scan', () => {
  test('lists only runtime cycles, leaving out type-only, dynamic and lone modules', () => {
    const cycles = importCycles(readImportGraph(fixture));
    expect(cycles).toEqual([[path.join(fixture, 'library/a.ts'), path.join(fixture, 'library/b.ts')]]);
    expect(cycleDomains(fixture, cycles[0]!)).toEqual(['library']);
  });

  test('exits non-zero only when the module count exceeds the baseline', () => {
    const run = (baseline: string) =>
      spawnSync(process.execPath, [scriptPath, fixture, '--baseline', baseline], { encoding: 'utf8' });

    const over = run('1');
    expect(over.status).toBe(1);
    expect(over.stdout).toContain('modules in cycles 2');
    expect(over.stderr).toContain('exceed the baseline of 1');

    expect(run('2').status).toBe(0);
  });

  test('rejects an invalid baseline', () => {
    const result = spawnSync(process.execPath, [scriptPath, fixture, '--baseline', 'many'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
  });
});
