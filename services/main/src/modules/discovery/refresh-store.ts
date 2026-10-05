import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import {
  inAccess,
  RecommendationStale,
  requireRecoveryOpen,
} from '../recommendation/derived-generation.ts';
import type { ReadPosition } from '../work/read-session.ts';
import { WORK_READ_COST } from '../work/read-contract.ts';
import { DISCOVERY_COST, type OwnedDiscoveryBasis } from './contract.ts';
import {
  discoveryAccessBasis,
  discoveryScopeKey,
  discoveryStorage,
  DISCOVERY_SOURCE_KEY_COST,
  foldSourceFence,
  generation,
  sourceChanges,
  sourceChangesWithin,
  sourceFence,
  type DiscoveryGeneration,
  type DiscoverySourceChanges,
} from './store.ts';
import { DISCOVERY_SOURCE_PROFILE } from './profile.ts';
import type { DiscoveryChanges } from './changes.ts';
import {
  rollbackDiscoveryVersion,
  repairAbandonedDiscoveryVersion,
  discoveryStorageReusable,
} from './versions.ts';

export const DISCOVERY_REFRESH_COST = {
  intervalMs: 100,
  idleMs: 1000,
  backgroundIdleMs: 30_000,
  foregroundBurst: 8,
  fullBuildMs: 300_000,
  recoveryMs: 10_000,
  retryMs: 30_000,
  maximumRetryMs: 300_000,
  localStatements: 160,
  localGraphCalls: 12,
  irrelevantStatements: 50,
  irrelevantGraphCalls: 6,
  leaseMs: 30_000,
  catalogSize: 20,
  jobsPerTick: 1,
  worksPerTick: DISCOVERY_COST.buildWorks,
  purgeEntries: 1000,
  graphCalls: WORK_READ_COST.graphCalls + 3,
} as const;
export interface RefreshJob {
  scope_key: string;
  basis: OwnedDiscoveryBasis;
  generation_id: string | null;
  lease_epoch: string;
  attempts?: string;
}
export function discoveryRetryDelay(attempts = '1'): number {
  return Math.min(
    DISCOVERY_REFRESH_COST.maximumRetryMs,
    DISCOVERY_REFRESH_COST.retryMs * 2 ** Math.min(4, Math.max(0, Number(attempts) - 1)),
  );
}
/** `since` holds the changes folded after the row's Access basis. A change
 * still awaiting its fold is after every revision; the next tick folds it. */
export const discoveryGenerationCurrent = (
  row: Pick<
    DiscoveryGeneration,
    'source_epoch' | 'source_sequence' | 'recovery_generation' | 'source_profile' | 'covered_sequence'
  >,
  position: ReadPosition,
  since: Pick<DiscoverySourceChanges, 'wide' | 'statements' | 'generation'>,
) =>
  row.source_epoch === position.dataEpoch &&
  (row.covered_sequence ?? row.source_sequence) === position.sequence &&
  !since.wide &&
  !since.statements.length &&
  row.recovery_generation === since.generation &&
  row.source_profile === DISCOVERY_SOURCE_PROFILE;

/** A due-index claim serializes each population, not the graph or other jobs.
 * SKIP LOCKED is queue-only: https://www.postgresql.org/docs/18/sql-select.html
 * (reviewed 2026-09-28). Dataset correctness still uses the owner source fences. */
export class DiscoveryRefreshStore {
  constructor(private readonly pool: Pool) {}

