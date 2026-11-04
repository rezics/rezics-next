import {
  classifyIdentityMappings,
  comparableIdentityEvidence,
  type IdentityMappingEvidence,
  type IdentityOwnerEvidence,
  type IdentitySourceEvidence,
  type IdentityPendingEvidence,
  type IdentityControlEvidence,
} from '../identity-core/index.ts';
import type { Pool } from 'pg';
import { partitionOf, routeOf } from '../../route/route.ts';
import { withReadTransaction } from '../read.ts';
import type { IdentityMapping } from './identity-epoch-contract.ts';
import owners from '../identity-epoch-read-owners.sql';
import sources from '../identity-epoch-read-sources.sql';
import pending from '../identity-epoch-read-pending.sql';
import current from '../identity-terminal-closure-current.sql';
import { identitySourceSupportJob } from '../identity-source-support-scope.ts';

/** Bounded exact mapping proof, with source and control homes released independently. */
export async function readIdentityMappings(pool: Pool, originals: readonly string[]): Promise<IdentityMapping[]> {
  if (originals.length > 100) throw new RangeError('Identity page must contain at most 100 originals');
  if (!originals.length) return [];
  const routes = originals.map((id) => {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Identity original must be a native routed ID');
    return route;
  });
  // Keep every source/control snapshot local to one home. Double collection
  // detects changes while releasing homes; unrelated partition positions do not
  // invalidate exact mapping evidence.
  async function collect(): Promise<IdentityMappingEvidence> {
    const sourceOwners: IdentityOwnerEvidence[] = [],
      sourceRows: IdentitySourceEvidence[] = [];
    const controlOwners: IdentityOwnerEvidence[] = [],
      pendingRows: IdentityPendingEvidence[] = [],
      currentRows: IdentityControlEvidence[] = [];
    for (const home of new Set(routes.map(partitionOf))) {
      const indices = routes.flatMap((route, index) => (partitionOf(route) === home ? [index] : []));
      await withReadTransaction(pool, async (tx) => {
        sourceOwners.push(...(await tx.query(owners.sql, [[home]])).rows);
        sourceRows.push(
          ...(
            await tx.query(sources.sql, [
              indices.map((index) => originals[index]),
              indices.map((index) => routes[index]),
            ])
          ).rows,
        );
      });
    }
    const available = sourceRows.filter((row) => row.original && row.control_partition !== null && row.control_group);
    for (const home of new Set(available.map((row) => row.control_partition!))) {
      const group = available.filter((row) => row.control_partition === home);
      await withReadTransaction(pool, async (tx) => {
        controlOwners.push(...(await tx.query(owners.sql, [[home]])).rows);
        pendingRows.push(
          ...(await tx.query(pending.sql, [group.map(() => home), group.map((row) => row.control_group)])).rows,
        );
        currentRows.push(
          ...(
            await tx.query(current.sql, [
              group.map(() => home),
              group.map((row) => row.control_group),
              group.map((row) => row.original),
            ])
          ).rows,
        );
      });
    }
    return { sourceOwners, sourceRows, controlOwners, pendingRows, currentRows };
  }
  const first = await collect(),
    last = await collect();
  if (comparableIdentityEvidence(first) !== comparableIdentityEvidence(last))
    return originals.map(() => ({ state: 'unavailable', reason: 'bootstrap' }));
  return classifyIdentityMappings(
    originals.map((original, index) => ({ original, sourceHome: partitionOf(routes[index]!) })),
    last,
    identitySourceSupportJob(),
  );
}
