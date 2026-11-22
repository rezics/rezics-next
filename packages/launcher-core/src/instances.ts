import {
  defaultFabricVersion,
  defaultMinecraftVersion,
  rezicsSubjectIdPattern,
  type ArchivedInstance,
  type ArchivedMinecraftInstance,
  type Instance,
  type LocalGameArchiveChange,
  type LocalInstanceInput,
  type MinecraftInstanceInput,
  type MinecraftSelection,
  type MinecraftSettings,
  type MinecraftWorldVersionRisk,
  type ModrinthPackInstallControl,
  type VisualNovelInspection,
  type VisualNovelInspectionInput,
  type VisualNovelInstallation,
  type VisualNovelSettingsPatch,
} from '@rezics/launcher-contract';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative } from 'node:path';
import { moveDirectoryIfVacant, type LinuxDirectoryRename } from './directory-move.ts';
import {
  copyMinecraftFiles,
  copyMinecraftMigrationWorlds,
  copyMinecraftUpgradeWorlds,
  instanceFolder,
  reclaimInstanceStages,
  type MigrationWorld,
} from './instance-files.ts';
import type { MinecraftInstallation } from './minecraft-launch-metadata.ts';
import { confirmMinecraftWorldCopy, minecraftWorldsSaveRoot } from './saved-worlds.ts';
import {
  fileInfo,
  humanText,
  Locks,
  pathnameId,
  readJson,
  reclaimLocalTree,
  storagePath,
  writeJson,
} from './storage.ts';
import type { SaveRoot } from './saves.ts';
import { inspectVisualNovelInstallation, isRenpySaveName, renpySaveDirectory } from './visual-novel.ts';
import { scanVisualNovelFolders, visualNovelInstallationKey } from './visual-novel-discovery.ts';
import type { LocalVisualNovelInspection } from './visual-novel-metadata.ts';

export type LocalInstance = Omit<Instance, 'kind'> & {
  kind: 'local' | 'visual-novel';
  executable: string;
  workingDirectory: string;
  saveDirectory?: string;
  renpySaveName?: string;
};

export type MinecraftInstance = Omit<Instance, 'kind' | 'minecraft'> & {
  kind: 'minecraft';
  minecraft: NonNullable<Instance['minecraft']>;
  installation?: MinecraftInstallation;
  lastPreparationId?: string;
  lastUpgradeId?: string;
  archiveGeneration?: string;
};

export type StoredInstance = LocalInstance | MinecraftInstance;

type LegacyMinecraftInstance = Omit<MinecraftInstance, 'minecraft'> & {
  minecraft: { version: typeof defaultMinecraftVersion; loader: 'fabric'; prepared: boolean; fabricVersion?: never };
};

function resolveStoredInstance(record: StoredInstance | LegacyMinecraftInstance): StoredInstance {
  if (record.kind !== 'minecraft') return record;
  const { minecraft } = record;
  if (minecraft.loader !== 'fabric') return { ...record, minecraft };
  if (minecraft.fabricVersion === undefined && minecraft.version !== defaultMinecraftVersion) {
    throw new Error('This Minecraft instance has no selected Fabric loader version.');
  }
  return { ...record, minecraft: { ...minecraft, fabricVersion: minecraft.fabricVersion ?? defaultFabricVersion } };
}

export function instanceView(record: StoredInstance): Instance {
  const { id, name, kind, subjectId, minecraft } = record;
  return { id, name, kind, ...(subjectId && { subjectId }), ...(minecraft && { minecraft }) };
}

function compareInstances(left: Instance, right: Instance) {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function archiveRevision(record: MinecraftInstance) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

async function externalPath(path: string, field: string, directory: boolean) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`Select an absolute ${field} path.`);
  const actual = await realpath(path);
  const info = await fileInfo(actual);
  if (!(directory ? info?.isDirectory() : info?.isFile())) throw new Error(`Select a valid ${field}.`);
  return actual;
}

