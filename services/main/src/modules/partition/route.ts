import type { Pool } from 'pg';

export class StalePartitionLease extends Error {}
export class PartitionRouteConflict extends Error {}

export interface PartitionRoute {
  owner: 'graph' | 'content' | 'object';
  datasetId: string;
  location: string;
  routingEpoch: string;
  leaseEpoch: string;
  relocationId: string | null;
}

/** One indexed Access row per owner dataset; moves are recorded in relay. */
export class OwnerPartitionRoutes {
  constructor(private readonly pool: Pool) {}

  async initialize(route: Omit<PartitionRoute, 'leaseEpoch' | 'relocationId'>): Promise<PartitionRoute> {
    await this.pool.query(`INSERT INTO access.owner_partition_route
      (owner, dataset_id, location, routing_epoch) VALUES ($1,$2,$3,$4)
      ON CONFLICT (owner, dataset_id) DO NOTHING`,
    [route.owner, route.datasetId, route.location, route.routingEpoch]);
    const current = await this.current(route.owner, route.datasetId);
    if (current.location !== route.location || current.routingEpoch !== route.routingEpoch) {
      throw new PartitionRouteConflict('partition route differs from worker configuration');
    }
    return current;
  }

  async current(owner: PartitionRoute['owner'], datasetId: string): Promise<PartitionRoute> {
    const found = await this.pool.query<{ owner: PartitionRoute['owner']; dataset_id: string;
      location: string; routing_epoch: string; lease_epoch: string; relocation_id: string | null }>(
      `SELECT owner, dataset_id, location, routing_epoch, lease_epoch::text, relocation_id::text
       FROM access.owner_partition_route WHERE owner = $1 AND dataset_id = $2`,
    [owner, datasetId]);
    const row = found.rows[0];
    if (!row) throw new PartitionRouteConflict('partition route is uninitialized');
    return { owner: row.owner, datasetId: row.dataset_id, location: row.location,
      routingEpoch: row.routing_epoch, leaseEpoch: row.lease_epoch,
      relocationId: row.relocation_id };
  }

  async assertWrite(expected: Pick<PartitionRoute, 'owner' | 'datasetId' | 'location'
    | 'routingEpoch' | 'leaseEpoch'>): Promise<void> {
    const current = await this.current(expected.owner, expected.datasetId);
    if (current.location !== expected.location || current.routingEpoch !== expected.routingEpoch
      || current.leaseEpoch !== expected.leaseEpoch) {
      throw new StalePartitionLease('partition route or lease epoch has changed');
    }
  }

  /** CAS is the only routing change; target activation must precede this call. */
  async activate(input: {
    owner: PartitionRoute['owner']; datasetId: string; relocationId: string;
    sourceLocation: string; sourceRoutingEpoch: string; sourceLeaseEpoch: string;
    targetLocation: string; targetRoutingEpoch: string;
  }): Promise<PartitionRoute> {
    const changed = await this.pool.query(
      `UPDATE access.owner_partition_route SET location = $6, routing_epoch = $7,
         lease_epoch = lease_epoch + 1, relocation_id = $8, updated_at = clock_timestamp()
       WHERE owner = $1 AND dataset_id = $2 AND location = $3 AND routing_epoch = $4
         AND lease_epoch = $5::bigint`,
      [input.owner, input.datasetId, input.sourceLocation, input.sourceRoutingEpoch,
        input.sourceLeaseEpoch, input.targetLocation, input.targetRoutingEpoch,
        input.relocationId]);
    if (changed.rowCount !== 1) {
      const current = await this.current(input.owner, input.datasetId);
      if (current.location === input.targetLocation
        && current.routingEpoch === input.targetRoutingEpoch
        && current.relocationId === input.relocationId
        && BigInt(current.leaseEpoch) === BigInt(input.sourceLeaseEpoch) + 1n) return current;
      throw new PartitionRouteConflict('partition route moved during activation');
    }
    return this.current(input.owner, input.datasetId);
  }
}
