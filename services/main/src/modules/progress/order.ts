import { recordTree, structureObjects } from '../structure/change.ts';
import { checkStructureManifest, STRUCTURE_LIMITS } from '../structure/format.ts';
import { newCost, StructureObjectCorrupt } from '../structure/tree.ts';
import type { CompositionHeader } from '../structure/graph.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

export type ProgressOrder = { revision: string; key: string; eligible: boolean };
type ProgressOrderHit = { kind: 'order'; order: ProgressOrder } | { kind: 'removed' } | { kind: 'absent' };

/** Exact point lookups of at most 16 ancestors, independent of sibling count.
 * The private owner index never persists an ordinal or undisclosed-item count.
 * An occurrence that is not in this Structure is absent, not corrupt: a series
 * anchor names a chapter that lives in a member volume. */
async function progressOrderHit(env: WorkActivationEnvironment, header: CompositionHeader,
  occurrence: string): Promise<ProgressOrderHit> {
  const objects = structureObjects(env);
  const manifest = checkStructureManifest(await objects.get(header.manifest.slice(-64)));
  if (manifest.structure !== header.structure || manifest.generation !== header.generation) {
    throw new StructureObjectCorrupt('Progress order differs from its Structure head');
  }
  const keys: string[] = [], seen = new Set<string>(), cost = newCost();
  let next = occurrence, eligible = true;
  while (next !== header.structure) {
    if (keys.length >= STRUCTURE_LIMITS.maxDepth || seen.has(next)) {
      throw new StructureObjectCorrupt('Progress ancestry is cyclic or exceeds its depth');
    }
    seen.add(next);
    const record = (await recordTree(objects).lookup(manifest.records, [next], cost)).get(next);
    if (!record && next === occurrence && keys.length === 0) return { kind: 'absent' };
    if (next === occurrence && record?.state === 'removed') return { kind: 'removed' };
    if (!record || record.state !== 'active' || !record.segmentKey || !record.orderKey
      || next !== occurrence && record.role !== 'group') {
      throw new StructureObjectCorrupt('Progress ancestry is unavailable');
    }
    if (record.qualifier?.type === 'work-part' && record.qualifier.inclusion === 'extra'
      || record.qualifier?.type === 'book-group' && record.qualifier.division === 'extras') eligible = false;
    keys.unshift(`${record.segmentKey}\u0002${record.orderKey}`);
    next = record.parent;
  }
  return { kind: 'order', order: { revision: header.head, key: keys.join('\u0001'), eligible } };
}

export async function readProgressOrder(env: WorkActivationEnvironment, header: CompositionHeader,
  occurrence: string): Promise<ProgressOrder | undefined> {
  const hit = await progressOrderHit(env, header, occurrence);
  if (hit.kind === 'order') return hit.order;
  if (hit.kind === 'removed') return undefined;
  throw new StructureObjectCorrupt('Progress ancestry is unavailable');
}

/** Like readProgressOrder, but an occurrence from another Structure is absent
 * (null) so a series anchor can be rebuilt instead of failing the index. */
export async function readIndexedProgressOrder(env: WorkActivationEnvironment, header: CompositionHeader,
  occurrence: string): Promise<ProgressOrder | undefined | null> {
  const hit = await progressOrderHit(env, header, occurrence);
  if (hit.kind === 'order') return hit.order;
  if (hit.kind === 'removed') return undefined;
  return null;
}
