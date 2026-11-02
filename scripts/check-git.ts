#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MANIFEST_FILE = 'manifest.json';
const PACK_FILE = 'snapshot.pack';
const FORMAT = 'rezics-native-git-snapshot-v2';
const OBJECT_FORMATS = ['sha1', 'sha256'] as const;
// Dozens of workers pack concurrently on a loaded host; two minutes was too short at load 70.
const GIT_OPERATION_TIMEOUT_MS = 600_000;

type ObjectFormat = (typeof OBJECT_FORMATS)[number];
type Manifest = {
  format: typeof FORMAT;
  objectFormat: ObjectFormat;
  head: string;
  indexTree: string;
  dev: string | null;
  shallow: string;
  pack: { file: typeof PACK_FILE; bytes: number; sha256: string };
};

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  const clean = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(clean)) {
    if (
      [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_COMMON_DIR',
        'GIT_CEILING_DIRECTORIES',
        'GIT_PREFIX',
        'GIT_CONFIG',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_PARAMETERS',
      ].includes(key) ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
    ) {
      delete clean[key];
    }
  }
  return {
    ...clean,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    ...overrides,
  };
}

function git(cwd: string, args: string[], overrides: Record<string, string> = {}): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: environment(overrides),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: GIT_OPERATION_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) throw new Error('check-git: native Git operation failed');
  return result.stdout.toString().trim();
}

function runGit(cwd: string, args: string[], overrides: Record<string, string> = {}): void {
  git(cwd, args, overrides);
}

function optionalGit(cwd: string, args: string[], missingExitCode: number): string | undefined {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: environment(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: GIT_OPERATION_TIMEOUT_MS,
  });
  if (result.exitCode === 0) return result.stdout.toString().trim();
  if (!result.exitedDueToTimeout && result.exitCode === missingExitCode) return undefined;
  throw new Error('check-git: native Git operation failed');
}

function validObjectId(value: unknown, format: ObjectFormat): value is string {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${format === 'sha1' ? 40 : 64}}$`).test(value);
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

function alternateObjectPath(path: string): string {
  return /[:\\"]/.test(path) ? `"${path.replace(/[\\":]/g, '\\$&')}"` : path;
}

function verifySnapshotRepository(repository: string, packPath: string, manifest: Omit<Manifest, 'pack'>): void {
  mkdirSync(repository, { recursive: true });
  const template = join(repository, 'template');
  const gitDirectory = join(repository, 'git');
  mkdirSync(template);
  runGit(repository, [
    'init',
    '--bare',
    '--quiet',
    `--object-format=${manifest.objectFormat}`,
    `--template=${template}`,
    gitDirectory,
  ]);
  writeFileSync(join(gitDirectory, 'shallow'), `${manifest.shallow}\n`, { mode: 0o600, flag: 'wx' });
  const pack = Bun.spawnSync(['git', '--git-dir', gitDirectory, 'index-pack', '--strict', '--stdin'], {
    cwd: repository,
    env: environment(),
    stdin: Bun.file(packPath),
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: GIT_OPERATION_TIMEOUT_MS,
  });
  if (pack.exitCode !== 0) throw new Error('check-git: native Git pack verification failed');
  const gitEnv = { GIT_DIR: gitDirectory };
  runGit(repository, ['update-ref', 'refs/heads/check-snapshot', manifest.head], gitEnv);
  if (manifest.dev !== null) runGit(repository, ['update-ref', 'refs/heads/dev', manifest.dev], gitEnv);
  runGit(repository, ['update-ref', 'refs/rezics-check/staged-index', manifest.indexTree], gitEnv);
  runGit(repository, ['symbolic-ref', 'HEAD', 'refs/heads/check-snapshot'], gitEnv);
  runGit(repository, ['fsck', '--strict', '--connectivity-only', '--no-reflogs'], gitEnv);
  if (
    manifest.dev !== null &&
    git(repository, ['merge-base', manifest.head, manifest.dev], gitEnv) !== manifest.shallow
  ) {
    throw new Error('check-git: restored snapshot does not preserve its development merge base');
  }
  runGit(repository, ['cat-file', '-e', `${manifest.head}^{commit}`], gitEnv);
  runGit(repository, ['cat-file', '-e', `${manifest.indexTree}^{tree}`], gitEnv);
}

