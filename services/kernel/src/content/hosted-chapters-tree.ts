import { routeOf } from '../route/route.ts';
import {
  HOSTED_DEPTH_LIMIT,
  HOSTED_PLACEMENT_LIMIT,
  InvalidHostedStructureError,
  type HostedPlacement,
  type OrderedHostedPlacement,
} from './hosted-chapters-model.ts';

/** Whole-tree validation is bounded before any native attachment read or write. */
export function orderHostedPlacements(
  route: number,
  placements: readonly HostedPlacement[],
): readonly OrderedHostedPlacement[] {
  if (!Array.isArray(placements) || placements.length > HOSTED_PLACEMENT_LIMIT)
    throw new InvalidHostedStructureError();
  const byId = new Map<string, HostedPlacement>();
  const children = new Map<string | null, HostedPlacement[]>();
  for (const placement of placements) {
    if (
      !placement || routeOf(placement.occurrenceId) !== route || byId.has(placement.occurrenceId) ||
      (placement.parentId !== null && routeOf(placement.parentId) !== route) ||
      !Number.isSafeInteger(placement.position) || placement.position < 0 ||
      typeof placement.title !== 'string' || placement.title.trim().length === 0 ||
      [...placement.title].length > 256 ||
      (placement.kind !== 'part' && placement.kind !== 'chapter')
    ) throw new InvalidHostedStructureError();
    if (placement.kind === 'chapter') {
      const target = placement.target;
      if (!target || routeOf(target.postId) === null ||
        routeOf(target.threadId) !== routeOf(target.postId) ||
        routeOf(target.revisionId) !== routeOf(target.postId) ||
        !/^[0-9a-f]{64}$/.test(target.sha256)) throw new InvalidHostedStructureError();
    } else if (placement.target !== undefined) throw new InvalidHostedStructureError();
    byId.set(placement.occurrenceId, placement);
    const siblings = children.get(placement.parentId) ?? [];
    siblings.push(placement);
    children.set(placement.parentId, siblings);
  }
  for (const [parentId, siblings] of children) {
    if (parentId !== null && byId.get(parentId)?.kind !== 'part')
      throw new InvalidHostedStructureError('A parent must be an existing part');
    siblings.sort((a, b) => a.position - b.position);
    if (siblings.some((entry, index) => entry.position !== index))
      throw new InvalidHostedStructureError('Sibling positions must be contiguous and unique');
  }
  const result: OrderedHostedPlacement[] = [];
  function visit(parentId: string | null, depth: number): void {
    const siblings = children.get(parentId) ?? [];
    if (siblings.length && depth > HOSTED_DEPTH_LIMIT) throw new InvalidHostedStructureError('Tree is too deep');
    for (const placement of siblings) {
      result.push({ ...placement, ordinal: result.length });
      visit(placement.occurrenceId, depth + 1);
    }
  }
  visit(null, 1);
  if (result.length !== placements.length) throw new InvalidHostedStructureError('Tree contains a cycle');
  return result;
}

/** Publication drops private siblings while retaining the selected relative order. */
export function selectHostedRelease(
  placements: readonly OrderedHostedPlacement[],
  occurrenceIds: readonly string[],
): readonly OrderedHostedPlacement[] {
  if (!Array.isArray(occurrenceIds) || occurrenceIds.length > HOSTED_PLACEMENT_LIMIT)
    throw new InvalidHostedStructureError();
  const selected = new Set(occurrenceIds);
  if (selected.size !== occurrenceIds.length) throw new InvalidHostedStructureError('Duplicate selection');
  const result = placements.filter((placement) => selected.has(placement.occurrenceId));
  if (result.length !== selected.size) throw new InvalidHostedStructureError('Unknown occurrence');
  for (const placement of result) {
    if (placement.parentId !== null && !selected.has(placement.parentId))
      throw new InvalidHostedStructureError('Release must include selected ancestors');
  }
  const positions = new Map<string | null, number>();
  return result.map((placement, ordinal) => {
    const position = positions.get(placement.parentId) ?? 0;
    positions.set(placement.parentId, position + 1);
    return { ...placement, position, ordinal };
  });
}
