import { KERNEL_CLIENT_OUTPUT, withKernelClientOutput } from '../../../scripts/check-output-tree.ts';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withThrowawayDatabase } from './derived.ts';
import {
  compilerConfigArgs,
  compilerEnvironment,
  isLocalTypecheckLanding,
  placeCompilerRun,
  typecheckCacheRoot,
  type CompilerPlacementDependencies,
} from '../../../scripts/typecheck.ts';
import { POSTGRES_IMAGE, schemaDumps, validateMigrationVersions } from './database.ts';
import { withCommandPhase, writeCommandObservation, commandObservation } from './command-phases.ts';

const directory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repository = resolve(directory, '../..');

function workspacePath(path: string): string | undefined {
  const relativePath = relative(repository, path);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) || relativePath === '')
    return undefined;
  return relativePath.split(sep).join('/');
}

function returnedPaths(
  env: NodeJS.ProcessEnv,
  emitClient: boolean,
  emitSchema: string | undefined,
  emitOpenApi: boolean,
): string[] | undefined {
  // External projects cannot be represented by the workspace-relative placement contract.
  const projectDirectory = env.REYLO_CONFIG ? dirname(resolve(directory, env.REYLO_CONFIG)) : directory;
  if (workspacePath(resolve(projectDirectory, '.reylo')) === undefined) return undefined;

  // tsc, construct and optional client emission consume the compiler's `.reylo/`
  // analyses before placement returns. The caller consumes only their status and
  // requested generated outputs. Release analyses are generated separately by analyse.ts;
  // returning this cache would recursively include entries from unrelated databases/runs.
  const paths: string[] = emitClient ? [KERNEL_CLIENT_OUTPUT.transport] : [];
  if (emitOpenApi) paths.push('contracts/openapi.json');
  if (emitSchema === 'core') paths.push('services/kernel/db/schema.sql');
  if (
    emitSchema !== undefined &&
    /^[a-z][a-z0-9_]*$/.test(emitSchema) &&
    emitSchema !== 'migrations' &&
    isDirectory(resolve(directory, 'db', emitSchema, 'migrations'))
  ) {
    const schema = workspacePath(resolve(directory, 'db', emitSchema, 'schema.sql'));
    if (schema !== undefined) paths.push(schema);
  }
  return paths;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function command(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = Bun.spawn(args, {
    cwd: directory,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await child.exited;
}

async function compilerCommand(phase: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return withCommandPhase(phase, () => command(args, env), env);
}

type ReyloCacheManifest = { version: 1; files: Record<string, string> };

export type ReyloAnalysisPreparation = {
  available: boolean;
  environment: NodeJS.ProcessEnv;
  analyzedFiles: number;
  totalFiles: number;
  dispose: () => void;
};

type ReyloAnalysisDependencies = {
  cacheRoot?: string;
  repository?: string;
  workspace?: string;
  schemaDumps?: (url: string, workspace: string) => Record<string, string>;
  identity?: (repository: string, workspace: string) => string;
  generate?: (
    files: readonly string[],
    configFile: string,
    env: NodeJS.ProcessEnv,
    workspace: string,
  ) => Promise<{ status: number; stdout: string; stderr: string }>;
};

function sha256(...parts: (string | Uint8Array)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

/** A canonical digest of the migrated schema, independent of the throwaway PostgreSQL server identity. */
export function schemaDumpDigest(dumps: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(dumps).sort()) hash.update(path).update('\0').update(dumps[path]!).update('\0');
  return hash.digest('hex');
}

function reyloAnalysisIdentity(repository: string, workspace: string): string {
  const hash = createHash('sha256')
    .update(Bun.version)
    .update('\0')
    .update(Bun.revision)
    .update('\0')
    .update(process.versions.node ?? '')
    .update('\0');
  const inputs: readonly (readonly [string, string])[] = [
    ['package.json', join(repository, 'package.json')],
    ['bun.lock', join(repository, 'bun.lock')],
    ['scripts/typecheck.ts', join(repository, 'scripts/typecheck.ts')],
    ['scripts/compiler-database.ts', join(repository, 'scripts/compiler-database.ts')],
    ['services/kernel/package.json', join(workspace, 'package.json')],
    ['services/kernel/tsconfig.json', join(workspace, 'tsconfig.json')],
    ['services/kernel/scripts/typecheck.ts', fileURLToPath(import.meta.url)],
    ['typescript/package.json', join(repository, 'node_modules/typescript/package.json')],
    ['reylo/package.json', join(workspace, 'node_modules/reylo/package.json')],
    ['reylo/src/cli.js', join(workspace, 'node_modules/reylo/src/cli.js')],
    ['reylo/src/engine.js', join(workspace, 'node_modules/reylo/src/engine.js')],
    ['reylo/src/native.js', join(workspace, 'node_modules/reylo/src/native.js')],
  ];
  for (const [name, path] of inputs) {
    hash.update(name).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}

function stableDatabaseConfiguration(url: string, env: NodeJS.ProcessEnv): string {
  const database = new URL(url);
  return JSON.stringify({
    protocol: database.protocol,
    username: database.username,
    database: database.pathname,
    options: [...database.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0,
    ),
    pgOptions: env.PGOPTIONS ?? '',
    postgresImage: POSTGRES_IMAGE,
  });
}

class InvalidReyloAnalysisCache extends Error {}

function isInvalidCachePath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
}

function cacheManifest(value: unknown): ReyloCacheManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidReyloAnalysisCache('Invalid Reylo analysis cache manifest');
  const record = value as { version?: unknown; files?: unknown };
  if (record.version !== 1 || !record.files || typeof record.files !== 'object' || Array.isArray(record.files))
    throw new InvalidReyloAnalysisCache('Invalid Reylo analysis cache manifest');
  const files = record.files as Record<string, unknown>;
  for (const [path, digest] of Object.entries(files))
    if (
      !path.startsWith('src/') ||
      path.split('/').some((part) => part === '..' || part === '.') ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new InvalidReyloAnalysisCache('Invalid Reylo analysis cache manifest');
  return { version: 1, files: files as Record<string, string> };
}

type ReyloCacheSnapshot = {
  id: string;
  directory: string;
  manifest: ReyloCacheManifest;
  manifestText: string;
};

function readCacheSnapshot(base: string): ReyloCacheSnapshot | undefined {
  let snapshotId: string;
  try {
    snapshotId = readFileSync(join(base, 'current'), 'utf8').trim();
  } catch (error) {
    if (isInvalidCachePath(error)) return undefined;
    throw error;
  }
  if (!/^[a-f0-9]{64}$/.test(snapshotId)) return undefined;

  const directory = join(base, 'snapshots', snapshotId);
  let manifestText: string;
  try {
    manifestText = readFileSync(join(directory, 'manifest.json'), 'utf8');
  } catch (error) {
    if (isInvalidCachePath(error)) return undefined;
    throw error;
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  try {
    return { id: snapshotId, directory, manifest: cacheManifest(manifestValue), manifestText };
  } catch (error) {
    if (error instanceof InvalidReyloAnalysisCache) return undefined;
    throw error;
  }
}

function copyCacheTree(
  source: string,
  destination: string,
  hash: ReturnType<typeof createHash>,
  relativeRoot: string,
): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    const relativePath = `${relativeRoot}/${entry.name}`;
    if (entry.isSymbolicLink())
      throw new InvalidReyloAnalysisCache(`Reylo analysis cache contains a symbolic link: ${from}`);
    if (entry.isDirectory()) copyCacheTree(from, to, hash, relativePath);
    else if (entry.isFile()) {
      mkdirSync(dirname(to), { recursive: true });
      const contents = readFileSync(from);
      writeFileSync(to, contents);
      hash.update(relativePath).update('\0').update(contents).update('\0');
    } else throw new InvalidReyloAnalysisCache(`Reylo analysis cache contains an unsupported file: ${from}`);
  }
}

function publishCacheSnapshot(base: string, project: string, manifest: string): void {
  const snapshots = join(base, 'snapshots');
  mkdirSync(snapshots, { recursive: true });
  const temporary = mkdtempSync(join(snapshots, '.snapshot-'));
  try {
    const hash = createHash('sha256');
    copyCacheTree(join(project, '.reylo'), join(temporary, '.reylo'), hash, '.reylo');
    writeFileSync(join(temporary, 'manifest.json'), manifest);
    hash.update('manifest.json').update('\0').update(manifest).update('\0');
    const digest = hash.digest('hex');
    const target = join(snapshots, digest);
    try {
      renameSync(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EEXIST' && code !== 'ENOTEMPTY') || !existsSync(target)) throw error;
      rmSync(temporary, { recursive: true, force: true });
    }
    const pointer = join(base, `.current-${randomUUID()}.tmp`);
    writeFileSync(pointer, `${digest}\n`);
    renameSync(pointer, join(base, 'current'));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function generateReyloAnalysis(
  files: readonly string[],
  configFile: string,
  env: NodeJS.ProcessEnv,
  workspace: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const cli = resolve(workspace, 'node_modules/reylo/src/cli.js');
  const child = Bun.spawn([process.execPath, cli, 'generate', ...files], {
    cwd: workspace,
    env: { ...env, REYLO_CONFIG: configFile },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

/**
 * Build a private Reylo view for this run. The host cache is immutable and namespaced by the resulting schema dump;
 * Reylo's own statement entries then let a changed SQL file add only its new statement analysis.
 */
export async function prepareReyloAnalysisCache(
  env: NodeJS.ProcessEnv,
  dependencies: ReyloAnalysisDependencies = {},
): Promise<ReyloAnalysisPreparation> {
  const repository = resolve(dependencies.repository ?? resolve(directory, '../..'));
  const workspace = resolve(dependencies.workspace ?? directory);
  const noCache = (): ReyloAnalysisPreparation => ({
    available: false,
    environment: env,
    analyzedFiles: 0,
    totalFiles: 0,
    dispose: () => {},
  });
  if (
    !env.DATABASE_URL ||
    !env.KERNEL_DATABASE_CONTAINER ||
    env.REYLO_CONFIG !== undefined ||
    existsSync(resolve(workspace, '.reylo.yaml')) ||
    existsSync(resolve(workspace, '.reylo.yml'))
  )
    return noCache();

  const dumps = (dependencies.schemaDumps ?? schemaDumps)(env.DATABASE_URL, workspace);
  const schemaDigest = schemaDumpDigest(dumps);
  const identity = sha256(
    (dependencies.identity ?? reyloAnalysisIdentity)(repository, workspace),
    stableDatabaseConfiguration(env.DATABASE_URL, env),
  );
  const base = join(dependencies.cacheRoot ?? typecheckCacheRoot(env), 'reylo-kernel', identity, schemaDigest);
  const snapshot = readCacheSnapshot(base);
  let previous: ReyloCacheManifest = snapshot?.manifest ?? { version: 1, files: {} };

  const sourceFiles = [...new Bun.Glob('src/**/*.sql').scanSync({ cwd: workspace })].sort();
  const hashes = Object.fromEntries(sourceFiles.map((file) => [file, sha256(readFileSync(resolve(workspace, file)))]));
  let changed = sourceFiles.filter((file) => previous.files[file] !== hashes[file]);
  const runRoot = join(repository, '.temp/typecheck/reylo-runs');
  mkdirSync(runRoot, { recursive: true });
  const privateRoot = mkdtempSync(join(runRoot, 'kernel-'));
  const configFile = join(privateRoot, '.reylo.yaml');
  let keep = false;
  try {
    if (snapshot) {
      try {
        const hash = createHash('sha256');
        copyCacheTree(join(snapshot.directory, '.reylo'), join(privateRoot, '.reylo'), hash, '.reylo');
        hash.update('manifest.json').update('\0').update(snapshot.manifestText).update('\0');
        if (hash.digest('hex') !== snapshot.id)
          throw new InvalidReyloAnalysisCache('Reylo analysis cache snapshot digest does not match its contents');
      } catch (error) {
        if (!(error instanceof InvalidReyloAnalysisCache) && !isInvalidCachePath(error)) throw error;
        rmSync(join(privateRoot, '.reylo'), { recursive: true, force: true });
        previous = { version: 1, files: {} };
        changed = sourceFiles;
      }
    }
    if (changed.length > 0) {
      writeFileSync(configFile, `direct_url: ${JSON.stringify(env.DATABASE_URL)}\n`);
      const generated = await (dependencies.generate ?? generateReyloAnalysis)(changed, configFile, env, workspace);
      if (generated.status !== 0) {
        rmSync(privateRoot, { recursive: true, force: true });
        return noCache();
      }
    }
    writeFileSync(configFile, 'direct_url: ""\n');
    if (changed.length > 0) {
      const manifest = JSON.stringify({ version: 1, files: hashes } satisfies ReyloCacheManifest) + '\n';
      mkdirSync(base, { recursive: true });
      publishCacheSnapshot(base, privateRoot, manifest);
    }
    keep = true;
    return {
      available: true,
      environment: { ...env, REYLO_CONFIG: configFile },
      analyzedFiles: changed.length,
      totalFiles: sourceFiles.length,
      dispose: () => rmSync(privateRoot, { recursive: true, force: true }),
    };
  } finally {
    if (!keep) rmSync(privateRoot, { recursive: true, force: true });
  }
}

async function typecheck(
  env: NodeJS.ProcessEnv,
  emitClient: boolean,
  emitSchema?: string,
  emitOpenApi = false,
  prepareSqlAnalysis: typeof prepareReyloAnalysisCache = prepareReyloAnalysisCache,
): Promise<number> {
  const incremental = localCompilerStateArgs(env);
  const analysis = await withCommandPhase('sql-analysis', () => prepareSqlAnalysis(env), env);
  if (analysis.available)
    process.stdout.write(
      `Kernel SQL analysis cache: analyzed ${analysis.analyzedFiles}, reused ${analysis.totalFiles - analysis.analyzedFiles} of ${analysis.totalFiles} files.\n`,
    );
  const compilerEnv = analysis.available ? analysis.environment : env;
  const typecheckEnv = { ...compilerEnv };
  if (analysis.available) delete typecheckEnv.DATABASE_URL;
  let compiled: number;
  try {
    compiled = await withCommandPhase(
      'compiler',
      async () => {
        // Client-dependent tests must see declarations from the source being checked.
        // The generator checks all source modules; the full workspace checks still run before publication.
        if (emitClient) {
          const emitted = await compilerCommand('client-emit', ['bun', 'scripts/client.ts'], typecheckEnv);
          if (emitted !== 0) return emitted;
        }
        const tsc = await withCommandPhase(
          'typecheck',
          () =>
            compilerCommand(
              'tsc',
              ['tsc', '--noEmit', ...incremental, '--runExternalCode', '-p', 'tsconfig.json'],
              typecheckEnv,
            ),
          env,
        );
        if (tsc !== 0) return tsc;
        const constructed = await compilerCommand('construct', ['bun', 'run', 'construct'], compilerEnv);
        if (constructed !== 0) return constructed;
        if (emitOpenApi) {
          const contract = await compilerCommand('openapi', ['bun', 'scripts/openapi.ts'], compilerEnv);
          if (contract !== 0) return contract;
        }
        return 0;
      },
      env,
    );
  } finally {
    analysis.dispose();
  }
  if (compiled !== 0) return compiled;
  // Migration work can refresh its own snapshot using this same compiler database.
  // No additional database, native check or change to other modules' snapshots is needed.
  if (emitSchema !== undefined) {
    await withCommandPhase(
      'sql-schema',
      async () => {
        const path = emitSchema === 'core' ? 'db/schema.sql' : `db/${emitSchema}/schema.sql`;
        const dump = schemaDumps(env.DATABASE_URL!, directory)[path];
        if (dump === undefined) throw new Error(`Unknown schema module: ${emitSchema}`);
        await Bun.write(resolve(directory, path), dump);
      },
      env,
    );
  }
  return 0;
}

function localCompilerStateArgs(env: NodeJS.ProcessEnv): string[] {
  if (!isLocalTypecheckLanding(env)) return [];
  const file = env.TYPECHECK_BUILD_INFO_FILE;
  const allowed = `${resolve(repository, '.temp/typecheck/compiler-state/runs')}${sep}`;
  const stateFile = file ? resolve(file) : '';
  if (!stateFile.startsWith(allowed)) throw new Error('Local landing typecheck has no safe compiler state file');
  return ['--incremental', '--tsBuildInfoFile', stateFile];
}

export async function runKernelTypecheck(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: CompilerPlacementDependencies & {
    typecheck?: typeof typecheck;
    prepareSqlAnalysis?: typeof prepareReyloAnalysisCache;
    withThrowawayDatabase?: typeof withThrowawayDatabase;
    outputTree?: typeof withKernelClientOutput;
  } = {},
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  env = compilerEnvironment(env, args);
  const emitClient = args.includes('--emit-client');
  const emitOpenApi = args.includes('--emit-openapi');
  const emitSchema = args.find((arg) => arg.startsWith('--emit-schema='))?.slice('--emit-schema='.length);
  const runCommands = dependencies.typecheck ?? typecheck;
  const withDatabase = dependencies.withThrowawayDatabase ?? withThrowawayDatabase;
  const compile = (databaseEnv: NodeJS.ProcessEnv) => {
    const compilerEnv =
      env.REYLO_CONFIG === undefined ? databaseEnv : { ...databaseEnv, REYLO_CONFIG: env.REYLO_CONFIG };
    return emitSchema === undefined
      ? runCommands(compilerEnv, emitClient, undefined, emitOpenApi, dependencies.prepareSqlAnalysis)
      : runCommands(compilerEnv, emitClient, emitSchema, emitOpenApi, dependencies.prepareSqlAnalysis);
  };
  const config = compilerConfigArgs(env, repository, [directory]);
  const returns = returnedPaths(env, emitClient, emitSchema, emitOpenApi);
  const remoteCommand = [
    'bun',
    'scripts/typecheck.ts',
    ...(emitClient ? ['--emit-client'] : []),
    ...(emitOpenApi ? ['--emit-openapi'] : []),
    ...(emitSchema === undefined ? [] : [`--emit-schema=${emitSchema}`]),
    ...config,
  ];
  const placed = isLocalTypecheckLanding(env)
    ? null
    : await placeCompilerRun(
        {
          label: 'kernel typecheck',
          root: repository,
          cwd: directory,
          command: remoteCommand,
          keepsFiles: emitClient || emitOpenApi || emitSchema !== undefined || returns === undefined,
          ...(returns === undefined ? {} : { returns }),
        },
        directory,
        env,
        dependencies,
      );
  if (placed !== null) return placed;
  writeCommandObservation('kernel typecheck', commandObservation(remoteCommand, repository, env), env);
  // The compiler database applies the same migrations as derived generation, in admitted custody only.
  validateMigrationVersions(
    Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory })),
    new Date(),
  );
  const run = () => (env.DATABASE_URL ? compile(env) : withDatabase(compile));
  return emitClient
    ? (dependencies.outputTree ?? withKernelClientOutput)(repository, run, { returns: returns ?? [] })
    : run();
}

if (import.meta.main) {
  try {
    process.exitCode = await runKernelTypecheck();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
