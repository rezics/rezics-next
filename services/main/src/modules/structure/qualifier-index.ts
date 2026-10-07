import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { STRUCTURE_QUALIFIER_KEY_INDEX_FORMAT, STRUCTURE_INDEXED_MANIFEST_FORMAT,
  checkStructureManifest, checkStructurePage, InvalidStructureObject, STRUCTURE_LIMITS,
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
  progress?: QualifierKeyProgress, cost: TreeCost = newCost(), batchLimit: number = QUALIFIER_KEY_COST.prepareBatch): Promise<{
    complete: boolean; progress: QualifierKeyProgress; index?: QualifierKeyIndexRoot;
  }> {
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > QUALIFIER_KEY_COST.prepareBatch)
    throw new StructureObjectCorrupt('Qualifier preparation turn width is invalid');
  const sourceRoot = qualifierSourceRoot(source), tree = qualifierKeyTree(objects);
  await validateSourceRecordRoot(objects, source, cost);
  if (progress && (progress.sourceRoot !== sourceRoot || !Number.isSafeInteger(progress.visited)
    || progress.visited < 0 || progress.visited > source.records.count
    || progress.after !== null && !native.test(progress.after))) {
    throw new StructureObjectCorrupt('Qualifier preparation cursor differs from retained source');
  }
  const records = new StructureTree<OccurrenceRecord>(objects, 'record', entry => entry.occurrence);
  const candidates = await records.range(source.records, progress?.after ? `${progress.after}\u0000` : '',
    '\uffff', batchLimit + 1, cost);
  const batch = candidates.slice(0, batchLimit);
  const edits = new Map<string, QualifierKeyEntry>();
  for (const record of batch) { const entry = posting(record); if (entry) edits.set(entry.key, entry); }
  const next = { sourceRoot, after: batch.at(-1)?.occurrence ?? progress?.after ?? null,
    visited: (progress?.visited ?? 0) + batch.length,
    root: await tree.apply(progress?.root ?? await tree.empty(cost), edits, cost) };
  const exhausted = candidates.length <= batchLimit;
  if (next.visited > source.records.count || exhausted && next.visited !== source.records.count
    || !exhausted && next.visited >= source.records.count) {
    throw new StructureObjectCorrupt('Qualifier preparation record coverage differs from source');
  }
  const complete = exhausted && next.visited === source.records.count;
  return { complete, progress: next, ...(complete ? { index: {
    format: STRUCTURE_QUALIFIER_KEY_INDEX_FORMAT, sourceRoot, root: next.root } } : {}) };
}

export interface QualifierRootCheckpoint {
  manifestDigest: string; sourceRoot: string; source: QualifierIndexSource;
  progress: QualifierKeyProgress; version: string; batchLimit: number; complete: boolean;
}
interface QualifierRootRow {
  manifest_digest: string; source_root: string; source: QualifierIndexSource;
  progress: QualifierKeyProgress; version: string; batch_limit: number; complete: boolean;
}
const checkpointColumns = 'manifest_digest, source_root, source, progress, version::text, batch_limit, complete';
const manifestSha = /^[0-9a-f]{64}$/;
function checkedQualifierRoot(root: TreeRoot): void {
  if (!root || Object.keys(root).sort().join(',') !== 'count,level,page'
    || !/^sha256:[0-9a-f]{64}$/.test(root.page) || !Number.isInteger(root.level)
    || root.level < 0 || root.level >= STRUCTURE_LIMITS.treeLevels
    || !Number.isSafeInteger(root.count) || root.count < 0 || root.count > STRUCTURE_LIMITS.maxPlacements) {
    throw new StructureObjectCorrupt('Qualifier checkpoint tree root is invalid');
  }
}
function qualifierSource(source: QualifierIndexSource): QualifierIndexSource {
  return { structure: source.structure, structureOf: source.structureOf, profile: source.profile,
    generation: source.generation, records: source.records, order: source.order, placementCount: source.placementCount };
}
function checkpointView(row: QualifierRootRow): QualifierRootCheckpoint {
  const source = row.source, progress = row.progress;
  if (!manifestSha.test(row.manifest_digest) || !source || !progress
    || !native.test(source.structure) || !native.test(source.structureOf) || !native.test(source.generation)
    || !Number.isSafeInteger(source.placementCount) || source.placementCount < 0
    || source.placementCount > STRUCTURE_LIMITS.maxPlacements
    || !Number.isInteger(row.batch_limit) || row.batch_limit < 1 || row.batch_limit > QUALIFIER_KEY_COST.prepareBatch
    || !/^(0|[1-9][0-9]*)$/.test(String(row.version)) || typeof row.complete !== 'boolean'
    || !Number.isSafeInteger(progress.visited) || progress.visited < 0
    || (progress.after === null) !== (progress.visited === 0)
    || progress.after !== null && !native.test(progress.after)) {
    throw new StructureObjectCorrupt('Qualifier preparation checkpoint is invalid');
  }
  checkedQualifierRoot(source.records); checkedQualifierRoot(source.order); checkedQualifierRoot(progress.root);
  if (row.source_root !== qualifierSourceRoot(source) || progress.sourceRoot !== row.source_root
    || progress.visited > source.records.count || progress.root.count > progress.visited
    || source.order.count !== source.placementCount || row.complete && progress.visited !== source.records.count) {
    throw new StructureObjectCorrupt('Qualifier preparation checkpoint source or count differs');
  }
  return { manifestDigest: row.manifest_digest, sourceRoot: row.source_root, source,
    progress, version: String(row.version), batchLimit: row.batch_limit, complete: row.complete };
}
function matchQualifierSource(checkpoint: QualifierRootCheckpoint, source: QualifierIndexSource): void {
  if (checkpoint.sourceRoot !== qualifierSourceRoot(source)) {
    throw new StructureObjectCorrupt('Qualifier preparation belongs to another exact source');
  }
}

