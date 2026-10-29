import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileEnvironment, planNeedsSearch, runChecksThenStartSearch } from '../scripts/check.ts';

const PROJECT_ROOT = resolve(import.meta.dir, '../../..');

function withModule(files: Record<string, string>, use: (directory: string) => void): void {
  const temporaryRoot = resolve(PROJECT_ROOT, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(resolve(temporaryRoot, 'kernel-search-plan-'));
  try {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(dirname(resolve(directory, file)), { recursive: true });
      writeFileSync(resolve(directory, file), contents);
    }
    use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('file-mode plans without a static relative import to search work do not need a search container', () => {
  withModule(
    {
      'test/ordinary.test.ts': "import { value } from '../src/ordinary.ts'; expect(value).toBe(1);",
      'src/ordinary.ts': 'export const value = 1; export const optional = import("some-package");',
      'src/other.ts': "export const urlName = 'OPENSEARCH_URL';",
    },
    (directory) => {
      expect(planNeedsSearch({ files: ['test/ordinary.test.ts'], tests: ['test/ordinary.test.ts'] }, directory)).toBe(
        false,
      );
    },
  );
});

test('file-mode plans need search when a selected test static import closure reaches search work', () => {
  withModule(
    {
      'test/ordinary.test.ts': "import './support/worker.ts';",
      'test/support/worker.ts': "import '../../src/search/work.ts';",
      'src/search/work.ts': 'export const url = process.env.OPENSEARCH_URL;',
    },
    (directory) => {
      expect(planNeedsSearch({ files: ['test/ordinary.test.ts'], tests: ['test/ordinary.test.ts'] }, directory)).toBe(
        true,
      );
    },
  );
});

test('file-mode plans scan imports after a shebang in the selected import closure', () => {
  withModule(
    {
      'test/ordinary.test.ts': "import './support/worker.ts';",
      'test/support/worker.ts': "#!/usr/bin/env bun\nimport '../../src/search/work.ts';",
      'src/search/work.ts': 'export const searchEnabled = true;',
    },
    (directory) => {
      expect(planNeedsSearch({ files: ['test/ordinary.test.ts'], tests: ['test/ordinary.test.ts'] }, directory)).toBe(
        true,
      );
    },
  );
});

test('file-mode plans need search when a file in the import closure cannot be scanned', () => {
  withModule(
    {
      'test/ordinary.test.ts': "import './support/worker.ts';",
      'test/support/worker.ts': 'const =',
    },
    (directory) => {
      expect(planNeedsSearch({ files: ['test/ordinary.test.ts'], tests: ['test/ordinary.test.ts'] }, directory)).toBe(
        true,
      );
    },
  );
});

test('full check plans always need search', () => {
  expect(planNeedsSearch({ files: null, tests: [] }, import.meta.dir)).toBe(true);
});

test('search startup follows completion of typecheck, lint and format', async () => {
  const order: string[] = [];
  await runChecksThenStartSearch(
    true,
    async () => {
      order.push('typecheck');
      order.push('lint');
      order.push('format');
    },
    () => {
      order.push('search');
      return 'http://search';
    },
  );
  expect(order).toEqual(['typecheck', 'lint', 'format', 'search']);
});

test('a file environment without a search container omits OPENSEARCH_URL', () => {
  const environment = fileEnvironment(
    { OPENSEARCH_URL: 'http://unrelated-server', KERNEL_POOL_ACQUIRE_TIMEOUT_MS: '100' },
    {
      url: 'postgres://rezics:rezics@127.0.0.1/rezics?',
      database: 'kernel_test_1',
      reyloConfig: '/tmp/reylo.yaml',
    },
  );
  expect(environment).not.toHaveProperty('OPENSEARCH_URL');
});
