import { maxMinecraftWorldSelection } from '@rezics/launcher-contract';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isPortableSaveName, listMinecraftWorlds, minecraftWorldRoot } from './saved-worlds.ts';
import { fileInfo, isMissing, readJson, reclaimLocalTree } from './storage.ts';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const generatedInstanceId = /^game-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const fileFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const gameTransient = new Set(['logs', 'crash-reports', 'debug', '.cache', '.fabric', '.mixin.out', 'backups']);

export type MigrationWorld = { id: string; path: string; device: bigint; inode: bigint };

export async function instanceFolder(path: string, create = false) {
  const info = await fileInfo(path);
  if (info && !info.isDirectory()) throw new Error('A Launcher instance folder is unavailable or linked.');
  if (!info && create) await mkdir(path, { recursive: true });
  return Boolean(info) || create;
}

export async function reclaimInstanceStages(path: string) {
  if (!(await fileInfo(path))?.isDirectory()) return;
  const directory = await opendir(path);
  for await (const entry of directory) {
    if (entry.isDirectory() && generatedInstanceId.test(entry.name)) {
      await reclaimLocalTree(join(path, entry.name)).catch(() => {});
    }
  }
}

type Filter = (name: string, depth: number) => boolean;
type CopyOptions = { accept?: Filter; signal?: AbortSignal; requireSafeContent?: true };

function copyableEntry(name: string) {
  const key = name.toLowerCase();
  return key !== 'session.lock' && !key.startsWith('.rezics-restore-');
}

async function copyTree(source: string, target: string, device: number, options: CopyOptions = {}, depth = 0) {
  const { accept, signal, requireSafeContent } = options;
  signal?.throwIfAborted();
  const info = await fileInfo(source);
  if (!info || info.dev !== device || (!info.isDirectory() && !info.isFile())) {
    if (requireSafeContent) throw new Error('A Minecraft world contains a link, special file or mounted folder.');
    return;
  }
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    const entries = await opendir(source);
    for await (const entry of entries) {
      if ((requireSafeContent || entry.isFile() || entry.isDirectory()) && (!accept || accept(entry.name, depth))) {
        await copyTree(join(source, entry.name), join(target, entry.name), device, options, depth + 1);
      }
    }
    return;
  }
  const handle = await open(source, fileFlags);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || info.ino !== actual.ino || info.dev !== actual.dev) {
      throw new Error('A file changed while Launcher was copying the instance.');
    }
    await mkdir(dirname(target), { recursive: true });
    await pipeline(handle.createReadStream(), createWriteStream(target, { flags: 'wx', mode: info.mode & 0o777 }), {
      ...(signal && { signal }),
    });
  } finally {
    await handle.close();
  }
}

export async function copyMinecraftFiles(source: string, destination: string, copyWorlds: boolean) {
  const home = await fileInfo(source);
  if (!home?.isDirectory()) throw new Error('The original Minecraft instance folder is unavailable.');
  const game = join(source, 'game');
  if ((await fileInfo(game))?.isDirectory()) {
    await copyTree(game, join(destination, 'game'), home.dev, {
      accept(name, depth) {
        const key = name.toLowerCase();
        return copyableEntry(name) && (depth > 0 || (!gameTransient.has(key) && (copyWorlds || key !== 'saves')));
      },
    });
  }

  const installed = join(source, 'installed-mods');
  const installedStore = await fileInfo(installed);
  if (installedStore?.isDirectory() && installedStore.dev === home.dev) {
    const ledger = join(installed, 'installed.json');
    if ((await fileInfo(ledger))?.isFile()) {
      await copyTree(ledger, join(destination, 'installed-mods', 'installed.json'), home.dev);
    }
  }

  const packLedger = join(source, 'modrinth-pack.json');
  const packMetadata = await fileInfo(packLedger);
  if (!packMetadata?.isFile() || packMetadata.dev !== home.dev) return;
  const ledger = await readJson<{ transaction?: string }>(packLedger);
  const retained = join(source, 'modrinth-pack-content');
  const retainedFolder = await fileInfo(retained);
  const id = ledger?.transaction;
  if (typeof id !== 'string' || !uuid.test(id) || !retainedFolder?.isDirectory() || retainedFolder.dev !== home.dev) {
    throw new Error('The original instance’s modpack history could not be copied.');
  }
  const generation = join(retained, id);
  const content = await fileInfo(generation);
  if (!content?.isDirectory() || content.dev !== home.dev) {
    throw new Error('The original instance’s modpack history could not be copied.');
  }
  await copyTree(packLedger, join(destination, 'modrinth-pack.json'), home.dev);
  await copyTree(generation, join(destination, 'modrinth-pack-content', id), home.dev);
}

