import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { activateHead, authorizeManager, claimLease, digest, fenceLease, inAccess,
  recordReceipt, replayReceipt, requireRecoveryOpen, RecommendationConflict,
  RecommendationDenied, RecommendationMissing, RecommendationRestart, RecommendationStale, RecommendationUnavailable,
  type ManageContext, type ReceiptKey } from '../recommendation/derived-generation.ts';
import type { ReadPosition } from '../work/read-session.ts';
import { READ_BASIS_RETENTION_MS } from '../read-basis/retention.ts';
import { DISCOVERY_COST, type DiscoveryBasis, type DiscoveryRow, type OwnedDiscoveryBasis,
  type ProjectedWork } from './contract.ts';
import { discoveryAutomation, DISCOVERY_SERVICE_PRINCIPAL, type DiscoveryAutomation } from './automation.ts';
import { DISCOVERY_SOURCE_PROFILE } from './profile.ts';

type DiscoveryOperator = ManageContext | DiscoveryAutomation;

export interface DiscoveryGeneration {
  generation_id: string; scope: DiscoveryBasis['scope']; realm: string | null; context: string | null;
  principal_id: string | null; source_epoch: string; source_sequence: string;
  access_revision: string; recovery_generation: string; checkpoint: string; complete: boolean;
  state: string; work_count: string; active_head: string | null;
  changed_works: string[] | null;
  source_profile?: string | null;
}
export interface DiscoveryReadGeneration extends DiscoveryGeneration { stale: boolean }
const basisOf = (row: DiscoveryGeneration): OwnedDiscoveryBasis => ({ scope: row.scope,
  realm: row.realm, context: row.context, owner: row.principal_id });
export const discoveryScopeKey = (basis: OwnedDiscoveryBasis) => digest(['discovery-standing-mean-v1', basis]);

export const DISCOVERY_SELECTED_TERM_COST = { terms: DISCOVERY_COST.pageSize, queries: 1 } as const;
export const discoverySelectedTermsSql = `SELECT term, concept, work_count::text FROM access.discovery_term_count
  WHERE generation_id = $1 AND term = ANY($2::text[]) LIMIT ${DISCOVERY_SELECTED_TERM_COST.terms}`;

export function discoverySeekSql(sort: 'recent' | 'top-rated', continuation: boolean): string {
  const key = sort === 'recent' ? 'recent_order' : 'rating_order';
  return `SELECT work, ${key}::text AS order_key, payload FROM access.discovery_entry
    WHERE generation_id = $1 AND work_type = $2 AND term = $3
      ${sort === 'top-rated' ? 'AND rating_count > 0' : ''}
      ${continuation ? `AND (${key}, work COLLATE "C") > ($5::numeric, $6::text COLLATE "C")` : ''}
    ORDER BY ${key}, work COLLATE "C" LIMIT $4`;
}

