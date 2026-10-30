import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';

export type RealmClaimStatus = Readonly<{
  realmId: string;
  requestId: string;
  state: 'pending' | 'approved';
  orphanedAt: string;
  requestedAt: string;
  approvedAt: string | null;
  currentEpisode: boolean;
}>;

/** Own exact receipt, or the own request in the current native orphan episode.
 * Null means an authorized, active point has no matching request. Inaccessible
 * containers throw not_found; unavailable native authority throws its typed error.
 */
export type ReadOwnRealmClaim = (
  deps: Readonly<{ pool: Pool; access: Access; clock?: () => Date }>,
  actor: Actor,
  input: Readonly<{ realmId: string; requestId?: string }>,
  context: Readonly<{ deadline: number }>,
) => Promise<RealmClaimStatus | null>;
