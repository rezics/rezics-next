import type {
  MinecraftInPlaceUpgradeBlocker,
  MinecraftPreparation,
  MinecraftPreparationMode,
  MinecraftUpgradeMode,
} from './minecraft-preparation.ts';
import type {
  AutomaticBackupStatus,
  MinecraftRestoreVersionRisk,
  MinecraftWorld,
  MinecraftWorldArchive,
  MinecraftWorldImportVersionRisk,
  MinecraftWorldVersionRisk,
  MinecraftWorldPreview,
  SaveSelection,
} from './save-management.ts';

export * from './minecraft-preparation.ts';
export * from './save-management.ts';
export * from './bundled-plugins.ts';

export type DestinationId = 'info' | 'guide' | 'community';

export type OverlayPanel = {
  id: string;
  title: string;
  text: string;
  destination?: DestinationId;
};

export type Session = {
  sessionId: string;
  instanceId: string;
  pid: number;
  title: string;
  startedAt: number;
  destinations: { id: DestinationId; label: string }[];
  panels?: OverlayPanel[];
};

export const overlayPanelLimit = 8;
export const overlayFrameLimit = 16_384;
export const overlaySessionFrameLimit = 32_768;
export const overlayShortcutLabels = {
  'ctrl-shift-space': 'Ctrl+Shift+Space',
  'ctrl-shift-f9': 'Ctrl+Shift+F9',
  'ctrl-shift-f10': 'Ctrl+Shift+F10',
} as const;
export type OverlayShortcut = keyof typeof overlayShortcutLabels;
export type OverlayPreferences = { enabled: boolean; shortcut: OverlayShortcut };
export const defaultOverlayShortcut: OverlayShortcut = 'ctrl-shift-space';
export function isOverlayShortcut(value: unknown): value is OverlayShortcut {
  return typeof value === 'string' && Object.hasOwn(overlayShortcutLabels, value);
}

export type OverlayInput = { v: 1; type: 'session'; session: Session | null };
export type OverlayOutput =
  | { v: 1; type: 'ready'; sessionFrameLimit?: typeof overlaySessionFrameLimit; shortcut?: OverlayShortcut }
  | { v: 1; type: 'hotkey-unavailable' }
  | { v: 1; type: 'webview2-unavailable'; runtimeDetected?: true }
  | { v: 1; type: 'session-status'; sessionId: string; attached: boolean }
  | { v: 1; type: 'open-destination'; sessionId: string; destination: DestinationId };

export type LocalInstanceInput = {
  kind: 'visual-novel' | 'local';
  name: string;
  executable: string;
  workingDirectory?: string;
  saveDirectory?: string;
  renpySaveName?: string;
  subjectId?: string;
};

export type VisualNovelInspection = {
  engine: 'renpy' | 'kirikiri' | 'unknown';
  title?: string;
  version?: string;
  saveName?: string;
  gameSaveDirectory?: string;
  detectedSaveDirectory?: string;
};

export type VisualNovelInspectionInput = { executable: string; workingDirectory?: string };
export type VisualNovelInstallation = {
  executable: string;
  workingDirectory: string;
  instance: Instance;
  archived?: true;
};
export type VisualNovelLaunchEvidence = 'renpy-bootstrap' | 'kirikiri-embedded-xp3';
export type VisualNovelDiscovery = {
  root: string;
  installations: {
    directory: string;
    status: 'single' | 'multiple' | 'unrecognized' | 'incomplete';
    recommendedExecutable?: string;
    candidates: {
      executable: string;
      workingDirectory: string;
      metadata: VisualNovelInspection;
      platformMatch: boolean;
      launchEvidence?: VisualNovelLaunchEvidence;
      instance?: Instance;
      archived?: true;
    }[];
  }[];
  errors: { path: string; message: string }[];
};
export const rezicsSubjectIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const maxVisualNovelSubjectQueryLength = 2048;
export type VisualNovelSubjectMatch = { id: string; title: string; type: string };
export type VisualNovelAssociationChange = {
  expectedSubjectId: string | null;
  subjectId: string | null;
};
export type VisualNovelAssociationResult = {
  status: 'changed' | 'unchanged' | 'conflict';
  instance: Instance;
};
export type VisualNovelSettings = Omit<LocalInstanceInput, 'kind'> & {
  revision: string;
  metadata: VisualNovelInspection | null;
};
export type VisualNovelSettingsPatch = {
  name?: string;
  executable?: string;
  workingDirectory?: string | null;
  saveDirectory?: string | null;
  renpySaveName?: string | null;
  subjectId?: string | null;
};
export type VisualNovelSettingsResult = {
  status: 'changed' | 'unchanged' | 'conflict';
  instance: Instance;
  revision: string;
};

