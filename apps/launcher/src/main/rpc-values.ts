import {
  isOverlayShortcut,
  isVisualNovelSaveRoot,
  minecraftLoaderNames,
  maxMinecraftWorldSelection,
  visualNovelSaveRoots,
  type MinecraftInstanceInput,
  type MinecraftLoader,
  type MinecraftSettingsPatch,
  type OverlayPreferences,
  type ReleaseRef,
  type SaveRestoreReview,
  type SaveSelection,
  type VisualNovelRestoreChoice,
  type VisualNovelSettingsPatch,
} from '@rezics/launcher-contract';

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value as Record<string, unknown>;
}

export function text(value: unknown, max = 256, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    throw new Error('A required field is empty or too long.');
  }
  return value;
}

export function optionalText(value: unknown, max = 256): string | undefined {
  if (value === undefined || value === '') return;
  return text(value, max);
}

export function catalogKind(value: unknown) {
  if (value !== 'overlay-panel' && value !== 'minecraft-mod') throw new Error('Choose a package category.');
  return value;
}

export function releaseReference({ packageId, releaseId }: Record<string, unknown>): ReleaseRef {
  return { packageId: text(packageId), releaseId: text(releaseId) };
}

export function packageEnabled(value: unknown) {
  if (typeof value !== 'boolean') throw new Error('Choose whether to enable the package.');
  return value;
}

export function overlayPackageIds(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Supply the Overlay extension IDs in display order.');
  return value.map((id) => text(id));
}

type VisualNovelPathField = 'executable' | 'workingDirectory' | 'saveDirectory';
const visualNovelFields = ['name', 'executable', 'workingDirectory', 'saveDirectory', 'renpySaveName', 'subjectId'];

export function visualNovelSettingsPatch(
  value: unknown,
  path: (value: unknown, field: VisualNovelPathField) => string,
): VisualNovelSettingsPatch {
  const fields = record(value);
  if (Object.keys(fields).some((field) => !visualNovelFields.includes(field))) {
    throw new Error('Unknown visual novel setting.');
  }
  const patch: VisualNovelSettingsPatch = {};
  if (fields.name !== undefined) patch.name = text(fields.name, 120);
  if (fields.executable !== undefined) patch.executable = path(fields.executable, 'executable');
  for (const field of ['workingDirectory', 'saveDirectory'] as const) {
    if (fields[field] !== undefined) patch[field] = fields[field] === null ? null : path(fields[field], field);
  }
  if (fields.renpySaveName !== undefined) {
    patch.renpySaveName = fields.renpySaveName === null ? null : text(fields.renpySaveName, 120);
  }
  if (fields.subjectId !== undefined) patch.subjectId = fields.subjectId === null ? null : text(fields.subjectId, 36);
  return patch;
}

export function visualNovelSettingsReview(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('Read the current visual novel settings before editing them.');
  }
  return value;
}

export function overlayShortcut(value: unknown) {
  if (!isOverlayShortcut(value)) throw new Error('Choose an available Overlay shortcut.');
  return value;
}

export function overlayPreferencesPatch(value: unknown): Partial<OverlayPreferences> {
  const fields = record(value);
  const keys = Object.keys(fields);
  if (!keys.length || keys.some((key) => key !== 'enabled' && key !== 'shortcut')) {
    throw new Error('Supply at least one supported Overlay setting.');
  }
  const { enabled } = fields;
  if (Object.hasOwn(fields, 'enabled') && typeof enabled !== 'boolean') {
    throw new Error('Choose whether Overlay starts with games.');
  }
  return {
    ...(typeof enabled === 'boolean' && { enabled }),
    ...(Object.hasOwn(fields, 'shortcut') && { shortcut: overlayShortcut(fields.shortcut) }),
  };
}

export function exactWorldId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 255) {
    throw new Error('Choose a valid Minecraft world.');
  }
  return value;
}

export function copyWorldIds(value: unknown, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maxMinecraftWorldSelection) {
    throw new Error(
      allowEmpty
        ? `Choose up to ${maxMinecraftWorldSelection} worlds to copy.`
        : `Choose between 1 and ${maxMinecraftWorldSelection} worlds to copy.`,
    );
  }
  return value.map(exactWorldId);
}

export function copyMinecraftWorlds(value: unknown) {
  if (typeof value !== 'boolean') throw new Error('Choose whether to copy the current worlds.');
  return value;
}

export function archivedMinecraftRevision(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('Review the archived instance before deleting it.');
  }
  return value;
}

