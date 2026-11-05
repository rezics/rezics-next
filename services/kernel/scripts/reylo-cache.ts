import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { typecheckCacheRoot } from '../../../scripts/typecheck.ts';
import { POSTGRES_IMAGE, schemaDumps } from './database.ts';

// Kernel's SQL analysis cache: shared by `typecheck`, `check` and every throwaway database consumer on a host.
const directory = resolve(fileURLToPath(new URL('..', import.meta.url)));

type ReyloCacheManifest = { version: 1; files: Record<string, string> };

export type ReyloAnalysisPreparation = {
  available: boolean;
  environment: NodeJS.ProcessEnv;
  analyzedFiles: number;
  totalFiles: number;
  /** Entries Reylo wrote while analysing the changed files; renamed entries are reused, not counted. */
  writtenEntries: number;
  dispose: () => void;
};

export type ReyloAnalysisDependencies = {
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
    ['services/kernel/scripts/reylo-cache.ts', fileURLToPath(import.meta.url)],
    ['typescript/package.json', join(repository, 'node_modules/typescript/package.json')],
    ['reylo/package.json', join(workspace, 'node_modules/reylo/package.json')],
    ['reylo/src/cli.js', join(workspace, 'node_modules/reylo/src/cli.js')],
    ['reylo/src/engine.js', join(workspace, 'node_modules/reylo/src/engine.js')],
    ['reylo/src/native.js', join(workspace, 'node_modules/reylo/src/native.js')],
  ];
  const engineOverride = process.env.REYLO_ENGINE_PATH;
  if (engineOverride) hash.update(engineOverride).update('\0').update(readFileSync(engineOverride)).update('\0');
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
    // Once `current` moves, the older snapshots of this base are unreferenced. A reader that still holds one finds it
    // invalid and analyses from scratch, as it would for any unreadable snapshot.
    for (const name of readdirSync(snapshots))
      if (name !== digest && !name.startsWith('.')) rmSync(join(snapshots, name), { recursive: true, force: true });
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

/** The number of Reylo entries in a `.reylo/queries` directory; a missing directory has none. */
function entryCount(queries: string): number {
  try {
    return readdirSync(queries).filter((file) => file.endsWith('.json')).length;
  } catch (error) {
    if (isInvalidCachePath(error)) return 0;
    throw error;
  }
}

/**
 * Reylo names an entry by its statement and by its server's URL, host and port included. Every throwaway database has
 * a new port, so the copied entries are renamed to this server's name: an unchanged statement then finds its own entry,
 * which is reused while the schema matches, and a changed statement adds one entry.
 */
function rekeyEntries(queries: string, url: string): void {
  const database = new URL(url);
  const server = createHash('sha256')
    .update(`${database.protocol}//${database.username}@${database.host}${database.pathname}`)
    .digest('hex')
    .slice(0, 16);
  let names: string[];
  try {
    names = readdirSync(queries);
  } catch (error) {
    if (isInvalidCachePath(error)) return;
    throw error;
  }
  for (const name of names.sort()) {
    const match = /^([0-9a-f]{32})-([0-9a-f]{16})\.json$/.exec(name);
    if (match && match[2] !== server) renameSync(join(queries, name), join(queries, `${match[1]}-${server}.json`));
  }
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
    writtenEntries: 0,
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
    let written = 0;
    if (changed.length > 0) {
      writeFileSync(configFile, `direct_url: ${JSON.stringify(env.DATABASE_URL)}\n`);
      const queries = join(privateRoot, '.reylo', 'queries');
      rekeyEntries(queries, env.DATABASE_URL);
      const before = entryCount(queries);
      const generated = await (dependencies.generate ?? generateReyloAnalysis)(changed, configFile, env, workspace);
      if (generated.status !== 0) {
        rmSync(privateRoot, { recursive: true, force: true });
        return noCache();
      }
      written = entryCount(queries) - before;
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
      writtenEntries: written,
      dispose: () => rmSync(privateRoot, { recursive: true, force: true }),
    };
  } finally {
    if (!keep) rmSync(privateRoot, { recursive: true, force: true });
  }
}
