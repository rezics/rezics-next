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
    selection: record.selection ?? null, labels: record.labels, qualifier: record.qualifier ?? null });
}

/** A record's place in its Book: the correspondence key of its group, or null at the top level. */
type Parent = string | null;
interface Mapped { record: Record; parent: Parent }

/**
 * Source uses by correspondence key. A Book nests one level: a group stands at
 * the top level and a chapter under the top level or one such group.
 */
function mapSource(snapshot: Snapshot, conflicts: RefreshConflict[]): Map<string, Mapped> {
  const found = new Map<string, Mapped>();
  const byOccurrence = new Map(snapshot.records.map(record => [record.occurrence, record]));
  for (const record of snapshot.records) {
    if (record.state === 'removed') continue;
    const key = sourceCorrespondence(snapshot.structure, sourceKey(record));
    const owner = record.parent === snapshot.structure ? null : byOccurrence.get(record.parent);
    if (record.role !== 'chapter' && record.role !== 'group'
      || record.parent !== snapshot.structure && (record.role === 'group' || owner?.state !== 'active'
        || owner.role !== 'group' || owner.parent !== snapshot.structure)) {
      conflicts.push({ sourceKey: key, reason: 'unknown-child-correspondence' });
      continue;
    }
    if (found.has(key)) conflicts.push({ sourceKey: key, reason: 'ambiguous-key' });
    found.set(key, { record, parent: owner ? sourceCorrespondence(snapshot.structure, sourceKey(owner)) : null });
  }
  return found;
}

