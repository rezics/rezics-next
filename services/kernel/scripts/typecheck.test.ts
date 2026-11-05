import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { withCommandPhase } from './command-phases.ts';
import { prepareReyloAnalysisCache } from './reylo-cache.ts';
import { runKernelTypecheck } from './typecheck.ts';

test('Kernel typecheck reuses SQL analysis, keeps diagnostics, and scopes invalidation to changed inputs', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'kernel-typecheck-cache-'));
  const workspace = join(repository, 'services/kernel');
  const cacheRoot = join(repository, 'cache');
  const bin = join(repository, 'bin');
  const diagnosticsFile = join(repository, 'diagnostics.txt');
  const phasesFile = join(repository, 'command-phases.tsv');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(workspace, 'src/first.sql'), 'select 1;\n');
  writeFileSync(join(workspace, 'src/second.sql'), 'select 2;\n');
  const tsc = join(bin, 'tsc');
  writeFileSync(
    tsc,
    '#!/bin/sh\n[ -n "$REYLO_CONFIG" ] || exit 9\n[ -z "$DATABASE_URL" ] || exit 9\nprintf \'%s\\n\' \'services/kernel/src/query.ts(12,3): error TS2345: same cold/warm diagnostic\' > "$DIAGNOSTIC_FILE"\nexit 2\n',
  );
  chmodSync(tsc, 0o755);
  const emitter = join(bin, 'bun');
  writeFileSync(
    emitter,
    '#!/bin/sh\n[ -n "$DATABASE_URL" ] || exit 9\n[ "$1" = scripts/client.ts ] || exit 9\nexit 0\n',
  );
  chmodSync(emitter, 0o755);
  let dumps = {
    'db/schema.sql': 'create table first (id integer);',
    'db/access/schema.sql': 'create table second (id integer);',
  };
  const generated: string[][] = [];
  const diagnostics = ['services/kernel/src/query.ts(12,3): error TS2345: same cold/warm diagnostic'];
  const analysisResults: { analyzed: number; total: number }[] = [];
  let phaseClock = 0n;
  const phaseEnv = { REZICS_CHECK_PHASES: phasesFile };
  const options = {
    repository,
    workspace,
    cacheRoot,
    identity: () => 'fixed-toolchain',
    schemaDumps: () => ({ ...dumps }),
    generate: async (files: readonly string[], configFile: string) => {
      expect(readFileSync(configFile, 'utf8')).toContain('direct_url:');
      generated.push([...files]);
      const configDirectory = dirname(configFile);
      const output = join(configDirectory, '.reylo/queries');
      mkdirSync(output, { recursive: true });
      for (const file of files)
        writeFileSync(join(output, `${randomUUID()}.json`), readFileSync(join(workspace, file)));
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  const check = async (emitClient = false) => {
    const status = await runKernelTypecheck(
      {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        DATABASE_URL: 'postgres://rezics:rezics@127.0.0.1:5432/rezics',
        KERNEL_DATABASE_CONTAINER: 'fixture-container',
        DIAGNOSTIC_FILE: diagnosticsFile,
        REZICS_CHECK_PHASES: phasesFile,
      },
      {
        recognize: () => ({
          outcome: 'admitted',
          runId: 'fixture',
          scope: 'fixture.scope',
          supervisor: { pid: 1, started: '1', group: 1 },
        }),
        outputTree: async (_root, command) => command(),
        prepareSqlAnalysis: async (env) => {
          const prepared = await prepareReyloAnalysisCache(env, options);
          analysisResults.push({ analyzed: prepared.analyzedFiles, total: prepared.totalFiles });
          return prepared;
        },
      },
      emitClient ? ['--emit-client'] : [],
    );
    return { status, ...analysisResults.at(-1)!, diagnostics: [readFileSync(diagnosticsFile, 'utf8').trim()] };
  };

  try {
    await withCommandPhase(
      'database-image',
      () => undefined,
      phaseEnv,
      () => (phaseClock += 1_000_000_000n),
    );
    await withCommandPhase(
      'migrations',
      () => undefined,
      phaseEnv,
      () => (phaseClock += 1_000_000_000n),
    );
    const cold = await check();
    const warm = await check();
    expect(cold).toEqual({ status: 2, analyzed: 2, total: 2, diagnostics });
    expect(warm).toEqual({ status: 2, analyzed: 0, total: 2, diagnostics });
    expect(generated).toEqual([['src/first.sql', 'src/second.sql']]);

    writeFileSync(join(workspace, 'src/first.sql'), 'select 10;\n');
    expect((await check()).analyzed).toBe(1);
    expect(generated.at(-1)).toEqual(['src/first.sql']);

    dumps = { ...dumps, 'db/access/schema.sql': 'create table second (id bigint);' };
    expect((await check()).analyzed).toBe(2);
    expect(generated.at(-1)).toEqual(['src/first.sql', 'src/second.sql']);

    for (const pointer of new Bun.Glob('reylo-kernel/*/*/current').scanSync({ cwd: cacheRoot }))
      writeFileSync(join(cacheRoot, pointer), 'invalid snapshot id\n');
    expect((await check()).analyzed).toBe(2);
    expect(generated.at(-1)).toEqual(['src/first.sql', 'src/second.sql']);

    const open = new Map<string, number>();
    const durations: Record<string, number> = {};
    for (const line of readFileSync(phasesFile, 'utf8').trim().split('\n')) {
      const [phase, edge, timestamp] = line.split('\t');
      if (edge === 'start') open.set(phase!, Number(timestamp));
      else {
        const started = open.get(phase!);
        expect(started).toBeDefined();
        open.delete(phase!);
        durations[phase!] = (durations[phase!] ?? 0) + (Number(timestamp) - started!);
      }
    }
    // Emission keeps its database while the following tsc still uses database-free cached analysis.
    expect((await check(true)).status).toBe(2);
    expect(open.size).toBe(0);
    for (const phase of ['database-image', 'migrations', 'sql-analysis', 'typecheck'])
      expect(durations[phase]).toBeGreaterThan(0);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
