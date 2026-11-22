import {
  defaultFabricVersion,
  defaultMinecraftVersion,
  isEarlierMinecraftRelease,
  minecraftReleaseIdPattern,
  type FabricLoaderVersion,
  type MinecraftInstanceInput,
  type MinecraftLoaderVersion,
  type MinecraftSelection,
  type MinecraftVersion,
} from '@rezics/launcher-contract';
import { LibraryInfo } from '@xmcl/core';
import { rcompare } from 'semver';
import * as v from 'valibot';
import { getJson } from './catalog.ts';

const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const fabricBase = 'https://meta.fabricmc.net/v2/versions/loader/';
const fabricLibraryRepositories = new Set(['https://maven.fabricmc.net/', 'https://libraries.minecraft.net/']);
const forgeMetadata = 'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json';
const neoForgeMetadata = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const firstModernForge = '1.18';
const firstNeoForge = '1.20.2';
const loaderId = /^\d[\da-z.+-]{0,63}$/iu;
const forgeId = /^(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}$/u;
const neoForgeBuild = /^(0|[1-9]\d{0,5})(-beta)?$/u;
const neoForgeId = /^(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2,3}(?:-beta)?$/u;
const ForgeCatalogue = v.record(v.string(), v.unknown());
const ForgeReleases = v.pipe(v.array(v.string()), v.maxLength(1024));
const NeoForgeCatalogue = v.object({ versions: v.pipe(v.array(v.string()), v.maxLength(8192)) });
const sha1Pattern = /^[a-f\d]{40}$/u;
const FabricProfile = v.looseObject({
  inheritsFrom: v.string(),
  mainClass: v.string(),
  libraries: v.array(
    v.looseObject({
      name: v.string(),
      url: v.optional(v.string(), 'https://libraries.minecraft.net/'),
      sha1: v.optional(v.pipe(v.string(), v.regex(sha1Pattern))),
      size: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
    }),
  ),
});
const MojangManifest = v.object({
  latest: v.optional(v.object({ release: v.string() })),
  versions: v.pipe(v.array(v.object({ id: v.string(), type: v.string(), url: v.string() })), v.maxLength(4096)),
});
const FabricVersions = v.pipe(
  v.array(v.object({ loader: v.object({ version: v.pipe(v.string(), v.regex(loaderId)), stable: v.boolean() }) })),
  v.maxLength(1024),
);

type GameMetadata = MinecraftVersion & { url: string };
export type ForgeSelection = Extract<MinecraftSelection, { loader: 'forge' | 'neoforge' }>;
export type LoaderInstaller = { url: string; sha1: string };
type CacheEntry<T> = { value: Promise<T>; expiresAt: number };

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string, load: () => Promise<T>) {
  const previous = cache.get(key);
  if (previous && Date.now() < previous.expiresAt) return previous.value;
  if (!previous && cache.size >= 8) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  const next = { value: load(), expiresAt: Date.now() + 5 * 60_000 };
  cache.set(key, next);
  // Retry an unavailable provider on the next request.
  void next.value.catch(() => {
    if (cache.get(key) === next) cache.delete(key);
  });
  return next.value;
}

function requireGameVersion(version: string) {
  if (typeof version !== 'string' || version !== version.trim() || !minecraftReleaseIdPattern.test(version)) {
    throw new Error('Select a stable Minecraft version.');
  }
  return version;
}

function neoForgeLine(game: string): string | undefined {
  if (isEarlierMinecraftRelease(game, firstNeoForge)) return;
  const [major, minor, patch = '0'] = game.split('.');
  if (major === '1') return `${minor}.${patch}.`;
  if (Number(major) >= 26) return `${major}.${minor}.${patch}.`;
}

function neoForgeRelease(line: string, id: string) {
  const match = id.startsWith(line) ? neoForgeBuild.exec(id.slice(line.length)) : null;
  if (match) return { id, stable: !match[2], build: Number(match[1]) };
}

