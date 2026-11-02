import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, POSTGRES_IMAGE, schemaDumps, validateMigrationVersions } from './database.ts';
import { cleanup, docker, run } from './check.ts';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(directory, '../..');

type DerivedCacheState = {
  version: 1;
  checkout: string;
  migrations: string;
  container: string;
};

type DerivedContainer = {
  id: string;
  running: boolean;
  checkout: string;
};

type OpenApiCacheState = {
  version: 1;
  sources: string;
  output: string;
};

const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.sql']);

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function checkoutKey(root = repository): string {
  return digest(resolve(root)).slice(0, 20);
}

/** Migration order and contents both identify the database schema this cache contains. */
export function migrationFingerprint(files: readonly string[], root = directory): string {
  const hash = createHash('sha256');
  hash.update(POSTGRES_IMAGE).update('\0');
  for (const file of [...files].sort()) {
    const path = resolve(root, file);
    hash.update(relative(root, path).split(sep).join('/')).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}

export function reusableDerivedDatabase(
  state: DerivedCacheState | undefined,
  container: DerivedContainer | undefined,
  checkout: string,
  migrations: string,
): boolean {
  return Boolean(
    state?.version === 1 &&
      state.checkout === checkout &&
      state.migrations === migrations &&
      container?.running &&
      container.id === state.container &&
      container.checkout === checkout,
  );
}

/** Source changes invalidate OpenAPI; output edits also force a repair from the generator. */
export function openApiCacheMatches(
  state: OpenApiCacheState | undefined,
  sources: string,
  output: string | undefined,
): boolean {
  return Boolean(state?.version === 1 && state.sources === sources && output && state.output === output);
}

function sourceFiles(root: string, pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync({ cwd: root })]
    .filter((file) => sourceExtensions.has(file.slice(file.lastIndexOf('.'))))
    .sort();
}

