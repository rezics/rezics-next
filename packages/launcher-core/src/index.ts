import {
  isDestinationId,
  isEarlierMinecraftRelease,
  minecraftInPlaceUpgradeMessages,
  minecraftLoaderVersion,
  minecraftMemoryMiB,
  minecraftReleaseIdPattern,
  sameMinecraftSelection,
  type AutomaticBackupStatus,
  type CatalogInstallPreview,
  type CatalogInstallReview,
  type DestinationId,
  type LauncherApi,
  type InstalledOverlayExtension,
  type MinecraftInPlaceUpgradeBlocker,
  type MinecraftPreparation,
  type MinecraftSettings,
  type ModrinthPackInstallControl,
  type ModrinthPackPreview,
  type OverlayPanel,
  type Session,
  type SaveSelection,
  type Snapshot,
  type ReleaseRef,
  type VisualNovelInstallation,
  type VisualNovelSettingsPatch,
  type VisualNovelSettingsResult,
} from '@rezics/launcher-contract';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  copyMinecraftMigrationWorlds,
  selectMinecraftMigrationWorlds,
  validateMinecraftWorldIds,
  type MigrationWorld,
} from './instance-files.ts';
import { InstalledStore, overlayPanelIssue, type Installed } from './installed.ts';
import {
  Instances,
  instanceView,
  parseSubjectId,
  pathOverlaps,
  type MinecraftInstance,
  type StoredInstance,
} from './instances.ts';
import { LaunchFailure, launchIssues, safeLaunchFailure, visualNovelExecutableIssue } from './launch-issues.ts';
import type { SecretStorage } from './minecraft-auth.ts';
import { existingModFolder, inspectModFolder, setManualModEnabled } from './minecraft-mod-folder.ts';
import { hasUnmanagedMinecraftMods, parseMinecraftUpgradeSelection } from './minecraft-upgrade.ts';
import type { MinecraftModTarget } from './modrinth.ts';
import { ModrinthRequests } from './modrinth-requests.ts';
import { overlayExtensionRevision, overlayExtensionViews, Packages, selectOverlayPanels } from './packages.ts';
import { createRezicsLibraryReader } from './rezics-library.ts';
import { createBuiltinPlugins, prepareGameSession } from './plugins/builtin-plugins.ts';
import { createMinecraftPreparation, type MinecraftPreparationJob } from './plugins/minecraft-preparation.ts';
import { visualNovelSettingsRevision } from './plugins/visual-novel-plugin.ts';
import {
  confirmMinecraftWorldCopy,
  listMinecraftWorlds,
  minecraftWorldCopyRisk,
  minecraftWorldRoot,
  minecraftWorldVersionRisk,
} from './saved-worlds.ts';
import {
  checkMinecraftWorldImportSource,
  exportMinecraftWorldArchive,
  importMinecraftWorldArchive,
  importMinecraftWorldFolder,
  inspectMinecraftWorldArchive,
  inspectMinecraftWorldFolder,
  suggestMinecraftWorldImportName,
} from './world-transfer.ts';
import { NoSaveFolderError, Saves, type SaveRoot } from './saves.ts';
import { checkLocalDirectory, fileInfo, humanText, Locks } from './storage.ts';
import type { LinuxDirectoryRename } from './directory-move.ts';

export type LauncherOptions = {
  dataDir: string;
  catalogUrl: string;
  webUrl: string;
  launcherVersion: string;
  minecraftClientId?: string;
  readRezicsLibraryToken?: (signal?: AbortSignal) => string | undefined | Promise<string | undefined>;
  linuxRenameDirectory?: LinuxDirectoryRename;
  locale?: string;
  secretStorage?: SecretStorage;
  openExternal: (url: string) => Promise<void>;
  fetch?: typeof fetch;
};

type AutomaticBackupResult = { snapshot: Snapshot } | { snapshot: null; priorFailure: string | null };

export type Launcher = LauncherApi & {
  visualNovelInstallations(): Promise<VisualNovelInstallation[]>;
  editVisualNovelSettings(
    instanceId: string,
    patch: VisualNovelSettingsPatch,
    revision: string,
  ): Promise<VisualNovelSettingsResult>;
  previewCatalogInstall(ref: ReleaseRef, instanceId?: string, signal?: AbortSignal): Promise<CatalogInstallPreview>;
  installReviewedCatalogPackage(ref: ReleaseRef, review: CatalogInstallReview, instanceId?: string): Promise<void>;
  listOverlayExtensions(): Promise<InstalledOverlayExtension[]>;
  repairOverlayExtension(id: string, revision: string, signal?: AbortSignal): Promise<void>;
  reorderOverlayExtensions(packageIds: string[], orderRevision: string): Promise<void>;
  changeOverlayExtension(id: string, revision: string, enabled: boolean | null): Promise<void>;
  gameWorkState(): 'idle' | 'playing' | 'finishing';
  waitForGameWork(): Promise<void>;
  waitForPreparationWork(): Promise<void>;
  subscribe(listener: (session: Session | null) => void): () => void;
  subscribeMinecraftSignIn(listener: () => void): () => void;
  subscribeMinecraftPreparation(listener: (preparation: MinecraftPreparation) => void): () => void;
  subscribeAutomaticBackup(listener: (id: string, status: AutomaticBackupStatus) => void): () => void;
  subscribeLaunchReport(listener: (instanceId: string) => void): () => void;
};

export { visualNovelInstallationKey } from './visual-novel-discovery.ts';
export { createRezicsLibraryReader } from './rezics-library.ts';
export { parseMinecraftUpgradeSelection } from './minecraft-upgrade.ts';
export { minecraftWorldImportName } from './world-transfer.ts';

const preparationInProgress = 'Wait for Minecraft preparation to finish before playing.';

function openUrl(base: URL, instance: StoredInstance, destination: DestinationId) {
  const subject = instance.subjectId;
  if (subject && destination === 'info') {
    return new URL(`/subjects/${encodeURIComponent(subject)}`, base).href;
  }
  const target = new URL('/search', base);
  const extra = destination === 'guide' ? ' guide' : destination === 'community' ? ' community' : '';
  target.searchParams.set('q', `${instance.kind === 'minecraft' ? 'Minecraft' : instance.name}${extra}`);
  return target.href;
}

function spawned(child: ChildProcess) {
  if (child.pid) return Promise.resolve(child.pid);
  return new Promise<number>((accept, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.removeListener('error', reject);
      if (child.pid) accept(child.pid);
      else reject(new Error('Startup did not return a game process ID.'));
    });
  });
}

async function forceStop(child: ChildProcess, accepted: () => void) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const listener = new AbortController();
  const timeout = AbortSignal.timeout(10_000);
  const exited = once(child, 'exit', { signal: AbortSignal.any([listener.signal, timeout]) });
  try {
    if (!child.kill('SIGKILL')) throw new Error('The game process did not accept the stop request.');
    accepted();
    await exited;
  } catch {
    if (timeout.aborted) throw new Error('The game did not report that it stopped.');
    throw new Error('The game could not be stopped. Retry from the current session.');
  } finally {
    listener.abort();
    void exited.catch(() => {});
  }
}

async function waitForMinecraftExit(child: ChildProcess, signal: AbortSignal) {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const finish = () => resolve();
  const abort = () => reject(signal.reason);
  child.once('exit', finish);
  child.once('close', finish);
  signal.addEventListener('abort', abort, { once: true });
  try {
    await promise;
  } finally {
    child.removeListener('exit', finish);
    child.removeListener('close', finish);
    signal.removeEventListener('abort', abort);
  }
}

export { openOverlayPreferences } from './overlay-preferences.ts';

