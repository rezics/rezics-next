import { createHash } from 'node:crypto';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { STRUCTURE_QUALIFIER_KEY_INDEX_FORMAT, STRUCTURE_INDEXED_MANIFEST_FORMAT,
  checkStructurePage, InvalidStructureObject,
  type OccurrenceRecord, type QualifierKeyIndexRoot, type StructureManifest } from './format.ts';
import { StructureTree, StructureObjectCorrupt, StructureObjectUnavailable, newCost,
  type TreeCost, type TreeRoot } from './tree.ts';

/** Only an immutable authored qualifier supplies a key in this revision.
 * Current Resource metadata needs its own source-promotion proof first. */
export interface QualifierKey { type: 'zone-mount'; zone: string; routeSegment: string }
export interface QualifierKeyEntry { key: string; occurrence: string }
export type QualifierIndexSource = Pick<StructureManifest,
  'structure' | 'structureOf' | 'profile' | 'generation' | 'records' | 'order' | 'placementCount'>;
export interface QualifierKeyProgress { sourceRoot: string; after: string | null; visited: number; root: TreeRoot }
export const QUALIFIER_KEY_COST = { candidates: 101, visits: 4096, prepareBatch: 256,
  objectPages: 160, objectBytes: 4 * 1024 * 1024, deadlineMs: 10_000 } as const;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
async function validateSourceRecordRoot(objects: ImmutableObjects, source: QualifierIndexSource, cost: TreeCost) {
  let root;
  try { root = checkStructurePage(await objects.get(source.records.page.slice(7))); }
  catch (error) {
    if (error instanceof ObjectUnavailable) throw new StructureObjectUnavailable(error.message);
    if (error instanceof InvalidStructureObject || error instanceof ObjectIntegrityError) throw new StructureObjectCorrupt(error.message);
    throw error;
  }
  cost.pagesRead++;
  const count = root.level === 0 ? root.entries.length
    : (root.entries as Array<{ count: number }>).reduce((total, child) => total + child.count, 0);
  if (root.tree !== 'record' || root.level !== source.records.level || count !== source.records.count) {
    throw new StructureObjectCorrupt('Qualifier source record root differs from its descriptor');
  }
}
export function qualifierKeyPrefix(key: QualifierKey): string {
  if (key.type !== 'zone-mount' || !native.test(key.zone)
    || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key.routeSegment) || key.routeSegment.length > 64) {
    throw new StructureObjectCorrupt('Qualifier key is invalid');
  }
  return `${digest([key.type, key.zone, key.routeSegment])}\u0001`;
}
export function qualifierKeyOf(record: OccurrenceRecord): QualifierKey | null {
  return record.state === 'active' && record.role === 'mount' && record.qualifier?.type === 'zone-mount'
    ? { type: 'zone-mount', zone: record.qualifier.zone, routeSegment: record.qualifier.routeSegment } : null;
}
export function qualifierSourceRoot(source: QualifierIndexSource): string {
  const root = (value: TreeRoot) => [value.page, value.level, value.count];
  return `sha256:${digest([source.structure, source.structureOf, source.profile, source.generation,
    root(source.records), root(source.order), source.placementCount])}`;
}
export function qualifierKeyTree(objects: ImmutableObjects) {
  return new StructureTree<QualifierKeyEntry>(objects, 'qualifier-key', entry => {
    if (entry.key.slice(65) !== entry.occurrence) throw new StructureObjectCorrupt('Qualifier posting identity differs');
    return entry.key;
  });
}
export function requireQualifierKeyIndex(source: StructureManifest): QualifierKeyIndexRoot {
  if (source.format !== STRUCTURE_INDEXED_MANIFEST_FORMAT) {
    throw new StructureObjectUnavailable('Retained qualifier key coverage is unavailable; prepare this exact source root');
  }
  if (source.qualifierKeys.sourceRoot !== qualifierSourceRoot(source)
    || source.qualifierKeys.root.count > source.records.count) {
    throw new StructureObjectCorrupt('Qualifier key coverage differs from selected source roots');
  }
  return source.qualifierKeys;
}
function posting(record: OccurrenceRecord): QualifierKeyEntry | null {
  const key = qualifierKeyOf(record);
  return key ? { key: `${qualifierKeyPrefix(key)}${record.occurrence}`, occurrence: record.occurrence } : null;
}
export async function createQualifierKeyIndex(objects: ImmutableObjects, source: QualifierIndexSource,
  records: readonly OccurrenceRecord[], cost: TreeCost): Promise<QualifierKeyIndexRoot> {
  await validateSourceRecordRoot(objects, source, cost);
  if (records.length !== source.records.count || new Set(records.map(record => record.occurrence)).size !== records.length) {
    throw new StructureObjectCorrupt('Qualifier key construction lacks the complete retained record set');
  }
  const retained = await new StructureTree<OccurrenceRecord>(objects, 'record', entry => entry.occurrence)
    .lookup(source.records, records.map(record => record.occurrence), cost);
  if (records.some(record => !retained.has(record.occurrence) || digest(retained.get(record.occurrence)) !== digest(record))) {
    throw new StructureObjectCorrupt('Qualifier key construction differs from authoritative records');
  }
  const tree = qualifierKeyTree(objects), changes = new Map<string, QualifierKeyEntry>();
  for (const record of records) { const entry = posting(record); if (entry) changes.set(entry.key, entry); }
  return { format: STRUCTURE_QUALIFIER_KEY_INDEX_FORMAT, sourceRoot: qualifierSourceRoot(source),
    root: await tree.apply(await tree.empty(cost), changes, cost) };
}
/** Bounded deltas preserve complete coverage only from a complete predecessor.
 * Legacy ordinary writes keep their legacy format; absence never invents an empty index. */
