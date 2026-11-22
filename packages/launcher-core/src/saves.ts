import {
  isEarlierMinecraftRelease,
  isVisualNovelSaveRoot,
  type Instance,
  type MinecraftRestoreVersionRisk,
  type RestorePreview,
  type SaveRestoreReview,
  type SaveSelection,
  type Snapshot,
  type SnapshotHistory,
  type VisualNovelRestoreChoice,
} from '@rezics/launcher-contract';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { moveDirectoryIfVacant, type LinuxDirectoryRename } from './directory-move.ts';
import {
  copyVerifiedBundle,
  exportSaveBundle,
  parseStoredSnapshot,
  readSaveBundle,
  type SnapshotRecord,
} from './save-bundles.ts';
import { inspectRestoreTargets, planSaveRestore, restoreReviewChanged } from './save-restore-plan.ts';
import {
  confirmRestoreDirectory,
  moveRestoreDirectory,
  recoverSaveRestore,
  restoreDirectory,
  restoreStage,
  type SaveRestoreJournal,
  type SaveRoots,
} from './save-restore-journal.ts';
import { copySaveTree, hashSaveTree, matchesSaveTree } from './save-tree.ts';
import { isPortableSaveName, minecraftWorldSaveRoot, newestMinecraftWorldVersion } from './saved-worlds.ts';
import { checkLocalDirectory, fileInfo, isMissing, pathnameId, readJson, writeJson } from './storage.ts';

export type SaveRoot = { id: string; path: string };
type AutomaticBackupRecord = { message: string | null; snapshotId?: string };
const noSaveFolderMessage = 'No save folder is available for this instance.';

export class NoSaveFolderError extends Error {
  constructor() {
    super(noSaveFolderMessage);
  }
}

class SnapshotReadError extends Error {
  constructor(readonly reason: SnapshotHistory['issues'][number]['reason']) {
    super(reason === 'invalid-metadata' ? 'That snapshot has invalid metadata.' : 'That snapshot is unavailable.');
  }
}

function versionRisk(
  record: Snapshot,
  targetVersion: string,
  newestWorldVersion: string | null,
): MinecraftRestoreVersionRisk | undefined {
  const backupVersion = record.minecraft?.version;
  const recordedRisk =
    backupVersion && isEarlierMinecraftRelease(targetVersion, backupVersion) ? backupVersion : undefined;
  if (
    newestWorldVersion &&
    isEarlierMinecraftRelease(targetVersion, newestWorldVersion) &&
    (!recordedRisk || isEarlierMinecraftRelease(recordedRisk, newestWorldVersion))
  ) {
    return { backupVersion: newestWorldVersion, targetVersion, source: 'world' };
  }
  if (recordedRisk) return { backupVersion: recordedRisk, targetVersion };
}

function confirmRestoreVersion(risk?: MinecraftRestoreVersionRisk, confirmation?: MinecraftRestoreVersionRisk) {
  if (confirmation) {
    if (risk?.backupVersion !== confirmation.backupVersion || risk?.targetVersion !== confirmation.targetVersion) {
      throw new Error('The Minecraft version warning changed. Preview this backup again.');
    }
  } else if (risk) {
    throw new Error('Preview this backup and confirm the Minecraft version warning before restoring.');
  }
}

function snapshotView({ roots: _roots, newestWorldVersion: _version, ...snapshot }: SnapshotRecord): Snapshot {
  return snapshot;
}

export class Saves {
  private readonly path: string;
  private readonly journal: string;
  private readonly automaticRecordPath: string;

  constructor(
    private readonly instanceDir: string,
    private readonly saveRoots: SaveRoots,
    private readonly kind?: Instance['kind'],
    private readonly linuxRenameDirectory?: LinuxDirectoryRename,
  ) {
    this.path = join(instanceDir, 'snapshots');
    this.journal = join(instanceDir, 'restore-journal.json');
    this.automaticRecordPath = join(instanceDir, 'backup-failure.json');
  }

