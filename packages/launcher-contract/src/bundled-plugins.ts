export type HostCommandDeclaration =
  | { input: 'none'; runningHost?: true; description?: string }
  | {
      input: 'text' | 'path' | 'json' | 'json-with-base';
      argument?: string;
      runningHost?: true;
      description?: string;
    };

/** Build-time declarations. Executable entries belong to the host and desktop registries. */
export const minecraftPlugin = {
  id: 'minecraft',
  hostCommands: {
    'minecraft-versions': { input: 'none' },
    'minecraft-loaders': { input: 'json' },
    'create-minecraft': { input: 'json' },
    'rename-minecraft': { input: 'json' },
    'duplicate-minecraft': { input: 'json' },
    'archive-minecraft': { input: 'text', argument: 'instance-id' },
    'list-archived-minecraft': { input: 'none' },
    'restore-archived-minecraft': { input: 'text', argument: 'instance-id' },
    'delete-archived-minecraft': { input: 'json' },
    'set-minecraft-settings': { input: 'json' },
    'set-minecraft-java': { input: 'json' },
    'check-minecraft-java': { input: 'text', argument: 'instance-id', description: 'Check the selected Java runtime.' },
    'prepare-minecraft': { input: 'json', runningHost: true },
    'preview-minecraft-version-change': { input: 'json' },
    'start-minecraft-version-change': { input: 'json', runningHost: true },
    'minecraft-preparation': { input: 'text', argument: 'instance-id' },
    'minecraft-preparations': { input: 'none' },
    'cancel-minecraft-preparation': { input: 'json' },
    'start-minecraft-sign-in': { input: 'json', runningHost: true },
    'minecraft-sign-in-status': { input: 'none' },
    'cancel-minecraft-sign-in': { input: 'none' },
    'minecraft-accounts': { input: 'none' },
    'select-minecraft-account': { input: 'text', argument: 'account-id', runningHost: true },
    'forget-minecraft-account': { input: 'text', argument: 'account-id', runningHost: true },
    'minecraft-mod-folder': { input: 'text', argument: 'instance-id' },
    'set-minecraft-mod-file': { input: 'json' },
    'minecraft-mods': { input: 'text', argument: 'instance-id' },
    'search-minecraft-mods': { input: 'json' },
    'minecraft-mod-versions': { input: 'json' },
    'preview-minecraft-mod-install': { input: 'json' },
    'install-minecraft-mod': { input: 'json' },
    'preview-minecraft-mod-state': { input: 'json' },
    'apply-minecraft-mod-state': { input: 'json' },
    'import-minecraft-mod': { input: 'json' },
    'repair-minecraft-mod': { input: 'json' },
    'remove-minecraft-mod': { input: 'json' },
    'search-minecraft-packs': { input: 'json' },
    'minecraft-pack-versions': { input: 'json' },
    'preview-minecraft-pack': { input: 'json' },
    'install-minecraft-pack': { input: 'json' },
    'minecraft-pack': { input: 'text', argument: 'instance-id' },
    'repair-minecraft-pack': { input: 'text', argument: 'instance-id' },
    'export-minecraft-pack': { input: 'json' },
    'preview-minecraft-world': { input: 'json' },
    'import-minecraft-world': { input: 'json' },
    'export-minecraft-world': { input: 'json' },
  } as const satisfies Record<string, HostCommandDeclaration>,
  desktopCommands: [
    'listMinecraftVersions',
    'listFabricVersions',
    'listForgeVersions',
    'listNeoForgeVersions',
    'createMinecraft',
    'renameMinecraft',
    'duplicateMinecraft',
    'archiveMinecraft',
    'listArchivedMinecraft',
    'restoreArchivedMinecraft',
    'deleteArchivedMinecraft',
    'setMinecraftSettings',
    'chooseMinecraftJava',
    'checkMinecraftJava',
    'chooseMinecraftUpgradeJava',
    'previewModrinthPack',
    'searchModrinthPacks',
    'listModrinthPackVersions',
    'previewOnlineModrinthPack',
    'cancelModrinthPackPreview',
    'chooseModrinthPackJava',
    'importModrinthPack',
    'cancelModrinthPackInstallation',
    'currentModrinthPack',
    'repairModrinthPack',
    'exportModrinthPack',
    'prepareMinecraft',
    'startMinecraftPreparation',
    'readMinecraftInPlaceUpgradeBlocker',
    'previewMinecraftWorldCopy',
    'startMinecraftUpgrade',
    'readMinecraftPreparation',
    'activeMinecraftPreparations',
    'readMinecraftPreparationActivity',
    'cancelMinecraftPreparation',
    'beginMinecraftSignIn',
    'readMinecraftSignIn',
    'cancelMinecraftSignIn',
    'openMicrosoftSignIn',
    'minecraftAccount',
    'minecraftAccounts',
    'selectMinecraftAccount',
    'forgetMinecraftAccount',
    'signOutMinecraft',
    'listMinecraftWorlds',
    'previewMinecraftWorld',
    'cancelMinecraftWorldTransfer',
    'discardMinecraftWorldPreview',
    'importMinecraftWorld',
    'exportMinecraftWorldArchive',
    'searchMods',
    'modVersions',
    'previewModInstall',
    'installMod',
    'previewModState',
    'applyModState',
    'readMinecraftModFolder',
    'setMinecraftManualModEnabled',
    'openMinecraftModFolder',
    'repairMod',
    'importMod',
  ],
  instanceKind: 'minecraft',
  createsInstance: true,
  contributesLocalImport: false,
  gamePanels: { overview: 'overview', mods: 'game', packs: 'game', settings: 'game' },
  libraryPanels: [],
  observesGameSessions: false,
} as const;

