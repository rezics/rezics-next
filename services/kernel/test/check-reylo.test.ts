import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileEnvironment, invokeTypecheck, writeReyloProject } from '../scripts/check.ts';

const KERNEL_ROOT = resolve(import.meta.dir, '..');

test("the compiler and each test file's processes use the check's explicit analysis project", () => {
  const temporaryRoot = resolve(KERNEL_ROOT, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(resolve(temporaryRoot, 'check-reylo-fixture-'));
  try {
    const url = 'postgres://rezics:rezics@127.0.0.1:5432/rezics?sslmode=disable';
    const analysisUrl = 'postgres://rezics:rezics@127.0.0.1:5432/kernel_analysis?sslmode=disable';
    const reyloConfig = writeReyloProject(directory, analysisUrl);
    // A stale value from the caller's shell must not decide where a file's processes analyse.
    const base = { PATH: '/usr/bin', DATABASE_URL: url, REYLO_CONFIG: '/elsewhere/.reylo.yaml' };
    const compilerInvocations: Array<{ program: string; args: string[]; environment: NodeJS.ProcessEnv }> = [];
    const recordCompilerInvocation = (
      program: string,
      args: string[],
      environment: NodeJS.ProcessEnv,
    ): void => {
      compilerInvocations.push({ program, args, environment });
    };
    invokeTypecheck('/kernel/node_modules/.bin/tsc', null, base, reyloConfig, recordCompilerInvocation);
    invokeTypecheck('/kernel/node_modules/.bin/tsc', ['test/a.test.ts'], base, reyloConfig, recordCompilerInvocation);
    const first = fileEnvironment(base, {
      url,
      database: 'kernel_test_1',
      searchUrl: 'http://127.0.0.1:9200',
      reyloConfig,
    });
    const second = fileEnvironment(base, {
      url,
      database: 'kernel_test_2',
      searchUrl: 'http://127.0.0.1:9200',
      reyloConfig,
    });

    expect(first.DATABASE_URL).toContain('/kernel_test_1?');
    expect(second.DATABASE_URL).toContain('/kernel_test_2?');
    expect(first.DATABASE_URL).not.toBe(second.DATABASE_URL);
    expect(first.REYLO_CONFIG).toBe(reyloConfig);
    expect(second.REYLO_CONFIG).toBe(reyloConfig);
    expect(compilerInvocations.map(({ args }) => args)).toEqual([
      ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json'],
      ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json', '--pretty', 'false'],
    ]);
    expect(compilerInvocations.map(({ environment }) => environment.REYLO_CONFIG)).toEqual([
      reyloConfig,
      reyloConfig,
    ]);
    expect(compilerInvocations.map(({ environment }) => environment.DATABASE_URL)).toEqual([url, url]);
    expect(compilerInvocations.map(({ program }) => program)).toEqual([
      '/kernel/node_modules/.bin/tsc',
      '/kernel/node_modules/.bin/tsc',
    ]);

    expect(basename(reyloConfig)).toBe('.reylo.yaml');
    expect(dirname(reyloConfig).startsWith(`${temporaryRoot}/`)).toBe(true);
    const project = readFileSync(reyloConfig, 'utf8');
    expect(project).toContain(JSON.stringify(analysisUrl));
    for (const own of [url, first.DATABASE_URL!, second.DATABASE_URL!]) expect(project).not.toContain(own);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