  async purge(): Promise<number> {
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      const row = (
        await client.query<{
          generation_id: string;
          root: string;
          storage_version: string;
          scope_key: string;
        }>(`SELECT r.generation_id,d.storage_version::text,g.scope_key,
        coalesce(d.storage_generation,d.generation_id) AS root FROM access.discovery_retirement r
        JOIN access.derived_generation g ON g.id = r.generation_id
        JOIN access.discovery_generation d ON d.generation_id=r.generation_id
        WHERE r.due_at <= statement_timestamp()
        ORDER BY r.due_at,r.generation_id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`)
      ).rows[0];
      if (!row) return 0;
      const lock = (
        await client.query<{ held: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS held',
          [`discovery:${row.scope_key}`],
        )
      ).rows[0];
      if (!lock?.held) return 0;
      const retained = (
        await client.query<{ version: string | null }>(
          `SELECT min(d.storage_version)::text AS version
        FROM access.discovery_generation d JOIN access.derived_generation g ON g.id=d.generation_id
        WHERE coalesce(d.storage_generation,d.generation_id)=$1
          AND (g.state IN ('building','ready') OR g.finished_at>statement_timestamp()-interval '6 minutes')`,
          [row.root],
        )
      ).rows[0]!.version;
      if (row.root !== row.generation_id) {
        const latest = (
          await client.query<{ version: string | null }>(
            `SELECT max(d.storage_version)::text AS version
          FROM access.discovery_generation d JOIN access.derived_generation g ON g.id=d.generation_id
          WHERE coalesce(d.storage_generation,d.generation_id)=$1 AND g.state IN ('building','ready','superseded')`,
            [row.root],
          )
        ).rows[0]!.version;
        if (latest === null || BigInt(row.storage_version) > BigInt(latest)) {
          await rollbackDiscoveryVersion(client, await generation(client, row.generation_id));
        }
      }
      await client.query("SELECT set_config('rezics.discovery_mode','purge',true)");
      let deleted = 0,
        pending = false;
      for (const table of ['discovery_entry', 'discovery_term_count', 'discovery_concept_count']) {
        const removed = await client.query(
          `DELETE FROM access.${table} WHERE ctid IN (
          SELECT ctid FROM access.${table} WHERE generation_id=$1
            ${retained === null ? 'AND $2::bigint IS NULL' : 'AND retired_version <= $2::bigint'} LIMIT $3)`,
          [row.root, retained, DISCOVERY_REFRESH_COST.purgeEntries],
        );
        deleted += removed.rowCount ?? 0;
        pending ||= removed.rowCount === DISCOVERY_REFRESH_COST.purgeEntries;
      }
      if (!pending) {
        await client.query('DELETE FROM access.discovery_retirement WHERE generation_id = $1', [
          row.generation_id,
        ]);
        await client.query(
          `UPDATE access.discovery_refresh SET generation_id=NULL WHERE generation_id=$1`,
          [row.generation_id],
        );
        // Keep only storage roots referenced by live/retained generations.
        const removed = await client.query(
          `DELETE FROM access.discovery_generation d WHERE d.generation_id=$1
          AND NOT EXISTS (SELECT 1 FROM access.discovery_generation child WHERE child.storage_generation=d.generation_id)
          AND NOT EXISTS (SELECT 1 FROM access.discovery_entry e WHERE e.generation_id=d.generation_id)
          RETURNING generation_id`,
          [row.generation_id],
        );
        if (removed.rowCount && row.root !== row.generation_id)
          await client.query(
            `INSERT INTO access.discovery_retirement (generation_id,due_at)
          SELECT id,finished_at+interval '6 minutes' FROM access.derived_generation WHERE id=$1 AND state IN ('superseded','expired','failed','cancelled')
          ON CONFLICT DO NOTHING`,
            [row.root],
          );
      }
      return deleted;
    });
  }

  async enroll(bases: OwnedDiscoveryBasis[]): Promise<void> {
    if (bases.length > DISCOVERY_REFRESH_COST.catalogSize + 1)
      throw new Error('Refresh enrollment exceeds its bound');
    await inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      for (const basis of bases)
        await client.query(
          `INSERT INTO access.discovery_refresh (scope_key, basis)
        VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [discoveryScopeKey(basis), basis],
        );
    });
  }

  async catalog(): Promise<string | null> {
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      return (
        (
          await client.query<{ checkpoint: string }>(`UPDATE access.discovery_refresh_catalog
        SET due_at = clock_timestamp() + interval '30 seconds' WHERE id AND due_at <= clock_timestamp()
        RETURNING checkpoint`)
        ).rows[0]?.checkpoint ?? null
      );
    });
  }

  async catalogDone(checkpoint: string, after: string): Promise<void> {
    await inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      await client.query(
        `UPDATE access.discovery_refresh_catalog SET checkpoint = $2,
        due_at = clock_timestamp() + interval '5 seconds' WHERE id AND checkpoint = $1`,
        [checkpoint, after],
      );
    });
  }

  async claim(background = false): Promise<RefreshJob | null> {
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      for (const priority of background ? [1, 0] : [0, 1]) {
        const claimed = (
          await client.query<RefreshJob>(
            `UPDATE access.discovery_refresh j
        SET due_at = clock_timestamp() + interval '30 seconds', lease_epoch = j.lease_epoch + 1,
          attempts = attempts + 1
        FROM (SELECT scope_key FROM access.discovery_refresh WHERE priority=$1 AND due_at <= statement_timestamp()
          ORDER BY due_at, scope_key LIMIT 1 FOR UPDATE SKIP LOCKED) candidate
        WHERE j.scope_key = candidate.scope_key RETURNING j.*, j.lease_epoch::text, j.attempts::text`,
            [priority],
          )
        ).rows[0];
        if (claimed) return claimed;
      }
      return null;
    });
  }

  /** `access` names the folded revision and the judged Statements after the
   * active generation's Access basis that reach this population. */
  async inspect(job: RefreshJob, position: ReadPosition) {
    return inAccess(this.pool, async (client) => {
      // Folding first gives every committed change its key and revision. A
      // fold locks the fence row until this transaction ends; writers never do.
      await foldSourceFence(client);
      const held = await client.query(
        `SELECT scope_key FROM access.discovery_refresh
        WHERE scope_key = $1 AND lease_epoch = $2 AND due_at > clock_timestamp() FOR UPDATE`,
        [job.scope_key, job.lease_epoch],
      );
      if (!held.rowCount) throw new RecommendationStale('Refresh lease changed');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `discovery:${job.scope_key}`,
      ]);
      const active = (
        await client.query<{ active_generation: string }>(
          `SELECT active_generation
        FROM access.derived_generation_head WHERE family = 'discovery' AND scope_key = $1`,
          [job.scope_key],
        )
      ).rows[0];
      const prior = active ? await generation(client, active.active_generation) : null;
      let principal: VerifiedPrincipal | null = null;
      if (job.basis.owner) {
        principal =
          (
            await client.query<VerifiedPrincipal>(
              `SELECT account_issuer AS issuer, account_subject AS subject
          FROM access.principal WHERE id = $1 AND active FOR SHARE`,
              [job.basis.owner],
            )
          ).rows[0] ?? null;
        if (!principal) return { fresh: false, row: null, principal: null, inactive: true };
      }
      const since = prior
        ? await sourceChangesWithin(
            client,
            prior,
            discoveryAccessBasis(prior),
            DISCOVERY_SOURCE_KEY_COST.statements + 1,
          )
        : null;
      if (prior && since && discoveryGenerationCurrent(prior, position, since)) {
        return { fresh: true, row: null, principal };
      }
      const access = since ? { revision: since.revision, statements: since.statements } : null;
      const pending = (
        await client.query<{ id: string; validated_sequence: string | null }>(
          `SELECT g.id,
        i.checkpoint_sequence::text AS validated_sequence FROM access.derived_generation g
        LEFT JOIN access.derived_generation_input i ON i.generation_id=g.id AND i.source='main-graph'
        WHERE g.family = 'discovery' AND g.scope_key = $1 AND
          (g.state = 'building' OR (g.id = $2 AND g.state = 'ready'))
        ORDER BY g.created_at, g.id LIMIT 1 FOR UPDATE OF g`,
          [job.scope_key, job.generation_id],
        )
      ).rows[0];
      let reuse =
        prior?.state === 'ready' &&
        since &&
        prior.source_epoch === position.dataEpoch &&
        !since.wide &&
        since.statements.length <= DISCOVERY_SOURCE_KEY_COST.statements &&
        prior.recovery_generation === since.generation &&
        prior.source_profile === DISCOVERY_SOURCE_PROFILE
          ? prior
          : null;
      if (!pending) {
        if (reuse) {
          await repairAbandonedDiscoveryVersion(client, reuse);
          if (!(await discoveryStorageReusable(client, reuse))) reuse = null;
        }
        return { fresh: false, row: null, principal, reuse, access };
      }
      const row = {
        ...(await generation(client, pending.id)),
        validated_sequence: pending.validated_sequence ?? null,
      };
      // A build outlives judged Statements after its basis; only a wide change
      // or recovery makes it obsolete.
      const own = await sourceChangesWithin(client, row, discoveryAccessBasis(row));
      if (
        row.source_epoch === position.dataEpoch &&
        row.recovery_generation === own.generation &&
        row.source_profile === DISCOVERY_SOURCE_PROFILE &&
        (row.complete || !own.wide)
      )
        return { fresh: false, row, principal, reuse, access };
      // Obsolete work can never activate. Closing it releases the one-building
      // constraint and fences a delayed manager/worker commit through its state.
      await rollbackDiscoveryVersion(client, row);
      await client.query(
        `UPDATE access.derived_generation SET state = 'cancelled', lease_expires_at = NULL,
        finished_at = clock_timestamp(), failure_reason = 'discovery-source-changed' WHERE id = $1`,
        [row.generation_id],
      );
      return { fresh: false, row: null, principal, reuse, access };
    });
  }

  /** Which of at most 2,000 Works a generation holds, one primary-key probe
   * each. A judged Statement reaches only Works already in the population:
   * judgments change classifications, never membership. */
  async members(row: DiscoveryGeneration, works: readonly string[]): Promise<string[]> {
    if (works.length > DISCOVERY_SOURCE_KEY_COST.statements)
      throw new RecommendationStale('Discovery membership probe exceeds its bound');
    if (!works.length) return [];
    return inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      return (
        await client.query<{ work: string }>(
          `SELECT DISTINCT work FROM access.discovery_entries($1,$2)
        WHERE generation_id=$1 AND work_type='' AND term='' AND work=ANY($3::text[])`,
          [...discoveryStorage(row), works],
        )
      ).rows.map((item) => item.work);
    });
  }

  /** Persist before advancing: a crash after the last Work must leave the ready
   * generation discoverable for activation, even on a one-Work population. */
  async attach(job: RefreshJob, generationId: string): Promise<void> {
    await inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      const result = await client.query(
        `UPDATE access.discovery_refresh SET generation_id = $3
        WHERE scope_key = $1 AND lease_epoch = $2 AND due_at > clock_timestamp()`,
        [job.scope_key, job.lease_epoch, generationId],
      );
      if (!result.rowCount) throw new RecommendationStale('Refresh lease changed');
    });
  }

  /** Evidence through this cut is durable only after workRead's final fence.
   * Keep the immutable population pin, while each tick validates a bounded new
   * interval instead of eventually exceeding the delta budget from its birth. */
  async validated(
    job: RefreshJob,
    row: DiscoveryGeneration,
    sequence: string,
    changes?: DiscoveryChanges | null,
  ): Promise<void> {
    await inAccess(this.pool, async (client) => {
      const since = await sourceChanges(client, row, discoveryAccessBasis(row));
      if (since.wide || row.recovery_generation !== since.generation) {
        throw new RecommendationStale('Discovery validation source changed');
      }
      const held = await client.query(
        `SELECT scope_key FROM access.discovery_refresh
        WHERE scope_key=$1 AND lease_epoch=$2 AND generation_id=$3 AND due_at > clock_timestamp() FOR UPDATE`,
        [job.scope_key, job.lease_epoch, row.generation_id],
      );
      if (!held.rowCount) throw new RecommendationStale('Refresh lease changed');
      const result = await client.query(
        `UPDATE access.derived_generation_input i SET checkpoint_sequence=$2::numeric
        FROM access.derived_generation g WHERE i.generation_id=$1 AND i.source='main-graph'
          AND g.id=i.generation_id AND g.state='building' AND i.checkpoint_sequence <= $2::numeric
          AND i.pinned_sequence <= $2::numeric`,
        [row.generation_id, sequence],
      );
      if (!result.rowCount)
        throw new RecommendationStale('Discovery validation checkpoint changed');
      if (changes === null)
        await client.query(
          'UPDATE access.discovery_generation SET rebuild_pending=true WHERE generation_id=$1',
          [row.generation_id],
        );
      else if (changes?.works.length)
        await client.query(
          `WITH combined AS (
        SELECT jsonb_agg(work ORDER BY work) AS works FROM (SELECT DISTINCT work FROM access.discovery_generation d,
          jsonb_array_elements_text(d.catchup_works || $2::jsonb) AS v(work) WHERE d.generation_id=$1) keys)
        UPDATE access.discovery_generation SET catchup_works=CASE WHEN jsonb_array_length(combined.works)<=2000
          THEN combined.works ELSE '[]'::jsonb END,
          rebuild_pending=rebuild_pending OR jsonb_array_length(combined.works)>2000 FROM combined
        WHERE generation_id=$1`,
          [row.generation_id, JSON.stringify(changes.works)],
        );
      await client.query(
        `INSERT INTO access.discovery_coverage (generation_id,sequence) VALUES ($1,$2)
        ON CONFLICT (generation_id) DO UPDATE SET sequence=greatest(access.discovery_coverage.sequence,EXCLUDED.sequence)`,
        [row.generation_id, sequence],
      );
    });
  }

  /** An exact irrelevant interval advances the graph and Access watermarks,
   * allocating no rows. `access` is a folded revision whose reaching changes
   * after the row's basis the caller found outside its population; anything
   * folded later stays after the new watermark. */
  async acknowledge(
    job: RefreshJob,
    row: DiscoveryGeneration,
    position: ReadPosition,
    access: string,
  ) {
    await inAccess(this.pool, async (client) => {
      const fence = await sourceFence(client);
      if (
        row.recovery_generation !== fence.generation ||
        row.source_epoch !== position.dataEpoch ||
        BigInt(access) < BigInt(discoveryAccessBasis(row)) ||
        BigInt(access) > BigInt(fence.revision)
      )
        throw new RecommendationStale('Discovery acknowledgment fence changed');
      const held = await client.query(
        `SELECT scope_key FROM access.discovery_refresh
        WHERE scope_key=$1 AND lease_epoch=$2 AND due_at>clock_timestamp() FOR UPDATE`,
        [job.scope_key, job.lease_epoch],
      );
      if (!held.rowCount) throw new RecommendationStale('Refresh lease changed');
      await client.query(
        `INSERT INTO access.discovery_coverage (generation_id,sequence,access_revision) VALUES ($1,$2,$3)
        ON CONFLICT (generation_id) DO UPDATE SET sequence=greatest(access.discovery_coverage.sequence,EXCLUDED.sequence),
          access_revision=greatest(access.discovery_coverage.access_revision,EXCLUDED.access_revision)`,
        [row.generation_id, position.sequence, access],
      );
    });
  }

  async finish(
    job: RefreshJob,
    generationId: string | null,
    outcome: string,
    duration: number,
    delay: number,
  ): Promise<void> {
    await inAccess(this.pool, async (client) => {
      await requireRecoveryOpen(client);
      const result = await client.query(
        `UPDATE access.discovery_refresh SET generation_id = $3,
        last_outcome = $4, last_duration_ms = $5,
        attempts = CASE WHEN $4 = 'retry' THEN attempts ELSE 0 END,
        due_at = clock_timestamp() + make_interval(secs => $6::double precision / 1000)
        WHERE scope_key = $1 AND lease_epoch = $2 AND due_at > clock_timestamp()`,
        [job.scope_key, job.lease_epoch, generationId, outcome, Math.ceil(duration), delay],
      );
      if (!result.rowCount) throw new RecommendationStale('Refresh lease changed');
    });
  }
}