function reusableCacheRoot(source: string): string | undefined {
  const scratch = join(source, '.temp');
  if (!isDirectory(scratch)) return undefined;
  const ignored = Bun.spawnSync(['git', 'check-ignore', '--quiet', '.temp/remote-check-git-cache'], {
    cwd: source,
    env: environment(),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: GIT_OPERATION_TIMEOUT_MS,
  });
  return ignored.exitCode === 0 ? join(scratch, 'remote-check-git-cache') : undefined;
}

async function readReusableSnapshot(
  directory: string,
  identity: Pick<Manifest, 'objectFormat' | 'head' | 'indexTree' | 'dev' | 'shallow'>,
): Promise<{ manifestPath: string; packPath: string }> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const packPath = join(directory, PACK_FILE);
  if (
    !isDirectory(directory) ||
    !isRegularFile(manifestPath) ||
    !isRegularFile(packPath) ||
    readdirSync(directory).sort().join('\0') !== [MANIFEST_FILE, PACK_FILE].sort().join('\0')
  ) {
    throw new Error('check-git: reusable native Git snapshot cache is incomplete');
  }
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  if (
    manifest.objectFormat !== identity.objectFormat ||
    manifest.head !== identity.head ||
    manifest.indexTree !== identity.indexTree ||
    manifest.dev !== identity.dev ||
    manifest.shallow !== identity.shallow ||
    statSync(packPath).size !== manifest.pack.bytes ||
    (await sha256File(packPath)) !== manifest.pack.sha256
  ) {
    throw new Error('check-git: reusable native Git snapshot cache failed integrity verification');
  }
  return { manifestPath, packPath };
}

async function publishReusableSnapshot(
  cacheRoot: string,
  cacheDirectory: string,
  manifestPath: string,
  packPath: string,
  identity: Pick<Manifest, 'objectFormat' | 'head' | 'indexTree' | 'dev' | 'shallow'>,
): Promise<void> {
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  if (!isDirectory(cacheRoot)) throw new Error('check-git: native Git snapshot cache directory is unsafe');
  if (existsSync(cacheDirectory)) {
    await readReusableSnapshot(cacheDirectory, identity);
    return;
  }
  const pending = mkdtempSync(join(cacheRoot, `.pending-${identity.head.slice(0, 12)}-`));
  let pendingExists = true;
  try {
    const cachedManifest = join(pending, MANIFEST_FILE);
    const cachedPack = join(pending, PACK_FILE);
    copyFileSync(manifestPath, cachedManifest);
    copyFileSync(packPath, cachedPack);
    chmodSync(cachedManifest, 0o444);
    chmodSync(cachedPack, 0o444);
    chmodSync(pending, 0o555);
    try {
      renameSync(pending, cacheDirectory);
      pendingExists = false;
    } catch (error) {
      if (!existsSync(cacheDirectory)) throw error;
      await readReusableSnapshot(cacheDirectory, identity);
    }
  } finally {
    if (pendingExists) {
      chmodSync(pending, 0o700);
      rmSync(pending, { recursive: true, force: true });
    }
  }
  await readReusableSnapshot(cacheDirectory, identity);
}

