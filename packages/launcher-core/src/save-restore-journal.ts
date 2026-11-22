import type { SaveSelection } from '@rezics/launcher-contract';
import { lstat, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import * as v from 'valibot';
import { moveDirectoryIfVacant, type LinuxDirectoryRename } from './directory-move.ts';
import { isPortableSaveName, minecraftWorldSaveRoot } from './saved-worlds.ts';
import { checkLocalDirectory, fileInfo, isMissing, readJson } from './storage.ts';
import type { SaveRoot } from './saves.ts';

const invalidJournal = 'The interrupted save restore could not be verified. Its files were kept.';
const changedDirectory =
  'A directory changed outside Launcher during the interrupted save restore. Its files were kept.';
const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const directoryId = v.strictObject({
  device: v.pipe(v.string(), v.regex(/^\d+$/u)),
  inode: v.pipe(v.string(), v.regex(/^\d+$/u)),
});
const state = v.picklist(['staging', 'moving', 'installed']);
const selectionShape = v.strictObject({
  kind: v.literal('world'),
  id: v.pipe(v.string(), v.check(isPortableSaveName)),
});
const legacyItem = v.strictObject({
  rootId: v.string(),
  target: v.string(),
  stage: v.string(),
  existed: v.boolean(),
});
const currentItem = v.strictObject({
  rootId: v.string(),
  target: v.string(),
  before: v.nullable(directoryId),
  parent: v.exactOptional(directoryId),
  incoming: v.exactOptional(directoryId),
});
const legacyJournal = v.strictObject({
  phase: state,
  items: v.pipe(v.array(legacyItem), v.minLength(1), v.maxLength(8)),
});
const currentJournal = v.strictObject({
  version: v.literal(2),
  operation: v.pipe(v.string(), v.regex(operationId)),
  phase: state,
  selection: v.exactOptional(selectionShape),
  items: v.pipe(v.array(currentItem), v.minLength(1), v.maxLength(8)),
});

export type SaveRoots = (selection?: SaveSelection) => Promise<SaveRoot[]>;
export type SaveRestoreJournal = v.InferOutput<typeof currentJournal>;
type DirectoryIdentity = v.InferOutput<typeof directoryId>;
type RecoveryItem = {
  target: string;
  stage: string;
  existed: boolean;
  before?: DirectoryIdentity | null;
  parent?: DirectoryIdentity;
  incoming?: DirectoryIdentity;
};

export function restoreStage(target: string, operation: string, index: number): string {
  return join(dirname(target), `.rezics-restore-${operation}-${index}`);
}

export async function restoreDirectory(path: string): Promise<DirectoryIdentity | null> {
  const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isDirectory()) throw new Error('A save restore directory is unavailable or is a link.');
  return { device: info.dev.toString(), inode: info.ino.toString() };
}

function sameDirectory(a: DirectoryIdentity | null, b: DirectoryIdentity | null | undefined) {
  return a === b || Boolean(a && b && a.device === b.device && a.inode === b.inode);
}

export async function confirmRestoreDirectory(path: string, expected: DirectoryIdentity | null) {
  if (!sameDirectory(await restoreDirectory(path), expected)) throw new Error(changedDirectory);
}

async function moveVacantRestoreDirectory(source: string, destination: string, linuxRename?: LinuxDirectoryRename) {
  try {
    await moveDirectoryIfVacant(source, destination, linuxRename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (await fileInfo(destination))) {
      throw new Error(changedDirectory);
    }
    throw error;
  }
}

export async function moveRestoreDirectory(
  source: string,
  destination: string,
  expected?: DirectoryIdentity,
  linuxRename?: LinuxDirectoryRename,
) {
  if (expected) await confirmRestoreDirectory(source, expected);
  await moveVacantRestoreDirectory(source, destination, linuxRename);
  if (expected && !sameDirectory(await restoreDirectory(destination), expected)) {
    await moveVacantRestoreDirectory(destination, source, linuxRename);
    throw new Error(changedDirectory);
  }
}

function legacyScope(journal: v.InferOutput<typeof legacyJournal>): SaveSelection | undefined {
  const world = journal.items.find(({ rootId }) => rootId === minecraftWorldSaveRoot);
  if (!world) return undefined;
  const id = basename(world.target);
  if (journal.items.length !== 1 || !isPortableSaveName(id)) throw new Error(invalidJournal);
  return { kind: 'world', id };
}

function samePath(persisted: string, expected: string) {
  return isAbsolute(persisted) && resolve(persisted) === persisted && relative(persisted, expected) === '';
}

