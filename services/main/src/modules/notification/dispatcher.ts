import { randomUUID } from 'node:crypto';
import { discloseNotifications } from '../disclosure/notifications.ts';
import type { Pool, PoolClient } from 'pg';
import { NotificationConflict, NotificationInvalid, NotificationStore, NotificationUnavailable, normalizeNotificationError,
  requireAccessOpen, rollback, sha256,
  optionalNotification, type ProposalSubscriptionReason,
} from './store.ts';

/** Only currently disclosed fields; never a stored copy of the subject. */
export type RenderedSubject = { fields: Readonly<Record<string, string>>; private: boolean };
export type SubjectResolution =
  | { status: 'available'; subject: RenderedSubject }
  | { status: 'undisclosed' | 'erased' | 'unavailable' };

/** Owner-specific read of the exact subject for one recipient at delivery time. */
export interface NotificationSubjectReader {
  resolve(input: { principalId: string; owner: string; ref: string; revision: string | null;
    disclosureBasis: string; realm?: string | null;
    /** Durable recipient provenance; omitted when merely managing a subscription. */
    recipientReason?: ProposalSubscriptionReason | null }): Promise<SubjectResolution>;
}

export interface ProviderSend {
  /** Stable across retries; the provider must treat it as its idempotency key. */
  deliveryId: string; channel: 'email' | 'push'; address: string | null; addressDigest: string;
  payload: Readonly<Record<string, string>>;
}
export type ProviderResult =
  | { status: 'accepted'; messageId: string }
  | { status: 'rejected'; permanent: boolean; code: string };
export type ProviderLookup = { status: 'accepted' | 'delivered'; messageId: string }
  | { status: 'failed'; code: string } | { status: 'not_found' };

/** External channel adapter. A thrown error or timeout is an unknown outcome, never a failure. */
export interface DeliveryProvider {
  readonly name: string;
  send(request: ProviderSend): Promise<ProviderResult>;
  lookup(deliveryId: string): Promise<ProviderLookup>;
}

export interface ProviderEvent {
  eventId: string; deliveryId: string | null;
  kind: 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed';
  payloadDigest: string;
}

export interface DispatchSummary { claimed: number; delivered: number; uncertain: number; retried: number;
  failed: number; cancelled: number; reconciled: number }

interface Claimed {
  id: string; item_id: string; principal_id: string; endpoint_id: string; channel: 'email' | 'push';
  endpoint_generation: string; attempt_count: number; lease_token: string; was_uncertain: boolean;
}

export const DISPATCH_LIMITS = { batch: 32, attempts: 8, leaseMs: 60_000, retryMs: 30_000 } as const;

/**
 * Bounded worker for committed notification deliveries. Each run leases at
 * most `batch` due rows (SKIP LOCKED), rechecks recipient, preference, endpoint
 * and disclosure in the claiming transaction, calls the provider outside any
 * transaction, and finishes under the lease token.
 */
export class NotificationDispatcher {
  private readonly retryMs: number;
  private readonly scopedSubjects = new Map<string, NotificationSubjectReader>();

  constructor(private readonly pool: Pool, private readonly provider: DeliveryProvider,
    private readonly subjects: NotificationSubjectReader, options: { retryMs?: number } = {}) {
    this.retryMs = options.retryMs ?? DISPATCH_LIMITS.retryMs;
  }

  get providerName(): string { return this.provider.name; }

