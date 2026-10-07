import { recordTree, structureObjects } from '../structure/change.ts';
import { checkStructureManifest, STRUCTURE_LIMITS } from '../structure/format.ts';
import { newCost, StructureObjectCorrupt } from '../structure/tree.ts';
import type { CompositionHeader } from '../structure/graph.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

/** Exact point lookups of at most 16 ancestors, independent of sibling count.
 * The private owner index never persists an ordinal or undisclosed-item count. */
export async function readProgressOrder(env: WorkActivationEnvironment, header: CompositionHeader,
  occurrence: string): Promise<{ revision: string; key: string; eligible: boolean } | undefined> {
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
    if (next === occurrence && record?.state === 'removed') return undefined;
    if (!record || record.state !== 'active' || !record.segmentKey || !record.orderKey
      || next !== occurrence && record.role !== 'group') {
      throw new StructureObjectCorrupt('Progress ancestry is unavailable');
    }
    if (record.qualifier?.type === 'work-part' && record.qualifier.inclusion === 'extra'
      || record.qualifier?.type === 'book-group' && record.qualifier.division === 'extras') eligible = false;
    keys.unshift(`${record.segmentKey}\u0002${record.orderKey}`);
    next = record.parent;
  }
  return { revision: header.head, key: keys.join('\u0001'), eligible };
}
