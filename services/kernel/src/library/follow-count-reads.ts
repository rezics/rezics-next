/** HTTP compatibility entry. The default composition supplies real native ports. */
import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import { requireLibraryDomain } from './domain-binding.ts';
export {
  readCollectionDiscoveryFollowCounts,
  type CollectionDiscoveryFollowCountKey,
} from './adapters/follow-count-discovery.ts';
export function createFollowCountReads({ pool, access }: { pool: Pool; access: Access }) {
  const runtime = requireLibraryDomain().followCounts;
  if (!runtime) throw new TypeError('Library Follow counts are not composed');
  return runtime.reads(pool, access);
}
