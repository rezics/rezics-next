import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const admitted = {
  outcome: 'admitted' as const,
  runId: 'auth-typecheck-fixture',
  scope: 'auth-typecheck-fixture.scope',
  supervisor: { pid: 1, started: '1', group: 1 },
};

test('Auth prepares its reached SQL cache before tsc and preserves diagnostics and disposal on compiler failure', async () => {
  const repository = resolve(import.meta.dir, '../../..');
  const temporaryRoot = join(repository, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'auth-typecheck-cache-'));
  const fixture = join(directory, 'run.ts');
  const disposed = join(directory, 'analysis-disposed');
  const sqlDiagnostic = 'src/credential-effects-stage.sql(5,2): error reylo1: SQL diagnostic stays exact';
  const typeDiagnostic = 'src/session.ts(9,3): error TS2322: TypeScript diagnostic stays exact';
  writeFileSync(
    fixture,
    `import { runAuthTypecheck } from ${JSON.stringify(join(import.meta.dir, 'typecheck.ts'))};
const result = await runAuthTypecheck(
  { DATABASE_URL: 'postgres://auth-compiler.test/rezics', PATH: process.env.PATH ?? '' },
  {
    recognize: () => (${JSON.stringify(admitted)}),
    place: async () => { throw new Error('admitted Auth typecheck must not be placed twice'); },
    prepareSqlAnalysis: async (env) => ({
      available: true,
      environment: { ...env, REYLO_CONFIG: '/private/auth/.reylo.yaml' },
      analyzedFiles: 4,
      totalFiles: 2033,
      writtenEntries: 4,
      async dispose() { await Bun.write(${JSON.stringify(disposed)}, 'disposed'); },
    }),
    typecheck: async () => {
      process.stdout.write(${JSON.stringify(`${sqlDiagnostic}\n`)});
      process.stderr.write(${JSON.stringify(`${typeDiagnostic}\n`)});
      return 2;
    },
  },
);
process.exitCode = result;
`,
  );

  try {
    const result = spawnSync(process.execPath, [fixture], {
      cwd: repository,
      encoding: 'utf8',
      env: process.env,
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toBe(`Auth SQL analysis cache: analyzed 4, reused 2029 of 2033 files.\n${sqlDiagnostic}\n`);
    expect(result.stderr).toBe(`${typeDiagnostic}\n`);
    expect(readFileSync(disposed, 'utf8')).toBe('disposed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
