import type { MemberNeighbors, MemberReordering } from './collection-model.ts';
import { keyBetween, localOrderKeys } from './ordinal.ts';

export type MemberPlacement =
  | { readonly kind: 'key'; readonly ordinalKey: string }
  | { readonly kind: 'respace' }
  | { readonly kind: 'respace'; readonly ordinalKey: string; readonly members: readonly MemberReordering[] };

/** Place one member between neighbour keys. A gap with no key of the ordinal
 * limit may respace a bounded local window supplied with its boundary keys.
 */
export function placeMember(
  neighbors: MemberNeighbors,
  inserted?: {
    readonly orderedMemberIds: readonly string[];
    readonly index: number;
    readonly memberId: string;
    readonly before?: string | null;
    readonly after?: string | null;
  },
): MemberPlacement {
  const ordinalKey = keyBetween(neighbors.before, neighbors.after);
  if (ordinalKey !== null) return { kind: 'key', ordinalKey };
  if (!inserted) return { kind: 'respace' };

  const { orderedMemberIds, index, memberId } = inserted;
  if (orderedMemberIds.includes(memberId)) throw new RangeError('The placed member is already in the order');
  if (!Number.isSafeInteger(index) || index < 0 || index > orderedMemberIds.length) {
    throw new RangeError('Placement index is outside the collection');
  }
  const ids = [...orderedMemberIds];
  ids.splice(index, 0, memberId);
  const keys = localOrderKeys(inserted.before ?? null, inserted.after ?? null, ids.length);
  if (!keys) return { kind: 'respace' };
  return {
    kind: 'respace',
    ordinalKey: keys[index]!,
    members: ids.map((id, position) => ({ memberId: id, ordinalKey: keys[position]! })),
  };
}
