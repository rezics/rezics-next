import type {
  AutomaticBackupStatus,
  CatalogInstallPreview,
  Instance,
  InstalledOverlayExtension,
  LauncherApi,
  LocalInstanceInput,
  MinecraftCustomJava,
  MinecraftWorld,
  MinecraftWorldPreview,
  MinecraftWorldImportVersionRisk,
  MinecraftWorldVersionRisk,
  MinecraftPreparation,
  MinecraftRestoreVersionRisk,
  ModrinthPackPreview,
  OverlayPreferences,
  OverlayShortcut,
  PackageInstallProgress,
  ReleaseRef,
  SaveRestoreReview,
  Session,
  Snapshot,
  VisualNovelDiscovery,
  VisualNovelInspection,
  VisualNovelSubjectMatch,
} from '@rezics/launcher-contract';

export type Picker = 'executable' | 'workingDirectory' | 'saveDirectory';

type VisualNovelDirectory = VisualNovelDiscovery['installations'][number];
export type DesktopVisualNovelCandidate = VisualNovelDirectory['candidates'][number] & {
  id: number;
};
export type DesktopVisualNovelScan = Omit<VisualNovelDiscovery, 'installations'> & {
  token: string;
  installations: (Omit<VisualNovelDirectory, 'candidates'> & { candidates: DesktopVisualNovelCandidate[] })[];
};
export type VisualNovelBatchResult =
  | { status: 'error'; index: number; executable?: string; message: string }
  | (Omit<LocalInstanceInput, 'kind'> & {
      index: number;
      workingDirectory: string;
      metadata: VisualNovelInspection;
    } & ({ status: 'inspected' } | { status: 'imported' | 'existing' | 'archived'; instance: Instance }));

export type DesktopPackPreview = { token: string; preview: ModrinthPackPreview };
export type WorldImportSource = 'folder' | 'zip';
export type DesktopWorldPreview = {
  token: string;
  world: MinecraftWorldPreview;
  versionRisk?: MinecraftWorldImportVersionRisk;
};
export type PackDestination =
  | 'new-instance'
  | { kind: 'copy-worlds'; worldIds: string[]; worldVersionConfirmation?: MinecraftWorldVersionRisk };
export type OverlayFailure =
  | 'missing'
  | 'hotkey'
  | 'shortcut-mismatch'
  | 'webview2'
  | 'webview2-startup'
  | 'startup'
  | 'timeout'
  | 'exited'
  | 'session';
export type OverlayStatus =
  | { state: 'inactive' }
  | ({ sessionId: string; shortcut: OverlayShortcut } & (
      | { state: 'starting' }
      | { state: 'ready' }
      | { state: 'disabled' }
      | { state: 'failed'; reason: OverlayFailure }
    ));

export type DesktopApi = Omit<
  LauncherApi,
  | 'importMod'
  | 'installMod'
  | 'previewModInstall'
  | 'repairMod'
  | 'importInstance'
  | 'discoverVisualNovels'
  | 'searchVisualNovelSubjects'
  | 'setVisualNovelAssociation'
  | 'readRezicsLibraryPage'
  | 'installPackage'
  | 'exportSnapshot'
  | 'importSnapshot'
  | 'restoreSnapshot'
  | 'inspectMinecraftWorldArchive'
  | 'importMinecraftWorldArchive'
  | 'inspectMinecraftWorldFolder'
  | 'importMinecraftWorldFolder'
  | 'exportMinecraftWorldArchive'
  | 'setMinecraftJava'
  | 'instanceFolder'
  | 'minecraftModFolder'
  | 'inspectModrinthPack'
  | 'stageOnlineModrinthPack'
  | 'importModrinthPack'
  | 'migrateModrinthPack'
  | 'repairModrinthPack'
  | 'exportModrinthPack'
  | 'exportFootprints'
  | 'launchDiagnosticText'
