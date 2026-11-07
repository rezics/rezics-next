import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const viteDepCacheReadyName = '_ready';
export const viteDepCacheLockName = '_lock';
export const viteDepCacheMetadataName = join('deps', '_metadata.json');
export const viteDepCacheSsrMetadataName = join('deps_ssr', '_metadata.json');
export const viteDepCacheMetadataFiles = [viteDepCacheMetadataName, viteDepCacheSsrMetadataName] as const;

export const webViteCalendarOptimizeDeps = ['react-day-picker', 'date-fns', '@date-fns/tz'] as const;

const webAppPackageJson = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const typeboxBareSpecifier = /^typebox(?:\/|$)/;

export type ViteWorkerResolveAlias = { find: string; replacement: string };

export type InstalledTypeboxWorkerImport = {
  specifier: string;
  importer: string;
  resolved: string;
};

export type InstalledElysiaTypeboxWorkerGraph = {
  elysiaRoot: string;
  elysiaEsm: string;
  typeboxRoot: string;
  first: InstalledTypeboxWorkerImport;
  imports: InstalledTypeboxWorkerImport[];
  aliases: ViteWorkerResolveAlias[];
  include: string[];
};

type PackageExports = Record<string, string | { import?: string; default?: string; require?: string }>;

function namedPackageRoot(resolved: string, name: string): string {
  const needle = `${sep}node_modules${sep}${name.replaceAll('/', sep)}`;
  const index = resolved.lastIndexOf(needle);
  if (index !== -1) return resolved.slice(0, index + needle.length);
  let current = resolved;
  for (;;) {
    try {
      const listed = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')) as { name?: string };
      if (listed.name === name) return current;
    } catch {
      // Walk toward the filesystem root until the named package directory is found.
    }
    const parent = dirname(current);
    if (parent === current) return dirname(resolved);
    current = parent;
  }
}

function readPackageExports(root: string): PackageExports {
  const listed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports?: PackageExports };
  return listed.exports ?? {};
}

function exportFile(
  root: string,
  entry: PackageExports[string] | undefined,
  field: 'import' | 'default' | 'require',
): string | undefined {
  if (!entry) return undefined;
  const relativePath = typeof entry === 'string' ? entry : (entry[field] ?? entry.import ?? entry.default);
  if (!relativePath) return undefined;
  return join(root, relativePath);
}

function specifierForExportKey(name: string, key: string): string | undefined {
  if (key === '.') return name;
  if (key === './package.json' || !key.startsWith('./')) return undefined;
  return `${name}/${key.slice(2)}`;
}

function existingFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}

function resolveElysiaRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  return (
    existingFile(base) ??
    existingFile(`${base}.mjs`) ??
    existingFile(`${base}.js`) ??
    existingFile(join(base, 'index.mjs')) ??
    existingFile(join(base, 'index.js'))
  );
}

function walkElysiaTypeboxImporters(elysiaRoot: string, elysiaEsm: string): Map<string, string> {
  const root = `${elysiaRoot}${sep}`;
  const queue = [elysiaEsm];
  const seenFiles = new Set<string>();
  const firstImporter = new Map<string, string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seenFiles.has(file) || !file.startsWith(root)) continue;
    seenFiles.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]!;
      if (typeboxBareSpecifier.test(specifier)) {
        if (!firstImporter.has(specifier)) firstImporter.set(specifier, file);
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const next = resolveElysiaRelative(file, specifier);
      if (next) queue.push(next);
    }
  }
  return firstImporter;
}

function resolveInstalledSpecifier(require: NodeJS.Require, specifier: string): string | undefined {
  try {
    return realpathSync(require.resolve(specifier));
  } catch {
    return undefined;
  }
}

