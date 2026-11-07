import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import migrationPhase from './entry-profile-migration-phase-read.sql';

/** Read-only rollout boundary. Existing fixed-contract DTOs can expose an unpinned
 * historical fact only before that owner's live-fact cutover. A missing job never
 * prevents reading a current pinned fact, and reads never create owner metadata.
 */
export async function assertPreProfileLibraryRead(client: Pick<PoolClient, 'query'>, accountId: string): Promise<void> {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid Library owner');
  const migration = await migrationPhase.run(client, { route, account_id: accountId });
  if (migration?.phase === 'ready') throw new Error('Unpinned Library fact after owner cutover');
}
