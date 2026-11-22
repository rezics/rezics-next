import {
  bundledPluginManifests,
  isDestinationId,
  type BundledPluginId,
  type LocalInstanceInput,
} from '@rezics/launcher-contract';
import { clipboard, dialog, shell, type BrowserWindow } from 'electron';
import { packageInstallProgressChannel, type Picker } from '../shared/desktop';
import { hostDesktopCommands } from '../shared/desktop-commands';
import type { LauncherHost } from './host';
import { createPackageInstallations } from './package-installations';
import { gameFootprintsDesktop } from './plugins/game-footprints';
import { launchDiagnosticsDesktop } from './plugins/launch-diagnostics';
import { minecraftDesktop } from './plugins/minecraft';
import { visualNovelDesktop } from './plugins/visual-novel';
import type { DesktopPluginEntries, DesktopRpcHandlers, HostRpcHandlers, PickSavePath } from './rpc-types';
import {
  catalogKind,
  minecraftRestoreConfirmation,
  optionalText,
  overlayPackageIds,
  overlayPreferencesPatch,
  overlayShortcut,
  packageEnabled,
  pinnedBackup,
  record,
  releaseReference,
  reviewRevision,
  saveRestoreReview,
  saveSelection,
  subject,
  text,
  visualNovelRestoreChoices,
} from './rpc-values';

function declaredHandlers(commands: readonly (keyof DesktopRpcHandlers)[], handlers: Partial<DesktopRpcHandlers>) {
  return commands.map((command) => {
    const handler = handlers[command];
    if (!Object.hasOwn(handlers, command) || typeof handler !== 'function') {
      throw new Error(`Missing desktop command handler: ${command}`);
    }
    return [command, handler] as const;
  });
}

