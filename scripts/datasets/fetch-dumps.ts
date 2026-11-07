import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  importNetworkCode,
  importOperationError,
  type ImportOperation,
} from '../../services/importer/src/import-fetch.ts';
import { reclaimInactiveFileCache, releaseWalkFileCache } from '../walk-memory.ts';

export const CROSS_MEDIA_DUMP_CACHE_ENV = 'REZICS_DATASETS_DUMP_CACHE';
export const DEFAULT_CROSS_MEDIA_DUMP_CACHE = '/home/edge/projects/rezics/rezics-datasets/dumps';
export const BANGUMI_ARCHIVE_URL =
  'https://github.com/bangumi/Archive/releases/download/archive/dump-2026-10-20.210332Z.zip';
export const BANGUMI_ARCHIVE_SHA256 = '9fe8de272398ff4bd12994b73e25aac37cca631372383f6aadc503528623aa93';
export const VNDB_ARCHIVE_URL = 'https://dl.vndb.org/dump/vndb-db-2026-11-04.tar.zst';
export const VNDB_ARCHIVE_SHA256 = 'fadbe611c4d6475ef63a0c1861512bc9ff64d21c6c9804a988522c7c65f6fa85';
export const VNDB_ARCHIVE_TIMESTAMP = '2026-11-04 08:00:24+00';
export const DEVELOPMENT_VNDB_PIN = {
  url: VNDB_ARCHIVE_URL,
  sha256: VNDB_ARCHIVE_SHA256,
  timestamp: VNDB_ARCHIVE_TIMESTAMP,
} as const;
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
  chars_traits: ['id', 'tid', 'spoil', 'lie'],
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
  traits: ['id', 'gid', 'gorder', 'defaultspoil', 'sexual', 'searchable', 'applicable', 'name', 'alias', 'description'],
};
/** Required COPY fields for the selected character vocabulary path. Archive-added fields remain valid. */
export const VNDB_DUMP_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  chars_traits: ['id', 'tid', 'spoil', 'lie'],
  chars_vns: ['id', 'vid', 'rid', 'role', 'spoil'],
  traits: ['id', 'name'],
  traits_parents: ['id', 'parent', 'main'],
};
export const VNDB_DUMP_TABLES = [
  'anime',
  'chars',
  'chars_alias',
  'chars_names',
  'chars_traits',
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
  'traits',
  'traits_parents',
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
type VndbDumpPin = Readonly<{ url: string; sha256: string; timestamp: string }>;
type CommandRunner = (command: string, args: string[]) => Promise<void>;

export type CrossMediaDumpPaths = Readonly<{
  cacheRoot: string;
  bangumi: string;
  vndb: string;
  bangumiArchive: string;
  vndbArchive: string;
  sourceSnapshots: Readonly<Record<'bangumi' | 'vndb', DumpSnapshot>>;
}>;

/** Verified acquisition provenance; metadata licences do not grant media rights. */
type DumpSnapshot = Readonly<{
  file: string;
  url: string;
  sha256: string;
  timestamp?: string;
  licences: readonly string[];
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
    const href = match[1];
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, directory);
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

async function requestDumpResponse(
  url: string,
  options: FetchOptions,
  operation: ImportOperation = 'dump-download',
): Promise<Response> {
  const fetcher = options.fetchImpl ?? globalThis.fetch;
  try {
    return await fetcher(url, { redirect: 'follow' });
  } catch (cause) {
    const networkCode = importNetworkCode(cause);
    throw importOperationError({
      operation,
      phase: 'network',
      source: url,
      message: operation === 'dump-index' ? 'VNDB dump index request failed' : 'Dump download request failed',
      ...(networkCode === undefined ? {} : { networkCode }),
      cause,
    });
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* A failed response body is discarded before reporting its status. */
  }
}

async function requireDumpBody(url: string, response: Response, operation: ImportOperation): Promise<void> {
  if (response.ok && response.body) return;
  await discardResponseBody(response);
  const failedStatus = !response.ok;
  throw importOperationError({
    operation,
    phase: failedStatus ? 'http' : 'response',
    source: url,
    status: response.status,
    ...(failedStatus ? {} : { code: 'missing-response-body' }),
    message: failedStatus
      ? `${operation === 'dump-index' ? 'VNDB dump index' : 'Dump download'} failed with HTTP ${response.status}`
      : `${operation === 'dump-index' ? 'VNDB dump index' : 'Dump download'} response has no body`,
  });
}

function requireHttpsResponse(url: string, response: Response, operation: ImportOperation): void {
  let finalUrl: URL;
  try {
    finalUrl = new URL(response.url || url);
  } catch (cause) {
    throw importOperationError({
      operation,
      phase: 'response',
      source: url,
      status: response.status,
      code: 'invalid-response-url',
      message: 'Dump response URL is invalid',
      cause,
    });
  }
  if (finalUrl.protocol !== 'https:')
    throw importOperationError({
      operation,
      phase: 'response',
      source: url,
      status: response.status,
      code: 'redirect-away-from-https',
      message:
        operation === 'dump-index'
          ? 'VNDB dump index redirected away from HTTPS'
          : 'Dump download redirected away from HTTPS',
    });
}

/** Write a successful response, preserving stream and integrity failures as private causes. */
async function writeDumpBody(url: string, path: string, response: Response, expectedSha256?: string): Promise<string> {
  await requireDumpBody(url, response, 'dump-download');
  requireHttpsResponse(url, response, 'dump-download');
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.${randomUUID()}.part`;
  try {
    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(partial, { flags: 'wx' }),
      );
    } catch (cause) {
      throw importOperationError({
        operation: 'dump-download',
        phase: 'response',
        source: url,
        status: response.status,
        code: 'stream-failed',
        message: 'Dump response stream failed',
        cause,
      });
    }
    let downloadedHash: string;
    try {
      downloadedHash = await sha256(partial);
    } catch (cause) {
      throw importOperationError({
        operation: 'dump-download',
        phase: 'integrity',
        source: url,
        status: response.status,
        code: 'digest-read-failed',
        message: 'Dump integrity check failed',
        cause,
      });
    }
    if (expectedSha256 !== undefined && downloadedHash !== expectedSha256)
      throw importOperationError({
        operation: 'dump-download',
        phase: 'integrity',
        source: url,
        status: response.status,
        code: 'sha256-mismatch',
        message: 'Dump SHA-256 mismatch',
      });
    await rename(partial, path);
    return downloadedHash;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
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
    if (cachedHash === expectedSha256) {
      reclaimInactiveFileCache();
      return cachedHash;
    }
    await rm(path);
  }

  const response = await requestDumpResponse(url, options);
  return writeDumpBody(url, path, response, expectedSha256);
}

async function cacheUnpinnedAsset(url: string, path: string, options: FetchOptions = {}): Promise<string> {
  if (await regularFile(path)) return sha256(path);
  const response = await requestDumpResponse(url, options);
  return writeDumpBody(url, path, response);
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

async function vndbDirectory(root: string, timestamp?: string): Promise<string | undefined> {
  return locateDirectory(root, async (candidate) => {
    if (!(await regularFile(join(candidate, 'README.txt')))) return false;
    if (!(await regularFile(join(candidate, 'schema_vndbid.sql')))) return false;
    if (timestamp !== undefined) {
      const stamp = join(candidate, 'TIMESTAMP');
      if (!(await regularFile(stamp)) || (await readFile(stamp, 'utf8')).trimEnd() !== timestamp) return false;
    }
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
      const requiredFields = VNDB_DUMP_REQUIRED_COLUMNS[table];
      if (requiredFields && requiredFields.some((name) => !columns.includes(name))) return false;
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

/**
 * Restored dump tables skip archive hashing inside the 6 GiB slice when the pin marker matches, or when
 * structure/timestamp already verify and the marker is then written from the pin digest.
 */
export async function reuseVerifiedDumpExtraction(
  target: string,
  digest: string,
  verify: (root: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const cachedRoot = await verify(target);
  if (!cachedRoot) return undefined;
  const marker = join(target, MARKER);
  try {
    const marked = (await readFile(marker, 'utf8')).trim();
    if (marked === digest) return cachedRoot;
    if (marked) return undefined;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  await writeFile(marker, `${digest}\n`);
  return cachedRoot;
}

async function extractCached(
  archive: string,
  digest: string,
  target: string,
  verify: (root: string) => Promise<string | undefined>,
  validateArchive: (archivePath: string) => Promise<void>,
  extractArchive: (archivePath: string, destination: string) => Promise<void>,
): Promise<string> {
  const cachedRoot = await reuseVerifiedDumpExtraction(target, digest, verify);
  if (cachedRoot) return cachedRoot;

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

async function cachedArchiveDigest(path: string): Promise<string | undefined> {
  if (!(await regularFile(path))) return undefined;
  return sha256(path);
}

async function fetchVndbArchive(
  cacheRoot: string,
  options: FetchOptions & { pin?: VndbDumpPin },
): Promise<{ archive: string; digest: string; file: string; url: string }> {
  const downloads = join(cacheRoot, 'downloads');
  if (options.pin) {
    // A development snapshot cannot be replaced by a different machine-local manifest or a rotated dump.
    const { url, sha256 } = options.pin;
    const file = dumpFileName(url);
    const archive = join(downloads, file);
    const digest = await cacheDumpAsset(url, archive, sha256, options);
    return { archive, digest, file, url };
  }
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

  const pinnedResponse = await requestDumpResponse(VNDB_ARCHIVE_URL, options);
  if (pinnedResponse.ok) {
    const digest = await writeDumpBody(VNDB_ARCHIVE_URL, pinnedPath, pinnedResponse);
    return { archive: pinnedPath, digest, file: pinnedFile, url: VNDB_ARCHIVE_URL };
  }
  const pinnedStatus = pinnedResponse.status;
  await discardResponseBody(pinnedResponse);
  if (!gone(pinnedStatus))
    throw importOperationError({
      operation: 'dump-download',
      phase: 'http',
      source: VNDB_ARCHIVE_URL,
      status: pinnedStatus,
      message: `Dump download failed with HTTP ${pinnedStatus}`,
    });

  const indexResponse = await requestDumpResponse(VNDB_DUMP_INDEX_URL, options, 'dump-index');
  await requireDumpBody(VNDB_DUMP_INDEX_URL, indexResponse, 'dump-index');
  requireHttpsResponse(VNDB_DUMP_INDEX_URL, indexResponse, 'dump-index');
  let indexHtml: string;
  try {
    indexHtml = await indexResponse.text();
  } catch (cause) {
    throw importOperationError({
      operation: 'dump-index',
      phase: 'response',
      source: VNDB_DUMP_INDEX_URL,
      status: indexResponse.status,
      code: 'stream-failed',
      message: 'VNDB dump index response failed',
      cause,
    });
  }
  let resolved: { file: string; url: string };
  try {
    resolved = parseVndbDumpIndex(indexHtml, VNDB_DUMP_INDEX_URL);
  } catch (cause) {
    throw importOperationError({
      operation: 'dump-index',
      phase: 'response',
      source: VNDB_DUMP_INDEX_URL,
      status: indexResponse.status,
      code: 'invalid-index',
      message: 'VNDB dump index does not list a current database dump',
      cause,
    });
  }
  const archive = join(downloads, resolved.file);
  const existing = await cachedArchiveDigest(archive);
  const digest = existing ?? (await cacheUnpinnedAsset(resolved.url, archive, options));
  return { archive, digest, file: resolved.file, url: resolved.url };
}

/** Fetch one VNDB dump, verifying it and recording the resolved file and checksum. */
export async function fetchVndbDump(
  options: FetchOptions & { cacheRoot?: string; pin?: VndbDumpPin } = {},
): Promise<{ cacheRoot: string; vndb: string; vndbArchive: string; manifest: VndbDumpManifest }> {
  const cacheRoot = resolve(options.cacheRoot ?? crossMediaDumpCacheRoot());
  await mkdir(cacheRoot, { recursive: true });
  if (options.pin) {
    const file = dumpFileName(options.pin.url);
    const reused = await reuseVerifiedDumpExtraction(
      join(cacheRoot, 'vndb', file.replace(/\.tar\.zst$/, '')),
      options.pin.sha256,
      (root) => vndbDirectory(root, options.pin?.timestamp),
    );
    if (reused) {
      const manifest: VndbDumpManifest = { file, url: options.pin.url, sha256: options.pin.sha256 };
      await writeVndbManifest(vndbDumpManifestPath(cacheRoot), manifest);
      releaseWalkFileCache(reused);
      return { cacheRoot, vndb: reused, vndbArchive: join(cacheRoot, 'downloads', file), manifest };
    }
  }
  const fetched = await fetchVndbArchive(cacheRoot, options);
  const vndb = await extractCached(
    fetched.archive,
    fetched.digest,
    join(cacheRoot, 'vndb', fetched.file.replace(/\.tar\.zst$/, '')),
    (root) => vndbDirectory(root, options.pin?.timestamp),
    validateVndbArchive,
    (path, destination) => runCommand('tar', ['--zstd', '-xf', path, '-C', destination]),
  );
  const manifest: VndbDumpManifest = { file: fetched.file, url: fetched.url, sha256: fetched.digest };
  await writeVndbManifest(vndbDumpManifestPath(cacheRoot), manifest);
  reclaimInactiveFileCache();
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

  const reusedBangumi = await reuseVerifiedDumpExtraction(bangumiTarget, BANGUMI_ARCHIVE_SHA256, bangumiDirectory);
  const bangumiDigest = reusedBangumi
    ? BANGUMI_ARCHIVE_SHA256
    : await cacheDumpAsset(BANGUMI_ARCHIVE_URL, bangumiArchive, BANGUMI_ARCHIVE_SHA256, options);
  const bangumi =
    reusedBangumi ??
    (await extractCached(
      bangumiArchive,
      bangumiDigest,
      bangumiTarget,
      bangumiDirectory,
      (path) => runCommand('unzip', ['-tqq', path]),
      (path, destination) => runCommand('unzip', ['-qq', path, '-d', destination]),
    ));
  const vndbDump = await fetchVndbDump({ ...options, cacheRoot, pin: DEVELOPMENT_VNDB_PIN });
  reclaimInactiveFileCache();
  return {
    cacheRoot,
    bangumi,
    vndb: vndbDump.vndb,
    bangumiArchive,
    vndbArchive: vndbDump.vndbArchive,
    sourceSnapshots: {
      bangumi: {
        file: dumpFileName(BANGUMI_ARCHIVE_URL),
        url: BANGUMI_ARCHIVE_URL,
        sha256: bangumiDigest,
        licences: ['CC-BY-SA-3.0'],
      },
      vndb: {
        ...vndbDump.manifest,
        timestamp: DEVELOPMENT_VNDB_PIN.timestamp,
        licences: ['ODbL-1.0', 'DbCL-1.0'],
      },
    },
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
