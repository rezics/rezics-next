import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { AdmissionDenied } from '../access/admission.ts';

/** Equals migration 160's window CHECK. It exceeds the session's offer and
 * receipt deadlines plus a pause/skew margin, so a live session has settled or
 * stopped handing bytes to its socket before any process may sweep its row. */
export const PRIVATE_SEARCH_SEND_WINDOW_MS = 30_000;
export const PRIVATE_SEARCH_OFFER_MS = 5_000;
export const PRIVATE_SEARCH_RECEIPT_MS = 10_000;
/** A query sweeps at most this many abandoned rows before its own admission. */
export const PRIVATE_SEARCH_QUERY_SWEEP = 8;
const MAX_SWEEP = 1_000;

export type SessionSettlement = 'withheld' | 'unconfirmed';

export interface PrivateSearchSweep {
  /** Armed rows whose send window elapsed without a receipt or session settlement. */
  unconfirmed: string[];
  /** Begun rows that were never armed and can no longer arm after lease expiry. */
  aborted: string[];
}

/** Access-owned terminal transitions for private search deliveries after the
 * 010 send marker. A receipt still finishes through the admission registry. */
export class PrivateSearchSettlement {
  constructor(private readonly pool: Pool) {}

  /** The arming session proves its identity with the receipt challenge whose
   * digest Access stored at arm time. Returns the resulting terminal state, or
   * null when this challenge never armed the row. Recovery holds allow it. */
  async settle(leaseId: string, receiptToken: string,
    outcome: SessionSettlement): Promise<SessionSettlement | 'delivered' | null> {
    if (!/^[0-9a-f-]{36}$/.test(leaseId) || !/^[0-9a-f]{64}$/.test(receiptToken)
      || (outcome !== 'withheld' && outcome !== 'unconfirmed')) {
      throw new AdmissionDenied('invalid private search settlement');
    }
    const digest = createHash('sha256').update(receiptToken).digest('hex');
    const settled = await this.pool.query<{ state: SessionSettlement }>(
      `UPDATE access.search_read_lease
       SET state = $2, settled_by = 'session', finished_at = clock_timestamp()
       WHERE id = $1 AND state = 'delivering' AND send_started_at IS NOT NULL
         AND receipt_digest = $3
       RETURNING state`, [leaseId, outcome, digest]);
    if (settled.rows[0]) return settled.rows[0].state;
    const prior = (await this.pool.query<{ state: string; receipt_digest: string | null }>(
      'SELECT state, receipt_digest FROM access.search_read_lease WHERE id = $1',
      [leaseId])).rows[0];
    if (!prior || prior.receipt_digest !== digest) return null;
    if (prior.state === 'withheld' || prior.state === 'unconfirmed' || prior.state === 'delivered') {
      return prior.state;
    }
    return null;
  }

  /** Bounded recovery for deliveries whose Main process vanished. Both scans
   * use partial indexes and lock at most `limit` rows each, skipping rows an
   * arm, receipt or other sweep currently holds. */
  async sweep(limit = PRIVATE_SEARCH_QUERY_SWEEP): Promise<PrivateSearchSweep> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SWEEP) {
      throw new AdmissionDenied('invalid private search sweep limit');
    }
    const unconfirmed = await this.pool.query<{ id: string }>(
      `WITH elapsed AS (
         SELECT id FROM access.search_read_lease
         WHERE state = 'delivering' AND send_started_at IS NOT NULL
           AND send_started_at <= clock_timestamp() - interval '30 seconds'
         ORDER BY send_started_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE access.search_read_lease lease
       SET state = 'unconfirmed', settled_by = 'window', finished_at = clock_timestamp()
       FROM elapsed WHERE lease.id = elapsed.id
       RETURNING lease.id`, [limit]);
    // The 010 arm requires an unexpired lease, so an unarmed row past expiry
    // can never offer a frame; its abort is the ordinary pre-send outcome.
    const aborted = await this.pool.query<{ id: string }>(
      `WITH expired AS (
         SELECT id FROM access.search_read_lease
         WHERE state = 'delivering' AND send_started_at IS NULL
           AND expires_at <= clock_timestamp()
         ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE access.search_read_lease lease
       SET state = 'aborted', finished_at = clock_timestamp()
       FROM expired WHERE lease.id = expired.id
       RETURNING lease.id`, [limit]);
    return { unconfirmed: unconfirmed.rows.map(row => row.id),
      aborted: aborted.rows.map(row => row.id) };
  }
}
