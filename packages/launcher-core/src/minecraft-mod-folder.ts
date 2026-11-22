import type { MinecraftLoader, MinecraftModFolder, MinecraftModFolderFile } from '@rezics/launcher-contract';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { link, lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { maxArtifactSize, readMinecraftMod } from './artifact.ts';
import { isPortableSaveName } from './saved-worlds.ts';
import { checkLocalDirectory, fileInfo, isMissing } from './storage.ts';

type Target = { instanceId: string; loader: Exclude<MinecraftLoader, 'vanilla'> };
type OwnedMods = { launcher: string[]; pack: string[] };
const disabledSuffix = '.disabled';
const staleFile = 'This mod file changed. Rescan Mods before changing it.';
const occupiedName = 'A file already uses the destination name in Mods.';

function archiveName(name: string) {
  return name.replace(/\.disabled$/iu, '');
}

function ownerFor(names: OwnedMods) {
  function key(name: string) {
    const archive = archiveName(name);
    return process.platform === 'win32' ? archive.toLowerCase() : archive;
  }
  const launcher = new Set(names.launcher.map(key));
  const pack = new Set(names.pack.map(key));
  return (name: string): MinecraftModFolderFile['owner'] => {
    const archive = key(name);
    return launcher.has(archive) ? 'launcher' : pack.has(archive) ? 'pack' : 'manual';
  };
}

async function modInfo(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function fileIdentity(info: BigIntStats) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
}

function fileRevision(target: Target, name: string, info: BigIntStats) {
  return createHash('sha256')
    .update(JSON.stringify([target.instanceId, target.loader, name, fileIdentity(info), info.ctimeNs.toString()]))
    .digest('hex');
}

export async function existingModFolder(game: string): Promise<string | null> {
  await checkLocalDirectory(game, 'Minecraft game');
  const path = join(game, 'mods');
  const folder = await fileInfo(path);
  if (!folder) return null;
  if (!folder.isDirectory()) throw new Error('The instance mods folder is unavailable or is a link.');
  return path;
}

export async function inspectModFolder(folder: string, target: Target, owned: OwnedMods): Promise<MinecraftModFolder> {
  const ownerOf = ownerFor(owned);
  await checkLocalDirectory(folder, 'instance mods');
  const entries = await readdir(folder, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const files: MinecraftModFolderFile[] = [];
  const declarations = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    const state = archiveState(name, target.loader);
    if (!state) continue;
    const owner = ownerOf(name);
    const path = join(folder, name);
    const info = await modInfo(path).catch(() => undefined);
    const metadata = await inspectArchive(path, target.loader, info);
    const revision =
      owner === 'manual' && info?.isFile() && info.ino !== 0n && toggleName(name, state, target.loader)
        ? fileRevision(target, name, info)
        : undefined;
    files.push({ name, owner, state, ...(revision && { revision }), ...metadata });
    if (state !== 'active' || metadata.status !== 'identified') continue;
    for (const id of metadata.ids) {
      const copies = declarations.get(id);
      if (copies) copies.push(name);
      else declarations.set(id, [name]);
    }
  }
  const duplicates = [...declarations].flatMap(([id, copies]) => (copies.length > 1 ? [{ id, files: copies }] : []));
  return { exists: true, files, duplicates };
}

export async function setManualModEnabled(
  folder: string,
  target: Target,
  owned: OwnedMods,
  name: string,
  enabled: boolean,
  revision: string,
) {
  const state = archiveState(name, target.loader);
  const nextName = state === (enabled ? 'disabled' : 'active') && toggleName(name, state, target.loader);
  if (!nextName) throw new Error('Choose an active or disabled JAR from this Mods folder.');
  if (ownerFor(owned)(name) !== 'manual') throw new Error('Use the package controls for managed mods.');
  await checkLocalDirectory(folder, 'instance mods');
  const source = join(folder, name);
  const destination = join(folder, nextName);
  const original = await modInfo(source);
  if (!original?.isFile() || original.ino === 0n || fileRevision(target, name, original) !== revision) {
    throw new Error(staleFile);
  }
  const identity = fileIdentity(original);
  const matches = (info: BigIntStats | undefined) => info?.isFile() && fileIdentity(info) === identity;
  const other = await modInfo(destination);
  if (other) {
    // A previous link may have been published before the source name could be removed.
    if (!matches(other)) throw new Error(occupiedName);
  } else {
    try {
      await link(source, destination);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new Error(occupiedName);
      }
      if (isMissing(error)) throw new Error(staleFile);
      throw new Error('Could not publish the new mod file name. Check write access or open the mods folder.');
    }
  }
  const [before, after] = await Promise.all([modInfo(source), modInfo(destination)]);
  if (!matches(before) || !matches(after)) throw new Error(staleFile);
  await unlink(source).catch(() => {
    throw new Error('Could not remove the previous mod file name. Rescan Mods and retry the change.');
  });
  return { name: nextName, enabled };
}

function toggleName(
  name: string,
  state: MinecraftModFolderFile['state'],
  loader: Target['loader'],
): string | undefined {
  const active = archiveName(name);
  const disabled = active + disabledSuffix;
  if (state === 'ignored' || archiveState(active, loader) !== 'active') return;
  if (!isPortableSaveName(name) || !isPortableSaveName(disabled)) return;
  return state === 'active' ? disabled : active;
}

function archiveState(name: string, loader: Target['loader']): MinecraftModFolderFile['state'] | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.jar' + disabledSuffix)) return 'disabled';
  if (!lower.endsWith('.jar')) return;
  if (loader === 'fabric' && (name.startsWith('.') || !name.endsWith('.jar'))) return 'ignored';
  return 'active';
}

async function inspectArchive(path: string, loader: Target['loader'], info: BigIntStats | undefined) {
  try {
    if (info?.isSymbolicLink()) return { status: 'linked' as const };
    if (info?.isFile() && info.size > 0n && info.size <= BigInt(maxArtifactSize)) {
      const { title, version, ids } = await readMinecraftMod(path, loader);
      return { status: 'identified' as const, title, version, ids };
    }
  } catch {
    // A broken or unreadable archive still belongs in the folder view.
  }
  return { status: 'unknown' as const };
}
