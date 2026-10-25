import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { clientDeclarations, committedDeclarations } from '../scripts/client.ts';

// Each declaration emit runs the TypeScript compiler; under a loaded host it exceeds Bun's 5 s default.
const timeout = 60_000;

const PROJECT_ROOT = resolve(import.meta.dir, '../../..');

test(
  'the client package carries the declarations the kernel emits for its HTTP contract',
  () => {
    const emitted = clientDeclarations();
    expect([...emitted.keys()]).toEqual(expect.arrayContaining(['http/kernel.d.ts', 'http/request.d.ts']));
    let sawSqlDeclaration = false;
    for (const [key, content] of emitted) {
      for (const match of content.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+\.sql)['"]/g)) {
        const target = resolve(dirname(resolve('/client', key)), match[1]!);
        const declaration = relative('/client', `${target}.d.ts`).split(sep).join('/');
        expect(emitted.has(declaration)).toBe(true);
        expect(declaration.endsWith('.sql.d.ts')).toBe(true);
        sawSqlDeclaration = true;
      }
    }
    expect(sawSqlDeclaration).toBe(true);
    if (JSON.stringify([...committedDeclarations()]) !== JSON.stringify([...emitted]))
      throw new Error('packages/client/src/kernel is stale; run `bun run --cwd services/kernel client`');
  },
  timeout,
);

test(
  'client declarations use the source root and exclude test-only type dependencies',
  () => {
    const temporaryRoot = resolve(PROJECT_ROOT, '.temp');
    mkdirSync(temporaryRoot, { recursive: true });
    const fixtureRoot = mkdtempSync(resolve(temporaryRoot, 'kernel-client-fixture-'));
    const workspace = resolve(fixtureRoot, 'workspace');
    const kernel = resolve(workspace, 'services/kernel');
    const source = resolve(kernel, 'src/http');
    const test = resolve(kernel, 'test');
    const specs = resolve(workspace, 'specs');

    try {
      mkdirSync(source, { recursive: true });
      mkdirSync(test, { recursive: true });
      mkdirSync(specs, { recursive: true });
      writeFileSync(
        resolve(kernel, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              target: 'esnext',
              module: 'preserve',
              moduleResolution: 'bundler',
              strict: true,
              skipLibCheck: true,
              types: [],
            },
            include: ['src/**/*.ts', 'test/**/*.ts'],
          },
          null,
          2,
        ),
      );
      writeFileSync(
        resolve(source, 'kernel.ts'),
        "import type { Request } from './request.js';\nexport interface Kernel { request: Request; status: 200 }\n",
      );
      writeFileSync(resolve(source, 'request.ts'), 'export interface Request { id: string }\n');
      writeFileSync(
        resolve(test, 'driver.ts'),
        "import type { FrozenSpec } from '../../../specs/frozen';\nexport interface Driver { spec: FrozenSpec }\n",
      );
      writeFileSync(resolve(specs, 'frozen.ts'), 'export interface FrozenSpec { readonly name: string }\n');

      const first = clientDeclarations(kernel);
      expect([...first.keys()]).toEqual(['http/kernel.d.ts', 'http/request.d.ts']);
      expect(first.get('http/kernel.d.ts')).toContain("from './request.js'");
      expect(first.has('test/driver.d.ts')).toBe(false);
      expect(first.has('specs/frozen.d.ts')).toBe(false);

      writeFileSync(resolve(source, 'request.ts'), 'export interface Request { id: string; version: number }\n');
      const changed = clientDeclarations(kernel);
      expect(changed.get('http/request.d.ts')).not.toBe(first.get('http/request.d.ts'));
      expect(changed.get('http/request.d.ts')).toContain('version: number');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
  timeout,
);
