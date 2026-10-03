import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { inAccess, RecommendationStale, requireRecoveryOpen } from '../recommendation/derived-generation.ts';
import type { ReadPosition } from '../work/read-session.ts';
import { WORK_READ_COST } from '../work/read-contract.ts';
import { READ_BASIS_RETENTION_MS } from '../read-basis/retention.ts';
import { DISCOVERY_COST, type OwnedDiscoveryBasis } from './contract.ts';
import { discoveryScopeKey, generation, sourceFence, type DiscoveryGeneration } from './store.ts';
import { DISCOVERY_SOURCE_PROFILE } from './profile.ts';

export const DISCOVERY_REFRESH_COST = { intervalMs: 100, idleMs: 100, retryMs: 30_000,
  leaseMs: 30_000, catalogSize: 20, jobsPerTick: 1, worksPerTick: DISCOVERY_COST.buildWorks, purgeEntries: 1000,
  graphCalls: WORK_READ_COST.graphCalls + 3 } as const;
export interface RefreshJob { scope_key: string; basis: OwnedDiscoveryBasis; generation_id: string | null; lease_epoch: string }
export const discoveryGenerationCurrent = (row: Pick<DiscoveryGeneration, 'source_epoch' | 'source_sequence'
  | 'access_revision' | 'recovery_generation' | 'source_profile'>,
position: ReadPosition, fence: { revision: string; generation: string }) =>
  row.source_epoch === position.dataEpoch && row.source_sequence === position.sequence
  && row.access_revision === fence.revision && row.recovery_generation === fence.generation
  && row.source_profile === DISCOVERY_SOURCE_PROFILE;

/** A due-index claim serializes each population, not the graph or other jobs.
 * SKIP LOCKED is queue-only: https://www.postgresql.org/docs/18/sql-select.html
 * (reviewed 2026-09-28). Dataset correctness still uses the owner source fences. */
export class DiscoveryRefreshStore {
  constructor(private readonly pool: Pool) {}

