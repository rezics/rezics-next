import {
  minecraftReleaseIdPattern,
  sameMinecraftSelection,
  type LauncherApi,
  type MinecraftCustomJava,
  type MinecraftJavaPolicy,
  type MinecraftSelection,
  type MinecraftWorldImportVersionRisk,
  type ModrinthPackInstallControl,
  type ModrinthPackPreview,
  type PackageInstallControl,
} from '@rezics/launcher-contract';
import { parseMinecraftUpgradeSelection } from '@rezics/launcher-core';
import { randomUUID } from 'node:crypto';
import type { PackDestination, WorldImportSource } from '../../shared/desktop';
import type { PluginDesktopCommand } from '../../shared/desktop-commands';
import type { PickOpenPath, PickSavePath, PluginRpcHandlers } from '../rpc-types';
import {
  archivedMinecraftRevision,
  copyMinecraftWorlds,
  copyWorldIds,
  exactWorldId,
  manualModChange,
  managedModEnabled,
  minecraftInstance,
  minecraftPreparationMode,
  minecraftSettings,
  minecraftUpgradeMode,
  modReviewRevision,
  optionalText,
  record,
  text,
  worldVersionConfirmation,
} from '../rpc-values';
import { inspectWorld } from './minecraft-world-automation';

type MinecraftPort = Pick<
  LauncherApi,
  | Extract<PluginDesktopCommand<'minecraft'>, keyof LauncherApi>
  | 'setMinecraftJava'
  | 'minecraftModFolder'
  | 'inspectModrinthPack'
  | 'stageOnlineModrinthPack'
  | 'migrateModrinthPack'
  | 'inspectMinecraftWorldFolder'
  | 'inspectMinecraftWorldArchive'
  | 'importMinecraftWorldFolder'
  | 'importMinecraftWorldArchive'
>;

type CancellableRequest = { token: string; controller: AbortController };
type PendingWorld = {
  token: string;
  instanceId: string;
  kind: WorldImportSource;
  source: string;
  digest: string;
  targetVersion: string;
  versionRisk: MinecraftWorldImportVersionRisk | undefined;
  busy: boolean;
};
type PackInstallation = CancellableRequest & { attemptId: string; cancellable: boolean };
type PendingPack = {
  token: string;
  source: string;
  digest: string;
  preview: ModrinthPackPreview;
  instanceId: string | undefined;
  java?: MinecraftCustomJava;
  release?: () => Promise<void>;
};

