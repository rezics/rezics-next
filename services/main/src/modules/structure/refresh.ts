import { createHash } from 'node:crypto';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { ObjectIntegrityError, ObjectUnavailable } from '../../infrastructure/immutable-objects.ts';
import { checkStructureManifest, InvalidStructureObject, STRUCTURE_LIMITS,
  type OccurrenceRecord, type StructureManifest } from './format.ts';
import { CompositionCorrupt, CompositionUnavailable, NATIVE_ID, derivedId,
  readCompositionHeader } from './graph.ts';
import { recordTree, structureObjects } from './change.ts';
import { evenKeys } from './order-key.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable, newCost } from './tree.ts';

export class StructureRefreshInvalid extends Error {}

/** One source item has one stable destination correspondence across source revisions. */
export function sourceCorrespondence(sourceStructure: string, sourceKey: string): string {
  return `source:${createHash('sha256').update(`${sourceStructure}\0${sourceKey}`).digest('hex')}`;
}

type Record = OccurrenceRecord;
type Snapshot = { structure: string; records: readonly Record[] };
export interface BookStructureSnapshot extends Snapshot {
  revision: string;
  manifest: StructureManifest;
}

/** Read one complete, bounded Book state from its exact immutable revision root. */
export async function readBookStructureSnapshot(env: WorkActivationEnvironment,
  structure: string, revision: string): Promise<BookStructureSnapshot> {
  if (!NATIVE_ID.test(structure) || !NATIVE_ID.test(revision)) {
    throw new CompositionUnavailable('Book source identity is invalid');
  }
  const header = await readCompositionHeader(env, structure);
  if (!header || header.profile !== 'book-composition') {
    throw new CompositionUnavailable('Book source is unavailable');
  }
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:StructureRevision ;
      rv:component ${iri(structure)} ; rv:manifest ?manifest . } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const reference = rows[0]?.manifest?.value;
  if (!rows.length) throw new CompositionUnavailable('Book source revision is unavailable');
  if (rows.length !== 1 || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(reference ?? '')) {
    throw new CompositionCorrupt('Book source revision is ambiguous');
  }
  const objects = structureObjects(env);
  let manifest: StructureManifest;
  try { manifest = checkStructureManifest(await objects.get(reference!.slice(-64))); }
  catch (error) {
    if (error instanceof ObjectIntegrityError || error instanceof InvalidStructureObject) {
      throw new StructureObjectCorrupt(error.message);
    }
    if (error instanceof ObjectUnavailable) throw new StructureObjectUnavailable(error.message);
    throw error;
  }
  if (manifest.structure !== structure || manifest.structureOf !== header.component
    || manifest.profile !== header.profile || manifest.records.count > STRUCTURE_LIMITS.stageRecords) {
    throw new StructureObjectCorrupt('Book source revision exceeds the refresh bound');
  }
  const records = await recordTree(objects).range(manifest.records, '', '\uffff',
    STRUCTURE_LIMITS.stageRecords + 1, newCost());
  if (records.length !== manifest.records.count) {
    throw new StructureObjectCorrupt('Book source record count differs');
  }
  return { structure, revision, manifest, records };
}
export interface RefreshConflict { sourceKey: string; reason: 'ambiguous-key' | 'local-and-source-edit'
  | 'local-and-source-order' | 'unknown-child-correspondence' }
export interface RefreshPlan {
  records: Record[];
  conflicts: RefreshConflict[];
  cost: { sourceRecords: number; baseRecords: number; localRecords: number; comparisons: number };
}

function sourceKey(record: Record): string { return record.sourceKey ?? record.occurrence; }
function content(record: Record): string {
  return JSON.stringify({ role: record.role, target: record.target ?? null,
    selection: record.selection ?? null, labels: record.labels });
}
function mapSource(snapshot: Snapshot, conflicts: RefreshConflict[]): Map<string, Record> {
  const found = new Map<string, Record>();
  for (const record of snapshot.records) {
    if (record.state === 'removed') continue;
    const key = sourceCorrespondence(snapshot.structure, sourceKey(record));
    if (record.parent !== snapshot.structure || record.role !== 'chapter') {
      conflicts.push({ sourceKey: key, reason: 'unknown-child-correspondence' });
      continue;
    }
    if (found.has(key)) conflicts.push({ sourceKey: key, reason: 'ambiguous-key' });
    found.set(key, record);
  }
  return found;
}

const ordered = (rows: readonly Record[]) => [...rows].filter(row => row.state === 'active')
  .sort((a, b) => a.segmentKey!.localeCompare(b.segmentKey!)
    || a.orderKey!.localeCompare(b.orderKey!));
