import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants, createWriteStream, fstat, read, type BigIntStats } from 'node:fs';
import { link, mkdir, open as openFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import type { Entry, ZipFile as OpenZip } from 'yauzl';
import { ZipFile } from 'yazl';
import { pathOverlaps } from '../instances.ts';
import { fileInfo } from '../storage.ts';
import { readZipEntry, withZipFile } from '../zip-read.ts';
import {
  comparePaths,
  maxPackArchive,
  maxPackEntries,
  maxPackIndex,
  maxPackOverride,
  packIndexName,
  packPath,
  PackPaths,
  packPreview,
  parsePackManifest,
  requireClientPath,
  type PackFile,
  type PackManifest,
  type PackOverride,
} from './modrinth-pack-format.ts';

const zipFolders = new Set(['overrides', 'client-overrides', 'server-overrides']);
const fileFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const readChunk = promisify(read);
type ArchiveOverride = PackOverride & { entry: Entry };
type ReadPack<T> = (
  manifest: PackManifest,
  overrides: PackOverride[],
  copyOverrides: (destination: string) => Promise<PackFile[]>,
) => Promise<T>;

export async function copyPackArchive(source: string, target: string, signal?: AbortSignal) {
  try {
    return await stageArchive(source, target, signal);
  } catch (error) {
    if (error instanceof Error && 'path' in error)
      throw new Error('Launcher could not read the chosen Modrinth archive.');
    throw error;
  }
}

async function stageArchive(source: string, target: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const info = await archiveInfo(source);
  const digest = createHash('sha256');
  let bytes = 0;
  const hash = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxPackArchive) return callback(new Error('The Modrinth archive is too large.'));
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  const handle = await openFile(source, fileFlags);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Choose a regular Modrinth archive.');
    await pipeline(
      handle.createReadStream(),
      hash,
      createWriteStream(target, { flags: 'wx', mode: 0o600, flush: true }),
      { signal },
    );
  } finally {
    await handle.close();
  }
  if (bytes !== info.size) throw new Error('The Modrinth archive changed while Launcher was reading it.');
  return digest.digest('hex');
}

async function archiveInfo(source: string) {
  if (!isAbsolute(source) || extname(source).toLowerCase() !== '.mrpack') {
    throw new Error('Choose a Modrinth .mrpack file.');
  }
  const info = await fileInfo(source);
  if (!info?.isFile() || info.size > maxPackArchive) {
    throw new Error('Choose a regular Modrinth archive within the 512 MiB limit.');
  }
  return info;
}

function descriptorStats(descriptor: number) {
  return new Promise<BigIntStats>((resolve, reject) => {
    fstat(descriptor, { bigint: true }, (error, stats) => (error ? reject(error) : resolve(stats)));
  });
}

export async function inspectPackArchive(source: string, signal?: AbortSignal) {
  try {
    signal?.throwIfAborted();
    await archiveInfo(source);
    return await withZipFile(source, async (zip, descriptor) => {
      const before = await descriptorStats(descriptor);
      if (!before.isFile() || before.size > maxPackArchive) throw new Error('The Modrinth archive is too large.');
      const digest = createHash('sha256');
      const chunk = Buffer.allocUnsafe(128 * 1024);
      let bytes = 0;
      while (true) {
        signal?.throwIfAborted();
        const { bytesRead } = await readChunk(descriptor, chunk, 0, chunk.length, bytes);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > maxPackArchive) throw new Error('The Modrinth archive is too large.');
        digest.update(chunk.subarray(0, bytesRead));
      }
      const preview = await readPackArchive(
        zip,
        async (manifest, overrides) => packPreview(manifest, overrides),
        signal,
      );
      const after = await descriptorStats(descriptor);
      if (
        BigInt(bytes) !== before.size ||
        before.size !== after.size ||
        before.ctimeNs !== after.ctimeNs ||
        before.mtimeNs !== after.mtimeNs
      ) {
        throw new Error('The Modrinth archive changed while Launcher was reading it.');
      }
      return { digest: digest.digest('hex'), preview };
    });
  } catch (error) {
    if (error instanceof Error && 'path' in error)
      throw new Error('Launcher could not read the chosen Modrinth archive.');
    throw error;
  }
}

function verifyZipType(entry: Entry, directory: boolean) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  const regular = directory ? 0x4000 : 0x8000;
  if ((mode && mode !== regular) || (entry.externalFileAttributes & 0x10 && !directory)) {
    throw new Error('The Modrinth archive contains a linked or special file.');
  }
  if (entry.generalPurposeBitFlag & 1 || ![0, 8].includes(entry.compressionMethod)) {
    throw new Error('The Modrinth archive uses unsupported ZIP settings.');
  }
  if (directory && entry.uncompressedSize !== 0) throw new Error('A Modrinth archive directory contains file data.');
}

export function withPackArchive<T>(source: string, run: ReadPack<T>, signal?: AbortSignal) {
  return withZipFile(source, (zip) => readPackArchive(zip, run, signal));
}