/** Fingerprint local routes, their source modules and workspace package implementations without loading the app. */
export function openApiSourceFingerprint(kernelDirectory = directory, repositoryRoot = repository): string {
  const manifests = [
    'package.json',
    'bun.lock',
    'services/kernel/package.json',
    ...[...new Bun.Glob('packages/*/package.json').scanSync({ cwd: repositoryRoot })],
  ].filter((file) => existsSync(resolve(repositoryRoot, file)));
  const entries = [
    ...sourceFiles(kernelDirectory, 'src/**/*').map((file) => [
      relative(repositoryRoot, resolve(kernelDirectory, file)).split(sep).join('/'),
      resolve(kernelDirectory, file),
    ] as const),
    ...['scripts/openapi.ts', 'test/support/receipt-keys.ts']
      .filter((file) => existsSync(resolve(kernelDirectory, file)))
      .map((file) => [
        relative(repositoryRoot, resolve(kernelDirectory, file)).split(sep).join('/'),
        resolve(kernelDirectory, file),
      ] as const),
    ...sourceFiles(repositoryRoot, 'packages/*/src/**/*')
      .filter((file) => !file.startsWith('packages/client/src/kernel/'))
      .map((file) => [file, resolve(repositoryRoot, file)] as const),
    ...manifests.map((file) => [file, resolve(repositoryRoot, file)] as const),
  ].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const hash = createHash('sha256');
  for (const [name, path] of entries) hash.update(name).update('\0').update(readFileSync(path)).update('\0');
  return hash.digest('hex');
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

function withCacheLock<T>(path: string, work: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 10 * 60_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    let descriptor: number;
    try {
      descriptor = openSync(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ownerText: string;
      try {
        ownerText = readFileSync(path, 'utf8').trim();
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw readError;
      }
      if (!ownerText) {
        let lockAge: number;
        try {
          lockAge = Date.now() - statSync(path).mtimeMs;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }
        if (lockAge > 10_000) {
          try {
            unlinkSync(path);
          } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
          }
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for derived cache lock ${path}`);
        Atomics.wait(pause, 0, 0, 50);
        continue;
      }
      const owner = Number(ownerText);
      let alive = Number.isSafeInteger(owner) && owner > 0;
      if (alive) {
        try {
          process.kill(owner, 0);
        } catch (signalError) {
          alive = (signalError as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      }
      if (!alive) {
        try {
          if (readFileSync(path, 'utf8').trim() !== ownerText) continue;
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw readError;
        }
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for derived cache lock ${path}`);
      Atomics.wait(pause, 0, 0, 50);
      continue;
    }
    try {
      writeFileSync(descriptor, String(process.pid));
    } catch (error) {
      closeSync(descriptor);
      unlinkSync(path);
      throw error;
    }
    try {
      return work();
    } finally {
      closeSync(descriptor);
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

function inspectDerivedContainer(name: string): DerivedContainer | undefined {
  const id = docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']).trim();
  if (!id) return undefined;
  const [fullId, running, checkout] = docker([
    'inspect',
    '--format',
    '{{.Id}}|{{.State.Running}}|{{ index .Config.Labels "rezics.kernel.derived.checkout" }}',
    id,
  ]).trim().split('|');
  return { id: fullId!, running: running === 'true', checkout: checkout ?? '' };
}

function mappedPort(container: string): string {
  const port = docker(['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
  if (!port) throw new Error('Could not determine the throwaway database port');
  return port;
}

function createDatabaseContainer(name: string, checkout: string): string {
  return docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `rezics.kernel.derived.checkout=${checkout}`,
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
  ]).trim();
}

function reusableDatabaseUrl(migrations: string): { container: string; url: string } {
  const checkout = checkoutKey();
  const name = `rezics-kernel-derived-${checkout}`;
  const cacheDirectory = resolve(repository, '.temp');
  const statePath = resolve(cacheDirectory, `kernel-derived-${checkout}.json`);
  const lockPath = resolve(cacheDirectory, `kernel-derived-${checkout}.lock`);
  return withCacheLock(lockPath, () => {
    const state = readJson<DerivedCacheState>(statePath);
    let found = inspectDerivedContainer(name);
    if (found && found.checkout !== checkout) throw new Error(`Refusing unowned derived database container ${name}`);
    if (reusableDerivedDatabase(state, found, checkout, migrations)) {
      const port = mappedPort(found!.id);
      return { container: found!.id, url: `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable` };
    }

    if (found) docker(['rm', '-f', found.id]);
    rmSync(statePath, { force: true });
    const container = createDatabaseContainer(name, checkout);
    try {
      const port = mappedPort(container);
      const url = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
      migrate(url);
      writeJson(statePath, { version: 1, checkout, migrations, container } satisfies DerivedCacheState);
      return { container, url };
    } catch (error) {
      docker(['rm', '-f', container]);
      throw error;
    }
  });
}

function generateOpenApiIfNeeded(): boolean {
  const sources = openApiSourceFingerprint();
  const contract = resolve(repository, 'contracts/openapi.json');
  const statePath = resolve(repository, '.temp', `kernel-openapi-${checkoutKey()}.json`);
  const state = readJson<OpenApiCacheState>(statePath);
  const output = existsSync(contract) ? digest(readFileSync(contract)) : undefined;
  if (openApiCacheMatches(state, sources, output)) return false;
  return true;
}

function recordOpenApiGeneration(): void {
  const contract = resolve(repository, 'contracts/openapi.json');
  const output = readFileSync(contract);
  writeJson(resolve(repository, '.temp', `kernel-openapi-${checkoutKey()}.json`), {
    version: 1,
    sources: openApiSourceFingerprint(),
    output: digest(output),
  } satisfies OpenApiCacheState);
}

/** Start or reuse a migration-matched throwaway database, run `work`, and remove one-run containers. */
export async function withThrowawayDatabase<T>(
  work: (env: NodeJS.ProcessEnv) => Promise<T> | T,
  options: { reuse?: boolean } = {},
): Promise<T> {
  const reuse = options.reuse ?? false;
  let container = '';
  const inheritedUrl = process.env.DATABASE_URL;
  const inheritedContainer = process.env.KERNEL_DATABASE_CONTAINER;
  const onSigint = (): void => {
    if (!reuse) cleanup([container]);
    process.exit(130);
  };
  const onSigterm = (): void => {
    if (!reuse) cleanup([container]);
    process.exit(143);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    let url: string;
    if (reuse) {
      const migrations = Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory }));
      const prepared = reusableDatabaseUrl(migrationFingerprint(migrations));
      container = prepared.container;
      url = prepared.url;
    } else {
      container = docker([
        'run',
        '-d',
        '--rm',
        '--label',
        `rezics.kernel.derived.pid=${process.pid}`,
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
      const port = mappedPort(container);
      url = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
      migrate(url);
    }
    process.env.KERNEL_DATABASE_CONTAINER = container;
    process.env.DATABASE_URL = url;
    const env = { ...process.env, DATABASE_URL: url, KERNEL_DATABASE_CONTAINER: container };
    return await work(env);
  } finally {
    if (!reuse) cleanup([container]);
    // A later consumer must not inherit a URL this one-run container no longer serves.
    if (inheritedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = inheritedUrl;
    if (inheritedContainer === undefined) delete process.env.KERNEL_DATABASE_CONTAINER;
    else process.env.KERNEL_DATABASE_CONTAINER = inheritedContainer;
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

function derivedAction(args: readonly string[]): 'schema' | 'contracts' {
  if (args.length === 0) return 'contracts';
  if (args.length === 1 && args[0] === 'schema') return 'schema';
  throw new Error(`Unsupported derived arguments: ${args.join(' ')}`);
}

/** Write dumps from the checkout's migration-matched throwaway database, ignoring inherited development settings. */
async function writeSchemaDumps(env: NodeJS.ProcessEnv): Promise<void> {
  const url = env.DATABASE_URL;
  const container = env.KERNEL_DATABASE_CONTAINER;
  if (!url || !container) throw new Error('Throwaway database connection is missing');
  // withThrowawayDatabase also installs the selected container for schemaDumps' pg_dump.
  const dumps = schemaDumps(url, directory);
  for (const [path, dump] of Object.entries(dumps)) {
    await Bun.write(resolve(directory, path), dump);
  }
}

async function main(): Promise<void> {
  const action = derivedAction(process.argv.slice(2));
  const migrations = Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory }));
  validateMigrationVersions(migrations, new Date());
  if (action === 'schema') {
    await withThrowawayDatabase(writeSchemaDumps, { reuse: true });
    return;
  }
  const generateOpenApi = generateOpenApiIfNeeded();
  await withThrowawayDatabase(
    (env) => {
      if (generateOpenApi) {
        run('bun', ['scripts/openapi.ts'], env);
        recordOpenApiGeneration();
      }
      run('bun', ['scripts/client.ts'], env);
    },
    { reuse: true },
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