  private snapshotPath(id: string) {
    return join(this.path, pathnameId(id));
  }

  private async checkStorage() {
    await checkLocalDirectory(this.instanceDir, 'instance');
    await checkLocalDirectory(this.path, 'snapshots');
  }

  private async read(id: string) {
    await this.checkStorage();
    return this.readSnapshot(id);
  }

  private async readSnapshot(id: string) {
    const folder = this.snapshotPath(id);
    const manifest = join(folder, 'snapshot.json');
    let value: unknown;
    try {
      if ((await fileInfo(folder))?.isDirectory() && (await fileInfo(manifest))?.isFile()) {
        value = await readJson<unknown>(manifest);
      }
    } catch (error) {
      throw new SnapshotReadError(error instanceof SyntaxError ? 'invalid-metadata' : 'unavailable');
    }
    if (value === undefined) throw new SnapshotReadError('unavailable');
    const record = parseStoredSnapshot(value, id);
    if (!record) throw new SnapshotReadError('invalid-metadata');
    return record;
  }

  private worldVersion(record: SnapshotRecord, folder: string, signal?: AbortSignal) {
    return newestMinecraftWorldVersion(
      record.roots.map(({ id }) => ({ id, path: join(folder, pathnameId(id)) })),
      signal,
    );
  }

  private async previewVersionRisk(id: string, record: SnapshotRecord, targetVersion?: string) {
    if (!targetVersion || !record.minecraft) return;
    const retained = record.newestWorldVersion;
    const newest =
      typeof retained === 'string' || retained === null
        ? retained
        : await this.worldVersion(record, this.snapshotPath(id));
    return versionRisk(record, targetVersion, newest);
  }

  async selection(id: string): Promise<SaveSelection | undefined> {
    return (await this.read(id)).selection;
  }

  async list(): Promise<Snapshot[]> {
    return (await this.history()).snapshots;
  }

  async history(): Promise<SnapshotHistory> {
    await this.checkStorage();
    const entries = await readdir(this.path, { withFileTypes: true }).catch((error) => {
      if (isMissing(error)) return [];
      throw error;
    });
    const history: SnapshotHistory = { snapshots: [], issues: [] };
    for (const entry of entries) {
      if (!/^snapshot-[a-z0-9_-]{1,111}$/iu.test(entry.name)) continue;
      try {
        history.snapshots.push(snapshotView(await this.readSnapshot(entry.name)));
      } catch (error) {
        if (!(error instanceof SnapshotReadError)) throw error;
        history.issues.push({ id: entry.name, reason: error.reason });
      }
    }
    history.snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    history.issues.sort((a, b) => a.id.localeCompare(b.id));
    return history;
  }

  private async automaticRecord(): Promise<AutomaticBackupRecord | undefined> {
    const info = await fileInfo(this.automaticRecordPath);
    if (!info) return undefined;
    if (!info.isFile() || info.size > 4096) throw new Error('The automatic backup status is unavailable.');
    const record = await readJson<{ message?: unknown; snapshotId?: unknown }>(this.automaticRecordPath);
    if (!record) return undefined;
    const snapshotId = record.snapshotId;
    return {
      message: typeof record.message === 'string' ? record.message : null,
      ...(typeof snapshotId === 'string' && /^snapshot-[a-f0-9-]{36}$/u.test(snapshotId) && { snapshotId }),
    };
  }

  async failure(): Promise<string | null> {
    const message = (await this.automaticRecord())?.message ?? null;
    return message === noSaveFolderMessage ? null : message;
  }

  async recordFailure(message: string) {
    const previous = await this.automaticRecord().catch(() => undefined);
    await writeJson(this.automaticRecordPath, { ...previous, message });
  }