  async purge(): Promise<number> {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const row = (await client.query<{ generation_id: string }>(`SELECT r.generation_id FROM access.discovery_retirement r
        JOIN access.derived_generation g ON g.id = r.generation_id
        WHERE g.state IN ('cancelled', 'failed') OR g.finished_at <= clock_timestamp()
          - make_interval(secs => $1::double precision / 1000)
        ORDER BY r.generation_id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
      [READ_BASIS_RETENTION_MS + WORK_READ_COST.deadlineMs])).rows[0];
      if (!row) return 0;
      const deleted = await client.query(`DELETE FROM access.discovery_entry WHERE (generation_id, work, work_type, term) IN (
        SELECT generation_id, work, work_type, term FROM access.discovery_entry WHERE generation_id = $1
        ORDER BY work, work_type, term LIMIT $2)`, [row.generation_id, DISCOVERY_REFRESH_COST.purgeEntries]);
      if ((deleted.rowCount ?? 0) < DISCOVERY_REFRESH_COST.purgeEntries) {
        await client.query('DELETE FROM access.discovery_term_count WHERE generation_id = $1', [row.generation_id]);
        await client.query('DELETE FROM access.discovery_retirement WHERE generation_id = $1', [row.generation_id]);
      }
      return deleted.rowCount ?? 0;
    });
  }

  async enroll(bases: OwnedDiscoveryBasis[]): Promise<void> {
    if (bases.length > DISCOVERY_REFRESH_COST.catalogSize + 1) throw new Error('Refresh enrollment exceeds its bound');
    await inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      for (const basis of bases) await client.query(`INSERT INTO access.discovery_refresh (scope_key, basis)
        VALUES ($1, $2) ON CONFLICT DO NOTHING`, [discoveryScopeKey(basis), basis]);
    });
  }

  async catalog(): Promise<string | null> {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      return (await client.query<{ checkpoint: string }>(`UPDATE access.discovery_refresh_catalog
        SET due_at = clock_timestamp() + interval '30 seconds' WHERE id AND due_at <= clock_timestamp()
        RETURNING checkpoint`)).rows[0]?.checkpoint ?? null;
    });
  }

  async catalogDone(checkpoint: string, after: string): Promise<void> {
    await inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      await client.query(`UPDATE access.discovery_refresh_catalog SET checkpoint = $2,
        due_at = clock_timestamp() + interval '5 seconds' WHERE id AND checkpoint = $1`, [checkpoint, after]);
    });
  }

  async claim(): Promise<RefreshJob | null> {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      return (await client.query<RefreshJob>(`UPDATE access.discovery_refresh j
        SET due_at = clock_timestamp() + interval '30 seconds', lease_epoch = j.lease_epoch + 1,
          attempts = attempts + 1
        FROM (SELECT scope_key FROM access.discovery_refresh WHERE due_at <= clock_timestamp()
          ORDER BY due_at, scope_key LIMIT 1 FOR UPDATE SKIP LOCKED) candidate
        WHERE j.scope_key = candidate.scope_key RETURNING j.*, j.lease_epoch::text`)).rows[0] ?? null;
    });
  }

  async inspect(job: RefreshJob, position: ReadPosition) {
    return inAccess(this.pool, async client => {
      const fence = await sourceFence(client);
      const held = await client.query(`SELECT scope_key FROM access.discovery_refresh
        WHERE scope_key = $1 AND lease_epoch = $2 AND due_at > clock_timestamp() FOR UPDATE`,
      [job.scope_key, job.lease_epoch]);
      if (!held.rowCount) throw new RecommendationStale('Refresh lease changed');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`discovery:${job.scope_key}`]);
      const active = (await client.query<{ active_generation: string }>(`SELECT active_generation
        FROM access.derived_generation_head WHERE family = 'discovery' AND scope_key = $1`, [job.scope_key])).rows[0];
      const prior = active ? await generation(client, active.active_generation) : null;
      if (prior && discoveryGenerationCurrent(prior, position, fence)) {
        return { fresh: true, row: null, principal: null };
      }
      let principal: VerifiedPrincipal | null = null;
      if (job.basis.owner) {
        principal = (await client.query<VerifiedPrincipal>(`SELECT account_issuer AS issuer, account_subject AS subject
          FROM access.principal WHERE id = $1 AND active FOR SHARE`, [job.basis.owner])).rows[0] ?? null;
        if (!principal) return { fresh: false, row: null, principal: null, inactive: true };
      }
      const pending = (await client.query<{ id: string; validated_sequence: string | null }>(`SELECT g.id,
        i.checkpoint_sequence::text AS validated_sequence FROM access.derived_generation g
        LEFT JOIN access.derived_generation_input i ON i.generation_id=g.id AND i.source='main-graph'
        WHERE g.family = 'discovery' AND g.scope_key = $1 AND
          (g.state = 'building' OR (g.id = $2 AND g.state = 'ready'))
        ORDER BY g.created_at, g.id LIMIT 1 FOR UPDATE OF g`, [job.scope_key, job.generation_id])).rows[0];
      const reuse = prior?.state === 'ready' && prior.source_epoch === position.dataEpoch
        && prior.access_revision === fence.revision && prior.recovery_generation === fence.generation
        && prior.source_profile === DISCOVERY_SOURCE_PROFILE ? prior : null;
      if (!pending) return { fresh: false, row: null, principal, reuse };
      const row = { ...await generation(client, pending.id),
        validated_sequence: pending.validated_sequence ?? null };
      if (row.source_epoch === position.dataEpoch && row.recovery_generation === fence.generation
        && row.source_profile === DISCOVERY_SOURCE_PROFILE
        && (row.complete || row.access_revision === fence.revision)) return { fresh: false, row, principal, reuse };
      // Obsolete work can never activate. Closing it releases the one-building
      // constraint and fences a delayed manager/worker commit through its state.
      await client.query(`UPDATE access.derived_generation SET state = 'cancelled', lease_expires_at = NULL,
        finished_at = clock_timestamp(), failure_reason = 'discovery-source-changed' WHERE id = $1`, [row.generation_id]);
      return { fresh: false, row: null, principal, reuse };
    });
  }

  /** Persist before advancing: a crash after the last Work must leave the ready
   * generation discoverable for activation, even on a one-Work population. */
  async attach(job: RefreshJob, generationId: string): Promise<void> {
    await inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const result = await client.query(`UPDATE access.discovery_refresh SET generation_id = $3
        WHERE scope_key = $1 AND lease_epoch = $2 AND due_at > clock_timestamp()`,
      [job.scope_key, job.lease_epoch, generationId]);
      if (!result.rowCount) throw new RecommendationStale('Refresh lease changed');
    });
  }

  /** Evidence through this cut is durable only after workRead's final fence.
   * Keep the immutable population pin, while each tick validates a bounded new
   * interval instead of eventually exceeding the delta budget from its birth. */
  async validated(job: RefreshJob, row: DiscoveryGeneration, sequence: string): Promise<void> {
    await inAccess(this.pool, async client => {
      const fence = await sourceFence(client);
      if (row.access_revision !== fence.revision || row.recovery_generation !== fence.generation) {
        throw new RecommendationStale('Discovery validation source changed');
      }
      const held = await client.query(`SELECT scope_key FROM access.discovery_refresh
        WHERE scope_key=$1 AND lease_epoch=$2 AND generation_id=$3 AND due_at > clock_timestamp() FOR UPDATE`,
      [job.scope_key, job.lease_epoch, row.generation_id]);
      if (!held.rowCount) throw new RecommendationStale('Refresh lease changed');
      const result = await client.query(`UPDATE access.derived_generation_input i SET checkpoint_sequence=$2::numeric
        FROM access.derived_generation g WHERE i.generation_id=$1 AND i.source='main-graph'
          AND g.id=i.generation_id AND g.state='building' AND i.checkpoint_sequence <= $2::numeric
          AND i.pinned_sequence <= $2::numeric`, [row.generation_id, sequence]);
      if (!result.rowCount) throw new RecommendationStale('Discovery validation checkpoint changed');
    });
  }

  async finish(job: RefreshJob, generationId: string | null, outcome: string, duration: number, delay: number): Promise<void> {
    await inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const result = await client.query(`UPDATE access.discovery_refresh SET generation_id = $3,
        last_outcome = $4, last_duration_ms = $5,
        due_at = clock_timestamp() + make_interval(secs => $6::double precision / 1000)
        WHERE scope_key = $1 AND lease_epoch = $2 AND due_at > clock_timestamp()`,
      [job.scope_key, job.lease_epoch, generationId, outcome, Math.ceil(duration), delay]);
      if (!result.rowCount) throw new RecommendationStale('Refresh lease changed');
    });
  }
}
