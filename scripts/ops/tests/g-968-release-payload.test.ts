import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { copyReleaseTree } from '../release-payload.ts';

const root = resolve(import.meta.dir, '../../..');

function write(base: string, path: string, bytes: string) {
  const file = join(base, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function inventory(base: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [
          path.slice(base.length + 1),
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        ];
      })
      .sort(([left], [right]) => (left! < right! ? -1 : left! > right! ? 1 : 0)),
  );
}

test('G-968/OPS01: release trees dereference workspace code without hashing live Wrangler or cache state', () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const fixture = mkdtempSync(join(root, '.temp/g-968-release-'));
  try {
    const workspace = join(fixture, 'apps/web');
    write(workspace, 'package.json', '{"name":"@rezics/web"}');
    write(workspace, 'features/config/env.ts', 'export const port = 3000;');
    write(workspace, '.wrangler/state/v3/observability/traces.sqlite', 'first trace');
    write(workspace, '.wrangler/state/v3/observability/traces.sqlite-shm', 'first shm');
    write(workspace, '.wrangler/state/v3/observability/traces.sqlite-wal', 'first wal');
    write(workspace, '.cache/build/state', 'first build');
    const source = join(fixture, 'node_modules');
    write(source, 'dependency/index.js', 'module.exports = 1;');
    write(source, 'dependency/runtime/catalog.sqlite', 'immutable dependency data');
    write(source, 'dependency/.wrangler.js', 'module.exports = 2;');
    write(source, '.cache/tool/state', 'first cache');
    mkdirSync(join(source, '@rezics'), { recursive: true });
    symlinkSync(workspace, join(source, '@rezics/web'), 'dir');
    const first = join(fixture, 'first');
    copyReleaseTree(source, first);
    expect(existsSync(join(first, '@rezics/web/.wrangler'))).toBe(false);
    expect(existsSync(join(first, '@rezics/web/.cache'))).toBe(false);
    expect(existsSync(join(first, '.cache'))).toBe(false);
    expect(readFileSync(join(first, '@rezics/web/features/config/env.ts'), 'utf8')).toBe(
      'export const port = 3000;',
    );
    expect(Object.keys(inventory(first))).toEqual([
      '@rezics/web/features/config/env.ts',
      '@rezics/web/package.json',
      'dependency/.wrangler.js',
      'dependency/index.js',
      'dependency/runtime/catalog.sqlite',
    ]);

    // These are the three changing files observed between the two failed-run artifacts.
    for (const suffix of ['', '-shm', '-wal']) {
      write(workspace, `.wrangler/state/v3/observability/traces.sqlite${suffix}`, 'later trace');
    }
    write(workspace, '.cache/build/state', 'later build');
    write(source, '.cache/tool/state', 'later cache');
    const second = join(fixture, 'second');
    copyReleaseTree(source, second);
    expect(inventory(second)).toEqual(inventory(first));
    expect(existsSync(join(workspace, '.wrangler/state/v3/observability/traces.sqlite'))).toBe(
      true,
    );

    write(workspace, 'features/config/env.ts', 'export const port = 3001;');
    const changed = join(fixture, 'changed');
    copyReleaseTree(source, changed);
    expect(inventory(changed)).not.toEqual(inventory(first));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
