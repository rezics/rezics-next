import type { Pool } from 'pg';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { checkOccurrenceRecord, checkStructureManifest, InvalidStructureObject,
  STRUCTURE_LIMITS, type OrderEntry, type StructureManifest } from './format.ts';
import { orderTree, recordTree } from './change.ts';
import { orderTreeKey } from './graph.ts';
import { newCost, StructureObjectCorrupt, StructureObjectUnavailable, type TreeRoot } from './tree.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { WORK_READ_COST } from '../work/read-contract.ts';

const DIGEST = /^[0-9a-f]{64}$/;
export interface GroupRootCheckpoint {
  manifestDigest: string;
  structure: string;
  records: TreeRoot;
  order: TreeRoot;
  total: number;
  cursor: string | null;
  scanned: number;
  groups: TreeRoot;
  version: string;
  complete: boolean;
}
interface Row {
  manifest_digest: string; structure: string; records: TreeRoot; ordering: TreeRoot;
  total: number; cursor: string | null; scanned: number; groups: TreeRoot;
  version: string; complete: boolean;
}
const columns = 'manifest_digest, structure, records, ordering, total, cursor, scanned, groups, version::text, complete';
const sameRoot = (a: TreeRoot, b: TreeRoot) => a.page === b.page && a.level === b.level && a.count === b.count;
function checkedRoot(root: TreeRoot) {
  if (!root || Object.keys(root).sort().join(',') !== 'count,level,page'
    || !/^sha256:[0-9a-f]{64}$/.test(root.page)
    || !Number.isInteger(root.level) || root.level < 0 || root.level >= STRUCTURE_LIMITS.treeLevels
    || !Number.isInteger(root.count) || root.count < 0 || root.count > STRUCTURE_LIMITS.maxPlacements) {
    throw new StructureObjectCorrupt('prepared group root is invalid');
  }
  return root;
}
function view(row: Row): GroupRootCheckpoint {
  if (!DIGEST.test(row.manifest_digest) || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(row.structure)
    || !Number.isSafeInteger(row.total) || row.total < 0 || row.total > STRUCTURE_LIMITS.maxPlacements
    || !Number.isSafeInteger(row.scanned) || row.scanned < 0 || row.scanned > row.total
    || !/^(0|[1-9][0-9]*)$/.test(String(row.version)) || typeof row.complete !== 'boolean'
    || row.complete && row.scanned !== row.total || (row.cursor === null) !== (row.scanned === 0)
    || row.cursor !== null && (!row.cursor.startsWith(`${row.structure}\u0001`) || row.cursor.length > 512)) {
    throw new StructureObjectCorrupt('group preparation checkpoint is invalid');
  }
  const groups = checkedRoot(row.groups);
  const order = checkedRoot(row.ordering);
  if (groups.count > row.scanned || row.total > order.count) throw new StructureObjectCorrupt('group preparation count differs');
  return { manifestDigest: row.manifest_digest, structure: row.structure,
    records: checkedRoot(row.records), order, total: row.total,
    cursor: row.cursor, scanned: row.scanned, groups, version: String(row.version), complete: row.complete };
}
function sourceMatches(checkpoint: GroupRootCheckpoint, source: StructureManifest) {
  if (source.profile !== 'book-composition' || checkpoint.structure !== source.structure
    || !sameRoot(checkpoint.records, source.records) || !sameRoot(checkpoint.order, source.order)) {
    throw new StructureObjectCorrupt('group preparation belongs to another source manifest');
  }
}

/** Private Content owner custody for unchanged historical manifests. Ordinary
 * reads perform one primary-key lookup; only explicit maintenance examines the
 * source's top-level order, in turns bounded by the existing page entry limit. */
export class StructureGroupRootStore {
  constructor(private readonly pool: Pool, private readonly objects: ImmutableObjects) {}

