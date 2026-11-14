import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';

const artifactSchema = 1;
const artifactLimit = 2;
const lockWaitMs = 10 * 60_000;
const lockPollMs = 40;
const localLockGraceMs = 30_000;
const remoteOwnerExpiryMs = 6 * 60 * 60_000;
const modes = {
  'screenshot-test': ['storybook build --test --disable-telemetry --quiet; one Web site'],
  full: [
    'web Storybook build --config-dir .storybook --quiet; STORYBOOK_UI_URL=./ui/',
    'UI Storybook build --config-dir .storybook --quiet; accessibility probe removed',
  ],
} as const;

export type StorybookBuildMode = keyof typeof modes;
export type StorybookArtifactInput = { path: string; contents: string | Uint8Array };
export type StorybookArtifactBuildStats = { nestedBuilds?: number };
export type StorybookArtifactLease = {
  identity: string;
  site: string;
  bytes: number;
  disposition: 'built' | 'reused';
  nestedBuilds: number;
  nestedReuses: number;
  release: () => Promise<void>;
};
export type StorybookArtifactStore = {
  acquire: (
    identity: string,
    build: (site: string, workDirectory: string) => Promise<StorybookArtifactBuildStats | void>,
    options?: { signal?: AbortSignal; mode?: StorybookBuildMode; onBuildStart?: (directory: string) => void },
  ) => Promise<StorybookArtifactLease>;
};

export class StorybookArtifactBuildCleanupFailure extends Error {
  constructor(
    readonly buildFailure: unknown,
    readonly cleanupFailure: unknown,
  ) {
    super('Storybook artifact build workspace cleanup failed.', { cause: buildFailure });
    this.name = 'StorybookArtifactBuildCleanupFailure';
  }
}

type ArtifactMetadata = {
  schema: number;
  identity: string;
  mode: StorybookBuildMode;
  bytes: number;
  createdAt: string;
  nestedBuilds: number;
};
type LockOwner = { pid: number; host: string; createdAt: number };
type LeaseOwner = { pid: number; host: string; createdAt: number };

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(String(signal?.reason ?? 'Artifact acquisition aborted.'));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Hash build inputs by path and content; Git revisions and unrelated commit history never participate. */
export function storybookArtifactIdentity(input: {
  mode: StorybookBuildMode;
  files: readonly StorybookArtifactInput[];
  configuration?: Readonly<Record<string, string>>;
}): string {
  const files = [...input.files]
    .map((file) => ({
      path: file.path.replaceAll('\\', '/'),
      contents: typeof file.contents === 'string' ? Buffer.from(file.contents) : file.contents,
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ schema: artifactSchema, mode: input.mode, configuration: input.configuration ?? {} }));
  for (const file of files) {
    hash.update('\0');
    hash.update(String(Buffer.byteLength(file.path)));
    hash.update(':');
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.contents.byteLength));
    hash.update(':');
    hash.update(file.contents);
  }
  return hash.digest('hex');
}

async function collectTree(root: string, path: string, files: Map<string, Uint8Array>): Promise<void> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (
        [
          'node_modules',
          '.git',
          '.temp',
          'dist',
          'storybook-static',
          '.wrangler',
          'coverage',
          'test',
          'tests',
          '__tests__',
        ].includes(entry.name)
      )
        continue;
      await collectTree(root, child, files);
    } else if (entry.isFile()) {
      const name = relative(root, child).split(sep).join('/');
      if (name === 'apps/web/src/routeTree.gen.ts' || /\.(?:test|spec)\.[^.]+$/.test(entry.name)) continue;
      files.set(name, await readFile(child));
    }
  }
}

async function collectRootConfig(root: string, directory: string, files: Map<string, Uint8Array>): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !/^(package\.json|tsconfig[^/]*\.json|vite\.config\.[cm]?[jt]s|project\.inlang|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s)$/.test(
        entry.name,
      )
    )
      continue;
    const path = join(directory, entry.name);
    files.set(relative(root, path).split(sep).join('/'), await readFile(path));
  }
}

function internalDependencies(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const packageJson = manifest as Record<string, unknown>;
  return [
    ...new Set(
      ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) => {
        const entries = packageJson[field];
        return typeof entries === 'object' && entries !== null
          ? Object.keys(entries as Record<string, unknown>).filter((name) => name.startsWith('@rezics/'))
          : [];
      }),
    ),
  ].sort();
}

