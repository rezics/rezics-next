export type SaveSelection = { kind: 'world'; id: string };
export type MinecraftRestoreVersionRisk = { backupVersion: string; targetVersion: string; source?: 'world' };
export type MinecraftWorldVersionRisk = { worldVersion: string; targetVersion: string };
export type MinecraftWorldImportVersionRisk = MinecraftWorldVersionRisk;

export type MinecraftWorld = { id: string; name: string };
export const maxMinecraftWorldSelection = 128;
export type MinecraftWorldPreview = { name: string; files: number; bytes: number; minecraftVersion?: string };
export type MinecraftWorldArchive = MinecraftWorldPreview;
export type AutomaticBackupStatus = { state: 'idle' } | { state: 'running' } | { state: 'failed'; message: string };