export async function updateQualifierKeyIndex(objects: ImmutableObjects, previous: StructureManifest,
  next: QualifierIndexSource, changes: readonly { before?: OccurrenceRecord; after?: OccurrenceRecord }[],
  cost: TreeCost): Promise<QualifierKeyIndexRoot | undefined> {
  if (previous.format !== STRUCTURE_INDEXED_MANIFEST_FORMAT) return undefined;
  await validateSourceRecordRoot(objects, previous, cost);
  await validateSourceRecordRoot(objects, next, cost);
  const prior = requireQualifierKeyIndex(previous), edits = new Map<string, QualifierKeyEntry | null>();
  const records = new StructureTree<OccurrenceRecord>(objects, 'record', entry => entry.occurrence);
  const beforeRecords = await records.lookup(previous.records, changes.flatMap(change => change.before ? [change.before.occurrence] : []), cost);
  const afterRecords = await records.lookup(next.records, changes.flatMap(change => change.after ? [change.after.occurrence] : []), cost);
  for (const change of changes) {
    if (change.before && (!beforeRecords.has(change.before.occurrence) || digest(beforeRecords.get(change.before.occurrence)) !== digest(change.before))
      || change.after && (!afterRecords.has(change.after.occurrence) || digest(afterRecords.get(change.after.occurrence)) !== digest(change.after))
      || change.before && change.after && change.before.occurrence !== change.after.occurrence) {
      throw new StructureObjectCorrupt('Qualifier key delta differs from authoritative records');
    }
    const before = change.before && posting(change.before), after = change.after && posting(change.after);
    if (before) edits.set(before.key, null);
    if (after) edits.set(after.key, after);
  }
  return { format: STRUCTURE_QUALIFIER_KEY_INDEX_FORMAT, sourceRoot: qualifierSourceRoot(next),
    root: await qualifierKeyTree(objects).apply(prior.root, edits, cost) };
}
/** Preparation belongs to the existing retained-root owner. Resume binds the
 * exact immutable source; this pure turn performs no graph/head publication. */
export async function prepareQualifierKeyIndexBatch(objects: ImmutableObjects, source: QualifierIndexSource,
  progress?: QualifierKeyProgress, cost: TreeCost = newCost()): Promise<{
    complete: boolean; progress: QualifierKeyProgress; index?: QualifierKeyIndexRoot;
  }> {
  const sourceRoot = qualifierSourceRoot(source), tree = qualifierKeyTree(objects);
  await validateSourceRecordRoot(objects, source, cost);
  if (progress && (progress.sourceRoot !== sourceRoot || !Number.isSafeInteger(progress.visited)
    || progress.visited < 0 || progress.visited > source.records.count
    || progress.after !== null && !native.test(progress.after))) {
    throw new StructureObjectCorrupt('Qualifier preparation cursor differs from retained source');
  }
  const records = new StructureTree<OccurrenceRecord>(objects, 'record', entry => entry.occurrence);
  const candidates = await records.range(source.records, progress?.after ? `${progress.after}\u0000` : '',
    '\uffff', QUALIFIER_KEY_COST.prepareBatch + 1, cost);
  const batch = candidates.slice(0, QUALIFIER_KEY_COST.prepareBatch);
  const edits = new Map<string, QualifierKeyEntry>();
  for (const record of batch) { const entry = posting(record); if (entry) edits.set(entry.key, entry); }
  const next = { sourceRoot, after: batch.at(-1)?.occurrence ?? progress?.after ?? null,
    visited: (progress?.visited ?? 0) + batch.length,
    root: await tree.apply(progress?.root ?? await tree.empty(cost), edits, cost) };
  const exhausted = candidates.length <= QUALIFIER_KEY_COST.prepareBatch;
  if (next.visited > source.records.count || exhausted && next.visited !== source.records.count
    || !exhausted && next.visited >= source.records.count) {
    throw new StructureObjectCorrupt('Qualifier preparation record coverage differs from source');
  }
  const complete = exhausted && next.visited === source.records.count;
  return { complete, progress: next, ...(complete ? { index: {
    format: STRUCTURE_QUALIFIER_KEY_INDEX_FORMAT, sourceRoot, root: next.root } } : {}) };
}