/** Installed Elysia ESM graph of `typebox` / `typebox/*` plus TypeBox package exports, resolved from that importer. */
export function installedElysiaTypeboxWorkerGraph(fromFile: string): InstalledElysiaTypeboxWorkerGraph {
  const fromRequire = createRequire(fromFile);
  const clientRequire = createRequire(fromRequire.resolve('@rezics/client'));
  const elysiaResolved = clientRequire.resolve('elysia');
  const elysiaRoot = namedPackageRoot(elysiaResolved, 'elysia');
  const elysiaEsm =
    existingFile(exportFile(elysiaRoot, readPackageExports(elysiaRoot)['.'], 'import') ?? '') ?? elysiaResolved;
  const importers = walkElysiaTypeboxImporters(elysiaRoot, elysiaEsm);
  const firstSpecifier = importers.keys().next().value;
  if (!firstSpecifier) throw new Error(`Elysia ESM at ${elysiaEsm} imports no typebox specifiers`);
  const firstImporter = importers.get(firstSpecifier)!;
  const typeboxRequire = createRequire(firstImporter);
  const typeboxRoot = namedPackageRoot(typeboxRequire.resolve('typebox'), 'typebox');
  const bySpecifier = new Map<string, InstalledTypeboxWorkerImport>();
  const admit = (specifier: string, importer: string) => {
    if (bySpecifier.has(specifier)) return;
    const resolved = resolveInstalledSpecifier(createRequire(importer), specifier);
    if (!resolved) return;
    bySpecifier.set(specifier, { specifier, importer, resolved });
  };
  for (const [specifier, importer] of importers) admit(specifier, importer);
  for (const key of Object.keys(readPackageExports(typeboxRoot))) {
    const specifier = specifierForExportKey('typebox', key);
    if (specifier) admit(specifier, firstImporter);
  }
  const imports = [...bySpecifier.values()];
  const first = bySpecifier.get(firstSpecifier);
  if (!first) throw new Error(`Installed TypeBox exports do not resolve ${firstSpecifier} from ${firstImporter}`);
  const aliases = [...imports]
    .map(({ specifier, resolved }) => ({ find: specifier, replacement: resolved }))
    .sort((left, right) => right.find.length - left.find.length || left.find.localeCompare(right.find));
  return {
    elysiaRoot,
    elysiaEsm,
    typeboxRoot,
    first,
    imports,
    aliases,
    include: aliases.map((alias) => alias.find).sort((left, right) => left.localeCompare(right)),
  };
}

export const webViteTypeboxWorkerGraph = installedElysiaTypeboxWorkerGraph(webAppPackageJson);

const elysiaTypeboxLivePath = /^(.*\/elysia\/(?:dist|src)\/type\/)(typebox-type|typebox-value)\.(?:mjs|js|cjs|ts)$/;

/** Elysia's default TypeBox stubs `require()` subpaths. Workerd has no sync loader, so load the sibling live ESM. */
export function elysiaTypeboxLiveModule(id: string): string | undefined {
  const path = (id.split('?')[0] ?? id).replace(/\\/g, '/');
  const match = elysiaTypeboxLivePath.exec(path);
  if (!match) return undefined;
  const live = `${match[1]}${match[2]}-live.mjs`;
  return existsSync(live) ? live : undefined;
}

export function elysiaTypeboxLiveModuleCode(id: string): string | undefined {
  const live = elysiaTypeboxLiveModule(id);
  if (!live) return undefined;
  return `export * from ${JSON.stringify(live)};\n`;
}

/** Scan the complete route graph up front so a local Worker browser check never discovers a route dependency
 * after the first page has loaded.
 */
export const webViteClientOptimizeDeps = {
  entries: ['src/routes/**/*.tsx', 'src/server.ts', 'src/session/routes.ts'],
  holdUntilCrawlEnd: true,
  exclude: [...webViteCalendarOptimizeDeps],
} as const;

export const webViteWorkerSsrOptimizeDeps = {
  noDiscovery: true,
  holdUntilCrawlEnd: true,
  entries: [] as string[],
  include: [
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'react-dom',
    'react-dom/server',
    'react-dom/server.edge',
    '@tanstack/react-router > @tanstack/react-store',
    '@inlang/paraglide-js/urlpattern-polyfill',
    // CommonJS packages a Worker graph walk reached raw. Nested parents are not resolvable from the app root.
    'satori/standalone',
    '@puckeditor/core > flat',
    '@puckeditor/core > object-hash',
    // TypeBox subpaths Elysia imports. Worker conditions omit `import`, so the optimizer and workerd otherwise
    // treat `typebox/type` as `elysia/dist/type/typebox/type`.
    ...webViteTypeboxWorkerGraph.include,
  ],
  exclude: [...webViteCalendarOptimizeDeps],
};

export const webViteWarmSsrEnvName = 'WEB_VITE_WARM_SSR';

const webViteWorkerSsrConditionNames = ['workerd', 'worker', 'module', 'browser'] as const;

