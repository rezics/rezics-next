import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const appRoot = join(import.meta.dir, '..');

test('Web typecheck declares Reylo in this workspace and does not compile Kernel scripts', () => {
  const tsconfig = JSON.parse(readFileSync(join(appRoot, 'tsconfig.json'), 'utf8')) as {
    contentMappers: Array<{ package: string; extensions: string[] }>;
  };
  expect(tsconfig.contentMappers).toEqual([{ package: 'reylo', extensions: ['.sql'] }]);
  const scripts = JSON.parse(readFileSync(join(appRoot, 'tsconfig.scripts.json'), 'utf8')) as {
    exclude: string[];
  };
  expect(scripts.exclude).toEqual([
    'scripts/check.ts',
    'scripts/seeded-content-ratings-reviews-walk.ts',
    'scripts/vndb-seeded-journey.ts',
  ]);
  const manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  expect(manifest.dependencies?.reylo).toBeUndefined();
  expect(manifest.devDependencies?.reylo).toBe('0.7.0');
  const source = readFileSync(join(import.meta.dir, 'typecheck.ts'), 'utf8');
  expect(source).not.toContain('prepareReyloAnalysisCache');
  expect(source).not.toContain('services/kernel/scripts/');
  expect(source).not.toContain('services/kernel/node_modules/reylo');
});
