import { isVisualNovelSaveRoot, type RestorePreview, type VisualNovelRestoreChoice } from '@rezics/launcher-contract';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathOverlaps } from './instances.ts';
import type { SnapshotRecord } from './save-bundles.ts';
import { restoreDirectory } from './save-restore-journal.ts';
import type { SnapshotRoot } from './save-tree.ts';
import type { SaveRoot } from './saves.ts';

export const restoreReviewChanged = 'The save destinations changed. Preview this backup again before restoring.';

type Route = { saved: SnapshotRoot; target: SaveRoot };
type RestorePlan = { routes: Route[]; complete: boolean; visualNovel?: RestorePreview['visualNovel'] };
type DirectoryIdentity = Awaited<ReturnType<typeof restoreDirectory>>;
type CheckedRoute = Route & { before: DirectoryIdentity; parent: DirectoryIdentity };

export function planSaveRestore(
  record: SnapshotRecord,
  roots: SaveRoot[],
  visualNovel: boolean,
  choices?: VisualNovelRestoreChoice[],
): RestorePlan {
  const sources = new Map(record.roots.map((root) => [root.id, root]));
  if (!sources.size || sources.size > 8 || sources.size !== record.roots.length) {
    throw new Error('The backup has invalid save locations.');
  }
  if (choices !== undefined && !visualNovel) throw new Error('Choose a visual novel to change restore destinations.');

  if (!visualNovel) {
    const routes = record.roots.map((saved) => {
      const target = roots.find(({ id }) => id === saved.id);
      if (!target) throw new Error('A save location from this snapshot is unavailable.');
      return { saved, target };
    });
    return { routes, complete: true };
  }

  const available = roots.flatMap(({ id, path }) => (isVisualNovelSaveRoot(id) ? [{ id, path }] : []));
  const savedRoots = record.roots.map(({ id, files, bytes }) => {
    if (!isVisualNovelSaveRoot(id)) throw new Error('This backup has unsupported visual novel save locations.');
    return { id, files, bytes };
  });
  const chosen =
    choices ??
    savedRoots.flatMap(({ id }) => (available.some((root) => root.id === id) ? [{ sourceId: id, targetId: id }] : []));
  const availableById = new Map(available.map((root) => [root.id, root]));
  const selected = new Map<VisualNovelRestoreChoice['sourceId'], VisualNovelRestoreChoice['targetId']>();
  const used = new Set<VisualNovelRestoreChoice['sourceId']>();
  for (const { sourceId, targetId } of chosen) {
    if (!sources.has(sourceId) || selected.has(sourceId) || (targetId !== null && !availableById.has(targetId))) {
      throw new Error(restoreReviewChanged);
    }
    if (targetId !== null) {
      if (used.has(targetId)) throw new Error('Choose a different destination for each backup folder.');
      used.add(targetId);
    }
    selected.set(sourceId, targetId);
  }
  const routes = savedRoots.flatMap(({ id }) => {
    const targetId = selected.get(id);
    return targetId ? [{ saved: sources.get(id)!, target: availableById.get(targetId)! }] : [];
  });
  return {
    routes,
    complete: selected.size === savedRoots.length && routes.length > 0,
    visualNovel: { sources: savedRoots, destinations: available, choices: chosen },
  };
}

export async function inspectRestoreTargets(snapshotId: string, routes: Route[]) {
  const checked: CheckedRoute[] = [];
  for (const { saved, target } of routes) {
    const path = resolve(target.path);
    if (path === dirname(path) || checked.some((route) => pathOverlaps(route.target.path, path))) {
      throw new Error('The backup has invalid save locations.');
    }
    const [before, parent] = await Promise.all([restoreDirectory(path), restoreDirectory(dirname(path))]);
    checked.push({ saved, target: { id: target.id, path }, before, parent });
  }
  const revision = createHash('sha256').update(JSON.stringify({ snapshotId, checked })).digest('hex');
  return { checked, revision };
}
