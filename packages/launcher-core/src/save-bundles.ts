import type { Snapshot } from '@rezics/launcher-contract';
import { randomUUID } from 'node:crypto';
import { mkdir, open, opendir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import * as v from 'valibot';
import { moveDirectoryIfVacant, type LinuxDirectoryRename } from './directory-move.ts';
import { copySaveTree, matchesSaveTree, portableSaveLimits, type SnapshotRoot } from './save-tree.ts';
import { isPortableSaveName, minecraftWorldSaveRoot } from './saved-worlds.ts';
import { fileInfo, storagePath, writeJson } from './storage.ts';

export type SnapshotRecord = Snapshot & { roots: SnapshotRoot[]; newestWorldVersion?: string | null };

const maxManifestBytes = 1024 * 1024;

const portableCounts = {
  files: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(portableSaveLimits.entries)),
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(portableSaveLimits.bytes)),
};
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const localCounts = { files: count, bytes: count };
const rootId = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u));
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
const snapshotFields = {
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  label: v.exactOptional(v.pipe(v.string(), v.maxLength(120))),
  pinned: v.exactOptional(v.boolean()),
  minecraft: v.exactOptional(
    v.strictObject({
      version: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
      loader: v.picklist(['vanilla', 'fabric', 'forge', 'neoforge']),
      loaderVersion: v.exactOptional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
      mods: v.array(v.string()),
    }),
  ),
  selection: v.exactOptional(
    v.strictObject({
      kind: v.literal('world'),
      id: v.pipe(v.string(), v.check(isPortableSaveName)),
    }),
  ),
};

const manifestSchema = v.strictObject({
  format: v.literal('rezics-save-backup'),
  version: v.literal(1),
  snapshot: v.strictObject({ ...snapshotFields, ...portableCounts }),
  roots: v.pipe(
    v.array(v.strictObject({ id: rootId, ...portableCounts, sha256: digest })),
    v.minLength(1),
    v.maxLength(8),
  ),
});

const localSnapshotSchema = v.object({
  ...snapshotFields,
  ...localCounts,
  id: v.string(),
  newestWorldVersion: v.exactOptional(v.nullable(v.string())),
  roots: v.pipe(
    v.array(v.object({ id: rootId, ...localCounts, sha256: v.exactOptional(digest) })),
    v.minLength(1),
    v.maxLength(8),
  ),
});

type Manifest = v.InferOutput<typeof manifestSchema>;

function consistentSnapshot(snapshot: Omit<Snapshot, 'id'>, roots: SnapshotRoot[]) {
  const ids = new Set(roots.map((root) => root.id));
  return (
    ids.size === roots.length &&
    roots.reduce((count, root) => count + root.files, 0) === snapshot.files &&
    roots.reduce((count, root) => count + root.bytes, 0) === snapshot.bytes &&
    (snapshot.selection
      ? Boolean(snapshot.minecraft && ids.size === 1 && ids.has(minecraftWorldSaveRoot))
      : !ids.has(minecraftWorldSaveRoot))
  );
}

export function parseStoredSnapshot(value: unknown, id: string): SnapshotRecord | undefined {
  const parsed = v.safeParse(localSnapshotSchema, value);
  if (parsed.success && parsed.output.id === id && consistentSnapshot(parsed.output, parsed.output.roots)) {
    return parsed.output;
  }
}

function validateManifest(value: unknown): Manifest {
  const result = v.safeParse(manifestSchema, value);
  if (!result.success) throw new Error('The folder does not contain a supported REZICS backup.');
  const { roots, snapshot } = result.output;
  if (!consistentSnapshot(snapshot, roots)) {
    throw new Error('The backup manifest has inconsistent save roots or counts.');
  }
  return result.output;
}

