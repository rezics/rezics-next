import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stackRun } from '../../../scripts/stack-run.ts';
import { withThrowawayDatabase } from './derived.ts';

const workspace = resolve(import.meta.dir, '..');
const root = resolve(workspace, '../..');
const output = 'services/kernel/.temp/reylo-benchmark.json';

async function command(argv: string[], cwd: string, env = process.env) {
  const started = performance.now();
  const child = Bun.spawn(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, seconds: (performance.now() - started) / 1000, stdout, stderr };
}

async function benchmark() {
  mkdirSync(join(workspace, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(workspace, '.temp/reylo-benchmark-'));
  const dependencies = join(directory, 'dependencies');
  mkdirSync(dependencies);
  writeFileSync(
    join(dependencies, 'package.json'),
    JSON.stringify({ private: true, dependencies: { reylo: '0.6.0', '@reylosql/postgres': '0.6.0' } }),
  );
  const installed = await command(['bun', 'install'], dependencies);
  if (installed.status !== 0) throw new Error(installed.stderr);
  const results: object[] = [];
  await withThrowawayDatabase(async (env) => {
    for (const version of ['0.6.0', '0.7.0']) {
      const reylo =
        version === '0.6.0' ? join(dependencies, 'node_modules/reylo') : join(workspace, 'node_modules/reylo');
      const project = join(directory, version);
      mkdirSync(project);
      const config = join(project, '.reylo.yaml');
      writeFileSync(config, `direct_url: ${JSON.stringify(env.DATABASE_URL)}\n`);
      const analysis = await command(['bun', join(reylo, 'src/cli.js'), 'generate', 'src'], workspace, {
        ...env,
        REYLO_CONFIG: config,
      });
      writeFileSync(join(project, 'analysis.log'), analysis.stdout + analysis.stderr);
      if (analysis.status !== 0) throw new Error(analysis.stderr + analysis.stdout);
      writeFileSync(config, 'direct_url: ""\n');
      const tsconfig = join(project, 'tsconfig.json');
      writeFileSync(
        tsconfig,
        JSON.stringify({
          extends: join(workspace, 'tsconfig.json'),
          contentMappers: [{ package: reylo, extensions: ['.sql'] }],
        }),
      );
      const { DATABASE_URL: _, ...offline } = env;
      const compiler = await command(
        [join(root, 'node_modules/.bin/tsc'), '--noEmit', '--runExternalCode', '-p', tsconfig],
        workspace,
        { ...offline, REYLO_CONFIG: config },
      );
      writeFileSync(join(project, 'typecheck.log'), compiler.stdout + compiler.stderr);
      const result = {
        version,
        analysisSeconds: analysis.seconds,
        compilerSeconds: compiler.seconds,
        typecheckSeconds: analysis.seconds + compiler.seconds,
        compilerStatus: compiler.status,
        analysisSummary: analysis.stdout.trim().split('\n').slice(-3),
        diagnostics: compiler.stdout + compiler.stderr,
      };
      results.push(result);
      console.log(JSON.stringify({ ...result, diagnostics: undefined }));
    }
    return 0;
  });
  writeFileSync(join(root, output), JSON.stringify({ results }, null, 2));
  return 0;
}
if (import.meta.main)
  process.exitCode = await stackRun(
    {
      label: 'Reylo version comparison',
      root,
      cwd: workspace,
      command: ['bun', 'scripts/benchmark-reylo.ts'],
      keepsFiles: true,
      returns: [output],
    },
    benchmark,
  );
