import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { SCREEN_LIMITS, SCREEN_POLICY, screenUnavailable, type ScreenVerdict } from './policy.ts';

export interface ScreenLease {
  job: string; source: string; asset: string; digest: string; namespace: string; mediaType: string;
  epoch: string; token: string; attempt: number;
}
export interface ScreenReview {
  job: string; asset: string; source: string; digest: string; verdict: ScreenVerdict;
}
export interface ScreeningCases { openScreeningCase(input: ScreenReview): Promise<string> }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class MediaScreenStore {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'"); const result = await run(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  /** One indexed queue/expired-lease probe. SKIP LOCKED lets another Main instance
   * proceed without duplicate work; the held lease also fences final settlement. */
  async leaseNext(leaseMs: number = SCREEN_LIMITS.leaseMs): Promise<ScreenLease | null> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > SCREEN_LIMITS.leaseMs) throw new Error('invalid screen lease');
    return this.transaction(async client => {
      const row = (await client.query(`SELECT j.*, a.object_namespace, p.media_type FROM media.transform_job j
        JOIN media.asset a ON a.id = j.asset_id JOIN media.asset_state s ON s.id = a.state_head
        JOIN media.representation p ON p.id = j.source_id
        WHERE j.profile = $1 AND (j.status = 'queued' OR
          (j.status = 'leased' AND j.lease_expires_at <= clock_timestamp())) AND j.attempt < 16
          AND s.lifecycle = 'active' AND s.erasure_epoch = j.erasure_epoch
          AND p.availability = 'available' AND media.delivery_clearance(p) = 'screening'
        ORDER BY j.created_at, j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [SCREEN_POLICY.profile])).rows[0];
      if (!row) return null;
      const token = randomUUID();
      await client.query(`UPDATE media.transform_job SET status = 'leased', attempt = attempt + 1,
        lease_token = $2, lease_expires_at = clock_timestamp() + $3 * interval '1 millisecond' WHERE id = $1`,
      [row.id, token, leaseMs]);
      return { job: row.id, source: row.source_id, asset: row.asset_id, digest: row.input_digest,
        namespace: row.object_namespace, mediaType: row.media_type, epoch: String(row.erasure_epoch), token,
        attempt: row.attempt + 1 };
    });
  }
  /** Lost/expired token and changed erasure epoch settle nothing, including receipts. */
  async settle(lease: ScreenLease, verdict: ScreenVerdict): Promise<boolean> {
    return this.finish(lease, verdict, false);
  }
  /** Retire one obsolete job per tick so deleted/suppressed inputs cannot
   * accumulate at the front of the indexed queue and starve later originals. */
  async cancelObsolete(): Promise<void> {
    const candidate = (await this.pool.query(`SELECT j.id, j.asset_id FROM media.transform_job j
      JOIN media.asset a ON a.id = j.asset_id JOIN media.asset_state s ON s.id = a.state_head
      JOIN media.representation p ON p.id = j.source_id
      WHERE j.profile = $1 AND j.status IN ('queued','leased')
        AND (s.lifecycle <> 'active' OR s.erasure_epoch <> j.erasure_epoch
          OR p.availability <> 'available' OR media.delivery_clearance(p) <> 'screening')
      ORDER BY j.created_at, j.id LIMIT 1`, [SCREEN_POLICY.profile])).rows[0];
    if (!candidate) return;
    await this.transaction(async client => {
      await client.query('SELECT id FROM media.asset WHERE id = $1 FOR SHARE', [candidate.asset_id]);
      const row = (await client.query(`SELECT j.id FROM media.transform_job j
        JOIN media.asset a ON a.id = j.asset_id JOIN media.asset_state s ON s.id = a.state_head
        JOIN media.representation p ON p.id = j.source_id WHERE j.id = $1 AND j.status IN ('queued','leased')
          AND (s.lifecycle <> 'active' OR s.erasure_epoch <> j.erasure_epoch
            OR p.availability <> 'available' OR media.delivery_clearance(p) <> 'screening') FOR UPDATE OF j`, [candidate.id])).rows[0];
      if (!row) return;
      const operation = `media-screen:${row.id}`;
      const at = (await client.query(`UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton
        RETURNING data_epoch, sequence::text`)).rows[0]!;
      await client.query(`INSERT INTO content.receipt (operation_id, request_digest, action, outcome, reason, data_epoch, sequence)
        VALUES ($1,$2,'media.screen.settle','rejected','input-unavailable',$3,$4)`,
      [operation, hash(operation), at.data_epoch, at.sequence]);
      await client.query(`INSERT INTO content.outbox (id, data_epoch, sequence, operation_id, event_type, recipe, payload)
        VALUES ($1,$2,$3,$4,'media.screen.cancelled','media-v1',$5)`,
      [randomUUID(), at.data_epoch, at.sequence, operation, { asset: candidate.asset_id }]);
      await client.query(`UPDATE media.transform_job SET status = 'cancelled', reason = 'input-unavailable',
        settle_operation_id = $2, settled_at = clock_timestamp() WHERE id = $1`, [row.id, operation]);
    });
  }

  /** Sixteen crashed attempts cannot strand an image in screening forever. */
  async holdExhausted(): Promise<void> {
    const row = (await this.pool.query(`SELECT j.* FROM media.transform_job j
      WHERE j.profile = $1 AND j.status = 'leased' AND j.attempt = 16
        AND j.lease_expires_at <= clock_timestamp() ORDER BY j.lease_expires_at, j.id LIMIT 1`,
    [SCREEN_POLICY.profile])).rows[0];
    if (row) await this.finish({ job: row.id, source: row.source_id, asset: row.asset_id,
      digest: row.input_digest, namespace: '', mediaType: '', epoch: String(row.erasure_epoch),
      token: row.lease_token, attempt: row.attempt }, screenUnavailable(), true);
  }
  private async finish(lease: ScreenLease, verdict: ScreenVerdict, exhausted: boolean): Promise<boolean> {
    return this.transaction(async client => {
      // Asset before job matches activation and erasure lock ordering.
      const current = (await client.query(`SELECT s.lifecycle, s.erasure_epoch FROM media.asset a
        JOIN media.asset_state s ON s.id = a.state_head WHERE a.id = $1 FOR SHARE OF a`, [lease.asset])).rows[0];
      if (!current || current.lifecycle !== 'active' || String(current.erasure_epoch) !== lease.epoch) return false;
      const job = (await client.query(`SELECT id FROM media.transform_job WHERE id = $1 AND source_id = $2
        AND lease_token = $3 AND status = 'leased' AND (($4 = false AND lease_expires_at > clock_timestamp())
          OR ($4 = true AND attempt = 16 AND lease_expires_at <= clock_timestamp()))
        FOR UPDATE`, [lease.job, lease.source, lease.token, exhausted])).rows[0];
      if (!job) return false;
      const operation = `media-screen:${lease.job}`;
      const at = (await client.query(`UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton
        RETURNING data_epoch, sequence::text`)).rows[0]!;
      await client.query(`INSERT INTO content.receipt (operation_id, request_digest, action, outcome, data_epoch, sequence)
        VALUES ($1,$2,'media.screen.settle','succeeded',$3,$4)`, [operation, hash(JSON.stringify(verdict)), at.data_epoch, at.sequence]);
      await client.query(`INSERT INTO content.outbox (id, data_epoch, sequence, operation_id, event_type, recipe, payload)
        VALUES ($1,$2,$3,$4,'media.screen.settled','media-v1',$5)`,
      [randomUUID(), at.data_epoch, at.sequence, operation, { asset: lease.asset, representation: lease.source, clearance: verdict.clearance }]);
      await client.query(`UPDATE media.transform_job SET status = $3, settle_operation_id = $2,
        reason = $4, settled_at = clock_timestamp() WHERE id = $1`,
      [lease.job, operation, exhausted ? 'failed' : 'succeeded', exhausted ? 'screen-unavailable' : null]);
      await client.query(`INSERT INTO media.screen_result (job_id, source_id, clearance, reason, evidence, operation_id)
        VALUES ($1,$2,$3,$4,$5,$6)`, [lease.job, lease.source, verdict.clearance, verdict.reason, verdict.evidence, operation]);
      return true;
    });
  }
  /** Internal capability for G-565 after its staff authority/decision commit.
   * One original CAS and one receipt; delivery slots resolve clearance on read.
   * A known-copy marker remains effective even if staff clears the classifier hold. */
  async reviewOriginal(source: string, expected: 'held' | 'cleared' | 'rejected', decision: string,
    clearance: 'cleared' | 'rejected'): Promise<'applied' | 'replayed' | 'stale'> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!uuid.test(source) || !uuid.test(decision) || !['held', 'cleared', 'rejected'].includes(expected)
      || !['cleared', 'rejected'].includes(clearance)) throw new Error('invalid staff clearance');
    return this.transaction(async client => {
      const operation = `media-review:${decision}`;
      const digest = hash(JSON.stringify({ source, expected, decision, clearance }));
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [operation]);
      const prior = (await client.query('SELECT request_digest FROM content.receipt WHERE operation_id = $1', [operation])).rows[0];
      if (prior) {
        if (prior.request_digest !== digest) throw new Error('staff decision binds another intent');
        return 'replayed';
      }
      const row = (await client.query(`SELECT p.clearance, a.id AS asset, a.state_head, s.* FROM media.asset a
        JOIN media.asset_state s ON s.id = a.state_head JOIN media.representation p ON p.asset_id = a.id
        WHERE p.id = $1 AND p.kind = 'original' AND p.availability = 'available' FOR UPDATE OF a, p`, [source])).rows[0];
      if (!row || row.lifecycle !== 'active' || row.clearance !== expected) return 'stale';
      const at = (await client.query(`UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton
        RETURNING data_epoch, sequence::text`)).rows[0]!;
      await client.query(`INSERT INTO content.receipt (operation_id, request_digest, action, outcome, data_epoch, sequence)
        VALUES ($1,$2,'media.screen.review','succeeded',$3,$4)`, [operation, digest, at.data_epoch, at.sequence]);
      await client.query(`INSERT INTO content.outbox (id, data_epoch, sequence, operation_id, event_type, recipe, payload)
        VALUES ($1,$2,$3,$4,'media.screen.reviewed','media-v1',$5)`,
      [randomUUID(), at.data_epoch, at.sequence, operation, { asset: row.asset, representation: source, clearance, decision }]);
      await client.query(`INSERT INTO media.clearance_decision (id, source_id, decision_id, clearance, operation_id)
        VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), source, decision, clearance, operation]);
      if (clearance === 'rejected' && row.moderation !== 'suppressed') {
        await client.query(`INSERT INTO media.asset_state (id, asset_id, predecessor, disclosure, moderation,
          lifecycle, erasure_epoch, actor, authority_epoch, operation_id, data_epoch, sequence)
          VALUES ($1,$2,$3,$4,'suppressed',$5,$6,$7,$8,$9,$10,$11)`,
        [randomUUID(), row.asset, row.state_head, row.disclosure, row.lifecycle, row.erasure_epoch,
          row.actor, row.authority_epoch, operation, at.data_epoch, at.sequence]);
      }
      return 'applied';
    });
  }

  /** Durable cross-owner retry queue: at most eight cases per tick, no byte copies. */
  async pendingReviews(): Promise<ScreenReview[]> {
    return (await this.pool.query(`SELECT j.id, j.asset_id, j.source_id, j.input_digest, r.clearance, r.reason, r.evidence
      FROM media.screen_review q JOIN media.screen_result r ON r.job_id = q.job_id
      JOIN media.transform_job j ON j.id = q.job_id
      WHERE q.case_id IS NULL AND q.retry_after <= clock_timestamp()
      ORDER BY q.retry_after, q.job_id LIMIT $1`, [SCREEN_LIMITS.reviewBatch])).rows.map(row => ({
      job: row.id, asset: row.asset_id, source: row.source_id, digest: row.input_digest,
      verdict: { clearance: row.clearance, reason: row.reason, evidence: row.evidence },
    }));
  }
  async reviewAttempt(job: string, caseId: string | null): Promise<void> {
    await this.pool.query(`UPDATE media.screen_review SET case_id = COALESCE(case_id, $2),
      retry_after = clock_timestamp() + interval '1 minute' WHERE job_id = $1 AND case_id IS NULL`, [job, caseId]);
  }
}
