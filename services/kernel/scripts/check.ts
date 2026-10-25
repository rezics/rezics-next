import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, moduleExtensionFiles, POSTGRES_IMAGE, schemaDumps } from './database.ts';

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
  const extensionFiles = moduleExtensionFiles();
  if (extensionFiles.length) fail(`Module migrations must not create extensions:\n${extensionFiles.join('\n')}`);

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

  migrate(url);
  for (const [path, dump] of Object.entries(schemaDumps(url))) {
    const file = Bun.file(resolve(directory, path));
    if (!(await file.exists()) || (await file.text()) !== dump) {
      fail(`Schema dump differs from ${path}; run \`bun run db dump\``);
    }
  }

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
