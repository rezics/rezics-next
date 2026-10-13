import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  copyReleasePayload,
  copyReleaseRuntimeFiles,
  releaseRuntimeFiles,
} from './release-payload.ts';

const root = resolve(import.meta.dir, '../..');

function fixture(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  return mkdtempSync(join(root, '.temp/release-payload-'));
}

function write(base: string, path: string, code: string): void {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), code);
}

test('release payload follows transitive runtime imports beyond its copied trees', () => {
  const directory = fixture();
  const source = join(directory, 'source');
  const payload = join(directory, 'payload');
  try {
    for (const path of ['services', 'packages', 'generated', 'node_modules/@rezics']) {
      mkdirSync(join(source, path), { recursive: true });
    }
    write(
      source,
      'services/main/src/index.ts',
      `
      import { registry } from '../../../model/compiler/registry.ts';
      import { workspace } from '@rezics/runtime';
      import type { DevelopmentOnly } from './missing-types.ts';
      import { readFileSync } from 'node:fs';
      export const main = [registry, workspace, readFileSync];
      export const lazy = () => import('../../../adapters/lazy.ts');
    `,
    );
    write(source, 'model/compiler/registry.ts', "export { registry } from './outputs';");
    write(
      source,
      'model/compiler/outputs.ts',
      `
      import catalog from './catalog.json';
      import './registry.ts';
      export const registry = catalog;
    `,
    );
    write(source, 'model/compiler/catalog.json', '{"revision":1}');
    write(source, 'adapters/lazy.ts', "export const lazy = require('./common.cjs');");
    write(
      source,
      'adapters/common.cjs',
      "module.exports = require('../model/compiler/catalog.json');",
    );
    write(
      source,
      'packages/runtime/package.json',
      '{"name":"@rezics/runtime","exports":"./src/index.ts"}',
    );
    write(
      source,
      'packages/runtime/src/index.ts',
      `
      import { adapter } from '../../../adapters/workspace.ts';
      export const workspace = adapter;
    `,
    );
    write(source, 'adapters/workspace.ts', 'export const adapter = 1;');
    symlinkSync(
      join(source, 'packages/runtime'),
      join(source, 'node_modules/@rezics/runtime'),
      'dir',
    );

    copyReleasePayload(source, payload);
    expect(releaseRuntimeFiles(source)).toEqual([
      'adapters/common.cjs',
      'adapters/lazy.ts',
      'adapters/workspace.ts',
      'model/compiler/catalog.json',
      'model/compiler/outputs.ts',
      'model/compiler/registry.ts',
      'packages/runtime/src/index.ts',
      'services/main/src/index.ts',
    ]);
    for (const path of releaseRuntimeFiles(source)) {
      expect(readFileSync(join(payload, path))).toEqual(readFileSync(join(source, path)));
    }

    // A new import outside every coarse copied tree must join the next payload.
    write(
      source,
      'model/compiler/outputs.ts',
      "export { registry } from '../../new-runtime/registry.ts';",
    );
    write(source, 'new-runtime/registry.ts', 'export const registry = 2;');
    const next = join(directory, 'next');
    copyReleasePayload(source, next);
    expect(readFileSync(join(next, 'new-runtime/registry.ts'), 'utf8')).toBe(
      'export const registry = 2;',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Main entry import closure is present in the release and covered by the runtime Docker copies', () => {
  const directory = fixture();
  try {
    const files = releaseRuntimeFiles(root);
    expect(files).toContain('model/compiler/registry.ts');
    expect(files).toContain('model/compiler/outputs.ts');
    copyReleaseRuntimeFiles(root, directory);
    const dockerfile = readFileSync(join(root, 'infra/release/Dockerfile'), 'utf8');
    const copies = [...dockerfile.matchAll(/^COPY --from=dependencies .*?\/app\/(\S+) /gm)].map(
      (match) => match[1]!,
    );
    for (const path of files) {
      expect(existsSync(join(directory, path)), `release omits ${path}`).toBe(true);
      expect(readFileSync(join(directory, path))).toEqual(readFileSync(join(root, path)));
      expect(
        copies.some((copy) => path === copy || path.startsWith(`${copy}/`)),
        `runtime Dockerfile omits ${path}`,
      ).toBe(true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release refuses an unresolved runtime import before sealing the payload', () => {
  const directory = fixture();
  try {
    write(directory, 'services/main/src/index.ts', "import '../../../missing/runtime.ts';");
    expect(() => releaseRuntimeFiles(directory)).toThrow('missing/runtime.ts');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