/** Stages the source HEAD and staged index tree into an independent, self-contained native Git pack. */
export async function stageCheckGit(workspace: string, artifactDirectory: string): Promise<string> {
  const source = resolve(workspace);
  const artifacts = resolve(artifactDirectory);
  if (!isDirectory(source)) throw new Error('check-git: source checkout is unavailable');
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  if (!isDirectory(artifacts)) throw new Error('check-git: artifact directory is unavailable');
  if (readdirSync(artifacts).length !== 0) throw new Error('check-git: artifact directory must be empty');

  const objectFormatText = git(source, ['rev-parse', '--show-object-format']);
  if (!(OBJECT_FORMATS as readonly string[]).includes(objectFormatText)) {
    throw new Error('check-git: unsupported native Git object format');
  }
  const objectFormat = objectFormatText as ObjectFormat;
  const head = git(source, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const devCandidate = optionalGit(source, ['rev-parse', '--verify', 'dev^{commit}'], 128);
  const dev = devCandidate && validObjectId(devCandidate, objectFormat) ? devCandidate : undefined;
  if (devCandidate !== undefined && dev === undefined)
    throw new Error('check-git: development ref identity is invalid');
  const mergeBaseCandidate = dev ? optionalGit(source, ['merge-base', head, dev], 1) : undefined;
  const mergeBase =
    mergeBaseCandidate && validObjectId(mergeBaseCandidate, objectFormat) ? mergeBaseCandidate : undefined;
  if (mergeBaseCandidate !== undefined && mergeBase === undefined) {
    throw new Error('check-git: development merge-base identity is invalid');
  }
  const shallow = mergeBase ?? head;
  const devCommit = mergeBase ? dev! : null;
  const objectDirectory = git(source, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  const sourceIndex = git(source, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  if (!validObjectId(head, objectFormat) || !isDirectory(objectDirectory)) {
    throw new Error('check-git: source repository identity is invalid');
  }

  const build = mkdtempSync(join(artifacts, '.build-'));
  const packPath = join(artifacts, PACK_FILE);
  const manifestPath = join(artifacts, MANIFEST_FILE);
  const indexCopy = join(build, 'source.index');
  const bare = join(build, 'snapshot');
  const template = join(build, 'template');
  try {
    if (existsSync(sourceIndex)) copyFileSync(sourceIndex, indexCopy);
    else runGit(source, ['read-tree', head], { GIT_INDEX_FILE: indexCopy });
    mkdirSync(template);
    runGit(build, ['init', '--bare', '--quiet', `--object-format=${objectFormat}`, `--template=${template}`, bare]);

    const isolatedObjects = {
      GIT_OBJECT_DIRECTORY: join(bare, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectPath(objectDirectory),
    };
    const isolatedGit = { GIT_DIR: bare, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectPath(objectDirectory) };
    writeFileSync(join(bare, 'shallow'), `${shallow}\n`, { mode: 0o600, flag: 'wx' });
    // Keep the source Git directory active while reading a copied index. This lets Git resolve linked-worktree
    // split-index shared files without changing the source index or writing objects into the source object store.
    const indexTree = git(source, ['write-tree'], {
      ...isolatedObjects,
      GIT_INDEX_FILE: indexCopy,
    });
    if (!validObjectId(indexTree, objectFormat)) throw new Error('check-git: staged index identity is invalid');
    const identity: Pick<Manifest, 'objectFormat' | 'head' | 'indexTree' | 'dev' | 'shallow'> = {
      objectFormat,
      head,
      indexTree,
      dev: devCommit,
      shallow,
    };
    const cacheRoot = reusableCacheRoot(source);
    if (cacheRoot !== undefined) {
      mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
      if (!isDirectory(cacheRoot)) throw new Error('check-git: native Git snapshot cache directory is unsafe');
      const cacheDirectory = join(cacheRoot, `${objectFormat}-${head}-${indexTree}-${devCommit ?? 'unscoped'}`);
      if (existsSync(cacheDirectory)) {
        const cached = await readReusableSnapshot(cacheDirectory, identity);
        copyFileSync(cached.manifestPath, manifestPath);
        copyFileSync(cached.packPath, packPath);
        return manifestPath;
      }
    }
    runGit(build, ['update-ref', 'refs/heads/check-snapshot', head], isolatedGit);
    if (devCommit !== null) runGit(build, ['update-ref', 'refs/heads/dev', devCommit], isolatedGit);
    runGit(build, ['update-ref', 'refs/rezics-check/staged-index', indexTree], isolatedGit);
    runGit(build, ['symbolic-ref', 'HEAD', 'refs/heads/check-snapshot'], isolatedGit);

    const descriptor = openSync(packPath, 'wx', 0o600);
    let packed: ReturnType<typeof Bun.spawnSync>;
    try {
      packed = Bun.spawnSync(['git', 'pack-objects', '--stdout', '--revs', '--threads=2'], {
        cwd: build,
        env: environment(isolatedGit),
        stdin: new Blob([
          `refs/heads/check-snapshot\n${devCommit === null ? '' : 'refs/heads/dev\n'}refs/rezics-check/staged-index\n`,
        ]),
        stdout: descriptor,
        stderr: 'pipe',
        timeout: GIT_OPERATION_TIMEOUT_MS,
      });
    } finally {
      closeSync(descriptor);
    }
    if (packed.exitCode !== 0 || !isRegularFile(packPath)) {
      const reason = packed.exitedDueToTimeout ? 'timed out' : (packed.stderr?.toString() ?? '').trim().slice(-300);
      throw new Error(`check-git: native Git snapshot packing failed${reason ? `: ${reason}` : ''}`);
    }

    const manifestWithoutPack: Omit<Manifest, 'pack'> = {
      format: FORMAT,
      objectFormat,
      head,
      indexTree,
      dev: devCommit,
      shallow,
    };
    const validation = join(build, 'validation');
    verifySnapshotRepository(validation, packPath, manifestWithoutPack);
    const packBytes = statSync(packPath).size;
    if (!Number.isSafeInteger(packBytes) || packBytes < 1) throw new Error('check-git: native Git pack is empty');
    const manifest: Manifest = {
      ...manifestWithoutPack,
      pack: { file: PACK_FILE, bytes: packBytes, sha256: await sha256File(packPath) },
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
    if (cacheRoot !== undefined) {
      await publishReusableSnapshot(
        cacheRoot,
        join(cacheRoot, `${objectFormat}-${head}-${indexTree}-${devCommit ?? 'unscoped'}`),
        manifestPath,
        packPath,
        identity,
      );
    }
    return manifestPath;
  } catch (error) {
    rmSync(packPath, { force: true });
    rmSync(manifestPath, { force: true });
    if (error instanceof Error && error.message.startsWith('check-git:')) throw error;
    throw new Error('check-git: native Git snapshot staging failed');
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}

function parseManifest(contents: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('check-git: snapshot manifest is invalid');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('check-git: snapshot manifest is invalid');
  const candidate = parsed as Partial<Manifest>;
  if (
    candidate.format !== FORMAT ||
    !(OBJECT_FORMATS as readonly unknown[]).includes(candidate.objectFormat) ||
    !validObjectId(candidate.head, candidate.objectFormat as ObjectFormat) ||
    !validObjectId(candidate.indexTree, candidate.objectFormat as ObjectFormat) ||
    !(candidate.dev === null || validObjectId(candidate.dev, candidate.objectFormat as ObjectFormat)) ||
    !validObjectId(candidate.shallow, candidate.objectFormat as ObjectFormat) ||
    (candidate.dev === null && candidate.shallow !== candidate.head) ||
    !candidate.pack ||
    candidate.pack.file !== PACK_FILE ||
    !Number.isSafeInteger(candidate.pack.bytes) ||
    candidate.pack.bytes < 1 ||
    typeof candidate.pack.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.pack.sha256)
  ) {
    throw new Error('check-git: snapshot manifest is invalid');
  }
  return candidate as Manifest;
}

/** Restores a snapshot into a new native repository without checking out or overwriting workspace files. */
export async function restoreCheckGit(manifestPath: string, checkout: string): Promise<void> {
  const manifestFile = resolve(manifestPath);
  const root = resolve(checkout);
  if (!isDirectory(root) || !isRegularFile(manifestFile)) throw new Error('check-git: snapshot input is missing');
  const manifest = parseManifest(readFileSync(manifestFile, 'utf8'));
  const packPath = join(dirname(manifestFile), manifest.pack.file);
  if (!isRegularFile(packPath) || statSync(packPath).size !== manifest.pack.bytes) {
    throw new Error('check-git: snapshot pack is missing or partial');
  }
  if ((await sha256File(packPath)) !== manifest.pack.sha256) {
    throw new Error('check-git: snapshot pack integrity check failed');
  }

  const gitDirectory = join(root, '.git');
  if (existsSync(gitDirectory)) throw new Error('check-git: checkout already contains Git metadata');
  const staging = mkdtempSync(join(root, '.check-git-restore-'));
  const template = join(staging, 'template');
  const metadata = join(staging, 'metadata');
  let published = false;
  try {
    mkdirSync(template);
    runGit(staging, [
      'init',
      '--bare',
      '--quiet',
      `--object-format=${manifest.objectFormat}`,
      `--template=${template}`,
      metadata,
    ]);
    writeFileSync(join(metadata, 'shallow'), `${manifest.shallow}\n`, { mode: 0o600, flag: 'wx' });
    const pack = Bun.spawnSync(['git', '--git-dir', metadata, 'index-pack', '--strict', '--stdin'], {
      cwd: staging,
      env: environment(),
      stdin: Bun.file(packPath),
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: GIT_OPERATION_TIMEOUT_MS,
    });
    if (pack.exitCode !== 0) throw new Error('check-git: native Git pack verification failed');

    const gitEnv = { GIT_DIR: metadata };
    runGit(staging, ['config', '--file', join(metadata, 'config'), 'core.bare', 'false']);
    runGit(staging, ['config', '--file', join(metadata, 'config'), 'core.logAllRefUpdates', 'false']);
    runGit(staging, ['update-ref', 'refs/heads/check-snapshot', manifest.head], gitEnv);
    if (manifest.dev !== null) runGit(staging, ['update-ref', 'refs/heads/dev', manifest.dev], gitEnv);
    runGit(staging, ['update-ref', 'refs/rezics-check/staged-index', manifest.indexTree], gitEnv);
    runGit(staging, ['symbolic-ref', 'HEAD', 'refs/heads/check-snapshot'], gitEnv);
    runGit(staging, ['cat-file', '-e', `${manifest.head}^{commit}`], gitEnv);
    runGit(staging, ['cat-file', '-e', `${manifest.indexTree}^{tree}`], gitEnv);
    runGit(root, ['--git-dir', metadata, '--work-tree', root, 'read-tree', manifest.indexTree], {
      ...gitEnv,
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: join(metadata, 'index'),
    });
    mkdirSync(join(metadata, 'info'), { recursive: true });
    appendFileSync(
      join(metadata, 'info', 'exclude'),
      '\n# Files created by the bounded remote check runner.\n/.alive\n/.bun-install-complete\n/.remote-check-slot-count\n/bun-runtime-transpiler-cache/\n/command-phases.tsv\n/command-started\n/exit-status\n',
    );
    runGit(staging, ['--git-dir', metadata, 'fsck', '--strict', '--connectivity-only', '--no-reflogs'], gitEnv);
    if (
      manifest.dev !== null &&
      git(staging, ['--git-dir', metadata, 'merge-base', manifest.head, manifest.dev], gitEnv) !== manifest.shallow
    ) {
      throw new Error('check-git: restored snapshot does not preserve its development merge base');
    }
    if (git(staging, ['--git-dir', metadata, 'rev-parse', 'HEAD'], gitEnv) !== manifest.head) {
      throw new Error('check-git: restored HEAD does not match the snapshot');
    }

    renameSync(metadata, gitDirectory);
    published = true;
    rmSync(staging, { recursive: true, force: true });
    if (git(root, ['rev-parse', 'HEAD']) !== manifest.head) {
      throw new Error('check-git: restored HEAD does not match the snapshot');
    }
    const cacheRoot = reusableCacheRoot(root);
    if (cacheRoot !== undefined) {
      await publishReusableSnapshot(
        cacheRoot,
        join(
          cacheRoot,
          `${manifest.objectFormat}-${manifest.head}-${manifest.indexTree}-${manifest.dev ?? 'unscoped'}`,
        ),
        manifestFile,
        packPath,
        {
          objectFormat: manifest.objectFormat,
          head: manifest.head,
          indexTree: manifest.indexTree,
          dev: manifest.dev,
          shallow: manifest.shallow,
        },
      );
    }
  } catch (error) {
    if (published) rmSync(gitDirectory, { recursive: true, force: true });
    if (error instanceof Error && error.message.startsWith('check-git:')) throw error;
    throw new Error('check-git: native Git snapshot restoration failed');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const [action, manifest, checkout, expectedManifestSha256] = process.argv.slice(2);
  if (action !== 'restore' || !manifest || !checkout) {
    console.error('Usage: bun scripts/check-git.ts restore <manifest> <checkout> [manifest-sha256]');
    return 2;
  }
  try {
    if (expectedManifestSha256 !== undefined) {
      if (
        !/^[a-f0-9]{64}$/.test(expectedManifestSha256) ||
        (await sha256File(resolve(manifest))) !== expectedManifestSha256
      ) {
        throw new Error('check-git: snapshot manifest integrity check failed');
      }
    }
    await restoreCheckGit(manifest, checkout);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'check-git: native Git snapshot restoration failed');
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
