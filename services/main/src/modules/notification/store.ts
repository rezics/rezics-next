import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { deliveryChannels, notificationPurposes, optionalPurposes, preferenceChannels } from './schema.ts';

export class NotificationInvalid extends Error {}
export class NotificationDenied extends Error {}
export class NotificationConflict extends Error {}
export class NotificationStale extends Error {}
export class NotificationUnavailable extends Error {}

export type NotificationPurpose = typeof notificationPurposes[number];
export type OptionalPurpose = typeof optionalPurposes[number];
export type PreferenceChannel = typeof preferenceChannels[number];
export type DeliveryChannel = typeof deliveryChannels[number];

/** Fixed bounds of the first notification profile; every operation is O(bound). */
export const NOTIFICATION_LIMITS = {
  recipientsPerEvent: 256,
  endpointsPerRecipient: 8,
  streamPage: 50,
  deliveryTtlMs: 86_400_000,
} as const;

const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
const topicPattern = /^[a-z][a-z0-9_.-]{0,63}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface NotificationEvent {
  sourceOwner: 'graph' | 'content' | 'access' | 'account';
  sourceEvent: string;
  purpose: NotificationPurpose;
  topic: string;
  subject: { owner: 'graph' | 'content' | 'source' | 'media' | 'access'; ref: string; revision: string | null };
  disclosureBasis: string;
  /** Access principal ids already resolved by the producer's current subscription read. */
  recipients: readonly string[];
}
export interface EnqueuedItem { principalId: string; itemId: string; generation: string; sequence: string;
  deliveries: number; replayed: boolean }

export interface PreferenceChange {
  purpose: OptionalPurpose; topic: string; channel: PreferenceChannel;
  state: 'enabled' | 'disabled'; expectedRevision: string | null; idempotencyKey: string;
  via: 'settings' | 'signed_link';
}
export interface Preference { purpose: string; topic: string; channel: string; state: string; revision: string;
  replayed: boolean }

export interface StreamItem {
  id: string; sequence: string; purpose: string; topic: string; state: 'active' | 'withdrawn' | 'erased';
  /** Present only for active items; withdrawn or erased items keep their sequence as a tombstone. */
  subject: { owner: string; ref: string; revision: string | null } | null;
  createdAt: string;
}
export interface StreamPage {
  generation: string; head: string; reset: boolean; readThrough: string;
  items: StreamItem[]; next: string | null;
}
export interface DeliveryView {
  id: string; itemId: string; channel: string; state: string; cancelReason: string | null;
  attempts: number; terminalAt: string | null;
}

export async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
}

/** Every ordinary Access transaction shares the global recovery pause. */
export async function requireAccessOpen(client: PoolClient): Promise<void> {
  const fence = await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
  if (fence.rows[0]?.open !== true) throw new NotificationUnavailable('Access is held for recovery');
}

export function normalizeNotificationError(error: unknown): Error {
  if (error instanceof NotificationInvalid || error instanceof NotificationDenied
    || error instanceof NotificationConflict || error instanceof NotificationStale
    || error instanceof NotificationUnavailable) return error;
  const code = (error as { code?: string }).code;
  if (code === '23505' || code === '40001' || code === '40P01') {
    return new NotificationConflict('concurrent notification change');
  }
  if (code === '23514' || code === '23503') return new NotificationStale('notification state changed');
  if (code === '55P03' || code === '57014') return new NotificationUnavailable('notification owner is busy');
  return new NotificationUnavailable('notification owner is unavailable');
}

/**
 * Private Access-owned notification owner: preferences, endpoints, recipient
 * streams and items, and read watermarks. External delivery lives in
 * NotificationDispatcher; this class never calls a provider.
 */
export class NotificationStore {
  constructor(private readonly pool: Pool) {}

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

  /** Reads: a caller without any Access principal has an empty inbox; an inactive one is denied. */
  private async reader(client: PoolClient, principal: VerifiedPrincipal): Promise<string | null> {
    const found = await client.query<{ id: string; active: boolean }>(`SELECT id, active FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 FOR SHARE`, [principal.issuer, principal.subject]);
    if (!found.rows[0]) return null;
    if (!found.rows[0].active) throw new NotificationDenied('recipient is inactive');
    return found.rows[0].id;
  }

