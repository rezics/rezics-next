import {
  type MinecraftWorld,
  type MinecraftWorldArchive,
  type MinecraftWorldImportVersionRisk,
} from '@rezics/launcher-contract';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream, fstat, read, type Stats } from 'node:fs';
import { link, mkdir, open, opendir, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import type { Entry, ZipFile as ReadZip } from 'yauzl';
import { ZipFile } from 'yazl';
import { pathOverlaps } from './instances.ts';
import { inspectMinecraftLevel, minecraftLevelFileLimit } from './minecraft-level.ts';
import {
  checkedWorldsDirectory,
  isPortableSaveName,
  minecraftWorldRoot,
  minecraftWorldVersionRisk,
} from './saved-worlds.ts';
import { checkLocalDirectory, fileInfo, humanText, isMissing, storagePath } from './storage.ts';
import { moveDirectoryIfVacant, type LinuxDirectoryRename } from './directory-move.ts';
import { readZipEntry, withZipFile } from './zip-read.ts';

const archiveLimit = 2 * 1024 ** 3;
const entryLimit = 32_000;
const importStagingName = '.world-import-staging';
const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const pathKey = (value: string) => value.normalize('NFC').toUpperCase();
const readDescriptor = promisify(read);

type WorldFile = { parts: string[]; entry: Entry };
type WorldArchive = { archive: MinecraftWorldArchive; files: WorldFile[] };
type WorldEntry = { source: string; path: string; info: Stats };
const changedFolder = 'The world folder changed. Open the preview again.';
const occupiedWorldName = 'This instance already has a folder or file with that world name. Choose another name.';

function transient(name: string) {
  const key = name.toLowerCase();
  return key === 'session.lock' || key === '.ds_store' || key.startsWith('.rezics-restore-');
}

export function minecraftWorldImportName(value: string) {
  const name = humanText(value, 120, 'world folder name');
  if (!isPortableSaveName(name) || transient(name)) throw new Error('Choose a portable world folder name.');
  return name;
}

class WorldPaths {
  private readonly paths = new Map<string, { name: string; file: boolean }>();

  add(parts: string[], file: boolean) {
    if (
      parts.length > 24 ||
      Buffer.byteLength(parts.join('/')) > 240 ||
      parts.some((name) => !isPortableSaveName(name))
    ) {
      throw new Error('The world contains an invalid or non-portable path.');
    }
    let name = '';
    for (const [index, part] of parts.entries()) {
      name = name ? name + '/' + part : part;
      const leaf = file && index === parts.length - 1;
      const key = pathKey(name);
      const previous = this.paths.get(key);
      if (previous && (previous.name !== name || previous.file || leaf)) {
        throw new Error('The world contains conflicting paths.');
      }
      if (!previous) this.paths.set(key, { name, file: leaf });
    }
  }
}

function checkLevel(data: Buffer) {
  const level = inspectMinecraftLevel(data);
  if (level) return level.release;
  throw new Error('The selected world does not contain a readable Minecraft Java level.dat.');
}

function confirmWorldVersion(
  worldVersion: string | undefined,
  targetVersion: string,
  confirmation: MinecraftWorldImportVersionRisk | undefined,
) {
  const risk = minecraftWorldVersionRisk(worldVersion, targetVersion);
  if (risk && (confirmation?.worldVersion !== risk.worldVersion || confirmation.targetVersion !== risk.targetVersion)) {
    throw new Error('This world was saved by a newer Minecraft release. Open the preview and confirm the import.');
  }
}

function suggestedName(value: string) {
  const name = value.trim();
  return name.length <= 120 && isPortableSaveName(name) && !transient(name) ? name : 'Imported world';
}

export async function suggestMinecraftWorldImportName(game: string, preferred: string, signal?: AbortSignal) {
  const name = minecraftWorldImportName(preferred);
  signal?.throwIfAborted();
  const { path, exists } = await checkedWorldsDirectory(game);
  if (!exists) return name;

  const occupied = new Set<string>();
  for await (const entry of await opendir(path)) {
    signal?.throwIfAborted();
    occupied.add(pathKey(entry.name));
  }
  if (!occupied.has(pathKey(name))) return name;
  const stem = Array.from(name);
  for (let index = 2; ; index += 1) {
    const suffix = ` (${index})`;
    let candidate = stem.join('').trimEnd() + suffix;
    while (candidate.length > 120 || Buffer.byteLength(candidate) > 255) {
      stem.pop();
      candidate = stem.join('').trimEnd() + suffix;
    }
    if (!occupied.has(pathKey(candidate))) return candidate;
  }
}

export async function checkMinecraftWorldImportSource(home: string, source: string) {
  const canonical = await realpath(source);
  if (pathOverlaps(canonical, join(await realpath(home), importStagingName))) {
    throw new Error('Choose a source world outside the import staging folder.');
  }
  return canonical;
}

async function inspect(zip: ReadZip, source: string, signal?: AbortSignal): Promise<WorldArchive> {
  if (zip.entryCount > entryLimit) throw new Error('The world ZIP contains too many entries.');
  const paths = new WorldPaths();
  const files: WorldFile[] = [];
  const levels: WorldFile[] = [];
  let bytes = 0;
  for await (const entry of zip.eachEntry()) {
    signal?.throwIfAborted();
    const directory = entry.fileName.endsWith('/');
    const parts = (directory ? entry.fileName.slice(0, -1) : entry.fileName).split('/');
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
    if ((mode && mode !== (directory ? 0x4000 : 0x8000)) || (entry.externalFileAttributes & 0x10 && !directory)) {
      throw new Error('The world ZIP contains a link or special file.');
    }
    if (
      entry.generalPurposeBitFlag & 1 ||
      ![0, 8].includes(entry.compressionMethod) ||
      (directory && entry.uncompressedSize !== 0)
    )
      throw new Error('The world ZIP uses unsupported settings.');
    paths.add(parts, !directory);
    if (directory || parts[0] === '__MACOSX' || parts.some(transient)) continue;
    bytes += entry.uncompressedSize;
    if (bytes > archiveLimit) throw new Error('The expanded world exceeds the 2 GiB limit.');
    const file = { parts, entry };
    files.push(file);
    if (parts.length <= 2 && parts.at(-1) === 'level.dat') levels.push(file);
  }
  const [level] = levels;
  if (levels.length !== 1 || !level) throw new Error('Choose a ZIP containing one Minecraft Java world.');
  const prefix = level.parts.length === 2 ? level.parts[0] : undefined;
  if (prefix && files.some(({ parts }) => parts[0] !== prefix || parts.length < 2)) {
    throw new Error('The world ZIP contains files outside its world folder.');
  }
  signal?.throwIfAborted();
  const levelData = await readZipEntry(zip, level.entry, minecraftLevelFileLimit, signal);
  if (crc32(levelData) !== level.entry.crc32) throw new Error('The world ZIP contains damaged data.');
  const minecraftVersion = checkLevel(levelData);
  const name = suggestedName(prefix ?? basename(source, extname(source)));
  return {
    archive: { name, files: files.length, bytes, ...(minecraftVersion && { minecraftVersion }) },
    files: prefix ? files.map(({ parts, entry }) => ({ parts: parts.slice(1), entry })) : files,
  };
}

function statDescriptor(fd: number): Promise<Stats> {
  return new Promise((resolve, reject) => fstat(fd, (error, info) => (error ? reject(error) : resolve(info))));
}

function unchanged(before: Stats, after: Stats) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function withWorldArchive<T>(
  source: string,
  signal: AbortSignal | undefined,
  run: (zip: ReadZip, world: WorldArchive, digest: string) => Promise<T>,
) {
  signal?.throwIfAborted();
  if (!isAbsolute(source) || extname(source).toLowerCase() !== '.zip') throw new Error('Choose a world ZIP file.');
  const before = await fileInfo(source);
  if (!before?.isFile() || before.size < 1 || before.size > archiveLimit) {
    throw new Error('Choose a regular world ZIP within the 2 GiB limit.');
  }
  const changed = 'The world ZIP changed. Open the preview again.';
  return withZipFile(source, async (zip, fd) => {
    if (!unchanged(before, await statDescriptor(fd))) throw new Error(changed);
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(256 * 1024);
    for (let offset = 0; offset < before.size;) {
      signal?.throwIfAborted();
      const { bytesRead } = await readDescriptor(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!bytesRead) throw new Error(changed);
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    signal?.throwIfAborted();
    const value = await run(zip, await inspect(zip, source, signal), hash.digest('hex'));
    if (!unchanged(before, await statDescriptor(fd))) throw new Error(changed);
    return value;
  });
}

export function inspectMinecraftWorldArchive(source: string, signal?: AbortSignal) {
  return withWorldArchive(source, signal, async (_zip, { archive }, digest) => ({ archive, digest }));
}

async function publishWorld(
  home: string,
  game: string,
  source: string,
  input: string,
  signal: AbortSignal | undefined,
  linuxRenameDirectory: LinuxDirectoryRename | undefined,
  stage: (directory: string) => Promise<void>,
): Promise<MinecraftWorld> {
  signal?.throwIfAborted();
  const name = minecraftWorldImportName(input);
  const { path: saves } = await checkedWorldsDirectory(game);
  const staging = join(home, importStagingName);
  const stagedWorld = join(staging, 'world');
  const target = join(saves, name);
  const canonicalSource = await checkMinecraftWorldImportSource(home, source);
  if (pathOverlaps(canonicalSource, join(await storagePath(saves), name))) {
    throw new Error('Choose a destination outside the source world.');
  }
  async function ensureAvailable() {
    const { exists } = await checkedWorldsDirectory(game);
    if (exists && (await readdir(saves)).some((entry) => pathKey(entry) === pathKey(name))) {
      throw new Error(occupiedWorldName);
    }
  }
  await ensureAvailable();
  await checkLocalDirectory(staging, 'world import staging');
  await checkLocalDirectory(stagedWorld, 'staged world');
  await mkdir(staging, { recursive: true });
  await rm(stagedWorld, { recursive: true, force: true });
  try {
    signal?.throwIfAborted();
    await stage(stagedWorld);
    signal?.throwIfAborted();
    await mkdir(saves, { recursive: true });
    await ensureAvailable();
    signal?.throwIfAborted();
    try {
      await moveDirectoryIfVacant(stagedWorld, target, linuxRenameDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (await fileInfo(target))) {
        throw new Error(occupiedWorldName);
      }
      throw error;
    }
    return { id: name, name };
  } finally {
    await rm(stagedWorld, { recursive: true, force: true });
    try {
      await rmdir(staging);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!isMissing(error) && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    }
  }
}

export function importMinecraftWorldArchive(
  home: string,
  game: string,
  source: string,
  expected: string,
  input: string,
  targetVersion: string,
  confirmation?: MinecraftWorldImportVersionRisk,
  signal?: AbortSignal,
  linuxRenameDirectory?: LinuxDirectoryRename,
) {
  return publishWorld(home, game, source, input, signal, linuxRenameDirectory, (stagedWorld) =>
    withWorldArchive(source, signal, async (zip, world, digest) => {
      if (digest !== expected) throw new Error('The world ZIP changed. Open the preview again.');
      confirmWorldVersion(world.archive.minecraftVersion, targetVersion, confirmation);
      for (const { parts, entry } of world.files) {
        signal?.throwIfAborted();
        const file = join(stagedWorld, ...parts);
        await mkdir(dirname(file), { recursive: true });
        let crc = 0;
        const checksum = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            crc = crc32(chunk, crc);
            callback(null, chunk);
          },
          flush(callback) {
            callback(crc === entry.crc32 ? undefined : new Error('The world ZIP contains damaged data.'));
          },
        });
        await pipeline(
          await zip.openReadStreamPromise(entry),
          checksum,
          createWriteStream(file, { flags: 'wx', mode: 0o600 }),
          { signal },
        );
      }
    }),
  );
}

