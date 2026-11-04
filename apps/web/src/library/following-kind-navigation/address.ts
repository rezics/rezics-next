import type { MineFollow } from '../mine-following';

/** Navigation vocabulary follows native target identity, not catalogue subtypes. */
export type FollowingKind = 'all' | MineFollow['targetType'];
export function followingKind(value: unknown): FollowingKind | null {
  if (value === undefined || value === 'all') return 'all';
  return value === 'subject' || value === 'collection' || value === 'space' ? value : null;
}

/** Named unavailable seam: installed follows.get has only view, cursor and limit.
 * Activate only with Commerce's matching generated query and native kind-bound cursor evidence.
 */
export const followingKindProducer = 'unavailable' as const;
