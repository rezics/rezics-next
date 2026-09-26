import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';
import { assertGraphAdmissionOpen, cutoverRestoredGraphLineage } from '../work/restore-lineage.ts';
import { OwnerPartitionRoutes, PartitionRouteConflict } from '../partition/route.ts';
import { ObjectRecoveryConflict, type ObjectRecoveryStore } from './object-coverage.ts';
import { graphPlacementControl, graphPlacementCoverage, PlacementConflict }
  from './placement.ts';
import type { OwnerRelocationRow } from './schema.ts';

export class RelocationConflict extends Error {}

export interface GraphRelocationTarget {
  sourceLocation: string;
  targetLocation: string;
  target: FusekiClient;
  sourceObjects: ObjectRecoveryStore;
  targetObjects: ObjectRecoveryStore;
  routes: OwnerPartitionRoutes;
}

type MoveRow = OwnerRelocationRow;

function fencedEpoch(id: string): string {
  const hex = createHash('sha256').update(`relocation-source-fence-v1:${id}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function moveRow(client: PoolClient, id: string, key: string): Promise<MoveRow> {
  const found = await client.query<MoveRow>(
    'SELECT * FROM relay.owner_relocation WHERE id = $1 AND operation_id = $2',
    [id, `owner:relocate:${key}`]);
  const row = found.rows[0];
  if (!row) throw new RelocationConflict('relocation id and operation key do not match');
  if (row.owner !== 'graph' || row.dataset_id !== DATASET) {
    throw new RelocationConflict('only the product graph placement is supported');
  }
  return row;
}

async function erasureEpoch(client: PoolClient): Promise<string | null> {
  const result = await client.query<{ epoch: string | null }>(
    'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure');
  return result.rows[0]?.epoch ?? null;
}

async function releaseTarget(target: FusekiClient, id: string, dataEpoch: string,
  routingEpoch: string): Promise<void> {
  const control = await graphPlacementControl(target);
  if (control.held) {
    const receipt = `urn:rezics:receipt:restore-release:${hash(id)}`;
    const digest = hash(JSON.stringify({ family: 'owner-relocation-release-v1', id,
      dataEpoch, routingEpoch }));
    const result = await target.commandWithReceipt({ receipt, digest, validations: [],
      deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      INSERT { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(digest)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(dataEpoch)} ; rv:sequence 0 . } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(dataEpoch)} ;
        rv:routingEpoch ${lit(routingEpoch)} ; rv:sequence 0 ; rv:restoreHold true . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      }` });
    if (result.status !== 'committed') {
      throw new RelocationConflict(`target hold release was not committed (${result.status})`);
    }
  }
  await assertGraphAdmissionOpen(target, { dataEpoch, routingEpoch });
}

/**
 * One exclusive move per dataset. Physical TDB2 and object copying is offline;
 * this cutover admits only an exact target copy. The old graph is fenced first,
 * target activation is verified next, and Access routing changes last. A retry
 * recovers each crash window from the two graph controls and the Access route.
 * Verification costs O(Q log Q + B) over graph quads and referenced object bytes.
 */
export class GraphRelocationOperator {
  constructor(private readonly relay: Pool, private readonly source: FusekiClient,
    private readonly placement: GraphRelocationTarget) {}

