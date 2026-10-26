import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileEnvironment, writeReyloProject } from '../scripts/check.ts';

const KERNEL_ROOT = resolve(import.meta.dir, '..');

test("every test file's processes read Reylo analyses from the check's one analysis database", () => {
  const temporaryRoot = resolve(KERNEL_ROOT, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(resolve(temporaryRoot, 'check-reylo-fixture-'));
  try {
    const url = 'postgres://rezics:rezics@127.0.0.1:5432/rezics?sslmode=disable';
    const analysisUrl = 'postgres://rezics:rezics@127.0.0.1:5432/kernel_analysis?sslmode=disable';
    const reyloConfig = writeReyloProject(directory, analysisUrl);
    // A stale value from the caller's shell must not decide where a file's processes analyse.
    const base = { PATH: '/usr/bin', DATABASE_URL: url, REYLO_CONFIG: '/elsewhere/.reylo.yaml' };
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
    expect(first.REYLO_CONFIG).toBe(reyloConfig);
    expect(second.REYLO_CONFIG).toBe(reyloConfig);

    expect(basename(reyloConfig)).toBe('.reylo.yaml');
    expect(dirname(reyloConfig).startsWith(`${temporaryRoot}/`)).toBe(true);
    const project = readFileSync(reyloConfig, 'utf8');
    expect(project).toContain(JSON.stringify(analysisUrl));
    for (const own of [url, first.DATABASE_URL!, second.DATABASE_URL!]) expect(project).not.toContain(own);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
