import { bundledPluginManifests, type BundledPluginId } from '@rezics/launcher-contract';
import type { DesktopApi, DesktopRpc } from './desktop';

export const hostDesktopCommands = [
  'listInstances',
  'listArchivedInstances',
  'setLocalGameArchived',
  'overlayStatus',
  'overlayPreferences',
  'updateOverlayPreferences',
  'restartOverlay',
  'setOverlayShortcut',
  'openWebView2Download',
  'importInstance',
  'openInstanceFolder',
  'launch',
  'stopGame',
  'currentSession',
  'openDestination',
  'openRezicsLibrary',
  'openGameInfo',
  'listSnapshots',
  'readSnapshotHistory',
  'lastBackupFailure',
  'automaticBackupStatus',
  'retryAutomaticBackup',
  'createSnapshot',
  'setSnapshotPinned',
  'deleteSnapshot',
  'exportSnapshot',
  'importSnapshot',
  'previewRestore',
  'restoreSnapshot',
  'listPackages',
  'listReleases',
  'listInstalled',
  'previewCatalogInstall',
  'installReviewedCatalogPackage',
  'cancelPackageInstall',
  'listOverlayExtensions',
  'reorderOverlayExtensions',
  'repairOverlayExtension',
  'uninstallPackage',
  'setPackageEnabled',
  'pickPath',
] as const satisfies readonly (keyof DesktopRpc)[];

export type HostDesktopCommand = (typeof hostDesktopCommands)[number];
export type PluginDesktopCommand<Id extends BundledPluginId> =
  (typeof bundledPluginManifests)[Id]['desktopCommands'][number];
export type PluginDesktopApi<Id extends BundledPluginId> = Pick<
  DesktopApi,
  HostDesktopCommand | PluginDesktopCommand<Id> | Exclude<keyof DesktopApi, keyof DesktopRpc>
>;

type DeclaredCommand = HostDesktopCommand | PluginDesktopCommand<BundledPluginId>;
type CompleteDesktopCommands = Exclude<keyof DesktopRpc, DeclaredCommand> extends never ? (keyof DesktopRpc)[] : never;

export const desktopCommands = [
  ...hostDesktopCommands,
  ...Object.values(bundledPluginManifests).flatMap(({ desktopCommands }) => desktopCommands),
] satisfies CompleteDesktopCommands;

if (new Set(desktopCommands).size !== desktopCommands.length) {
  throw new Error('Each desktop command must have exactly one owner.');
}