async function collectWorldFiles(root: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const world = await fileInfo(root);
  if (!world?.isDirectory()) throw new Error('The selected world is unavailable.');
  const device = world.dev;
  const paths = new WorldPaths();
  const files: WorldEntry[] = [];
  const directories: WorldEntry[] = [{ source: root, path: '', info: world }];
  let entries = 0;
  let bytes = 0;
  async function read(directory: string, parts: string[], expected: Stats) {
    const folder = await opendir(directory);
    for await (const entry of folder) {
      signal?.throwIfAborted();
      if (transient(entry.name)) continue;
      if (++entries > entryLimit) throw new Error('The world contains too many entries.');
      const source = join(directory, entry.name);
      const info = await fileInfo(source);
      if (!info || info.dev !== device || (!info.isFile() && !info.isDirectory())) {
        throw new Error('The world contains a link, special file or mounted path.');
      }
      const segments = [...parts, entry.name];
      paths.add(segments, info.isFile());
      const value = { source, info, path: segments.join('/') };
      if (info.isDirectory()) {
        directories.push(value);
        await read(source, segments, info);
      } else {
        bytes += info.size;
        if (bytes > archiveLimit) throw new Error('The world exceeds the 2 GiB limit.');
        files.push(value);
      }
    }
    const current = await fileInfo(directory);
    if (!current?.isDirectory() || !unchanged(expected, current))
      throw new Error('A world folder changed while being read.');
  }
  await read(root, [], world);
  return { directories, files, bytes, root: world };
}

