import { minecraftLoaderVersion, type MinecraftSelection, type ModrinthPackPreview } from '@rezics/launcher-contract';
import { Buffer } from 'node:buffer';
import * as v from 'valibot';
import { isPortableSaveName } from '../saved-worlds.ts';

export const maxPackEntries = 4000;
export const maxPackArchive = 512 * 1024 * 1024;
export const maxPackOverride = 128 * 1024 * 1024;
export const maxPackDownload = 512 * 1024 * 1024;
export const maxPackDownloads = 4 * 1024 * 1024 * 1024;
export const maxPackIndex = 4 * 1024 * 1024;
export const packIndexName = 'modrinth.index.json';
const supportedRoots = new Set(['mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks']);
const windowsDevice = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;
const shortText = v.pipe(v.string(), v.minLength(1), v.maxLength(120), v.regex(/^[^\x00-\x1f\x7f]+$/u));
const sha1 = v.pipe(
  v.string(),
  v.regex(/^[a-f0-9]{40}$/iu),
  v.transform((hash) => hash.toLowerCase()),
);
export const sha512 = v.pipe(
  v.string(),
  v.regex(/^[a-f0-9]{128}$/iu),
  v.transform((hash) => hash.toLowerCase()),
);
const environment = v.picklist(['required', 'optional', 'unsupported']);
const gameVersion = v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d{0,3})(?:\.(?:0|[1-9]\d{0,3})){1,2}$/u));
const loaderVersion = v.pipe(v.string(), v.regex(/^\d[\da-z.+-]{0,63}$/iu));
const summaries = v.pipe(v.string(), v.maxLength(1000), v.regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/u));
const dependenciesSchema = v.strictObject({
  minecraft: gameVersion,
  'fabric-loader': v.optional(loaderVersion),
  forge: v.optional(loaderVersion),
  neoforge: v.optional(loaderVersion),
});
const packResourceSchema = v.object({
  path: v.string(),
  hashes: v.object({ sha1, sha512 }),
  env: v.optional(v.object({ client: environment, server: environment })),
  downloads: v.pipe(v.array(v.pipe(v.string(), v.maxLength(4096))), v.minLength(1), v.maxLength(5)),
  fileSize: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(maxPackDownload)),
});
const manifestSchema = v.object({
  formatVersion: v.literal(1),
  game: v.literal('minecraft'),
  versionId: shortText,
  name: shortText,
  summary: v.optional(summaries),
  files: v.pipe(v.array(packResourceSchema), v.maxLength(maxPackEntries)),
  dependencies: dependenciesSchema,
});
export const overrideSchema = v.object({
  path: v.string(),
  bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(maxPackOverride)),
  kind: v.picklist(['shared', 'client']),
});
export const packFingerprintSchema = v.object({
  bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(maxPackDownload)),
  sha512,
});
export const packFileSchema = v.object({ path: v.string(), ...packFingerprintSchema.entries });

export type PackManifest = v.InferOutput<typeof manifestSchema>;
export type PackResource = v.InferOutput<typeof packResourceSchema>;
export type PackOverride = v.InferOutput<typeof overrideSchema>;
export type PackFingerprint = v.InferOutput<typeof packFingerprintSchema>;
export type PackFile = v.InferOutput<typeof packFileSchema>;

export const pathKey = (path: string) => path.normalize('NFC').toUpperCase();

export function comparePaths(left: { path: string }, right: { path: string }) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function packPath(path: string) {
  const parts = path.split('/');
  const invalid = parts.some((part) => !isPortableSaveName(part) || windowsDevice.test(part.split('.')[0]!.trimEnd()));
  if (parts.length > 12 || Buffer.byteLength(path) > 240 || invalid) {
    throw new Error('The Modrinth pack contains an invalid or non-portable path.');
  }
  return parts;
}

export function requireClientPath(path: string, kind: 'download' | 'override' | 'owned', directory = false) {
  const parts = packPath(path);
  const [root] = parts;
  if (!directory && parts.length === 1 && path === 'options.txt' && kind !== 'download') return;
  if (!root || !supportedRoots.has(root))
    throw new Error(`The Modrinth pack uses an unsupported client path (${path}).`);
  const mod = root === 'mods';
  const archive = root === 'resourcepacks' || root === 'shaderpacks';
  if (directory) {
    if (parts.length === 1) return;
    if (!mod && kind !== 'download') return;
  }
  if (!directory && parts.length >= 2) {
    const file = parts.at(-1)!;
    if (mod && kind !== 'override' && parts.length === 2 && /\.jar$/iu.test(file) && !/^rezics-/iu.test(file)) return;
    if (!mod && kind !== 'download') {
      if (!/\.(?:jar|class|dll|exe|com|bat|cmd|scr|msi|ps1|sh|dylib|so|app|lnk|url)$/iu.test(file)) return;
    }
    if (archive && kind === 'download' && parts.length === 2 && /\.zip$/iu.test(file)) return;
  }
  throw new Error(`The Modrinth pack uses an unsupported client file (${path}).`);
}