/** Worker resolve conditions used when warming SSR optimizeDeps without Miniflare. */
export const webViteWorkerSsrResolve = {
  noExternal: true as const,
  conditions: [...webViteWorkerSsrConditionNames, 'development|production'],
};

/** Rolldown options matching Cloudflare's Worker optimizer so warmed files use the same builds. */
export const webViteWorkerSsrRolldownOptions = {
  platform: 'neutral' as const,
  resolve: {
    conditionNames: [...webViteWorkerSsrConditionNames, 'development'],
    extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json', '.cjs', '.cts', '.ctx'],
  },
  transform: { target: 'es2026' as const },
};

/** SSR environment that pre-bundles the pinned includes without loading worktree source. */
export const webViteWorkerSsrEnvironment = {
  consumer: 'server' as const,
  keepProcessEnv: true,
  resolve: webViteWorkerSsrResolve,
  optimizeDeps: {
    noDiscovery: webViteWorkerSsrOptimizeDeps.noDiscovery,
    holdUntilCrawlEnd: webViteWorkerSsrOptimizeDeps.holdUntilCrawlEnd,
    entries: [] as string[],
    include: [...webViteWorkerSsrOptimizeDeps.include],
    exclude: [...webViteWorkerSsrOptimizeDeps.exclude],
    rolldownOptions: webViteWorkerSsrRolldownOptions,
  },
};

/** Optimizer inputs that decide what is pre-bundled. Worktree paths and serve plugin lists are restamped later. */
export const webViteOptimizerIdentity = {
  client: webViteClientOptimizeDeps,
  ssr: {
    noDiscovery: webViteWorkerSsrOptimizeDeps.noDiscovery,
    holdUntilCrawlEnd: webViteWorkerSsrOptimizeDeps.holdUntilCrawlEnd,
    entries: webViteWorkerSsrOptimizeDeps.entries,
    include: webViteWorkerSsrOptimizeDeps.include,
    exclude: webViteWorkerSsrOptimizeDeps.exclude,
  },
} as const;

export type ViteDepCacheReady = {
  lockHash: string;
  builtAt: string;
};

export type PrepareViteDepCacheOptions = {
  workspaceRoot: string;
  appRoot: string;
  env?: NodeJS.ProcessEnv;
  cacheHome?: string;
  lockBytes?: Uint8Array | string;
  patchBytes?: string;
  optimizer?: unknown;
  build?: (stagingDirectory: string, env: NodeJS.ProcessEnv) => Promise<void>;
  now?: () => Date;
  pollIntervalMs?: number;
  waitMs?: number;
};

export type ViteDepCache = {
  directory: string;
  lockHash: string;
  reused: boolean;
};

export type ViteDepCacheOptimizerHashes = {
  hash: string;
  lockfileHash: string;
  configHash: string;
};

export type ViteEnvironmentForDepHash = {
  config: {
    root: string;
    keepProcessEnv?: boolean;
    mode?: string;
    resolve?: unknown;
    assetsInclude?: unknown;
    plugins?: Array<{ name: string }>;
    optimizeDeps?: {
      include?: string[];
      exclude?: string[];
      rolldownOptions?: Record<string, unknown> & { output?: Record<string, unknown> };
    };
    optimizeDepsPluginNames?: string[];
  };
};

export type ViteDepCacheAlignEnvironment = ViteEnvironmentForDepHash & {
  name?: string;
  depsOptimizer?: { init: () => Promise<unknown> };
};

const lockfileFormats: Array<{ path: string; checkPatchesDir: false | string; manager: string }> = [
  { path: 'node_modules/.pnpm/lock.yaml', checkPatchesDir: false, manager: 'pnpm' },
  { path: 'node_modules/.package-lock.json', checkPatchesDir: 'patches', manager: 'npm' },
  { path: 'node_modules/.yarn-state.yml', checkPatchesDir: false, manager: 'yarn' },
  { path: 'bun.lock', checkPatchesDir: 'patches', manager: 'bun' },
  { path: '.rush/temp/shrinkwrap-deps.json', checkPatchesDir: false, manager: 'pnpm' },
  { path: 'aube-lock.yaml', checkPatchesDir: false, manager: 'aube' },
  { path: 'nub.lock', checkPatchesDir: false, manager: 'nub' },
  { path: '.pnp.cjs', checkPatchesDir: '.yarn/patches', manager: 'yarn' },
  { path: '.pnp.js', checkPatchesDir: '.yarn/patches', manager: 'yarn' },
  { path: 'node_modules/.yarn-integrity', checkPatchesDir: 'patches', manager: 'yarn' },
  { path: 'bun.lockb', checkPatchesDir: 'patches', manager: 'bun' },
];