export function parseSubjectId(value: string) {
  const id = humanText(value, 36, 'REZICS Subject ID').toLowerCase();
  if (!rezicsSubjectIdPattern.test(id)) {
    throw new Error('Enter a valid REZICS Subject ID.');
  }
  return id;
}

function pathContains(directory: string, path: string) {
  const offset = relative(directory, path);
  return (
    offset === '' ||
    (offset !== '..' && !offset.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(offset))
  );
}

export function pathOverlaps(left: string, right: string) {
  return pathContains(left, right) || pathContains(right, left);
}

export class Instances {
  private readonly root: string;
  private readonly archive: string;
  private readonly duplicateStages: string;
  private readonly deletionStages: string;
  private readonly lifecycle = new Locks();
  private readonly localChanges = new Locks();
  private startup: Promise<void> | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly linuxRenameDirectory?: LinuxDirectoryRename,
  ) {
    this.root = join(dataDir, 'instances');
    this.archive = join(this.root, '.archive');
    this.duplicateStages = join(this.root, '.duplicate-staging');
    this.deletionStages = join(this.root, '.archive-deleting');
  }

  directory(id: string) {
    return join(this.root, pathnameId(id));
  }

  gamePath(id: string) {
    return join(this.directory(id), 'game');
  }

  async find(id: string): Promise<StoredInstance> {
    await instanceFolder(this.root);
    const stored = await this.read(this.directory(id), id);
    if (!stored) throw new Error('That game instance does not exist.');
    return stored;
  }

  async write(record: StoredInstance) {
    await instanceFolder(this.root, true);
    const home = this.directory(record.id);
    await instanceFolder(home, true);
    await writeJson(join(home, 'instance.json'), record);
    return instanceView(record);
  }

  async list() {
    await this.recoverLifecycle();
    return (await this.recordsAt(this.root)).map(instanceView).sort(compareInstances);
  }

  async visualNovelInstallations(): Promise<VisualNovelInstallation[]> {
    await this.recoverLifecycle();
    return this.localChanges.run('installations', async () => {
      await instanceFolder(this.root);
      const installations = new Map<string, VisualNovelInstallation>();
      for (const root of [this.archive, this.root]) {
        for (const record of await this.recordsAt(root)) {
          if (record.kind !== 'visual-novel') continue;
          const { executable, workingDirectory } = record;
          installations.set(visualNovelInstallationKey(executable, workingDirectory), {
            executable,
            workingDirectory,
            instance: instanceView(record),
            ...(root === this.archive && { archived: true }),
          });
        }
      }
      return [...installations.values()];
    });
  }

  renameMinecraft(id: string, name: string): Promise<Instance> {
    return this.mutate(id, async () => {
      const source = await this.activeMinecraft(id);
      return this.write({ ...source, name: humanText(name, 120, 'instance name') });
    });
  }

  duplicateMinecraft(id: string, name: string, copyWorlds: boolean): Promise<Instance> {
    return this.mutate(id, async () => {
      const source = await this.activeMinecraft(id);
      const copy: MinecraftInstance = {
        ...source,
        id: `game-${randomUUID()}`,
        name: humanText(name, 120, 'instance name'),
      };
      await instanceFolder(this.duplicateStages, true);
      const staging = join(this.duplicateStages, copy.id);
      await mkdir(staging);
      try {
        await copyMinecraftFiles(this.directory(id), staging, copyWorlds);
        await writeJson(join(staging, 'instance.json'), copy);
        await this.move(staging, this.directory(copy.id));
        return instanceView(copy);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  copyMinecraftUpgrade(
    sourceId: string,
    record: MinecraftInstance,
    signal: AbortSignal,
    commit: (publish: () => Promise<void>) => Promise<void>,
    worlds?: MigrationWorld[],
    confirmation?: MinecraftWorldVersionRisk,
  ): Promise<void> {
    return this.mutate(sourceId, async () => {
      signal.throwIfAborted();
      await instanceFolder(this.duplicateStages, true);
      const target = this.directory(record.id);
      if (await fileInfo(target)) throw new Error('The upgraded copy already exists.');
      const staging = join(this.duplicateStages, pathnameId(record.id));
      await mkdir(staging);
      try {
        const source = this.directory(sourceId);
        const game = join(staging, 'game');
        if (worlds === undefined) await copyMinecraftUpgradeWorlds(source, staging, signal);
        else if (worlds.length) await copyMinecraftMigrationWorlds(source, game, worlds, signal);
        await confirmMinecraftWorldCopy(game, record.minecraft.version, confirmation, undefined, signal);
        signal.throwIfAborted();
        await writeJson(join(staging, 'instance.json'), record);
        await commit(() => this.move(staging, target));
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  archiveMinecraft(id: string): Promise<void> {
    return this.mutate(id, async () => {
      const record = await this.activeMinecraft(id);
      await this.moveToArchive(id, async () => {
        // A restored instance can be archived again under the same ID.
        await this.write({ ...record, archiveGeneration: randomUUID() });
      });
    });
  }

  async listArchivedMinecraft(): Promise<ArchivedMinecraftInstance[]> {
    return (await this.listArchivedInstances()).filter((instance) => instance.kind === 'minecraft');
  }

  async listArchivedInstances(): Promise<ArchivedInstance[]> {
    await this.recoverLifecycle();
    await instanceFolder(this.root);
    return (await this.recordsAt(this.archive))
      .map((record): ArchivedInstance =>
        record.kind === 'minecraft'
          ? { ...instanceView(record), kind: record.kind, revision: archiveRevision(record) }
          : { ...instanceView(record), kind: record.kind },
      )
      .sort(compareInstances);
  }

  restoreArchivedMinecraft(id: string): Promise<Instance> {
    return this.mutate(id, async () => {
      const record = await this.archivedMinecraft(id);
      await this.moveFromArchive(id);
      return instanceView(record);
    });
  }

  setLocalGameArchived(
    id: string,
    archived: boolean,
    beforeArchive: (record: LocalInstance) => Promise<void>,
  ): Promise<LocalGameArchiveChange> {
    return this.mutate(id, () =>
      this.localChanges.run('installations', async () => {
        const active = await this.read(this.directory(id), id);
        const stored = await this.readArchive(id);
        if (active && stored) throw new Error('This ID is present in both Installed and the archive.');
        const record = active ?? stored;
        if (!record || record.kind === 'minecraft') throw new Error('Choose an imported local game.');
        const instance = instanceView(record);
        if (archived === Boolean(stored)) return { status: 'unchanged', instance };
        if (archived) {
          await this.moveToArchive(id, () => beforeArchive(record));
          return { status: 'archived', instance };
        }
        await this.moveFromArchive(id);
        return { status: 'restored', instance };
      }),
    );
  }

  private async moveToArchive(id: string, beforeMove: () => Promise<void>) {
    await instanceFolder(this.archive, true);
    const archived = join(this.archive, id);
    const occupied = 'An archived instance already uses this ID.';
    if (await fileInfo(archived)) throw new Error(occupied);
    await beforeMove();
    await this.move(this.directory(id), archived, occupied);
  }

  private async moveFromArchive(id: string) {
    const active = this.directory(id);
    const occupied = 'An active instance already uses this ID.';
    if (await fileInfo(active)) throw new Error(occupied);
    await this.move(join(this.archive, id), active, occupied);
  }

  private async move(source: string, destination: string, occupied = 'An instance folder already uses this ID.') {
    try {
      await moveDirectoryIfVacant(source, destination, this.linuxRenameDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (await fileInfo(destination))) {
        throw new Error(occupied);
      }
      throw error;
    }
  }

  deleteArchivedMinecraft(id: string, expectedRevision: string): Promise<void> {
    return this.mutate(id, async () => {
      const record = await this.archivedMinecraft(id);
      if (archiveRevision(record) !== expectedRevision) {
        throw new Error('This archive entry changed. Review the archived instance again before deleting it.');
      }
      await instanceFolder(this.deletionStages, true);
      const tomb = join(this.deletionStages, `game-${randomUUID()}`);
      await this.move(join(this.archive, id), tomb);
      try {
        await reclaimLocalTree(tomb);
      } catch {
        throw new Error(
          'The instance was removed from the archive. Launcher will retry removing its files after reopening.',
        );
      }
    });
  }

  private async recordsAt(root: string) {
    if (!(await instanceFolder(root))) return [];
    const homes = await readdir(root, { withFileTypes: true });
    const games: StoredInstance[] = [];
    for (const entry of homes) {
      if (!entry.isDirectory() || !entry.name.startsWith('game-')) continue;
      const record = await this.read(join(root, entry.name), entry.name);
      if (record) games.push(record);
    }
    return games;
  }

  private async read(home: string, id: string): Promise<StoredInstance | undefined> {
    if (!(await fileInfo(home))?.isDirectory()) return;
    const metadata = join(home, 'instance.json');
    if (!(await fileInfo(metadata))?.isFile()) return;
    const record = await readJson<StoredInstance | LegacyMinecraftInstance>(metadata);
    if (record?.id === id) return resolveStoredInstance(record);
  }

  private async activeMinecraft(id: string): Promise<MinecraftInstance> {
    const record = await this.find(id);
    if (record.kind !== 'minecraft') throw new Error('Choose a Minecraft instance.');
    return record;
  }

  private async archivedMinecraft(id: string): Promise<MinecraftInstance> {
    const record = await this.readArchive(id);
    if (record?.kind !== 'minecraft') throw new Error('Choose an archived Minecraft instance.');
    return record;
  }

  private async readArchive(id: string) {
    await instanceFolder(this.archive);
    return this.read(join(this.archive, id), id);
  }

  private async mutate<T>(id: string, work: () => Promise<T>) {
    const key = pathnameId(id);
    await this.recoverLifecycle();
    return this.lifecycle.run(key, async () => {
      await instanceFolder(this.root);
      return work();
    });
  }

  private recoverLifecycle() {
    return (this.startup ??= (async () => {
      if (await instanceFolder(this.root)) {
        await Promise.all([reclaimInstanceStages(this.duplicateStages), reclaimInstanceStages(this.deletionStages)]);
      }
    })().catch((error: unknown) => {
      this.startup = undefined;
      throw error;
    }));
  }

  async discoverVisualNovels(path: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const root = await externalPath(path, 'games folder', true);
    const data = await storagePath(this.dataDir);
    if (pathContains(data, root)) throw new Error('Choose a games folder outside the Launcher data folder.');
    return scanVisualNovelFolders(
      root,
      data,
      await this.visualNovelInstallations(),
      (executable, directory) => this.inspectVisualNovelPackage(executable, directory),
      signal,
    );
  }

  async inspectVisualNovel(input: VisualNovelInspectionInput): Promise<VisualNovelInspection> {
    const executable = await externalPath(input.executable, 'game executable', false);
    const directory = input.workingDirectory
      ? await externalPath(input.workingDirectory, 'working folder', true)
      : dirname(executable);
    return this.inspectVisualNovelAt(executable, directory);
  }

  async inspectVisualNovelAt(
    executable: string,
    directory: string,
    savedName?: string,
  ): Promise<VisualNovelInspection> {
    return (await this.inspectVisualNovelPackage(executable, directory, savedName)).metadata;
  }

  private async inspectVisualNovelPackage(
    executable: string,
    directory: string,
    savedName?: string,
  ): Promise<LocalVisualNovelInspection> {
    const { metadata: inspection, ...layout } = await inspectVisualNovelInstallation(executable, directory);
    if (inspection.engine === 'renpy') {
      const { gameSaveDirectory: discovered, ...metadata } = inspection;
      const gameSaveDirectory = discovered && !pathOverlaps(discovered, this.dataDir) ? discovered : undefined;
      const name = savedName ?? inspection.saveName;
      const detectedSaveDirectory =
        name && (await this.checkedRenpySaveDirectory(executable, directory, name, gameSaveDirectory));
      return {
        metadata: {
          ...metadata,
          ...(gameSaveDirectory && { gameSaveDirectory }),
          ...(detectedSaveDirectory && { detectedSaveDirectory }),
        },
        ...layout,
      };
    }
    const { detectedSaveDirectory: detected, ...metadata } = inspection;
    if (!detected) return { metadata: inspection, ...layout };
    const inGame = join(directory, 'game', 'saves');
    if (pathOverlaps(detected, this.dataDir) || (relative(detected, inGame) && pathContains(detected, inGame)))
      return { metadata, ...layout };
    return { metadata: inspection, ...layout };
  }

  private async checkedRenpySaveDirectory(executable: string, directory: string, name: string, game?: string) {
    if (!isRenpySaveName(name)) return;
    try {
      const candidate = await renpySaveDirectory(executable, directory, name);
      if (!candidate) return;
      const info = await fileInfo(candidate);
      if (info && !info.isDirectory()) return;
      const [path, data, local] = await Promise.all([
        storagePath(candidate),
        storagePath(this.dataDir),
        game && storagePath(game),
      ]);
      if (pathOverlaps(path, data) || (local && pathOverlaps(path, local))) return;
      return path;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'ENOTDIR' && code !== 'ELOOP' && code !== 'EACCES' && code !== 'EPERM') throw error;
    }
  }

  async visualNovel(id: string): Promise<LocalInstance> {
    const instance = await this.find(id);
    if (instance.kind !== 'visual-novel') throw new Error('Choose a visual novel instance.');
    return instance;
  }

  private async selectedSaveFolder(path: string) {
    const folder = await externalPath(path, 'save folder', true);
    if (parse(folder).root === folder || pathOverlaps(folder, this.dataDir)) {
      throw new Error('Choose the game’s save folder outside the Launcher data folder.');
    }
    return folder;
  }

  async editVisualNovel(instance: LocalInstance, patch: VisualNovelSettingsPatch): Promise<LocalInstance> {
    const next = { ...instance };
    if (patch.name !== undefined) next.name = humanText(patch.name, 120, 'game name');
    if (patch.executable !== undefined) {
      next.executable = await externalPath(patch.executable, 'game executable', false);
      if (instance.workingDirectory === dirname(instance.executable)) next.workingDirectory = dirname(next.executable);
    }
    if (patch.workingDirectory === null) next.workingDirectory = dirname(next.executable);
    else if (patch.workingDirectory !== undefined) {
      next.workingDirectory = await externalPath(patch.workingDirectory, 'working folder', true);
    }
    if (patch.saveDirectory === null) delete next.saveDirectory;
    else if (patch.saveDirectory !== undefined) next.saveDirectory = await this.selectedSaveFolder(patch.saveDirectory);
    if (patch.renpySaveName === null) delete next.renpySaveName;
    else if (patch.renpySaveName !== undefined) {
      if (!isRenpySaveName(patch.renpySaveName)) throw new Error('Invalid Ren’Py save name.');
      next.renpySaveName = patch.renpySaveName;
    }
    if (patch.subjectId === null) delete next.subjectId;
    else if (patch.subjectId !== undefined) next.subjectId = parseSubjectId(patch.subjectId);
    return next;
  }

  async local(input: LocalInstanceInput) {
    const { kind } = input;
    if (kind !== 'local' && kind !== 'visual-novel') throw new Error('Unsupported local game type.');
    const name = humanText(input.name, 120, 'game name');
    const executable = await externalPath(input.executable, 'game executable', false);
    const workingDirectory = input.workingDirectory
      ? await externalPath(input.workingDirectory, 'working folder', true)
      : dirname(executable);
    const saveDirectory = input.saveDirectory ? await this.selectedSaveFolder(input.saveDirectory) : undefined;
    if (input.renpySaveName && !isRenpySaveName(input.renpySaveName)) throw new Error('Invalid Ren’Py save name.');
    return this.localChanges.run('installations', async () => {
      await instanceFolder(this.root);
      const key = visualNovelInstallationKey(executable, workingDirectory);
      for (const archived of await this.recordsAt(this.archive)) {
        if (
          archived.kind === kind &&
          visualNovelInstallationKey(archived.executable, archived.workingDirectory) === key
        ) {
          throw new Error('This installation is archived. Restore it from Archived instances.');
        }
      }
      return this.write({
        id: `game-${randomUUID()}`,
        name,
        kind,
        ...(input.subjectId && { subjectId: parseSubjectId(input.subjectId) }),
        executable,
        workingDirectory,
        ...(saveDirectory && { saveDirectory }),
        ...(input.renpySaveName && { renpySaveName: input.renpySaveName }),
      });
    });
  }

  minecraft(input: MinecraftInstanceInput, selection: MinecraftSelection) {
    return this.write(this.minecraftRecord(input, selection));
  }

  private minecraftRecord(
    input: MinecraftInstanceInput,
    selection: MinecraftSelection,
    settings?: MinecraftSettings,
  ): MinecraftInstance {
    return {
      id: `game-${randomUUID()}`,
      name: humanText(input.name, 120, 'instance name'),
      kind: 'minecraft',
      ...(input.subjectId && { subjectId: parseSubjectId(input.subjectId) }),
      minecraft: { ...selection, prepared: false, ...(settings && { settings }) },
    };
  }

  async publishMinecraftImport(
    input: MinecraftInstanceInput,
    selection: MinecraftSelection,
    populate: (instanceDir: string, gameDir: string) => Promise<unknown>,
    settings?: MinecraftSettings,
    control?: ModrinthPackInstallControl,
  ) {
    control?.signal.throwIfAborted();
    const record = this.minecraftRecord(input, selection, settings);
    await instanceFolder(this.root, true);
    const staging = join(this.root, '.modrinth-import');
    const previous = await fileInfo(staging);
    if (previous && !previous.isDirectory()) throw new Error('The Modrinth import staging folder is unavailable.');
    if (previous) await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      await populate(staging, join(staging, 'game'));
      control?.signal.throwIfAborted();
      await writeJson(join(staging, 'instance.json'), record);
      control?.signal.throwIfAborted();
      control?.beginCommit?.();
      await this.move(staging, this.directory(record.id));
      return instanceView(record);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async saveRoots(instance: StoredInstance): Promise<SaveRoot[]> {
    if (instance.kind === 'minecraft')
      return [{ id: minecraftWorldsSaveRoot, path: join(this.gamePath(instance.id), 'saves') }];
    if (instance.saveDirectory) return [{ id: 'selected', path: instance.saveDirectory }];
    if (instance.kind === 'local') return [{ id: 'local', path: join(instance.workingDirectory, 'saves') }];
    const { executable, workingDirectory, renpySaveName } = instance;
    const conventional = join(workingDirectory, 'game', 'saves');
    const inspection = await this.inspectVisualNovelAt(executable, workingDirectory, renpySaveName);
    const inGame = inspection.engine === 'renpy' ? inspection.gameSaveDirectory : conventional;
    const roots: SaveRoot[] = inGame ? [{ id: 'game', path: inGame }] : [];
    const profile =
      inspection.engine === 'renpy'
        ? inspection.detectedSaveDirectory
        : renpySaveName && (await this.checkedRenpySaveDirectory(executable, workingDirectory, renpySaveName, inGame));
    if (profile) roots.push({ id: 'renpy', path: profile });
    if (
      !renpySaveName &&
      inspection.engine === 'kirikiri' &&
      inspection.detectedSaveDirectory &&
      !pathOverlaps(conventional, inspection.detectedSaveDirectory)
    ) {
      roots.push({ id: 'kirikiri', path: inspection.detectedSaveDirectory });
    }
    return roots;
  }
}
