import type { Pool } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from './read.ts';
import type { IdentityMapping } from './identity-epoch-contract.ts';
import owners from './identity-epoch-read-owners.sql';
import sources from './identity-epoch-read-sources.sql';
import pending from './identity-epoch-read-pending.sql';
import current from './identity-epoch-read-current.sql';

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
  async function collect() {
    const sourceOwners: Record<string, any>[] = [],
      sourceRows: Record<string, any>[] = [];
    const controlOwners: Record<string, any>[] = [],
      pendingRows: Record<string, any>[] = [],
      currentRows: Record<string, any>[] = [];
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
    for (const home of new Set(available.map((row) => row.control_partition))) {
      const group = available.filter((row) => row.control_partition === home);
      await withReadTransaction(pool, async (tx) => {
        controlOwners.push(...(await tx.query(owners.sql, [[home]])).rows);
        pendingRows.push(
          ...(await tx.query(pending.sql, [group.map(() => home), group.map((row) => row.control_group)])).rows,
        );
        currentRows.push(
          ...(await tx.query(current.sql, [group.map(() => home), group.map((row) => row.control_group)])).rows,
        );
      });
    }
    return { sourceOwners, sourceRows, controlOwners, pendingRows, currentRows };
  }
  const first = await collect(),
    last = await collect();
  const comparable = (value: Awaited<ReturnType<typeof collect>>) =>
    JSON.stringify(
      {
        ...value,
        sourceOwners: value.sourceOwners.map(({ position: _position, ...owner }) => owner),
        controlOwners: value.controlOwners.map(({ position: _position, ...owner }) => owner),
      },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    );
  if (comparable(first) !== comparable(last))
    return originals.map(() => ({ state: 'unavailable', reason: 'bootstrap' }));
  const { sourceOwners, sourceRows, controlOwners, pendingRows, currentRows } = last;
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
}
