/** Native development preparation. No Kernel host or SQL module is imported eagerly. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  prepareReyloAnalysisCache,
  schemaDumpDigest,
  type ReyloAnalysisDependencies,
  type ReyloAnalysisPreparation,
} from '../../kernel/scripts/reylo-cache.ts';
import { schemaDumps } from '../../kernel/scripts/database.ts';
import { processIdentity, terminateDetachedGroup, type RunnerIdentity } from '../../../scripts/check-custody.ts';

const repository = resolve(import.meta.dir, '../../..');
const kernel = resolve(repository, 'services/kernel');
const preparationKey = 'REZICS_LOCAL_STACK_NATIVE_KEY';
const owned = new Set<ReyloAnalysisPreparation>();
const preparations = new Map<string, Promise<NodeJS.ProcessEnv>>();

/** Every actual nested operation starts inside its phase, including synchronous work and failures. */
export async function nativePhase<T>(name: string, work: () => T | Promise<T>): Promise<T> {
  const started = performance.now();
  console.error(`stack: ${name} starting utc=${new Date().toISOString()}`);
  try {
    const value = await work();
    console.error(
      `stack: ${name} ready utc=${new Date().toISOString()} elapsedMs=${Math.round(performance.now() - started)}`,
    );
    return value;
  } catch (error) {
    console.error(
      `stack: ${name} failed utc=${new Date().toISOString()} elapsedMs=${Math.round(performance.now() - started)}`,
    );
    throw new Error(
      `walk: the ${name} phase did not start: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

export function developmentDatabaseUrl(value: string): string {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1')
    throw new Error('Local stack requires a PostgreSQL database on 127.0.0.1');
  return url.href;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Includes TS callers/declarations as well as SQL, compiler, package and engine inputs. */
export function developmentNativeSourceIdentity(root = repository): string {
  const hash = createHash('sha256').update(Bun.version).update(Bun.revision);
  const files = new Set([
    'package.json',
    'bun.lock',
    'tsconfig.base.json',
    'apps/web/scripts/website-configuration.ts',
    'apps/web/src/session/website-scopes.ts',
    ...new Bun.Glob('{services/{auth,kernel},packages/*}/{src,scripts}/**/*.{ts,tsx,js,json,sql}').scanSync({
      cwd: root,
    }),
    ...new Bun.Glob('{services/{auth,kernel},packages/*}/{package.json,tsconfig.json}').scanSync({ cwd: root }),
    'node_modules/typescript/package.json',
  ]);
  for (const file of [...files].sort())
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(resolve(root, file)))
      .update('\0');
  for (const workspace of ['auth', 'kernel']) {
    for (const file of ['package.json', 'src/cli.js', 'src/engine.js', 'src/native.js']) {
      const path = resolve(root, 'services', workspace, 'node_modules/reylo', file);
      hash.update(`${workspace}/reylo/${file}`).update(readFileSync(path));
    }
    for (const file of ['.reylo.yaml', '.reylo.yml']) {
      const path = resolve(root, 'services', workspace, file);
      if (existsSync(path)) hash.update(path).update(readFileSync(path));
    }
  }
  if (process.env.REYLO_ENGINE_PATH) hash.update(readFileSync(process.env.REYLO_ENGINE_PATH));
  return hash.digest('hex');
}

type NativeInputs = {
  key: string;
  environment: NodeJS.ProcessEnv;
  dumps: Record<string, string>;
};

export type DevelopmentNativeDependencies = {
  sourceIdentity?: () => string;
  schemaDumps?: typeof schemaDumps;
  prepareSql?: typeof prepareReyloAnalysisCache;
  generate?: ReyloAnalysisDependencies['generate'];
  directory?: string;
};

async function nativeInputs(
  environment: NodeJS.ProcessEnv,
  dependencies: DevelopmentNativeDependencies,
): Promise<NativeInputs> {
  const env: NodeJS.ProcessEnv & { DATABASE_URL: string } = {
    ...process.env,
    ...environment,
    DATABASE_URL: developmentDatabaseUrl(environment.DATABASE_URL!),
  };
  // Bind the URL before either the generator or Reylo's first worker snapshots the environment.
  // A compiler's inherited REYLO_CONFIG is not a native-stack preparation for this database.
  delete env.REYLO_CONFIG;
  delete env[preparationKey];
  const dumps = await nativePhase('native-schema', () => {
    const previous = process.env.KERNEL_DATABASE_CONTAINER;
    if (env.KERNEL_DATABASE_CONTAINER === undefined) delete process.env.KERNEL_DATABASE_CONTAINER;
    else process.env.KERNEL_DATABASE_CONTAINER = env.KERNEL_DATABASE_CONTAINER;
    try {
      return (dependencies.schemaDumps ?? schemaDumps)(env.DATABASE_URL, kernel);
    } finally {
      if (previous === undefined) delete process.env.KERNEL_DATABASE_CONTAINER;
      else process.env.KERNEL_DATABASE_CONTAINER = previous;
    }
  });
  const source = await nativePhase('native-sources', () =>
    (dependencies.sourceIdentity ?? developmentNativeSourceIdentity)(),
  );
  return {
    environment: env,
    dumps,
    key: digest(JSON.stringify([env.DATABASE_URL, env.PGOPTIONS ?? '', schemaDumpDigest(dumps), source])),
  };
}

/** One owned generator group; cancellation settles the engine descendants before private files are removed. */
export async function runDevelopmentNativeGenerator(
  command: string[],
  workspace: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd: workspace,
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  const parent = processIdentity()!;
  const identity: RunnerIdentity = processIdentity(child.pid) ?? { ...parent, pid: child.pid, group: child.pid };
  let cancellation: NodeJS.Signals | undefined;
  let settlement: Promise<Awaited<ReturnType<typeof terminateDetachedGroup>>> | undefined;
  const drain = () => (settlement ??= terminateDetachedGroup(identity, 250));
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
    const handler = () => {
      cancellation ??= signal;
      void drain();
    };
    process.once(signal, handler);
    return [signal, handler] as const;
  });
  const killOnExit = () => {
    try {
      process.kill(-identity.group, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  process.once('exit', killOnExit);
  try {
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const status = await child.exited;
    const result = await drain();
    const [stdout, stderr] = await output;
    if (!result.terminal) throw new Error(`Native SQL generator did not settle: ${result.reason}`);
    if (cancellation) throw new Error(`Native SQL generator cancelled by ${cancellation}\n${stdout}${stderr}`);
    return { status, stdout, stderr };
  } finally {
    await drain();
    process.off('exit', killOnExit);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

async function prepareInputs(
  inputs: NativeInputs,
  dependencies: DevelopmentNativeDependencies,
): Promise<NodeJS.ProcessEnv> {
  const analysis = await nativePhase('native-sql-preparation', () =>
    (dependencies.prepareSql ?? prepareReyloAnalysisCache)(inputs.environment, {
      // Auth reads its SQL text directly; only Kernel SQL imports need Reylo analysis.
      workspace: kernel,
      sourceWorkspaces: [kernel],
      schemaWorkspace: kernel,
      schemaDumps: () => inputs.dumps,
      // Native callers also work with a published local URL without a named container.
      // The existing producer's container check is replaced by the schema already read from that exact URL.
      allowDirectDatabase: true,
      requireAnalysis: true,
      generate:
        dependencies.generate ??
        ((files, configFile, env, workspace) =>
          runDevelopmentNativeGenerator(
            [process.execPath, resolve(workspace, 'node_modules/reylo/src/cli.js'), 'generate', ...files],
            workspace,
            { ...env, REYLO_CONFIG: configFile },
          )),
      phase: (name, work) => nativePhase(`native-sql-${name}`, work),
    }),
  );
  owned.add(analysis);
  console.error(
    `stack: native-sql-work analyzedFiles=${analysis.analyzedFiles} reusedFiles=${analysis.totalFiles - analysis.analyzedFiles} totalFiles=${analysis.totalFiles} writtenEntries=${analysis.writtenEntries}`,
  );
  return { ...analysis.environment, [preparationKey]: inputs.key };
}

/** The parent shares its prepared view with Auth, Kernel, Worker and frontend binding callers. */
export async function prepareDevelopmentNative(
  environment: NodeJS.ProcessEnv,
  dependencies: DevelopmentNativeDependencies = {},
  inputs?: NativeInputs,
): Promise<NodeJS.ProcessEnv> {
  inputs ??= await nativeInputs(environment, dependencies);
  const inherited = { ...process.env, ...environment };
  if (inherited[preparationKey] === inputs.key && inherited.REYLO_CONFIG)
    return { ...inputs.environment, REYLO_CONFIG: inherited.REYLO_CONFIG, [preparationKey]: inputs.key };
  let prepared = preparations.get(inputs.key);
  if (!prepared) {
    prepared = prepareInputs(inputs, dependencies);
    preparations.set(inputs.key, prepared);
    void prepared.catch(() => preparations.delete(inputs!.key));
  }
  const analysisEnv = await prepared;
  return {
    ...inputs.environment,
    ...(analysisEnv.REYLO_CONFIG ? { REYLO_CONFIG: analysisEnv.REYLO_CONFIG } : {}),
    [preparationKey]: inputs.key,
  };
}

/** Runtime imports retain their private view until all children and deferred SQL imports have settled. */
export function disposeDevelopmentNative(): void {
  for (const analysis of owned) analysis.dispose();
  owned.clear();
  preparations.clear();
}
process.once('exit', disposeDevelopmentNative);

/** The SQL loader snapshots both values on first use; restore both after native loading. */
export async function withDevelopmentDatabase<T>(
  environment: NodeJS.ProcessEnv,
  load: () => Promise<T>,
  dependencies: DevelopmentNativeDependencies = {},
  inputs?: NativeInputs,
): Promise<T> {
  const prepared = await prepareDevelopmentNative(environment, dependencies, inputs);
  const previous = { DATABASE_URL: process.env.DATABASE_URL, REYLO_CONFIG: process.env.REYLO_CONFIG };
  Object.assign(process.env, { DATABASE_URL: prepared.DATABASE_URL, REYLO_CONFIG: prepared.REYLO_CONFIG });
  if (prepared.REYLO_CONFIG === undefined) delete process.env.REYLO_CONFIG;
  try {
    await nativePhase('native-registration', () => import('reylo/register'));
    return await load();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Cache only the result of the real mount. Configuration, database, schema and source changes all retire it. */
export async function developmentNativeWebsite<T>(
  environment: NodeJS.ProcessEnv,
  mount: () => Promise<T>,
  dependencies: DevelopmentNativeDependencies = {},
): Promise<T> {
  const inputs = await nativeInputs(environment, dependencies);
  const configuration = { ...environment };
  delete configuration.REYLO_CONFIG;
  delete configuration[preparationKey];
  const artifactPath = process.env.WEBSITE_CONFIGURATION_FILE;
  const artifact = artifactPath
    ? await nativePhase('catalogue-deployment-input', () => readFile(resolve(repository, artifactPath), 'utf8'))
    : undefined;
  const key = digest(
    JSON.stringify([
      inputs.key,
      Object.entries(configuration).sort(([a], [b]) => a.localeCompare(b)),
      artifactPath,
      artifact,
    ]),
  );
  const path = resolve(
    dependencies.directory ?? resolve(repository, '.temp/local-stack/native-website'),
    `${key}.json`,
  );
  const cached = await nativePhase('catalogue-prepared-read', async () => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  });
  if (cached !== undefined) return JSON.parse(cached) as T;
  const website = await withDevelopmentDatabase(environment, mount, dependencies, inputs);
  await nativePhase('catalogue-prepared-publish', async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(website)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  });
  return website;
}
