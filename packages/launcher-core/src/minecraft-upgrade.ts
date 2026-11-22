import { minecraftReleaseIdPattern, type MinecraftSelection } from '@rezics/launcher-contract';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import { checkLocalDirectory, fileInfo } from './storage.ts';

const version = v.pipe(v.string(), v.regex(minecraftReleaseIdPattern));
const build = v.pipe(v.string(), v.regex(/^\d[\da-z.+-]{0,63}$/iu));
const exactSelection = v.variant('loader', [
  v.object({ loader: v.literal('vanilla'), version }),
  v.object({ loader: v.literal('fabric'), version, fabricVersion: build }),
  v.object({ loader: v.literal('forge'), version, forgeVersion: build }),
  v.object({ loader: v.literal('neoforge'), version, neoForgeVersion: build }),
]);

export function parseMinecraftUpgradeSelection(input: unknown): MinecraftSelection {
  const selection = v.safeParse(exactSelection, input);
  if (!selection.success) throw new Error('Choose an exact Minecraft release and loader version.');
  return selection.output;
}

export async function hasUnmanagedMinecraftMods(game: string, signal?: AbortSignal) {
  await checkLocalDirectory(game, 'Minecraft game');
  const mods = join(game, 'mods');
  const folder = await fileInfo(mods);
  if (!folder) return false;
  if (!folder.isDirectory()) return true;
  return containsMod(mods, folder.dev, signal);
}

async function containsMod(path: string, device: number, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const entries = await opendir(path);
  for await (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.isDirectory()) {
      const child = join(path, entry.name);
      const current = await fileInfo(child);
      if (!current?.isDirectory() || current.dev !== device || (await containsMod(child, device, signal))) return true;
    } else if (!entry.isFile() || /\.(?:jar|zip)(?:\.disabled)?$/iu.test(entry.name)) return true;
  }
  return false;
}