export function minecraftDesktop(
  core: MinecraftPort,
  pick: PickOpenPath,
  savePath: PickSavePath,
  openExternal: (url: string) => Promise<void>,
  openPath: (path: string) => Promise<string>,
  installPackage: (attemptId: string, work: (control: PackageInstallControl) => Promise<void>) => Promise<boolean>,
): PluginRpcHandlers<'minecraft'> {
  let pickedUpgradeJava: { instanceId: string; version: string; executable: string } | undefined;
  let packSelection: CancellableRequest | undefined;
  let pendingPack: PendingPack | undefined;
  let installingPack: PackInstallation | undefined;
  let pendingWorld: PendingWorld | undefined;
  let worldTransfer: CancellableRequest | undefined;

  async function runWorldTransfer<T>(attemptId: unknown, work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    if (worldTransfer) throw new Error('Wait for the current world transfer to finish.');
    const controller = new AbortController();
    const { signal } = controller;
    worldTransfer = { token: attemptId === undefined ? randomUUID() : text(attemptId, 64), controller };
    try {
      return await work(signal);
    } catch (error) {
      if (signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))) {
        return null;
      }
      throw error;
    } finally {
      worldTransfer = undefined;
    }
  }

  async function releasePack(pack: Pick<PendingPack, 'release'> | undefined) {
    if (pack?.release) await pack.release().catch(() => {});
  }

  async function clearPackPreview() {
    if (installingPack && installingPack.token === packSelection?.token) stopPackInstallation(installingPack);
    packSelection?.controller.abort();
    packSelection = undefined;
    const discarded = pendingPack;
    pendingPack = undefined;
    await releasePack(discarded);
  }

  function stopPackInstallation(installation: PackInstallation | undefined) {
    if (!installation?.cancellable) return false;
    installation.cancellable = false;
    installation.controller.abort(new Error('Modrinth pack installation cancelled.'));
    return true;
  }

  async function runPackInstallation<T>(
    token: string,
    attemptId: string,
    work: (control: ModrinthPackInstallControl) => Promise<T>,
  ): Promise<T | null> {
    if (installingPack) throw new Error('Wait for the current pack operation to finish.');
    const installation = { token, attemptId, controller: new AbortController(), cancellable: true };
    const { signal } = installation.controller;
    installingPack = installation;
    try {
      return await work({
        signal,
        beginCommit: () => {
          installation.cancellable = false;
        },
      });
    } catch (error) {
      if (signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))) {
        return null;
      }
      throw error;
    } finally {
      installingPack = undefined;
    }
  }

  async function nextPackPreview() {
    const cleanup = clearPackPreview();
    const request = { token: randomUUID(), controller: new AbortController() };
    packSelection = request;
    await cleanup;
    return request;
  }

  function pickJava(title: string) {
    return pick({
      title,
      properties: ['openFile'],
      ...(process.platform === 'win32' && { filters: [{ name: 'Java executable', extensions: ['exe'] }] }),
    });
  }

  function reviewedPack(token: string) {
    if (!pendingPack || pendingPack.token !== token) throw new Error('Choose and preview the modpack again.');
    return pendingPack;
  }

  async function upgradeJava(
    instanceId: string,
    selection: MinecraftSelection,
    value: unknown,
  ): Promise<MinecraftJavaPolicy | undefined> {
    if (value === undefined) return undefined;
    const { kind, executable: file } = record(value);
    if (kind === 'managed') return { kind: 'managed' };
    if (kind === 'custom') {
      const executable = text(file, 32_768);
      if (
        pickedUpgradeJava?.instanceId === instanceId &&
        pickedUpgradeJava.version === selection.version &&
        pickedUpgradeJava.executable === executable
      ) {
        return { kind, executable };
      }
      const attempt = await core.readMinecraftPreparation(instanceId);
      if (
        attempt?.mode === 'upgrade' &&
        (attempt.state === 'failed' || attempt.state === 'cancelled') &&
        attempt.java?.kind === kind &&
        attempt.java.executable === executable &&
        attempt.selection &&
        sameMinecraftSelection(attempt.selection, selection)
      ) {
        return { kind, executable };
      }
    }
    throw new Error('Choose Java for the selected version with the launcher file picker.');
  }

  return {
    listMinecraftVersions: () => core.listMinecraftVersions(),
    listFabricVersions: (version) => core.listFabricVersions(text(version, 32)),
    listForgeVersions: (version) => core.listForgeVersions(text(version, 32)),
    listNeoForgeVersions: (version) => core.listNeoForgeVersions(text(version, 32)),
    createMinecraft: (value) => core.createMinecraft(minecraftInstance(value)),
    renameMinecraft: (id, name) => core.renameMinecraft(text(id), text(name, 120)),
    duplicateMinecraft: (id, name, copyWorlds) =>
      core.duplicateMinecraft(text(id), text(name, 120), copyMinecraftWorlds(copyWorlds)),
    archiveMinecraft: (id) => core.archiveMinecraft(text(id)),
    listArchivedMinecraft: () => core.listArchivedMinecraft(),
    restoreArchivedMinecraft: (id) => core.restoreArchivedMinecraft(text(id)),
    deleteArchivedMinecraft: (id, revision) =>
      core.deleteArchivedMinecraft(text(id), archivedMinecraftRevision(revision)),
    setMinecraftSettings: (id, value) => core.setMinecraftSettings(text(id), minecraftSettings(value)),
    async chooseMinecraftJava(id) {
      const instanceId = text(id);
      const file = await pickJava('Choose a Java executable');
      return file ? core.setMinecraftJava(instanceId, file) : null;
    },
    checkMinecraftJava: (id) => core.checkMinecraftJava(text(id)),
    async chooseMinecraftUpgradeJava(id, targetVersion) {
      const instanceId = text(id);
      const version = text(targetVersion, 32);
      if (!minecraftReleaseIdPattern.test(version)) throw new Error('Choose an exact Minecraft release.');
      const executable = await pickJava(`Choose Java for Minecraft ${version}`);
      if (!executable) return null;
      pickedUpgradeJava = { instanceId, version, executable };
      return { kind: 'custom', executable };
    },
    async previewModrinthPack(id) {
      const instanceId = optionalText(id);
      const request = await nextPackPreview();
      const source = await pick({
        title: 'Choose a Modrinth modpack',
        properties: ['openFile'],
        filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }],
      });
      if (!source || packSelection !== request) return null;
      try {
        const { digest, preview } = await core.inspectModrinthPack(source, request.controller.signal);
        if (packSelection !== request) return null;
        pendingPack = { token: request.token, source, digest, preview, instanceId };
        return { token: request.token, preview };
      } catch (error) {
        if (request.controller.signal.aborted) return null;
        throw error;
      }
    },
    searchModrinthPacks: (query, cursor) => core.searchModrinthPacks(text(query, 120, true), optionalText(cursor, 256)),
    listModrinthPackVersions: (project, cursor) =>
      core.listModrinthPackVersions(text(project, 120), optionalText(cursor, 256)),
    async previewOnlineModrinthPack(project, version, id) {
      const projectId = text(project, 120);
      const versionId = text(version, 120);
      const instanceId = optionalText(id);
      const request = await nextPackPreview();
      try {
        const staged = await core.stageOnlineModrinthPack(projectId, versionId, request.controller.signal);
        if (packSelection !== request) {
          await releasePack(staged);
          return null;
        }
        pendingPack = { ...staged, token: request.token, instanceId };
        return { token: request.token, preview: staged.preview };
      } catch (error) {
        if (request.controller.signal.aborted) return null;
        throw error;
      }
    },
    cancelModrinthPackPreview: clearPackPreview,
    async chooseModrinthPackJava(value) {
      const pack = reviewedPack(text(value, 64));
      const executable = await pickJava(`Choose Java for Minecraft ${pack.preview.selection.version}`);
      if (!executable || pendingPack !== pack) return null;
      const java = { kind: 'custom', executable } as const;
      pack.java = java;
      return java;
    },
    async importModrinthPack(value, destinationValue, attemptValue, useSelectedJava) {
      const token = text(value, 64);
      const destination = packDestination(destinationValue);
      const attemptId = optionalText(attemptValue, 64) ?? randomUUID();
      const selectedPack = reviewedPack(token);
      if (useSelectedJava !== undefined && typeof useSelectedJava !== 'boolean') {
        throw new Error('Choose a Java runtime from the pack preview.');
      }
      const java = useSelectedJava ? selectedPack.java : undefined;
      if (useSelectedJava && !java) throw new Error('Choose a Java executable from this pack preview.');
      const { source, digest, preview, instanceId } = selectedPack;
      if (typeof destination === 'object' && !instanceId) {
        throw new Error('Preview the pack from the instance whose worlds you want to copy.');
      }
      return runPackInstallation(token, attemptId, async (control) => {
        pendingPack = undefined;
        try {
          const instance =
            typeof destination === 'object' && instanceId
              ? await core.migrateModrinthPack(
                  source,
                  digest,
                  preview,
                  instanceId,
                  destination.worldIds,
                  control,
                  destination.worldVersionConfirmation,
                  java,
                )
              : await core.importModrinthPack(
                  source,
                  digest,
                  preview,
                  destination ? undefined : instanceId,
                  control,
                  java,
                );
          if (packSelection?.token === token) packSelection = undefined;
          await releasePack(selectedPack);
          return instance;
        } catch (error) {
          if (packSelection?.token === token) pendingPack = selectedPack;
          else await releasePack(selectedPack);
          throw error;
        }
      });
    },
    async cancelModrinthPackInstallation(value, attemptValue) {
      const token = text(value, 64);
      const attemptId = text(attemptValue, 64);
      return installingPack?.token === token && installingPack.attemptId === attemptId
        ? stopPackInstallation(installingPack)
        : false;
    },
    currentModrinthPack: (id) => core.currentModrinthPack(text(id)),
    repairModrinthPack(value, attempt) {
      const id = text(value);
      return runPackInstallation(id, text(attempt, 64), (control) => core.repairModrinthPack(id, control));
    },
    async exportModrinthPack(id) {
      const instanceId = text(id);
      const destination = await savePath({
        title: 'Export the Modrinth modpack',
        defaultPath: 'minecraft.mrpack',
        filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }],
      });
      if (!destination) return false;
      await core.exportModrinthPack(instanceId, destination);
      return true;
    },
    prepareMinecraft: (id) => core.prepareMinecraft(text(id)),
    startMinecraftPreparation: (id, mode) => core.startMinecraftPreparation(text(id), minecraftPreparationMode(mode)),
    readMinecraftInPlaceUpgradeBlocker: (id, version) =>
      core.readMinecraftInPlaceUpgradeBlocker(text(id), text(version)),
    previewMinecraftWorldCopy: (id, version, worldIds) =>
      core.previewMinecraftWorldCopy(
        text(id),
        text(version, 32),
        worldIds === undefined ? undefined : copyWorldIds(worldIds, true),
      ),
    async startMinecraftUpgrade(id, value, mode, worldIds, confirmation, java) {
      const instanceId = text(id);
      const selection = parseMinecraftUpgradeSelection(value);
      return core.startMinecraftUpgrade(
        instanceId,
        selection,
        minecraftUpgradeMode(mode),
        worldIds === undefined ? undefined : copyWorldIds(worldIds, true),
        worldVersionConfirmation(confirmation),
        await upgradeJava(instanceId, selection, java),
      );
    },
    readMinecraftPreparation: (id) => core.readMinecraftPreparation(text(id)),
    activeMinecraftPreparations: () => core.activeMinecraftPreparations(),
    readMinecraftPreparationActivity: () => core.readMinecraftPreparationActivity(),
    cancelMinecraftPreparation: (id, attemptId) =>
      core.cancelMinecraftPreparation(text(id), optionalText(attemptId, 64)),
    beginMinecraftSignIn: (accountId) => core.beginMinecraftSignIn(optionalText(accountId, 120)),
    readMinecraftSignIn: () => core.readMinecraftSignIn(),
    cancelMinecraftSignIn: () => core.cancelMinecraftSignIn(),
    async openMicrosoftSignIn() {
      const signIn = await core.readMinecraftSignIn();
      if (signIn.state !== 'waiting' || signIn.device.expiresAt <= Date.now()) {
        throw new Error('Start a new Microsoft sign-in.');
      }
      const target = new URL(signIn.device.url);
      const hosts = ['www.microsoft.com', 'microsoft.com', 'login.live.com', 'login.microsoftonline.com'];
      if (
        target.protocol !== 'https:' ||
        target.username ||
        target.password ||
        target.port ||
        !hosts.includes(target.hostname)
      ) {
        throw new Error('Microsoft returned an unexpected sign-in address.');
      }
      await openExternal(target.href);
    },
    minecraftAccount: () => core.minecraftAccount(),
    minecraftAccounts: () => core.minecraftAccounts(),
    selectMinecraftAccount: (id) => core.selectMinecraftAccount(text(id, 120)),
    forgetMinecraftAccount: (id) => core.forgetMinecraftAccount(text(id, 120)),
    signOutMinecraft: () => core.signOutMinecraft(),
    listMinecraftWorlds: (id) => core.listMinecraftWorlds(text(id)),
    async previewMinecraftWorld(id, kind, attemptId) {
      const instanceId = text(id);
      if (kind !== 'folder' && kind !== 'zip') throw new Error('Choose a world folder or ZIP.');
      return runWorldTransfer(attemptId, async (signal) => {
        const token = randomUUID();
        pendingWorld = undefined;
        const source = await pick(
          kind === 'folder'
            ? { title: 'Choose a Minecraft world folder', properties: ['openDirectory'] }
            : {
                title: 'Choose a Minecraft world ZIP',
                properties: ['openFile'],
                filters: [{ name: 'Minecraft world ZIP', extensions: ['zip'] }],
              },
        );
        if (!source) return null;
        const { world, digest, versionRisk, targetVersion } = await inspectWorld(
          core,
          { kind, path: source },
          instanceId,
          signal,
        );
        signal.throwIfAborted();
        pendingWorld = { token, instanceId, kind, source, digest, targetVersion, versionRisk, busy: false };
        return { token, world, ...(versionRisk && { versionRisk }) };
      });
    },
    async cancelMinecraftWorldTransfer(attemptId) {
      if (worldTransfer?.token === text(attemptId, 64)) {
        worldTransfer.controller.abort(new Error('World transfer cancelled.'));
      }
    },
    async discardMinecraftWorldPreview(value) {
      const token = text(value, 64);
      if (pendingWorld?.token === token && !pendingWorld.busy) {
        pendingWorld = undefined;
      }
    },
    async importMinecraftWorld(value, name, confirmation, attemptId) {
      const token = text(value, 64);
      const operation = pendingWorld;
      if (!operation || operation.token !== token || operation.busy)
        throw new Error('Open the world import preview again.');
      return runWorldTransfer(attemptId, async (signal) => {
        operation.busy = true;
        try {
          const importWorld =
            operation.kind === 'folder' ? core.importMinecraftWorldFolder : core.importMinecraftWorldArchive;
          const imported = await importWorld(
            operation.instanceId,
            operation.source,
            operation.digest,
            text(name, 120),
            confirmation === true ? operation.versionRisk : undefined,
            operation.targetVersion,
            signal,
          );
          if (pendingWorld === operation) pendingWorld = undefined;
          return imported;
        } finally {
          operation.busy = false;
        }
      });
    },
    async exportMinecraftWorldArchive(id, world, attemptId) {
      const instance = text(id);
      const worldId = exactWorldId(world);
      const exportName = worldId.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/gu, '-');
      return runWorldTransfer(attemptId, async (signal) => {
        const destination = await savePath({
          title: 'Export a Minecraft world ZIP',
          defaultPath: `${exportName}.zip`,
          filters: [{ name: 'Minecraft world ZIP', extensions: ['zip'] }],
        });
        signal.throwIfAborted();
        return destination === null ? null : core.exportMinecraftWorldArchive(instance, worldId, destination, signal);
      });
    },
    searchMods: (id, query) => core.searchMods(text(id), text(query, 120, true)),
    modVersions: (id, project) => core.modVersions(text(id), text(project)),
    previewModInstall: (id, version) => core.previewModInstall(text(id), text(version)),
    installMod: (id, version, revision, attempt) =>
      installPackage(text(attempt, 64), (control) =>
        core.installMod(text(id), text(version), modReviewRevision(revision, 'installation'), control),
      ),
    previewModState: (id, pkg, enabled) => core.previewModState(text(id), text(pkg), managedModEnabled(enabled)),
    applyModState: (id, pkg, enabled, revision) =>
      core.applyModState(text(id), text(pkg), managedModEnabled(enabled), modReviewRevision(revision, 'change')),
    readMinecraftModFolder: (id) => core.readMinecraftModFolder(text(id)),
    setMinecraftManualModEnabled(id, file, state, expected) {
      const { name, enabled, revision } = manualModChange({ name: file, enabled: state, revision: expected });
      return core.setMinecraftManualModEnabled(text(id), name, enabled, revision);
    },
    async openMinecraftModFolder(id) {
      const folder = await core.minecraftModFolder(text(id));
      if (!folder) throw new Error('This instance does not have a mods folder yet.');
      if (await openPath(folder)) throw new Error('Could not open the instance mods folder.');
    },
    async repairMod(id, pkg, fromFile) {
      const instance = text(id);
      const packageId = text(pkg);
      if (typeof fromFile !== 'boolean') throw new Error('Choose a mod repair source.');
      if (!fromFile) {
        await core.repairMod(instance, packageId);
        return true;
      }
      const file = await pick({
        title: 'Choose the original mod JAR',
        properties: ['openFile'],
        filters: [{ name: 'Minecraft JAR', extensions: ['jar'] }],
      });
      if (!file) return false;
      await core.repairMod(instance, packageId, file);
      return true;
    },
    async importMod(id) {
      const instance = text(id);
      const file = await pick({
        title: 'Import a Minecraft mod',
        properties: ['openFile'],
        filters: [{ name: 'Minecraft JAR', extensions: ['jar'] }],
      });
      if (!file) return false;
      await core.importMod(instance, file);
      return true;
    },
  };
}

function packDestination(value: unknown): PackDestination | undefined {
  if (value === undefined || value === 'new-instance') return value;
  const { kind, worldIds, worldVersionConfirmation: confirmation } = record(value);
  if (kind !== 'copy-worlds') throw new Error('Choose a destination for the pack.');
  const warning = worldVersionConfirmation(confirmation);
  return { kind, worldIds: copyWorldIds(worldIds, false), ...(warning && { worldVersionConfirmation: warning }) };
}
