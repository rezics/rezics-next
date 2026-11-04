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
export const VNDB_README_SHA256 = '49dc1574d7a656fa43fe0809f1981e09c401a0fa0c3c365d9fc0509c3c71e454';
export const VNDB_SCHEMA_SHA256 = 'd608ec4022029bdb65a5c780bbf8ca46e3348f16eaa7b88290efde35e2dd4758';

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
const VNDB_TABLES = [
  'anime',
  'chars',
  'chars_vns',
  'entry_meta',
  'extlinks',
  'producers',
  'releases',
  'releases_producers',
  'releases_supersedes',
  'releases_vn',
  'staff',
  'staff_alias',
  'vn',
  'vn_anime',
  'vn_relations',
  'vn_seiyuu',
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

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(Reflect.get(error, 'code'))
    : undefined;
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

async function hashMatches(path: string, expected: string): Promise<boolean> {
  if (!(await regularFile(path))) return false;
  return (await sha256(path)) === expected;
}

async function vndbDirectory(root: string): Promise<string | undefined> {
  return locateDirectory(root, async (candidate) => {
    if (!(await hashMatches(join(candidate, 'README.txt'), VNDB_README_SHA256))) return false;
    if (!(await hashMatches(join(candidate, 'schema_vndbid.sql'), VNDB_SCHEMA_SHA256))) return false;
    const db = join(candidate, 'db');
    for (const table of VNDB_TABLES) {
      const file = join(db, table);
      const header = join(db, `${table}.header`);
      if (!(await regularFile(file)) || !(await regularFile(header))) return false;
      const columns = (await readFile(header, 'utf8')).trimEnd().split('\t');
      if (!columns.length || columns.some((column) => !column) || new Set(columns).size !== columns.length)
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

/** Fetch and validate both pinned source dumps, reusing verified archive and extraction caches. */
export async function fetchCrossMediaDumps(options: FetchOptions & { cacheRoot?: string } = {}): Promise<CrossMediaDumpPaths> {
  const cacheRoot = resolve(options.cacheRoot ?? crossMediaDumpCacheRoot());
  const bangumiArchive = join(cacheRoot, 'downloads', 'dump-2026-10-20.210332Z.zip');
  const vndbArchive = join(cacheRoot, 'downloads', 'vndb-db-2026-10-25.tar.zst');
  const bangumiTarget = join(cacheRoot, 'bangumi', 'dump-2026-10-20.210332Z');
  const vndbTarget = join(cacheRoot, 'vndb', 'vndb-db-2026-10-25');
  await mkdir(cacheRoot, { recursive: true });

  const bangumiDigest = await cacheDumpAsset(BANGUMI_ARCHIVE_URL, bangumiArchive, BANGUMI_ARCHIVE_SHA256, options);
  const vndbDigest = await cacheUnpinnedAsset(VNDB_ARCHIVE_URL, vndbArchive, options);
  const bangumi = await extractCached(
    bangumiArchive,
    bangumiDigest,
    bangumiTarget,
    bangumiDirectory,
    (path) => runCommand('unzip', ['-tqq', path]),
    (path, destination) => runCommand('unzip', ['-qq', path, '-d', destination]),
  );
  const vndb = await extractCached(
    vndbArchive,
    vndbDigest,
    vndbTarget,
    vndbDirectory,
    validateVndbArchive,
    (path, destination) => runCommand('tar', ['--zstd', '-xf', path, '-C', destination]),
  );
  return { cacheRoot, bangumi, vndb, bangumiArchive, vndbArchive };
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
