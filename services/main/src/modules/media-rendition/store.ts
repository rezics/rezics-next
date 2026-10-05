import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { advanceContentSequence } from '../content-sequence.ts';
import { MediaInvalid, MediaMissing } from '../media/store.ts';
import {
  checkSize,
  parseProfile,
  pixelCrop,
  renditionProfiles,
  RENDITION_LIMITS,
  type ImageSize,
  type RenditionCandidate,
  type RenditionOutput,
} from './policy.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROFILE = '^image-width-[1-9][0-9]{0,3}-(avif|webp)-v1$';
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export interface RenditionBasis {
  use: string;
  asset: string;
  source: string;
  digest: string;
  namespace: string;
  mediaType: string;
  crop: string | null;
  epoch: string;
  authorityEpoch: string;
}
export interface RenditionLease extends Omit<RenditionBasis, 'use'> {
  job: string;
  token: string;
  profile: string;
  attempt: number;
}
interface BasisRow {
  use: string;
  asset: string;
  source: string;
  digest: string;
  namespace: string;
  media_type: string;
  crop: string | null;
  epoch: string;
  authority_epoch: string;
}
const basis = (row: BasisRow): RenditionBasis => ({
  use: row.use,
  asset: row.asset,
  source: row.source,
  digest: row.digest,
  namespace: row.namespace,
  mediaType: row.media_type,
  crop: row.crop,
  epoch: row.epoch,
  authorityEpoch: row.authority_epoch,
});

const USE_BASIS_SQL = `SELECT u.id AS use,a.id AS asset,p.id AS source,p.byte_digest AS digest,
  a.object_namespace AS namespace,p.media_type,u.crop,s.erasure_epoch::text AS epoch,s.authority_epoch
  FROM media.use u JOIN media.asset a ON a.id = u.asset_id
  JOIN media.asset_state s ON s.id = a.state_head
  JOIN media.representation p ON p.id = u.representation_id AND p.kind = 'original'
  JOIN content.revision revision ON revision.id = u.asset_revision_id AND revision.availability = 'available'
  WHERE u.id = $1 AND s.lifecycle = 'active' AND s.moderation = 'none'
    AND p.availability = 'available' AND media.delivery_clearance(p) = 'cleared'`;

/** One SQL round trip, at most 64 exact Use probes and twelve candidates per
 * Use. Lateral source/profile/crop index probes avoid inventory scans and N+1
 * calls. O(B log M + B*C log R), with fixed C <= 12; O(B*C) output. The caller
 * must already have resolved target disclosure/Access for these Uses. */
export const RENDITION_CANDIDATES_SQL = `SELECT u.id AS use,p.id,p.pixel_width,p.pixel_height,p.media_type
  FROM media.use u JOIN media.asset a ON a.id = u.asset_id
  JOIN media.asset_state s ON s.id = a.state_head
  JOIN content.revision revision ON revision.id = u.asset_revision_id AND revision.availability = 'available'
  JOIN media.representation source ON source.id = u.representation_id AND source.kind = 'original'
  CROSS JOIN LATERAL (
    SELECT r.id,r.pixel_width,r.pixel_height,r.media_type FROM media.representation r
    WHERE r.source_id = source.id AND COALESCE(r.crop,'') = COALESCE(u.crop,'')
      AND r.kind = 'rendition' AND r.availability = 'available'
      AND r.profile ~ '${PROFILE}' AND r.media_type IN ('image/avif','image/webp')
    ORDER BY r.pixel_width,r.media_type,r.id LIMIT ${RENDITION_LIMITS.candidates}
  ) p
  WHERE u.id = ANY($1::uuid[]) AND s.lifecycle = 'active' AND s.moderation = 'none'
    AND source.availability = 'available' AND media.delivery_clearance(source) = 'cleared'
  ORDER BY u.id,p.pixel_width,p.media_type`;

export class MediaRenditionStore {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(
        "BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'",
      );
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Internal owner lookup; this method confers no reader or editor authority. */
  async requestBasis(use: string): Promise<RenditionBasis> {
    if (!UUID.test(use)) throw new MediaInvalid('invalid rendition Use');
    const row = (await this.pool.query<BasisRow>(USE_BASIS_SQL, [use])).rows[0];
    if (!row) throw new MediaMissing('rendition source is unavailable');
    return basis(row);
  }