export async function sourceFence(client: PoolClient) {
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
export async function generation(client: PoolClient, id: string): Promise<DiscoveryGeneration> {
  const row = (await client.query<DiscoveryGeneration>(`SELECT d.*, g.state, h.revision::text AS active_head,
    d.source_sequence::text, d.access_revision::text, d.work_count::text,
    g.input_manifest->>'sourceProfile' AS source_profile
    FROM access.discovery_generation d JOIN access.derived_generation g ON g.id = d.generation_id
    LEFT JOIN access.derived_generation_head h ON h.family = 'discovery' AND h.scope_key = g.scope_key
    WHERE d.generation_id = $1`, [id])).rows[0];
  if (!row) throw new RecommendationMissing('Discovery generation is unavailable');
  return row;
}
async function operatorPrincipal(client: PoolClient, context: DiscoveryOperator,
  scope: DiscoveryBasis['scope'], owner?: string | null) {
  if (discoveryAutomation in context) {
    const principal = context[discoveryAutomation];
    if (scope !== 'mine') {
      if (principal) throw new RecommendationDenied('Shared refresh cannot select a principal');
      return DISCOVERY_SERVICE_PRINCIPAL;
    }
    if (!principal || (owner && owner !== principal)
      || !(await client.query('SELECT id FROM access.principal WHERE id = $1 AND active FOR SHARE', [principal])).rowCount) {
      throw new RecommendationDenied('Refresh principal is unavailable');
    }
    return principal;
  }
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
const manager = (client: PoolClient, context: DiscoveryOperator, row: DiscoveryGeneration) =>
  operatorPrincipal(client, context, row.scope, row.principal_id);

/** Durable generation/checkpoint protocol; no method in the GET path builds or
 * aggregates. Manager-driven advance calls do one Work and release their lease. */
export class DiscoveryProjection {
  constructor(private readonly pool: Pool) {}

  async register(context: DiscoveryOperator, basis: DiscoveryBasis, position: ReadPosition, key: ReceiptKey,
    reuse?: { generation: string; works: string[] }) {
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
      const manifest = { basis: owned, position, access: fence, sourceProfile: DISCOVERY_SOURCE_PROFILE };
      await client.query(`INSERT INTO access.derived_generation
        (id, family, scope_key, input_digest, input_manifest, lease_expires_at)
        VALUES ($1, 'discovery', $2, $3, $4, clock_timestamp())`, [id, scope, digest(manifest), manifest]);
      await client.query(`INSERT INTO access.discovery_generation
        (generation_id, scope, realm, context, principal_id, source_epoch, source_sequence,
         access_revision, recovery_generation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, basis.scope, basis.realm, basis.context, owned.owner, position.dataEpoch, position.sequence,
        fence.revision, fence.generation]);
      // Reuse saves graph hydration, but immutable generations still copy SQL
      // rows. Bound that copy; larger populations use resumable source batches.
      const reusable = reuse && Number((await client.query<{ count: string }>(`SELECT count(*)::text FROM (
        SELECT 1 FROM access.discovery_entry WHERE generation_id = $1 LIMIT $2) bounded`,
      [reuse.generation, DISCOVERY_COST.reuseEntries + 1])).rows[0]!.count) <= DISCOVERY_COST.reuseEntries;
      if (reuse && reusable) {
        const prior = await generation(client, reuse.generation);
        if (prior.state !== 'ready' || prior.source_epoch !== position.dataEpoch
          || prior.access_revision !== fence.revision || prior.recovery_generation !== fence.generation
          || prior.source_profile !== DISCOVERY_SOURCE_PROFILE
          || digest(basisOf(prior)) !== digest(owned) || reuse.works.length > 2000
          || BigInt(prior.source_sequence) > BigInt(position.sequence)) {
          throw new RecommendationRestart('Discovery reuse basis changed');
        }
        await client.query(`INSERT INTO access.discovery_entry
          (generation_id, work, work_type, term, recent_order, rating_count, rating_sum, payload)
          SELECT $1, work, work_type, term, recent_order, rating_count, rating_sum, payload
          FROM access.discovery_entry WHERE generation_id = $2 AND NOT (work = ANY($3::text[]))`,
        [id, reuse.generation, reuse.works]);
        await client.query(`INSERT INTO access.discovery_term_count (generation_id, term, concept, work_count)
          SELECT $1, term, payload->'classification'->>'concept', count(*)
          FROM access.discovery_entry WHERE generation_id = $1 AND work_type = '' AND term <> ''
          GROUP BY term, payload->'classification'->>'concept'`, [id]);
        await client.query(`UPDATE access.discovery_generation SET changed_works = $2,
          work_count = (SELECT count(*) FROM access.discovery_entry
            WHERE generation_id = $1 AND work_type = '' AND term = '') WHERE generation_id = $1`,
        [id, JSON.stringify(reuse.works)]);
      }
      await client.query(`INSERT INTO access.derived_generation_input
        (generation_id, source, data_epoch, pinned_sequence, checkpoint_sequence)
        VALUES ($1, 'main-graph', $2, $3, $3)`, [id, position.dataEpoch, position.sequence]);
      await recordReceipt(client, principal, key, { action: 'build', generation_id: id,
        outcome: 'succeeded', head_revision: null });
      return { ...await generation(client, id), replayed: false };
    });
  }

  async view(context: DiscoveryOperator, id: string) {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const row = await generation(client, id);
      await manager(client, context, row);
      return row;
    });
  }

  async beginStep(context: DiscoveryOperator, id: string, checkpoint: string) {
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

  async commitStep(context: DiscoveryOperator, id: string, lease: string, checkpoint: string,
    result: { after: string; complete: boolean; item: ProjectedWork | null }, position: ReadPosition) {
    return this.commitBatch(context, id, lease, checkpoint,
      { ...result, items: result.item ? [result.item] : [] }, position);
  }

  async releaseStep(context: DiscoveryOperator, id: string, lease: string) {
    await inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      await manager(client, context, await generation(client, id));
      await client.query(`UPDATE access.derived_generation SET lease_expires_at = clock_timestamp()
        WHERE id = $1 AND lease_epoch = $2 AND state = 'building'`, [id, lease]);
    });
  }

  async commitBatch(context: DiscoveryOperator, id: string, lease: string, checkpoint: string,
    result: { after: string; complete: boolean; items: ProjectedWork[] }, position: ReadPosition) {
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
      if (result.items.length > DISCOVERY_COST.buildWorks
        || new Set(result.items.map(item => item.work)).size !== result.items.length) {
        throw new RecommendationUnavailable('Discovery batch exceeds its bound');
      }
      const entries = result.items.flatMap(item => {
        if (item.work <= checkpoint || item.work > result.after || item.types.length > 3
          || item.classifications.length > DISCOVERY_COST.termsPerWork
          || new Set(item.classifications.map(term => term.sense)).size !== item.classifications.length
          || item.primaryCredits.length > DISCOVERY_COST.primaryCredits) {
          throw new RecommendationUnavailable('Discovery projection exceeds its fanout');
        }
        return ['', ...item.types].flatMap(type => [null, ...item.classifications].map(term => ({
          work: item.work, recent: item.recentOrder, count: item.rating?.count ?? 0, sum: item.rating?.sum ?? 0,
          type, term: term?.sense ?? '', payload: { revision: item.revision, mainVersion: item.mainVersion,
            types: item.types, rating: item.rating, classification: term,
            primaryCredits: item.primaryCredits, classifications: item.classifications.slice(0, DISCOVERY_COST.cardTags) } })));
      });
      if (entries.length) {
        await client.query(`INSERT INTO access.discovery_entry
          (generation_id, work, work_type, term, recent_order, rating_count, rating_sum, payload)
          SELECT $1,e.work,e.type,e.term,e.recent::numeric,e.count,e.sum,e.payload
          FROM jsonb_to_recordset($2::jsonb) e(work text, type text, term text, recent text, count smallint, sum smallint, payload jsonb)`,
        [id, JSON.stringify(entries)]);
        const terms = result.items.flatMap(item => item.classifications.map(({ sense, concept }) => ({ term: sense, concept })));
        if (terms.length) {
          const meanings = new Map<string, string>();
          for (const term of terms) {
            if (meanings.has(term.term) && meanings.get(term.term) !== term.concept) {
              throw new RecommendationUnavailable('Discovery term meaning changed within a batch');
            }
            meanings.set(term.term, term.concept);
          }
          const counts = await client.query(`INSERT INTO access.discovery_term_count (generation_id, term, concept, work_count)
            SELECT $1, t.term, t.concept, count(*) FROM jsonb_to_recordset($2::jsonb) t(term text, concept text)
            GROUP BY t.term, t.concept
            ON CONFLICT (generation_id, term) DO UPDATE
              SET work_count = access.discovery_term_count.work_count + EXCLUDED.work_count
              WHERE access.discovery_term_count.concept = EXCLUDED.concept`,
          [id, JSON.stringify(terms)]);
          if (counts.rowCount !== meanings.size) {
            throw new RecommendationUnavailable('Discovery term meaning changed within a build');
          }
        }
      }
      await client.query(`UPDATE access.discovery_generation SET checkpoint = $2, complete = $3,
        work_count = work_count + $4 WHERE generation_id = $1`, [id, result.after, result.complete, result.items.length]);
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

  async cancel(context: DiscoveryOperator, id: string) {
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

  async activate(context: DiscoveryOperator, id: string, expected: string | null,
    position: ReadPosition, key: ReceiptKey) {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const row = await generation(client, id);
      if (row.source_profile !== DISCOVERY_SOURCE_PROFILE) {
        throw new RecommendationRestart('Discovery source profile changed');
      }
      const principal = await manager(client, context, row);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`discovery-receipt:${principal}:${key.idempotencyKey}`]);
      // A completed population is immutable at its source cut. Concurrent
      // writes affect freshness, not eligibility to activate that pinned cut.
      const fence = await sourceFence(client);
      if (row.source_epoch !== position.dataEpoch || row.recovery_generation !== fence.generation
        || BigInt(row.source_sequence) > BigInt(position.sequence)) {
        throw new RecommendationRestart('Discovery recovery basis changed');
      }
      if ((await client.query(`SELECT 1 FROM access.derived_generation_head
        WHERE family = 'discovery' AND active_generation = $1`, [id])).rowCount
        && !await replayReceipt(client, principal, key, 'activate')) {
        throw new RecommendationStale('Discovery generation is already active');
      }
      return activateHead(client, principal, key, id, expected);
    });
  }

  async active(basis: OwnedDiscoveryBasis, position: ReadPosition, pinned?: string): Promise<DiscoveryReadGeneration> {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const head = (await client.query<{ active_generation: string }>(`SELECT active_generation::text
        FROM access.derived_generation_head WHERE family = 'discovery' AND scope_key = $1`,
      [discoveryScopeKey(basis)])).rows[0];
      if (!head) throw new RecommendationUnavailable('Discovery has no active generation');
      const row = await generation(client, pinned ?? head.active_generation);
      // Activation may replace the head between these READ COMMITTED statements.
      // The captured generation is also a pin on a first page, not a 503 race.
      const retained = row.state !== 'ready' && (await client.query(`SELECT id FROM access.derived_generation
        WHERE id = $1 AND state IN ('superseded', 'expired')
          AND finished_at > clock_timestamp() - make_interval(secs => $2::double precision / 1000)`,
      [row.generation_id, READ_BASIS_RETENTION_MS])).rowCount === 1;
      if (row.state !== 'ready' && !retained) {
        if (pinned) throw new RecommendationRestart('Discovery generation expired');
        throw new RecommendationUnavailable('Discovery basis is unavailable');
      }
      if (digest(basisOf(row)) !== digest(basis)) {
        throw new RecommendationUnavailable('Discovery basis is unavailable');
      }
      const fence = await sourceFence(client);
      if (row.source_epoch !== position.dataEpoch || row.recovery_generation !== fence.generation) {
        if (pinned) throw new RecommendationRestart('Discovery recovery basis expired');
        throw new RecommendationUnavailable('Discovery recovery basis is unavailable');
      }
      return { ...row, stale: row.source_profile !== DISCOVERY_SOURCE_PROFILE
        || row.source_sequence !== position.sequence
        || row.access_revision !== fence.revision || row.state !== 'ready'
        || head.active_generation !== row.generation_id };
    });
  }

  async page(row: DiscoveryGeneration, sort: 'recent' | 'top-rated', type: string, term: string,
    limit: number, after?: { key: string; work: string }) {
    return inAccess(this.pool, async client => {
      // Ranking rows are immutable. Source writes invalidate freshness, not the
      // population; recovery remains a hard boundary for every page.
      const fence = await sourceFence(client);
      if (fence.generation !== row.recovery_generation) throw new RecommendationRestart('Discovery recovery basis expired');
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

  /** Exact selected-Sense lookups on (generation_id, term), independent of popularity rank.
   * Absent rows mean zero only when the caller verifies the generation is fresh. */
  async selectedTerms(row: DiscoveryGeneration, terms: readonly string[]) {
    if (terms.length > DISCOVERY_SELECTED_TERM_COST.terms || new Set(terms).size !== terms.length
      || terms.some(term => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(term))) {
      throw new RecommendationUnavailable('Selected term page is out of bounds');
    }
    return inAccess(this.pool, async client => {
      const fence = await sourceFence(client);
      if (fence.generation !== row.recovery_generation) throw new RecommendationRestart('Discovery recovery basis expired');
      return terms.length ? (await client.query<{ term: string; concept: string; work_count: string }>(
        discoverySelectedTermsSql, [row.generation_id, terms])).rows : [];
    });
  }

  async popular(row: DiscoveryGeneration, limit: number) {
    return inAccess(this.pool, async client => {
      const fence = await sourceFence(client);
      if (fence.generation !== row.recovery_generation) throw new RecommendationRestart('Discovery recovery basis expired');
      if (!Number.isInteger(limit) || limit < 1 || limit > DISCOVERY_COST.pageSize) {
        throw new RecommendationUnavailable('Popular term page is out of bounds');
      }
      return (await client.query<{ term: string; concept: string; work_count: string }>(`
        SELECT term, concept, work_count::text FROM access.discovery_term_count
        WHERE generation_id = $1 ORDER BY work_count DESC, term COLLATE "C" LIMIT $2`,
      [row.generation_id, limit])).rows;
    });
  }
}
