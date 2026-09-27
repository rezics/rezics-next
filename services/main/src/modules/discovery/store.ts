import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { activateHead, authorizeManager, claimLease, digest, fenceLease, inAccess,
  recordReceipt, replayReceipt, requireRecoveryOpen, RecommendationConflict,
  RecommendationDenied, RecommendationMissing, RecommendationRestart, RecommendationStale, RecommendationUnavailable,
  type ManageContext, type ReceiptKey } from '../recommendation/derived-generation.ts';
import type { ReadPosition } from '../work/read-session.ts';
import { DISCOVERY_COST, type DiscoveryBasis, type DiscoveryRow, type OwnedDiscoveryBasis,
  type ProjectedWork } from './contract.ts';

export interface DiscoveryGeneration {
  generation_id: string; scope: DiscoveryBasis['scope']; realm: string | null; context: string | null;
  principal_id: string | null; source_epoch: string; source_sequence: string;
  access_revision: string; recovery_generation: string; checkpoint: string; complete: boolean;
  state: string; work_count: string; active_head: string | null;
}
const basisOf = (row: DiscoveryGeneration): OwnedDiscoveryBasis => ({ scope: row.scope,
  realm: row.realm, context: row.context, owner: row.principal_id });
export const discoveryScopeKey = (basis: OwnedDiscoveryBasis) => digest(['discovery-standing-mean-v1', basis]);

export function discoverySeekSql(sort: 'recent' | 'top-rated', continuation: boolean): string {
  const key = sort === 'recent' ? 'recent_order' : 'rating_order';
  return `SELECT work, ${key}::text AS order_key, payload FROM access.discovery_entry
    WHERE generation_id = $1 AND work_type = $2 AND term = $3
      ${sort === 'top-rated' ? 'AND rating_count > 0' : ''}
      ${continuation ? `AND (${key}, work COLLATE "C") > ($5::numeric, $6::text COLLATE "C")` : ''}
    ORDER BY ${key}, work COLLATE "C" LIMIT $4`;
}

async function sourceFence(client: PoolClient) {
  await requireRecoveryOpen(client);
  const row = (await client.query<{ revision: string; generation: string }>(`SELECT
    d.revision::text, f.generation::text FROM access.discovery_source_fence d
    CROSS JOIN access.recovery_fence f WHERE d.id AND f.id FOR SHARE OF d`)).rows[0];
  if (!row) throw new RecommendationUnavailable('Discovery source fence is unavailable');
  return row;
}
function assertPosition(row: DiscoveryGeneration, position: ReadPosition) {
  if (row.source_epoch !== position.dataEpoch || row.source_sequence !== position.sequence) {
    throw new RecommendationRestart('Discovery graph changed');
  }
}
async function assertFence(client: PoolClient, row: DiscoveryGeneration) {
  const fence = await sourceFence(client);
  if (fence.revision !== row.access_revision || fence.generation !== row.recovery_generation) {
    throw new RecommendationRestart('Discovery Access basis changed');
  }
}
async function generation(client: PoolClient, id: string): Promise<DiscoveryGeneration> {
  const row = (await client.query<DiscoveryGeneration>(`SELECT d.*, g.state, h.revision::text AS active_head,
    d.source_sequence::text, d.access_revision::text, d.work_count::text
    FROM access.discovery_generation d JOIN access.derived_generation g ON g.id = d.generation_id
    LEFT JOIN access.derived_generation_head h ON h.family = 'discovery' AND h.scope_key = g.scope_key
    WHERE d.generation_id = $1`, [id])).rows[0];
  if (!row) throw new RecommendationMissing('Discovery generation is unavailable');
  return row;
}
async function operatorPrincipal(client: PoolClient, context: ManageContext,
  scope: DiscoveryBasis['scope'], owner?: string | null) {
  if (scope !== 'mine') return authorizeManager(client, context);
  // A person may rebuild only their own private rating population. The acting
  // Agent cannot select another principal, including for organization personas.
  const principal = (await client.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
  [context.principal.issuer, context.principal.subject])).rows[0]?.id;
  if (!principal) throw new RecommendationDenied('Discovery principal is inactive');
  if (owner && owner !== principal) {
    throw new RecommendationMissing('Discovery generation is unavailable');
  }
  return principal;
}
const manager = (client: PoolClient, context: ManageContext, row: DiscoveryGeneration) =>
  operatorPrincipal(client, context, row.scope, row.principal_id);