export function createDesktopRpc(
  { core, overlay, importVisualNovels }: Pick<LauncherHost, 'core' | 'overlay' | 'importVisualNovels'>,
  getWindow: () => BrowserWindow | null,
) {
  const selected = new Map<Picker, string>();
  const packageInstalls = createPackageInstallations((attemptId, progress) => {
    const contents = getWindow()?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(packageInstallProgressChannel, attemptId, progress);
  });

  async function pick(options: Electron.OpenDialogOptions) {
    const window = getWindow();
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }

  const savePath: PickSavePath = async (options) => {
    const window = getWindow();
    if (!window) return null;
    const result = await dialog.showSaveDialog(window, options);
    return result.canceled ? null : result.filePath || null;
  };

  function chosen(value: unknown, field: Picker): string {
    if (typeof value !== 'string' || selected.get(field) !== value) {
      throw new Error('Choose the file or folder with the launcher file picker.');
    }
    return value;
  }

  async function importInstance(value: unknown) {
    const fields = record(value);
    const { kind } = fields;
    if (kind !== 'visual-novel' && kind !== 'local') throw new Error('Select a supported game type.');
    const input: LocalInstanceInput = {
      kind,
      name: text(fields.name, 160),
      executable: chosen(fields.executable, 'executable'),
      ...subject(fields),
    };
    if (fields.workingDirectory !== undefined) {
      input.workingDirectory = chosen(fields.workingDirectory, 'workingDirectory');
    }
    if (fields.saveDirectory !== undefined) input.saveDirectory = chosen(fields.saveDirectory, 'saveDirectory');
    if (fields.renpySaveName !== undefined) input.renpySaveName = text(fields.renpySaveName, 160);
    const instance = await core.importInstance(input);
    selected.clear();
    return instance;
  }

  const host: HostRpcHandlers = {
    listInstances: () => core.listInstances(),
    listArchivedInstances: () => core.listArchivedInstances(),
    setLocalGameArchived(id, archived) {
      if (typeof archived !== 'boolean') throw new Error('Choose whether to archive or restore the local game.');
      return core.setLocalGameArchived(text(id), archived);
    },
    overlayStatus: async () => overlay.status(),
    overlayPreferences: async () => overlay.preferences(),
    updateOverlayPreferences: (value) => overlay.updatePreferences(overlayPreferencesPatch(value)),
    restartOverlay: async (id) => overlay.restart(text(id)),
    setOverlayShortcut: (id, shortcut) => overlay.setShortcut(text(id), overlayShortcut(shortcut)),
    async openWebView2Download(id) {
      const sessionId = text(id);
      const status = overlay.status();
      if (status.state !== 'failed' || status.sessionId !== sessionId || status.reason !== 'webview2') {
        throw new Error('WebView2 recovery is unavailable for this game session.');
      }
      await shell.openExternal('https://developer.microsoft.com/en-us/microsoft-edge/webview2/');
    },
    importInstance,
    async openInstanceFolder(id) {
      if (await shell.openPath(await core.instanceFolder(text(id))))
        throw new Error('Could not open the instance folder.');
    },
    launch: (id) => core.launch(text(id)),
    stopGame: (id) => core.stopGame(text(id)),
    currentSession: () => core.currentSession(),
    openDestination(id, destination) {
      if (!isDestinationId(destination)) throw new Error('Select an available REZICS destination.');
      return core.openDestination(text(id), destination);
    },
    openRezicsLibrary: () => core.openRezicsLibrary(),
    openGameInfo: (id) => core.openGameInfo(text(id)),
    listSnapshots: (id) => core.listSnapshots(text(id)),
    readSnapshotHistory: (id) => core.readSnapshotHistory(text(id)),
    lastBackupFailure: (id) => core.lastBackupFailure(text(id)),
    automaticBackupStatus: (id) => core.automaticBackupStatus(text(id)),
    retryAutomaticBackup: (id) => core.retryAutomaticBackup(text(id)),
    createSnapshot: (id, label, selection) =>
      core.createSnapshot(text(id), optionalText(label, 160), saveSelection(selection)),
    setSnapshotPinned: (id, snapshot, pinned) => core.setSnapshotPinned(text(id), text(snapshot), pinnedBackup(pinned)),
    deleteSnapshot: (id, snapshot) => core.deleteSnapshot(text(id), text(snapshot)),
    async exportSnapshot(id, snapshot) {
      const instance = text(id);
      const snapshotId = text(snapshot);
      const folder = await pick({ title: 'Choose where to export the backup', properties: ['openDirectory'] });
      return folder === null ? null : core.exportSnapshot(instance, snapshotId, folder);
    },
    async importSnapshot(id) {
      const instance = text(id);
      const folder = await pick({ title: 'Choose a REZICS backup folder', properties: ['openDirectory'] });
      return folder === null ? null : core.importSnapshot(instance, folder);
    },
    previewRestore: (id, snapshot, choices) =>
      core.previewRestore(text(id), text(snapshot), visualNovelRestoreChoices(choices)),
    restoreSnapshot: (id, snapshot, confirmation, review) =>
      core.restoreSnapshot(
        text(id),
        text(snapshot),
        minecraftRestoreConfirmation(confirmation),
        saveRestoreReview(review),
      ),
    listPackages(kind, query, cursor) {
      return core.listPackages(catalogKind(kind), optionalText(query, 120), optionalText(cursor, 4096));
    },
    listReleases: (id, cursor) => core.listReleases(text(id), optionalText(cursor, 4096)),
    listInstalled: (id) => core.listInstalled(optionalText(id)),
    previewCatalogInstall: (ref, id) => core.previewCatalogInstall(releaseReference(record(ref)), optionalText(id)),
    installReviewedCatalogPackage: (ref, revision, attempt, id) =>
      packageInstalls.run(text(attempt, 64), (control) =>
        core.installReviewedCatalogPackage(
          releaseReference(record(ref)),
          { revision: reviewRevision(revision, 'package installation'), ...control },
          optionalText(id),
        ),
      ),
    cancelPackageInstall: async (attempt) => packageInstalls.cancel(text(attempt, 64)),
    listOverlayExtensions: () => core.listOverlayExtensions(),
    reorderOverlayExtensions: (ids, revision) =>
      core.reorderOverlayExtensions(overlayPackageIds(ids), reviewRevision(revision, 'Overlay extension order')),
    repairOverlayExtension: (id, revision) =>
      core.repairOverlayExtension(text(id), reviewRevision(revision, 'installed Overlay extension')),
    uninstallPackage: (pkg, id) => core.uninstallPackage(text(pkg), optionalText(id)),
    setPackageEnabled: (pkg, enabled, id) =>
      core.setPackageEnabled(text(pkg), packageEnabled(enabled), optionalText(id)),
    async pickPath(kind) {
      if (kind !== 'executable' && kind !== 'workingDirectory' && kind !== 'saveDirectory') {
        throw new Error('Choose a supported file or folder.');
      }
      const file = await pick(
        kind === 'executable'
          ? {
              title: 'Choose a game executable',
              properties: ['openFile'],
              ...(process.platform === 'win32' && { filters: [{ name: 'Executable', extensions: ['exe'] }] }),
            }
          : {
              title: kind === 'workingDirectory' ? 'Choose a working folder' : 'Choose a save folder',
              properties: ['openDirectory'],
            },
      );
      if (file) selected.set(kind, file);
      return file;
    },
  };
  const plugins: DesktopPluginEntries = {
    minecraft: {
      handlers: minecraftDesktop(
        core,
        pick,
        savePath,
        (url) => shell.openExternal(url),
        (path) => shell.openPath(path),
        packageInstalls.run,
      ),
    },
    'launch-diagnostics': { handlers: launchDiagnosticsDesktop(core, (value) => clipboard.writeText(value)) },
    'visual-novel': visualNovelDesktop(core, chosen, () => selected.clear(), pick, importVisualNovels),
    'game-footprints': { handlers: gameFootprintsDesktop(core, savePath) },
  };

  const pluginIds = Object.keys(bundledPluginManifests) as BundledPluginId[];
  const commands = [
    ...declaredHandlers(hostDesktopCommands, host),
    ...pluginIds.flatMap((id) => declaredHandlers(bundledPluginManifests[id].desktopCommands, plugins[id].handlers)),
  ];
  return {
    handlers: Object.fromEntries(commands) as DesktopRpcHandlers,
    abandonRendererRequests() {
      for (const id of pluginIds) plugins[id].abandonRendererRequests?.();
      return packageInstalls.abandon();
    },
  };
}
