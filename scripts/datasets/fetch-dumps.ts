import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const CROSS_MEDIA_DUMP_CACHE_ENV = 'REZICS_DATASETS_DUMP_CACHE';
export const DEFAULT_CROSS_MEDIA_DUMP_CACHE = '/home/edge/projects/rezics/rezics-datasets/dumps';
export const BANGUMI_ARCHIVE_URL =
  'https://github.com/bangumi/Archive/releases/download/archive/dump-2026-10-20.210332Z.zip';
export const BANGUMI_ARCHIVE_SHA256 = '9fe8de272398ff4bd12994b73e25aac37cca631372383f6aadc503528623aa93';
export const VNDB_ARCHIVE_URL = 'https://dl.vndb.org/dump/vndb-db-2026-10-25.tar.zst';
export const VNDB_DUMP_INDEX_URL = 'https://dl.vndb.org/dump/';
export const VNDB_DUMP_MANIFEST = 'manifest.json';
const VNDB_DATED_DUMP = /^vndb-db-\d{4}-\d{2}-\d{2}\.tar\.zst$/;

const BANGUMI_TABLES = [
  'subject.jsonlines',
  'subject-relations.jsonlines',
  'subject-characters.jsonlines',
  'subject-persons.jsonlines',
  'character.jsonlines',
  'person.jsonlines',
  'person-characters.jsonlines',
  'person-relations.jsonlines',
  'episode.jsonlines',
];
export const VNDB_DUMP_HEADERS: Readonly<Record<string, readonly string[]>> = {
  chars_alias: ['id', 'spoil', 'name', 'latin'],
  chars_names: ['id', 'lang', 'name', 'latin'],
  extlinks: ['id', 'site', 'value'],
  producers_extlinks: ['id', 'link'],
  producers_relations: ['id', 'pid', 'relation'],
  releases_extlinks: ['id', 'link'],
  releases_media: ['id', 'medium', 'qty'],
  releases_platforms: ['id', 'platform'],
  staff_extlinks: ['id', 'link'],
  vn_extlinks: ['id', 'link'],
  tags: ['id', 'cat', 'defaultspoil', 'searchable', 'applicable', 'name', 'alias', 'description'],
  tags_parents: ['id', 'parent', 'main'],
  tags_vn: ['date', 'tag', 'vid', 'uid', 'vote', 'spoiler', 'ignore', 'lie', 'notes'],
};
export const VNDB_DUMP_TABLES = [
  'anime',
  'chars',
  'chars_alias',
  'chars_names',
  'chars_vns',
  'entry_meta',
  'extlinks',
  'producers',
  'producers_relations',
  'producers_extlinks',
  'releases',
  'releases_extlinks',
  'releases_media',
  'releases_platforms',
  'releases_producers',
  'releases_supersedes',
  'releases_titles',
  'releases_vn',
  'staff',
  'staff_alias',
  'staff_extlinks',
  'tags',
  'tags_parents',
  'tags_vn',
  'vn',
  'vn_anime',
  'vn_extlinks',
  'vn_relations',
  'vn_seiyuu',
  'vn_extlinks',
  'vn_staff',
  'vn_titles',
];
const MARKER = '.cross-media-dump-sha256';

type FetchOptions = { fetchImpl?: typeof fetch };
type CommandRunner = (command: string, args: string[]) => Promise<void>;

export type CrossMediaDumpPaths = Readonly<{
  cacheRoot: string;
  bangumi: string;
  vndb: string;
  bangumiArchive: string;
  vndbArchive: string;
}>;

export type VndbDumpManifest = Readonly<{
  file: string;
  url: string;
  sha256: string;
}>;

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(Reflect.get(error, 'code'))
    : undefined;
}

function dumpFileName(url: string): string {
  const name = new URL(url).pathname.split('/').pop();
  ensure(name, 'Dump URL is missing a file name');
  return name;
}

function gone(status: number): boolean {
  return status === 404 || status === 410;
}

/** Pick the current dated VNDB database dump from the published dump index HTML. */
export function parseVndbDumpIndex(
  html: string,
  indexUrl: string = VNDB_DUMP_INDEX_URL,
): { file: string; url: string } {
  ensure(html.trim().length > 0, 'VNDB dump index is empty');
  const base = new URL(indexUrl);
  ensure(base.protocol === 'https:', 'VNDB dump index must be HTTPS');
  const directory = base.href.endsWith('/') ? base.href : `${base.href}/`;
  const files = new Set<string>();
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    let resolved: URL;
    try {
      resolved = new URL(match[1], directory);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'https:' || resolved.host !== base.host) continue;
    const name = resolved.pathname.split('/').pop();
    if (name && VNDB_DATED_DUMP.test(name)) files.add(name);
  }
  for (const match of html.matchAll(/vndb-db-\d{4}-\d{2}-\d{2}\.tar\.zst/g)) files.add(match[0]);
  const newest = [...files].sort().at(-1);
  ensure(newest, 'VNDB dump index does not list a current database dump');
  const url = new URL(newest, directory);
  ensure(url.protocol === 'https:' && url.host === base.host, 'VNDB dump resolved away from the dump host');
  return { file: newest, url: url.href };
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function directory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest('hex');
}

