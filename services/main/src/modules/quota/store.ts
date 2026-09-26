import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { OwnerRow } from '../commerce/owner-columns.ts';
import type { quotaColumns } from './schema.ts';

export class QuotaInvalid extends Error {}
export class QuotaDenied extends Error {}
/** The operation key already binds another reservation intent. */
export class QuotaKeyConflict extends Error {}
/** No open ledger has the requested capacity. */
export class QuotaExhausted extends Error {}
/** The lease expired or the reservation is already in another terminal state. */
export class QuotaStale extends Error {}
export class QuotaUnavailable extends Error {}

/** Account scope and Access representation action for quota use. */
export const QUOTA_SCOPE = 'quota:reserve';
export const QUOTA_ACTION = 'quota.use';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const unitPattern = /^[a-z][a-z0-9.-]{0,62}$/;
const count = /^[1-9][0-9]{0,17}$/;
const MAX_LEDGERS = 16;

export interface ReservationTarget {
  realm: string; unit: string; beneficiary: string; operationId: string; stage: number;
}
export type ReservationCommand = ReservationTarget & ({ action: 'reserve'; amount: string }
  | { action: 'renew' } | { action: 'defer' } | { action: 'release' }
  | { action: 'consume' | 'settle'; consumed: string; ackReference?: string });

export interface ReservationView {
  reservationId: string; realm: string; unit: string; beneficiary: string; operationId: string;
  stage: number; policyRevision: string; ledger: { source: 'base' | 'entitlement'; entitlementId: string | null };
  amount: string; consumed: string; state: string; generation: string; expiresAt: string; replayed: boolean;
}

type Reservation = OwnerRow<typeof quotaColumns.reservation>;
type Policy = { id: string; head_revision: string; period: string; base_allowance: string;
  max_reservation: string; failure_policy: 'release' | 'retain' };

/**
 * Quota owner: one bounded reservation per (policy, operation, stage). The
 * ledger row lock plus its capacity CHECK decide final-capacity races; the
 * reservation trigger moves ledger totals, so settle/release/expire release
 * exactly the unconsumed remainder once. Gift and purchase entitlements fund
 * separate ledgers, spent after the base allowance in that order.
 */