  private async matchesAutomaticSnapshot(record: SnapshotRecord, roots: SaveRoot[], context: Snapshot['minecraft']) {
    if (record.selection || !Array.isArray(record.roots) || !isDeepStrictEqual(context, record.minecraft)) return false;
    if (roots.length !== record.roots.length) return false;
    for (const root of roots) {
      const saved = record.roots.find((entry) => entry?.id === root.id);
      if (!saved?.sha256 || !matchesSaveTree(saved, await hashSaveTree(root.path))) return false;
    }
    for (const saved of record.roots) {
      const previous = await hashSaveTree(join(this.snapshotPath(record.id), pathnameId(saved.id))).catch(
        () => undefined,
      );
      if (!previous || !matchesSaveTree(saved, previous)) return false;
    }
    return true;
  }

  async createAutomatic(roots: SaveRoot[], context: Snapshot['minecraft']): Promise<Snapshot> {
    const available: SaveRoot[] = [];
    for (const root of roots) {
      if (await fileInfo(root.path)) available.push(root);
    }
    if (!available.length) throw new NoSaveFolderError();
    const status = await this.automaticRecord().catch(() => undefined);
    const id = status?.snapshotId;
    const previous = id && (await this.read(id).catch(() => undefined));
    const retained =
      previous && previous.id === id && (await this.matchesAutomaticSnapshot(previous, available, context));
    const snapshot = retained ? snapshotView(previous) : await this.create(roots, context, 'Automatic backup');
    if (!retained || status?.message) {
      await writeJson(this.automaticRecordPath, { message: null, snapshotId: snapshot.id }).catch(() => {});
    }
    return snapshot;
  }