function cacheHome(env: NodeJS.ProcessEnv, override?: string): string {
  if (override) return resolve(override);
  if (env.XDG_CACHE_HOME) return resolve(env.XDG_CACHE_HOME);
  return join(homedir(), '.cache');
}

export function viteDepCacheRoot(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  return join(cacheHome(env, home), 'rezics', 'web-vite-deps');
}

export function hashLockfile(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function viteHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').substring(0, 8);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function tryStatSync(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function lookupFile(dir: string, fileNames: readonly string[]): string | undefined {
  let current = dir;
  for (;;) {
    for (const fileName of fileNames) {
      const fullPath = join(current, fileName);
      if (tryStatSync(fullPath)?.isFile()) return fullPath;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Concatenated `patches/` file bytes so reuse follows content, not directory mtime. */
export function readPatchBytes(workspaceRoot: string): string {
  const directory = join(workspaceRoot, 'patches');
  const root = tryStatSync(directory);
  if (!root?.isDirectory()) return '';
  const parts: string[] = [];
  const walk = (current: string) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) parts.push(relative(directory, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'));
    }
  };
  walk(directory);
  return parts.join('\0');
}

export function hashViteDepCacheIdentity(input: {
  lockBytes: Uint8Array | string;
  patchBytes?: string;
  optimizer?: unknown;
}): string {
  const lock = typeof input.lockBytes === 'string' ? input.lockBytes : Buffer.from(input.lockBytes).toString('utf8');
  return hashLockfile(
    `${lock}\0${input.patchBytes ?? ''}\0${JSON.stringify(input.optimizer ?? webViteOptimizerIdentity)}`,
  );
}

/** Same 8-character lockfile hash Vite uses, including bun `patches/` mtime. */
export function viteLockfileHash(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const formats = [...lockfileFormats].sort((_, { manager }) =>
    env.npm_config_user_agent?.startsWith(manager) ? 1 : -1,
  );
  const lockfilePath =
    lookupFile(
      root,
      formats.map((format) => format.path),
    ) ?? lookupFile(root, ['yarn.lock']);
  let content = lockfilePath ? readFileSync(lockfilePath, 'utf8') : '';
  if (lockfilePath) {
    const normalized = lockfilePath.replaceAll('\\', '/');
    const format = [...formats, { path: 'yarn.lock', checkPatchesDir: false as const, manager: 'yarn' }].find((entry) =>
      normalized.endsWith(entry.path),
    );
    if (format?.checkPatchesDir) {
      const baseDir = lockfilePath.slice(0, -format.path.length);
      const stat = tryStatSync(join(baseDir, format.checkPatchesDir));
      if (stat?.isDirectory()) content += stat.mtimeMs.toString();
    }
  }
  return viteHash(content);
}

/** Same config hash Vite compares at optimizer init, including root, plugins and resolve. */
export function viteEnvironmentConfigHash(environment: ViteEnvironmentForDepHash): string {
  const { config } = environment;
  const optimizeDeps = config.optimizeDeps ?? {};
  const rolldownOptions = optimizeDeps.rolldownOptions;
  return viteHash(
    JSON.stringify(
      {
        define: !config.keepProcessEnv ? process.env.NODE_ENV || config.mode : null,
        root: config.root,
        resolve: config.resolve,
        assetsInclude: config.assetsInclude,
        plugins: (config.plugins ?? []).map((plugin) => plugin.name),
        optimizeDeps: {
          include: optimizeDeps.include ? unique(optimizeDeps.include).sort() : undefined,
          exclude: optimizeDeps.exclude ? unique(optimizeDeps.exclude).sort() : undefined,
          rolldownOptions: {
            ...rolldownOptions,
            plugins: undefined,
            onLog: undefined,
            onwarn: undefined,
            checks: undefined,
            output: {
              ...rolldownOptions?.output,
              plugins: undefined,
            },
          },
        },
        optimizeDepsPluginNames: config.optimizeDepsPluginNames,
      },
      (_, value) => {
        if (typeof value === 'function' || value instanceof RegExp) return value.toString();
        return value;
      },
    ),
  );
}

export function viteEnvironmentDepHashes(
  environment: ViteEnvironmentForDepHash,
  env: NodeJS.ProcessEnv = process.env,
): ViteDepCacheOptimizerHashes {
  const lockfileHash = viteLockfileHash(environment.config.root, env);
  const configHash = viteEnvironmentConfigHash(environment);
  return {
    lockfileHash,
    configHash,
    hash: viteHash(lockfileHash + configHash),
  };
}

export function viteDepCacheOptimizeCommand(appRoot: string): string[] {
  return [join(appRoot, 'node_modules', '.bin', 'vite'), 'optimize', '--force'];
}

/** Node, not Bun: Cloudflare's config loader refuses `process.versions.bun`, matching the Vite CLI. */
export function viteDepCacheWarmCommand(appRoot: string): string[] {
  return ['node', join(appRoot, 'scripts', 'warm-vite-deps.ts')];
}

export function viteDepCacheMetadataFile(environmentName: string): string {
  return environmentName === 'client' ? viteDepCacheMetadataName : join(`deps_${environmentName}`, '_metadata.json');
}

function writeMetadataHashes(path: string, hashes: ViteDepCacheOptimizerHashes): void {
  const metadata = JSON.parse(readFileSync(path, 'utf8')) as ViteDepCacheOptimizerHashes;
  if (
    metadata.lockfileHash === hashes.lockfileHash &&
    metadata.configHash === hashes.configHash &&
    metadata.hash === hashes.hash
  )
    return;
  metadata.lockfileHash = hashes.lockfileHash;
  metadata.configHash = hashes.configHash;
  metadata.hash = hashes.hash;
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

/** Rewrite Vite metadata lockfileHash in this process so a later optimizer skip uses the same hash. */
export function alignViteLockfileHashes(
  directory: string,
  appRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const lockfileHash = viteLockfileHash(appRoot, env);
  for (const relativePath of viteDepCacheMetadataFiles) {
    const path = join(directory, relativePath);
    if (!existsSync(path)) continue;
    const metadata = JSON.parse(readFileSync(path, 'utf8')) as { lockfileHash?: string };
    if (metadata.lockfileHash === lockfileHash) continue;
    metadata.lockfileHash = lockfileHash;
    writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
  }
}

/**
 * Copy this Vite process's optimizer hashes onto published metadata before init reads it.
 * `vite optimize` and middleware-mode warm hash a different plugin list than `vite serve`,
 * so an isolated-network start would otherwise delete the cache and hang on DNS.
 */
export function alignViteDepCacheToOptimizer(
  directory: string,
  environmentName: string,
  hashes: ViteDepCacheOptimizerHashes,
): void {
  const path = join(directory, viteDepCacheMetadataFile(environmentName));
  if (!existsSync(path)) return;
  writeMetadataHashes(path, hashes);
}

export function alignViteDepCacheEnvironments(
  directory: string,
  environments: Record<string, ViteDepCacheAlignEnvironment | undefined>,
): void {
  for (const [name, environment] of Object.entries(environments)) {
    if (!environment?.config) continue;
    alignViteDepCacheToOptimizer(directory, environment.name ?? name, viteEnvironmentDepHashes(environment));
  }
}

/**
 * Restamp hashes now and again immediately before `depsOptimizer.init`.
 * Cloudflare may call init during `configureServer`, which is before Vite's post-hooks.
 */
export function bindViteDepCacheAlign(
  directory: string,
  environments: Record<string, ViteDepCacheAlignEnvironment | undefined>,
): () => void {
  alignViteDepCacheEnvironments(directory, environments);
  for (const [name, environment] of Object.entries(environments)) {
    const optimizer = environment?.depsOptimizer;
    if (!optimizer) continue;
    const originalInit = optimizer.init.bind(optimizer);
    optimizer.init = async () => {
      alignViteDepCacheEnvironments(directory, { [name]: environment });
      return originalInit();
    };
  }
  return () => alignViteDepCacheEnvironments(directory, environments);
}

/** Copy published dependency output into a run-private directory the Vite process may restamp. */
export function materializeViteDepCache(published: ViteDepCache, runDirectory: string): string {
  rmSync(runDirectory, { recursive: true, force: true });
  mkdirSync(dirname(runDirectory), { recursive: true, mode: 0o700 });
  cpSync(published.directory, runDirectory, { recursive: true });
  return runDirectory;
}