async function readPackArchive<T>(zip: OpenZip, run: ReadPack<T>, signal?: AbortSignal): Promise<T> {
  if (zip.entryCount > maxPackEntries) throw new Error('The Modrinth archive contains too many entries.');
  const archivePaths = new PackPaths();
  const seen = new Set<string>();
  const shared = new Map<string, ArchiveOverride>();
  const client = new Map<string, ArchiveOverride>();
  let manifest: PackManifest | undefined;
  let bytes = 0;

  for await (const entry of zip.eachEntry()) {
    signal?.throwIfAborted();
    const directory = entry.fileName.endsWith('/');
    const path = directory ? entry.fileName.slice(0, -1) : entry.fileName;
    verifyZipType(entry, directory);
    if (seen.has(path)) throw new Error('The Modrinth archive contains duplicate entries.');
    seen.add(path);
    archivePaths.add(path, directory);
    bytes += entry.uncompressedSize;
    if (bytes > maxPackArchive) throw new Error('The Modrinth archive expands beyond the 512 MiB limit.');
    if (path === packIndexName && !directory) {
      if (entry.uncompressedSize > maxPackIndex) throw new Error('The Modrinth pack index is too large.');
      const data = await readZipEntry(zip, entry, maxPackIndex);
      if (crc32(data) !== entry.crc32) throw new Error('The Modrinth pack index failed its ZIP checksum.');
      try {
        manifest = parsePackManifest(JSON.parse(data.toString('utf8')));
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('The Modrinth pack index is not readable.');
        throw error;
      }
      continue;
    }
    if (entry.uncompressedSize > maxPackOverride) throw new Error('A Modrinth pack override is too large.');
    if (path === 'icon.png' && !directory) continue;
    const [folder, ...parts] = packPath(path);
    if (!folder || !zipFolders.has(folder) || (!directory && !parts.length)) {
      throw new Error(`The Modrinth archive contains an unsupported entry (${path}).`);
    }
    if (!parts.length || folder === 'server-overrides') continue;
    const relative = parts.join('/');
    if (relative === 'icon.png' && !directory) continue;
    requireClientPath(relative, 'override', directory);
    if (directory) continue;
    const kind = folder === 'overrides' ? 'shared' : 'client';
    (kind === 'shared' ? shared : client).set(relative, {
      path: relative,
      bytes: entry.uncompressedSize,
      kind,
      entry,
    });
  }

  if (!manifest) throw new Error('The Modrinth archive has no pack index.');
  const paths = new PackPaths();
  for (const resource of manifest.files) paths.add(resource.path);
  for (const override of shared.values()) paths.add(override.path);
  for (const override of client.values()) {
    paths.add(override.path, false, shared.has(override.path));
    shared.set(override.path, override);
  }
  const overrides = [...shared.values()].sort(comparePaths);
  if (overrides.length + manifest.files.length > maxPackEntries) {
    throw new Error('The Modrinth pack contains too many files.');
  }

  return await run(
    manifest,
    overrides.map(({ path, bytes: size, kind }) => ({ path, bytes: size, kind })),
    async (destination) => {
      const files: PackFile[] = [];
      for (const { entry, path, bytes: expected } of overrides) {
        signal?.throwIfAborted();
        const target = join(destination, ...packPath(path));
        await mkdir(dirname(target), { recursive: true });
        const hash = createHash('sha512');
        let checksum = 0;
        let size = 0;
        const verify = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > expected) return callback(new Error('A Modrinth pack override exceeds its declared size.'));
            checksum = crc32(chunk, checksum);
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          await zip.openReadStreamPromise(entry),
          verify,
          createWriteStream(target, { flags: 'wx', mode: 0o600, flush: true }),
          { signal },
        );
        if (size !== expected || checksum !== entry.crc32)
          throw new Error(`A Modrinth pack override failed verification (${path}).`);
        files.push({ path, bytes: size, sha512: hash.digest('hex') });
      }
      return files;
    },
  );
}

export async function writePackArchive(
  destination: string,
  instanceDir: string,
  manifest: PackManifest,
  overrides: PackOverride[],
  source: (path: string) => string,
  reserve: (folder: string) => Promise<string>,
) {
  if (!isAbsolute(destination) || extname(destination).toLowerCase() !== '.mrpack') {
    throw new Error('Choose a .mrpack export file.');
  }
  const folder = await realpath(dirname(destination));
  const instances = await realpath(dirname(instanceDir));
  const target = join(folder, basename(destination));
  if (pathOverlaps(instances, target))
    throw new Error('Choose an export location outside the Launcher instance folders.');
  if (await fileInfo(target)) throw new Error('Choose a new file for the Modrinth pack export.');

  const temporary = await reserve(folder);
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  // ZIP's timestamp uses local date fields. The DOS epoch produces identical metadata across time zones.
  const metadata = { mtime: new Date(1980, 0, 1), mode: 0o100644, forceDosTimestamp: true };
  const archive = pipeline(output, createWriteStream(temporary, { flags: 'wx', mode: 0o600, flush: true }));
  zip.on('error', (error) => output.destroy(error));
  try {
    zip.addBuffer(Buffer.from(JSON.stringify(manifest) + '\n'), packIndexName, metadata);
    for (const { path, kind } of overrides) {
      const prefix = kind === 'client' ? 'client-overrides' : 'overrides';
      zip.addFile(source(path), `${prefix}/${path}`, metadata);
    }
    zip.end();
    await archive;
    if ((await fileInfo(temporary))!.size > maxPackArchive)
      throw new Error('The exported Modrinth archive is too large.');
    await link(temporary, target);
    return target;
  } catch (error) {
    output.destroy();
    await archive.catch(() => {});
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}
