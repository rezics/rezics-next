import { type MinecraftFolder, type ResolvedVersion, Version } from '@xmcl/core';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import { checkLocalDirectory, fileInfo, writeJson } from './storage.ts';

const ProfileId = v.pipe(v.string(), v.regex(/^[a-z\d][a-z\d._+-]{0,159}$/iu));
const ProfileIds = v.pipe(v.array(ProfileId), v.minLength(1), v.maxLength(2));
const MetadataPins = v.pipe(
  v.array(v.object({ id: ProfileId, sha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)) })),
  v.minLength(1),
  v.maxLength(2),
);
const metadataSizeLimit = 2 * 1024 * 1024;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export type MinecraftInstallation = {
  versionId: string;
  javaRuntime?: string;
  javaMajor?: number;
  launchMetadata?: v.InferOutput<typeof MetadataPins>;
  loaderOutputsSha256?: string;
};

async function metadataFile(file: string) {
  const entry = await fileInfo(file);
  if (!entry?.isFile() || entry.size > metadataSizeLimit) {
    throw new Error('A Minecraft launch profile is unavailable.');
  }
  return readFile(file);
}

function resolveProfiles(folder: MinecraftFolder, profiles: { id: string; json: string }[]) {
  const hierarchy = profiles.map(({ id, json }, index) => {
    const profile = Version.normalizeVersionJson(json, folder.root);
    if (profile.id !== id || profile.inheritsFrom !== profiles[index + 1]?.id) {
      throw new Error('Minecraft launch profiles do not match the prepared version.');
    }
    return profile;
  });
  return Version.resolve(folder, hierarchy);
}

export async function pinLaunchMetadata(folder: MinecraftFolder, version: ResolvedVersion) {
  const cache = join(folder.root, 'launch-metadata');
  await checkLocalDirectory(cache, 'Minecraft launch metadata');
  const profiles = [];
  for (const id of v.parse(ProfileIds, version.inheritances)) {
    const descriptor = JSON.parse((await metadataFile(folder.getVersionJson(id))).toString('utf8'));
    const json = JSON.stringify(descriptor);
    const sha256 = hash(json);
    const destination = join(cache, `${sha256}.json`);
    const cached = await metadataFile(destination).catch(() => undefined);
    if (!cached || hash(cached) !== sha256) await writeJson(destination, descriptor);
    profiles.push({ id, json, sha256 });
  }
  const launchMetadata = v.parse(MetadataPins, profiles);
  return { version: resolveProfiles(folder, profiles), launchMetadata };
}

export async function readLaunchVersion(folder: MinecraftFolder, installation: MinecraftInstallation) {
  if (installation.launchMetadata === undefined) return Version.parse(folder, installation.versionId);
  const pins = v.parse(MetadataPins, installation.launchMetadata);
  if (pins[0]?.id !== installation.versionId) throw new Error('Minecraft launch metadata does not match the instance.');
  const cache = join(folder.root, 'launch-metadata');
  await checkLocalDirectory(cache, 'Minecraft launch metadata');
  const profiles = await Promise.all(
    pins.map(async ({ id, sha256 }) => {
      const bytes = await metadataFile(join(cache, `${sha256}.json`));
      if (hash(bytes) !== sha256) throw new Error('A Minecraft launch profile is damaged.');
      return { id, json: bytes.toString('utf8') };
    }),
  );
  return resolveProfiles(folder, profiles);
}