/** Download one pinned asset to a temporary file, verify it, then atomically cache it. */
export async function cacheDumpAsset(
  url: string,
  path: string,
  expectedSha256: string,
  options: FetchOptions = {},
): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  if (await regularFile(path)) {
    const cachedHash = await sha256(path);
    if (cachedHash === expectedSha256) return cachedHash;
    await rm(path);
  }

  const fetcher = options.fetchImpl ?? globalThis.fetch;
  const partial = `${path}.${process.pid}.${randomUUID()}.part`;
  try {
    const response = await fetcher(url, { redirect: 'follow' });
    ensure(response.ok && response.body, `Dump download failed with HTTP ${response.status}: ${url}`);
    const finalUrl = new URL(response.url || url);
    ensure(finalUrl.protocol === 'https:', 'Dump download redirected away from HTTPS');
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      createWriteStream(partial, { flags: 'wx' }),
    );
    const downloadedHash = await sha256(partial);
    ensure(downloadedHash === expectedSha256, `Dump SHA-256 mismatch: ${url}`);
    await rename(partial, path);
    return downloadedHash;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function cacheUnpinnedAsset(url: string, path: string, options: FetchOptions = {}): Promise<string> {
  if (await regularFile(path)) return sha256(path);
  await mkdir(dirname(path), { recursive: true });
  const fetcher = options.fetchImpl ?? globalThis.fetch;
  const partial = `${path}.${process.pid}.${randomUUID()}.part`;
  try {
    const response = await fetcher(url, { redirect: 'follow' });
    ensure(response.ok && response.body, `Dump download failed with HTTP ${response.status}: ${url}`);
    const finalUrl = new URL(response.url || url);
    ensure(finalUrl.protocol === 'https:', 'Dump download redirected away from HTTPS');
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      createWriteStream(partial, { flags: 'wx' }),
    );
    const downloadedHash = await sha256(partial);
    await rename(partial, path);
    return downloadedHash;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

const runCommand: CommandRunner = (command, args) =>
  new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once('error', (error) => rejectCommand(new Error(`Could not run ${command}: ${error.message}`)));
    child.once('close', (code) =>
      code === 0
        ? resolveCommand()
        : rejectCommand(new Error(`${command} exited ${code ?? 'without a status'}: ${stderr.trim()}`)),
    );
  });

async function runCommandOutput(command: string, args: string[], maximumBytes = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > maximumBytes) {
        overflow = true;
        child.kill();
      } else stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once('error', (error) => rejectOutput(new Error(`Could not run ${command}: ${error.message}`)));
    child.once('close', (code) => {
      if (overflow) rejectOutput(new Error(`${command} output exceeded ${maximumBytes} bytes`));
      else if (code !== 0) rejectOutput(new Error(`${command} exited ${code ?? 'without a status'}: ${stderr.trim()}`));
      else resolveOutput(stdout);
    });
  });
}

async function validateVndbArchive(path: string): Promise<void> {
  const listing = await runCommandOutput('tar', ['--zstd', '-tvf', path]);
  const entries = listing.split('\n').filter(Boolean);
  ensure(entries.length > 0, 'VNDB archive is empty');
  for (const entry of entries) {
    const mode = entry[0];
    ensure(mode === '-' || mode === 'd', 'VNDB archive contains a link or special file');
    const member = entry.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/)?.[1];
    ensure(member, 'VNDB archive member listing is invalid');
    const normalized = member.replace(/^\.\//, '').replace(/\/$/, '');
    ensure(
      normalized.length > 0 &&
        !normalized.startsWith('/') &&
        !normalized.includes('\\') &&
        !normalized.split('/').includes('..'),
      'VNDB archive contains an unsafe path',
    );
  }
}

async function locateDirectory(
  root: string,
  matches: (candidate: string) => Promise<boolean>,
  depth = 4,
): Promise<string | undefined> {
  if (!(await directory(root))) return undefined;
  if (await matches(root)) return root;
  if (depth === 0) return undefined;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = await locateDirectory(join(root, entry.name), matches, depth - 1);
    if (candidate) return candidate;
  }
  return undefined;
}