export const launchDiagnosticsPlugin = {
  id: 'launch-diagnostics',
  hostCommands: {
    'launch-log': { input: 'text', argument: 'instance-id', description: 'Read filtered launch diagnostics.' },
    'launch-report': { input: 'text', argument: 'instance-id', description: 'Read the structured launch outcome.' },
  } as const satisfies Record<string, HostCommandDeclaration>,
  desktopCommands: ['readLaunchReport', 'copyLaunchDiagnostic'],
  instanceKind: 'all',
  createsInstance: false,
  contributesLocalImport: false,
  gamePanels: { logs: 'utility' },
  libraryPanels: [],
  observesGameSessions: false,
} as const;

export const visualNovelPlugin = {
  id: 'visual-novel',
  hostCommands: {
    'search-vn': { input: 'text', argument: 'query' },
    'search-vn-batch': {
      input: 'json',
      description: 'Find public REZICS visual novel candidates for up to 100 queries.',
    },
    'discover-vn': { input: 'path', argument: 'folder' },
    'inspect-vn': { input: 'json-with-base' },
    'import-vn': { input: 'json-with-base' },
    'link-vn': { input: 'json' },
    'read-vn-settings': { input: 'json' },
    'edit-vn': { input: 'json-with-base' },
  } as const satisfies Record<string, HostCommandDeclaration>,
  desktopCommands: [
    'searchVisualNovelSubjects',
    'cancelVisualNovelSubjectSearch',
    'readLinkedVisualNovelSubject',
    'inspectVisualNovel',
    'scanVisualNovelFolder',
    'discardVisualNovelScan',
    'importScannedVisualNovels',
    'readVisualNovelSettings',
    'updateVisualNovelSettings',
  ],
  instanceKind: 'visual-novel',
  createsInstance: false,
  contributesLocalImport: true,
  gamePanels: { overview: 'overview', settings: 'game' },
  libraryPanels: [],
  observesGameSessions: false,
} as const;

export const gameFootprintsPlugin = {
  id: 'game-footprints',
  hostCommands: {
    'footprint-status': { input: 'none', description: 'Read the current local recording setting and error state.' },
    'set-footprint-recording': {
      input: 'json',
      description: 'Set local recording using a JSON object with a boolean enabled field.',
    },
    'export-footprints': {
      input: 'json',
      description: 'Export JSON Lines to a new absolute .jsonl path supplied in the file field.',
    },
  } as const satisfies Record<string, HostCommandDeclaration>,
  desktopCommands: ['footprintStatus', 'setFootprintRecording', 'exportFootprints'],
  instanceKind: 'all',
  createsInstance: false,
  contributesLocalImport: false,
  gamePanels: {},
  libraryPanels: ['game-footprints'],
  observesGameSessions: true,
} as const;

export const bundledPluginManifests = {
  [minecraftPlugin.id]: minecraftPlugin,
  [launchDiagnosticsPlugin.id]: launchDiagnosticsPlugin,
  [visualNovelPlugin.id]: visualNovelPlugin,
  [gameFootprintsPlugin.id]: gameFootprintsPlugin,
};

type BundledPluginManifests = typeof bundledPluginManifests;
export type BundledPluginId = keyof BundledPluginManifests;
export type BundledHostCommand<Id extends BundledPluginId> = keyof BundledPluginManifests[Id]['hostCommands'];
export type BundledGamePanelPlacement = {
  [Id in BundledPluginId]: BundledPluginManifests[Id]['gamePanels'][keyof BundledPluginManifests[Id]['gamePanels']];
}[BundledPluginId];

export type BundledPluginEntries = {
  readonly [Id in BundledPluginId]: { readonly manifest: BundledPluginManifests[Id] };
};

export type CompletedGameSession = {
  sessionId: string;
  startedAt: number;
  elapsedMs: number;
};

export type GameSessionCompletion = (session: CompletedGameSession) => Promise<void>;
export type GameSessionObserver = (subjectId: string | undefined) => Promise<GameSessionCompletion | undefined>;
