import { minecraftPlugin } from '@rezics/launcher-contract';
import { join } from 'node:path';
import type { InstalledStore } from '../installed.ts';
import { MinecraftAuth, type SecretStorage } from '../minecraft-auth.ts';
import { MinecraftVersions } from '../minecraft-versions.ts';
import { Minecraft } from '../minecraft.ts';
import type { MinecraftModTarget } from '../modrinth.ts';
import type { ModrinthRequests } from '../modrinth-requests.ts';
import type { Packages } from '../packages.ts';
import { ModrinthPackProvider } from './modrinth-pack-provider.ts';
import { ModrinthPacks } from './modrinth-pack.ts';

export type MinecraftPluginOptions = {
  dataDir: string;
  modrinth: ModrinthRequests;
  packages: Pick<Packages, 'previewModrinth' | 'installModrinth' | 'importLocal' | 'repairMod'> & {
    readonly modrinth: Pick<Packages['modrinth'], 'search' | 'list'>;
  };
  minecraftClientId?: string | undefined;
  secretStorage?: SecretStorage | undefined;
  fetch?: typeof fetch | undefined;
};

export function createMinecraftPlugin(options: MinecraftPluginOptions) {
  const auth = new MinecraftAuth(
    options.minecraftClientId,
    join(options.dataDir, 'minecraft-account.json'),
    options.secretStorage,
    options.fetch,
  );
  const versions = new MinecraftVersions(options.fetch ?? fetch);
  const game = new Minecraft(options.dataDir, auth, versions);
  const { packages } = options;
  const mods = {
    search: (query: string, target: MinecraftModTarget) => packages.modrinth.search(query, target),
    versions: (projectId: string, target: MinecraftModTarget) => packages.modrinth.list(projectId, target),
    preview: packages.previewModrinth.bind(packages),
    install: packages.installModrinth.bind(packages),
    importLocal: (store: InstalledStore, file: string, target: MinecraftModTarget) =>
      packages.importLocal(store, file, target),
    repair: (store: InstalledStore, packageId: string, target: MinecraftModTarget, file?: string) =>
      packages.repairMod(store, packageId, target, file),
  };
  const packs = new ModrinthPacks(options.modrinth.fetch);
  const packProvider = new ModrinthPackProvider(options.dataDir, options.modrinth, packs);
  void packProvider.recover().catch(() => {});
  return { manifest: minecraftPlugin, auth, versions, game, mods, packs, packProvider };
}