  async create(
    roots: SaveRoot[],
    context: Snapshot['minecraft'],
    label?: string,
    selection?: SaveSelection,
    signal?: AbortSignal,
  ): Promise<Snapshot> {
    signal?.throwIfAborted();
    if (
      selection &&
      (!context || !isPortableSaveName(selection.id) || roots.length !== 1 || roots[0]?.id !== minecraftWorldSaveRoot)
    ) {
      throw new Error('Choose one Minecraft world to back up.');
    }
    await this.checkStorage();
    const id = `snapshot-${randomUUID()}`;
    await mkdir(this.path, { recursive: true });
    const stage = join(this.path, '.pending');
    await mkdir(stage);
    try {
      const record: SnapshotRecord = { id, createdAt: new Date().toISOString(), files: 0, bytes: 0, roots: [] };
      if (label) record.label = label;
      if (context) record.minecraft = context;
      if (selection) record.selection = selection;
      for (const root of roots) {
        if (!(await fileInfo(root.path))) continue;
        const copied = await copySaveTree(root.path, join(stage, pathnameId(root.id)), { signal });
        record.roots.push({ id: root.id, ...copied });
        record.files += copied.files;
        record.bytes += copied.bytes;
      }
      if (!record.roots.length) throw new NoSaveFolderError();
      if (context) record.newestWorldVersion = await this.worldVersion(record, stage, signal);
      await writeJson(join(stage, 'snapshot.json'), record);
      signal?.throwIfAborted();
      await moveDirectoryIfVacant(stage, this.snapshotPath(id), this.linuxRenameDirectory);
      return snapshotView(record);
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    const record = await this.read(id);
    if (Boolean(record.pinned) === pinned) return;
    if (pinned) record.pinned = true;
    else delete record.pinned;
    await writeJson(join(this.snapshotPath(id), 'snapshot.json'), record);
  }

  async delete(id: string): Promise<void> {
    if ((await this.read(id)).pinned) throw new Error('Unpin this backup before deleting it.');
    const stage = join(this.path, '.deleting');
    await rm(stage, { recursive: true, force: true });
    await moveDirectoryIfVacant(this.snapshotPath(id), stage, this.linuxRenameDirectory);
    await rm(stage, { recursive: true, force: true });
  }

  async exportSnapshot(id: string, destinationFolder: string): Promise<string> {
    const record = await this.read(id);
    return exportSaveBundle(this.snapshotPath(id), this.path, record, destinationFolder, this.linuxRenameDirectory);
  }

  async importSnapshot(
    sourceFolder: string,
    receivingKind: Instance['kind'],
    rootsFor: (selection?: SaveSelection) => Promise<SaveRoot[]>,
  ): Promise<Snapshot> {
    const bundle = await readSaveBundle(sourceFolder, this.path);
    const { snapshot, roots: sourceRoots } = bundle.manifest;
    if (Boolean(snapshot.minecraft) !== (receivingKind === 'minecraft')) {
      throw new Error('This backup belongs to a different type of game.');
    }
    if (receivingKind === 'visual-novel') {
      if (!sourceRoots.every(({ id }) => isVisualNovelSaveRoot(id))) {
        throw new Error('This backup has unsupported visual novel save locations.');
      }
    } else {
      const receiving = new Set((await rootsFor(snapshot.selection)).map((root) => root.id));
      if (!sourceRoots.every((root) => receiving.has(root.id))) {
        throw new Error('This instance does not have the save locations from the backup.');
      }
    }

    const id = `snapshot-${randomUUID()}`;
    await mkdir(this.path, { recursive: true });
    const stage = join(this.path, '.pending');
    await mkdir(stage);
    try {
      const roots = await copyVerifiedBundle(bundle, stage);
      const record: SnapshotRecord = {
        id,
        createdAt: snapshot.createdAt,
        files: snapshot.files,
        bytes: snapshot.bytes,
        ...(snapshot.label && { label: snapshot.label }),
        ...(snapshot.pinned && { pinned: true }),
        ...(snapshot.minecraft && { minecraft: snapshot.minecraft }),
        ...(snapshot.selection && { selection: snapshot.selection }),
        roots,
      };
      if (snapshot.minecraft) record.newestWorldVersion = await this.worldVersion(record, stage);
      await writeJson(join(stage, 'snapshot.json'), record);
      await moveDirectoryIfVacant(stage, this.snapshotPath(id), this.linuxRenameDirectory);
      return snapshotView(record);
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }

  async preview(
    id: string,
    roots: SaveRoot[],
    targetVersion?: string,
    choices?: VisualNovelRestoreChoice[],
  ): Promise<RestorePreview> {
    const record = await this.read(id);
    const plan = planSaveRestore(record, roots, this.kind === 'visual-novel', choices);
    const targets = plan.routes.map(({ saved, target }) => ({
      path: target.path,
      files: saved.files,
      bytes: saved.bytes,
    }));
    const review = plan.complete
      ? { revision: (await inspectRestoreTargets(id, plan.routes)).revision, ...(choices && { choices }) }
      : undefined;
    const risk = await this.previewVersionRisk(id, record, targetVersion);
    return {
      snapshot: snapshotView(record),
      targets,
      ...(review && { review }),
      ...(plan.visualNovel && { visualNovel: plan.visualNovel }),
      ...(risk && { minecraftVersionRisk: risk }),
    };
  }

  async recover() {
    await this.checkStorage();
    await this.recoverRestore();
    await rm(join(this.path, '.pending'), { recursive: true, force: true });
    await rm(join(this.path, '.deleting'), { recursive: true, force: true });
  }

  async recoverRestore() {
    await checkLocalDirectory(this.instanceDir, 'instance');
    await recoverSaveRestore(this.journal, this.saveRoots, this.linuxRenameDirectory);
  }

  async restore(
    id: string,
    context: Snapshot['minecraft'],
    confirmation?: MinecraftRestoreVersionRisk,
    options?: { review?: SaveRestoreReview; allowedRoots?: SaveRoot[] },
  ) {
    const { review, allowedRoots } = options ?? {};
    await this.recover();
    const record = await this.read(id);
    confirmRestoreVersion(await this.previewVersionRisk(id, record, context?.version), confirmation);
    const roots = allowedRoots ?? (await this.saveRoots(record.selection));
    const isVisualNovel = this.kind === 'visual-novel';
    const plan = planSaveRestore(record, roots, isVisualNovel, review?.choices);
    if (!plan.complete) throw new Error('Preview this backup and choose the save destinations before restoring.');
    const { checked, revision } = await inspectRestoreTargets(id, plan.routes);
    if (review && review.revision !== revision) throw new Error(restoreReviewChanged);
    const confirmDestinations = async () => {
      const current = planSaveRestore(record, await this.saveRoots(record.selection), isVisualNovel, review?.choices);
      if (
        !current.complete ||
        current.routes.length !== checked.length ||
        current.routes.some(
          ({ target }, index) =>
            target.id !== checked[index]!.target.id || resolve(target.path) !== checked[index]!.target.path,
        )
      )
        throw new Error(restoreReviewChanged);
    };
    const liveRoots: SaveRoot[] = [];
    const operation = randomUUID();
    const journal: SaveRestoreJournal = {
      version: 2,
      operation,
      phase: 'staging',
      items: [],
      ...(record.selection && { selection: record.selection }),
    };
    const copies: string[] = [];
    for (const { target, before } of checked) {
      const stage = restoreStage(target.path, operation, copies.length);
      if (await fileInfo(stage)) throw new Error('A save restore staging folder is already occupied.');
      if (before) liveRoots.push(target);
      journal.items.push({ rootId: target.id, target: target.path, before });
      copies.push(stage);
    }
    await writeJson(this.journal, journal);
    try {
      for (const [index, item] of journal.items.entries()) {
        const stage = copies[index]!;
        const { saved, parent: originalParent } = checked[index]!;
        if (originalParent) await confirmRestoreDirectory(dirname(stage), originalParent);
        await mkdir(dirname(stage), { recursive: true });
        await mkdir(stage);
        const next = join(stage, 'next');
        const copied = await copySaveTree(join(this.snapshotPath(id), pathnameId(saved.id)), next);
        if (!matchesSaveTree(saved, copied)) {
          throw new Error('This backup is damaged. Your current saves were kept. Choose another backup.');
        }
        const parent = await restoreDirectory(dirname(stage));
        const incoming = await restoreDirectory(next);
        if (!parent || !incoming) throw new Error('The staged save could not be verified.');
        await confirmRestoreDirectory(item.target, item.before);
        item.parent = parent;
        item.incoming = incoming;
      }
      if (record.minecraft && context?.version) {
        const actual = await newestMinecraftWorldVersion(
          journal.items.map(({ rootId }, index) => ({ id: rootId, path: join(copies[index]!, 'next') })),
        );
        if (record.newestWorldVersion !== undefined && record.newestWorldVersion !== actual) {
          record.newestWorldVersion = actual;
          await writeJson(join(this.snapshotPath(id), 'snapshot.json'), record);
        }
        confirmRestoreVersion(versionRisk(record, context.version, actual), confirmation);
      }
      await confirmDestinations();
      if (liveRoots.length) {
        await this.create(liveRoots, context, 'Before restore', record.selection);
        await confirmDestinations();
      }
      await writeJson(this.journal, { ...journal, phase: 'moving' });
      for (const [index, item] of journal.items.entries()) {
        const stage = copies[index]!;
        const next = join(stage, 'next');
        await confirmRestoreDirectory(dirname(stage), item.parent!);
        await confirmRestoreDirectory(next, item.incoming!);
        await confirmRestoreDirectory(item.target, item.before);
        if (item.before) {
          await moveRestoreDirectory(item.target, join(stage, 'previous'), item.before, this.linuxRenameDirectory);
        }
        await moveRestoreDirectory(next, item.target, item.incoming, this.linuxRenameDirectory);
      }
      await writeJson(this.journal, { ...journal, phase: 'installed' });
    } finally {
      await recoverSaveRestore(this.journal, async () => roots, this.linuxRenameDirectory);
    }
  }
}