  async read(manifestDigest: string): Promise<GroupRootCheckpoint | null> {
    if (!DIGEST.test(manifestDigest)) throw new StructureObjectCorrupt('invalid group preparation source digest');
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM structure.group_root WHERE manifest_digest = $1`,
      [manifestDigest]);
    return result.rows[0] ? view(result.rows[0]) : null;
  }

  async completedTopGroups(manifestDigest: string, source?: StructureManifest): Promise<TreeRoot | null> {
    if (!DIGEST.test(manifestDigest)) throw new StructureObjectCorrupt('invalid group preparation source digest');
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM structure.group_root
      WHERE manifest_digest = $1 AND complete`, [manifestDigest]);
    if (!result.rows[0]) return null;
    const checkpoint = view(result.rows[0]);
    if (!checkpoint.complete) throw new StructureObjectCorrupt('group preparation is incomplete');
    if (source) sourceMatches(checkpoint, source);
    return checkpoint.groups;
  }

  /** Used only by fixed owner-cut capture/GC, never by an ordinary reader. */
  async retainedRoots(): Promise<GroupRootCheckpoint[]> {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM structure.group_root ORDER BY manifest_digest`);
    return result.rows.map(view);
  }

  async prepare(manifestDigest: string, input: { checkDeadline?: () => void } = {}): Promise<GroupRootCheckpoint> {
    if (!DIGEST.test(manifestDigest)) throw new StructureObjectCorrupt('invalid group preparation source digest');
    const deadline = Date.now() + WORK_READ_COST.deadlineMs;
    const check = () => {
      input.checkDeadline?.();
      if (Date.now() >= deadline) throw new StructureObjectUnavailable('group preparation deadline exceeded');
    };
    // Include every immutable get/put in the same turn deadline. No whole tree
    // materialization or predecessor replay is hidden behind the checkpoint.
    const objects: ImmutableObjects = { get: async digest => {
      check(); const bytes = await this.objects.get(digest); check(); return bytes;
    }, put: async bytes => { check(); const digest = await this.objects.put(bytes); check(); return digest; } };
    check();
    let source: StructureManifest;
    try { source = checkStructureManifest(await objects.get(manifestDigest)); }
    catch (error) {
      if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
      throw error;
    }
    if (source.profile !== 'book-composition' || source.order.count !== source.placementCount) {
      throw new StructureObjectCorrupt('group preparation source is not an exact Book manifest');
    }
    let checkpoint = await this.read(manifestDigest);
    const cost = newCost(), tree = orderTree(objects);
    if (!checkpoint) {
      const total = await tree.countBefore(source.order, `${source.structure}\u0002`, cost)
        - await tree.countBefore(source.order, `${source.structure}\u0001`, cost);
      const groups = await tree.empty(cost);
      check();
      try {
        await this.pool.query(`INSERT INTO structure.group_root
          (manifest_digest, structure, records, ordering, total, groups)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (manifest_digest) DO NOTHING`,
        [manifestDigest, source.structure, source.records, source.order, total, groups]);
      } catch (error) {
        checkpoint = await this.read(manifestDigest).catch(() => null);
        if (!checkpoint) throw error;
        sourceMatches(checkpoint, source);
        if (checkpoint.total !== total) throw new StructureObjectCorrupt('group preparation source total differs');
      }
      checkpoint = await this.read(manifestDigest);
      if (!checkpoint) throw new StructureObjectUnavailable('group preparation checkpoint is unavailable');
    }
    sourceMatches(checkpoint, source);
    if (checkpoint.complete) return checkpoint;
    const start = await tree.countBefore(source.order, `${source.structure}\u0001`, cost);
    if (await tree.countBefore(source.order, `${source.structure}\u0002`, cost) - start !== checkpoint.total) {
      throw new StructureObjectCorrupt('group preparation source total differs');
    }
    if (checkpoint.cursor) {
      const anchor = await tree.lookup(source.order, [checkpoint.cursor], cost);
      if (!anchor.has(checkpoint.cursor)
        || await tree.countBefore(source.order, `${checkpoint.cursor}\u0000`, cost) - start !== checkpoint.scanned) {
        throw new StructureObjectCorrupt('group preparation cursor differs from its source progress');
      }
    }
    const entries = await tree.range(source.order,
      checkpoint.cursor ? `${checkpoint.cursor}\u0000` : `${source.structure}\u0001`,
      `${source.structure}\u0002`, STRUCTURE_LIMITS.pageEntries, cost);
    const records = await recordTree(objects).lookup(source.records, entries.map(entry => entry.occurrence), cost);
    const groups = new Map<string, OrderEntry>();
    for (const entry of entries) {
      check();
      const record = records.get(entry.occurrence);
      if (!record || record.state !== 'active' || record.parent !== source.structure
        || orderTreeKey(record as typeof entry) !== orderTreeKey(entry)) {
        throw new StructureObjectCorrupt('group preparation order differs from its source record');
      }
      try { checkOccurrenceRecord(record, source.profile); }
      catch (error) {
        if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
        throw error;
      }
      if (record.role === 'group') groups.set(orderTreeKey(entry), entry);
    }
    const scanned = checkpoint.scanned + entries.length;
    const complete = entries.length < STRUCTURE_LIMITS.pageEntries;
    if (scanned > checkpoint.total || complete && scanned !== checkpoint.total) {
      throw new StructureObjectCorrupt('group preparation traversal differs from source total');
    }
    const root = await tree.apply(checkpoint.groups, groups, cost);
    const cursor = entries.length ? orderTreeKey(entries.at(-1)!) : checkpoint.cursor;
    check();
    try {
      const result = await this.pool.query<Row>(`UPDATE structure.group_root
        SET groups = $3, cursor = $4, scanned = $5, complete = $6, version = version + 1
        WHERE manifest_digest = $1 AND version = $2 AND NOT complete RETURNING ${columns}`,
      [manifestDigest, checkpoint.version, root, cursor, scanned, complete]);
      if (result.rows[0]) return view(result.rows[0]);
    } catch (error) {
      // The UPDATE is one autocommit CAS. An acknowledgement may disappear
      // after durable commit; reload the owner's checkpoint instead of replaying
      // a guessed batch or replacing its original manifest.
      const retained = await this.read(manifestDigest).catch(() => null);
      if (retained && BigInt(retained.version) > BigInt(checkpoint.version)) {
        sourceMatches(retained, source);
        return retained;
      }
      throw error;
    }
    const retained = await this.read(manifestDigest);
    if (!retained) throw new StructureObjectUnavailable('group preparation checkpoint is unavailable');
    sourceMatches(retained, source);
    return retained;
  }
}

/** Refine only the in-memory view. The original manifest digest, bytes and
 * selected revision remain the source of historical identity and pinning. */
export async function resolvePreparedGroups(env: WorkActivationEnvironment | undefined,
  manifestDigest: string, manifest: StructureManifest): Promise<StructureManifest> {
  if (manifest.topGroups || manifest.profile !== 'book-composition' || !env?.structureGroupRoots) return manifest;
  let topGroups;
  try { topGroups = await env.structureGroupRoots.completedTopGroups(manifestDigest, manifest); }
  catch (error) {
    if (error instanceof StructureObjectCorrupt || error instanceof StructureObjectUnavailable) throw error;
    throw new StructureObjectUnavailable('Structure group custody owner is unavailable');
  }
  return topGroups ? { ...manifest, topGroups } : manifest;
}