  async activate(id: string, key: string): Promise<MoveRow> {
    const client = await this.relay.connect();
    const lock = `owner:relocate:${key}`;
    let locked = false;
    try {
      const acquired = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lock]);
      if (acquired.rows[0]?.locked !== true) throw new RelocationConflict('relocation is running');
      locked = true;
      let row = await moveRow(client, id, key);
      if (row.source_location !== this.placement.sourceLocation
        || row.target_location !== this.placement.targetLocation) {
        throw new RelocationConflict('relocation placement differs from operator configuration');
      }
      if (row.state === 'aborted' || row.state === 'collected') {
        throw new RelocationConflict('relocation is closed');
      }
      if (row.state === 'activated' || row.state === 'retaining') return row;
      const sourceFence = fencedEpoch(`routing:${id}`);
      let targetEpoch = row.target_routing_epoch ?? randomUUID();
      const sourceFenceData = fencedEpoch(id);
      let routed;
      try { routed = await this.placement.routes.current('graph', DATASET); }
      catch (error) {
        if (!(error instanceof PartitionRouteConflict)
          || error.message !== 'partition route is uninitialized') throw error;
        routed = await this.placement.routes.initialize({ owner: 'graph',
          datasetId: DATASET, location: row.source_location,
          routingEpoch: row.source_routing_epoch });
      }
      const routedToSource = routed.location === row.source_location
        && routed.routingEpoch === row.source_routing_epoch;
      const routedToTarget = routed.location === row.target_location
        && routed.routingEpoch === targetEpoch && routed.relocationId === id;
      if (!routedToSource && !routedToTarget) {
        throw new RelocationConflict('Access route differs from the relocation plan');
      }
      if (row.state === 'staged') {
        const [source, target] = await Promise.all([
          graphPlacementControl(this.source), graphPlacementControl(this.placement.target)]);
        if (source.held || target.held || source.routingEpoch !== row.source_routing_epoch
          || source.dataEpoch !== target.dataEpoch || source.sequence !== target.sequence
          || target.routingEpoch !== row.source_routing_epoch) {
          throw new RelocationConflict('source and copied target are not at one unfenced cut');
        }
        const planned = randomUUID();
        const erasure = await erasureEpoch(client);
        await client.query(`UPDATE relay.owner_relocation SET state = 'copying',
          source_data_epoch = $2, source_sequence = $3, target_data_epoch = $4,
          target_routing_epoch = $5, erasure_epoch = $6 WHERE id = $1 AND state = 'staged'`,
        [id, source.dataEpoch, source.sequence, planned, targetEpoch, erasure]);
        row = await moveRow(client, id, key);
      }
      targetEpoch = row.target_routing_epoch ?? targetEpoch;
      if (!row.source_data_epoch || row.source_sequence === null || !row.target_data_epoch
        || row.target_routing_epoch !== targetEpoch) {
        throw new RelocationConflict('relocation cutover plan is incomplete');
      }
      const sourceDataEpoch = row.source_data_epoch;
      const sourceSequence = row.source_sequence;
      const targetDataEpoch = row.target_data_epoch;
      if (row.state === 'copying') {
        await cutoverRestoredGraphLineage(this.source, { prior: {
          dataEpoch: sourceDataEpoch, routingEpoch: row.source_routing_epoch,
          sequence: sourceSequence }, next: { dataEpoch: sourceFenceData,
          routingEpoch: sourceFence } });
        await client.query("UPDATE relay.owner_relocation SET state = 'draining' WHERE id = $1 AND state = 'copying'", [id]);
        row = await moveRow(client, id, key);
      }
      const source = await graphPlacementControl(this.source);
      if (source.dataEpoch !== sourceFenceData || source.routingEpoch !== sourceFence
        || source.sequence !== '0' || !source.held) {
        throw new RelocationConflict('source graph is not fenced at the final cut');
      }
      const target = await graphPlacementControl(this.placement.target);
      const targetPreActivation = target.dataEpoch === sourceDataEpoch
        && target.routingEpoch === row.source_routing_epoch
        && target.sequence === sourceSequence && !target.held;
      const targetActivated = target.dataEpoch === targetDataEpoch
        && target.routingEpoch === targetEpoch && target.sequence === '0';
      if (!targetPreActivation && !targetActivated) {
        throw new RelocationConflict('target graph control differs from the move plan');
      }
      if (targetActivated && routedToSource && !target.held) {
        throw new RelocationConflict('target graph opened before the routing cutover');
      }
      let sourceCoverage;
      let targetCoverage;
      try { [sourceCoverage, targetCoverage] = await Promise.all([
        graphPlacementCoverage(this.source, this.placement.sourceObjects),
        graphPlacementCoverage(this.placement.target, this.placement.targetObjects)]); }
      catch (error) {
        if (error instanceof PlacementConflict || error instanceof ObjectRecoveryConflict) {
          throw new RelocationConflict(error.message);
        }
        throw error;
      }
      if (JSON.stringify(sourceCoverage) !== JSON.stringify(targetCoverage)) {
        throw new RelocationConflict('target graph, anchors or referenced objects differ from fenced source');
      }
      if (await erasureEpoch(client) !== row.erasure_epoch) {
        throw new RelocationConflict('erasure journal advanced during physical relocation');
      }
      if (row.state === 'draining') {
        await client.query(`UPDATE relay.owner_relocation SET state = 'verifying',
          anchor_count = $2, anchor_digest = $3, object_count = $4, object_digest = $5
          WHERE id = $1 AND state = 'draining'`, [id,
          sourceCoverage.objects.anchorCount, sourceCoverage.objects.anchorDigest,
          sourceCoverage.objects.objectCount, sourceCoverage.objects.objectDigest]);
        row = await moveRow(client, id, key);
      }
      if (row.anchor_count !== sourceCoverage.objects.anchorCount
        || row.anchor_digest !== sourceCoverage.objects.anchorDigest
        || row.object_count !== sourceCoverage.objects.objectCount
        || row.object_digest !== sourceCoverage.objects.objectDigest) {
        throw new RelocationConflict('verified relocation evidence changed');
      }
      if (targetPreActivation) {
        await cutoverRestoredGraphLineage(this.placement.target, { prior: {
          dataEpoch: sourceDataEpoch, routingEpoch: row.source_routing_epoch,
          sequence: sourceSequence }, next: { dataEpoch: targetDataEpoch,
          routingEpoch: targetEpoch } });
      }
      const activated = await graphPlacementControl(this.placement.target);
      if (activated.dataEpoch !== targetDataEpoch
        || activated.routingEpoch !== targetEpoch || activated.sequence !== '0') {
        throw new RelocationConflict('target activation is unverified');
      }
      if (routedToSource && !activated.held) {
        throw new RelocationConflict('target activation hold is absent before routing cutover');
      }
      // The target remains held until routing CAS commits. A restart can release
      // that hold after confirming the same route and relocation identity.
      await this.placement.routes.activate({ owner: 'graph', datasetId: DATASET,
        relocationId: id, sourceLocation: row.source_location,
        sourceRoutingEpoch: row.source_routing_epoch,
        sourceLeaseEpoch: routedToSource ? routed.leaseEpoch
          : (BigInt(routed.leaseEpoch) - 1n).toString(), targetLocation: row.target_location,
        targetRoutingEpoch: targetEpoch });
      await releaseTarget(this.placement.target, id, targetDataEpoch, targetEpoch);
      await client.query(`UPDATE relay.owner_relocation SET state = 'activated',
        activated_at = clock_timestamp() WHERE id = $1 AND state = 'verifying'`, [id]);
      return moveRow(client, id, key);
    } finally {
      try { if (locked) await client.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]); }
      finally { client.release(); }
    }
  }
}