class QualifierPreparationBudget extends StructureObjectUnavailable {}

/** Fixed private Content custody. A caller supplies only the original SHA;
 * cursor, totals and roots are read from authenticated objects and owner rows. */
export class StructureQualifierRootStore {
  constructor(private readonly pool: Pool, private readonly objects: ImmutableObjects) {}

  async read(manifestDigest: string): Promise<QualifierRootCheckpoint | null> {
    if (!manifestSha.test(manifestDigest)) throw new StructureObjectCorrupt('Invalid qualifier source SHA');
    const result = await this.pool.query<QualifierRootRow>(`SELECT ${checkpointColumns}
      FROM structure.qualifier_root WHERE manifest_digest = $1`, [manifestDigest]);
    return result.rows[0] ? checkpointView(result.rows[0]) : null;
  }

  async completedQualifierKeys(manifestDigest: string, source: StructureManifest): Promise<QualifierKeyIndexRoot | null> {
    const checkpoint = await this.read(manifestDigest);
    if (!checkpoint) return null;
    matchQualifierSource(checkpoint, source);
    if (!checkpoint.complete) return null;
    return { format: STRUCTURE_QUALIFIER_KEY_INDEX_FORMAT, sourceRoot: checkpoint.sourceRoot, root: checkpoint.progress.root };
  }

  /** Signed owner-cut capture/GC only; ordinary lookup never enumerates rows. */
  async retainedRoots(): Promise<QualifierRootCheckpoint[]> {
    const result = await this.pool.query<QualifierRootRow>(`SELECT ${checkpointColumns}
      FROM structure.qualifier_root ORDER BY manifest_digest`);
    return result.rows.map(checkpointView);
  }