export type MinecraftLoader = 'vanilla' | 'fabric' | 'forge' | 'neoforge';

export const minecraftLoaderNames = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
} as const;

export type MinecraftInstanceInput = {
  name: string;
  loader: MinecraftLoader;
  version?: string;
  fabricVersion?: string;
  forgeVersion?: string;
  neoForgeVersion?: string;
  subjectId?: string;
};

export const defaultMinecraftVersion = '1.21.1';
export const defaultFabricVersion = '0.16.14';
export const minecraftReleaseIdPattern = /^(?:0|[1-9]\d{0,3})(?:\.(?:0|[1-9]\d{0,3})){1,2}$/u;

export function isEarlierMinecraftRelease(candidate: string, current: string) {
  if (!minecraftReleaseIdPattern.test(candidate) || !minecraftReleaseIdPattern.test(current)) return false;
  const earlier = candidate.split('.').map(Number);
  const installed = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const left = earlier[index] ?? 0;
    const right = installed[index] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

export type MinecraftVersion = { id: string; latest?: true };
export type MinecraftLoaderVersion = { id: string; stable: boolean };
export type FabricLoaderVersion = MinecraftLoaderVersion;
export type MinecraftSelection =
  | { version: string; loader: 'vanilla' }
  | { version: string; loader: 'fabric'; fabricVersion: string }
  | { version: string; loader: 'forge'; forgeVersion: string }
  | { version: string; loader: 'neoforge'; neoForgeVersion: string };

export function minecraftLoaderVersion(selection: MinecraftSelection): string | undefined {
  switch (selection.loader) {
    case 'vanilla':
      return undefined;
    case 'fabric':
      return selection.fabricVersion;
    case 'forge':
      return selection.forgeVersion;
    case 'neoforge':
      return selection.neoForgeVersion;
  }
}

export function sameMinecraftSelection(left: MinecraftSelection, right: MinecraftSelection): boolean {
  return (
    left.version === right.version &&
    left.loader === right.loader &&
    minecraftLoaderVersion(left) === minecraftLoaderVersion(right)
  );
}

export type MinecraftCustomJava = { kind: 'custom'; executable: string };
export type MinecraftJavaPolicy = { kind: 'managed' } | MinecraftCustomJava;
export type MinecraftJavaStatus = { version: string; requiredMajor: number } & (
  | { state: 'ready'; policy: MinecraftJavaPolicy['kind']; major: number; architecture: string }
  | { state: 'needs-preparation'; policy: 'managed' }
  | { state: 'invalid'; policy: MinecraftJavaPolicy['kind']; action: 'repair' | 'settings'; message: string }
);
export type MinecraftSettings = { java: MinecraftJavaPolicy; maxMemoryMiB?: number; accountId?: string };
export type MinecraftSettingsPatch = {
  useManagedJava?: boolean;
  maxMemoryMiB?: number | null;
  accountId?: string | null;
};
export const minecraftMemoryMiB = { min: 512, max: 32768 } as const;

export type ModrinthPackPreview = {
  name: string;
  versionId: string;
  summary?: string;
  selection: MinecraftSelection;
  files: { path: string; bytes: number; client: 'required' | 'optional' | 'unsupported' }[];
  overrides: { path: string; bytes: number; kind: 'shared' | 'client' }[];
};

export type Instance = {
  id: string;
  name: string;
  kind: 'minecraft' | 'visual-novel' | 'local';
  subjectId?: string;
  minecraft?: MinecraftSelection & { prepared: boolean; settings?: MinecraftSettings };
};

export type ArchivedMinecraftInstance = Instance & { kind: 'minecraft'; revision: string };
export type ArchivedInstance = ArchivedMinecraftInstance | (Instance & { kind: 'local' | 'visual-novel' });
export type LocalGameArchiveChange = { status: 'archived' | 'restored' | 'unchanged'; instance: Instance };

export type RezicsLibraryQuery = {
  kind: 'visual-novels' | 'video-games';
  cursor?: string;
  installedOnly?: boolean;
};
export type RezicsLibraryPage =
  | { status: 'authorization-required' | 'denied' | 'unavailable' | 'installations-unavailable' | 'stale-cursor' }
  | {
      status: 'ready';
      entries: { subjectId: string; title: string | null; installations: Instance[] }[];
      next: string | null;
      metadataUnavailable?: true;
      installationsUnavailable?: true;
    };

export type Snapshot = {
  id: string;
  createdAt: string;
  label?: string;
  selection?: SaveSelection;
  pinned?: boolean;
  files: number;
  bytes: number;
  minecraft?: { version: string; loader: MinecraftLoader; loaderVersion?: string; mods: string[] };
};

export type SnapshotHistory = {
  snapshots: Snapshot[];
  issues: { id: string; reason: 'unavailable' | 'invalid-metadata' }[];
};

export const visualNovelSaveRoots = ['game', 'renpy', 'kirikiri', 'selected'] as const;
export type VisualNovelSaveRoot = (typeof visualNovelSaveRoots)[number];

export function isVisualNovelSaveRoot(value: unknown): value is VisualNovelSaveRoot {
  return visualNovelSaveRoots.some((root) => root === value);
}

export type VisualNovelRestoreChoice = { sourceId: VisualNovelSaveRoot; targetId: VisualNovelSaveRoot | null };
export type SaveRestoreReview = { revision: string; choices?: VisualNovelRestoreChoice[] };

export type RestorePreview = {
  snapshot: Snapshot;
  targets: { path: string; files: number; bytes: number }[];
  review?: SaveRestoreReview;
  minecraftVersionRisk?: MinecraftRestoreVersionRisk;
  visualNovel?: {
    sources: { id: VisualNovelSaveRoot; files: number; bytes: number }[];
    destinations: { id: VisualNovelSaveRoot; path: string }[];
    choices: VisualNovelRestoreChoice[];
  };
};

export type PackageKind = 'overlay-panel' | 'minecraft-mod';
export type CatalogPackage = {
  id: string;
  kind: PackageKind;
  publisher: string;
  title: string;
  summary: string;
  subjectId?: string;
};
export type ReleaseRef = { packageId: string; releaseId: string };
export type CatalogRelease = {
  id: string;
  packageId: string;
  version: string;
  compatibility:
    | { kind: 'overlay-panel'; launcherRange: string }
    | { kind: 'minecraft-mod'; gameVersion: string; loader: 'fabric' };
  artifact: { url: string; size: number; sha256: string };
  requires: ReleaseRef[];
};
export type Page<T> = { items: T[]; nextCursor: string | null };

export type PackageInstallProgress =
  | { phase: 'checking' | 'staging' | 'publishing' }
  | {
      phase: 'downloading' | 'verifying';
      title: string;
      position: number;
      total: number;
      bytes: number;
      totalBytes: number;
    };
export type PackageInstallControl = {
  signal?: AbortSignal;
  beginCommit?: () => void;
  report?: (progress: PackageInstallProgress) => void;
};
export type CatalogInstallReview = PackageInstallControl & { revision: string };
export type CatalogInstallPreview = ReleaseRef & {
  instanceId?: string;
  revision: string;
  changes: (ReleaseRef & {
    title: string;
    version: string;
    installedVersion?: string;
    action: 'install' | 'replace' | 'enable' | 'keep' | 'reinstall';
    enables?: true;
    size: number;
    sha256: string;
    requires: ReleaseRef[];
  })[];
};

export type ModrinthProject = { id: string; title: string; summary: string };
export type ModrinthVersion = { id: string; projectId: string; version: string; title: string };
export type ModrinthInstallPreview = {
  revision: string;
  release: ModrinthVersion;
  changes: (ModrinthVersion & {
    action: 'install' | 'replace' | 'enable' | 'reinstall';
    installedVersion?: string;
    enables?: true;
  })[];
};
export type ModrinthPackRelease = ModrinthVersion & {
  channel: 'release' | 'beta' | 'alpha';
  gameVersions: string[];
  loaders: string[];
  publishedAt: string;
};
export type InstalledPackage = {
  id: string;
  title: string;
  version: string;
  source: 'rezics' | 'modrinth' | 'local';
  releaseId?: string;
  enabled: boolean;
  fileIssue?: 'missing' | 'damaged' | 'unavailable';
};

export type InstalledOverlayExtension = InstalledPackage & {
  releaseId: string;
  revision: string;
  orderRevision: string;
  visible: boolean;
};

export type MinecraftModStatePreview = {
  revision: string;
  enabled: boolean;
  changes: Pick<InstalledPackage, 'id' | 'title' | 'version'>[];
};

export type MinecraftModFolderFile = {
  name: string;
  owner: 'launcher' | 'pack' | 'manual';
  state: 'active' | 'disabled' | 'ignored';
  revision?: string;
} & ({ status: 'identified'; title: string; version: string; ids: string[] } | { status: 'linked' | 'unknown' });

export type MinecraftModFolder = {
  exists: boolean;
  files: MinecraftModFolderFile[];
  duplicates: { id: string; files: string[] }[];
};

export type MinecraftAccount = { id: string; name: string };
export type MinecraftSavedAccount = MinecraftAccount & { state: 'ready' | 'needs-sign-in' };
export type MinecraftAccounts = { activeId: string | null; profiles: MinecraftSavedAccount[]; persistent: boolean };
export type MinecraftSignIn = { url: string; code: string; expiresAt: number };
export type MinecraftSignInStatus =
  | { state: 'idle' | 'requesting' | 'saving' | 'signed-in' }
  | { state: 'waiting'; device: MinecraftSignIn }
  | { state: 'failed'; message: string };

export type LaunchIssue = {
  kind:
    | 'account'
    | 'java'
    | 'memory'
    | 'installation'
    | 'mods'
    | 'modpack'
    | 'saves'
    | 'executable'
    | 'crash'
    | 'unknown';
  action: 'account' | 'settings' | 'mods' | 'packs' | 'repair' | 'saves' | 'none';
  summary: string;
};

export type LaunchReport = {
  state: 'running' | 'exited' | 'failed';
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  error?: string;
  issue?: LaunchIssue;
  crashReport?: { text: string; truncated: boolean };
};

export type ModrinthPackInstallControl = { signal: AbortSignal; beginCommit?: () => void };

export interface LauncherApi {
  footprintStatus(): Promise<{ enabled: boolean; error: string | null }>;
  setFootprintRecording(enabled: boolean): Promise<{ enabled: boolean; error: string | null }>;
  exportFootprints(destination: string, replace?: boolean): Promise<void>;
  listInstances(): Promise<Instance[]>;
  listArchivedInstances(): Promise<ArchivedInstance[]>;
  setLocalGameArchived(instanceId: string, archived: boolean): Promise<LocalGameArchiveChange>;
  importInstance(input: LocalInstanceInput): Promise<Instance>;
  inspectVisualNovel(input: VisualNovelInspectionInput): Promise<VisualNovelInspection>;
  discoverVisualNovels(directory: string, signal?: AbortSignal): Promise<VisualNovelDiscovery>;
  searchVisualNovelSubjects(query: string, signal?: AbortSignal): Promise<VisualNovelSubjectMatch[]>;
  readLinkedVisualNovelSubject(instanceId: string): Promise<VisualNovelSubjectMatch | null>;
  setVisualNovelAssociation(
    instanceId: string,
    change: VisualNovelAssociationChange,
  ): Promise<VisualNovelAssociationResult>;
  readVisualNovelSettings(instanceId: string): Promise<VisualNovelSettings>;
  updateVisualNovelSettings(instanceId: string, patch: VisualNovelSettingsPatch, revision?: string): Promise<Instance>;
  listMinecraftVersions(): Promise<MinecraftVersion[]>;
  listFabricVersions(gameVersion: string): Promise<FabricLoaderVersion[]>;
  listForgeVersions(gameVersion: string): Promise<MinecraftLoaderVersion[]>;
  listNeoForgeVersions(gameVersion: string): Promise<MinecraftLoaderVersion[]>;
  createMinecraft(input: MinecraftInstanceInput): Promise<Instance>;
  renameMinecraft(instanceId: string, name: string): Promise<Instance>;
  duplicateMinecraft(instanceId: string, name: string, copyWorlds: boolean): Promise<Instance>;
  archiveMinecraft(instanceId: string): Promise<void>;
  listArchivedMinecraft(): Promise<ArchivedMinecraftInstance[]>;
  restoreArchivedMinecraft(instanceId: string): Promise<Instance>;
  deleteArchivedMinecraft(instanceId: string, revision: string): Promise<void>;
  setMinecraftSettings(instanceId: string, patch: MinecraftSettingsPatch): Promise<Instance>;
  setMinecraftJava(instanceId: string, executable: string): Promise<Instance>;
  checkMinecraftJava(instanceId: string): Promise<MinecraftJavaStatus>;
  instanceFolder(instanceId: string): Promise<string>;
  inspectModrinthPack(source: string, signal?: AbortSignal): Promise<{ digest: string; preview: ModrinthPackPreview }>;
  searchModrinthPacks(query: string, cursor?: string): Promise<Page<ModrinthProject>>;
  listModrinthPackVersions(projectId: string, cursor?: string): Promise<Page<ModrinthPackRelease>>;
  stageOnlineModrinthPack(
    projectId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<{
    source: string;
    digest: string;
    preview: ModrinthPackPreview;
    release(): Promise<void>;
  }>;
  importModrinthPack(
    source: string,
    digest: string,
    preview: ModrinthPackPreview,
    instanceId?: string,
    control?: ModrinthPackInstallControl,
    java?: MinecraftCustomJava,
  ): Promise<Instance>;
  migrateModrinthPack(
    source: string,
    digest: string,
    preview: ModrinthPackPreview,
    fromInstanceId: string,
    worldIds: string[],
    control?: ModrinthPackInstallControl,
    worldVersionConfirmation?: MinecraftWorldVersionRisk,
    java?: MinecraftCustomJava,
  ): Promise<Instance>;
  currentModrinthPack(instanceId: string): Promise<ModrinthPackPreview | null>;
  repairModrinthPack(instanceId: string, control?: ModrinthPackInstallControl): Promise<number>;
  exportModrinthPack(instanceId: string, destination: string): Promise<string>;
  prepareMinecraft(instanceId: string): Promise<Instance>;
  startMinecraftPreparation(
    instanceId: string,
    mode: Exclude<MinecraftPreparationMode, 'upgrade'>,
  ): Promise<MinecraftPreparation>;
  readMinecraftInPlaceUpgradeBlocker(
    instanceId: string,
    version: string,
  ): Promise<MinecraftInPlaceUpgradeBlocker | null>;
  previewMinecraftWorldCopy(
    instanceId: string,
    targetVersion: string,
    worldIds?: readonly string[],
  ): Promise<MinecraftWorldVersionRisk | null>;
  startMinecraftUpgrade(
    instanceId: string,
    selection: MinecraftSelection,
    mode: MinecraftUpgradeMode,
    worldIds?: readonly string[],
    worldVersionConfirmation?: MinecraftWorldVersionRisk,
    java?: MinecraftJavaPolicy,
    expectedSource?: MinecraftSelection,
  ): Promise<MinecraftPreparation>;
  readMinecraftPreparation(instanceId: string): Promise<MinecraftPreparation | null>;
  activeMinecraftPreparations(): Promise<MinecraftPreparation[]>;
  readMinecraftPreparationActivity(): Promise<MinecraftPreparation[]>;
  cancelMinecraftPreparation(instanceId: string, attemptId?: string): Promise<MinecraftPreparation | null>;
  beginMinecraftSignIn(accountId?: string): Promise<void>;
  readMinecraftSignIn(): Promise<MinecraftSignInStatus>;
  cancelMinecraftSignIn(): Promise<void>;
  minecraftAccount(): Promise<MinecraftAccount | null>;
  minecraftAccounts(): Promise<MinecraftAccounts>;
  selectMinecraftAccount(accountId: string): Promise<void>;
  forgetMinecraftAccount(accountId: string): Promise<void>;
  signOutMinecraft(): Promise<void>;
  launch(instanceId: string): Promise<Session>;
  stopGame(sessionId: string): Promise<void>;
  currentSession(): Promise<Session | null>;
  readLaunchReport(instanceId: string): Promise<LaunchReport | null>;
  launchDiagnosticText(instanceId: string): Promise<string | null>;
  readRezicsLibraryPage(query: RezicsLibraryQuery, signal?: AbortSignal): Promise<RezicsLibraryPage>;
  openRezicsLibrary(): Promise<void>;
  openGameInfo(instanceId: string): Promise<void>;
  openDestination(sessionId: string, destination: DestinationId): Promise<void>;
  listSnapshots(instanceId: string): Promise<Snapshot[]>;
  readSnapshotHistory(instanceId: string): Promise<SnapshotHistory>;
  lastBackupFailure(instanceId: string): Promise<string | null>;
  automaticBackupStatus(instanceId: string): Promise<AutomaticBackupStatus>;
  retryAutomaticBackup(instanceId: string): Promise<Snapshot>;
  listMinecraftWorlds(instanceId: string): Promise<MinecraftWorld[]>;
  inspectMinecraftWorldArchive(
    source: string,
    instanceId?: string,
    signal?: AbortSignal,
  ): Promise<{
    archive: MinecraftWorldArchive;
    digest: string;
    targetVersion?: string;
    versionRisk?: MinecraftWorldImportVersionRisk;
  }>;
  importMinecraftWorldArchive(
    instanceId: string,
    source: string,
    digest: string,
    name: string,
    confirmation?: MinecraftWorldImportVersionRisk,
    expectedVersion?: string,
    signal?: AbortSignal,
  ): Promise<MinecraftWorld>;
  exportMinecraftWorldArchive(
    instanceId: string,
    worldId: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<string>;
  inspectMinecraftWorldFolder(
    source: string,
    instanceId?: string,
    signal?: AbortSignal,
  ): Promise<{
    folder: MinecraftWorldPreview;
    digest: string;
    targetVersion?: string;
    versionRisk?: MinecraftWorldImportVersionRisk;
  }>;
  importMinecraftWorldFolder(
    instanceId: string,
    source: string,
    digest: string,
    name: string,
    confirmation?: MinecraftWorldImportVersionRisk,
    expectedVersion?: string,
    signal?: AbortSignal,
  ): Promise<MinecraftWorld>;
  createSnapshot(instanceId: string, label?: string, selection?: SaveSelection): Promise<Snapshot>;
  setSnapshotPinned(instanceId: string, snapshotId: string, pinned: boolean): Promise<void>;
  deleteSnapshot(instanceId: string, snapshotId: string): Promise<void>;
  exportSnapshot(instanceId: string, snapshotId: string, destinationFolder: string): Promise<string>;
  importSnapshot(instanceId: string, sourceFolder: string): Promise<Snapshot>;
  previewRestore(instanceId: string, snapshotId: string, choices?: VisualNovelRestoreChoice[]): Promise<RestorePreview>;
  restoreSnapshot(
    instanceId: string,
    snapshotId: string,
    confirmation?: MinecraftRestoreVersionRisk,
    review?: SaveRestoreReview,
  ): Promise<void>;
  listPackages(kind: PackageKind, q?: string, cursor?: string): Promise<Page<CatalogPackage>>;
  listReleases(packageId: string, cursor?: string): Promise<Page<CatalogRelease>>;
  listInstalled(instanceId?: string): Promise<InstalledPackage[]>;
  installPackage(ref: ReleaseRef, instanceId?: string): Promise<void>;
  uninstallPackage(packageId: string, instanceId?: string): Promise<void>;
  setPackageEnabled(packageId: string, enabled: boolean, instanceId?: string): Promise<void>;
  searchMods(instanceId: string, q: string): Promise<ModrinthProject[]>;
  modVersions(instanceId: string, projectId: string): Promise<ModrinthVersion[]>;
  previewModInstall(instanceId: string, versionId: string, signal?: AbortSignal): Promise<ModrinthInstallPreview>;
  installMod(instanceId: string, versionId: string, revision?: string, control?: PackageInstallControl): Promise<void>;
  previewModState(instanceId: string, packageId: string, enabled: boolean): Promise<MinecraftModStatePreview>;
  applyModState(instanceId: string, packageId: string, enabled: boolean, revision: string): Promise<void>;
  readMinecraftModFolder(instanceId: string): Promise<MinecraftModFolder>;
  setMinecraftManualModEnabled(
    instanceId: string,
    name: string,
    enabled: boolean,
    revision: string,
  ): Promise<{ name: string; enabled: boolean }>;
  minecraftModFolder(instanceId: string): Promise<string | null>;
  repairMod(instanceId: string, packageId: string, file?: string): Promise<void>;
  importMod(instanceId: string, file: string): Promise<void>;
}

export function isDestinationId(value: unknown): value is DestinationId {
  return value === 'info' || value === 'guide' || value === 'community';
}

export function parseOverlayOutput(frame: string): OverlayOutput | undefined {
  if (new TextEncoder().encode(frame).length > overlayFrameLimit) return;
  try {
    const data: unknown = JSON.parse(frame);
    if (!data || typeof data !== 'object' || !('v' in data) || data.v !== 1 || !('type' in data)) return;
    if (data.type === 'ready') {
      const shortcut = 'shortcut' in data ? data.shortcut : undefined;
      if (shortcut !== undefined && !isOverlayShortcut(shortcut)) return;
      return {
        v: 1,
        type: 'ready',
        ...(shortcut && { shortcut }),
        ...('sessionFrameLimit' in data &&
          data.sessionFrameLimit === overlaySessionFrameLimit && { sessionFrameLimit: overlaySessionFrameLimit }),
      };
    }
    if (data.type === 'hotkey-unavailable') {
      return { v: 1, type: data.type };
    }
    if (data.type === 'webview2-unavailable') {
      return {
        v: 1,
        type: data.type,
        ...('runtimeDetected' in data && data.runtimeDetected === true && { runtimeDetected: true }),
      };
    }
    if (!('sessionId' in data) || typeof data.sessionId !== 'string' || !data.sessionId.trim()) return;
    if (data.type === 'session-status' && 'attached' in data && typeof data.attached === 'boolean') {
      return { v: 1, type: data.type, sessionId: data.sessionId, attached: data.attached };
    }
    if (data.type === 'open-destination' && 'destination' in data && isDestinationId(data.destination)) {
      return { v: 1, type: data.type, sessionId: data.sessionId, destination: data.destination };
    }
  } catch {
    return;
  }
}
