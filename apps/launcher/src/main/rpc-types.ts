import type { BundledPluginId } from '@rezics/launcher-contract';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import type { DesktopRpc } from '../shared/desktop';
import type { HostDesktopCommand, PluginDesktopCommand } from '../shared/desktop-commands';

export type DesktopRpcHandlers = {
  [Command in keyof DesktopRpc]: (...args: unknown[]) => ReturnType<DesktopRpc[Command]>;
};

export type HostRpcHandlers = Pick<DesktopRpcHandlers, HostDesktopCommand>;
export type PluginRpcHandlers<Id extends BundledPluginId> = Pick<DesktopRpcHandlers, PluginDesktopCommand<Id>>;
export type DesktopPluginEntries = {
  [Id in BundledPluginId]: {
    handlers: PluginRpcHandlers<Id>;
    abandonRendererRequests?: () => void;
  };
};

export type PickOpenPath = (options: OpenDialogOptions) => Promise<string | null>;
export type PickSavePath = (options: SaveDialogOptions) => Promise<string | null>;