  /** Add an exact owner reader for one disclosure basis during process composition. */
  registerSubjectReader(disclosureBasis: string, reader: NotificationSubjectReader): void {
    if (!disclosureBasis || disclosureBasis.length > 128 || this.scopedSubjects.has(disclosureBasis)) {
      throw new Error('notification subject reader basis is invalid or already registered');
    }
    this.scopedSubjects.set(disclosureBasis, reader);
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch(() => {
      throw new NotificationUnavailable('notification owner is unavailable');
    });
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireAccessOpen(client);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollback(client);
      throw normalizeNotificationError(error);
    } finally { client.release(); }
  }

  private async cancel(client: PoolClient, id: string, reason: string): Promise<void> {
    await client.query(`UPDATE access.notification_delivery SET state = 'cancelled', cancel_reason = $2,
      next_attempt_at = NULL, lease_token = NULL, lease_until = NULL, terminal_at = clock_timestamp()
      WHERE id = $1 AND state IN ('pending', 'sending', 'uncertain')`, [id, reason]);
  }

  /** A lease that expired while sending may have reached the provider: it becomes uncertain. */
  async recoverExpiredLeases(limit: number = DISPATCH_LIMITS.batch): Promise<number> {
    return this.transaction(async client => (await client.query(`UPDATE access.notification_delivery d
      SET state = 'uncertain', lease_token = NULL, lease_until = NULL, next_attempt_at = clock_timestamp()
      FROM (SELECT id FROM access.notification_delivery WHERE state = 'sending' AND lease_until < clock_timestamp()
        ORDER BY lease_until, id LIMIT $1 FOR UPDATE SKIP LOCKED) due
      WHERE d.id = due.id`, [limit])).rowCount ?? 0);
  }

  async runOnce(limit: number = DISPATCH_LIMITS.batch): Promise<DispatchSummary> {
    if (!Number.isInteger(limit) || limit < 1 || limit > DISPATCH_LIMITS.batch) {
      throw new NotificationInvalid('dispatch batch is out of bounds');
    }
    const summary: DispatchSummary = { claimed: 0, delivered: 0, uncertain: 0, retried: 0, failed: 0,
      cancelled: 0, reconciled: 0 };
    const claimed = await this.transaction(async client => {
      const due = (await client.query<Omit<Claimed, 'lease_token' | 'was_uncertain'> & { state: string }>(
        `SELECT id, item_id, principal_id, endpoint_id, channel, endpoint_generation::text, attempt_count, state
         FROM access.notification_delivery
         WHERE state IN ('pending', 'uncertain') AND next_attempt_at <= clock_timestamp()
         ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
      const leased: Claimed[] = [];
      for (const row of due) {
        const reason = await this.ineligible(client, row);
        if (reason) { await this.cancel(client, row.id, reason); summary.cancelled++; continue; }
        const lease = randomUUID();
        await client.query(`UPDATE access.notification_delivery SET state = 'sending', lease_token = $2,
          lease_until = clock_timestamp() + ($3::bigint * interval '1 millisecond'), next_attempt_at = NULL
          WHERE id = $1`, [row.id, lease, DISPATCH_LIMITS.leaseMs]);
        leased.push({ ...row, lease_token: lease, was_uncertain: row.state === 'uncertain' });
      }
      return leased;
    });
    summary.claimed = claimed.length;
    for (const delivery of claimed) {
      const outcome = await this.deliver(delivery);
      summary[outcome]++;
    }
    return summary;
  }

  /** Current recipient, preference, endpoint and expiry eligibility; null when deliverable. */
  private async ineligible(client: PoolClient, row: { id: string; item_id: string; principal_id: string;
    endpoint_id: string; channel: string; endpoint_generation: string }): Promise<string | null> {
    const facts = (await client.query<{ principal_active: boolean; fenced: boolean; item_state: string;
      purpose: string; topic: string; endpoint_state: string; endpoint_generation: string; expired: boolean;
      disabled: boolean;
        muted: boolean;
      }>(
        `SELECT p.active AS principal_active,
        EXISTS (SELECT 1 FROM access.outbox o WHERE o.kind = 'account.deletion_fenced'
          AND o.principal_id = p.id) AS fenced,
        i.state AS item_state, i.purpose, i.topic, e.state AS endpoint_state,
        e.generation::text AS endpoint_generation, d.expires_at <= clock_timestamp() AS expired,
        EXISTS (SELECT 1 FROM access.notification_preference n WHERE n.principal_id = p.id
          AND n.purpose = i.purpose AND n.topic = i.topic AND n.channel = d.channel
          AND n.state = 'disabled') AS disabled,
        EXISTS (SELECT 1 FROM access.proposal_subscription sub WHERE sub.principal_id = p.id
          AND sub.proposal = pc.proposal AND sub.level = 'ignore'
          AND i.disclosure_basis = 'editorial-proposal-v1') AS muted
      FROM access.notification_delivery d
      JOIN access.notification_item i ON i.id = d.item_id
      LEFT JOIN access.notification_proposal_context pc ON pc.item_id = i.id
      JOIN access.principal p ON p.id = d.principal_id
      JOIN access.notification_endpoint e ON e.id = d.endpoint_id
      WHERE d.id = $1`, [row.id])).rows[0];
    if (!facts) return 'ineligible';
    if (facts.fenced) return 'recipient_erased';
    if (!facts.principal_active) return 'ineligible';
    if (facts.item_state === 'erased') return 'subject_erased';
    if (facts.item_state !== 'active') return 'undisclosed';
    if (facts.expired) return 'expired';
    if (facts.endpoint_state !== 'active' || facts.endpoint_generation !== row.endpoint_generation) {
      return 'endpoint_invalid';
    }
    if (facts.disabled && optionalNotification(facts.purpose, facts.topic)) return 'unsubscribed';
    if (facts.muted) return 'unsubscribed';
    return null;
  }

  private async deliver(row: Claimed): Promise<keyof DispatchSummary> {
    // An uncertain earlier attempt is reconciled by its stable id before any resend.
    if (row.was_uncertain) {
      let lookup: ProviderLookup | null = null;
      try { lookup = await this.provider.lookup(row.id); } catch { lookup = null; }
      if (lookup === null) return this.finish(row, null, { kind: 'uncertain' });
      if (lookup.status === 'accepted' || lookup.status === 'delivered') {
        await this.finish(row, null, { kind: 'delivered', messageId: lookup.messageId });
        return 'reconciled';
      }
      if (lookup.status === 'failed') {
        await this.finish(row, null, { kind: 'failed', code: lookup.code });
        return 'reconciled';
      }
    }
    const prepared = await this.prepare(row);
    if (prepared.kind === 'cancel') {
      await this.transaction(async client => {
        const held = await client.query('SELECT 1 FROM access.notification_delivery WHERE id = $1 AND lease_token = $2 FOR UPDATE',
          [row.id, row.lease_token]);
        if (held.rows[0]) {
          await this.cancel(client, row.id, prepared.reason);
          if (prepared.reason === 'subject_erased') {
            await client.query(`UPDATE access.notification_item SET state = 'erased',
              state_changed_at = clock_timestamp() WHERE id = $1 AND state <> 'erased'`, [row.item_id]);
          }
        }
      });
      return 'cancelled';
    }
    let result: ProviderResult | null;
    try {
      result = await this.provider.send({ deliveryId: row.id, channel: row.channel, address: prepared.address,
        addressDigest: prepared.addressDigest, payload: prepared.payload });
    } catch { result = null; }
    return this.finish(row, prepared, result === null ? { kind: 'uncertain' }
      : result.status === 'accepted' ? { kind: 'delivered', messageId: result.messageId }
        : result.permanent ? { kind: 'failed', code: result.code } : { kind: 'retry', code: result.code });
  }

  /** Render only fields currently disclosed to this recipient on this endpoint. */
  private async prepare(row: Claimed): Promise<{ kind: 'cancel'; reason: string } | { kind: 'send';
    address: string | null; addressDigest: string; payload: Record<string, string>; disclosureDigest: string }> {
    const context = (await this.pool.query<{ subject_owner: string; subject_ref: string;
      subject_revision: string | null; disclosure_basis: string; address: string | null; address_digest: string;
      lock_screen_disclosure: boolean; realm: string | null; reason: ProposalSubscriptionReason | null }>(`SELECT i.subject_owner, i.subject_ref, i.subject_revision,
        i.disclosure_basis, e.address, e.address_digest, e.lock_screen_disclosure, c.realm, pc.reason
      FROM access.notification_delivery d JOIN access.notification_item i ON i.id = d.item_id
      JOIN access.notification_endpoint e ON e.id = d.endpoint_id
      LEFT JOIN access.notification_display_context c ON c.item_id = i.id
      LEFT JOIN access.notification_proposal_context pc ON pc.item_id = i.id WHERE d.id = $1`, [row.id])).rows[0];
    if (!context) return { kind: 'cancel', reason: 'ineligible' };
    const subjectReader = this.scopedSubjects.get(context.disclosure_basis) ?? this.subjects;
    const input = { principalId: row.principal_id, owner: context.subject_owner,
      ref: context.subject_ref, revision: context.subject_revision, disclosureBasis: context.disclosure_basis,
      realm: context.realm, recipientReason: context.reason };
    const [resolved] = await discloseNotifications(this.pool,
      [{ input, result: await subjectReader.resolve(input) }], row.channel);
    if (!resolved) return { kind: 'cancel', reason: 'undisclosed' };
    if (resolved.status === 'erased') return { kind: 'cancel', reason: 'subject_erased' };
    if (resolved.status !== 'available') return { kind: 'cancel', reason: 'undisclosed' };
    // Push without lock-screen disclosure carries no private subject fields.
    const payload: Record<string, string> = row.channel === 'push' && resolved.subject.private
      && !context.lock_screen_disclosure ? { notice: 'new-activity' } : { ...resolved.subject.fields };
    return { kind: 'send', address: context.address, addressDigest: context.address_digest, payload,
      disclosureDigest: sha256(JSON.stringify(Object.entries(payload).sort())) };
  }

  private async finish(row: Claimed, prepared: { addressDigest: string; disclosureDigest: string } | null,
    outcome: { kind: 'delivered'; messageId: string } | { kind: 'failed' | 'retry'; code: string }
      | { kind: 'uncertain' }): Promise<keyof DispatchSummary> {
    return this.transaction(async client => {
      const held = (await client.query<{ attempt_count: number }>(`SELECT attempt_count
        FROM access.notification_delivery WHERE id = $1 AND lease_token = $2 AND state = 'sending' FOR UPDATE`,
      [row.id, row.lease_token])).rows[0];
      // A lost lease means a callback or reconciliation already decided this row.
      if (!held) return 'reconciled';
      const attempt = held.attempt_count + (prepared ? 1 : 0);
      if (prepared) {
        const recorded = outcome.kind === 'delivered' ? 'accepted' : outcome.kind === 'failed'
          ? 'rejected_permanent' : outcome.kind === 'retry' ? 'rejected_transient' : 'uncertain';
        await client.query(`INSERT INTO access.notification_attempt (delivery_id, attempt, lease_token,
          address_digest, disclosure_digest, outcome, provider_status, provider_message_id, finished_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())`,
        [row.id, attempt, row.lease_token, prepared.addressDigest, prepared.disclosureDigest, recorded,
          'code' in outcome ? outcome.code : null, 'messageId' in outcome ? outcome.messageId : null]);
      }
      if (outcome.kind === 'delivered') {
        await client.query(`UPDATE access.notification_delivery SET state = 'delivered', attempt_count = $2,
          provider_message_id = $3, lease_token = NULL, lease_until = NULL, terminal_at = clock_timestamp()
          WHERE id = $1`, [row.id, attempt, outcome.messageId]);
        return 'delivered';
      }
      if (outcome.kind === 'failed' || attempt >= DISPATCH_LIMITS.attempts) {
        await client.query(`UPDATE access.notification_delivery SET state = 'failed', attempt_count = $2,
          diagnostic = $3, lease_token = NULL, lease_until = NULL, terminal_at = clock_timestamp()
          WHERE id = $1`, [row.id, attempt, 'code' in outcome ? outcome.code.slice(0, 64) : 'attempts-exhausted']);
        return 'failed';
      }
      const state = outcome.kind === 'uncertain' ? 'uncertain' : 'pending';
      await client.query(`UPDATE access.notification_delivery SET state = $2, attempt_count = $3,
        lease_token = NULL, lease_until = NULL,
        next_attempt_at = clock_timestamp() + ($4::bigint * interval '1 millisecond')
        WHERE id = $1`, [row.id, state, attempt, this.retryMs]);
      return outcome.kind === 'uncertain' ? 'uncertain' : 'retried';
    });
  }

  /**
   * Provider callback or reconciliation evidence, deduplicated by provider
   * event id. A repeated or late event has no second effect and never reopens
   * a terminal delivery.
   */
  async recordProviderEvent(event: ProviderEvent): Promise<{ recorded: boolean; state: string | null }> {
    if (event.eventId.length < 1 || event.eventId.length > 256 || !/^[0-9a-f]{64}$/.test(event.payloadDigest)
      || (event.deliveryId !== null && !/^[0-9a-f-]{36}$/.test(event.deliveryId))) {
      throw new NotificationInvalid('provider event does not match its profile');
    }
    return this.transaction(async client => {
      const delivery = event.deliveryId === null ? null : (await client.query<{ id: string; state: string;
        endpoint_id: string }>(`SELECT id, state, endpoint_id FROM access.notification_delivery
        WHERE id = $1 FOR UPDATE`, [event.deliveryId])).rows[0] ?? null;
      const inserted = await client.query(`INSERT INTO access.notification_provider_event (provider,
        provider_event_id, delivery_id, source, kind, payload_digest) VALUES ($1, $2, $3, 'callback', $4, $5)
        ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      [this.provider.name, event.eventId, delivery?.id ?? null, event.kind, event.payloadDigest]);
      if (!inserted.rowCount) {
        const prior = (await client.query<{ kind: string; payload_digest: string }>(`SELECT kind, payload_digest
          FROM access.notification_provider_event WHERE provider = $1 AND provider_event_id = $2`,
        [this.provider.name, event.eventId])).rows[0]!;
        if (prior.kind !== event.kind || prior.payload_digest !== event.payloadDigest) {
          throw new NotificationConflict('provider event id reused with different content');
        }
        return { recorded: false, state: delivery?.state ?? null };
      }
      if (!delivery) return { recorded: true, state: null };
      const open = ['pending', 'sending', 'uncertain'].includes(delivery.state);
      if (open && event.kind === 'delivered') {
        await client.query(`UPDATE access.notification_delivery SET state = 'delivered', lease_token = NULL,
          lease_until = NULL, next_attempt_at = NULL, terminal_at = clock_timestamp() WHERE id = $1`, [delivery.id]);
        return { recorded: true, state: 'delivered' };
      }
      if (event.kind === 'bounced' || event.kind === 'complained' || event.kind === 'suppressed') {
        // The address is unusable for every later delivery; rotation creates a new generation.
        await client.query(`UPDATE access.notification_endpoint SET state = 'invalid', address = NULL,
          retired_at = clock_timestamp() WHERE id = $1 AND state = 'active'`, [delivery.endpoint_id]);
      }
      if (open && event.kind !== 'delivered') {
        await client.query(`UPDATE access.notification_delivery SET state = 'failed', lease_token = NULL,
          lease_until = NULL, next_attempt_at = NULL, diagnostic = $2, terminal_at = clock_timestamp()
          WHERE id = $1`, [delivery.id, `provider-${event.kind}`]);
        return { recorded: true, state: 'failed' };
      }
      return { recorded: true, state: delivery.state };
    });
  }

  /**
   * Restore reconciliation for recipients whose Account erasure intent is
   * retained outside Access backups (relay.account_deletion_intent). Open
   * deliveries are cancelled and items erased before any dispatch resumes.
   */
  async reconcileErasedRecipients(principalIds: readonly string[]): Promise<{ deliveries: number; items: number }> {
    return new NotificationStore(this.pool).reconcileErasedRecipients(principalIds);
  }

  /**
   * Replays the relay's retained Account erasure intents (kept outside Access
   * backups) onto notification state after an Access restore. Paged in
   * principal order; idempotent, so a repeated or interrupted run is safe.
   */
  async reconcileRetainedErasures(relay: Pool, page = 500): Promise<{ recipients: number; deliveries: number;
    items: number }> {
    return new NotificationStore(this.pool).reconcileRetainedErasures(relay, page);
  }
}
