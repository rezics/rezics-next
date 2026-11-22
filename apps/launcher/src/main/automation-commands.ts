import {
  bundledPluginManifests,
  type BundledHostCommand,
  type BundledPluginId,
  type HostCommandDeclaration,
} from '@rezics/launcher-contract';
import type { Launcher } from '@rezics/launcher-core';
import { isAbsolute } from 'node:path';
import type {
  AutomationHandler,
  AutomationPorts,
  AutomationResult,
  PluginAutomationHandlers,
} from './automation-types';
import { automationError } from './automation-types';
import { catalogCommands } from './catalog-automation';
import type { OverlayBridge } from './overlay-bridge';
import { gameFootprintsCommands } from './plugins/game-footprints';
import { launchDiagnosticsCommands } from './plugins/launch-diagnostics-automation';
import { minecraftCommands } from './plugins/minecraft-automation';
import { visualNovelCommands } from './plugins/visual-novel-automation';
import {
  minecraftRestoreConfirmation,
  optionalText,
  overlayPreferencesPatch,
  overlayShortcut,
  pinnedBackup,
  record,
  saveRestoreReview,
  saveSelection,
  text,
  visualNovelRestoreChoices,
} from './rpc-values';

const hostCommands = {
  'list-installed': { input: 'none' },
  'import-local-game': { input: 'json' },
  'list-archived-local-games': { input: 'none' },
  'archive-local-games': { input: 'json' },
  'restore-archived-local-games': { input: 'json' },
  'game-status': { input: 'none' },
  'start-game': { input: 'text', argument: 'instance-id', runningHost: true },
  'stop-game': { input: 'text', argument: 'session-id' },
  'quit-host': {
    input: 'none',
    runningHost: true,
    description: 'Quit the terminal host after its game or preparation finishes.',
  },
  'restart-overlay': { input: 'text', argument: 'session-id' },
  'overlay-preferences': { input: 'none' },
  'set-overlay-preferences': { input: 'json' },
  'set-overlay-shortcut': { input: 'json' },
  'list-backups': { input: 'text', argument: 'instance-id' },
  'backup-history': { input: 'text', argument: 'instance-id', description: 'List backups and unreadable records.' },
  'read-automatic-backups': { input: 'json', description: 'Read automatic backup status for a batch of instances.' },
  'retry-automatic-backup': { input: 'text', argument: 'instance-id' },
  'list-worlds': { input: 'text', argument: 'instance-id' },
  'create-backup': { input: 'json' },
  'set-backup-pinned': { input: 'json' },
  'delete-backup': { input: 'json' },
  'export-backup': { input: 'json' },
  'import-backup': { input: 'json' },
  'preview-restore': { input: 'json' },
  'restore-backup': { input: 'json' },
} as const satisfies Record<string, HostCommandDeclaration>;

const pluginCommands = {
  minecraft: minecraftCommands,
  'visual-novel': visualNovelCommands,
  'launch-diagnostics': launchDiagnosticsCommands,
  'game-footprints': gameFootprintsCommands,
} satisfies { [Id in BundledPluginId]: PluginAutomationHandlers<Id> };

type PluginCommand = { [Id in BundledPluginId]: BundledHostCommand<Id> }[BundledPluginId];
type AutomationCommand = keyof typeof hostCommands | keyof typeof catalogCommands | PluginCommand;
export type AutomationRequest = { command: AutomationCommand; argument?: unknown };

type RegisteredCommand = { declaration: HostCommandDeclaration; plugin?: BundledPluginId; handler?: AutomationHandler };
const commands = new Map<string, RegisteredCommand>();
function register(name: string, entry: RegisteredCommand) {
  if (commands.has(name)) throw new Error(`Duplicate Launcher command: ${name}.`);
  commands.set(name, entry);
}