> & {
  previewCatalogInstall(ref: ReleaseRef, instanceId?: string): Promise<CatalogInstallPreview>;
  installReviewedCatalogPackage(
    ref: ReleaseRef,
    revision: string,
    attemptId: string,
    instanceId?: string,
  ): Promise<boolean>;
  cancelPackageInstall(attemptId: string): Promise<boolean>;
  listOverlayExtensions(): Promise<InstalledOverlayExtension[]>;
  reorderOverlayExtensions(packageIds: string[], orderRevision: string): Promise<void>;
  repairOverlayExtension(packageId: string, revision: string): Promise<void>;
  exportFootprints(): Promise<boolean>;
  importInstance(input: LocalInstanceInput): Promise<Awaited<ReturnType<LauncherApi['importInstance']>>>;
  scanVisualNovelFolder(requestId: string): Promise<DesktopVisualNovelScan | null>;
  discardVisualNovelScan(requestId: string): Promise<void>;
  importScannedVisualNovels(token: string, candidateIds: number[]): Promise<VisualNovelBatchResult[]>;
  searchVisualNovelSubjects(query: string, requestId?: string): Promise<VisualNovelSubjectMatch[]>;
  cancelVisualNovelSubjectSearch(requestId: string): Promise<void>;
  importMod(instanceId: string): Promise<boolean>;
  previewModInstall(instanceId: string, versionId: string): ReturnType<LauncherApi['previewModInstall']>;
  installMod(instanceId: string, versionId: string, revision: string, attemptId: string): Promise<boolean>;
  repairMod(instanceId: string, packageId: string, fromFile: boolean): Promise<boolean>;
  exportSnapshot(instanceId: string, snapshotId: string): Promise<string | null>;
  importSnapshot(instanceId: string): Promise<Snapshot | null>;
  restoreSnapshot(
    instanceId: string,
    snapshotId: string,
    confirmation: MinecraftRestoreVersionRisk | undefined,
    review: SaveRestoreReview,
  ): Promise<void>;
  previewMinecraftWorld(
    instanceId: string,
    kind: WorldImportSource,
    attemptId?: string,
  ): Promise<DesktopWorldPreview | null>;
  cancelMinecraftWorldTransfer(attemptId: string): Promise<void>;
  discardMinecraftWorldPreview(token: string): Promise<void>;
  importMinecraftWorld(
    token: string,
    name: string,
    confirmNewerWorld?: boolean,
    attemptId?: string,
  ): Promise<MinecraftWorld | null>;
  exportMinecraftWorldArchive(instanceId: string, worldId: string, attemptId?: string): Promise<string | null>;
  chooseMinecraftJava(instanceId: string): Promise<Instance | null>;
  chooseMinecraftUpgradeJava(instanceId: string, version: string): Promise<MinecraftCustomJava | null>;
  openInstanceFolder(instanceId: string): Promise<void>;
  openMinecraftModFolder(instanceId: string): Promise<void>;
  previewModrinthPack(instanceId?: string): Promise<DesktopPackPreview | null>;
  previewOnlineModrinthPack(
    projectId: string,
    versionId: string,
    instanceId?: string,
  ): Promise<DesktopPackPreview | null>;
  cancelModrinthPackPreview(): Promise<void>;
  chooseModrinthPackJava(token: string): Promise<MinecraftCustomJava | null>;
  importModrinthPack(
    token: string,
    destination?: PackDestination,
    attemptId?: string,
    useSelectedJava?: boolean,
  ): Promise<Instance | null>;
  cancelModrinthPackInstallation(token: string, attemptId: string): Promise<boolean>;
  repairModrinthPack(instanceId: string, attemptId: string): Promise<number | null>;
  exportModrinthPack(instanceId: string): Promise<boolean>;
  pickPath(kind: Picker): Promise<string | null>;
  overlayStatus(): Promise<OverlayStatus>;
  overlayPreferences(): Promise<OverlayPreferences>;
  updateOverlayPreferences(patch: Partial<OverlayPreferences>): Promise<OverlayPreferences>;
  restartOverlay(sessionId: string): Promise<void>;
  setOverlayShortcut(sessionId: string, shortcut: OverlayShortcut): Promise<void>;
  openWebView2Download(sessionId: string): Promise<void>;
  openMicrosoftSignIn(): Promise<void>;
  copyLaunchDiagnostic(instanceId: string): Promise<boolean>;
  onSession(listener: (session: Session | null) => void): () => void;
  onOverlayStatus(listener: (value: OverlayStatus) => void): () => void;
  onOverlayPreferences(listener: (value: OverlayPreferences) => void): () => void;
  onMinecraftSignInChanged(listener: () => void): () => void;
  onMinecraftPreparation(listener: (preparation: MinecraftPreparation) => void): () => void;
  onPackageInstallProgress(listener: (attemptId: string, progress: PackageInstallProgress) => void): () => void;
  onAutomaticBackup(listener: (instanceId: string, status: AutomaticBackupStatus) => void): () => void;
  onLaunchReportChanged(listener: (instanceId: string) => void): () => void;
  onInstalledChanged(listener: (archivedInstanceIds?: readonly string[]) => void): () => void;
  onSaveHistoryChanged(listener: (instanceId: string) => void): () => void;
  onModFolderChanged(listener: (instanceId: string) => void): () => void;
  onExtensionsChanged(listener: () => void): () => void;
  onFootprintRecordingChanged(listener: () => void): () => void;
};

export type DesktopRpc = Omit<
  DesktopApi,
  | 'onSession'
  | 'onOverlayStatus'
  | 'onOverlayPreferences'
  | 'onMinecraftSignInChanged'
  | 'onMinecraftPreparation'
  | 'onPackageInstallProgress'
  | 'onAutomaticBackup'
  | 'onLaunchReportChanged'
  | 'onInstalledChanged'
  | 'onSaveHistoryChanged'
  | 'onModFolderChanged'
  | 'onExtensionsChanged'
  | 'onFootprintRecordingChanged'
>;
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: string };
export const rpcChannel = 'rezics-launcher:call';
export const sessionChannel = 'rezics-launcher:session';
export const overlayStatusChannel = 'rezics-launcher:overlay-status';
export const overlayPreferencesChannel = 'rezics-launcher:overlay-preferences';
export const minecraftSignInChannel = 'rezics-launcher:minecraft-sign-in';
export const minecraftPreparationChannel = 'rezics-launcher:minecraft-preparation';
export const packageInstallProgressChannel = 'rezics-launcher:package-install-progress';
export const automaticBackupChannel = 'rezics-launcher:automatic-backup';
export const launchReportChangedChannel = 'rezics-launcher:launch-report-changed';
export const installedChangedChannel = 'rezics-launcher:installed-changed';
export const saveHistoryChangedChannel = 'rezics-launcher:save-history-changed';
export const modFolderChangedChannel = 'rezics-launcher:mod-folder-changed';
export const extensionsChangedChannel = 'rezics-launcher:extensions-changed';
export const footprintRecordingChangedChannel = 'rezics-launcher:footprint-recording-changed';