async function bangumiDirectory(root: string): Promise<string | undefined> {
  return locateDirectory(root, async (candidate) => {
    const files = await Promise.all(BANGUMI_TABLES.map((name) => regularFile(join(candidate, name))));
    return files.every(Boolean);
  });
}

async function vndbDirectory(root: string): Promise<string | undefined> {
  return locateDirectory(root, async (candidate) => {
    if (!(await regularFile(join(candidate, 'README.txt')))) return false;
    if (!(await regularFile(join(candidate, 'schema_vndbid.sql')))) return false;
    const db = join(candidate, 'db');
    for (const table of VNDB_DUMP_TABLES) {
      const file = join(db, table);
      const header = join(db, `${table}.header`);
      if (!(await regularFile(file)) || !(await regularFile(header))) return false;
      const columns = (await readFile(header, 'utf8')).trimEnd().split('\t');
      if (!columns.length || columns.some((column) => !column) || new Set(columns).size !== columns.length)
        return false;
      const required = VNDB_DUMP_HEADERS[table];
      if (required && (columns.length !== required.length || required.some((name, index) => columns[index] !== name)))
        return false;
    }
    return true;
  });
}

async function replaceDirectory(stage: string, target: string): Promise<void> {
  const previous = `${target}.previous-${process.pid}`;
  await rm(previous, { recursive: true, force: true });
  const hadTarget = await directory(target);
  if (hadTarget) await rename(target, previous);
  try {
    await rename(stage, target);
  } catch (error) {
    if (hadTarget) await rename(previous, target);
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
}

async function extractCached(
  archive: string,
  digest: string,
  target: string,
  verify: (root: string) => Promise<string | undefined>,
  validateArchive: (archivePath: string) => Promise<void>,
  extractArchive: (archivePath: string, destination: string) => Promise<void>,
): Promise<string> {
  const cachedRoot = await verify(target);
  if (cachedRoot) {
    try {
      if ((await readFile(join(target, MARKER), 'utf8')).trim() === digest) return cachedRoot;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  const stage = `${target}.partial-${process.pid}-${randomUUID()}`;
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    await validateArchive(archive);
    await extractArchive(archive, stage);
    const extractedRoot = await verify(stage);
    ensure(extractedRoot, `Verified dump is missing required files: ${archive}`);
    await writeFile(join(stage, MARKER), `${digest}\n`, { flag: 'wx' });
    await replaceDirectory(stage, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  const installedRoot = await verify(target);
  ensure(installedRoot, `Could not install verified dump cache: ${target}`);
  return installedRoot;
}

export function crossMediaDumpCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env[CROSS_MEDIA_DUMP_CACHE_ENV] || DEFAULT_CROSS_MEDIA_DUMP_CACHE);
}

export function vndbDumpManifestPath(cacheRoot: string): string {
  return join(cacheRoot, 'vndb', VNDB_DUMP_MANIFEST);
}

async function readVndbManifest(path: string): Promise<VndbDumpManifest | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const file = Reflect.get(raw, 'file');
  const url = Reflect.get(raw, 'url');
  const digest = Reflect.get(raw, 'sha256');
  if (typeof file !== 'string' || typeof url !== 'string' || typeof digest !== 'string') return undefined;
  if (!VNDB_DATED_DUMP.test(file) || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return { file, url, sha256: digest };
}

async function writeVndbManifest(path: string, manifest: VndbDumpManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.${randomUUID()}.part`;
  try {
    await writeFile(partial, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function writeDumpBody(url: string, path: string, response: Response): Promise<string> {
  ensure(response.ok && response.body, `Dump download failed with HTTP ${response.status}: ${url}`);
  const finalUrl = new URL(response.url || url);
  ensure(finalUrl.protocol === 'https:', 'Dump download redirected away from HTTPS');
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.${randomUUID()}.part`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      createWriteStream(partial, { flags: 'wx' }),
    );
    const downloadedHash = await sha256(partial);
    await rename(partial, path);
    return downloadedHash;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function cachedArchiveDigest(path: string): Promise<string | undefined> {
  if (!(await regularFile(path))) return undefined;
  return sha256(path);
}

async function fetchVndbArchive(
  cacheRoot: string,
  options: FetchOptions,
): Promise<{ archive: string; digest: string; file: string; url: string }> {
  const downloads = join(cacheRoot, 'downloads');
  const cached = await readVndbManifest(vndbDumpManifestPath(cacheRoot));
  if (cached) {
    const archive = join(downloads, cached.file);
    if ((await cachedArchiveDigest(archive)) === cached.sha256)
      return { archive, digest: cached.sha256, file: cached.file, url: cached.url };
  }

  const pinnedFile = dumpFileName(VNDB_ARCHIVE_URL);
  const pinnedPath = join(downloads, pinnedFile);
  const pinnedDigest = await cachedArchiveDigest(pinnedPath);
  if (pinnedDigest) return { archive: pinnedPath, digest: pinnedDigest, file: pinnedFile, url: VNDB_ARCHIVE_URL };

  const fetcher = options.fetchImpl ?? globalThis.fetch;
  const pinnedResponse = await fetcher(VNDB_ARCHIVE_URL, { redirect: 'follow' });
  if (pinnedResponse.ok) {
    const digest = await writeDumpBody(VNDB_ARCHIVE_URL, pinnedPath, pinnedResponse);
    return { archive: pinnedPath, digest, file: pinnedFile, url: VNDB_ARCHIVE_URL };
  }
  const pinnedStatus = pinnedResponse.status;
  try {
    await pinnedResponse.body?.cancel();
  } catch {
    /* 404/410 body is discarded before the index fetch */
  }
  ensure(gone(pinnedStatus), `Dump download failed with HTTP ${pinnedStatus}: ${VNDB_ARCHIVE_URL}`);

  const indexResponse = await fetcher(VNDB_DUMP_INDEX_URL, { redirect: 'follow' });
  ensure(Boolean(indexResponse.ok), `VNDB dump index failed with HTTP ${indexResponse.status}: ${VNDB_DUMP_INDEX_URL}`);
  const indexUrl = new URL(indexResponse.url || VNDB_DUMP_INDEX_URL);
  ensure(indexUrl.protocol === 'https:', 'VNDB dump index redirected away from HTTPS');
  const resolved = parseVndbDumpIndex(await indexResponse.text(), VNDB_DUMP_INDEX_URL);
  const archive = join(downloads, resolved.file);
  const existing = await cachedArchiveDigest(archive);
  const digest = existing ?? (await cacheUnpinnedAsset(resolved.url, archive, options));
  return { archive, digest, file: resolved.file, url: resolved.url };
}

/** Fetch one VNDB dump, verifying it and recording the resolved file and checksum. */
export async function fetchVndbDump(
  options: FetchOptions & { cacheRoot?: string } = {},
): Promise<{ cacheRoot: string; vndb: string; vndbArchive: string; manifest: VndbDumpManifest }> {
  const cacheRoot = resolve(options.cacheRoot ?? crossMediaDumpCacheRoot());
  await mkdir(cacheRoot, { recursive: true });
  const fetched = await fetchVndbArchive(cacheRoot, options);
  const vndb = await extractCached(
    fetched.archive,
    fetched.digest,
    join(cacheRoot, 'vndb', fetched.file.replace(/\.tar\.zst$/, '')),
    vndbDirectory,
    validateVndbArchive,
    (path, destination) => runCommand('tar', ['--zstd', '-xf', path, '-C', destination]),
  );
  const manifest: VndbDumpManifest = { file: fetched.file, url: fetched.url, sha256: fetched.digest };
  await writeVndbManifest(vndbDumpManifestPath(cacheRoot), manifest);
  return { cacheRoot, vndb, vndbArchive: fetched.archive, manifest };
}

/** Fetch and validate both source dumps, reusing verified archive and extraction caches. */
export async function fetchCrossMediaDumps(
  options: FetchOptions & { cacheRoot?: string } = {},
): Promise<CrossMediaDumpPaths> {
  const cacheRoot = resolve(options.cacheRoot ?? crossMediaDumpCacheRoot());
  const bangumiArchive = join(cacheRoot, 'downloads', 'dump-2026-10-20.210332Z.zip');
  const bangumiTarget = join(cacheRoot, 'bangumi', 'dump-2026-10-20.210332Z');
  await mkdir(cacheRoot, { recursive: true });

  const bangumiDigest = await cacheDumpAsset(BANGUMI_ARCHIVE_URL, bangumiArchive, BANGUMI_ARCHIVE_SHA256, options);
  const bangumi = await extractCached(
    bangumiArchive,
    bangumiDigest,
    bangumiTarget,
    bangumiDirectory,
    (path) => runCommand('unzip', ['-tqq', path]),
    (path, destination) => runCommand('unzip', ['-qq', path, '-d', destination]),
  );
  const vndbDump = await fetchVndbDump({ ...options, cacheRoot });
  return {
    cacheRoot,
    bangumi,
    vndb: vndbDump.vndb,
    bangumiArchive,
    vndbArchive: vndbDump.vndbArchive,
  };
}

if (import.meta.main) {
  try {
    const paths = await fetchCrossMediaDumps();
    process.stdout.write(`Bangumi: ${paths.bangumi}\nVNDB: ${paths.vndb}\nCache: ${paths.cacheRoot}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Dump fetch failed'}\n`);
    process.exitCode = 1;
  }
}