  /** The recipient is the verified caller's own active principal; no other identity is accepted. */
  private async recipient(client: PoolClient, principal: VerifiedPrincipal, create: boolean): Promise<string> {
    if (create) {
      await client.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1, $2, $3) ON CONFLICT (account_issuer, account_subject) DO NOTHING`,
      [randomUUID(), principal.issuer, principal.subject]);
    }
    const found = await client.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
    [principal.issuer, principal.subject]);
    if (!found.rows[0]) throw new NotificationDenied('recipient is inactive or unknown');
    return found.rows[0].id;
  }

  /**
   * Producer intake for one domain event. Each recipient gets at most one item
   * per (source event, topic); deliveries are created only for currently
   * allowed channels and active endpoints and are rechecked again at delivery.
   */
  async enqueue(event: NotificationEvent): Promise<EnqueuedItem[]> {
    if (!(notificationPurposes as readonly string[]).includes(event.purpose) || !topicPattern.test(event.topic)
      || event.sourceEvent.length < 1 || event.sourceEvent.length > 256
      || event.subject.ref.length < 1 || event.subject.ref.length > 512
      || event.recipients.length < 1 || event.recipients.length > NOTIFICATION_LIMITS.recipientsPerEvent
      || new Set(event.recipients).size !== event.recipients.length
      || !event.recipients.every(id => uuidPattern.test(id))) {
      throw new NotificationInvalid('notification event does not match its profile');
    }
    // Canonical order keeps concurrent producers from deadlocking on stream rows.
    const recipients = [...event.recipients].sort();
    return this.transaction(async client => {
      const results: EnqueuedItem[] = [];
      for (const principalId of recipients) {
        const active = await client.query<{ active: boolean }>(
          'SELECT active FROM access.principal WHERE id = $1 FOR SHARE', [principalId]);
        if (active.rows[0]?.active !== true) continue;
        await client.query(`INSERT INTO access.notification_stream (principal_id, stream)
          VALUES ($1, 'inbox') ON CONFLICT DO NOTHING`, [principalId]);
        const stream = (await client.query<{ generation: string; head_sequence: string }>(
          `SELECT generation::text, head_sequence::text FROM access.notification_stream
           WHERE principal_id = $1 AND stream = 'inbox' FOR UPDATE`, [principalId])).rows[0]!;
        const existing = (await client.query<{ id: string; generation: string; sequence: string; deliveries: number }>(
          `SELECT i.id, i.generation::text, i.sequence::text,
             (SELECT count(*)::int FROM access.notification_delivery d WHERE d.item_id = i.id) AS deliveries
           FROM access.notification_item i
           WHERE i.principal_id = $1 AND i.source_owner = $2 AND i.source_event = $3 AND i.topic = $4`,
        [principalId, event.sourceOwner, event.sourceEvent, event.topic])).rows[0];
        if (existing) {
          results.push({ principalId, itemId: existing.id, generation: existing.generation,
            sequence: existing.sequence, deliveries: existing.deliveries, replayed: true });
          continue;
        }
        const sequence = (BigInt(stream.head_sequence) + 1n).toString();
        await client.query(`UPDATE access.notification_stream SET head_sequence = $2
          WHERE principal_id = $1 AND stream = 'inbox'`, [principalId, sequence]);
        const itemId = randomUUID();
        await client.query(`INSERT INTO access.notification_item (id, principal_id, stream, generation, sequence,
          purpose, topic, source_owner, source_event, subject_owner, subject_ref, subject_revision, disclosure_basis)
          VALUES ($1, $2, 'inbox', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [itemId, principalId, stream.generation, sequence, event.purpose, event.topic, event.sourceOwner,
          event.sourceEvent, event.subject.owner, event.subject.ref, event.subject.revision, event.disclosureBasis]);
        const inserted = await client.query(`INSERT INTO access.notification_delivery (id, item_id, principal_id,
            endpoint_id, channel, endpoint_generation, next_attempt_at, expires_at)
          SELECT gen_random_uuid(), $1, e.principal_id, e.id, e.channel, e.generation, clock_timestamp(),
            clock_timestamp() + ($5::bigint * interval '1 millisecond')
          FROM (SELECT * FROM access.notification_endpoint
            WHERE principal_id = $2 AND state = 'active' ORDER BY id LIMIT $6) e
          WHERE $3 IN ('security', 'account') OR NOT EXISTS (
            SELECT 1 FROM access.notification_preference p
            WHERE p.principal_id = e.principal_id AND p.purpose = $3 AND p.topic = $4
              AND p.channel = e.channel AND p.state = 'disabled')`,
        [itemId, principalId, event.purpose, event.topic, NOTIFICATION_LIMITS.deliveryTtlMs,
          NOTIFICATION_LIMITS.endpointsPerRecipient]);
        results.push({ principalId, itemId, generation: stream.generation, sequence,
          deliveries: inserted.rowCount ?? 0, replayed: false });
      }
      return results;
    });
  }

  /** Idempotent CAS change of one optional-purpose preference with an immutable receipt. */
  async setPreference(principal: VerifiedPrincipal, change: PreferenceChange): Promise<Preference> {
    if (!(optionalPurposes as readonly string[]).includes(change.purpose) || !topicPattern.test(change.topic)
      || !(preferenceChannels as readonly string[]).includes(change.channel)
      || !['enabled', 'disabled'].includes(change.state) || !keyPattern.test(change.idempotencyKey)
      || (change.expectedRevision !== null && !/^[1-9][0-9]{0,18}$/.test(change.expectedRevision))) {
      throw new NotificationInvalid('preference change does not match its profile');
    }
    const digest = sha256(JSON.stringify([change.purpose, change.topic, change.channel, change.state,
      change.expectedRevision, change.via]));
    return this.transaction(async client => {
      const principalId = await this.recipient(client, principal, true);
      const receipt = (await client.query<{ request_digest: string; purpose: string; topic: string;
        channel: string; state: string; revision: string }>(`SELECT request_digest, purpose, topic, channel,
        state, revision::text FROM access.notification_preference_change
        WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, change.idempotencyKey])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== digest) throw new NotificationConflict('idempotency key reused');
        return { purpose: receipt.purpose, topic: receipt.topic, channel: receipt.channel,
          state: receipt.state, revision: receipt.revision, replayed: true };
      }
      const current = (await client.query<{ revision: string }>(`SELECT revision::text
        FROM access.notification_preference WHERE principal_id = $1 AND purpose = $2 AND topic = $3
          AND channel = $4 FOR UPDATE`, [principalId, change.purpose, change.topic, change.channel])).rows[0];
      if ((current?.revision ?? null) !== change.expectedRevision) {
        throw new NotificationStale('preference revision changed');
      }
      const revision = current ? (BigInt(current.revision) + 1n).toString() : '1';
      if (current) {
        await client.query(`UPDATE access.notification_preference SET state = $5, revision = $6,
          updated_at = clock_timestamp() WHERE principal_id = $1 AND purpose = $2 AND topic = $3 AND channel = $4`,
        [principalId, change.purpose, change.topic, change.channel, change.state, revision]);
      } else {
        await client.query(`INSERT INTO access.notification_preference
          (principal_id, purpose, topic, channel, state, revision) VALUES ($1, $2, $3, $4, $5, 1)`,
        [principalId, change.purpose, change.topic, change.channel, change.state]);
      }
      await client.query(`INSERT INTO access.notification_preference_change (principal_id, idempotency_key,
        request_digest, purpose, topic, channel, state, revision, via) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [principalId, change.idempotencyKey, digest, change.purpose, change.topic, change.channel, change.state,
        revision, change.via]);
      return { purpose: change.purpose, topic: change.topic, channel: change.channel, state: change.state,
        revision, replayed: false };
    });
  }

  /**
   * Register or rotate the caller's endpoint. Rotation retires the previous
   * generation and cancels its open deliveries; it never reopens a terminal one.
   */
  async registerEndpoint(principal: VerifiedPrincipal, input: { channel: DeliveryChannel;
    deviceId: string | null; address: string | null; addressDigest: string; lockScreenDisclosure: boolean }):
    Promise<{ id: string; generation: string; retired: number }> {
    if (!(deliveryChannels as readonly string[]).includes(input.channel) || !/^[0-9a-f]{64}$/.test(input.addressDigest)
      || (input.channel === 'push') !== (input.deviceId !== null && input.address !== null)
      || (input.deviceId !== null && !keyPattern.test(input.deviceId))
      || (input.address !== null && (input.address.length < 1 || input.address.length > 2048))) {
      throw new NotificationInvalid('endpoint does not match its profile');
    }
    return this.transaction(async client => {
      const principalId = await this.recipient(client, principal, true);
      const previous = (await client.query<{ id: string; generation: string; address_digest: string }>(
        `SELECT id, generation::text, address_digest FROM access.notification_endpoint
         WHERE principal_id = $1 AND channel = $2 AND device_id IS NOT DISTINCT FROM $3 AND state = 'active'
         FOR UPDATE`, [principalId, input.channel, input.deviceId])).rows[0];
      if (previous?.address_digest === input.addressDigest) {
        return { id: previous.id, generation: previous.generation, retired: 0 };
      }
      let retired = 0;
      if (previous) {
        retired = (await client.query(`UPDATE access.notification_delivery SET state = 'cancelled',
            cancel_reason = 'endpoint_invalid', next_attempt_at = NULL, lease_token = NULL, lease_until = NULL,
            terminal_at = clock_timestamp()
          WHERE endpoint_id = $1 AND state IN ('pending', 'sending', 'uncertain')`, [previous.id])).rowCount ?? 0;
        await client.query(`UPDATE access.notification_endpoint SET state = 'retired', address = NULL,
          retired_at = clock_timestamp() WHERE id = $1`, [previous.id]);
      }
      const generation = (await client.query<{ generation: string }>(`SELECT (coalesce(max(generation), 0) + 1)::text
        AS generation FROM access.notification_endpoint WHERE principal_id = $1 AND channel = $2
          AND device_id IS NOT DISTINCT FROM $3`, [principalId, input.channel, input.deviceId])).rows[0]!.generation;
      const id = randomUUID();
      await client.query(`INSERT INTO access.notification_endpoint (id, principal_id, channel, device_id,
        generation, state, address, address_digest, lock_screen_disclosure)
        VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)`,
      [id, principalId, input.channel, input.deviceId, generation, input.address, input.addressDigest,
        input.lockScreenDisclosure]);
      return { id, generation, retired };
    });
  }

  /**
   * One bounded page of the caller's inbox after a (generation, sequence)
   * cursor. A cursor from an older generation returns an explicit reset from
   * the start of the current generation; sequences are gap-free, so a client
   * detects missed realtime hints by comparing sequences.
   */
  async readStream(principal: VerifiedPrincipal, after: { generation: string; sequence: string } | null,
    limit: number = NOTIFICATION_LIMITS.streamPage): Promise<StreamPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > NOTIFICATION_LIMITS.streamPage
      || (after && (!/^[1-9][0-9]{0,18}$/.test(after.generation) || !/^(0|[1-9][0-9]{0,18})$/.test(after.sequence)))) {
      throw new NotificationInvalid('stream cursor does not match its profile');
    }
    return this.transaction(async client => {
      const principalId = await this.reader(client, principal);
      const stream = (principalId === null ? undefined : (await client.query<{ generation: string;
        head_sequence: string }>(`SELECT generation::text, head_sequence::text FROM access.notification_stream
         WHERE principal_id = $1 AND stream = 'inbox'`, [principalId])).rows[0])
        ?? { generation: '1', head_sequence: '0' };
      if (after && BigInt(after.generation) > BigInt(stream.generation)) {
        throw new NotificationStale('stream cursor is ahead of the recipient stream');
      }
      const reset = after !== null && after.generation !== stream.generation;
      const from = after && !reset ? after.sequence : '0';
      if (BigInt(from) > BigInt(stream.head_sequence)) throw new NotificationStale('stream cursor is ahead of head');
      const rows = (await client.query<{ id: string; sequence: string; purpose: string; topic: string;
        state: StreamItem['state']; subject_owner: string; subject_ref: string; subject_revision: string | null;
        created_at: Date }>(`SELECT i.id, i.sequence::text AS sequence, i.purpose, i.topic, i.state,
          i.subject_owner, i.subject_ref, i.subject_revision, i.created_at FROM access.notification_item i
        WHERE i.principal_id = $1 AND i.stream = 'inbox' AND i.generation = $2 AND i.sequence > $3
        ORDER BY i.sequence LIMIT $4`, [principalId, stream.generation, from, limit + 1])).rows;
      const watermark = (await client.query<{ read_through: string }>(`SELECT read_through::text
        FROM access.notification_read_watermark WHERE principal_id = $1 AND stream = 'inbox' AND generation = $2`,
      [principalId, stream.generation])).rows[0];
      const page = rows.slice(0, limit);
      return {
        generation: stream.generation, head: stream.head_sequence, reset,
        readThrough: watermark?.read_through ?? '0',
        items: page.map(row => ({ id: row.id, sequence: row.sequence, purpose: row.purpose, topic: row.topic,
          state: row.state, createdAt: row.created_at.toISOString(),
          subject: row.state === 'active'
            ? { owner: row.subject_owner, ref: row.subject_ref, revision: row.subject_revision } : null })),
        next: rows.length > limit ? `${stream.generation}:${page.at(-1)!.sequence}` : null,
      };
    });
  }

  /** Realtime hint: the durable head only. Clients fetch items through readStream. */
  async hint(principal: VerifiedPrincipal): Promise<{ generation: string; head: string }> {
    return this.transaction(async client => {
      const principalId = await this.reader(client, principal);
      const stream = principalId === null ? undefined : (await client.query<{ generation: string;
        head_sequence: string }>(`SELECT generation::text, head_sequence::text FROM access.notification_stream
         WHERE principal_id = $1 AND stream = 'inbox'`, [principalId])).rows[0];
      return { generation: stream?.generation ?? '1', head: stream?.head_sequence ?? '0' };
    });
  }

  /**
   * Monotonic, idempotent read watermark within one stream generation. A lower
   * value is a no-op returning the current watermark; a value past the head or
   * for another generation is stale.
   */
  async advanceWatermark(principal: VerifiedPrincipal, generation: string, readThrough: string):
    Promise<{ generation: string; readThrough: string; advanced: boolean }> {
    if (!/^[1-9][0-9]{0,18}$/.test(generation) || !/^(0|[1-9][0-9]{0,18})$/.test(readThrough)) {
      throw new NotificationInvalid('watermark does not match its profile');
    }
    return this.transaction(async client => {
      const principalId = await this.recipient(client, principal, false);
      const stream = (await client.query<{ generation: string; head_sequence: string }>(
        `SELECT generation::text, head_sequence::text FROM access.notification_stream
         WHERE principal_id = $1 AND stream = 'inbox' FOR SHARE`, [principalId])).rows[0];
      if (!stream || stream.generation !== generation || BigInt(readThrough) > BigInt(stream.head_sequence)) {
        throw new NotificationStale('watermark is outside the current stream generation');
      }
      const row = (await client.query<{ read_through: string; advanced: boolean }>(
        `INSERT INTO access.notification_read_watermark (principal_id, stream, generation, read_through)
         VALUES ($1, 'inbox', $2, $3)
         ON CONFLICT (principal_id, stream, generation) DO UPDATE
           SET read_through = GREATEST(access.notification_read_watermark.read_through, EXCLUDED.read_through),
               updated_at = CASE WHEN EXCLUDED.read_through > access.notification_read_watermark.read_through
                 THEN clock_timestamp() ELSE access.notification_read_watermark.updated_at END
         RETURNING read_through::text, (read_through = $3::bigint) AS advanced`,
      [principalId, generation, readThrough])).rows[0]!;
      return { generation, readThrough: row.read_through, advanced: row.advanced };
    });
  }

  /** Explicit reset opens a new generation; old watermarks stay with their generation. */
  async resetStream(principal: VerifiedPrincipal, expectedGeneration: string): Promise<{ generation: string }> {
    if (!/^[1-9][0-9]{0,18}$/.test(expectedGeneration)) throw new NotificationInvalid('invalid generation');
    return this.transaction(async client => {
      const principalId = await this.recipient(client, principal, false);
      const updated = await client.query<{ generation: string }>(`UPDATE access.notification_stream
        SET generation = generation + 1, head_sequence = 0, reset_at = clock_timestamp()
        WHERE principal_id = $1 AND stream = 'inbox' AND generation = $2 RETURNING generation::text`,
      [principalId, expectedGeneration]);
      if (!updated.rows[0]) throw new NotificationStale('stream generation changed');
      return { generation: updated.rows[0].generation };
    });
  }

  async readDelivery(principal: VerifiedPrincipal, deliveryId: string): Promise<DeliveryView> {
    if (!uuidPattern.test(deliveryId)) throw new NotificationInvalid('invalid delivery id');
    return this.transaction(async client => {
      const principalId = await this.recipient(client, principal, false);
      const row = (await client.query<{ id: string; item_id: string; channel: string; state: string;
        cancel_reason: string | null; attempt_count: number; terminal_at: Date | null }>(
        `SELECT id, item_id, channel, state, cancel_reason, attempt_count, terminal_at
         FROM access.notification_delivery WHERE id = $1 AND principal_id = $2`, [deliveryId, principalId])).rows[0];
      // Another recipient's delivery is indistinguishable from a missing one.
      if (!row) throw new NotificationDenied('delivery is unavailable');
      return { id: row.id, itemId: row.item_id, channel: row.channel, state: row.state,
        cancelReason: row.cancel_reason, attempts: row.attempt_count,
        terminalAt: row.terminal_at?.toISOString() ?? null };
    });
  }

  /** Reapply an Account erasure before any restored item or delivery can be read. */
  async reconcileErasedRecipients(principalIds: readonly string[]): Promise<{ deliveries: number; items: number }> {
    if (principalIds.length > 1000 || !principalIds.every(id => uuidPattern.test(id))) {
      throw new NotificationInvalid('erased recipient batch is out of bounds');
    }
    if (!principalIds.length) return { deliveries: 0, items: 0 };
    return this.transaction(async client => {
      const deliveries = (await client.query(`UPDATE access.notification_delivery SET state = 'cancelled',
          cancel_reason = 'recipient_erased', next_attempt_at = NULL, lease_token = NULL, lease_until = NULL,
          terminal_at = clock_timestamp()
        WHERE principal_id = ANY($1::uuid[]) AND state IN ('pending', 'sending', 'uncertain')`,
      [principalIds])).rowCount ?? 0;
      const items = (await client.query(`UPDATE access.notification_item SET state = 'erased',
          state_changed_at = coalesce(state_changed_at, clock_timestamp())
        WHERE principal_id = ANY($1::uuid[]) AND state <> 'erased'`, [principalIds])).rowCount ?? 0;
      return { deliveries, items };
    });
  }

  /** Relay retains these intents outside an Access backup; page them before serving. */
  async reconcileRetainedErasures(relay: Pool, page = 500): Promise<{ recipients: number; deliveries: number;
    items: number }> {
    if (!Number.isInteger(page) || page < 1 || page > 500) {
      throw new NotificationInvalid('erasure reconciliation page is out of bounds');
    }
    const total = { recipients: 0, deliveries: 0, items: 0 };
    const deadline = Date.now() + 590_000;
    let after: string | null = null;
    while (true) {
      if (Date.now() >= deadline) {
        throw new NotificationUnavailable('retained erasure reconciliation exceeded the startup budget');
      }
      const rows: { principal_id: string }[] = (await relay.query<{ principal_id: string }>(
        `SELECT principal_id::text FROM relay.account_deletion_intent
         WHERE ($1::uuid IS NULL OR principal_id > $1::uuid) ORDER BY principal_id LIMIT $2`, [after, page])).rows;
      if (!rows.length) return total;
      const result = await this.reconcileErasedRecipients(rows.map(row => row.principal_id));
      total.recipients += rows.length;
      total.deliveries += result.deliveries;
      total.items += result.items;
      after = rows.at(-1)!.principal_id;
      if (rows.length < page) return total;
    }
  }
}
