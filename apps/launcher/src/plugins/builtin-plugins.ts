import type {
  BundledGamePanelPlacement,
  BundledPluginEntries,
  BundledPluginId,
  Instance,
  LaunchIssue,
  LocalInstanceInput,
  MinecraftPreparation,
} from '@rezics/launcher-contract';
import type { ComponentType, SVGProps } from 'react';
import type { DesktopApi, Picker } from '../shared/desktop';
import type { PluginDesktopApi } from '../shared/desktop-commands';
import { gameFootprintsFrontend } from './game-footprints';
import { launchDiagnosticsFrontend } from './launch-diagnostics';
import { minecraftFrontend } from './minecraft';
import { visualNovelFrontend } from './visual-novel';

type GamePanelProps<Api> = {
  api: Api;
  instance: Instance;
  running: boolean;
  sessionActive: boolean;
  resolveLaunchIssue: (kind: LaunchIssue['kind']) => Promise<void>;
  preparation: MinecraftPreparation | undefined;
  refresh: () => void;
  openInstance: (instance: Instance) => void;
  openArchive: () => void;
  selectPanel: (id: string, focusId: string) => void;
};

type GamePanel<Api = DesktopApi> = { label: string; Component: ComponentType<GamePanelProps<Api>> };
type LibraryPanel<Api = DesktopApi> = ComponentType<{ api: Api }>;
type Creator<Api> = {
  label: string;
  Component: ComponentType<{
    api: Api;
    done: (instance: Instance) => void;
    cancel: () => void;
  }>;
};

export type LocalImportPaths = Partial<Record<Picker, string>>;
export type LocalImportOptions = Pick<LocalInstanceInput, 'renpySaveName'>;

export type LocalImportFieldProps<Api> = {
  api: Api;
  formId: string;
  paths: LocalImportPaths;
  options: LocalImportOptions;
  onOptionsChange: (options: LocalImportOptions) => void;
  subjectId: string;
  onSubjectChange: (subjectId: string) => void;
  suggestName: (title?: string) => void;
  disabled: boolean;
};

export type LocalImportContribution<Api> = {
  label: string;
  Fields: ComponentType<LocalImportFieldProps<Api>>;
  batch?: { label: string; Component: ComponentType<{ api: Api; back: () => void; done: () => void }> };
  instanceOptions: (options: LocalImportOptions, paths: LocalImportPaths) => LocalImportOptions;
};

type InstancePresentation = {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  canLaunch: (instance: Instance) => boolean;
  metadata: (instance: Instance) => (string | false)[];
};

type BundledFrontendEntries = {
  readonly [Id in BundledPluginId]: BundledPluginEntries[Id] & {
    readonly panels: {
      readonly [Panel in keyof BundledPluginEntries[Id]['manifest']['gamePanels']]: GamePanel<PluginDesktopApi<Id>>;
    };
  } & (BundledPluginEntries[Id]['manifest']['createsInstance'] extends true
      ? { readonly create: Creator<PluginDesktopApi<Id>> }
      : {}) &
    (BundledPluginEntries[Id]['manifest']['contributesLocalImport'] extends true
      ? { readonly localImport: LocalImportContribution<PluginDesktopApi<Id>> }
      : { readonly localImport?: never }) &
    (BundledPluginEntries[Id]['manifest']['libraryPanels'][number] extends never
      ? { readonly libraryPanels?: never }
      : {
          readonly libraryPanels: {
            readonly [Panel in BundledPluginEntries[Id]['manifest']['libraryPanels'][number]]: LibraryPanel<
              PluginDesktopApi<Id>
            >;
          };
        }) &
    (BundledPluginEntries[Id]['manifest']['instanceKind'] extends 'all'
      ? {}
      : { readonly instance: InstancePresentation });
};

export const bundledFrontendPlugins = {
  minecraft: minecraftFrontend,
  'launch-diagnostics': launchDiagnosticsFrontend,
  'visual-novel': visualNovelFrontend,
  'game-footprints': gameFootprintsFrontend,
} satisfies BundledFrontendEntries;

export const bundledInstanceCreators = Object.values(bundledFrontendPlugins).flatMap((entry) =>
  'create' in entry ? [{ id: entry.manifest.id, ...entry.create }] : [],
);

export const bundledLocalImports = Object.values(bundledFrontendPlugins).flatMap((entry) =>
  'localImport' in entry ? [{ kind: entry.manifest.instanceKind, ...entry.localImport }] : [],
);

export const bundledLibraryPanels = Object.values(bundledFrontendPlugins).flatMap((entry) =>
  'libraryPanels' in entry
    ? Object.entries<LibraryPanel>(entry.libraryPanels).map(([id, Component]) => ({
        key: `${entry.manifest.id}:${id}`,
        Component,
      }))
    : [],
);

type RegisteredPanel = GamePanel & { id: string; placement: BundledGamePanelPlacement };

export function bundledGamePanels(instance: Instance): RegisteredPanel[] {
  const result = new Map<string, RegisteredPanel>();
  let hasOverview = false;
  for (const { manifest, panels } of Object.values(bundledFrontendPlugins)) {
    if (manifest.instanceKind !== 'all' && manifest.instanceKind !== instance.kind) continue;
    const placements: Readonly<Record<string, BundledGamePanelPlacement>> = manifest.gamePanels;
    for (const [id, panel] of Object.entries<GamePanel>(panels)) {
      const placement = placements[id];
      if (!placement || result.has(id) || (placement === 'overview' && hasOverview)) {
        throw new Error(`Invalid bundled game panel: ${id}`);
      }
      hasOverview ||= placement === 'overview';
      result.set(id, { ...panel, id, placement });
    }
  }
  return [...result.values()];
}

export function bundledInstancePresentation(instance: Instance): InstancePresentation | undefined {
  for (const entry of Object.values(bundledFrontendPlugins)) {
    if ('instance' in entry && entry.manifest.instanceKind === instance.kind) return entry.instance;
  }
}
