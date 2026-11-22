import type { LauncherOptions } from '@rezics/launcher-core';
import type { OverlayPreferences } from '@rezics/launcher-contract';
import { createLauncher, openOverlayPreferences } from '@rezics/launcher-core';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OverlayStatus } from '../shared/desktop';
import { runAutomation, type AutomationRequest } from './automation-commands';
import { visualNovels } from './plugins/visual-novel-automation';
import { listenForAutomation } from './automation-transport';
import { OverlayBridge } from './overlay-bridge';

export type LauncherHostOptions = LauncherOptions & {
  overlayExecutable?: string | undefined;
  onOverlayStatus?: (status: OverlayStatus) => void;
  onOverlayPreferences?: (value: OverlayPreferences) => void;
  automation?: {
    onInstalledChanged?: (archivedInstanceIds?: readonly string[]) => void;
    onSaveHistoryChanged?: (instanceId: string) => void;
    onModFolderChanged?: (instanceId: string) => void;
    onExtensionsChanged?: () => void;
    onFootprintRecordingChanged?: () => void;
    onTerminalQuit?: () => void;
  };
};

export type LauncherHost = Awaited<ReturnType<typeof createLauncherHost>>;

export class LauncherProfileBusyError extends Error {
  constructor(cause: unknown) {
    super('This library is open in another Launcher host. Close that host and retry.', { cause });
  }
}

const commandsWhileQuitting = new Set<AutomationRequest['command']>([
  'quit-host',
  'game-status',
  'stop-game',
  'launch-report',
  'launch-log',
  'list-installed',
  'list-backups',
  'backup-history',
  'read-automatic-backups',
  'minecraft-preparations',
  'minecraft-preparation',
  'cancel-minecraft-preparation',
]);

export async function createLauncherHost({
  overlayExecutable,
  onOverlayStatus,
  onOverlayPreferences,
  automation,
  ...options
}: LauncherHostOptions) {
  await mkdir(options.dataDir, { recursive: true });
  const dataDir = await realpath(options.dataDir);
  const ownership = new DatabaseSync(join(dataDir, 'host.sqlite'));
  try {
    // SQLite releases the write lock if the process exits unexpectedly.
    ownership.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
    const preferences = await openOverlayPreferences(dataDir);
    const core = createLauncher({ ...options, dataDir });
    const overlay = new OverlayBridge(
      overlayExecutable,
      (sessionId, destination) => core.openDestination(sessionId, destination),
      onOverlayStatus,
      preferences,
      onOverlayPreferences,
    );
    const disconnect = core.subscribe((session) => overlay.setSession(session));
    let imports = Promise.resolve();
    const preparationStarts = new Set<Promise<unknown>>();
    let quitPending = false;
    const stopAutomation = automation && (await listenForAutomation(dataDir, automate));
    let closing: Promise<void> | undefined;
    return {
      core,
      overlay,
      automate,
      importVisualNovels,
      requestTerminalQuit,
      waitForTerminalWork,
      close: () => (closing ??= close()),
    };

    async function automate(request: AutomationRequest, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (quitPending && !commandsWhileQuitting.has(request.command)) {
        throw new Error(
          'The terminal host is waiting to quit. You can inspect or stop the current game or preparation.',
        );
      }
      let work = runAutomation(
        { core, overlay, importVisualNovels, requestTerminalQuit, quitPending },
        request,
        signal,
      );
      if (request.command === 'prepare-minecraft' || request.command === 'start-minecraft-version-change') {
        const start = work;
        preparationStarts.add(start);
        work = start.finally(() => preparationStarts.delete(start));
      }
      const result = await work;
      if (result.installedChanged) automation?.onInstalledChanged?.(result.archivedInstanceIds);
      if (result.saveHistoryChanged) automation?.onSaveHistoryChanged?.(result.saveHistoryChanged);
      if (result.modFolderChanged) automation?.onModFolderChanged?.(result.modFolderChanged);
      if (result.extensionsChanged) automation?.onExtensionsChanged?.();
      if (result.footprintRecordingChanged) automation?.onFootprintRecordingChanged?.();
      return result;
    }

    function requestTerminalQuit() {
      const request = automation?.onTerminalQuit;
      if (!request) throw new Error('Use quit-host with a terminal host started by serve.');
      if (quitPending) return;
      quitPending = true;
      request();
    }

    async function waitForTerminalWork() {
      // A preparation accepted before quit can still be acquiring its instance lock.
      await Promise.allSettled(preparationStarts);
      await Promise.all([core.waitForGameWork(), core.waitForPreparationWork()]);
    }

    function importVisualNovels(batch: unknown[], base: string, fromScan?: true) {
      const result = imports.then(async () => {
        const rows = await visualNovels(core, batch, base, { apply: true, ...(fromScan && { fromScan }) });
        if (rows.some(({ status }) => status === 'imported')) automation?.onInstalledChanged?.();
        return rows;
      });
      imports = result.then(
        () => {},
        () => {},
      );
      return result;
    }

    async function close() {
      try {
        await stopAutomation?.();
        await imports;
        if (core.gameWorkState() !== 'idle') await core.waitForGameWork();
        disconnect();
        await overlay.waitForPreferences();
        await Promise.all([overlay.stop(), core.cancelMinecraftSignIn(), core.waitForPreparationWork()]);
      } finally {
        ownership.close();
      }
    }
  } catch (error) {
    ownership.close();
    if (
      error &&
      typeof error === 'object' &&
      (('errcode' in error && error.errcode === 5) || ('code' in error && error.code === 'SQLITE_BUSY'))
    ) {
      throw new LauncherProfileBusyError(error);
    }
    throw error;
  }
}