  async prepare(manifestDigest: string): Promise<QualifierRootCheckpoint> {
    if (!manifestSha.test(manifestDigest)) throw new StructureObjectCorrupt('Invalid qualifier source SHA');
    const deadline = Date.now() + QUALIFIER_KEY_COST.deadlineMs;
    let reads = 0, bytes = 0;
    const cached = new Map<string, Promise<Uint8Array>>();
    const check = () => {
      if (Date.now() >= deadline) throw new StructureObjectUnavailable('Qualifier preparation deadline exceeded');
    };
    const objects: ImmutableObjects = { get: async key => {
      check();
      if (!cached.has(key)) {
        // Reserve the existing maximum serialized page before physical I/O;
        // rejected work cannot overshoot the turn's byte/page envelope.
        if (reads >= QUALIFIER_KEY_COST.objectPages
          || bytes + STRUCTURE_LIMITS.pageBytes > QUALIFIER_KEY_COST.objectBytes) {
          throw new QualifierPreparationBudget('Qualifier preparation needs a narrower trusted turn');
        }
        reads++;
        cached.set(key, (async () => {
          const value = await this.objects.get(key); check();
          if (value.length > STRUCTURE_LIMITS.pageBytes) throw new StructureObjectCorrupt('Qualifier source page exceeds its byte bound');
          bytes += value.length; return value;
        })());
      }
      return cached.get(key)!;
    }, put: async value => { check(); const key = await this.objects.put(value); check(); return key; } };
    let source: StructureManifest;
    try {
      const original = await objects.get(manifestDigest);
      if (createHash('sha256').update(original).digest('hex') !== manifestDigest) throw new ObjectIntegrityError('Qualifier source SHA differs');
      source = checkStructureManifest(original);
    } catch (error) {
      if (error instanceof ObjectUnavailable) throw new StructureObjectUnavailable(error.message);
      if (error instanceof ObjectIntegrityError || error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
      throw error;
    }
    if (source.order.count !== source.placementCount) throw new StructureObjectCorrupt('Qualifier source order count differs');
    let checkpoint = await this.read(manifestDigest);
    const cost = newCost();
    if (!checkpoint) {
      await validateSourceRecordRoot(objects, source, cost);
      const progress: QualifierKeyProgress = { sourceRoot: qualifierSourceRoot(source), after: null,
        visited: 0, root: await qualifierKeyTree(objects).empty(cost) };
      try {
        await this.pool.query(`INSERT INTO structure.qualifier_root
          (manifest_digest, source_root, source, progress) VALUES ($1,$2,$3,$4)
          ON CONFLICT (manifest_digest) DO NOTHING`, [manifestDigest, progress.sourceRoot, qualifierSource(source), progress]);
      } catch (error) {
        checkpoint = await this.read(manifestDigest).catch(() => null);
        if (!checkpoint) throw error;
      }
      checkpoint = await this.read(manifestDigest);
      if (!checkpoint) throw new StructureObjectUnavailable('Qualifier checkpoint is unavailable');
    }
    matchQualifierSource(checkpoint, source);
    // An owner row restored without its exact cursor anchor is never coverage.
    const records = new StructureTree<OccurrenceRecord>(objects, 'record', entry => entry.occurrence);
    if (checkpoint.progress.after) {
      const anchor = await records.lookup(source.records, [checkpoint.progress.after], cost);
      if (!anchor.has(checkpoint.progress.after)
        || await records.countBefore(source.records, `${checkpoint.progress.after}\u0000`, cost) !== checkpoint.progress.visited) {
        throw new StructureObjectCorrupt('Qualifier checkpoint cursor differs from source progress');
      }
    }
    let page;
    try { page = checkStructurePage(await objects.get(checkpoint.progress.root.page.slice(7))); }
    catch (error) {
      if (error instanceof ObjectUnavailable) throw new StructureObjectUnavailable(error.message);
      if (error instanceof ObjectIntegrityError || error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
      throw error;
    }
    const rootCount = page.level === 0 ? page.entries.length
      : (page.entries as Array<{ count: number }>).reduce((sum, child) => sum + child.count, 0);
    if (page.tree !== 'qualifier-key' || page.level !== checkpoint.progress.root.level
      || rootCount !== checkpoint.progress.root.count) throw new StructureObjectCorrupt('Qualifier checkpoint posting root differs');
    if (checkpoint.complete) return checkpoint;
    let next: { progress: QualifierKeyProgress; complete: boolean };
    let batchLimit = checkpoint.batchLimit;
    try { next = await prepareQualifierKeyIndexBatch(objects, source, checkpoint.progress, cost, batchLimit); }
    catch (error) {
      if (!(error instanceof QualifierPreparationBudget) || batchLimit === 1) throw error;
      // Custody records only a smaller work width. Failed candidate pages never
      // advance cursor/count/root or authorize completion; the next turn resumes
      // the same exact source under the same CAS fence.
      batchLimit = Math.max(1, Math.floor(batchLimit / 2));
      next = { progress: checkpoint.progress, complete: false };
    }
    check();
    try {
      const result = await this.pool.query<QualifierRootRow>(`UPDATE structure.qualifier_root
        SET progress = $3, complete = $4, version = version + 1, batch_limit = $6
        WHERE manifest_digest = $1 AND version = $2 AND NOT complete AND source_root = $5
        RETURNING ${checkpointColumns}`, [manifestDigest, checkpoint.version, next.progress, next.complete, checkpoint.sourceRoot, batchLimit]);
      if (result.rows[0]) return checkpointView(result.rows[0]);
    } catch (error) {
      const retained = await this.read(manifestDigest).catch(() => null);
      if (retained && BigInt(retained.version) > BigInt(checkpoint.version)) {
        matchQualifierSource(retained, source); return retained;
      }
      throw error;
    }
    const retained = await this.read(manifestDigest);
    if (!retained) throw new StructureObjectUnavailable('Qualifier checkpoint is unavailable');
    matchQualifierSource(retained, source); return retained;
  }
}

/** Refines only an in-memory view; original bytes, graph anchors and pins remain exact. */
export async function resolvePreparedQualifierKeys(env: {
  structureQualifierRoots?: Pick<StructureQualifierRootStore, 'completedQualifierKeys'>;
} | undefined, manifestDigest: string, manifest: StructureManifest): Promise<StructureManifest> {
  if (manifest.format === STRUCTURE_INDEXED_MANIFEST_FORMAT) return manifest;
  let qualifierKeys;
  try { qualifierKeys = await env?.structureQualifierRoots?.completedQualifierKeys(manifestDigest, manifest); }
  catch (error) {
    if (error instanceof StructureObjectCorrupt || error instanceof StructureObjectUnavailable) throw error;
    throw new StructureObjectUnavailable('Qualifier custody owner is unavailable');
  }
  if (!qualifierKeys) throw new StructureObjectUnavailable('Exact retained qualifier coverage is unavailable');
  return { ...manifest, format: STRUCTURE_INDEXED_MANIFEST_FORMAT, qualifierKeys };
}
