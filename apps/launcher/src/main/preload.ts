import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, DesktopRpc, RpcResult } from '../shared/desktop';
import { desktopCommands } from '../shared/desktop-commands';
import {
  automaticBackupChannel,
  extensionsChangedChannel,
  footprintRecordingChangedChannel,
  installedChangedChannel,
  launchReportChangedChannel,
  minecraftPreparationChannel,
  minecraftSignInChannel,
  modFolderChangedChannel,
  overlayPreferencesChannel,
  overlayStatusChannel,
  packageInstallProgressChannel,
  rpcChannel,
  saveHistoryChangedChannel,
  sessionChannel,
} from '../shared/desktop';

async function call<K extends keyof DesktopRpc>(
  method: K,
  ...args: Parameters<DesktopRpc[K]>
): Promise<Awaited<ReturnType<DesktopRpc[K]>>> {
  const result: RpcResult<Awaited<ReturnType<DesktopRpc[K]>>> = await ipcRenderer.invoke(rpcChannel, method, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const commands = Object.fromEntries(
  desktopCommands.map((command) => [
    command,
    (...args: Parameters<DesktopRpc[typeof command]>) => call(command, ...args),
  ]),
) as DesktopRpc;

const api: DesktopApi = {
  ...commands,
  onSession: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on(sessionChannel, receive);
    return () => ipcRenderer.removeListener(sessionChannel, receive);
  },
  onOverlayStatus(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on(overlayStatusChannel, receive);
    return () => ipcRenderer.removeListener(overlayStatusChannel, receive);
  },
  onOverlayPreferences(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on(overlayPreferencesChannel, receive);
    return () => ipcRenderer.removeListener(overlayPreferencesChannel, receive);
  },
  onMinecraftSignInChanged(listener) {
    const receive = () => listener();
    ipcRenderer.on(minecraftSignInChannel, receive);
    return () => ipcRenderer.removeListener(minecraftSignInChannel, receive);
  },
  onMinecraftPreparation(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on(minecraftPreparationChannel, receive);
    return () => ipcRenderer.removeListener(minecraftPreparationChannel, receive);
  },
  onPackageInstallProgress(listener) {
    const receive = (_event: Electron.IpcRendererEvent, ...value: Parameters<typeof listener>) => listener(...value);
    ipcRenderer.on(packageInstallProgressChannel, receive);
    return () => ipcRenderer.removeListener(packageInstallProgressChannel, receive);
  },
  onAutomaticBackup(listener) {
    const receive = (_event: Electron.IpcRendererEvent, ...value: Parameters<typeof listener>) => listener(...value);
    ipcRenderer.on(automaticBackupChannel, receive);
    return () => ipcRenderer.removeListener(automaticBackupChannel, receive);
  },
  onLaunchReportChanged(listener) {
    const receive = (_event: Electron.IpcRendererEvent, instanceId: string) => listener(instanceId);
    ipcRenderer.on(launchReportChangedChannel, receive);
    return () => ipcRenderer.removeListener(launchReportChangedChannel, receive);
  },
  onInstalledChanged(listener) {
    const receive = (_event: Electron.IpcRendererEvent, archivedInstanceIds?: readonly string[]) =>
      listener(archivedInstanceIds);
    ipcRenderer.on(installedChangedChannel, receive);
    return () => ipcRenderer.removeListener(installedChangedChannel, receive);
  },
  onSaveHistoryChanged(listener) {
    const receive = (_event: Electron.IpcRendererEvent, instanceId: string) => listener(instanceId);
    ipcRenderer.on(saveHistoryChangedChannel, receive);
    return () => ipcRenderer.removeListener(saveHistoryChangedChannel, receive);
  },
  onModFolderChanged(listener) {
    const receive = (_event: Electron.IpcRendererEvent, instanceId: string) => listener(instanceId);
    ipcRenderer.on(modFolderChangedChannel, receive);
    return () => ipcRenderer.removeListener(modFolderChangedChannel, receive);
  },
  onExtensionsChanged(listener) {
    const receive = () => listener();
    ipcRenderer.on(extensionsChangedChannel, receive);
    return () => ipcRenderer.removeListener(extensionsChangedChannel, receive);
  },
  onFootprintRecordingChanged(listener) {
    const receive = () => listener();
    ipcRenderer.on(footprintRecordingChangedChannel, receive);
    return () => ipcRenderer.removeListener(footprintRecordingChangedChannel, receive);
  },
};
contextBridge.exposeInMainWorld('launcher', api);