  /** Exact digest-bound oriented dimensions come from the bounded inspector.
   * One source/crop lock, one prior-job batch and <= 12 fixed inserts; repeats,
   * including concurrent requests for another equivalent Use, create no jobs. */
  async queue(inspected: RenditionBasis, size: ImageSize): Promise<number> {
    const profiles = renditionProfiles(pixelCrop(inspected.crop, size).width);
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        JSON.stringify(['media-rendition', inspected.source, inspected.crop]),
      ]);
      const row = (
        await client.query<BasisRow>(`${USE_BASIS_SQL} FOR SHARE OF a,p`, [inspected.use])
      ).rows[0];
      if (
        !row ||
        row.source !== inspected.source ||
        row.digest !== inspected.digest ||
        row.epoch !== inspected.epoch ||
        row.crop !== inspected.crop
      )
        throw new MediaMissing('rendition source changed');
      const existing = new Set(
        (
          await client.query<{ profile: string }>(
            `SELECT profile FROM media.transform_job
        WHERE source_id = $1 AND profile = ANY($2::text[]) AND COALESCE(crop,'') = COALESCE($3,'')`,
            [row.source, profiles, row.crop],
          )
        ).rows.map((job) => job.profile),
      );
      let queued = 0;
      for (const profile of profiles) {
        if (existing.has(profile)) continue;
        const job = randomUUID();
        const operationId = `media-rendition-request:${sha(JSON.stringify([row.source, profile, row.crop]))}`;
        await advanceContentSequence(client, {
          operationId,
          requestDigest: sha(operationId),
          action: 'media.transform.request',
          outcome: 'succeeded',
          eventType: 'media.transform.requested',
          recipe: 'media-v1',
          payload: { asset: row.asset, job },
        });
        await client.query(
          `INSERT INTO media.transform_job (id,asset_id,source_id,input_digest,profile,crop,
          authority_epoch,erasure_epoch,operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            job,
            row.asset,
            row.source,
            row.digest,
            profile,
            row.crop,
            row.authority_epoch,
            row.epoch,
            operationId,
          ],
        );
        queued++;
      }
      return queued;
    });
  }

  /** Two indexed ready-queue heads (queued and expired), one job per tick.
   * Obsolete/exhausted heads retire here rather than a scan over healthy jobs. */
  async leaseNext(leaseMs: number = RENDITION_LIMITS.leaseMs): Promise<RenditionLease | null> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > RENDITION_LIMITS.leaseMs)
      throw new MediaInvalid('invalid rendition lease');
    return this.transaction(async (client) => {
      const job = (
        await client.query(`SELECT j.* FROM media.transform_job j JOIN (
        (SELECT id FROM media.transform_job WHERE profile ~ '${PROFILE}' AND status = 'queued'
          ORDER BY created_at,id LIMIT 1)
        UNION ALL
        (SELECT id FROM media.transform_job WHERE profile ~ '${PROFILE}' AND status = 'leased'
          AND lease_expires_at <= clock_timestamp() ORDER BY lease_expires_at,id LIMIT 1)
        ) ready ON ready.id = j.id WHERE j.status = 'queued' OR (j.status = 'leased'
          AND j.lease_expires_at <= clock_timestamp()) ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`)
      ).rows[0];
      if (!job || !['queued', 'leased'].includes(job.status)) return null;
      const source = (
        await client.query(
          `SELECT a.object_namespace,p.media_type FROM media.asset a
        JOIN media.asset_state s ON s.id = a.state_head JOIN media.representation p ON p.id = $2
        WHERE a.id = $1 AND s.lifecycle = 'active' AND s.moderation = 'none' AND s.erasure_epoch = $3
          AND p.asset_id = a.id AND p.kind = 'original' AND p.availability = 'available'
          AND p.byte_digest = $4 AND media.delivery_clearance(p) = 'cleared'`,
          [job.asset_id, job.source_id, job.erasure_epoch, job.input_digest],
        )
      ).rows[0];
      if (!source || job.attempt >= RENDITION_LIMITS.attempts) {
        await this.terminal(
          client,
          job.id,
          job.asset_id,
          source ? 'failed' : 'cancelled',
          source ? 'attempts-exhausted' : 'input-unavailable',
        );
        return null;
      }
      const token = randomUUID();
      const leased = await client.query(
        `UPDATE media.transform_job SET status = 'leased',attempt = attempt + 1,
        lease_token = $2,lease_expires_at = clock_timestamp() + $3 * interval '1 millisecond'
        WHERE id = $1 AND (status = 'queued' OR lease_expires_at <= clock_timestamp()) RETURNING id`,
        [job.id, token, leaseMs],
      );
      if (!leased.rowCount) return null;
      return {
        job: job.id,
        asset: job.asset_id,
        source: job.source_id,
        digest: job.input_digest,
        namespace: source.object_namespace,
        mediaType: source.media_type,
        crop: job.crop,
        epoch: String(job.erasure_epoch),
        authorityEpoch: job.authority_epoch,
        profile: job.profile,
        token,
        attempt: job.attempt + 1,
      };
    });
  }

  private async terminal(
    client: PoolClient,
    job: string,
    asset: string,
    status: 'failed' | 'cancelled' | 'succeeded',
    reason?: string,
  ): Promise<string> {
    const operationId = `media-rendition-settle:${job}`;
    await advanceContentSequence(client, {
      operationId,
      requestDigest: sha(JSON.stringify([job, status, reason ?? null])),
      action: 'media.transform.settle',
      outcome: status === 'succeeded' ? 'succeeded' : 'rejected',
      reason,
      eventType: `media.transform.${status}`,
      recipe: 'media-v1',
      payload: { asset, job },
    });
    await client.query(
      `UPDATE media.transform_job SET status = $2,reason = $3,settle_operation_id = $4,
      settled_at = clock_timestamp() WHERE id = $1`,
      [job, status, reason ?? null, operationId],
    );
    return operationId;
  }

  /** Asset -> source -> job lock order fences erasure/availability and the token.
   * Persist under that asset fence: an erasure sweep cannot finish and then have
   * a late transform recreate bytes in the erased namespace. No stale put occurs.
   * One object, one receipt/outbox/job and one representation; no Use fan-out. */
  async settle(
    lease: RenditionLease,
    output: RenditionOutput,
    persist: () => Promise<string>,
  ): Promise<boolean> {
    checkSize(output);
    const profile = parseProfile(lease.profile);
    if (
      !output.bytes.length ||
      output.bytes.length > RENDITION_LIMITS.bytes ||
      output.type !== profile.type ||
      output.width > profile.width
    )
      throw new MediaInvalid('invalid rendition output');
    return this.transaction(async (client) => {
      const current = (
        await client.query(
          `SELECT p.id FROM media.asset a
        JOIN media.asset_state s ON s.id = a.state_head JOIN media.representation p ON p.id = $2
        WHERE a.id = $1 AND s.lifecycle = 'active' AND s.moderation = 'none' AND s.erasure_epoch = $3
          AND p.asset_id = a.id AND p.availability = 'available' AND p.byte_digest = $4
          AND media.delivery_clearance(p) = 'cleared' FOR SHARE OF a,p`,
          [lease.asset, lease.source, lease.epoch, lease.digest],
        )
      ).rows[0];
      if (!current) return false;
      const held = (
        await client.query(
          `SELECT id FROM media.transform_job WHERE id = $1 AND source_id = $2
        AND lease_token = $3 AND status = 'leased' AND lease_expires_at > clock_timestamp() FOR UPDATE`,
          [lease.job, lease.source, lease.token],
        )
      ).rows[0];
      if (!held) return false;
      const digest = await persist();
      if (digest !== sha(output.bytes)) throw new MediaInvalid('rendition object digest differs');
      // Object read-back can consume a lease. A late writer leaves no deliverable
      // representation; retry can reuse immutable bytes under the same asset.
      if (
        !(
          await client.query(
            `SELECT id FROM media.transform_job WHERE id = $1
        AND lease_expires_at > clock_timestamp()`,
            [lease.job],
          )
        ).rowCount
      )
        return false;
      const operationId = await this.terminal(client, lease.job, lease.asset, 'succeeded');
      await client.query(
        `INSERT INTO media.representation (id,asset_id,kind,source_id,transform_job_id,
        profile,crop,byte_digest,byte_length,media_type,pixel_width,pixel_height,operation_id)
        VALUES ($1,$2,'rendition',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          lease.asset,
          lease.source,
          lease.job,
          lease.profile,
          lease.crop,
          digest,
          output.bytes.length,
          output.type,
          output.width,
          output.height,
          operationId,
        ],
      );
      return true;
    });
  }

  async candidatesBatch(uses: readonly string[]): Promise<Map<string, RenditionCandidate[]>> {
    if (uses.length > RENDITION_LIMITS.batch || uses.some((use) => !UUID.test(use)))
      throw new MediaInvalid('invalid rendition batch');
    const result = new Map<string, RenditionCandidate[]>(uses.map((use) => [use, []]));
    if (!uses.length) return result;
    const rows = (
      await this.pool.query<{
        use: string;
        id: string;
        pixel_width: number;
        pixel_height: number;
        media_type: RenditionCandidate['type'];
      }>(RENDITION_CANDIDATES_SQL, [[...new Set(uses)]])
    ).rows;
    for (const row of rows)
      result
        .get(row.use)!
        .push({
          url: `/v1/media/representations/${row.id}/bytes?use=${row.use}`,
          width: row.pixel_width,
          height: row.pixel_height,
          type: row.media_type,
        });
    return result;
  }
}