async function readRestoreRecovery(path: string, saveRoots: SaveRoots) {
  const info = await fileInfo(path);
  if (!info) return null;
  if (!info.isFile() || info.size > 65536) throw new Error(invalidJournal);
  const value = await readJson<unknown>(path).catch(() => {
    throw new Error(invalidJournal);
  });
  const parsed = v.safeParse(v.union([currentJournal, legacyJournal]), value);
  if (!parsed.success) throw new Error(invalidJournal);
  const journal = parsed.output;
  const roots = await saveRoots('version' in journal ? journal.selection : legacyScope(journal));
  const ids = new Set<string>();
  let operation = 'version' in journal ? journal.operation : undefined;
  const items: RecoveryItem[] = [];
  for (const item of journal.items) {
    const root = roots.find(({ id }) => id === item.rootId);
    if (!root || ids.has(item.rootId)) throw new Error(invalidJournal);
    ids.add(item.rootId);
    const target = resolve(root.path);
    if (target === dirname(target) || !samePath(item.target, target)) throw new Error(invalidJournal);
    if ('stage' in item) {
      const suffix = `-${items.length}`;
      const name = basename(item.stage);
      const token = name.slice('.rezics-restore-'.length, -suffix.length);
      if (!operationId.test(token) || (operation !== undefined && operation !== token)) throw new Error(invalidJournal);
      operation = token;
      const stage = restoreStage(target, operation, items.length);
      if (!samePath(item.stage, stage)) throw new Error(invalidJournal);
      items.push({ target, stage, existed: item.existed });
    } else {
      if (!operation || (journal.phase !== 'staging' && (!item.incoming || !item.parent))) {
        throw new Error(invalidJournal);
      }
      items.push({
        target,
        stage: restoreStage(target, operation, items.length),
        existed: item.before !== null,
        before: item.before,
        ...(item.parent && { parent: item.parent }),
        ...(item.incoming && { incoming: item.incoming }),
      });
    }
  }
  if (items.some((item, index) => items.slice(index + 1).some((other) => relative(item.target, other.target) === ''))) {
    throw new Error(invalidJournal);
  }
  return { phase: journal.phase, items };
}

async function planRecovery(item: RecoveryItem, phase: SaveRestoreJournal['phase']) {
  const { target, stage, before, incoming } = item;
  await checkLocalDirectory(dirname(target), 'save parent');
  if (item.parent) await confirmRestoreDirectory(dirname(target), item.parent);
  await checkLocalDirectory(stage, 'save recovery');
  const previous = await restoreDirectory(join(stage, 'previous'));
  const next = await restoreDirectory(join(stage, 'next'));
  if (previous && !item.existed) throw new Error(invalidJournal);
  if (phase === 'staging') {
    if (previous) throw new Error(invalidJournal);
    return 'keep';
  }
  if (before !== undefined) {
    if ((previous && !sameDirectory(previous, before)) || (next && !sameDirectory(next, incoming))) {
      throw new Error(changedDirectory);
    }
  }
  if (phase === 'installed') return 'keep';

  const live = await restoreDirectory(target);
  if (previous && live && next) throw new Error(changedDirectory);
  if (before !== undefined) {
    if (previous) {
      if (live && !sameDirectory(live, incoming)) throw new Error(changedDirectory);
    } else if (before) {
      if (!sameDirectory(live, before)) throw new Error(changedDirectory);
    } else if (live && (!sameDirectory(live, incoming) || next)) {
      throw new Error(changedDirectory);
    }
  }
  if (previous) return 'restore';
  if (!item.existed && live && !next && (before === null || (await fileInfo(stage)))) return 'remove';
  return 'keep';
}

async function rewindIncoming(item: RecoveryItem, linuxRename?: LinuxDirectoryRename) {
  const { target, stage, incoming } = item;
  if (!(await restoreDirectory(target))) return;
  await moveRestoreDirectory(target, join(stage, 'next'), incoming, linuxRename);
}

export async function recoverSaveRestore(path: string, saveRoots: SaveRoots, linuxRename?: LinuxDirectoryRename) {
  const journal = await readRestoreRecovery(path, saveRoots);
  if (!journal) return;
  // Validate the entire operation before rolling back any one root.
  const actions = await Promise.all(journal.items.map((item) => planRecovery(item, journal.phase)));
  for (const [index, item] of journal.items.entries()) {
    const { stage, target } = item;
    const action = actions[index];
    if ((await planRecovery(item, journal.phase)) !== action) throw new Error(changedDirectory);
    if (action !== 'keep') await rewindIncoming(item, linuxRename);
    if (action === 'restore') {
      await moveRestoreDirectory(join(stage, 'previous'), target, item.before ?? undefined, linuxRename);
    }
    await rm(stage, { recursive: true, force: true });
  }
  await rm(path, { force: true });
}