for (const [name, declaration] of Object.entries(hostCommands)) register(name, { declaration });
for (const [name, { run, ...declaration }] of Object.entries(catalogCommands)) {
  register(name, { declaration, handler: { run } });
}
for (const plugin of Object.keys(bundledPluginManifests) as BundledPluginId[]) {
  const declarations: Record<string, HostCommandDeclaration> = bundledPluginManifests[plugin].hostCommands;
  const handlers: Partial<Record<string, AutomationHandler>> = pluginCommands[plugin];
  for (const name of Object.keys(handlers)) {
    if (!Object.hasOwn(declarations, name)) throw new Error(`Undeclared Launcher command: ${name}.`);
  }
  for (const [name, declaration] of Object.entries(declarations)) {
    const handler = handlers[name];
    if (!Object.hasOwn(handlers, name) || typeof handler?.run !== 'function') {
      throw new Error(`Missing Launcher command handler: ${name}.`);
    }
    register(name, { declaration, handler, plugin });
  }
}

export function isAutomationCommand(command: unknown): command is AutomationCommand {
  return typeof command === 'string' && commands.has(command);
}

export function automationDeclaration(command: AutomationCommand) {
  return commands.get(command)!.declaration;
}

export function describeAutomationCommands() {
  return [...commands].map(([name, { declaration, plugin }]) => ({ name, ...declaration, ...(plugin && { plugin }) }));
}

export function automationNeedsRunningHost(command: AutomationCommand) {
  return automationDeclaration(command).runningHost === true;
}

async function runInstanceBatch<T>(argument: unknown, run: (instanceId: string) => Promise<T>, signal?: AbortSignal) {
  if (!Array.isArray(argument)) throw new Error('Supply a JSON array of objects with an instanceId.');
  const value = [];
  let partial = false;
  for (const [index, row] of argument.entries()) {
    signal?.throwIfAborted();
    let instanceId: string | undefined;
    try {
      instanceId = text(record(row).instanceId, 120);
      value.push({ index, instanceId, ...(await run(instanceId)) });
    } catch (error) {
      partial = true;
      value.push({
        index,
        ...(instanceId && { instanceId }),
        status: 'error' as const,
        message: automationError(error),
      });
    }
  }
  return { value, partial };
}

async function changeLocalGameArchive(core: Launcher, argument: unknown, archived: boolean) {
  const { value, partial } = await runInstanceBatch(argument, (id) => core.setLocalGameArchived(id, archived));
  const changed = value.filter(({ status }) => status === 'archived' || status === 'restored');
  const archivedInstanceIds = changed.flatMap(({ status, instanceId }) =>
    status === 'archived' && instanceId ? [instanceId] : [],
  );
  const installedChanged = changed.length > 0;
  return { value, partial, installedChanged, ...(archivedInstanceIds.length && { archivedInstanceIds }) };
}