export class QuotaStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const fence = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (fence.rows[0]?.open !== true) throw new QuotaUnavailable('Access recovery is held');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      if (error && typeof error === 'object' && 'code' in error) {
        const code = String(error.code);
        if (['40001', '40P01', '55P03', '57014'].includes(code)) {
          throw new QuotaUnavailable('quota owner could not complete');
        }
        // The ledger CHECK is the backstop for a race the row lock already ordered.
        if (code === '23514' && 'constraint' in error && error.constraint === 'ledger_check2') {
          throw new QuotaExhausted('quota capacity is exhausted');
        }
      }
      throw error;
    } finally { client.release(); }
  }

  private validate(command: ReservationTarget): void {
    if (!nativeId.test(command.realm) || !unitPattern.test(command.unit)
      || !nativeId.test(command.beneficiary) || command.operationId.length < 1
      || command.operationId.length > 128 || command.operationId.includes('\0')
      || !Number.isInteger(command.stage) || command.stage < 0 || command.stage > 10000) {
      throw new QuotaInvalid('invalid quota target');
    }
  }

  /** Authorize the caller for the beneficiary and derive its private operation key. */
  private async authorize(client: PoolClient, principal: VerifiedPrincipal,
    target: ReservationTarget): Promise<{ operationKey: string; policy: Policy }> {
    const actor = await client.query<{ id: string }>(`SELECT p.id FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
        AND r.subject_id = $3 AND r.action = $4 AND r.active AND r.valid_until > clock_timestamp()
        AND s.active LIMIT 1 FOR SHARE OF p, r, s`,
    [principal.issuer, principal.subject, target.beneficiary, QUOTA_ACTION]);
    if (!actor.rows[0]) throw new QuotaDenied('caller does not represent the beneficiary');
    const policy = await client.query<Policy>(`SELECT p.id, p.head_revision, r.period, r.base_allowance,
        r.max_reservation, r.failure_policy
      FROM quota.policy p JOIN quota.policy_revision r ON r.policy_id = p.id AND r.revision = p.head_revision
      WHERE p.scope = $1 AND p.unit = $2 FOR SHARE OF p`, [target.realm, target.unit]);
    if (!policy.rows[0]) throw new QuotaInvalid('Realm has no policy for this unit');
    // Operation IDs are scoped to the calling principal, so another caller can neither
    // replay nor settle this reservation by guessing its operation ID.
    const operationKey = createHash('sha256')
      .update(`${actor.rows[0].id}\0${target.beneficiary}\0${target.operationId}`).digest('hex');
    return { operationKey, policy: policy.rows[0] };
  }

  private async view(client: PoolClient, target: ReservationTarget, row: Reservation,
    replayed: boolean): Promise<ReservationView> {
    const ledger = await client.query<{ source: 'base' | 'entitlement'; entitlement_id: string | null }>(
      'SELECT source, entitlement_id FROM quota.ledger WHERE id = $1', [row.ledger_id]);
    return { reservationId: row.id, realm: target.realm, unit: target.unit, beneficiary: target.beneficiary,
      operationId: target.operationId, stage: row.stage, policyRevision: row.policy_revision,
      ledger: { source: ledger.rows[0]!.source, entitlementId: ledger.rows[0]!.entitlement_id },
      amount: row.amount, consumed: row.consumed, state: row.state, generation: row.generation,
      expiresAt: row.expires_at.toISOString(), replayed };
  }

  /** Open this period's base and entitlement ledgers idempotently. */
  private async ensureLedgers(client: PoolClient, policy: Policy, realm: string, unit: string,
    beneficiary: string): Promise<void> {
    const period = policy.period === 'P1D' ? "date_trunc('day', clock_timestamp(), 'UTC')"
      : policy.period === 'P1M' ? "date_trunc('month', clock_timestamp(), 'UTC')" : "'epoch'::timestamptz";
    const end = policy.period === 'P1D' ? `${period} + interval '1 day'`
      : policy.period === 'P1M' ? `${period} + interval '1 month'` : 'NULL::timestamptz';
    if (BigInt(policy.base_allowance) > 0n) {
      await client.query(`INSERT INTO quota.ledger (id, policy_id, policy_revision, beneficiary, source,
          period_start, period_end, capacity)
        VALUES ($1, $2, $3, $4, 'base', ${period}, ${end}, $5)
        ON CONFLICT (policy_id, beneficiary, period_start) WHERE source = 'base' DO NOTHING`,
      [randomUUID(), policy.id, policy.head_revision, beneficiary, policy.base_allowance]);
    }
    const funded = await client.query<{ id: string; quota_amount: string }>(`
      SELECT e.id, b.quota_amount FROM commerce.entitlement e
      JOIN commerce.offering o ON o.id = e.offering_id
      JOIN commerce.plan_benefit b USING (offering_id, offering_revision, plan_key)
      WHERE e.beneficiary = $1 AND e.state = 'active' AND e.valid_from <= clock_timestamp()
        AND e.valid_until > clock_timestamp() AND o.seller = $2 AND b.quota_unit = $3
      ORDER BY e.id LIMIT ${MAX_LEDGERS}`, [beneficiary, realm, unit]);
    for (const row of funded.rows) {
      await client.query(`INSERT INTO quota.ledger (id, policy_id, policy_revision, beneficiary, source,
          entitlement_id, period_start, period_end, capacity)
        VALUES ($1, $2, $3, $4, 'entitlement', $5, ${period}, ${end}, $6)
        ON CONFLICT (policy_id, entitlement_id, period_start) WHERE source = 'entitlement' DO NOTHING`,
      [randomUUID(), policy.id, policy.head_revision, beneficiary, row.id, row.quota_amount]);
    }
  }

  private async find(client: PoolClient, policyId: string, operationKey: string,
    stage: number): Promise<Reservation | undefined> {
    return (await client.query<Reservation>(`SELECT * FROM quota.reservation
      WHERE policy_id = $1 AND operation_id = $2 AND stage = $3 FOR UPDATE`,
    [policyId, operationKey, stage])).rows[0];
  }

  private async move(client: PoolClient, row: Reservation, action: string, state: string,
    consumed: string, ackReference: string | null, renew: boolean): Promise<Reservation> {
    const next = (BigInt(row.generation) + 1n).toString();
    const updated = await client.query<Reservation>(`UPDATE quota.reservation r SET state = $2, consumed = $3,
        generation = $4, expires_at = CASE WHEN $5 THEN clock_timestamp() + v.reservation_ttl ELSE r.expires_at END
      FROM quota.policy_revision v WHERE r.id = $1 AND v.policy_id = r.policy_id AND v.revision = r.policy_revision
      RETURNING r.*`, [row.id, state, consumed, next, renew]);
    await client.query(`INSERT INTO quota.reservation_event (reservation_id, generation, action, state, consumed,
      expires_at, ack_reference) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [row.id, next, action, state, consumed, updated.rows[0]!.expires_at, ackReference]);
    return updated.rows[0]!;
  }

  /** Reserve, renew, consume, settle, release (compensate) or defer one stage. */
  async apply(principal: VerifiedPrincipal, command: ReservationCommand,
    requestDigest: string): Promise<ReservationView> {
    this.validate(command);
    if (!/^[0-9a-f]{64}$/.test(requestDigest)
      || (command.action === 'reserve' && !count.test(command.amount))
      || ((command.action === 'consume' || command.action === 'settle')
        && (!/^(0|[1-9][0-9]{0,17})$/.test(command.consumed)
          || (command.ackReference !== undefined
            && (command.ackReference.length < 1 || command.ackReference.length > 200))))) {
      throw new QuotaInvalid('invalid quota command');
    }
    const outcome = await this.transaction(async (client): Promise<ReservationView | { lapsed: ReservationView }> => {
      const { operationKey, policy } = await this.authorize(client, principal, command);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`quota:${policy.id}:${operationKey}:${command.stage}`]);
      const existing = await this.find(client, policy.id, operationKey, command.stage);
      if (command.action === 'reserve') {
        if (existing) {
          if (existing.request_digest !== requestDigest) throw new QuotaKeyConflict('operation binds another reservation');
          return this.view(client, command, existing, true);
        }
        if (BigInt(command.amount) > BigInt(policy.max_reservation)) {
          throw new QuotaInvalid('reservation exceeds the policy maximum');
        }
        await this.ensureLedgers(client, policy, command.realm, command.unit, command.beneficiary);
        // Lock every candidate in id order, then take the first that fits:
        // base, then gift, then purchase capacity.
        const ledgers = await client.query<{ id: string; source: string; grant_source: string | null;
          free: string }>(`SELECT l.id, l.source, e.source AS grant_source,
            (l.capacity - l.reserved - l.consumed)::text AS free
          FROM quota.ledger l LEFT JOIN commerce.entitlement e ON e.id = l.entitlement_id
          WHERE l.policy_id = $1 AND l.beneficiary = $2 AND l.open
            AND l.period_start <= clock_timestamp() AND (l.period_end IS NULL OR l.period_end > clock_timestamp())
            AND (l.entitlement_id IS NULL OR (e.state = 'active' AND e.valid_until > clock_timestamp()))
          ORDER BY l.id LIMIT ${MAX_LEDGERS} FOR UPDATE OF l`, [policy.id, command.beneficiary]);
        const rank = (row: { source: string; grant_source: string | null }) =>
          row.source === 'base' ? 0 : row.grant_source === 'gift' ? 1 : 2;
        const chosen = [...ledgers.rows].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
          .find(row => BigInt(row.free) >= BigInt(command.amount));
        if (!chosen) throw new QuotaExhausted('quota capacity is exhausted');
        const id = randomUUID();
        const inserted = await client.query<Reservation>(`INSERT INTO quota.reservation (id, ledger_id, policy_id,
            policy_revision, operation_id, stage, request_digest, amount, state, generation, expires_at)
          SELECT $1, l.id, l.policy_id, l.policy_revision, $3, $4, $5, $6, 'reserved', 1,
            clock_timestamp() + v.reservation_ttl
          FROM quota.ledger l JOIN quota.policy_revision v
            ON v.policy_id = l.policy_id AND v.revision = l.policy_revision
          WHERE l.id = $2 RETURNING *`,
        [id, chosen.id, operationKey, command.stage, requestDigest, command.amount]);
        await client.query(`INSERT INTO quota.reservation_event (reservation_id, generation, action, state,
          consumed, expires_at) VALUES ($1, 1, 'reserve', 'reserved', 0, $2)`, [id, inserted.rows[0]!.expires_at]);
        return this.view(client, command, inserted.rows[0]!, false);
      }
      if (!existing) throw new QuotaInvalid('reservation is unknown');
      const ack = 'ackReference' in command ? command.ackReference ?? null : null;
      if (ack) {
        const seen = await client.query('SELECT 1 FROM quota.reservation_event WHERE reservation_id = $1 AND ack_reference = $2',
          [existing.id, ack]);
        if (seen.rowCount) return this.view(client, command, existing, true);
      }
      const terminal = ['settled', 'released', 'expired'].includes(existing.state);
      const finalConsumed = command.action === 'settle' ? command.consumed
        : command.action === 'release' && policy.failure_policy === 'retain' ? existing.amount : existing.consumed;
      const target = command.action === 'settle' ? 'settled' : command.action === 'release' ? 'released' : null;
      if (terminal) {
        // Idempotent repeat of the same terminal outcome; anything else conflicts.
        if (target === existing.state && finalConsumed === existing.consumed) {
          return this.view(client, command, existing, true);
        }
        throw new QuotaStale(`reservation is already ${existing.state}`);
      }
      const lapsed = await client.query<{ lapsed: boolean }>(
        'SELECT $1::timestamptz <= clock_timestamp() AS lapsed', [existing.expires_at]);
      if (existing.state === 'reserved' && lapsed.rows[0]!.lapsed) {
        // Commit the expiry (consumed usage stays), then report the stale lease.
        return { lapsed: await this.view(client, command,
          await this.move(client, existing, 'expire', 'expired', existing.consumed, null, false), false) };
      }
      switch (command.action) {
        case 'renew':
          if (existing.state !== 'reserved') throw new QuotaStale('only a live lease renews');
          return this.view(client, command,
            await this.move(client, existing, 'renew', 'reserved', existing.consumed, null, true), false);
        case 'defer':
          if (existing.state !== 'reserved') throw new QuotaStale('reservation is already reconciling');
          return this.view(client, command,
            await this.move(client, existing, 'defer', 'reconciling', existing.consumed, null, false), false);
        case 'consume':
          if (existing.state !== 'reserved') throw new QuotaStale('only a live lease records usage');
          if (BigInt(command.consumed) < BigInt(existing.consumed) || BigInt(command.consumed) > BigInt(existing.amount)) {
            throw new QuotaInvalid('usage must stay within the reservation and never decrease');
          }
          return this.view(client, command,
            await this.move(client, existing, 'consume', 'reserved', command.consumed, ack, false), false);
        case 'settle':
          if (BigInt(command.consumed) < BigInt(existing.consumed) || BigInt(command.consumed) > BigInt(existing.amount)) {
            throw new QuotaInvalid('usage must stay within the reservation and never decrease');
          }
          return this.view(client, command,
            await this.move(client, existing, 'settle', 'settled', command.consumed, ack, false), false);
        default:
          return this.view(client, command,
            await this.move(client, existing, 'release', 'released', finalConsumed, null, false), false);
      }
    });
    if ('lapsed' in outcome) throw new QuotaStale('reservation lease expired');
    return outcome;
  }

  async read(principal: VerifiedPrincipal, target: ReservationTarget): Promise<ReservationView> {
    this.validate(target);
    return this.transaction(async client => {
      const { operationKey, policy } = await this.authorize(client, principal, target);
      const row = (await client.query<Reservation>(`SELECT * FROM quota.reservation
        WHERE policy_id = $1 AND operation_id = $2 AND stage = $3`, [policy.id, operationKey, target.stage])).rows[0];
      if (!row) throw new QuotaInvalid('reservation is unknown');
      return this.view(client, target, row, false);
    });
  }

  /** Expire at most `limit` lapsed leases; consumed usage stays accounted. */
  async expireDue(limit = 100): Promise<number> {
    return this.transaction(async client => {
      const due = await client.query<Reservation>(`SELECT * FROM quota.reservation
        WHERE state = 'reserved' AND expires_at <= clock_timestamp()
        ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`, [Math.min(Math.max(limit, 1), 1000)]);
      for (const row of due.rows) await this.move(client, row, 'expire', 'expired', row.consumed, null, false);
      return due.rows.length;
    });
  }
}