/** Collect the bounded source, response, config and locked-toolchain inputs consumed by Web Storybook. */
export async function readStorybookArtifactIdentity(
  root: string,
  mode: StorybookBuildMode,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const files = new Map<string, Uint8Array>();
  for (const path of [
    'package.json',
    'bun.lock',
    'bunfig.toml',
    'apps/web/.storybook',
    'apps/web/src',
    'apps/web/public',
    'apps/auth/src',
  ]) {
    const absolute = join(root, path);
    if (path.includes('/')) await collectTree(root, absolute, files);
    else {
      try {
        files.set(path, await readFile(absolute));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }

  await collectRootConfig(root, join(root, 'apps/web'), files);
  await collectRootConfig(root, join(root, 'apps/auth'), files);
  const manifests = ['apps/web/package.json', 'apps/auth/package.json'];
  const seen = new Set<string>();
  while (manifests.length) {
    const manifestPath = manifests.shift()!;
    const packageName =
      manifestPath === 'apps/web/package.json'
        ? undefined
        : manifestPath === 'apps/auth/package.json'
          ? undefined
          : manifestPath.split('/').at(-2);
    if (packageName && seen.has(packageName)) continue;
    if (packageName) seen.add(packageName);
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(join(root, manifestPath), 'utf8'));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    for (const dependency of internalDependencies(manifest)) {
      const name = dependency.slice('@rezics/'.length);
      const packageRoot = join(root, 'packages', name);
      const childManifest = `packages/${name}/package.json`;
      if (!files.has(childManifest)) {
        try {
          const contents = await readFile(join(root, childManifest));
          files.set(childManifest, contents);
          await collectTree(root, join(packageRoot, 'src'), files);
          await collectRootConfig(root, packageRoot, files);
          if (mode === 'full' && name === 'ui') await collectTree(root, join(packageRoot, '.storybook'), files);
          manifests.push(childManifest);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      }
    }
  }

  for (const path of [
    'apps/web/scripts/screenshots.ts',
    'apps/web/scripts/storybook-artifact.ts',
    ...(mode === 'full'
      ? [
          'apps/web/scripts/generate.ts',
          'apps/web/scripts/storybook-build.ts',
          'apps/web/scripts/storybook-build-cleanup.ts',
          'apps/web/scripts/storybook-build-output.ts',
        ]
      : []),
  ]) {
    files.set(path, await readFile(join(root, path)));
  }

  return storybookArtifactIdentity({
    mode,
    files: [...files].map(([path, contents]) => ({ path, contents })),
    configuration: {
      STORYBOOK_DISABLE_COMPONENT_REF: env.STORYBOOK_DISABLE_COMPONENT_REF ?? '',
      STORYBOOK_UI_URL: mode === 'full' ? './ui/' : (env.STORYBOOK_UI_URL ?? ''),
      STORYBOOK_DISABLE_TELEMETRY: mode === 'screenshot-test' ? '1' : (env.STORYBOOK_DISABLE_TELEMETRY ?? ''),
      REZICS_UI_ACCESSIBILITY_PROBE: '',
      CI: mode === 'screenshot-test' ? '1' : (env.CI ?? ''),
      'Bun.version': Bun.version,
      'Node.version': process.version,
      buildFlags: modes[mode].join('\0'),
    },
  });
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function localProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

async function lockIsStale(path: string, now: number): Promise<boolean> {
  const owner = await readJson<LockOwner>(join(path, 'owner.json'));
  if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
    if (owner.host === hostname()) return !localProcessAlive(owner.pid);
    return now - owner.createdAt > remoteOwnerExpiryMs;
  }
  try {
    return now - (await stat(path)).mtimeMs > localLockGraceMs;
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
}

async function withLock<T>(root: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  const lock = join(root, '.lock');
  const deadline = Date.now() + lockWaitMs;
  await mkdir(root, { recursive: true });
  while (true) {
    throwIfAborted(signal);
    try {
      await mkdir(lock);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      if (await lockIsStale(lock, Date.now())) {
        const retired = `${lock}.stale-${randomUUID()}`;
        try {
          await rename(lock, retired);
          await rm(retired, { recursive: true, force: true });
        } catch (retireError) {
          if (errorCode(retireError) !== 'ENOENT') throw retireError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Storybook artifact lock did not settle within 10 minutes.');
      await delay(lockPollMs, signal);
      continue;
    }
    let result: T;
    let actionFailure: unknown;
    let actionFailed = false;
    try {
      await writeFile(
        join(lock, 'owner.json'),
        JSON.stringify({ pid: process.pid, host: hostname(), createdAt: Date.now() } satisfies LockOwner),
        { flag: 'wx' },
      );
      result = await action();
    } catch (error) {
      actionFailure = error;
      actionFailed = true;
    }
    let cleanupFailure: unknown;
    let cleanupFailed = false;
    try {
      await rm(lock, { recursive: true, force: true });
    } catch (error) {
      cleanupFailure = error;
      cleanupFailed = true;
    }
    if (actionFailed && cleanupFailed) {
      const actionMessage = actionFailure instanceof Error ? actionFailure.message : String(actionFailure);
      const cleanupMessage = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
      throw new AggregateError(
        [actionFailure, cleanupFailure],
        `Storybook artifact action failed (${actionMessage}) and lock cleanup failed (${cleanupMessage}).`,
        { cause: actionFailure },
      );
    }
    if (actionFailed) throw actionFailure;
    if (cleanupFailed) throw cleanupFailure;
    return result!;
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(path);
    else bytes += (await lstat(path)).size;
  }
  return bytes;
}

async function artifactMetadata(
  directory: string,
  identity: string,
  mode?: StorybookBuildMode,
): Promise<ArtifactMetadata | undefined> {
  const metadata = await readJson<ArtifactMetadata>(join(directory, 'artifact.json'));
  if (
    !metadata ||
    metadata.schema !== artifactSchema ||
    metadata.identity !== identity ||
    (mode !== undefined && metadata.mode !== mode) ||
    !Number.isSafeInteger(metadata.bytes) ||
    metadata.bytes < 0 ||
    !Number.isSafeInteger(metadata.nestedBuilds) ||
    metadata.nestedBuilds < 0 ||
    typeof metadata.createdAt !== 'string'
  )
    return undefined;
  try {
    const index = await stat(join(directory, 'site', 'index.json'));
    if (!index.isFile()) return undefined;
    if (mode === 'full' && !(await stat(join(directory, 'site', 'ui', 'index.json'))).isFile()) return undefined;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  return metadata;
}

async function leaseDirectory(root: string, identity: string): Promise<string> {
  const directory = join(root, '.leases', identity);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function leaseOwnerIsLive(owner: LeaseOwner | undefined, now: number): Promise<boolean> {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.host !== 'string') return false;
  if (owner.host === hostname()) return localProcessAlive(owner.pid);
  return now - owner.createdAt <= remoteOwnerExpiryMs;
}

async function liveLeaseFiles(root: string, identity: string): Promise<string[]> {
  const directory = join(root, '.leases', identity);
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const now = Date.now();
  const live: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    if (await leaseOwnerIsLive(await readJson<LeaseOwner>(path), now)) live.push(path);
    else await rm(path, { force: true });
  }
  return live;
}

async function artifactDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => join(root, entry.name));
}

async function acquireLease(
  root: string,
  identity: string,
  metadata: ArtifactMetadata,
  disposition: 'built' | 'reused',
): Promise<StorybookArtifactLease> {
  const directory = await leaseDirectory(root, identity);
  const leaseFile = join(directory, `${process.pid}-${randomUUID()}.json`);
  await writeFile(
    leaseFile,
    JSON.stringify({ pid: process.pid, host: hostname(), createdAt: Date.now() } satisfies LeaseOwner),
    { flag: 'wx' },
  );
  let released = false;
  return {
    identity,
    site: join(root, identity, 'site'),
    bytes: metadata.bytes,
    disposition,
    nestedBuilds: disposition === 'built' ? metadata.nestedBuilds : 0,
    nestedReuses: disposition === 'reused' ? 1 : 0,
    async release() {
      if (released) return;
      await withLock(root, undefined, async () => {
        await rm(leaseFile, { force: true });
        try {
          if ((await readdir(directory)).length === 0) await rm(directory, { recursive: true, force: true });
          const leasesRoot = dirname(directory);
          if ((await readdir(leasesRoot)).length === 0) await rm(leasesRoot, { recursive: true, force: true });
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      });
      released = true;
    },
  };
}

/** One cross-process build lock publishes complete immutable trees and protects active capture leases. */
export function createStorybookArtifactStore(root: string): StorybookArtifactStore {
  return {
    async acquire(identity, build, options = {}) {
      const deadline = Date.now() + lockWaitMs;
      while (true) {
        throwIfAborted(options.signal);
        const acquired = await withLock(root, options.signal, async () => {
          const entries = await readdir(root, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('.building-')) continue;
            const directory = join(root, entry.name);
            const owner = await readJson<LeaseOwner>(join(directory, '.owner.json'));
            if (await leaseOwnerIsLive(owner, Date.now())) return undefined;
            if (!owner) {
              try {
                if (Date.now() - (await stat(directory)).mtimeMs <= localLockGraceMs) return undefined;
              } catch (error) {
                if (errorCode(error) !== 'ENOENT') throw error;
              }
            }
            await rm(directory, { recursive: true, force: true });
          }

          const target = join(root, identity);
          const metadata = await artifactMetadata(target, identity, options.mode);
          if (metadata) return acquireLease(root, identity, metadata, 'reused');

          if (entries.some((entry) => entry.isDirectory() && entry.name === identity)) {
            if ((await liveLeaseFiles(root, identity)).length) return undefined;
            await rm(target, { recursive: true, force: true });
          }

          let directories = await artifactDirectories(root);
          const modified = await Promise.all(
            directories.map(async (directory) => [directory, (await stat(directory)).mtimeMs] as const),
          );
          modified.sort((left, right) => left[1] - right[1]);
          directories = modified.map(([directory]) => directory);
          for (const directory of directories) {
            if (directories.length < artifactLimit) break;
            const key = directory.slice(root.length + 1);
            if ((await liveLeaseFiles(root, key)).length) continue;
            await rm(directory, { recursive: true, force: true });
            directories = directories.filter((candidate) => candidate !== directory);
          }
          if (directories.length >= artifactLimit) return undefined;

          const workDirectory = await mkdtemp(join(root, `.building-${identity}-`));
          const site = join(workDirectory, 'site');
          try {
            await writeFile(
              join(workDirectory, '.owner.json'),
              JSON.stringify({ pid: process.pid, host: hostname(), createdAt: Date.now() } satisfies LeaseOwner),
              { flag: 'wx' },
            );
            options.onBuildStart?.(workDirectory);
            const stats = await build(site, workDirectory);
            const bytes = await directoryBytes(site);
            for (const entry of await readdir(workDirectory)) {
              if (entry !== 'site' && entry !== '.owner.json')
                await rm(join(workDirectory, entry), { recursive: true, force: true });
            }
            await rm(join(workDirectory, '.owner.json'), { force: true });
            const metadata: ArtifactMetadata = {
              schema: artifactSchema,
              identity,
              mode: options.mode ?? 'screenshot-test',
              bytes,
              createdAt: new Date().toISOString(),
              nestedBuilds: stats?.nestedBuilds ?? 1,
            };
            await writeFile(join(workDirectory, 'artifact.json'), `${JSON.stringify(metadata, null, 2)}\n`, {
              flag: 'wx',
            });
            if (!(await artifactMetadata(workDirectory, identity, metadata.mode))) {
              throw new Error(`Storybook artifact ${identity} build did not produce a complete site.`);
            }
            await rename(workDirectory, target);
            return acquireLease(root, identity, metadata, 'built');
          } catch (error) {
            const unproved =
              typeof error === 'object' &&
              error !== null &&
              'unproved' in error &&
              Array.isArray((error as { unproved?: unknown }).unproved) &&
              (error as { unproved: unknown[] }).unproved.length > 0;
            if (!unproved) {
              try {
                await rm(workDirectory, { recursive: true, force: true });
              } catch (cleanupError) {
                throw new StorybookArtifactBuildCleanupFailure(error, cleanupError);
              }
            }
            throw error;
          }
        });
        if (acquired) return acquired;
        if (Date.now() >= deadline)
          throw new Error('Storybook artifact capacity did not become available within 10 minutes.');
        await delay(lockPollMs, options.signal);
      }
    },
  };
}

/** Replace a materialized Storybook directory with a same-filesystem atomic rename and rollback. */
export async function publishStorybookDirectory(staged: string, output: string): Promise<void> {
  const backup = `${output}.previous-${randomUUID()}`;
  let movedOld = false;
  try {
    try {
      await rename(output, backup);
      movedOld = true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    await rename(staged, output);
  } catch (error) {
    if (movedOld) {
      try {
        await rename(backup, output);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'Storybook publication failed and the previous output could not be restored.',
          {
            cause: error,
          },
        );
      }
    }
    throw error;
  }
  if (movedOld) await rm(backup, { recursive: true, force: true });
}