function trustedGameMetadata(entry: GameMetadata) {
  const url = new URL(entry.url);
  if (
    url.protocol !== 'https:' ||
    !['piston-meta.mojang.com', 'launchermeta.mojang.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !url.pathname.startsWith('/v1/packages/')
  ) {
    throw new Error('Minecraft returned an unexpected release metadata address.');
  }
  return entry;
}

export class MinecraftVersions {
  private readonly games = new Map<string, CacheEntry<GameMetadata[]>>();
  private readonly fabric = new Map<string, CacheEntry<FabricLoaderVersion[]>>();
  private readonly forge = new Map<string, CacheEntry<v.InferOutput<typeof ForgeCatalogue>>>();
  private readonly neoForge = new Map<string, CacheEntry<v.InferOutput<typeof NeoForgeCatalogue>>>();

  constructor(private readonly fetcher: typeof fetch) {}

  resourceJson(address: string, signal?: AbortSignal) {
    const fetcher = (async (input, init) => {
      signal?.throwIfAborted();
      if (!signal) return this.fetcher(input, init);
      const requestSignal = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
      return this.fetcher(input, { ...init, signal: requestSignal });
    }) as typeof fetch;
    return getJson(fetcher, new URL(address));
  }

  private releaseEntries(signal?: AbortSignal) {
    const load = async () => {
      const manifest = v.parse(MojangManifest, await this.resourceJson(manifestUrl, signal));
      return manifest.versions
        .filter((entry) => entry.type === 'release' && minecraftReleaseIdPattern.test(entry.id))
        .map(({ id, url }) =>
          trustedGameMetadata({ id, url, ...(id === manifest.latest?.release && { latest: true }) }),
        );
    };
    return signal ? load() : cached(this.games, 'release', load);
  }

  async gameMetadata(version: string, signal?: AbortSignal) {
    requireGameVersion(version);
    const choice = (await this.releaseEntries(signal)).find((entry) => entry.id === version);
    if (!choice) throw new Error('The selected Minecraft release is unavailable.');
    return choice;
  }

  async listMinecraftVersions(): Promise<MinecraftVersion[]> {
    return (await this.releaseEntries()).map(({ id, latest }) => ({ id, ...(latest && { latest }) }));
  }

  async listFabricVersions(version: string): Promise<FabricLoaderVersion[]> {
    return (await this.loaderEntries(version)).map(({ id, stable }) => ({ id, stable }));
  }

  async fabricProfile(selection: Extract<MinecraftSelection, { loader: 'fabric' }>, signal: AbortSignal) {
    const { version, fabricVersion } = selection;
    const url = `${fabricBase}${encodeURIComponent(version)}/${encodeURIComponent(fabricVersion)}/profile/json`;
    const profile = v.parse(FabricProfile, await this.resourceJson(url, signal));
    if (profile.inheritsFrom !== version)
      throw new Error('Fabric returned a profile for a different Minecraft release.');

    const libraries = await Promise.all(
      profile.libraries.map(async (library) => {
        const { name, sha1, size } = library;
        const base = new URL(library.url);
        const { path } = LibraryInfo.resolve(name);
        if (
          !fabricLibraryRepositories.has(base.href) ||
          !path.split('/').every((part) => /^[a-z\d_][a-z\d_.+-]*$/iu.test(part) && !part.endsWith('.'))
        ) {
          throw new Error('Fabric returned an unexpected library location.');
        }
        const url = new URL(path, base).href;
        const checksum = sha1 ?? (await this.publishedSha1(url, 'Fabric library', signal));
        return { ...library, downloads: { artifact: { path, url, sha1: checksum, size: size ?? -1 } } };
      }),
    );
    return { ...profile, libraries };
  }

  async listForgeVersions(version: string, signal?: AbortSignal): Promise<MinecraftLoaderVersion[]> {
    if (isEarlierMinecraftRelease(requireGameVersion(version), firstModernForge)) return [];
    const load = async () => v.parse(ForgeCatalogue, await this.resourceJson(forgeMetadata, signal));
    const catalogue = await (signal ? load() : cached(this.forge, 'releases', load));
    const releases = v.parse(ForgeReleases, catalogue[version] ?? []);
    const prefix = `${version}-`;
    return [...new Set(releases)]
      .filter((id) => id.startsWith(prefix))
      .map((id) => id.slice(prefix.length))
      .filter((id) => forgeId.test(id))
      .sort(rcompare)
      .map((id) => ({ id, stable: true }));
  }

  async listNeoForgeVersions(version: string, signal?: AbortSignal): Promise<MinecraftLoaderVersion[]> {
    const line = neoForgeLine(requireGameVersion(version));
    if (!line) return [];
    const load = async () => v.parse(NeoForgeCatalogue, await this.resourceJson(neoForgeMetadata, signal));
    const { versions } = await (signal ? load() : cached(this.neoForge, 'releases', load));
    return [...new Set(versions)]
      .flatMap((id) => neoForgeRelease(line, id) ?? [])
      .sort((a, b) => b.build - a.build || Number(b.stable) - Number(a.stable))
      .map(({ id, stable }) => ({ id, stable }));
  }

  async loaderInstaller(selection: ForgeSelection, signal: AbortSignal): Promise<LoaderInstaller> {
    const version = requireGameVersion(selection.version);
    let url: string;
    if (selection.loader === 'neoforge') {
      const line = neoForgeLine(version);
      const id = selection.neoForgeVersion;
      if (!line || !neoForgeRelease(line, id))
        throw new Error('The selected loader is unavailable for this Minecraft release.');
      url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${id}/neoforge-${id}-installer.jar`;
    } else {
      if (isEarlierMinecraftRelease(version, firstModernForge) || !forgeId.test(selection.forgeVersion)) {
        throw new Error('The selected loader is unavailable for this Minecraft release.');
      }
      const id = `${version}-${selection.forgeVersion}`;
      url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${id}/forge-${id}-installer.jar`;
    }
    return { url, sha1: await this.publishedSha1(url, 'installer', signal) };
  }

  private async publishedSha1(url: string, artifact: 'installer' | 'Fabric library', signal: AbortSignal) {
    signal.throwIfAborted();
    const response = await this.fetcher(`${url}.sha1`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      redirect: 'error',
    });
    const reader = response.body?.getReader();
    try {
      if (!response.ok || !reader) throw new Error(`The loader provider did not supply the ${artifact} checksum.`);
      let contents = '';
      const invalid = `The loader provider supplied an invalid ${artifact} checksum.`;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        contents += Buffer.from(item.value).toString('ascii');
        if (contents.length > 128) throw new Error(invalid);
      }
      const sha1 = contents.trim().toLowerCase();
      if (!sha1Pattern.test(sha1)) throw new Error(invalid);
      return sha1;
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }

  private loaderEntries(version: string, signal?: AbortSignal): Promise<FabricLoaderVersion[]> {
    requireGameVersion(version);
    const load = async () => {
      const fetchVersions = (async (input, init) => {
        signal?.throwIfAborted();
        const requestSignal = signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
        const response = await this.fetcher(input, requestSignal ? { ...init, signal: requestSignal } : init);
        if (response.status !== 400) return response;
        // Fabric's exact-game endpoint reports an unsupported game as HTTP 400 with an empty array.
        await response.body?.cancel();
        return Response.json([]);
      }) as typeof fetch;
      const versions = await getJson(fetchVersions, new URL(version, fabricBase));
      return v.parse(FabricVersions, versions).map(({ loader }) => ({ id: loader.version, stable: loader.stable }));
    };
    return signal ? load() : cached(this.fabric, version, load);
  }

  async select(input: MinecraftInstanceInput, signal?: AbortSignal): Promise<MinecraftSelection> {
    signal?.throwIfAborted();
    const version = requireGameVersion(input.version === undefined ? defaultMinecraftVersion : input.version);
    if (
      (input.loader !== 'fabric' && input.fabricVersion !== undefined) ||
      (input.loader !== 'forge' && input.forgeVersion !== undefined) ||
      (input.loader !== 'neoforge' && input.neoForgeVersion !== undefined)
    ) {
      if (input.loader === 'vanilla' && input.fabricVersion !== undefined) {
        throw new Error('Vanilla instances do not use a Fabric loader.');
      }
      throw new Error('Select a version for the chosen Minecraft loader.');
    }
    if (input.loader === 'vanilla') {
      if (version !== defaultMinecraftVersion) await this.gameMetadata(version, signal);
      return { version, loader: 'vanilla' };
    }
    if (input.loader === 'forge' || input.loader === 'neoforge') {
      const isForge = input.loader === 'forge';
      const requested = isForge ? input.forgeVersion : input.neoForgeVersion;
      const label = isForge ? 'Forge' : 'NeoForge';
      if (
        requested !== undefined &&
        (typeof requested !== 'string' || !(isForge ? forgeId : neoForgeId).test(requested))
      ) {
        throw new Error(`Select a valid ${label} loader version.`);
      }
      const available = await (isForge
        ? this.listForgeVersions(version, signal)
        : this.listNeoForgeVersions(version, signal));
      const selected = requested
        ? available.find(({ id }) => id === requested)
        : available.find(({ stable }) => stable);
      if (!selected) throw new Error(`The selected Minecraft release does not have this ${label} loader.`);
      if (version !== defaultMinecraftVersion) await this.gameMetadata(version, signal);
      return isForge
        ? { version, loader: 'forge', forgeVersion: selected.id }
        : { version, loader: 'neoforge', neoForgeVersion: selected.id };
    }
    if (input.loader !== 'fabric') throw new Error('Unsupported Minecraft loader.');

    const requested = input.fabricVersion;
    if (requested !== undefined && (typeof requested !== 'string' || !loaderId.test(requested))) {
      throw new Error('Select a valid Fabric loader version.');
    }
    if (version === defaultMinecraftVersion && (requested === undefined || requested === defaultFabricVersion)) {
      return { version, loader: 'fabric', fabricVersion: defaultFabricVersion };
    }
    if (version !== defaultMinecraftVersion) await this.gameMetadata(version, signal);
    const available = await this.loaderEntries(version, signal);
    const selected = requested ? available.find(({ id }) => id === requested) : available.find(({ stable }) => stable);
    if (!selected) throw new Error('The selected Minecraft release does not have this Fabric loader.');
    return { version, loader: 'fabric', fabricVersion: selected.id };
  }
}
