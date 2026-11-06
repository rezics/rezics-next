import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileWebPrograms, WEB_COMPILER_PROGRAMS } from './typecheck.ts';

test('official typecheck and the check gate share both Web compiler programs', () => {
  expect(WEB_COMPILER_PROGRAMS).toEqual([
    ['tsc', '--noEmit', '--runExternalCode', '-p', 'tsconfig.json'],
    ['tsc', '--noEmit', '--runExternalCode', '-p', 'tsconfig.scripts.json'],
  ]);
  expect(readFileSync(join(import.meta.dir, 'check.ts'), 'utf8')).toContain('compileWebPrograms');
  expect(readFileSync(join(import.meta.dir, 'check.ts'), 'utf8')).not.toContain(
    "['check', '--no-script', '-p', 'tsconfig.json']",
  );
});

test('the scripts program still runs after a red web program', async () => {
  const ran: string[] = [];
  expect(
    await compileWebPrograms(async (args) => {
      ran.push(args.at(-1)!);
      return args.at(-1) === 'tsconfig.json' ? 2 : 0;
    }),
  ).toBe(2);
  expect(ran).toEqual(['tsconfig.json', 'tsconfig.scripts.json']);
});

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