export async function runAutomation(
  {
    core,
    overlay,
    requestTerminalQuit,
    quitPending,
    ...ports
  }: {
    core: Launcher;
    overlay: Pick<OverlayBridge, 'status' | 'restart' | 'setShortcut' | 'preferences' | 'updatePreferences'>;
    requestTerminalQuit(): void;
    quitPending: boolean;
  } & AutomationPorts,
  { command, argument }: AutomationRequest,
  signal?: AbortSignal,
): Promise<AutomationResult> {
  const handler = commands.get(command)?.handler;
  if (handler) return handler.run(core, argument, signal, ports);
  switch (command) {
    case 'list-installed':
      return { value: await core.listInstances() };
    case 'import-local-game': {
      const input = record(argument);
      const value = await core.importInstance({
        kind: 'local',
        name: text(input.name, 120),
        executable: text(input.executable, 32_767),
        ...('workingDirectory' in input && { workingDirectory: text(input.workingDirectory, 32_767) }),
        ...('saveDirectory' in input && { saveDirectory: text(input.saveDirectory, 32_767) }),
        ...('subjectId' in input && { subjectId: text(input.subjectId, 36) }),
      });
      return { value, installedChanged: true };
    }
    case 'list-archived-local-games':
      return { value: (await core.listArchivedInstances()).filter(({ kind }) => kind !== 'minecraft') };
    case 'archive-local-games':
      return changeLocalGameArchive(core, argument, true);
    case 'restore-archived-local-games':
      return changeLocalGameArchive(core, argument, false);
    case 'game-status': {
      const work = core.gameWorkState();
      const overlayStatus = overlay.status();
      return {
        value: {
          work,
          session: await core.currentSession(),
          overlay: overlayStatus,
          ...(quitPending && { quitPending }),
        },
      };
    }
    case 'start-game':
      return { value: await core.launch(text(argument)) };
    case 'stop-game': {
      const sessionId = text(argument);
      await core.stopGame(sessionId);
      return { value: { status: 'stopped', sessionId } };
    }
    case 'quit-host':
      requestTerminalQuit();
      return { value: { status: 'quitting' } };
    case 'restart-overlay':
      overlay.restart(text(argument));
      return { value: overlay.status() };
    case 'overlay-preferences':
      return { value: overlay.preferences() };
    case 'set-overlay-preferences':
      return { value: await overlay.updatePreferences(overlayPreferencesPatch(argument)) };
    case 'set-overlay-shortcut': {
      const { sessionId, shortcut } = record(argument);
      await overlay.setShortcut(text(sessionId), overlayShortcut(shortcut));
      return { value: overlay.status() };
    }
    case 'list-backups':
      return { value: await core.listSnapshots(text(argument)) };
    case 'backup-history': {
      const value = await core.readSnapshotHistory(text(argument));
      return { value, partial: value.issues.length > 0 };
    }
    case 'read-automatic-backups':
      return runInstanceBatch(
        argument,
        async (id) => ({ status: 'ready', backup: await core.automaticBackupStatus(id) }),
        signal,
      );
    case 'retry-automatic-backup': {
      const instanceId = text(argument);
      return { value: await core.retryAutomaticBackup(instanceId), saveHistoryChanged: instanceId };
    }
    case 'list-worlds':
      return { value: await core.listMinecraftWorlds(text(argument)) };
    case 'create-backup': {
      const fields = record(argument);
      const instanceId = text(fields.instanceId);
      const value = await core.createSnapshot(
        instanceId,
        optionalText(fields.label, 160),
        saveSelection(fields.selection),
      );
      return { value, saveHistoryChanged: instanceId };
    }
    case 'set-backup-pinned': {
      const fields = record(argument);
      const instanceId = text(fields.instanceId);
      const snapshotId = text(fields.snapshotId);
      const pinned = pinnedBackup(fields.pinned);
      await core.setSnapshotPinned(instanceId, snapshotId, pinned);
      return { value: { instanceId, snapshotId, pinned }, saveHistoryChanged: instanceId };
    }
    case 'delete-backup': {
      const fields = record(argument);
      const instanceId = text(fields.instanceId);
      const snapshotId = text(fields.snapshotId);
      await core.deleteSnapshot(instanceId, snapshotId);
      return { value: { status: 'deleted', instanceId, snapshotId }, saveHistoryChanged: instanceId };
    }
    case 'export-backup':
    case 'import-backup': {
      const fields = record(argument);
      const instanceId = text(fields.instanceId);
      const folder = text(fields.folder, 32_767);
      if (!isAbsolute(folder)) throw new Error('Supply an absolute backup folder path.');
      if (command === 'export-backup') {
        return { value: { path: await core.exportSnapshot(instanceId, text(fields.snapshotId), folder) } };
      }
      return { value: await core.importSnapshot(instanceId, folder), saveHistoryChanged: instanceId };
    }
    case 'preview-restore': {
      const fields = record(argument);
      const value = await core.previewRestore(
        text(fields.instanceId),
        text(fields.snapshotId),
        visualNovelRestoreChoices(fields.choices),
      );
      return { value };
    }
    case 'restore-backup': {
      const fields = record(argument);
      const instanceId = text(fields.instanceId);
      const snapshotId = text(fields.snapshotId);
      await core.restoreSnapshot(
        instanceId,
        snapshotId,
        minecraftRestoreConfirmation(fields.confirmation),
        saveRestoreReview(fields.review),
      );
      return { value: { status: 'restored', instanceId, snapshotId }, saveHistoryChanged: instanceId };
    }
  }
  throw new Error('This Launcher command is unavailable.');
}
