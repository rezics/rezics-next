import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { inAccess, RecommendationStale, requireRecoveryOpen } from '../recommendation/derived-generation.ts';
import type { ReadPosition } from '../work/read-session.ts';
import { WORK_READ_COST } from '../work/read-contract.ts';
import type { OwnedDiscoveryBasis } from './contract.ts';
import { discoveryScopeKey, generation, sourceFence, type DiscoveryGeneration } from './store.ts';

export const DISCOVERY_REFRESH_COST = { intervalMs: 1000, idleMs: 5000, retryMs: 30_000,
  leaseMs: 30_000, catalogSize: 20, jobsPerTick: 1, worksPerTick: 1, purgeEntries: 1000,
  graphCalls: WORK_READ_COST.graphCalls + 3 } as const;
export interface RefreshJob { scope_key: string; basis: OwnedDiscoveryBasis; generation_id: string | null; lease_epoch: string }
const current = (row: DiscoveryGeneration, position: ReadPosition, fence: { revision: string; generation: string }) =>
  row.source_epoch === position.dataEpoch && row.source_sequence === position.sequence
  && row.access_revision === fence.revision && row.recovery_generation === fence.generation;

/** A due-index claim serializes each population, not the graph or other jobs.
 * SKIP LOCKED is queue-only: https://www.postgresql.org/docs/18/sql-select.html
 * (reviewed 2026-09-28). Dataset correctness still uses the owner source fences. */
export class DiscoveryRefreshStore {
  constructor(private readonly pool: Pool) {}

  async purge(): Promise<number> {
    return inAccess(this.pool, async client => {
      await requireRecoveryOpen(client);
      const row = (await client.query<{ generation_id: string }>(`SELECT generation_id FROM access.discovery_retirement
        ORDER BY generation_id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!row) return 0;
      const deleted = await client.query(`DELETE FROM access.discovery_entry WHERE (generation_id, work, work_type, term) IN (
        SELECT generation_id, work, work_type, term FROM access.discovery_entry WHERE generation_id = $1
        ORDER BY work, work_type, term LIMIT $2)`, [row.generation_id, DISCOVERY_REFRESH_COST.purgeEntries]);
      if ((deleted.rowCount ?? 0) < DISCOVERY_REFRESH_COST.purgeEntries) {
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
      if (active && current(await generation(client, active.active_generation), position, fence)) {
        return { fresh: true, row: null, principal: null };
      }
      let principal: VerifiedPrincipal | null = null;
      if (job.basis.owner) {
        principal = (await client.query<VerifiedPrincipal>(`SELECT account_issuer AS issuer, account_subject AS subject
          FROM access.principal WHERE id = $1 AND active FOR SHARE`, [job.basis.owner])).rows[0] ?? null;
        if (!principal) return { fresh: false, row: null, principal: null, inactive: true };
      }
      const pending = (await client.query<{ id: string }>(`SELECT id FROM access.derived_generation
        WHERE family = 'discovery' AND scope_key = $1 AND
          (state = 'building' OR (id = $2 AND state = 'ready'))
        ORDER BY created_at, id LIMIT 1 FOR UPDATE`, [job.scope_key, job.generation_id])).rows[0];
      if (!pending) return { fresh: false, row: null, principal };
      const row = await generation(client, pending.id);
      if (current(row, position, fence)) return { fresh: false, row, principal };
      // Obsolete work can never activate. Closing it releases the one-building
      // constraint and fences a delayed manager/worker commit through its state.
      await client.query(`UPDATE access.derived_generation SET state = 'cancelled', lease_expires_at = NULL,
        finished_at = clock_timestamp(), failure_reason = 'discovery-source-changed' WHERE id = $1`, [row.generation_id]);
      return { fresh: false, row: null, principal };
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
