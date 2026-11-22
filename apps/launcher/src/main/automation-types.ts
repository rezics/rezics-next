import type { BundledHostCommand, BundledPluginId, HostCommandDeclaration } from '@rezics/launcher-contract';
import type { Launcher } from '@rezics/launcher-core';
import type { VisualNovelBatchResult } from '../shared/desktop';

export type AutomationResult = {
  value: unknown;
  partial?: boolean;
  installedChanged?: boolean;
  archivedInstanceIds?: string[];
  saveHistoryChanged?: string;
  modFolderChanged?: string;
  extensionsChanged?: boolean;
  footprintRecordingChanged?: boolean;
};

export type AutomationPorts = {
  importVisualNovels(batch: unknown[], base: string): Promise<VisualNovelBatchResult[]>;
};

export type AutomationHandler<Core = Launcher> = {
  run(
    core: Core,
    argument: unknown,
    signal: AbortSignal | undefined,
    ports: AutomationPorts,
  ): Promise<AutomationResult>;
};

export type RegisteredAutomationHandler = AutomationHandler & HostCommandDeclaration;

export type PluginAutomationHandlers<Id extends BundledPluginId, Core = Launcher> = Record<
  BundledHostCommand<Id>,
  AutomationHandler<Core>
>;

export function automationError(error: unknown) {
  return error instanceof Error ? error.message : 'The Launcher host could not complete the command.';
}
