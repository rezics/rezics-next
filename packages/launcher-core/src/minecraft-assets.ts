import { checksum, type MinecraftFolder } from '@xmcl/core';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { isPortableSaveName } from './saved-worlds.ts';
import { checkLocalDirectory, fileInfo, readJson } from './storage.ts';

const AssetIndex = v.object({
  virtual: v.optional(v.boolean()),
  objects: v.record(
    v.string(),
    v.object({
      hash: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
      size: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    }),
  ),
});

type MinecraftAssetIndex = v.InferOutput<typeof AssetIndex>;

export async function readMinecraftAssetIndex(path: string) {
  return v.parse(AssetIndex, await readJson(path));
}

export function uniqueMinecraftAssets({ objects }: MinecraftAssetIndex) {
  return [...new Map(Object.entries(objects).map(([name, asset]) => [asset.hash, { name, ...asset }])).values()];
}

async function ensureDirectory(path: string) {
  await checkLocalDirectory(path, 'Minecraft virtual assets');
  await mkdir(path, { recursive: true });
}

async function materializeAsset(source: string, destination: string, hash: string, size: number) {
  const file = await fileInfo(destination);
  if (file?.isFile() && file.nlink === 1 && file.size === size && (await checksum(destination, 'sha1')) === hash) {
    return;
  }
  // Older builds hard-linked these files to the download cache. A separate file keeps the cache independent.
  const staged = join(dirname(destination), `.rezics-${randomUUID()}.tmp`);
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await rename(staged, destination);
  } finally {
    await rm(staged, { force: true });
  }
}

export async function materializeVirtualAssets(
  folder: MinecraftFolder,
  id: string,
  { objects }: MinecraftAssetIndex,
  signal?: AbortSignal,
) {
  if (!isPortableSaveName(id)) throw new Error('Invalid Minecraft virtual asset directory.');
  const names = new Set<string>();
  const entries = Object.entries(objects).map(([name, asset]) => {
    const parts = name.split('/');
    const folded = name.toLowerCase();
    if (!parts.every(isPortableSaveName) || names.has(folded)) {
      throw new Error('Invalid Minecraft virtual asset name.');
    }
    names.add(folded);
    return { parts, ...asset };
  });
  const assets = folder.getPath('assets');
  const virtual = join(assets, 'virtual');
  const root = join(virtual, id);
  for (const directory of [assets, virtual, root]) await ensureDirectory(directory);

  const directories = new Set<string>();
  for (const { parts } of entries) {
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      directory = join(directory, part);
      if (directories.has(directory)) continue;
      signal?.throwIfAborted();
      await ensureDirectory(directory);
      directories.add(directory);
    }
  }

  for (let start = 0; start < entries.length; start += 32) {
    signal?.throwIfAborted();
    const files = await Promise.allSettled(
      entries
        .slice(start, start + 32)
        .map(({ parts, hash, size }) => materializeAsset(folder.getAsset(hash), join(root, ...parts), hash, size)),
    );
    for (const result of files) if (result.status === 'rejected') throw result.reason;
  }
  signal?.throwIfAborted();
}
