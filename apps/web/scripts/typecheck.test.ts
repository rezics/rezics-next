import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { webKernelReyloPackage } from './typecheck.ts';

const appRoot = join(import.meta.dir, '..');

test('Web typecheck maps SQL through Kernel installed Reylo without compiling Kernel scripts', () => {
  const tsconfig = JSON.parse(readFileSync(join(appRoot, 'tsconfig.json'), 'utf8')) as {
    contentMappers: Array<{ package: string; extensions: string[] }>;
  };
  expect(tsconfig.contentMappers).toEqual([
    { package: '../../services/kernel/node_modules/reylo', extensions: ['.sql'] },
  ]);
  const manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  expect(manifest.dependencies?.reylo).toBeUndefined();
  expect(manifest.devDependencies?.reylo).toBeUndefined();
  expect(existsSync(webKernelReyloPackage)).toBe(true);
  const source = readFileSync(join(import.meta.dir, 'typecheck.ts'), 'utf8');
  expect(source).toContain("join(repository, 'services/kernel')");
  expect(source).not.toContain('prepareReyloAnalysisCache');
  expect(source).not.toContain('services/kernel/scripts/');
});
