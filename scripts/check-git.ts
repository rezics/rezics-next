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
  opendirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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

export type CheckGitPublication = Omit<Manifest, 'pack'> & { remote: { ref: string; commit: string } };
const CHECK_GIT_ORIGIN = 'https://github.com/rezics/rezics-next.git';

function shell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The store lock covers fetch, checkout and age pruning, including live runs' alternate objects. */
export function fetchCheckGitScript(
  publication: CheckGitPublication,
  checkout: string,
  store: string,
  origin = CHECK_GIT_ORIGIN,
): string {
  const { head, indexTree, dev, shallow, objectFormat, remote } = publication;
  if (
    !(OBJECT_FORMATS as readonly string[]).includes(objectFormat) ||
    !/^refs\/checks\/[a-zA-Z0-9-]+$/.test(remote.ref) ||
    ![head, indexTree, shallow, remote.commit, ...(dev ? [dev] : [])].every((id) => validObjectId(id, objectFormat))
  )
    throw new Error('check-git: invalid published snapshot');
  const run = basename(checkout);
  if (!/^[a-zA-Z0-9-]+$/.test(run)) throw new Error('check-git: invalid run identity');
  const body = `set -eu
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
store=${shell(resolve(store))}
root=${shell(resolve(checkout))}
if [ ! -d "$store" ]; then git init --bare --quiet --template= --object-format=${objectFormat} "$store"; fi
git --git-dir="$store" -c gc.auto=0 fetch --no-tags --no-write-fetch-head ${shell(origin)} ${shell(`+${remote.ref}:refs/check-runs/${run}`)}
test "$(git --git-dir="$store" rev-parse ${shell(`refs/check-runs/${run}`)})" = ${shell(remote.commit)}
test "$(git --git-dir="$store" rev-parse ${shell(`${remote.commit}^{tree}`)})" = ${shell(indexTree)}
git --git-dir="$store" cat-file -e ${shell(`${head}^{commit}`)}
${dev ? `git --git-dir="$store" cat-file -e ${shell(`${dev}^{commit}`)}` : ''}
mkdir -p "$(dirname "$root")"
stage=$(mktemp -d "$root.fetch-XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
git init --quiet --template= --object-format=${objectFormat} "$stage"
printf '%s\\n' "$store/objects" > "$stage/.git/objects/info/alternates"
printf '%s\\n' ${shell(shallow)} > "$stage/.git/shallow"
git -C "$stage" config core.logAllRefUpdates false
git -C "$stage" update-ref refs/heads/check-snapshot ${shell(head)}
${dev ? `git -C "$stage" update-ref refs/heads/dev ${shell(dev)}` : ''}
git -C "$stage" update-ref refs/rezics-check/staged-index ${shell(indexTree)}
git -C "$stage" symbolic-ref HEAD refs/heads/check-snapshot
git -C "$stage" read-tree ${shell(indexTree)}
git -C "$stage" checkout-index --all --force
test "$(git -C "$stage" rev-parse HEAD)" = ${shell(head)}
test "$(git -C "$stage" write-tree)" = ${shell(indexTree)}
${dev ? `test "$(git -C "$stage" merge-base HEAD dev)" = ${shell(shallow)}` : ''}
mkdir -p "$stage/.git/info"
printf '%s\\n' '/.alive' '/.bun-install-complete' '/.remote-check-slot-count' '/bun-runtime-transpiler-cache/' '/command-phases.tsv' '/command-started' '/exit-status' >> "$stage/.git/info/exclude"
mv -T -- "$stage" "$root"
# Completed runs lose their pins; a seven-day grace period retains reusable objects between runs.
if [ ! -f "$store/gc.timestamp" ] || [ "$(date +%s)" -gt "$(($(stat -c %Y "$store/gc.timestamp" 2>/dev/null || echo 0) + 86400))" ]; then
 (
  git --git-dir="$store" for-each-ref --format='%(refname)' refs/check-runs/ | while read -r ref; do
    if [ ! -d "$(dirname "$root")/\${ref##*/}" ]; then git --git-dir="$store" update-ref -d "$ref"; fi
  done
  git --git-dir="$store" gc --quiet --prune=7.days.ago
  touch "$store/gc.timestamp"
 ) || echo 'check-git: store age pruning deferred' >&2
fi
`;
  return `# REMOTE_CHECK_GITHUB_FETCH\nmkdir -p ${shell(dirname(resolve(store)))}\nflock -x ${shell(`${resolve(store)}.lock`)} sh -c ${shell(body)}`;
}