async function openWorldFile(file: WorldEntry, changed: string) {
  const handle = await open(file.source, openFlags);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !unchanged(file.info, info)) throw new Error(changed);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readWorldFolder(source: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!isAbsolute(source)) throw new Error('Choose a Minecraft Java world folder.');
  const selected = await fileInfo(source);
  if (!selected?.isDirectory()) throw new Error('Choose a regular Minecraft Java world folder.');
  const root = await realpath(source);
  const world = await collectWorldFiles(root, signal);
  if (!unchanged(selected, world.root)) throw new Error(changedFolder);
  const level = world.files.find(({ path }) => path === 'level.dat');
  if (!level || level.info.size < 1 || level.info.size > minecraftLevelFileLimit) {
    throw new Error('Choose a Minecraft Java world folder with a readable level.dat at its root.');
  }
  const handle = await openWorldFile(level, changedFolder);
  let minecraftVersion: string | undefined;
  try {
    minecraftVersion = checkLevel(
      await buffer(handle.createReadStream({ start: 0, end: level.info.size - 1, autoClose: false })),
    );
    if (!unchanged(level.info, await handle.stat())) throw new Error(changedFolder);
  } finally {
    await handle.close();
  }
  signal?.throwIfAborted();
  const current = await fileInfo(source);
  if (!current?.isDirectory() || !unchanged(selected, current)) throw new Error(changedFolder);
  const hash = createHash('sha256').update(JSON.stringify(root));
  for (const { path, info } of [...world.directories, ...world.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path === b.path ? 0 : 1,
  )) {
    hash.update(JSON.stringify([path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]) + '\n');
  }
  return { ...world, source: root, digest: hash.digest('hex'), minecraftVersion };
}