export async function copyMinecraftUpgradeWorlds(source: string, destination: string, signal: AbortSignal) {
  const home = await fileInfo(source);
  if (!home?.isDirectory()) throw new Error('The original Minecraft instance folder is unavailable.');
  const game = join(source, 'game');
  if (!(await instanceFolder(game))) return;
  const saves = join(game, 'saves');
  if (!(await instanceFolder(saves))) return;
  await copyTree(saves, join(destination, 'game', 'saves'), home.dev, {
    accept: copyableEntry,
    requireSafeContent: true,
    signal,
  });
}

export function validateMinecraftWorldIds(worldIds: readonly string[], allowEmpty = false) {
  if (
    !Array.isArray(worldIds) ||
    (!allowEmpty && worldIds.length === 0) ||
    worldIds.length > maxMinecraftWorldSelection
  ) {
    throw new Error(
      allowEmpty
        ? `Choose up to ${maxMinecraftWorldSelection} Minecraft worlds to copy.`
        : `Choose between 1 and ${maxMinecraftWorldSelection} Minecraft worlds to migrate.`,
    );
  }
  const names = new Set<string>();
  for (const id of worldIds) {
    if (typeof id !== 'string' || !isPortableSaveName(id)) throw new Error('Choose a valid Minecraft world.');
    const name = id.normalize('NFC').toUpperCase();
    if (names.has(name)) throw new Error('The selected Minecraft worlds have conflicting names.');
    names.add(name);
  }
}

async function migrationWorld(game: string, id: string, device: bigint): Promise<MigrationWorld> {
  const { path } = await minecraftWorldRoot(game, { kind: 'world', id });
  const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
    return undefined;
  });
  if (!info?.isDirectory() || info.dev !== device) {
    throw new Error('A selected Minecraft world is unavailable, linked or mounted.');
  }
  return { id, path, device: info.dev, inode: info.ino };
}

export async function selectMinecraftMigrationWorlds(source: string, worldIds: readonly string[]) {
  validateMinecraftWorldIds(worldIds);
  const ids = [...worldIds];
  const home = await lstat(source, { bigint: true });
  if (!home.isDirectory()) throw new Error('The original Minecraft instance folder is unavailable.');
  const game = join(source, 'game');
  const available = new Set((await listMinecraftWorlds(game)).map(({ id }) => id));
  if (ids.some((id) => !available.has(id))) {
    throw new Error('A selected Minecraft world is unavailable or linked. Open the world list again.');
  }
  const selected: MigrationWorld[] = [];
  for (const id of ids) selected.push(await migrationWorld(game, id, home.dev));
  return selected;
}

export async function copyMinecraftMigrationWorlds(
  source: string,
  targetGame: string,
  selected: MigrationWorld[],
  signal?: AbortSignal,
) {
  const home = await lstat(source, { bigint: true });
  if (!home.isDirectory()) throw new Error('The original Minecraft instance folder is unavailable.');
  const game = join(source, 'game');
  for (const world of selected) {
    signal?.throwIfAborted();
    const current = await migrationWorld(game, world.id, home.dev);
    if (current.device !== world.device || current.inode !== world.inode) {
      throw new Error('A selected Minecraft world changed. Open the world list again.');
    }
    const target = join(targetGame, 'saves', world.id);
    await copyTree(current.path, target, Number(home.dev), {
      accept: copyableEntry,
      requireSafeContent: true,
      ...(signal && { signal }),
    });
    if (!(await fileInfo(join(target, 'level.dat')))?.isFile()) {
      throw new Error('A selected Minecraft world no longer contains its level data.');
    }
  }
}