export function worldVersionConfirmation(value: unknown) {
  if (value === undefined) return;
  const { worldVersion, targetVersion } = record(value);
  return { worldVersion: text(worldVersion, 32), targetVersion: text(targetVersion, 32) };
}

export function subject(fields: Record<string, unknown>): { subjectId?: string } {
  const subjectId = optionalText(fields.subjectId);
  return subjectId === undefined ? {} : { subjectId };
}

export function minecraftLoader(value: unknown): MinecraftLoader {
  if (typeof value !== 'string' || !Object.hasOwn(minecraftLoaderNames, value)) {
    throw new Error('Choose a supported Minecraft loader.');
  }
  return value as MinecraftLoader;
}

export function minecraftInstance(value: unknown): MinecraftInstanceInput {
  const fields = record(value);
  const loader = minecraftLoader(fields.loader);
  const versions = ['version', 'fabricVersion', 'forgeVersion', 'neoForgeVersion'] as const;
  const selection = Object.fromEntries(
    versions.flatMap((field) => {
      const chosen = optionalText(fields[field], 64);
      return chosen === undefined ? [] : [[field, chosen]];
    }),
  );
  return {
    loader,
    name: text(fields.name, 160),
    ...selection,
    ...subject(fields),
  };
}

export function minecraftSettings(value: unknown): MinecraftSettingsPatch {
  const { useManagedJava, maxMemoryMiB, accountId } = record(value);
  if (useManagedJava !== undefined && typeof useManagedJava !== 'boolean') throw new Error('Choose a Java policy.');
  if (maxMemoryMiB !== undefined && maxMemoryMiB !== null && typeof maxMemoryMiB !== 'number') {
    throw new Error('Enter a memory limit in MiB.');
  }
  return {
    ...(useManagedJava !== undefined && { useManagedJava }),
    ...(maxMemoryMiB !== undefined && { maxMemoryMiB }),
    ...(accountId !== undefined && { accountId: accountId === null ? null : text(accountId, 120) }),
  };
}

export function minecraftPreparationMode(value: unknown) {
  if (value !== 'install' && value !== 'repair') throw new Error('Choose an install or repair operation.');
  return value;
}

export function minecraftUpgradeMode(value: unknown) {
  if (value !== 'in-place' && value !== 'copy') throw new Error('Choose how to prepare the new game version.');
  return value;
}

export function manualModChange({ name, enabled, revision }: Record<string, unknown>) {
  if (typeof enabled !== 'boolean') throw new Error('Choose whether to enable the mod file.');
  return { name: text(name, 255), enabled, revision: text(revision, 64) };
}

export function managedModEnabled(value: unknown) {
  if (typeof value !== 'boolean') throw new Error('Choose whether to enable this mod.');
  return value;
}

export function modReviewRevision(value: unknown, operation: 'installation' | 'change') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Review this mod ${operation} before continuing.`);
  }
  return value;
}

export function reviewRevision(value: unknown, subject: string) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Review the ${subject} before continuing.`);
  }
  return value;
}

export function saveSelection(value: unknown): SaveSelection | undefined {
  if (value === undefined) return;
  const fields = record(value);
  if (fields.kind !== 'world') throw new Error('Choose a Minecraft world.');
  return { kind: 'world', id: exactWorldId(fields.id) };
}

export function pinnedBackup(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Choose whether to keep the snapshot.');
  return value;
}

export function visualNovelRestoreChoices(value: unknown): VisualNovelRestoreChoice[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > visualNovelSaveRoots.length) {
    throw new Error('Choose a destination for each backup folder.');
  }
  return value.map((choice) => {
    const { sourceId, targetId } = record(choice);
    if (!isVisualNovelSaveRoot(sourceId) || (targetId !== null && !isVisualNovelSaveRoot(targetId))) {
      throw new Error('Choose a supported visual novel save location.');
    }
    return { sourceId, targetId };
  });
}

export function saveRestoreReview(value: unknown): SaveRestoreReview {
  if (!value) throw new Error('Preview this backup before restoring it.');
  const { revision, choices } = record(value);
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision)) {
    throw new Error('Preview this backup before restoring it.');
  }
  const selected = visualNovelRestoreChoices(choices);
  return { revision, ...(selected && { choices: selected }) };
}

export function minecraftRestoreConfirmation(value: unknown) {
  if (value === undefined) return;
  const { backupVersion, targetVersion } = record(value);
  return { backupVersion: text(backupVersion, 80), targetVersion: text(targetVersion, 80) };
}