/** Durable generation/checkpoint protocol; no method in the GET path builds or
 * aggregates. Manager-driven advance calls do one Work and release their lease. */
export class DiscoveryProjection {
  constructor(private readonly pool: Pool) {}

  async register(context: ManageContext, basis: DiscoveryBasis, position: ReadPosition, key: ReceiptKey) {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const principal = await operatorPrincipal(client, context, basis.scope);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`discovery-receipt:${principal}:${key.idempotencyKey}`]);
      const replay = await replayReceipt(client, principal, key, 'build');
      if (replay) return { ...await generation(client, replay.generation_id), replayed: true };
      const fence = await sourceFence(client);
      const owned: OwnedDiscoveryBasis = { ...basis, owner: basis.scope === 'mine' ? principal : null };
      const scope = discoveryScopeKey(owned);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`discovery:${scope}`]);
      const pending = (await client.query(`SELECT id FROM access.derived_generation
        WHERE family = 'discovery' AND scope_key = $1 AND state = 'building' LIMIT 1`, [scope])).rows[0];
      if (pending) throw new RecommendationConflict('A discovery build already exists for this basis');
      const id = randomUUID();
      const manifest = { basis: owned, position, access: fence };
      await client.query(`INSERT INTO access.derived_generation
        (id, family, scope_key, input_digest, input_manifest, lease_expires_at)
        VALUES ($1, 'discovery', $2, $3, $4, clock_timestamp())`, [id, scope, digest(manifest), manifest]);
      await client.query(`INSERT INTO access.discovery_generation
        (generation_id, scope, realm, context, principal_id, source_epoch, source_sequence,
         access_revision, recovery_generation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, basis.scope, basis.realm, basis.context, owned.owner, position.dataEpoch, position.sequence,
        fence.revision, fence.generation]);
      await client.query(`INSERT INTO access.derived_generation_input
        (generation_id, source, data_epoch, pinned_sequence, checkpoint_sequence)
        VALUES ($1, 'main-graph', $2, $3, $3)`, [id, position.dataEpoch, position.sequence]);
      await recordReceipt(client, principal, key, { action: 'build', generation_id: id,
        outcome: 'succeeded', head_revision: null });
      return { ...await generation(client, id), replayed: false };
    });
  }

  async view(context: ManageContext, id: string) {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const row = await generation(client, id);
      await manager(client, context, row);
      return row;
    });
  }

  async beginStep(context: ManageContext, id: string, checkpoint: string) {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const row = await generation(client, id);
      await manager(client, context, row);
      await assertFence(client, row);
      if (row.checkpoint !== checkpoint || row.complete) throw new RecommendationStale('Build checkpoint changed');
      const lease = await claimLease(client, id, DISCOVERY_COST.leaseMs);
      return { row, lease };
    });
  }

  async commitStep(context: ManageContext, id: string, lease: string, checkpoint: string,
    result: { after: string; complete: boolean; item: ProjectedWork | null }, position: ReadPosition) {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      await fenceLease(client, id, lease, DISCOVERY_COST.leaseMs);
      const row = await generation(client, id);
      await manager(client, context, row);
      assertPosition(row, position);
      await assertFence(client, row);
      if (row.checkpoint !== checkpoint || (result.after <= checkpoint && !result.complete)) {
        throw new RecommendationStale('Build checkpoint changed');
      }
      const item = result.item;
      if (item) {
        if (item.work !== result.after || item.types.length > 3
          || item.classifications.length > DISCOVERY_COST.termsPerWork) {
          throw new RecommendationUnavailable('Discovery projection exceeds its fanout');
        }
        const entries = ['', ...item.types].flatMap(type => [null, ...item.classifications].map(term => ({
          type, term: term?.sense ?? '', payload: { revision: item.revision, mainVersion: item.mainVersion,
            types: item.types, rating: item.rating, classification: term } })));
        await client.query(`INSERT INTO access.discovery_entry
          (generation_id, work, work_type, term, recent_order, rating_count, rating_sum, payload)
          SELECT $1,$2,e.type,e.term,$3,$4,$5,e.payload
          FROM jsonb_to_recordset($6::jsonb) e(type text, term text, payload jsonb)`,
        [id, item.work, item.recentOrder, item.rating?.count ?? 0, item.rating?.sum ?? 0, JSON.stringify(entries)]);
      }
      await client.query(`UPDATE access.discovery_generation SET checkpoint = $2, complete = $3,
        work_count = work_count + $4 WHERE generation_id = $1`, [id, result.after, result.complete, item ? 1 : 0]);
      await client.query(`UPDATE access.derived_generation_input SET snapshot_cursor = $2,
        snapshot_complete = $3 WHERE generation_id = $1 AND source = 'main-graph'`,
      [id, result.complete ? null : result.after, result.complete]);
      if (result.complete) await client.query(`UPDATE access.derived_generation SET state = 'ready',
        lease_expires_at = NULL, ready_at = clock_timestamp(),
        validation_digest = $2 WHERE id = $1`, [id, digest({ basis: row, last: result.after })]);
      else await client.query(`UPDATE access.derived_generation SET lease_expires_at = clock_timestamp()
        WHERE id = $1`, [id]);
      return generation(client, id);
    });
  }

  async cancel(context: ManageContext, id: string) {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const row = await generation(client, id);
      await manager(client, context, row);
      if (!['building', 'cancelled'].includes(row.state)) throw new RecommendationStale('Generation cannot be cancelled');
      await client.query(`UPDATE access.derived_generation SET state = 'cancelled',
        lease_expires_at = NULL, finished_at = clock_timestamp(), failure_reason = 'manager-cancelled'
        WHERE id = $1 AND state = 'building'`, [id]);
      return generation(client, id);
    });
  }

  async activate(context: ManageContext, id: string, expected: string | null,
    position: ReadPosition, key: ReceiptKey) {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const row = await generation(client, id);
      const principal = await manager(client, context, row);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`discovery-receipt:${principal}:${key.idempotencyKey}`]);
      assertPosition(row, position);
      await assertFence(client, row);
      return activateHead(client, principal, key, id, expected);
    });
  }

  async active(basis: OwnedDiscoveryBasis, position: ReadPosition, pinned?: string) {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const head = (await client.query<{ active_generation: string }>(`SELECT active_generation::text
        FROM access.derived_generation_head WHERE family = 'discovery' AND scope_key = $1`,
      [discoveryScopeKey(basis)])).rows[0];
      if (!head) throw new RecommendationUnavailable('Discovery has no active generation');
      if (pinned && head.active_generation !== pinned) throw new RecommendationRestart('Discovery generation changed');
      const row = await generation(client, head.active_generation);
      if (row.state !== 'ready' || digest(basisOf(row)) !== digest(basis)) {
        throw new RecommendationUnavailable('Discovery basis is unavailable');
      }
      assertPosition(row, position);
      await assertFence(client, row);
      return row;
    });
  }

  async page(row: DiscoveryGeneration, sort: 'recent' | 'top-rated', type: string, term: string,
    limit: number, after?: { key: string; work: string }) {
    return inAccess(this.pool, async client => {
      await assertFence(client, row);
      if (!Number.isInteger(limit) || limit < 1 || limit > DISCOVERY_COST.pageSize) {
        throw new RecommendationUnavailable('Discovery page is out of bounds');
      }
      const result = (await client.query<DiscoveryRow>(discoverySeekSql(sort, !!after),
        [row.generation_id, type, term, limit + 1, ...(after ? [after.key, after.work] : [])])).rows;
      if (Buffer.byteLength(JSON.stringify(result)) > DISCOVERY_COST.projectionBytes) {
        throw new RecommendationUnavailable('Discovery page exceeds its byte budget');
      }
      return result;
    });
  }
}