const CHECK_REF = /^refs\/checks\/[a-zA-Z0-9-]+$/;
const REF_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
type OwnedPublication = CheckGitPublication & {
  ownership: { origin: string | null; createdAt: number; state: 'active' | 'retained' | 'releasable' };
};
type PublicationOptions = {
  ref: string;
  retain?: boolean;
  deadlineMs?: number;
  /** Controlled-clock seams; production uses one absolute preparation deadline. */
  now?: () => number;
  backoff?: (ms: number) => Promise<void>;
};

function publicationRecord(workspace: string, ref: string): string {
  return join(resolve(workspace), '.temp/check-git-publications', `${ref.slice('refs/checks/'.length)}.json`);
}
function originIdentity(workspace: string): string | null {
  try { return createHash('sha256').update(git(workspace, ['remote', 'get-url', '--push', 'origin'])).digest('hex'); }
  catch { return null; }
}
function savePublication(path: string, record: OwnedPublication): void {
  const temporary = `${path}.${process.pid}.pending`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function transportDiagnostic(value: unknown): string {
  let message = String(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  message = message.replace(/https?:\/\/[^\s'"<>]+/gi, (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch { return '[redacted URL]'; }
  });
  message = message.replace(/((?:authorization|password|passwd|token|secret|credential)[\w-]*\s*[:=]\s*|bearer\s+|basic\s+)[^\s,;]+/gi, '$1[redacted]');
  for (const [key, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 4 && /TOKEN|PASSWORD|SECRET|CREDENTIAL/i.test(key))
      message = message.replaceAll(secret, '[redacted]');
  }
  return message.slice(-8192);
}

/** Only an exact recorded candidate can be deleted; retained runs require controller settlement. */
export async function releaseCheckGit(
  workspace: string,
  manifestPath: string,
  options: { settled?: boolean; deadlineMs?: number } = {},
): Promise<void> {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CheckGitPublication;
    if (!manifest.remote || !CHECK_REF.test(manifest.remote.ref)) return;
    const path = publicationRecord(workspace, manifest.remote.ref);
    const record = JSON.parse(readFileSync(path, 'utf8')) as OwnedPublication;
    if (record.remote.ref !== manifest.remote.ref || record.remote.commit !== manifest.remote.commit ||
        !validObjectId(record.remote.commit, record.objectFormat) ||
        record.ownership.origin === null || record.ownership.origin !== originIdentity(workspace)) return;
    if (record.ownership.state === 'retained' && !options.settled) return;
    record.ownership.state = 'releasable';
    savePublication(path, record);
    await pushCheckGit(workspace, [`--force-with-lease=${record.remote.ref}:${record.remote.commit}`, `:${record.remote.ref}`], {},
      options.deadlineMs ?? Date.now() + 2000);
    rmSync(path, { force: true });
  } catch (error) {
    console.error(`check-git: ref cleanup deferred: ${transportDiagnostic(error)}`);
  }
}

/** Scan at most 32 owned records, for at most ten seconds. Unknown, active and retained refs stay pinned. */
export async function sweepCheckGit(workspace: string, now = Date.now()): Promise<void> {
  const deadlineMs = Date.now() + 10_000;
  try {
    const directory = opendirSync(join(resolve(workspace), '.temp/check-git-publications'));
    try {
      for (let visited = 0; visited < 32 && Date.now() < deadlineMs; visited++) {
        const entry = directory.readSync();
        if (!entry) break;
        if (!entry.isFile() || !/^[a-zA-Z0-9-]+\.json$/.test(entry.name)) continue;
        const path = join(directory.path, entry.name);
        try {
          const record = JSON.parse(readFileSync(path, 'utf8')) as OwnedPublication;
          if (!CHECK_REF.test(record.remote.ref) || basename(path) !== `${record.remote.ref.slice('refs/checks/'.length)}.json` ||
              record.ownership.state !== 'releasable' || !Number.isFinite(record.ownership.createdAt) ||
              now - record.ownership.createdAt < REF_GRACE_MS) continue;
          await releaseCheckGit(workspace, path, { deadlineMs: Math.min(deadlineMs, Date.now() + 2000) });
        } catch { /* Unknown ownership never grants deletion authority. */ }
      }
    } finally { directory.closeSync(); }
  } catch { /* No journal, or unreadable ownership: leave remote refs alone. */ }
}

async function pushCheckGit(
  workspace: string, refspecs: string[], overrides: Record<string, string> = {},
  deadlineMs = Date.now() + GIT_OPERATION_TIMEOUT_MS, now = Date.now,
): Promise<void> {
  const remaining = deadlineMs - now();
  if (remaining <= 0) throw new Error('check-git: publication preparation deadline exceeded');
  const env = environment(overrides);
  // Authentication remains local; it is never part of the published manifest or host repository.
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    if (process.env[key] === undefined) delete env[key];
    else env[key] = process.env[key]!;
  }
  const pushed = Bun.spawn(['git', 'push', '--no-follow-tags', '--progress', 'origin', ...refspecs], {
    cwd: workspace, env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
    timeout: Math.min(GIT_OPERATION_TIMEOUT_MS, remaining),
  });
  const [code, stderr] = await Promise.all([pushed.exited, new Response(pushed.stderr).text()]);
  const detail = transportDiagnostic(stderr);
  if (code !== 0) throw new Error(`check-git: check ref push failed (exit ${code}${pushed.signalCode ? `, ${pushed.signalCode}` : ''}): ${detail}`);
  const bytes = detail.match(/Writing objects: 100%[^\r\n]*/g)?.at(-1);
  if (bytes) console.error(`check-git: ${bytes}`);
}

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
export async function stageCheckGit(
  workspace: string,
  artifactDirectory: string,
  publication?: PublicationOptions,
): Promise<string> {
  const now = publication?.now ?? Date.now;
  const deadlineMs = publication?.deadlineMs ?? now() + 900_000;
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
    if (publication !== undefined) {
      if (!/^refs\/checks\/[a-zA-Z0-9-]+$/.test(publication.ref))
        throw new Error('check-git: publication must use a check-only ref');
      // Scan the actual staged tree as well as check-run's working inputs, before any Git object is pushed.
      const scanned = Bun.spawnSync(
        ['git', 'grep', '-I', '-l', '-E', '--', '-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----', indexTree],
        {
          cwd: source,
          env: environment(isolatedObjects),
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: GIT_OPERATION_TIMEOUT_MS,
        },
      );
      if (scanned.exitCode !== 0 && scanned.exitCode !== 1) throw new Error('check-git: private key scan failed');
      if (
        scanned.stdout
          .toString()
          .split('\n')
          .filter(Boolean)
          .some((path) => path !== `${indexTree}:scripts/check-run.test.ts`)
      )
        throw new Error('check-git: candidate contains private key material');
      const commit = git(
        source,
        [
          'commit-tree',
          indexTree,
          '-p',
          head,
          ...(devCommit && devCommit !== head ? ['-p', devCommit] : []),
          '-m',
          'Remote check candidate',
        ],
        {
          ...isolatedObjects,
          GIT_AUTHOR_NAME: 'Remote check',
          GIT_AUTHOR_EMAIL: 'check@rezics.invalid',
          GIT_COMMITTER_NAME: 'Remote check',
          GIT_COMMITTER_EMAIL: 'check@rezics.invalid',
        },
      );
      const manifest: CheckGitPublication = { format: FORMAT, ...identity, remote: { ref: publication.ref, commit } };
      const recordPath = publicationRecord(source, publication.ref);
      mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
      const record: OwnedPublication = { ...manifest, ownership: {
        origin: originIdentity(source), createdAt: now(), state: publication.retain ? 'retained' : 'active',
      } };
      // Persist intent before transport: a lost push response or failed manifest still has exact cleanup identity.
      writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await pushCheckGit(source, [`${commit}:${publication.ref}`], isolatedObjects, deadlineMs, now);
            break;
          } catch (error) {
            console.error(`check-git: publication attempt ${attempt + 1} ${commit}:${publication.ref}: ${transportDiagnostic(error)}`);
            if (attempt === 1) throw error;
            if (deadlineMs - now() <= 250) throw new Error('check-git: publication preparation deadline exceeded before retry');
            await (publication.backoff ?? Bun.sleep)(250);
          }
        }
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
        return manifestPath;
      } catch (error) {
        console.error(`check-git: GitHub publication unavailable; using full snapshot upload: ${transportDiagnostic(error)}`);
        // Failed or interrupted publication may already exist remotely; cleanup must not gate fallback delivery.
        void releaseCheckGit(source, recordPath);
      }
    }
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
