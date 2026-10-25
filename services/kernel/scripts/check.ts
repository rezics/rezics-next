import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, POSTGRES_IMAGE, schemaDump } from './database.ts';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pid = String(process.pid);
let container = '';

function run(program: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(program, args, { cwd: directory, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function docker(args: string[]): string {
  return run('docker', args);
}

function cleanupStale(): void {
  const ids = docker(['ps', '-aq', '--filter', 'label=rezics.kernel.check.pid']).split('\n').filter(Boolean);
  for (const id of ids) {
    const owner = docker(['inspect', '-f', '{{ index .Config.Labels "rezics.kernel.check.pid" }}', id]);
    try {
      process.kill(Number(owner), 0);
    } catch {
      docker(['rm', '-f', id]);
    }
  }
}

function cleanup(): void {
  if (container) {
    try {
      docker(['rm', '-f', container]);
    } catch (error) {
      console.error(error);
    }
  }
}

function fail(message: string): never {
  throw new Error(message);
}

async function main(): Promise<void> {
  cleanupStale();
  container = docker([
    'run',
    '-d',
    '--rm',
    '--label',
    `rezics.kernel.check.pid=${pid}`,
    '-p',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql:rw,size=1g',
    '-e',
    'POSTGRES_USER=rezics',
    '-e',
    'POSTGRES_PASSWORD=rezics',
    '-e',
    'POSTGRES_DB=rezics',
    POSTGRES_IMAGE,
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
    '-c',
    'full_page_writes=off',
  ]);
  const portOutput = docker(['port', container, '5432/tcp']);
  const match = portOutput.match(/127\.0\.0\.1:(\d+)/);
  if (!match?.[1]) fail(`Could not determine the test database port: ${portOutput}`);
  const url = `postgres://rezics:rezics@127.0.0.1:${match[1]}/rezics?sslmode=disable`;

  const started = Date.now();
  while (true) {
    try {
      run('docker', ['exec', container, 'pg_isready', '-U', 'rezics', '-d', 'rezics']);
      // pg_isready in the container may succeed before the host publish is ready; TCP check from host follows.
      run('node', [
        '-e',
        `const n=require('net');const s=n.connect(${match[1]},'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))`,
      ]);
      break;
    } catch {
      if (Date.now() - started > 60_000) fail('Test PostgreSQL did not accept host TCP connections within 60 seconds');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }

  migrate(url);
  const expected = await Bun.file(resolve(directory, 'db/schema.sql')).text();
  if (schemaDump(url) !== expected) fail('Schema dump differs from db/schema.sql; run `bun run db dump`');

  const env = { ...process.env, DATABASE_URL: url };
  run(resolve(directory, '../../node_modules/.bin/tsc'), ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json'], env);
  run(resolve(directory, '../../node_modules/.bin/oxlint'), ['--config', '../../.oxlintrc.json', '.'], env);
  run(resolve(directory, '../../node_modules/.bin/oxfmt'), ['--check', '.'], env);
  run('bun', ['test'], env);
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  cleanup();
}
