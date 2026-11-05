import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import {
  assertNoServiceImports,
  clientDeclarations,
  committedDeclarations,
} from '../scripts/client.ts';

// Each declaration emit runs the TypeScript compiler; under a loaded host it exceeds Bun's 5 s default.
const timeout = 60_000;
// The real kernel also constructs SQL types, checks the source and emits the declaration graph. Budget each phase
// separately while six test files and the other workspace gates share the host.
const kernelDeclarationTimeout = 3 * timeout;

const PROJECT_ROOT = resolve(import.meta.dir, '../../..');

test(
  'the client package carries the declarations the kernel emits for its HTTP contract',
  () => {
    const emitted = clientDeclarations();
    expect([...clientDeclarations()]).toEqual([...emitted]);
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
  kernelDeclarationTimeout,
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

      mkdirSync(resolve(workspace, 'services/example'), { recursive: true });
      writeFileSync(resolve(workspace, 'services/example/package.json'), JSON.stringify({ name: '@fixture/service' }));
      writeFileSync(resolve(source, 'service.d.ts'), 'export interface Port { id: string }\n');
      const config = JSON.parse(readFileSync(resolve(kernel, 'tsconfig.json'), 'utf8'));
      config.compilerOptions.paths = { '@fixture/service': ['./src/http/service.d.ts'] };
      writeFileSync(resolve(kernel, 'tsconfig.json'), JSON.stringify(config));
      writeFileSync(
        resolve(source, 'kernel.ts'),
        "import type { Port } from '@fixture/service';\nexport interface Kernel { port: Port }\n",
      );
      expect(() => clientDeclarations(kernel)).toThrow(
        'Client declaration http/kernel.d.ts imports service package @fixture/service',
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
  timeout,
);

test('client generation refuses declarations importing a service workspace and names both', () => {
  const temporaryRoot = resolve(PROJECT_ROOT, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(resolve(temporaryRoot, 'client-service-import-'));
  try {
    mkdirSync(resolve(root, 'services/example'), { recursive: true });
    writeFileSync(resolve(root, 'services/example/package.json'), JSON.stringify({ name: '@fixture/service' }));
    for (const content of [
      "import type { Port } from '@fixture/service';",
      "export type { Port } from '@fixture/service/ports';",
      "export type Port = import('@fixture/service').Port;",
      "import '@fixture/service';",
      "import Port = require('@fixture/service/ports');",
    ]) {
      expect(() => assertNoServiceImports(new Map([['access/fixture.d.ts', content]]), root)).toThrow(
        'Client declaration access/fixture.d.ts imports service package @fixture/service',
      );
    }
    expect(() =>
      assertNoServiceImports(
        new Map([
          [
            'access/allowed.d.ts',
            "import type { Port } from '@rezics/auth-contract';\nexport type Pool = import('pg').Pool;",
          ],
          [
            'access/literals.d.ts',
            `// import '@fixture/service';\n/* export * from '@fixture/service'; */\nexport type Example = "from '@fixture/service'";`,
          ],
        ]),
        root,
      ),
    ).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('client compilation preserves prepared SQL analysis without a database URL', () => {
  const fixture = mkdtempSync(resolve(PROJECT_ROOT, '.temp/kernel-client-environment-'));
  const kernel = resolve(fixture, 'services/kernel');
  const previousConfig = process.env.REYLO_CONFIG;
  const previousDatabase = process.env.DATABASE_URL;
  try {
    mkdirSync(resolve(kernel, 'src/http'), { recursive: true });
    writeFileSync(resolve(kernel, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [] } }));
    writeFileSync(resolve(kernel, 'src/http/kernel.ts'), 'export type Kernel = string;');
    writeFileSync(resolve(kernel, 'src/http/request.ts'), 'export type Request = string;');
    const config = resolve(fixture, '.reylo.yaml');
    writeFileSync(config, 'direct_url: ""\n');
    const compiler = resolve(fixture, 'compiler');
    writeFileSync(compiler, `#!/usr/bin/env bun
if (process.env.REYLO_CONFIG !== ${JSON.stringify(config)} || process.env.DATABASE_URL !== undefined)
  throw new Error('Prepared SQL analysis environment was lost');
const result = Bun.spawnSync([${JSON.stringify(resolve(PROJECT_ROOT, 'node_modules/.bin/tsc'))}, ...process.argv.slice(2)], { stdout: 'inherit', stderr: 'inherit' });
process.exit(result.exitCode);
`);
    chmodSync(compiler, 0o755);
    process.env.REYLO_CONFIG = config;
    delete process.env.DATABASE_URL;
    expect([...clientDeclarations(kernel, { repositoryRoot: fixture, compiler }).keys()])
      .toEqual(['http/kernel.d.ts', 'http/request.d.ts']);
  } finally {
    if (previousConfig === undefined) delete process.env.REYLO_CONFIG;
    else process.env.REYLO_CONFIG = previousConfig;
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('generated client declarations import no Auth service and declare all package dependencies', async () => {
  for (const [file, content] of committedDeclarations()) {
    expect(content, file).not.toMatch(/['"]@rezics\/auth(?:\/[^'"]*)?['"]/);
  }
  const { checkWorkspaceImports } = await import('../../../scripts/workspace-imports.ts');
  expect(checkWorkspaceImports(PROJECT_ROOT).filter((line) => line.startsWith('error: @rezics/client '))).toEqual([]);
});