export async function inspectMinecraftWorldFolder(source: string, signal?: AbortSignal) {
  const world = await readWorldFolder(source, signal);
  return {
    folder: {
      name: suggestedName(basename(world.source)),
      files: world.files.length,
      bytes: world.bytes,
      ...(world.minecraftVersion && { minecraftVersion: world.minecraftVersion }),
    },
    digest: world.digest,
  };
}

export async function importMinecraftWorldFolder(
  home: string,
  game: string,
  source: string,
  expected: string,
  input: string,
  targetVersion: string,
  confirmation?: MinecraftWorldImportVersionRisk,
  signal?: AbortSignal,
  linuxRenameDirectory?: LinuxDirectoryRename,
) {
  const world = await readWorldFolder(source, signal);
  if (world.digest !== expected) throw new Error(changedFolder);
  confirmWorldVersion(world.minecraftVersion, targetVersion, confirmation);
  return publishWorld(home, game, world.source, input, signal, linuxRenameDirectory, async (stagedWorld) => {
    for (const entry of world.directories) {
      signal?.throwIfAborted();
      await mkdir(join(stagedWorld, entry.path), { recursive: true });
    }
    for (const file of world.files) {
      signal?.throwIfAborted();
      const handle = await openWorldFile(file, changedFolder);
      try {
        const target = join(stagedWorld, file.path);
        if (file.info.size === 0) {
          await writeFile(target, '', { flag: 'wx', mode: 0o600 });
        } else {
          await pipeline(
            handle.createReadStream({ start: 0, end: file.info.size - 1, autoClose: false }),
            createWriteStream(target, { flags: 'wx', mode: 0o600 }),
            { signal },
          );
        }
        if (!unchanged(file.info, await handle.stat())) throw new Error(changedFolder);
      } finally {
        await handle.close();
      }
    }
    if ((await readWorldFolder(source, signal)).digest !== expected) throw new Error(changedFolder);
  });
}