const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/** Bounded three-way merge; ambiguous child or simultaneous divergent edits return explicit conflicts. */
export function planBookRefresh(input: { source: Snapshot; base?: Snapshot; local: Snapshot;
  revision: string }): RefreshPlan {
  if (input.source.records.length > STRUCTURE_LIMITS.stageRecords
    || (input.base?.records.length ?? 0) > STRUCTURE_LIMITS.stageRecords
    || input.local.records.length > STRUCTURE_LIMITS.stageRecords
    || input.base && input.base.structure !== input.source.structure) {
    throw new StructureRefreshInvalid('refresh exceeds the bounded stage or changes source identity');
  }
  const conflicts: RefreshConflict[] = [];
  const source = mapSource(input.source, conflicts);
  const base = input.base ? mapSource(input.base, conflicts) : new Map<string, Record>();
  const local = new Map<string, Record>();
  const human: Record[] = [];
  for (const record of input.local.records) {
    if (record.parent !== input.local.structure || record.role !== 'chapter') {
      conflicts.push({ sourceKey: record.sourceKey ?? record.occurrence,
        reason: 'unknown-child-correspondence' });
      continue;
    }
    if (record.sourceKey?.startsWith('source:')) {
      if (local.has(record.sourceKey)) {
        conflicts.push({ sourceKey: record.sourceKey, reason: 'ambiguous-key' });
      }
      local.set(record.sourceKey, record);
    } else human.push(record);
  }
  const result = new Map<string, Record>();
  let comparisons = 0;
  for (const [key, incoming] of source) {
    const prior = base.get(key);
    const current = local.get(key);
    comparisons++;
    if (!prior) {
      if (current) {
        conflicts.push({ sourceKey: key, reason: 'ambiguous-key' });
        continue;
      }
      result.set(key, { ...incoming, occurrence: derivedId(`${input.revision}\0${key}`),
        parent: input.local.structure, sourceKey: key, introducedBy: input.revision });
      continue;
    }
    if (!current) {
      conflicts.push({ sourceKey: key, reason: 'ambiguous-key' });
      continue;
    }
    if (current.state === 'removed') {
      if (content(incoming) !== content(prior)) {
        conflicts.push({ sourceKey: key, reason: 'local-and-source-edit' });
      }
      result.set(key, current);
      continue;
    }
    const sourceChanged = content(incoming) !== content(prior);
    const localChanged = content(current) !== content(prior);
    if (sourceChanged && localChanged && content(incoming) !== content(current)) {
      conflicts.push({ sourceKey: key, reason: 'local-and-source-edit' });
      continue;
    }
    if (sourceChanged && !localChanged) {
      const { target: _target, selection: _selection, ...withoutSourceContent } = current;
      result.set(key, { ...withoutSourceContent, role: incoming.role,
        ...(incoming.target !== undefined ? { target: incoming.target } : {}),
        ...(incoming.selection !== undefined ? { selection: incoming.selection } : {}),
        labels: incoming.labels });
    } else result.set(key, current);
  }
  for (const [key, prior] of base) {
    if (source.has(key)) continue;
    const current = local.get(key);
    if (!current || current.state === 'removed') continue;
    comparisons++;
    if (content(current) !== content(prior)) {
      conflicts.push({ sourceKey: key, reason: 'local-and-source-edit' });
    } else {
      const { segmentKey: _segmentKey, orderKey: _orderKey, ...withoutOrder } = current;
      result.set(key, { ...withoutOrder, state: 'removed', removedBy: input.revision });
    }
  }
  const baseOrder = ordered(input.base?.records ?? []).map(row =>
    sourceCorrespondence(input.source.structure, sourceKey(row)));
  const sourceOrder = ordered(input.source.records).map(row =>
    sourceCorrespondence(input.source.structure, sourceKey(row)));
  const localOrder = ordered(input.local.records).map(row => row.sourceKey)
    .filter((key): key is string => Boolean(key && base.has(key)));
  const common = new Set(baseOrder.filter(key => source.has(key) && local.has(key)));
  const normalized = (keys: readonly string[]) => keys.filter(key => common.has(key));
  const sourceMoved = !same(normalized(sourceOrder), normalized(baseOrder));
  const localMoved = !same(normalized(localOrder), normalized(baseOrder));
  if (sourceMoved && localMoved && !same(normalized(sourceOrder), normalized(localOrder))) {
    conflicts.push({ sourceKey: '*', reason: 'local-and-source-order' });
  }
  if (sourceMoved && human.some(row => row.state === 'active')) {
    conflicts.push({ sourceKey: '*', reason: 'unknown-child-correspondence' });
  }
  if (conflicts.length) return { records: [], conflicts,
    cost: { sourceRecords: input.source.records.length, baseRecords: input.base?.records.length ?? 0,
      localRecords: input.local.records.length, comparisons } };
  const useSourceOrder = sourceMoved && !localMoved;
  const seen = new Set<string>();
  const active: Record[] = [];
  if (useSourceOrder) {
    for (const key of sourceOrder) {
      const row = result.get(key);
      if (row?.state === 'active' && !seen.has(key)) {
        active.push(row);
        seen.add(key);
      }
    }
  } else {
    for (const row of ordered(input.local.records)) {
      if (!row.sourceKey?.startsWith('source:')) {
        active.push(row);
        continue;
      }
      const merged = result.get(row.sourceKey);
      if (merged?.state === 'active' && !seen.has(row.sourceKey)) {
        active.push(merged);
        seen.add(row.sourceKey);
      }
    }
    for (const key of sourceOrder) {
      const row = result.get(key);
      if (row?.state === 'active' && !seen.has(key)) {
        active.push(row);
        seen.add(key);
      }
    }
  }
  if (active.length > STRUCTURE_LIMITS.stageRecords) {
    throw new StructureRefreshInvalid('refresh result exceeds the bounded stage');
  }
  const keys = new Map<number, string[]>();
  const positioned = active.map((row, index) => {
    const segment = Math.floor(index / STRUCTURE_LIMITS.segmentMembers);
    const count = Math.min(STRUCTURE_LIMITS.segmentMembers,
      active.length - segment * STRUCTURE_LIMITS.segmentMembers);
    if (!keys.has(segment)) keys.set(segment, evenKeys(count));
    return { ...row, segmentKey: segment.toString(36),
      orderKey: keys.get(segment)![index % STRUCTURE_LIMITS.segmentMembers]! };
  });
  const removed = [...result.values(), ...human].filter(row => row.state === 'removed');
  return { records: [...positioned, ...removed], conflicts,
    cost: { sourceRecords: input.source.records.length, baseRecords: input.base?.records.length ?? 0,
      localRecords: input.local.records.length, comparisons } };
}