/** Active uses in reading order: the top level in order, each group's chapters where it stands. */
function readingOrder(rows: readonly Record[], structure: string): Record[] {
  const active = rows.filter(row => row.state === 'active')
    .sort((a, b) => a.segmentKey!.localeCompare(b.segmentKey!) || a.orderKey!.localeCompare(b.orderKey!));
  const children = new Map<string, Record[]>();
  for (const row of active) children.set(row.parent, [...children.get(row.parent) ?? [], row]);
  return (children.get(structure) ?? []).flatMap(row => [row, ...children.get(row.occurrence) ?? []]);
}
const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/**
 * Bounded three-way merge; ambiguous child or simultaneous divergent edits return
 * explicit conflicts. Order includes each use's group, so moving a chapter into
 * another volume is an order change on the side that moved it.
 */
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
  const base = input.base ? mapSource(input.base, conflicts) : new Map<string, Mapped>();
  const localStructure = input.local.structure;
  const localById = new Map(input.local.records.map(record => [record.occurrence, record]));
  /** A local use's key: its source correspondence, or its own identity for a human use. */
  const localKey = (record: Record) => record.sourceKey?.startsWith('source:') ? record.sourceKey
    : `local:${record.occurrence}`;
  const local = new Map<string, Mapped>();
  const human: Record[] = [];
  for (const record of input.local.records) {
    const owner = record.parent === localStructure ? null : localById.get(record.parent);
    if (record.role !== 'chapter' && record.role !== 'group'
      || record.parent !== localStructure && (record.role === 'group' || owner?.role !== 'group'
        || owner.parent !== localStructure)) {
      conflicts.push({ sourceKey: record.sourceKey ?? record.occurrence,
        reason: 'unknown-child-correspondence' });
      continue;
    }
    if (record.sourceKey?.startsWith('source:')) {
      if (local.has(record.sourceKey)) {
        conflicts.push({ sourceKey: record.sourceKey, reason: 'ambiguous-key' });
      }
      local.set(record.sourceKey, { record, parent: owner ? localKey(owner) : null });
    } else human.push(record);
  }
  const result = new Map<string, Record>();
  let comparisons = 0;
  for (const [key, { record: incoming }] of source) {
    const prior = base.get(key)?.record;
    const current = local.get(key)?.record;
    comparisons++;
    if (!prior) {
      if (current) {
        conflicts.push({ sourceKey: key, reason: 'ambiguous-key' });
        continue;
      }
      result.set(key, { ...incoming, occurrence: derivedId(`${input.revision}\0${key}`),
        parent: localStructure, sourceKey: key, introducedBy: input.revision });
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
      const { target: _target, selection: _selection, qualifier: _qualifier, ...withoutSourceContent } = current;
      result.set(key, { ...withoutSourceContent, role: incoming.role,
        ...(incoming.target !== undefined ? { target: incoming.target } : {}),
        ...(incoming.selection !== undefined ? { selection: incoming.selection } : {}),
        ...(incoming.qualifier !== undefined ? { qualifier: incoming.qualifier } : {}),
        labels: incoming.labels });
    } else result.set(key, current);
  }
  for (const [key, { record: prior }] of base) {
    if (source.has(key)) continue;
    const current = local.get(key)?.record;
    if (!current || current.state === 'removed') continue;
    comparisons++;
    if (content(current) !== content(prior)) {
      conflicts.push({ sourceKey: key, reason: 'local-and-source-edit' });
    } else {
      const { segmentKey: _segmentKey, orderKey: _orderKey, ...withoutOrder } = current;
      result.set(key, { ...withoutOrder, state: 'removed', removedBy: input.revision });
    }
  }
  // Order is compared as the reading sequence of the uses all three sides share, each with its group.
  const sequence = (snapshot: Snapshot) => readingOrder(snapshot.records, snapshot.structure)
    .map(row => sourceCorrespondence(input.source.structure, sourceKey(row)));
  const placedIn = (mapped: Map<string, Mapped>, key: string) => `${mapped.get(key)?.parent ?? ''}>${key}`;
  const baseOrder = input.base ? sequence(input.base) : [];
  const sourceOrder = sequence(input.source);
  const localOrder = readingOrder(input.local.records, localStructure).map(localKey)
    .filter(key => base.has(key));
  const common = new Set(baseOrder.filter(key => source.has(key) && local.has(key)));
  const arranged = (keys: readonly string[], mapped: Map<string, Mapped>) =>
    keys.filter(key => common.has(key)).map(key => placedIn(mapped, key));
  const sourceMoved = !same(arranged(sourceOrder, source), arranged(baseOrder, base));
  const localMoved = !same(arranged(localOrder, local), arranged(baseOrder, base));
  if (sourceMoved && localMoved && !same(arranged(sourceOrder, source), arranged(localOrder, local))) {
    conflicts.push({ sourceKey: '*', reason: 'local-and-source-order' });
  }
  if (sourceMoved && human.some(row => row.state === 'active')) {
    conflicts.push({ sourceKey: '*', reason: 'unknown-child-correspondence' });
  }
  const cost = { sourceRecords: input.source.records.length, baseRecords: input.base?.records.length ?? 0,
    localRecords: input.local.records.length, comparisons };
  if (conflicts.length) return { records: [], conflicts, cost };
  // The arrangement: each kept use with the key of the group it stands in.
  const arrangement: { key: string; row: Record; parent: Parent }[] = [];
  const seen = new Set<string>();
  const place = (key: string, parent: Parent) => {
    const row = result.get(key);
    if (row?.state === 'active' && !seen.has(key)) {
      arrangement.push({ key, row, parent });
      seen.add(key);
    }
  };
  if (sourceMoved && !localMoved) {
    for (const key of sourceOrder) place(key, source.get(key)!.parent);
  } else {
    for (const row of readingOrder(input.local.records, localStructure)) {
      const key = localKey(row);
      const owner = row.parent === localStructure ? null : localKey(localById.get(row.parent)!);
      if (!row.sourceKey?.startsWith('source:')) {
        arrangement.push({ key, row, parent: owner });
        seen.add(key);
      } else place(key, owner);
    }
    for (const key of sourceOrder) place(key, source.get(key)!.parent);
  }
  if (arrangement.length > STRUCTURE_LIMITS.stageRecords) {
    throw new StructureRefreshInvalid('refresh result exceeds the bounded stage');
  }
  // A use follows its group; one whose group did not survive the merge has no place to stand.
  const destination = new Map(arrangement.map(item => [item.key, item.row]));
  const children = new Map<string, Record[]>();
  for (const item of arrangement) {
    const owner = item.parent === null ? null : destination.get(item.parent);
    if (item.parent !== null && owner?.role !== 'group') {
      return { records: [], conflicts: [{ sourceKey: item.key, reason: 'unknown-child-correspondence' }], cost };
    }
    const parent = owner?.occurrence ?? localStructure;
    children.set(parent, [...children.get(parent) ?? [], { ...item.row, parent }]);
  }
  const positioned = [...children.values()].flatMap(rows => {
    const segments = Math.ceil(rows.length / STRUCTURE_LIMITS.segmentMembers);
    const segmentKeys = evenKeys(segments);
    return rows.map((row, index) => {
      const segment = Math.floor(index / STRUCTURE_LIMITS.segmentMembers);
      const count = Math.min(STRUCTURE_LIMITS.segmentMembers, rows.length - segment * STRUCTURE_LIMITS.segmentMembers);
      return { ...row, segmentKey: segmentKeys[segment]!,
        orderKey: evenKeys(count)[index % STRUCTURE_LIMITS.segmentMembers]! };
    });
  });
  const removed = [...result.values(), ...human].filter(row => row.state === 'removed');
  return { records: [...positioned, ...removed], conflicts, cost };
}