export async function exportMinecraftWorldArchive(
  game: string,
  worldId: string,
  destination: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { path: source } = await minecraftWorldRoot(game, { kind: 'world', id: worldId });
  if (!isAbsolute(destination) || extname(destination).toLowerCase() !== '.zip') {
    throw new Error('Choose an absolute destination for the world ZIP.');
  }
  const folder = await realpath(dirname(destination));
  const target = join(folder, basename(destination));
  if (pathOverlaps(await realpath(source), target)) throw new Error('Save the ZIP outside the Minecraft world folder.');
  if (await fileInfo(target)) throw new Error('There is already a file at the chosen ZIP destination.');
  const { files } = await collectWorldFiles(source, signal);
  signal?.throwIfAborted();
  const staged = join(folder, `.rezics-world-${randomUUID()}.zip`);
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const written = pipeline(output, createWriteStream(staged, { flags: 'wx', mode: 0o600, flush: true }), { signal });
  zip.on('error', (error) => output.destroy(error));
  let opening: Promise<void> | undefined;
  let input: Readable | undefined;
  let inputClosed: Promise<void> | undefined;
  try {
    for (const file of files) {
      zip.addReadStreamLazy(file.path, { size: file.info.size, mtime: file.info.mtime }, (openStream) => {
        async function start() {
          signal?.throwIfAborted();
          if (output.destroyed) return;
          const handle = await openWorldFile(file, 'A world file changed during export.');
          if (output.destroyed) {
            await handle.close();
            return;
          }
          const stream = handle.createReadStream();
          input = stream;
          inputClosed = new Promise<void>((resolve) => stream.once('close', resolve));
          stream.on('error', (error) => output.destroy(error));
          openStream(null, stream);
        }
        opening = start().catch((error: Error) => {
          output.destroy(error);
        });
      });
    }
    zip.end();
    await written;
    if ((await fileInfo(staged))!.size > archiveLimit) throw new Error('The exported ZIP exceeds the 2 GiB limit.');
    signal?.throwIfAborted();
    await link(staged, target);
    return target;
  } finally {
    output.destroy();
    await opening;
    input?.destroy();
    await inputClosed;
    await written.catch(() => {});
    await rm(staged, { force: true });
  }
}
