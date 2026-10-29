import type { Pool } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from './read.ts';
import type { IdentityMapping } from './identity-epoch-contract.ts';
import owners from './identity-epoch-read-owners.sql';
import sources from './identity-epoch-read-sources.sql';
import pending from './identity-epoch-read-pending.sql';
import current from './identity-epoch-read-current.sql';

/** One native-backend snapshot, shared by the whole bounded member page. */
export async function readIdentityMappings(pool: Pool, originals: readonly string[]): Promise<IdentityMapping[]> {
  if (originals.length > 100) throw new RangeError('Identity page must contain at most 100 originals');
  if (!originals.length) return [];
  const routes = originals.map((id) => {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Identity original must be a native routed ID');
    return route;
  });
  return withReadTransaction(pool, async (tx) => {
    const sourceOwners = (await tx.query(owners.sql, [[...new Set(routes.map(partitionOf))]])).rows;
    const sourceRows = (await tx.query(sources.sql, [[...originals], routes])).rows;
    const available = sourceRows.filter((row) => row.original && row.control_partition !== null && row.control_group);
    const controlOwners = available.length
      ? (await tx.query(owners.sql, [[...new Set(available.map((row) => row.control_partition))]])).rows
      : [];
    const controlPartitions = available.map((row) => row.control_partition);
    const controlGroups = available.map((row) => row.control_group);
    const pendingRows = available.length ? (await tx.query(pending.sql, [controlPartitions, controlGroups])).rows : [];
    const currentRows = available.length ? (await tx.query(current.sql, [controlPartitions, controlGroups])).rows : [];
    return originals.map((original, index): IdentityMapping => {
      const sourceOwner = sourceOwners.find((owner) => owner.partition_no === partitionOf(routes[index]!));
      if (!sourceOwner) return { state: 'unavailable', reason: 'missing-owner' };
      if (sourceOwner.write_state !== 'active')
        return { state: 'unavailable', reason: sourceOwner.write_state === 'moved' ? 'moved-owner' : 'bootstrap' };
      const source = sourceRows.find((row) => row.subject_id === original);
      if (!source) return { state: 'absent' };
      if (
        !source.original ||
        source.control_partition === null ||
        !source.control_group ||
        BigInt(source.epoch) <= 0n ||
        source.owner_epoch !== sourceOwner.epoch ||
        BigInt(source.dirty_revision) > BigInt(source.captured_revision) ||
        source.control_group !== source.terminal ||
        (source.terminal === original ? source.current_target !== null : source.current_target !== source.terminal)
      )
        return { state: 'unavailable', reason: 'bootstrap' };
      const controlOwner = controlOwners.find((owner) => owner.partition_no === source.control_partition);
      if (!controlOwner) return { state: 'unavailable', reason: 'missing-owner' };
      if (controlOwner.write_state !== 'active')
        return { state: 'unavailable', reason: controlOwner.write_state === 'moved' ? 'moved-owner' : 'bootstrap' };
      const basis = currentRows.find(
        (group) => group.partition_no === source.control_partition && group.terminal === source.control_group,
      );
      if (!basis || basis.redirected || basis.owner_epoch !== controlOwner.epoch)
        return { state: 'unavailable', reason: 'bootstrap' };
      const claim = pendingRows.find(
        (group) => group.partition_no === source.control_partition && group.terminal === source.control_group,
      );
      if (claim?.pending_job)
        return { state: 'pending', original, job: { jobId: claim.pending_job, epoch: BigInt(claim.pending_epoch) } };
      return { state: 'mapped', original, terminal: source.terminal, epoch: BigInt(basis.published_epoch) };
    });
  });
}