export class PackPaths {
  private readonly names = new Map<string, { path: string; directory: boolean }>();

  add(path: string, isDirectory = false, allowExactFile = false) {
    let prefix = '';
    const parts = packPath(path);
    for (const [index, part] of parts.entries()) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const directory = isDirectory || index < parts.length - 1;
      const key = pathKey(prefix);
      const prior = this.names.get(key);
      if (prior && (prior.path !== prefix || prior.directory !== directory || (!directory && !allowExactFile))) {
        throw new Error(`The Modrinth pack contains conflicting paths (${prior.path}, ${prefix}).`);
      }
      if (!prior) this.names.set(key, { path: prefix, directory });
    }
  }
}

const manifestHosts = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const redirectHosts = new Set([
  ...manifestHosts,
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

export function packDownloadUrl(value: string | URL, redirect = false) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The Modrinth pack has an invalid download address.');
  }
  if (
    url.protocol !== 'https:' ||
    url.href.length > 4096 ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !(redirect ? redirectHosts : manifestHosts).has(url.hostname)
  ) {
    throw new Error('The Modrinth pack uses a download source outside the approved hosts.');
  }
  return url;
}

export function selectMinecraft(manifest: PackManifest): MinecraftSelection {
  const {
    minecraft: version,
    'fabric-loader': fabricVersion,
    forge: forgeVersion,
    neoforge: neoForgeVersion,
  } = manifest.dependencies;
  if (neoForgeVersion) return { version, loader: 'neoforge', neoForgeVersion };
  if (forgeVersion) return { version, loader: 'forge', forgeVersion };
  if (fabricVersion) return { version, loader: 'fabric', fabricVersion };
  return { version, loader: 'vanilla' };
}

export function matchesSelection(left: MinecraftSelection, right: MinecraftSelection) {
  return (
    left.version === right.version &&
    left.loader === right.loader &&
    minecraftLoaderVersion(left) === minecraftLoaderVersion(right)
  );
}

export function parsePackManifest(value: unknown): PackManifest {
  const result = v.safeParse(manifestSchema, value);
  if (!result.success || !result.output.name.trim() || !result.output.versionId.trim()) {
    throw new Error('The Modrinth pack index is invalid or requires an unsupported game or loader.');
  }
  const manifest = result.output;
  if (Object.values(manifest.dependencies).filter((version) => version !== undefined).length > 2) {
    throw new Error('The Modrinth pack must select a single exact loader version.');
  }
  const paths = new PackPaths();
  let bytes = 0;
  for (const resource of manifest.files) {
    paths.add(resource.path);
    requireClientPath(resource.path, 'download');
    resource.downloads = resource.downloads.map((url) => packDownloadUrl(url).href);
    if (clientSupport(resource) === 'required') bytes += resource.fileSize;
    if (bytes > maxPackDownloads) throw new Error('The Modrinth pack requires too much download space.');
  }
  manifest.files.sort(comparePaths);
  if (Buffer.byteLength(JSON.stringify(manifest)) >= maxPackIndex) {
    throw new Error('The normalized Modrinth pack index is too large.');
  }
  return manifest;
}

export function clientSupport(resource: PackResource) {
  return resource.env?.client ?? 'required';
}

export function requiredResources(manifest: PackManifest) {
  return manifest.files.filter((resource) => clientSupport(resource) === 'required');
}

export function packPreview(manifest: PackManifest, overrides: PackOverride[]): ModrinthPackPreview {
  return {
    name: manifest.name,
    versionId: manifest.versionId,
    ...(manifest.summary !== undefined && { summary: manifest.summary }),
    selection: selectMinecraft(manifest),
    files: manifest.files.map((file) => ({ path: file.path, bytes: file.fileSize, client: clientSupport(file) })),
    overrides: overrides.map(({ path, bytes, kind }) => ({ path, bytes, kind })),
  };
}

export function packFingerprintEqual(left: PackFingerprint | null, right: PackFingerprint | null) {
  return left?.bytes === right?.bytes && left?.sha512 === right?.sha512;
}