function contained(parent: string, path: string) {
  const child = relative(parent, path);
  return !child || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function portableDirectory(path: string) {
  if (!isAbsolute(path) || !(await fileInfo(path))?.isDirectory()) {
    throw new Error('Choose an existing backup folder without links.');
  }
  return realpath(path);
}

export async function exportSaveBundle(
  source: string,
  store: string,
  record: SnapshotRecord,
  selectedFolder: string,
  linuxRenameDirectory?: LinuxDirectoryRename,
): Promise<string> {
  const destination = await portableDirectory(selectedFolder);
  if (contained(await storagePath(store), destination)) {
    throw new Error('Choose a folder outside the Launcher snapshot store.');
  }
  const nonce = randomUUID();
  const stage = join(destination, `.rezics-save-${nonce}.pending`);
  const target = join(destination, `rezics-save-${nonce}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    const data = join(stage, 'data');
    await mkdir(data);
    const portable = { entries: 0, bytes: 0 };
    const roots: Manifest['roots'] = [];
    for (const root of record.roots) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(root.id)) throw new Error('This snapshot has an invalid save root.');
      const copied = await copySaveTree(join(source, root.id), join(data, root.id), { portable });
      if (!matchesSaveTree(root, copied)) {
        throw new Error('This backup is damaged. Choose another backup.');
      }
      roots.push({ id: root.id, ...copied });
    }
    const snapshot = {
      createdAt: record.createdAt,
      ...(record.label && { label: record.label }),
      ...(record.pinned && { pinned: true }),
      files: record.files,
      bytes: record.bytes,
      ...(record.minecraft && { minecraft: record.minecraft }),
      ...(record.selection && { selection: record.selection }),
    };
    const manifest = validateManifest({ format: 'rezics-save-backup', version: 1, snapshot, roots });
    if (Buffer.byteLength(JSON.stringify(manifest)) > maxManifestBytes) {
      throw new Error('The backup metadata is larger than the supported portable size.');
    }
    await writeJson(join(stage, 'backup.json'), manifest);
    await moveDirectoryIfVacant(stage, target, linuxRenameDirectory);
    return target;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function readSaveBundle(selectedFolder: string, store: string) {
  const folder = await portableDirectory(selectedFolder);
  const internal = await storagePath(store);
  if (contained(internal, folder) || contained(folder, internal)) {
    throw new Error('Choose a portable backup folder outside the Launcher snapshot store.');
  }
  const directory = await opendir(folder);
  for await (const entry of directory) {
    if ((entry.name === 'backup.json' && entry.isFile()) || (entry.name === 'data' && entry.isDirectory())) continue;
    throw new Error('The folder contains an unexpected backup file or link.');
  }
  const path = join(folder, 'backup.json');
  const file = await fileInfo(path);
  if (!file?.isFile() || file.size > maxManifestBytes) {
    throw new Error('The folder does not contain a supported REZICS backup.');
  }
  const handle = await open(path, 'r');
  let manifest: Manifest;
  try {
    const data = Buffer.alloc(maxManifestBytes + 1);
    let read = 0;
    while (read < data.length) {
      const result = await handle.read(data, read, data.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    if (read > maxManifestBytes) throw new Error('The backup metadata is larger than the supported portable size.');
    let value: unknown;
    try {
      value = JSON.parse(data.toString('utf8', 0, read));
    } catch {
      throw new Error('The backup manifest could not be read.');
    }
    manifest = validateManifest(value);
  } finally {
    await handle.close();
  }
  return { data: join(folder, 'data'), manifest };
}

export async function copyVerifiedBundle(
  bundle: Awaited<ReturnType<typeof readSaveBundle>>,
  stage: string,
): Promise<SnapshotRecord['roots']> {
  if (!(await fileInfo(bundle.data))?.isDirectory())
    throw new Error('The backup data folder is unavailable or linked.');
  const remaining = new Set(bundle.manifest.roots.map((root) => root.id));
  const directory = await opendir(bundle.data);
  for await (const entry of directory) {
    if (!entry.isDirectory() || !remaining.delete(entry.name)) {
      throw new Error('The backup data folder contains an unexpected save root.');
    }
  }
  if (remaining.size) throw new Error('The backup is missing a save root.');
  const portable = { entries: 0, bytes: 0 };
  const roots: SnapshotRecord['roots'] = [];
  for (const saved of bundle.manifest.roots) {
    const copied = await copySaveTree(join(bundle.data, saved.id), join(stage, saved.id), { portable });
    if (!matchesSaveTree(saved, copied)) {
      throw new Error('The backup files do not match the manifest.');
    }
    roots.push(saved);
  }
  return roots;
}
