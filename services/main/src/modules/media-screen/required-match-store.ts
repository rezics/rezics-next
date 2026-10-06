import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { advanceContentSequence, settledContentPosition } from '../content-sequence.ts';
import type { RequiredMatch } from './required-matcher.ts';

export const REQUIRED_MATCH_PROFILE = 'required-image-match-v1';
export const REQUIRED_MATCH_COST = {
  perTick: 1,
  ownerTransactions: 2,
  sourceBytes: 8 * 1024 * 1024,
  lookup:
    'ready/expired transform queue with profile filter and exact source/asset probes; work scales with ready jobs examined',
} as const;
export interface RequiredMatchLease {
  job: string;
  asset: string;
  source: string;
  digest: string;
  namespace: string;
  mediaType: string;
  token: string;
  epoch: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Reuses the durable exact-source queue and Content receipts. Outages leave
 * an expiring lease pending; they create neither NSFW evidence nor review holds. */
export class RequiredMediaMatchStore {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'");
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async leaseNext(leaseMs = 30_000, source?: string): Promise<RequiredMatchLease | null> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 30_000)
      throw new Error('invalid matcher lease');
    return this.transaction(async (client) => {
      const row = (
        await client.query(
          `SELECT j.*,a.object_namespace,p.media_type,s.erasure_epoch AS current_erasure_epoch FROM media.transform_job j
        JOIN media.asset a ON a.id=j.asset_id JOIN media.asset_state s ON s.id=a.state_head
        JOIN media.representation p ON p.id=j.source_id
        WHERE j.profile=$1 AND (j.status='queued' OR j.status='leased' AND j.lease_expires_at<=clock_timestamp())
          AND ($2::uuid IS NULL OR j.source_id=$2) AND s.lifecycle='active' AND s.moderation='none'
          AND p.availability='available'
        ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
          [REQUIRED_MATCH_PROFILE, source ?? null],
        )
      ).rows[0];
      if (!row) return null;
      let job = row.id as string;
      // Roll over exhaustion and restored input epochs without opening admission.
      // Exact-byte clearance survives restoration; an unfinished lease does not.
      if (row.attempt === 16 || String(row.erasure_epoch) !== String(row.current_erasure_epoch)) {
        const operation = `media-required-match-retry:${job}`;
        await advanceContentSequence(client, {
          operationId: operation,
          requestDigest: hash(operation),
          action: 'media.transform.request',
          outcome: 'succeeded',
          eventType: 'media.required-match.retry',
          recipe: 'media-v1',
          payload: { source: row.source_id },
        });
        await client.query(
          `UPDATE media.transform_job SET status='cancelled',reason='provider-unavailable',
          settle_operation_id=$2,settled_at=clock_timestamp() WHERE id=$1`,
          [job, operation],
        );
        job = randomUUID();
        await client.query(
          `INSERT INTO media.transform_job(id,asset_id,source_id,input_digest,profile,
          authority_epoch,erasure_epoch,operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            job,
            row.asset_id,
            row.source_id,
            row.input_digest,
            REQUIRED_MATCH_PROFILE,
            row.authority_epoch,
            row.current_erasure_epoch,
            operation,
          ],
        );
      }
      const token = randomUUID();
      await client.query(
        `UPDATE media.transform_job SET status='leased',attempt=attempt+1,
        lease_token=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1`,
        [job, token, leaseMs],
      );
      return {
        job,
        asset: row.asset_id,
        source: row.source_id,
        digest: row.input_digest,
        namespace: row.object_namespace,
        mediaType: row.media_type,
        token,
        epoch: String(row.current_erasure_epoch),
      };
    });
  }
  async settle(lease: RequiredMatchLease, result: RequiredMatch): Promise<boolean> {
    if (!['clear', 'blocked'].includes(result)) throw new Error('invalid required matcher result');
    const operation = `media-required-match:${lease.job}`;
    const settled = await this.transaction(async (client) => {
      const asset = (
        await client.query(
          `SELECT s.* FROM media.asset a JOIN media.asset_state s ON s.id=a.state_head
        WHERE a.id=$1 FOR SHARE OF a`,
          [lease.asset],
        )
      ).rows[0];
      if (
        !asset ||
        asset.lifecycle !== 'active' ||
        asset.moderation !== 'none' ||
        String(asset.erasure_epoch) !== lease.epoch
      )
        return false;
      const job = (
        await client.query(
          `SELECT j.id FROM media.transform_job j JOIN media.representation p ON p.id=j.source_id
        WHERE j.id=$1 AND j.source_id=$2 AND j.input_digest=$3 AND j.lease_token=$4 AND j.status='leased'
          AND j.lease_expires_at>clock_timestamp() AND p.availability='available' FOR UPDATE OF j`,
          [lease.job, lease.source, lease.digest, lease.token],
        )
      ).rows[0];
      if (!job) return false;
      await advanceContentSequence(client, {
        operationId: operation,
        requestDigest: hash(`${lease.digest}\0${result}`),
        action: 'media.transform.settle',
        outcome: 'succeeded',
        eventType: 'media.required-match.settled',
        recipe: 'media-v1',
        payload: { asset: lease.asset, source: lease.source, result },
      });
      await client.query(
        `UPDATE media.transform_job SET status=$2,reason=$3,
        settle_operation_id=$4,settled_at=clock_timestamp() WHERE id=$1`,
        [
          lease.job,
          result === 'clear' ? 'succeeded' : 'failed',
          result === 'clear' ? null : 'required-matcher-blocked',
          operation,
        ],
      );
      return true;
    });
    if (settled) await settledContentPosition(this.pool, operation);
    return settled;
  }
}
