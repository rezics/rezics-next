import {
  isEarlierMinecraftRelease,
  type MinecraftWorld,
  type MinecraftWorldVersionRisk,
  type SaveSelection,
} from '@rezics/launcher-contract';
import { Buffer } from 'node:buffer';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { readMinecraftLevelRelease } from './minecraft-level.ts';
import type { SaveRoot } from './saves.ts';
import { fileInfo } from './storage.ts';

export const minecraftWorldSaveRoot = 'world';
export const minecraftWorldsSaveRoot = 'worlds';

export async function newestMinecraftWorldVersion(roots: SaveRoot[], signal?: AbortSignal): Promise<string | null> {
  let newest: string | null = null;
  async function consider(world: string) {
    signal?.throwIfAborted();
    if (!(await fileInfo(world))?.isDirectory()) return;
    const release = await readMinecraftLevelRelease(join(world, 'level.dat'));
    if (release && (!newest || isEarlierMinecraftRelease(newest, release))) newest = release;
  }

  for (const root of roots) {
    signal?.throwIfAborted();
    if (root.id === minecraftWorldSaveRoot) await consider(root.path);
    if (root.id === minecraftWorldsSaveRoot && (await fileInfo(root.path))?.isDirectory()) {
      for await (const entry of await opendir(root.path)) {
        signal?.throwIfAborted();
        if (entry.isDirectory()) await consider(join(root.path, entry.name));
      }
    }
  }
  return newest;
}

export function minecraftWorldVersionRisk(worldVersion: string | null | undefined, targetVersion: string) {
  return worldVersion && isEarlierMinecraftRelease(targetVersion, worldVersion)
    ? { worldVersion, targetVersion }
    : null;
}

export async function minecraftWorldCopyRisk(
  game: string,
  targetVersion: string,
  worldIds?: readonly string[],
  signal?: AbortSignal,
) {
  if (worldIds?.length === 0) return null;
  const roots: SaveRoot[] = [];
  if (worldIds === undefined) {
    roots.push({ id: minecraftWorldsSaveRoot, path: (await checkedWorldsDirectory(game)).path });
  } else {
    for (const id of worldIds) {
      signal?.throwIfAborted();
      roots.push(await minecraftWorldRoot(game, { kind: 'world', id }));
    }
  }
  return minecraftWorldVersionRisk(await newestMinecraftWorldVersion(roots, signal), targetVersion);
}

export async function confirmMinecraftWorldCopy(
  game: string,
  targetVersion: string,
  confirmation?: MinecraftWorldVersionRisk,
  worldIds?: readonly string[],
  signal?: AbortSignal,
) {
  const risk = await minecraftWorldCopyRisk(game, targetVersion, worldIds, signal);
  if (risk && (confirmation?.worldVersion !== risk.worldVersion || confirmation.targetVersion !== risk.targetVersion)) {
    throw new Error('A selected world was saved in a newer Minecraft release. Review the world copy and confirm it.');
  }
}

const reservedName = /^(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

export function isPortableSaveName(name: string) {
  return (
    name.length > 0 &&
    Buffer.byteLength(name) <= 255 &&
    !/[<>:"/\\|?*\x00-\x1f\x7f]/u.test(name) &&
    !/[. ]$/u.test(name) &&
    !reservedName.test(name.split('.')[0]!.trimEnd())
  );
}

export async function checkedWorldsDirectory(gameDirectory: string) {
  const game = await fileInfo(gameDirectory);
  if (game && !game.isDirectory()) throw new Error('The Minecraft instance folder is unavailable or linked.');

  const path = join(gameDirectory, 'saves');
  const saves = await fileInfo(path);
  if (saves && !saves.isDirectory()) throw new Error('The Minecraft saves folder is unavailable or linked.');
  return { path, exists: Boolean(saves) };
}

export async function listMinecraftWorlds(gameDirectory: string): Promise<MinecraftWorld[]> {
  const { path, exists } = await checkedWorldsDirectory(gameDirectory);
  if (!exists) return [];
  const worlds: MinecraftWorld[] = [];
  const entries = await opendir(path);
  for await (const entry of entries) {
    if (!entry.isDirectory() || !isPortableSaveName(entry.name)) continue;
    const world = join(path, entry.name);
    if (!(await fileInfo(world))?.isDirectory()) continue;
    if ((await fileInfo(join(world, 'level.dat')))?.isFile()) worlds.push({ id: entry.name, name: entry.name });
  }
  return worlds.sort((left, right) => left.name.localeCompare(right.name));
}

export async function minecraftWorldRoot(
  gameDirectory: string,
  selection: SaveSelection,
  allowMissing = false,
): Promise<SaveRoot> {
  if (selection.kind !== 'world' || !isPortableSaveName(selection.id)) {
    throw new Error('Choose a valid Minecraft world.');
  }
  const { path } = await checkedWorldsDirectory(gameDirectory);
  const world = join(path, selection.id);
  const entry = await fileInfo(world);
  if (
    (entry && !entry.isDirectory()) ||
    (!allowMissing && (!entry || !(await fileInfo(join(world, 'level.dat')))?.isFile()))
  ) {
    throw new Error('The selected Minecraft world is unavailable or linked.');
  }
  return { id: minecraftWorldSaveRoot, path: world };
}