export function createLauncher(options: LauncherOptions): Launcher {
  const root = resolve(options.dataDir);
  const web = new URL(options.webUrl);
  if (!['http:', 'https:'].includes(web.protocol) || web.username || web.password) {
    throw new Error('Invalid REZICS website origin.');
  }
  const instances = new Instances(root, options.linuxRenameDirectory);
  const fetcher = options.fetch ?? fetch;
  const modrinth = new ModrinthRequests(fetcher, options.launcherVersion);
  const packages = new Packages(options.catalogUrl, options.launcherVersion, fetcher, modrinth);
  const plugins = createBuiltinPlugins({
    dataDir: root,
    instanceDirectory: (id) => instances.directory(id),
    minecraftClientId: options.minecraftClientId,
    secretStorage: options.secretStorage,
    fetch: options.fetch,
    packages,
    modrinth,
    visualNovels: {
      instances,
      endpoint: options.catalogUrl,
      website: web,
      locale: options.locale,
      fetch: options.fetch,
    },
  });
  const {
    minecraft: {
      auth,
      versions: minecraftVersions,
      game: minecraft,
      mods: minecraftMods,
      packs: modrinthPacks,
      packProvider,
    },
    'launch-diagnostics': diagnostics,
    'visual-novel': visualNovels,
    'game-footprints': footprints,
  } = plugins;
  const extensions = new InstalledStore(join(root, 'extensions'));
  const locks = new Locks();
  const subscriptions = new Set<(session: Session | null) => void>();
  const backupObservers = new Set<(id: string, status: AutomaticBackupStatus) => void>();
  const automaticBackups = new Map<string, Promise<AutomaticBackupResult>>();
  const backupStatuses = new Map<string, AutomaticBackupStatus>();
  const gameWork = new Set<Promise<unknown>>();
  let gameStarts = 0;
  let session: Session | null = null;
  let latestEditedPanels: OverlayPanel[] = [];
  let activeProcess:
    | { sessionId: string; child: ChildProcess; stopped: () => void; stopping?: Promise<void> }
    | undefined;
  let minecraftProcess: ChildProcess | undefined;

  function notify(value: Session | null) {
    session = value;
    for (const handler of subscriptions) handler(value);
  }

  function trackGameWork<T>(work: Promise<T>): Promise<T> {
    gameWork.add(work);
    const settled = () => gameWork.delete(work);
    void work.then(settled, settled);
    return work;
  }

  const instanceLock = (id: string) => `instance:${id}`;
  const savesFor = (instance: StoredInstance) =>
    new Saves(
      instances.directory(instance.id),
      async (selection) => scopedSaveRoots(instance, await instances.saveRoots(instance), selection, true),
      instance.kind,
      options.linuxRenameDirectory,
    );
  const modStore = (id: string) =>
    new InstalledStore(join(instances.directory(id), 'installed-mods'), join(instances.gamePath(id), 'mods'));

  function closed(id: string) {
    if (session?.instanceId === id) throw new Error('Close the game before changing this instance.');
  }

  function diagnosticInstance(id: string) {
    return instances.find(id).catch(() => {
      throw new LaunchFailure({ ...launchIssues.unknown, summary: 'The selected game instance could not be opened.' });
    });
  }

  async function modTarget(id: string): Promise<MinecraftModTarget> {
    const instance = await instances.find(id);
    if (instance.kind !== 'minecraft' || instance.minecraft.loader === 'vanilla') {
      throw new Error('Select an instance with Fabric, Forge or NeoForge to manage Minecraft mods.');
    }
    return { version: instance.minecraft.version, loader: instance.minecraft.loader };
  }

  function withSaveStore<T>(id: string, work: (saves: Saves, instance: StoredInstance) => Promise<T>) {
    return locks.run(instanceLock(id), async () => {
      const instance = await instances.find(id);
      return work(savesFor(instance), instance);
    });
  }

  function editVisualNovelSettings(
    id: string,
    patch: VisualNovelSettingsPatch,
    expectedRevision?: string,
  ): Promise<VisualNovelSettingsResult> {
    return locks.run(instanceLock(id), async () => {
      closed(id);
      const instance = await instances.visualNovel(id);
      const revision = visualNovelSettingsRevision(instance);
      const next = await visualNovels.edit(instance, patch);
      const nextRevision = visualNovelSettingsRevision(next);
      if (revision === nextRevision) return { status: 'unchanged', instance: instanceView(instance), revision };
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        return { status: 'conflict', instance: instanceView(instance), revision };
      }
      const changesSaveRoots =
        next.executable !== instance.executable ||
        next.workingDirectory !== instance.workingDirectory ||
        next.saveDirectory !== instance.saveDirectory ||
        next.renpySaveName !== instance.renpySaveName;
      const persist = () => instances.write(next);
      const saved = changesSaveRoots
        ? await withSaveFolders(savesFor(instance), instance, true, persist)
        : await persist();
      return { status: 'changed', instance: saved, revision: nextRevision };
    });
  }

  function withSaves<T>(
    id: string,
    work: (saves: Saves, roots: SaveRoot[], instance: StoredInstance) => Promise<T>,
    needsClosed: boolean,
  ) {
    return withSaveStore(id, (saves, instance) =>
      withSaveFolders(saves, instance, needsClosed, (roots) => work(saves, roots, instance)),
    );
  }

  function withSaveFolders<T>(
    saves: Saves,
    instance: StoredInstance,
    needsClosed: boolean,
    work: (roots: SaveRoot[]) => Promise<T>,
  ) {
    return locks.run('save-folders', async () => {
      const roots = await instances.saveRoots(instance);
      if (needsClosed && session) {
        const active = await instances.find(session.instanceId);
        const activeRoots = await instances.saveRoots(active);
        if (
          active.id === instance.id ||
          roots.some((root) => activeRoots.some((current) => pathOverlaps(root.path, current.path)))
        ) {
          throw new Error('Close the game before changing its saves.');
        }
      }
      if (!session || needsClosed) await saves.recover();
      return work(roots);
    });
  }

  function scopedSaveRoots(
    instance: StoredInstance,
    roots: SaveRoot[],
    selection?: SaveSelection,
    allowMissing = false,
  ) {
    if (!selection) return Promise.resolve(roots);
    if (instance.kind !== 'minecraft') throw new Error('Select a Minecraft instance to manage a world.');
    return minecraftWorldRoot(instances.gamePath(instance.id), selection, allowMissing).then((root) => [root]);
  }

  async function snapshotContext(instance: StoredInstance): Promise<Snapshot['minecraft']> {
    if (instance.kind !== 'minecraft') return undefined;
    const pack = await modrinthPacks.current(instances.directory(instance.id), instances.gamePath(instance.id));
    const mods = (await modStore(instance.id).list())
      .filter((item) => item.enabled)
      .map((item) => `${item.id}@${item.version}`);
    if (pack) mods.push(`${pack.name}@${pack.versionId}`);
    const loaderVersion = minecraftLoaderVersion(instance.minecraft);
    return {
      version: instance.minecraft.version,
      loader: instance.minecraft.loader,
      ...(loaderVersion && { loaderVersion }),
      mods,
    };
  }

  function backup(id: string, label?: string, selection?: SaveSelection) {
    return withSaves(
      id,
      async (saves, roots, instance) => {
        const selected = await scopedSaveRoots(instance, roots, selection);
        return saves.create(selected, await snapshotContext(instance), label, selection);
      },
      true,
    );
  }

  function backupFailure(error: unknown) {
    return error instanceof Error && error.message.trim() ? error.message.slice(0, 320) : 'The save backup failed.';
  }

  function announceBackup(id: string, status: AutomaticBackupStatus) {
    backupStatuses.set(id, status);
    for (const observer of backupObservers) {
      try {
        observer(id, status);
      } catch {
        // A connected window can disappear while the backup runs.
      }
    }
  }

  function automaticBackup(id: string) {
    const active = automaticBackups.get(id);
    if (active) return active;
    let started = false;
    const work = withSaveStore<AutomaticBackupResult>(id, async (saves, instance) => {
      started = true;
      announceBackup(id, { state: 'running' });
      try {
        const snapshot = await withSaveFolders(saves, instance, true, async (roots) =>
          saves.createAutomatic(roots, await snapshotContext(instance)),
        );
        return { snapshot };
      } catch (error) {
        if (error instanceof NoSaveFolderError) return { snapshot: null, priorFailure: await saves.failure() };
        await saves.recordFailure(backupFailure(error)).catch(() => {});
        throw error;
      }
    });
    automaticBackups.set(id, work);
    function finish(status: AutomaticBackupStatus) {
      automaticBackups.delete(id);
      if (started) announceBackup(id, status);
    }
    void work.then(
      (result) =>
        finish(
          result.snapshot === null && result.priorFailure
            ? { state: 'failed', message: result.priorFailure }
            : { state: 'idle' },
        ),
      (error: unknown) => finish({ state: 'failed', message: backupFailure(error) }),
    );
    return work;
  }

  async function automaticBackupStatus(id: string): Promise<AutomaticBackupStatus> {
    const known = backupStatuses.get(id);
    if (known) {
      await instances.find(id);
      return backupStatuses.get(id) ?? known;
    }
    return withSaveStore(id, async (saves) => {
      const failure = await saves.failure();
      return failure ? { state: 'failed', message: failure } : { state: 'idle' };
    });
  }

  async function requireMinecraft(id: string) {
    const instance = await instances.find(id);
    if (instance.kind !== 'minecraft') throw new Error('Select a Minecraft instance.');
    return instance;
  }

  function worldImportVersion(instance: StoredInstance, expectedVersion?: string) {
    if (instance.kind !== 'minecraft') throw new Error('Select a Minecraft instance to import a world.');
    const version = instance.minecraft.version;
    if (expectedVersion !== undefined && expectedVersion !== version) {
      throw new Error('The destination Minecraft release changed. Preview the world import again.');
    }
    return version;
  }

  function editMinecraftInstance<T>(id: string, edit: () => Promise<T>) {
    return locks.run(instanceLock(id), async () => {
      closed(id);
      await requireMinecraft(id);
      return edit();
    });
  }

  async function settleInstanceFiles(id: string) {
    await modrinthPacks.recover(instances.directory(id), instances.gamePath(id));
    await modStore(id).recover();
    const instance = await instances.find(id);
    await locks.run('save-folders', () => savesFor(instance).recover());
  }

  function withMinecraftResources<T>(job: MinecraftPreparationJob, work: () => Promise<T>) {
    return locks.run(
      'minecraft-resources',
      async () => {
        const game = minecraftProcess;
        if (game) {
          await job.report('waiting-for-game');
          if (minecraftProcess === game) await waitForMinecraftExit(game, job.signal);
        }
        job.signal.throwIfAborted();
        return work();
      },
      job.signal,
    );
  }

  async function inPlaceVersionChangeBlocker(
    instance: MinecraftInstance,
    version: string,
    signal?: AbortSignal,
  ): Promise<MinecraftInPlaceUpgradeBlocker | null> {
    signal?.throwIfAborted();
    const { id, minecraft } = instance;
    const game = instances.gamePath(id);
    if (isEarlierMinecraftRelease(version, minecraft.version) && (await listMinecraftWorlds(game)).length)
      return 'worlds';
    if (await minecraftWorldCopyRisk(game, version, undefined, signal)) return 'newer-worlds';
    if (await modrinthPacks.current(instances.directory(id), game)) return 'modpack';
    if ((await modStore(id).list()).length || (await hasUnmanagedMinecraftMods(game, signal))) return 'mods';
    return null;
  }

  async function confirmInPlaceVersionChange(instance: MinecraftInstance, version: string, signal: AbortSignal) {
    const blocker = await inPlaceVersionChangeBlocker(instance, version, signal);
    if (blocker) throw new Error(minecraftInPlaceUpgradeMessages[blocker]);
  }

  async function runMinecraftUpgrade(
    instance: MinecraftInstance,
    job: Extract<MinecraftPreparationJob, { mode: 'upgrade' }>,
  ) {
    const { selection, upgradeMode, worldIds, worldVersionConfirmation, java, signal } = job;
    const { id } = instance;
    const downgrade = isEarlierMinecraftRelease(selection.version, instance.minecraft.version);
    const copySuffix = downgrade ? ' (downgraded copy)' : ' (upgraded copy)';
    await job.report('version');
    if (sameMinecraftSelection(instance.minecraft, selection))
      throw new Error('Choose a different Minecraft release or loader.');
    if (upgradeMode === 'in-place') await confirmInPlaceVersionChange(instance, selection.version, signal);
    let copyWorlds: MigrationWorld[] | undefined;
    if (worldIds !== undefined) {
      copyWorlds = worldIds.length > 0 ? await selectIdleWorlds(instance, worldIds, signal) : [];
    }
    if (upgradeMode === 'copy') {
      await confirmMinecraftWorldCopy(
        instances.gamePath(id),
        selection.version,
        worldVersionConfirmation,
        worldIds,
        signal,
      );
    }

    const selected = await minecraftVersions.select({ name: instance.name, ...selection }, signal);
    const settings = java ? { ...instance.minecraft.settings, java } : instance.minecraft.settings;
    const change = {
      ...selected,
      prepared: true,
      ...(settings && { settings }),
    };
    await job.report('queued');
    const installation = await withMinecraftResources(job, () => minecraft.prepare(change, job));
    const resultId = upgradeMode === 'copy' ? `game-${job.id}` : id;
    const candidate: MinecraftInstance = {
      ...instance,
      id: resultId,
      name: upgradeMode === 'copy' ? instance.name.slice(0, 120 - copySuffix.length) + copySuffix : instance.name,
      minecraft: change,
      installation,
      lastPreparationId: job.id,
    };

    await job.report('worlds');
    await locks.run(
      'save-folders',
      async () => {
        signal.throwIfAborted();
        const saves = savesFor(instance);
        if (upgradeMode === 'copy') {
          if (copyWorlds === undefined || copyWorlds.length > 0) {
            await checkMigrationSourceIdle(id);
            await saves.recover();
          }
          await instances.copyMinecraftUpgrade(
            id,
            candidate,
            signal,
            (publish) => job.commit(publish, resultId),
            copyWorlds,
            worldVersionConfirmation,
          );
          return;
        }
        await saves.recover();
        await confirmInPlaceVersionChange(instance, selection.version, signal);
        await checkLocalDirectory(instances.gamePath(id), 'Minecraft game');
        const roots = await instances.saveRoots(instance);
        const worlds = roots[0];
        if (worlds) await checkLocalDirectory(worlds.path, 'Minecraft saves');
        if (worlds && (await fileInfo(worlds.path))) {
          await saves.create(
            roots,
            await snapshotContext(instance),
            'Before Minecraft version or loader change',
            undefined,
            signal,
          );
        }
        await job.commit(() => instances.write(candidate), resultId);
      },
      signal,
    );
  }

  const preparation = createMinecraftPreparation({
    directory: (id) => instances.directory(id),
    withInstance: (id, work) => locks.run(instanceLock(id), work),
    async recoverCommitted(status) {
      const upgrade = status.mode === 'upgrade';
      const selection = status.selection;
      if (upgrade && (!status.upgradeMode || !selection)) return undefined;
      const id = upgrade && status.upgradeMode === 'copy' ? `game-${status.id}` : status.instanceId;
      const record = await instances.find(id).catch(() => null);
      if (record?.kind !== 'minecraft' || !record.installation) return undefined;
      const committedId = record.lastPreparationId ?? (upgrade ? record.lastUpgradeId : undefined);
      if (committedId !== status.id) return undefined;
      if (upgrade && selection && !sameMinecraftSelection(record.minecraft, selection)) return undefined;
      return id;
    },
    async prepare(id, job) {
      closed(id);
      const instance = await requireMinecraft(id);
      if (job.mode === 'upgrade') return runMinecraftUpgrade(instance, job);
      await withMinecraftResources(job, async () => {
        const installation = await minecraft.prepare(instance.minecraft, job, instance.installation);
        await job.commit(() =>
          instances.write({
            ...instance,
            minecraft: { ...instance.minecraft, prepared: true },
            installation,
            lastPreparationId: job.id,
          }),
        );
      });
    },
  });

  async function readMinecraftPreparation(id: string) {
    const current = preparation.active(id);
    if (current) return current;
    return locks.run(instanceLock(id), async () => {
      await requireMinecraft(id);
      return preparation.read(id);
    });
  }

  function withInstanceMods<T>(
    instanceId: string,
    work: (store: InstalledStore, target: MinecraftModTarget) => Promise<T>,
    signal?: AbortSignal,
  ) {
    return locks.run(
      instanceLock(instanceId),
      async () => {
        closed(instanceId);
        const target = await modTarget(instanceId);
        await modrinthPacks.recover(instances.directory(instanceId), instances.gamePath(instanceId));
        return work(modStore(instanceId), target);
      },
      signal,
    );
  }

  async function committedModNames(id: string, store: InstalledStore) {
    const [launcher, pack] = await Promise.all([
      store.committedModNames(),
      modrinthPacks.committedModNames(instances.directory(id), instances.gamePath(id)),
    ]);
    return { launcher, pack };
  }

  async function editMods(
    instanceId: string,
    edit: (store: InstalledStore, target: MinecraftModTarget) => Promise<unknown>,
    signal?: AbortSignal,
  ) {
    await withInstanceMods(instanceId, edit, signal);
  }

  function editPackages(
    instanceId: string | undefined,
    edit: (store: InstalledStore, target?: MinecraftModTarget) => Promise<Installed[]>,
    signal?: AbortSignal,
  ) {
    if (instanceId) return editMods(instanceId, edit, signal);
    return locks.run(
      'extensions',
      async () => {
        latestEditedPanels = selectOverlayPanels(await edit(extensions));
        if (session) notify({ ...session, panels: latestEditedPanels });
      },
      signal,
    );
  }

  function changeInstalledPackage(
    id: string,
    instanceId: string | undefined,
    enabled: boolean | null,
    revision?: string,
  ) {
    return editPackages(instanceId, (store) =>
      store.edit(async (current) => {
        const record = current.find((item) => item.id === id);
        if (revision !== undefined && (!record || overlayExtensionRevision(record) !== revision)) {
          throw new Error('The installed Overlay extension changed. Review it again.');
        }
        if (enabled !== null && !record) throw new Error('This package is no longer installed.');
        if (!instanceId && enabled === true && record && overlayPanelIssue(record)) {
          throw new Error('Repair this Overlay extension before enabling it.');
        }
        const next =
          enabled === null
            ? current.filter((item) => item.id !== id)
            : current.map((item) => (item.id === id ? { ...item, enabled } : item));
        return { next, artifacts: new Map() };
      }),
    );
  }

  function installCatalogPackage(ref: ReleaseRef, instanceId?: string, review?: CatalogInstallReview) {
    return editPackages(
      instanceId,
      (store, target) =>
        packages.installCatalog(store, ref, target && instanceId ? { ...target, instanceId } : undefined, review),
      review?.signal,
    );
  }

  async function publishModrinthPack(
    source: string,
    digest: string,
    preview: ModrinthPackPreview,
    control?: ModrinthPackInstallControl,
    destination: { settings?: MinecraftSettings; copyWorlds?: (game: string) => Promise<void> } = {},
  ) {
    const input = { name: preview.name, ...preview.selection };
    const signal = control?.signal;
    const selection = await minecraftVersions.select(input, signal);
    let settings = destination.settings;
    if (settings?.java.kind === 'custom') {
      const runtime = await minecraft.probeReleaseJava(selection.version, settings.java.executable, signal);
      settings = { ...settings, java: { kind: 'custom', executable: runtime.executable } };
    }
    return locks.run(
      'modrinth-instance-import',
      () =>
        instances.publishMinecraftImport(
          input,
          selection,
          async (directory, game) => {
            // The pack's internal commit is still inside the unpublished instance directory.
            await modrinthPacks.apply(directory, game, source, digest, selection, signal && { signal });
            signal?.throwIfAborted();
            await destination.copyWorlds?.(game);
          },
          settings,
          control,
        ),
      signal,
    );
  }

  async function checkMigrationSourceIdle(id: string) {
    closed(id);
    if (!session) return;
    const active = await instances.find(session.instanceId);
    const activeRoots = await instances.saveRoots(active);
    const worlds = join(instances.gamePath(id), 'saves');
    if (activeRoots.some(({ path }) => pathOverlaps(path, worlds))) {
      throw new Error('Close the game before copying these worlds.');
    }
  }

  function selectIdleWorlds(instance: MinecraftInstance, worldIds: readonly string[], signal?: AbortSignal) {
    return locks.run(
      'save-folders',
      async () => {
        await checkMigrationSourceIdle(instance.id);
        await savesFor(instance).recover();
        return selectMinecraftMigrationWorlds(instances.directory(instance.id), worldIds);
      },
      signal,
    );
  }

  return {
    subscribe(listener) {
      subscriptions.add(listener);
      return () => subscriptions.delete(listener);
    },
    subscribeMinecraftSignIn: (listener) => auth.subscribeSignIn(listener),
    subscribeMinecraftPreparation: preparation.subscribe,
    subscribeLaunchReport: diagnostics.subscribe,
    subscribeAutomaticBackup(listener) {
      backupObservers.add(listener);
      return () => {
        backupObservers.delete(listener);
      };
    },
    listInstances: () => instances.list(),
    listArchivedInstances: () => instances.listArchivedInstances(),
    setLocalGameArchived: (id, archived) =>
      locks.run(instanceLock(id), () =>
        instances.setLocalGameArchived(id, archived, async (instance) => {
          closed(id);
          await withSaveFolders(savesFor(instance), instance, true, async () => {});
        }),
      ),
    visualNovelInstallations: () => instances.visualNovelInstallations(),
    waitForPreparationWork: preparation.waitForWork,
    footprintStatus: footprints.status,
    setFootprintRecording: footprints.enable,
    exportFootprints: footprints.export,
    importInstance: (input) => instances.local(input),
    inspectVisualNovel: visualNovels.inspect,
    discoverVisualNovels: (directory, signal) => instances.discoverVisualNovels(directory, signal),
    searchVisualNovelSubjects: visualNovels.search,
    readLinkedVisualNovelSubject: visualNovels.linkedSubject,
    setVisualNovelAssociation: (id, change) =>
      locks.run(instanceLock(id), async () => {
        const expected = change.expectedSubjectId === null ? null : parseSubjectId(change.expectedSubjectId);
        const target = change.subjectId === null ? null : parseSubjectId(change.subjectId);
        const instance = await instances.visualNovel(id);
        const current = instance.subjectId?.toLowerCase() ?? null;
        if (target === current) return { status: 'unchanged', instance: instanceView(instance) };
        if (current !== expected) return { status: 'conflict', instance: instanceView(instance) };
        closed(id);
        const next = await visualNovels.edit(instance, { subjectId: target });
        return { status: 'changed', instance: await instances.write(next) };
      }),
    readVisualNovelSettings: visualNovels.settings,
    editVisualNovelSettings,
    async updateVisualNovelSettings(id, patch, revision) {
      const change = await editVisualNovelSettings(id, patch, revision);
      if (change.status === 'conflict') throw new Error('These visual novel settings changed. Review them again.');
      return change.instance;
    },
    listMinecraftVersions: () => minecraftVersions.listMinecraftVersions(),
    listFabricVersions: (version) => minecraftVersions.listFabricVersions(version),
    listForgeVersions: (version) => minecraftVersions.listForgeVersions(version),
    listNeoForgeVersions: (version) => minecraftVersions.listNeoForgeVersions(version),
    createMinecraft: async (input) => instances.minecraft(input, await minecraftVersions.select(input)),
    renameMinecraft: (id, name) => editMinecraftInstance(id, () => instances.renameMinecraft(id, name)),
    duplicateMinecraft: (id, name, copyWorlds) =>
      editMinecraftInstance(id, async () => {
        await settleInstanceFiles(id);
        return instances.duplicateMinecraft(id, name, copyWorlds);
      }),
    archiveMinecraft: (id) =>
      editMinecraftInstance(id, async () => {
        await settleInstanceFiles(id);
        await instances.archiveMinecraft(id);
      }),
    listArchivedMinecraft: () => instances.listArchivedMinecraft(),
    restoreArchivedMinecraft: (id) => locks.run(instanceLock(id), () => instances.restoreArchivedMinecraft(id)),
    deleteArchivedMinecraft: (id, revision) =>
      locks.run(instanceLock(id), () => instances.deleteArchivedMinecraft(id, revision)),
    setMinecraftSettings(id, patch) {
      return locks.run(instanceLock(id), async () => {
        closed(id);
        const instance = await requireMinecraft(id);
        const settings: MinecraftSettings = { java: { kind: 'managed' }, ...instance.minecraft.settings };
        if (patch.useManagedJava) settings.java = { kind: 'managed' };
        if (patch.accountId === null) delete settings.accountId;
        else if (patch.accountId !== undefined) {
          const accounts = await auth.accounts();
          if (!accounts.profiles.some(({ id }) => id === patch.accountId))
            throw new Error('Select a saved Minecraft account.');
          settings.accountId = patch.accountId;
        }
        if (patch.maxMemoryMiB === null) delete settings.maxMemoryMiB;
        else if (patch.maxMemoryMiB !== undefined) {
          const { min, max } = minecraftMemoryMiB;
          if (!Number.isInteger(patch.maxMemoryMiB) || patch.maxMemoryMiB < min || patch.maxMemoryMiB > max) {
            throw new Error(`Choose a memory limit from ${min} to ${max} MiB.`);
          }
          settings.maxMemoryMiB = patch.maxMemoryMiB;
        }
        const prepared = instance.minecraft.prepared && (!patch.useManagedJava || !!instance.installation?.javaRuntime);
        return instances.write({ ...instance, minecraft: { ...instance.minecraft, prepared, settings } });
      });
    },
    setMinecraftJava(id, executable) {
      return locks.run(instanceLock(id), async () => {
        closed(id);
        const instance = await requireMinecraft(id);
        const requiredMajor = await minecraft.requiredJavaMajor(instance.installation ?? instance.minecraft.version);
        const java = await minecraft.verifyJavaRuntime({ kind: 'custom', executable }, requiredMajor);
        return instances.write({
          ...instance,
          minecraft: {
            ...instance.minecraft,
            prepared: !!instance.installation,
            settings: { ...instance.minecraft.settings, java: { kind: 'custom', executable: java.executable } },
          },
        });
      });
    },
    checkMinecraftJava(id) {
      return locks.run(instanceLock(id), async () => {
        closed(id);
        const {
          minecraft: { version, settings },
          installation,
        } = await requireMinecraft(id);
        const policy = settings?.java ?? { kind: 'managed' };
        const check = () => minecraft.checkJavaRuntime(version, policy, installation);
        if (policy.kind === 'custom' || !installation?.javaRuntime) return check();
        return locks.run('minecraft-resources', () => {
          if (minecraftProcess) throw new Error('Close Minecraft before checking the managed Java runtime.');
          return check();
        });
      });
    },
    instanceFolder(id) {
      return locks.run(instanceLock(id), async () => {
        await requireMinecraft(id);
        const directory = instances.gamePath(id);
        const info = await fileInfo(directory);
        if (info && !info.isDirectory()) throw new Error('The instance folder is unavailable or is a link.');
        await mkdir(directory, { recursive: true });
        return directory;
      });
    },
    inspectModrinthPack: (source, signal) => modrinthPacks.inspect(source, signal),
    searchModrinthPacks: (query, cursor) => packProvider.search(query, cursor),
    listModrinthPackVersions: (projectId, cursor) => packProvider.list(projectId, cursor),
    stageOnlineModrinthPack: (projectId, versionId, signal) => packProvider.stage(projectId, versionId, signal),
    async importModrinthPack(source, digest, preview, id, control, java) {
      if (id) {
        if (java) throw new Error('Choose a separate instance to select Java for this pack.');
        return locks.run(
          instanceLock(id),
          async () => {
            closed(id);
            const instance = await requireMinecraft(id);
            await modStore(id).recover();
            await modrinthPacks.apply(
              instances.directory(id),
              instances.gamePath(id),
              source,
              digest,
              instance.minecraft,
              control,
            );
            return instanceView(instance);
          },
          control?.signal,
        );
      }
      return publishModrinthPack(source, digest, preview, control, java && { settings: { java } });
    },
    migrateModrinthPack(source, digest, preview, fromInstanceId, worldIds, control, worldVersionConfirmation, java) {
      const signal = control?.signal;
      return locks.run(
        instanceLock(fromInstanceId),
        async () => {
          closed(fromInstanceId);
          const instance = await requireMinecraft(fromInstanceId);
          const home = instances.directory(instance.id);
          const selected = await selectIdleWorlds(instance, worldIds, signal);
          await confirmMinecraftWorldCopy(
            instances.gamePath(instance.id),
            preview.selection.version,
            worldVersionConfirmation,
            worldIds,
            signal,
          );
          const { accountId, maxMemoryMiB } = instance.minecraft.settings ?? {};
          const settings: MinecraftSettings = {
            java: java ?? { kind: 'managed' },
            ...(accountId && { accountId }),
            ...(maxMemoryMiB !== undefined && { maxMemoryMiB }),
          };
          return publishModrinthPack(source, digest, preview, control, {
            settings,
            copyWorlds: (game) =>
              locks.run(
                'save-folders',
                async () => {
                  await checkMigrationSourceIdle(instance.id);
                  await copyMinecraftMigrationWorlds(home, game, selected, signal);
                  await confirmMinecraftWorldCopy(
                    game,
                    preview.selection.version,
                    worldVersionConfirmation,
                    worldIds,
                    signal,
                  );
                },
                signal,
              ),
          });
        },
        signal,
      );
    },
    currentModrinthPack(id) {
      return locks.run(instanceLock(id), async () => {
        await requireMinecraft(id);
        return modrinthPacks.current(instances.directory(id), instances.gamePath(id));
      });
    },
    repairModrinthPack(id, control) {
      return locks.run(
        instanceLock(id),
        async () => {
          closed(id);
          const instance = await requireMinecraft(id);
          await modStore(id).recover();
          return modrinthPacks.repair(instances.directory(id), instances.gamePath(id), instance.minecraft, control);
        },
        control?.signal,
      );
    },
    exportModrinthPack(id, destination) {
      return locks.run(instanceLock(id), async () => {
        closed(id);
        await requireMinecraft(id);
        return modrinthPacks.export(instances.directory(id), instances.gamePath(id), destination);
      });
    },
    async prepareMinecraft(id) {
      await editMinecraftInstance(id, () => preparation.start(id, 'install'));
      const result = await preparation.wait(id);
      if (result?.state !== 'ready') throw new Error(result?.error ?? 'Minecraft preparation did not finish.');
      return instances.find(id).then(instanceView);
    },
    async startMinecraftPreparation(id, mode) {
      if (mode !== 'install' && mode !== 'repair') throw new Error('Choose installation or repair.');
      const active = preparation.active(id);
      if (active?.mode === 'upgrade') throw new Error('Wait for the current Minecraft change to finish.');
      if (active) return active;
      return editMinecraftInstance(id, () => preparation.start(id, mode));
    },
    async readMinecraftInPlaceUpgradeBlocker(id, version) {
      if (typeof version !== 'string' || !minecraftReleaseIdPattern.test(version)) {
        throw new Error('Choose an exact Minecraft release.');
      }
      return locks.run(instanceLock(id), async () => inPlaceVersionChangeBlocker(await requireMinecraft(id), version));
    },
    async previewMinecraftWorldCopy(id, targetVersion, worldIds) {
      if (typeof targetVersion !== 'string' || !minecraftReleaseIdPattern.test(targetVersion)) {
        throw new Error('Choose an exact Minecraft release.');
      }
      if (worldIds !== undefined) validateMinecraftWorldIds(worldIds, true);
      return locks.run(instanceLock(id), async () => {
        const instance = await requireMinecraft(id);
        return locks.run('save-folders', () =>
          minecraftWorldCopyRisk(instances.gamePath(instance.id), targetVersion, worldIds),
        );
      });
    },
    async startMinecraftUpgrade(id, selection, upgradeMode, worldIds, worldVersionConfirmation, java, expectedSource) {
      if (upgradeMode !== 'copy' && upgradeMode !== 'in-place')
        throw new Error('Choose how to change this Minecraft instance.');
      if (preparation.active(id)) throw new Error('Wait for the current Minecraft preparation to finish.');
      const requested = parseMinecraftUpgradeSelection(selection);
      if (worldIds !== undefined) {
        if (upgradeMode !== 'copy') throw new Error('Choose a separate instance to copy worlds.');
        validateMinecraftWorldIds(worldIds, true);
      }
      const chosen = worldIds === undefined ? undefined : [...worldIds];
      const source = await requireMinecraft(id);
      closed(id);
      return editMinecraftInstance(id, async () => {
        const current = await requireMinecraft(id);
        if (!sameMinecraftSelection(expectedSource ?? source.minecraft, current.minecraft)) {
          throw new Error('This Minecraft selection changed. Review the version change again.');
        }
        if (sameMinecraftSelection(current.minecraft, requested))
          throw new Error('Choose a different Minecraft release or loader.');
        return preparation.start(id, {
          mode: 'upgrade',
          selection: requested,
          upgradeMode,
          ...(chosen !== undefined && { worldIds: chosen }),
          ...(worldVersionConfirmation && { worldVersionConfirmation }),
          ...(java && { java }),
        });
      });
    },
    readMinecraftPreparation,
    activeMinecraftPreparations: async () => preparation.activeJobs(),
    async readMinecraftPreparationActivity() {
      const attempts = new Map<string, MinecraftPreparation>();
      for (const { id, kind } of await instances.list()) {
        if (kind !== 'minecraft') continue;
        const attempt = await readMinecraftPreparation(id).catch(() => null);
        if (attempt?.interrupted) attempts.set(id, attempt);
      }
      for (const attempt of preparation.activeJobs()) attempts.set(attempt.instanceId, attempt);
      return [...attempts.values()];
    },
    async cancelMinecraftPreparation(id, attemptId) {
      if (preparation.active(id)) return preparation.cancel(id, attemptId);
      return locks.run(instanceLock(id), async () => {
        await requireMinecraft(id);
        return preparation.cancel(id, attemptId);
      });
    },
    beginMinecraftSignIn: (accountId) => auth.begin(accountId),
    readMinecraftSignIn: async () => auth.readSignIn(),
    cancelMinecraftSignIn: () => auth.cancelSignIn(),
    minecraftAccount: () => auth.account(),
    minecraftAccounts: () => auth.accounts(),
    async selectMinecraftAccount(id) {
      await auth.select(id);
    },
    async forgetMinecraftAccount(id) {
      await auth.forget(id);
    },
    signOutMinecraft: () => auth.signOut(),
    launch(id) {
      gameStarts++;
      const starting = locks.run('session', () => {
        if (preparation.active(id)) throw new Error(preparationInProgress);
        return locks.run(instanceLock(id), () =>
          locks.run('save-folders', async () => {
            if (session) throw new Error('Close the current game before starting another.');
            const instance = await diagnosticInstance(id);
            if (instance.kind === 'minecraft' && preparation.hasActiveJobs()) throw new Error(preparationInProgress);
            const startupIssue =
              instance.kind === 'minecraft'
                ? launchIssues.java
                : instance.kind === 'visual-novel'
                  ? visualNovelExecutableIssue
                  : launchIssues.executable;
            const recording = diagnostics.begin(id, instance.kind === 'minecraft', startupIssue);
            const completeSession = await prepareGameSession(plugins, instance.subjectId);
            let child: ChildProcess;
            try {
              await savesFor(instance)
                .recoverRestore()
                .catch(() => {
                  throw new LaunchFailure(launchIssues.saves);
                });
              if (instance.kind === 'minecraft' && !instance.installation) {
                throw new LaunchFailure({
                  ...launchIssues.installation,
                  summary: 'Prepare this Minecraft instance before launching.',
                });
              }
              if (instance.kind === 'minecraft') {
                const damaged = await modrinthPacks
                  .firstDamagedDownload(instances.directory(id), instances.gamePath(id))
                  .catch(() => {
                    throw new LaunchFailure(launchIssues.modpack);
                  });
                if (damaged) {
                  throw new LaunchFailure({
                    ...launchIssues.modpack,
                    summary: `An installed Modrinth pack file is missing or damaged (${damaged}). Open Packs to repair it.`,
                  });
                }
              }
              const installedMods = modStore(id);
              let problem: Awaited<ReturnType<InstalledStore['firstEnabledFileIssue']>>;
              try {
                if (instance.kind === 'minecraft' && instance.minecraft.loader !== 'vanilla') {
                  problem = await installedMods.firstEnabledFileIssue();
                } else {
                  await installedMods.recover();
                }
              } catch (error) {
                if (instance.kind === 'minecraft') {
                  throw new LaunchFailure({
                    ...launchIssues.mods,
                    summary: 'Launcher could not recover the instance’s installed mods. Check Mods for details.',
                  });
                }
                throw error;
              }
              if (problem?.fileIssue) {
                const title = problem.title.replace(/[\x00-\x1f\x7f]/gu, ' ').slice(0, 100);
                throw new LaunchFailure({
                  ...launchIssues.mods,
                  summary: `${title}: its installed file is ${problem.fileIssue}. Open Mods to resolve it.`,
                });
              }
              if (instance.kind === 'minecraft') {
                if (preparation.hasActiveJobs()) {
                  throw new LaunchFailure({ ...launchIssues.unknown, summary: preparationInProgress });
                }
                child = await locks.run('minecraft-resources', async () => {
                  const gamePath = instances.gamePath(id);
                  await recording.prepareMinecraftCrashReports(gamePath);
                  const result = await minecraft.start(
                    gamePath,
                    instance.installation!,
                    instance.minecraft,
                    (process, secret, cleanup) => {
                      trackGameWork(recording.watch(process, secret));
                      trackGameWork(cleanup);
                    },
                  );
                  if (result.child.exitCode === null && result.child.signalCode === null) {
                    const running = result.child;
                    minecraftProcess = running;
                    const ended = () => {
                      if (minecraftProcess === running) minecraftProcess = undefined;
                      running.removeListener('exit', ended);
                      running.removeListener('close', ended);
                    };
                    running.once('exit', ended);
                    running.once('close', ended);
                  }
                  return result.child;
                });
              } else {
                try {
                  child = spawn(instance.executable, [], {
                    cwd: instance.workingDirectory,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: false,
                  });
                } catch {
                  throw new LaunchFailure(startupIssue);
                }
                trackGameWork(recording.watch(child));
              }
            } catch (error) {
              const failure = safeLaunchFailure(error);
              await recording.fail(failure).catch(() => {});
              throw failure;
            }
            const sessionId = randomUUID();
            let recordExit: ((end: number) => Promise<unknown>) | undefined;
            let exited = child.exitCode !== null || child.signalCode !== null;
            child.on('error', () => {});
            child.once('exit', () => {
              exited = true;
              if (activeProcess?.sessionId === sessionId) activeProcess = undefined;
              const recorded = recordExit?.(performance.now());
              if (session?.sessionId !== sessionId) return;
              const backup = automaticBackup(id);
              trackGameWork(
                Promise.allSettled([recorded, backup]).then(() => {
                  if (!session) notify(null);
                }),
              );
              notify(null);
            });
            const pid = await spawned(child).catch(async () => {
              const failure = new LaunchFailure(startupIssue);
              await recording.fail(failure).catch(() => {});
              throw failure;
            });
            const startedAt = Date.now();
            if (completeSession.length) {
              const monotonicStart = performance.now();
              recordExit = (monotonicEnd) => {
                const completed = { sessionId, startedAt, elapsedMs: monotonicEnd - monotonicStart };
                return Promise.allSettled(completeSession.map(async (complete) => complete(completed)));
              };
            }
            // Use the latest committed edit if one completed during the startup ledger read.
            const previousPanels = latestEditedPanels;
            const storedPanels = await extensions
              .readCommitted()
              .then(selectOverlayPanels)
              .catch(() => []);
            const current: Session = {
              sessionId,
              instanceId: id,
              pid,
              title: instance.name,
              startedAt,
              destinations: [
                { id: 'info', label: 'Game info' },
                { id: 'guide', label: 'Find guides' },
                { id: 'community', label: 'Community' },
              ],
              panels: latestEditedPanels === previousPanels ? storedPanels : latestEditedPanels,
            };
            if (exited) {
              void automaticBackup(id).catch(() => {});
              throw new Error('The game exited during startup.');
            }
            activeProcess = { sessionId, child, stopped: recording.stopped };
            notify(current);
            return current;
          }),
        );
      });
      const finishedStarting = () => {
        gameStarts--;
      };
      void starting.then(finishedStarting, finishedStarting);
      return trackGameWork(starting);
    },
    async stopGame(sessionId) {
      const active = activeProcess;
      if (!active || active.sessionId !== sessionId || session?.sessionId !== sessionId) {
        throw new Error('That game session is no longer running.');
      }
      active.stopping ??= forceStop(active.child, active.stopped);
      try {
        await active.stopping;
      } finally {
        delete active.stopping;
      }
    },
    currentSession: async () => session,
    gameWorkState() {
      if (gameStarts || session) return 'playing';
      return gameWork.size || automaticBackups.size ? 'finishing' : 'idle';
    },
    async waitForGameWork() {
      while (gameWork.size || automaticBackups.size) {
        await Promise.allSettled([...gameWork, ...automaticBackups.values()]);
      }
    },
    async readLaunchReport(id) {
      await diagnosticInstance(id);
      return diagnostics.read(id);
    },
    async launchDiagnosticText(id) {
      const instance = await diagnosticInstance(id);
      const paths = [root, instances.directory(id), homedir()];
      if (instance.kind === 'minecraft') {
        const java = instance.minecraft.settings?.java;
        if (java?.kind === 'custom') paths.push(java.executable);
      } else {
        paths.push(instance.executable, instance.workingDirectory);
        if (instance.saveDirectory) paths.push(instance.saveDirectory);
      }
      return diagnostics.copy(id, paths);
    },
    async openDestination(sessionId, destination) {
      const current = session;
      if (
        !current ||
        current.sessionId !== sessionId ||
        !isDestinationId(destination) ||
        !current.destinations.some(({ id }) => id === destination)
      ) {
        throw new Error('This game session or destination is no longer available.');
      }
      const instance = await instances.find(current.instanceId);
      if (session?.sessionId !== sessionId) throw new Error('This game session has ended.');
      await options.openExternal(openUrl(web, instance, destination));
    },
    openRezicsLibrary: () => options.openExternal(new URL('/library', web).href),
    readRezicsLibraryPage: createRezicsLibraryReader(
      options.catalogUrl,
      () => instances.list(),
      options.readRezicsLibraryToken,
      options.locale ?? 'en',
      options.fetch,
    ),
    async openGameInfo(id) {
      await options.openExternal(openUrl(web, await instances.find(id), 'info'));
    },
    listSnapshots: (id) => withSaveStore(id, (saves) => saves.list()),
    readSnapshotHistory: (id) => withSaveStore(id, (saves) => saves.history()),
    async lastBackupFailure(id) {
      await automaticBackups.get(id)?.catch(() => {});
      const status = await automaticBackupStatus(id);
      return status.state === 'failed' ? status.message : null;
    },
    automaticBackupStatus,
    async retryAutomaticBackup(id) {
      closed(id);
      const result = await automaticBackup(id);
      if (!result.snapshot) throw new NoSaveFolderError();
      return result.snapshot;
    },
    listMinecraftWorlds: (id) =>
      withSaves(
        id,
        async (_saves, _roots, instance) => {
          if (instance.kind !== 'minecraft') throw new Error('Select a Minecraft instance to manage worlds.');
          return listMinecraftWorlds(instances.gamePath(id));
        },
        false,
      ),
    async inspectMinecraftWorldArchive(source, id, signal) {
      const instance = id === undefined ? undefined : await requireMinecraft(id);
      if (instance) await checkMinecraftWorldImportSource(instances.directory(instance.id), source);
      const result = await inspectMinecraftWorldArchive(source, signal);
      const targetVersion = instance?.minecraft.version;
      const archive = instance
        ? {
            ...result.archive,
            name: await suggestMinecraftWorldImportName(instances.gamePath(instance.id), result.archive.name, signal),
          }
        : result.archive;
      const versionRisk = targetVersion && minecraftWorldVersionRisk(result.archive.minecraftVersion, targetVersion);
      return { ...result, archive, ...(targetVersion && { targetVersion }), ...(versionRisk && { versionRisk }) };
    },
    importMinecraftWorldArchive: (id, source, digest, name, confirmation, expectedVersion, signal) =>
      withSaves(
        id,
        async (_saves, _roots, instance) => {
          return importMinecraftWorldArchive(
            instances.directory(id),
            instances.gamePath(id),
            source,
            digest,
            name,
            worldImportVersion(instance, expectedVersion),
            confirmation,
            signal,
            options.linuxRenameDirectory,
          );
        },
        true,
      ),
    exportMinecraftWorldArchive: (id, world, destination, signal) =>
      withSaves(
        id,
        async (_saves, _roots, instance) => {
          if (instance.kind !== 'minecraft') throw new Error('Select a Minecraft instance to export a world.');
          return exportMinecraftWorldArchive(instances.gamePath(id), world, destination, signal);
        },
        true,
      ),
    async inspectMinecraftWorldFolder(source, id, signal) {
      const instance = id === undefined ? undefined : await requireMinecraft(id);
      if (instance) await checkMinecraftWorldImportSource(instances.directory(instance.id), source);
      const result = await inspectMinecraftWorldFolder(source, signal);
      const targetVersion = instance?.minecraft.version;
      const folder = instance
        ? {
            ...result.folder,
            name: await suggestMinecraftWorldImportName(instances.gamePath(instance.id), result.folder.name, signal),
          }
        : result.folder;
      const versionRisk = targetVersion && minecraftWorldVersionRisk(result.folder.minecraftVersion, targetVersion);
      return { ...result, folder, ...(targetVersion && { targetVersion }), ...(versionRisk && { versionRisk }) };
    },
    importMinecraftWorldFolder: (id, source, digest, name, confirmation, expectedVersion, signal) =>
      withSaves(
        id,
        async (_saves, _roots, instance) => {
          signal?.throwIfAborted();
          const targetVersion = worldImportVersion(instance, expectedVersion);
          if (session) {
            const active = await instances.find(session.instanceId);
            const roots = await instances.saveRoots(active);
            const canonicalSource = await realpath(source);
            const paths = await Promise.all(roots.map(({ path }) => realpath(path).catch(() => path)));
            if (paths.some((path) => pathOverlaps(path, canonicalSource))) {
              throw new Error('Close the source game before copying its world.');
            }
          }
          return importMinecraftWorldFolder(
            instances.directory(id),
            instances.gamePath(id),
            source,
            digest,
            name,
            targetVersion,
            confirmation,
            signal,
            options.linuxRenameDirectory,
          );
        },
        true,
      ),
    createSnapshot: (id, label, selection) =>
      backup(id, label?.trim() ? humanText(label, 120, 'snapshot label') : undefined, selection),
    setSnapshotPinned: (id, snapshotId, pinned) => withSaveStore(id, (saves) => saves.setPinned(snapshotId, pinned)),
    deleteSnapshot: (id, snapshotId) => withSaveStore(id, (saves) => saves.delete(snapshotId)),
    exportSnapshot: (id, snapshotId, destination) =>
      withSaveStore(id, (saves) => saves.exportSnapshot(snapshotId, destination)),
    importSnapshot: (id, source) =>
      withSaves(
        id,
        (saves, roots, instance) =>
          saves.importSnapshot(source, instance.kind, (selection) => scopedSaveRoots(instance, roots, selection, true)),
        false,
      ),
    previewRestore: (id, snapshotId, choices) =>
      withSaves(
        id,
        async (saves, roots, instance) => {
          const selected = await scopedSaveRoots(instance, roots, await saves.selection(snapshotId), true);
          return saves.preview(snapshotId, selected, instance.minecraft?.version, choices);
        },
        false,
      ),
    restoreSnapshot: (id, snapshotId, confirmation, review) =>
      withSaves(
        id,
        async (saves, roots, instance) =>
          saves.restore(snapshotId, await snapshotContext(instance), confirmation, {
            ...(review && { review }),
            allowedRoots: await scopedSaveRoots(instance, roots, await saves.selection(snapshotId), true),
          }),
        true,
      ),
    listPackages: (kind, q, cursor) => packages.catalog.list(kind, q, cursor),
    listReleases: (id, cursor) => packages.catalog.releases(id, cursor),
    listInstalled(instanceId) {
      return locks.run(instanceId ? instanceLock(instanceId) : 'extensions', async () => {
        if (instanceId) await modTarget(instanceId);
        return (instanceId ? modStore(instanceId) : extensions).views();
      });
    },
    previewCatalogInstall: (ref, instanceId, signal) =>
      instanceId
        ? withInstanceMods(instanceId, (store, target) =>
            packages.previewCatalog(store, ref, { ...target, instanceId }, signal),
          )
        : locks.run('extensions', () => packages.previewCatalog(extensions, ref, undefined, signal), signal),
    listOverlayExtensions: () => locks.run('extensions', async () => overlayExtensionViews(await extensions.list())),
    repairOverlayExtension: (id, revision, signal) =>
      editPackages(undefined, (store) => packages.repairOverlayExtension(store, id, revision, signal)),
    reorderOverlayExtensions: (packageIds, orderRevision) =>
      editPackages(undefined, (store) => packages.reorderOverlayExtensions(store, packageIds, orderRevision)),
    changeOverlayExtension: (id, revision, enabled) => changeInstalledPackage(id, undefined, enabled, revision),
    installPackage: (ref, instanceId) => installCatalogPackage(ref, instanceId),
    installReviewedCatalogPackage: (ref, review, instanceId) => installCatalogPackage(ref, instanceId, review),
    uninstallPackage: (id, instanceId) => changeInstalledPackage(id, instanceId, null),
    setPackageEnabled: (id, enabled, instanceId) => changeInstalledPackage(id, instanceId, enabled),
    async searchMods(id, q) {
      return minecraftMods.search(q, await modTarget(id));
    },
    async modVersions(id, project) {
      return minecraftMods.versions(project, await modTarget(id));
    },
    async previewModInstall(id, versionId, signal) {
      const { store, installed, target } = await withInstanceMods(
        id,
        async (store, target) => ({
          store,
          target,
          installed: await store.list(),
        }),
        signal,
      );
      return minecraftMods.preview(store, installed, versionId, { ...target, instanceId: id }, signal);
    },
    installMod: (id, versionId, revision, control) =>
      editMods(
        id,
        (store, target) => minecraftMods.install(store, versionId, { ...target, instanceId: id }, revision, control),
        control?.signal,
      ),
    previewModState: (id, packageId, enabled) =>
      withInstanceMods(id, (store, target) => store.previewModState({ ...target, instanceId: id }, packageId, enabled)),
    applyModState: (id, packageId, enabled, revision) =>
      withInstanceMods(id, (store, target) =>
        store.applyModState({ ...target, instanceId: id }, packageId, enabled, revision),
      ),
    readMinecraftModFolder: (id) =>
      locks.run(instanceLock(id), async () => {
        const { loader } = await modTarget(id);
        const game = instances.gamePath(id);
        const folder = await existingModFolder(game);
        if (!folder) return { exists: false, files: [], duplicates: [] };
        return inspectModFolder(folder, { instanceId: id, loader }, await committedModNames(id, modStore(id)));
      }),
    setMinecraftManualModEnabled: (id, name, enabled, revision) =>
      withInstanceMods(id, async (store, { loader }) => {
        await store.recover();
        const folder = await existingModFolder(instances.gamePath(id));
        if (!folder) throw new Error('This instance does not have a mods folder yet.');
        return setManualModEnabled(
          folder,
          { instanceId: id, loader },
          await committedModNames(id, store),
          name,
          enabled,
          revision,
        );
      }),
    minecraftModFolder: (id) =>
      locks.run(instanceLock(id), async () => {
        await modTarget(id);
        return existingModFolder(instances.gamePath(id));
      }),
    repairMod: (id, packageId, file) =>
      editMods(id, (store, target) => minecraftMods.repair(store, packageId, target, file)),
    importMod: (id, file) => editMods(id, (store, target) => minecraftMods.importLocal(store, file, target)),
  };
}
