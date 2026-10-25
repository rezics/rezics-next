import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, moduleExtensionFiles, POSTGRES_IMAGE, schemaDumps } from './database.ts';
import { buildSearchImage, waitForSearch } from './search.ts';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pid = String(process.pid);
let container = '';
let searchContainer = '';

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
  // One listing carries each owner, so a concurrent check's container that exits meanwhile cannot fail an inspect.
  const rows = docker([
    'ps',
    '-a',
    '--filter',
    'label=rezics.kernel.check.pid',
    '--format',
    '{{.ID}} {{.Label "rezics.kernel.check.pid"}}',
  ])
    .split('\n')
    .filter(Boolean);
  for (const row of rows) {
    const [id, owner] = row.split(' ');
    try {
      process.kill(Number(owner), 0);
    } catch {
      // Removing a container that is already gone is the outcome we want.
      spawnSync('docker', ['rm', '-f', id!], { cwd: directory, encoding: 'utf8' });
    }
  }
}

function cleanup(): void {
  for (const id of [searchContainer, container]) {
    if (!id) continue;
    try {
      docker(['rm', '-f', id]);
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
  const searchImage = buildSearchImage();
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
  searchContainer = docker([
    'run',
    '-d',
    '--label',
    `rezics.kernel.check.pid=${pid}`,
    '-p',
    '127.0.0.1::9200',
    '--tmpfs',
    '/usr/share/opensearch/data:rw,size=1g,uid=1000,gid=1000,mode=0755',
    '-e',
    'discovery.type=single-node',
    '-e',
    'DISABLE_SECURITY_PLUGIN=true',
    '-e',
    'DISABLE_INSTALL_DEMO_CONFIG=true',
    '-e',
    'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m',
    searchImage,
  ]);
  const searchPortOutput = docker(['port', searchContainer, '9200/tcp']);
  const searchPortMatch = searchPortOutput.match(/127\.0\.0\.1:(\d+)/);
  if (!searchPortMatch?.[1]) fail(`Could not determine the test search port: ${searchPortOutput}`);
  const searchUrl = `http://127.0.0.1:${searchPortMatch[1]}`;

  const portOutput = docker(['port', container, '5432/tcp']);
  const match = portOutput.match(/127\.0\.0\.1:(\d+)/);
  if (!match?.[1]) fail(`Could not determine the test database port: ${portOutput}`);
  const url = `postgres://rezics:rezics@127.0.0.1:${match[1]}/rezics?sslmode=disable`;
  process.env.KERNEL_DATABASE_CONTAINER = container;
  const env = { ...process.env, DATABASE_URL: url, KERNEL_DATABASE_CONTAINER: container };

  migrate(url);
  for (const [path, dump] of Object.entries(schemaDumps(url))) {
    const file = Bun.file(resolve(directory, path));
    if (!(await file.exists()) || (await file.text()) !== dump) {
      fail(`Schema dump differs from ${path}; run \`bun run db dump\``);
    }
  }

  run(resolve(directory, '../../node_modules/.bin/tsc'), ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json'], env);
  run(resolve(directory, '../../node_modules/.bin/oxlint'), ['--config', '../../.oxlintrc.json', '.'], env);
  run(resolve(directory, '../../node_modules/.bin/oxfmt'), ['--check', '.'], env);

  const testFiles = Array.from(new Bun.Glob('test/**/*.test.ts').scanSync({ cwd: directory })).sort();
  await waitForSearch(searchUrl, searchContainer);
  for (const [index, file] of testFiles.entries()) {
    const database = `kernel_test_${index + 1}`;
    // Each file gets a fresh copy so its result cannot depend on writes from another file.
    docker([
      'exec',
      container,
      'psql',
      '-U',
      'rezics',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `CREATE DATABASE ${database} TEMPLATE rezics`,
    ]);
    try {
      run('bun', ['test', `./${file}`], {
        ...env,
        DATABASE_URL: url.replace(/\/rezics(?=\?)/, `/${database}`),
        OPENSEARCH_URL: searchUrl,
      });
    } finally {
      // The tmpfs holds one copy at a time; keeping every copy filled it once the suite passed 80 files.
      docker([
        'exec',
        container,
        'psql',
        '-U',
        'rezics',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
      ]);
    }
  }
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
