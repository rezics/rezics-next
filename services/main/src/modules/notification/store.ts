import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { deliveryChannels, notificationKinds, notificationPurposes, optionalPurposes,
  preferenceChannels } from './schema.ts';
import type { NotificationSubjectReader, SubjectResolution } from './dispatcher.ts';
import { notificationNewWorkDisplay, sanctionFromFields } from './display.ts';
import { disclosurePoolReader, type DisclosureChannel } from '../disclosure/read.ts';
import { readResourceSummaries } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { discloseNotifications } from '../disclosure/notifications.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import { PersonPreferencesStore } from '../preferences/store.ts';
import type { Viewer } from '../suitability/policy.ts';
import { notificationRecipientAllowed } from './recipient-policy.ts';
import { relationshipRecipientPage, type RelationshipRecipients, type RecipientFrontier } from '../follows/recipients.ts';

export class NotificationInvalid extends Error {}
export class NotificationDenied extends Error {}
export class NotificationConflict extends Error {}
export class NotificationStale extends Error {}
export class NotificationUnavailable extends Error {}

export type NotificationPurpose = typeof notificationPurposes[number];
export type OptionalPurpose = typeof optionalPurposes[number] | 'governance';
export type PreferenceChannel = typeof preferenceChannels[number];
export type DeliveryChannel = typeof deliveryChannels[number];
export type NotificationKind = typeof notificationKinds[number];
export interface NotificationDisplayContext {
  kind: NotificationKind;
  actorAgent: string | null;
  realm: string | null;
  /** Stable, producer-selected identity of a repeatable conversation or event family. */
  groupKey: string | null;
}
export interface NotificationAgentSummary {
  id: string;
  /** Omitted when this recipient may not see the profile name. The id stays. */
  name?: string;
  handle: string | null;
  address?: import('@rezics/model/address').CanonicalAddress; avatar: string | null;
}
/** Recipient and delivery channel for one name-policy decision. A copied viewer has no authority. */
export interface NotificationActorAudience {
  viewer: Viewer;
  channel: DisclosureChannel;
  preferences: Pick<PersonPreferencesStore, 'visibleNameOwners'>;
}
export interface NotificationAgentReader {
  (agent: string, audience?: NotificationActorAudience): Promise<NotificationAgentSummary | null>;
  /** One name-policy read for every actor on a page or delivery, not one per pair. */
  readBatch?(agents: readonly string[], audience: NotificationActorAudience):
    Promise<ReadonlyMap<string, NotificationAgentSummary>>;
}

/** Fixed bounds of the first notification profile; every operation is O(bound). */
export const NOTIFICATION_LIMITS = {
  recipientsPerEvent: 256,
  endpointsPerRecipient: 8,
  streamPage: 50,
  unreadCap: 100,
  unreadScan: 256,
  deliveryTtlMs: 86_400_000,
} as const;

/** Indexed per-item delivery discovery, within the requested inbox page. */
export const NOTIFICATION_DELIVERY_DISCOVERY_COST = {
  statements: NOTIFICATION_LIMITS.streamPage,
  selectedRows: NOTIFICATION_LIMITS.streamPage * NOTIFICATION_LIMITS.endpointsPerRecipient,
} as const;

/** Post-commit realtime hints. Durable notification items remain in the stream. */
export const NOTIFICATION_REALTIME_CHANNEL = 'rezics_notification_stream_v1';

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
  /** Internal bounded fan-out plan; recipient page ACKs commit in Access. */
  relationshipPlan?: RelationshipRecipients;
  /** Follow producers may use kind `follow`; current labels are read from their owners. */
  display?: NotificationDisplayContext;
  proposal?: {
    id: string;
    revision: number;
    reasons: Readonly<Record<string, ProposalSubscriptionReason>>;
  };
}
export const proposalSubscriptionReasons = ['author', 'reviewer', 'steward', 'manual'] as const;
export type ProposalSubscriptionReason = (typeof proposalSubscriptionReasons)[number];
export const REVIEW_NOTIFICATION_TOPICS = [
  'review-requested',
  'changes-requested',
  'proposal-revised',
  'proposal-decided',
  'proposal-withdrawn',
  'proposal-reverted',
] as const;
export const optionalNotification = (purpose: string, topic: string) =>
  (optionalPurposes as readonly string[]).includes(purpose) ||
  (purpose === 'governance' && (REVIEW_NOTIFICATION_TOPICS as readonly string[]).includes(topic));
/** Two indexed item reads and a CAS write; no read-state mutation or provider call. */
export const NOTIFICATION_TRIAGE_COST = { statements: 9 } as const;
/** Includes both transactions and fences; exact target reads have their own actor bound. */
export const NOTIFICATION_SUBSCRIPTION_COST = { readStatements: 14, setStatements: 16 } as const;
export interface EnqueuedItem { principalId: string; itemId: string; generation: string; sequence: string;
  deliveries: number; replayed: boolean }

export interface PreferenceChange {
  purpose: OptionalPurpose; topic: string; channel: PreferenceChannel;
  state: 'enabled' | 'disabled'; expectedRevision: string | null; idempotencyKey: string;
  via: 'settings' | 'signed_link';
}
export interface Preference { purpose: string; topic: string; channel: string; state: string; revision: string;
  replayed: boolean }

/** Settings show only topics with an active producer. Keep this list in producer contract order. */
export const SETTINGS_NOTIFICATION_TOPICS = [
  { purpose: 'social', topic: 'reply' },
  { purpose: 'social', topic: 'mention' },
  { purpose: 'social', topic: 'post-vote' },
  { purpose: 'subscription', topic: 'followed-chapter' },
  { purpose: 'subscription', topic: 'new-work' },
  { purpose: 'subscription', topic: 'new-release' },
  { purpose: 'subscription', topic: 'collection-change' },
  { purpose: 'social', topic: 'review-helpful' },
  { purpose: 'social', topic: 'review' },
  ...REVIEW_NOTIFICATION_TOPICS.map((topic) => ({ purpose: 'governance' as const, topic })),
] as const;
/** One recovery check, one principal read and one indexed preference read for optional topics. */
export const NOTIFICATION_SETTINGS_COST = { readStatements: 3, maxRows: SETTINGS_NOTIFICATION_TOPICS.length * 3 * 3,
  responseItems: SETTINGS_NOTIFICATION_TOPICS.length * 3 } as const;
export interface SettingsPreference { purpose: OptionalPurpose; topic: string;
  channel: 'inbox' | 'push' | 'email'; state: 'enabled' | 'disabled'; revision: string | null }

export interface StreamItem {
  id: string; sequence: string; purpose: string; topic: string; state: 'active' | 'withdrawn' | 'erased';
  read: boolean;
  saved: boolean;
  done: boolean;
  triageRevision: string | null;
  reason: ProposalSubscriptionReason | null;
  proposal: { id: string; revision: number } | null;
  deliveries: { id: string; channel: string }[];
  /** Present only for active items; withdrawn or erased items keep their sequence as a tombstone. */
  subject: { owner: string; ref: string; revision: string | null } | null;
  display: (Omit<NotificationDisplayContext, 'actorAgent' | 'kind'> & {
    /** New-Work context is derived at read time; no new persisted display kind. */
    kind: NotificationKind | 'new_work'; actor: NotificationAgentSummary | null;
    realmName: string | null; realmRouteSegment: string | null; roleName: string | null;
    roleChange: 'given' | 'taken' | null;
    membershipAction?: 'ban' | 'unban' | null;
    membershipReason?: string | null;
    membershipUntil?: string | null;
    membershipPermanent?: boolean | null;
    target: { title: string | null; excerpt: string | null;
    language: string | null; linkTarget: string | null; reviewId: string | null;
    topicName?: string | null; href?: string | null } }) | null;
  createdAt: string;
}
export interface StreamPage {
  generation: string; head: string; reset: boolean; readThrough: string;
  items: StreamItem[]; groups: { kind: NonNullable<StreamItem['display']>['kind']; key: string; itemIds: string[] }[];
  next: string | null;
}

/** Page-local repeat groups; a missing or undisclosed context is never grouped. */
export function groupNotifications(items: readonly StreamItem[]): StreamPage['groups'] {
  const groups: StreamPage['groups'] = [];
  for (const item of items) {
    const display = item.display;
    if (!display?.groupKey) continue;
    const group = groups.find(candidate => candidate.kind === display.kind
      && candidate.key === display.groupKey && candidate.itemIds.length < 10);
    if (group) group.itemIds.push(item.id);
    else groups.push({ kind: display.kind, key: display.groupKey, itemIds: [item.id] });
  }
  return groups;
}
export interface DeliveryView {
  id: string; itemId: string; channel: string; state: string; cancelReason: string | null;
  attempts: number; terminalAt: string | null;
}

export async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
}

/** Every ordinary Access transaction shares the global recovery pause. */
export async function requireAccessOpen(client: Pick<PoolClient, 'query'>): Promise<void> {
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
  private readonly readSubjects = new Map<string, NotificationSubjectReader>();
  private defaultReadSubject: NotificationSubjectReader | null = null;
  private readAgent: NotificationAgentReader | null = null;

  setReadAgentReader(reader: NotificationAgentReader): void {
    if (this.readAgent) throw new NotificationInvalid('read Agent reader is already registered');
    this.readAgent = reader;
  }

  /** Current names for this recipient and channel. One policy read for the whole page. */
  private async notificationActors(agents: readonly string[], viewer: Viewer,
    channel: DisclosureChannel): Promise<ReadonlyMap<string, NotificationAgentSummary>> {
    if (!this.readAgent || !agents.length) return new Map();
    const audience: NotificationActorAudience = {
      viewer, channel, preferences: new PersonPreferencesStore(this.pool),
    };
    if (this.readAgent.readBatch) return this.readAgent.readBatch(agents, audience);
    const summaries = new Map<string, NotificationAgentSummary>();
    for (const agent of [...new Set(agents)]) {
      const summary = await this.readAgent(agent, audience);
      if (summary) summaries.set(agent, summary);
    }
    return summaries;
  }

  setDefaultReadSubjectReader(reader: NotificationSubjectReader): void {
    if (this.defaultReadSubject) throw new NotificationInvalid('default read subject is already registered');
    this.defaultReadSubject = reader;
  }

  registerReadSubjectReader(disclosureBasis: string, reader: NotificationSubjectReader): void {
    if (!disclosureBasis || this.readSubjects.has(disclosureBasis)) {
      throw new NotificationInvalid('read subject basis is invalid or already registered');
    }
    this.readSubjects.set(disclosureBasis, reader);
  }
  async resolveDigestSubject(input: Parameters<NotificationSubjectReader['resolve']>[0]) {
    return (await this.resolveDigestSubjects([input]))[0]!;
  }
  async resolveDigestSubjects(inputs: readonly Parameters<NotificationSubjectReader['resolve']>[0][]) {
    const subjects = await Promise.all(inputs.map(async input => {
      const resolver = this.readSubjects.get(input.disclosureBasis) ?? this.defaultReadSubject;
      const allowed = !input.actorAgent && !input.realm || await notificationRecipientAllowed(this.pool,input.principalId,
        input.actorAgent ?? null,input.realm ?? null,input.relatedResource ?? null);
      return { input, result: !allowed ? { status: 'undisclosed' as const }
        : resolver ? await resolver.resolve(input) : { status: 'unavailable' as const } };
    }));
    return discloseNotifications(this.pool, subjects, 'digest');
  }
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
   * A supplied Access client belongs to the caller's recovery-fenced transaction;
   * intake and the source acknowledgement then commit together without a second checkout.
   */
  async enqueue(event: NotificationEvent, heldClient?: PoolClient): Promise<EnqueuedItem[] & { complete?: boolean }> {
    if (!(notificationPurposes as readonly string[]).includes(event.purpose) || !topicPattern.test(event.topic)
      || event.sourceEvent.length < 1 || event.sourceEvent.length > 256
      || event.subject.ref.length < 1 || event.subject.ref.length > 512
      || (!event.relationshipPlan && event.recipients.length < 1) || event.recipients.length > NOTIFICATION_LIMITS.recipientsPerEvent
      || new Set(event.recipients).size !== event.recipients.length
      || !event.recipients.every(id => uuidPattern.test(id))
      || (event.proposal !== undefined &&
        (!uuidPattern.test(event.proposal.id) ||
          !Number.isSafeInteger(event.proposal.revision) ||
          event.proposal.revision < 1 ||
          event.subject.ref !== event.proposal.id ||
          event.subject.revision !== String(event.proposal.revision) ||
          event.recipients.some(
            (id) => !proposalSubscriptionReasons.includes(event.proposal!.reasons[id]!),
          ))) ||
      (event.display !== undefined && (
        !(notificationKinds as readonly string[]).includes(event.display.kind)
        || (event.display.actorAgent !== null
          && !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(event.display.actorAgent))
        || (event.display.realm !== null && (event.display.realm.length < 1 || event.display.realm.length > 512))
        || (event.display.groupKey !== null
          && (event.display.groupKey.length < 1 || event.display.groupKey.length > 256))))) {
      throw new NotificationInvalid('notification event does not match its profile');
    }
    // Canonical order keeps concurrent producers from deadlocking on stream rows.
    let recipients = [...event.recipients].sort();
    const intake = async (client: PoolClient) => {
      const results: EnqueuedItem[] & { complete?: boolean } = [];
      let nextCursor: RecipientFrontier | null = null;
      let proposalReasons = event.proposal?.reasons ?? {};
      if (event.relationshipPlan) {
        await client.query(`INSERT INTO access.notification_recipient_progress(source_owner,source_event,topic)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[event.sourceOwner,event.sourceEvent,event.topic]);
        const progress = (await client.query<{ after_principal: string | null; frontier: RecipientFrontier | null; complete: boolean }>(`SELECT after_principal,frontier,complete
          FROM access.notification_recipient_progress WHERE source_owner=$1 AND source_event=$2 AND topic=$3 FOR UPDATE`,
        [event.sourceOwner,event.sourceEvent,event.topic])).rows[0]!;
        if (progress.complete) return results;
        const page = await relationshipRecipientPage(client,event.relationshipPlan,progress.frontier ?? progress.after_principal);
        recipients = page.items; nextCursor = page.nextCursor;
        if (event.relationshipPlan.editorial) proposalReasons = page.reasons;
        Object.defineProperty(results,'complete',{ value: nextCursor === null });
      }
      for (const principalId of recipients) {
        // Recheck a mute inside intake, including a mute that raced the producer.
        if (event.proposal) {
          const subscription = (await client.query<{ level: string }>(`SELECT level FROM access.watch
            WHERE principal_id = $1 AND proposal = $2 FOR SHARE`,[principalId,event.proposal.id])).rows[0];
          if (subscription?.level === 'ignore' && ['manual','steward'].includes(proposalReasons[principalId] ?? 'manual')) continue;
        }
        const first = await client.query(`INSERT INTO access.notification_seen
          (principal_id, source_owner, source_event, topic)
          SELECT p.id, $2, $3, $4 FROM access.principal p WHERE p.id = $1 AND p.active
          ON CONFLICT DO NOTHING RETURNING principal_id`,
        [principalId, event.sourceOwner, event.sourceEvent, event.topic]);
        if (!first.rowCount) {
          const previous = (await client.query<{ id: string; generation: string;
            sequence: string; deliveries: number }>(`SELECT i.id, i.generation::text, i.sequence::text,
              (SELECT count(*)::int FROM access.notification_delivery d WHERE d.item_id = i.id) AS deliveries
              FROM access.notification_item i WHERE i.principal_id = $1 AND i.source_owner = $2
                AND i.source_event = $3 AND i.topic = $4`,
          [principalId, event.sourceOwner, event.sourceEvent, event.topic])).rows[0];
          if (previous) results.push({ principalId, itemId: previous.id,
            generation: previous.generation, sequence: previous.sequence,
            deliveries: previous.deliveries, replayed: true });
          continue;
        }
        const active = await client.query<{ inbox: boolean; email: boolean }>(
          `SELECT p.active AND (NOT $4::boolean OR NOT EXISTS (SELECT 1 FROM access.notification_preference n
             WHERE n.principal_id = p.id AND n.purpose = $2 AND n.topic = $3
               AND n.channel = 'inbox' AND n.state = 'disabled')) AS inbox,
           p.active AND EXISTS (SELECT 1 FROM access.notification_preference n
             WHERE n.principal_id = p.id AND n.purpose = $2 AND n.topic = $3
               AND n.channel = 'email' AND n.state = 'enabled') AS email
           FROM access.principal p WHERE p.id = $1 FOR SHARE`,
        [principalId, event.purpose, event.topic,
            !['security', 'account'].includes(event.purpose)
              && !(event.purpose === 'governance' && event.topic === 'moderation-outcome'),
          ]);
        if (active.rows[0]?.email && optionalNotification(event.purpose, event.topic)) {
          await client.query(`INSERT INTO access.notification_digest_day (principal_id, day)
            VALUES ($1, (clock_timestamp() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING`, [principalId]);
          await client.query(`INSERT INTO access.notification_digest_candidate (principal_id, day,
            source_owner, source_event, purpose, topic, subject_owner, subject_ref,
            subject_revision, disclosure_basis, realm, proposal, proposal_reason, actor_agent, related_resource)
            VALUES ($1, (clock_timestamp() AT TIME ZONE 'UTC')::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT DO NOTHING`, [principalId, event.sourceOwner, event.sourceEvent,
            event.purpose, event.topic, event.subject.owner, event.subject.ref,
            event.subject.revision, event.disclosureBasis, event.display?.realm ?? null, event.proposal?.id ?? null,
            event.proposal ? proposalReasons[principalId] ?? 'manual' : null,event.display?.actorAgent ?? null,event.display?.groupKey ?? null]);
        }
        if (active.rows[0]?.inbox !== true) continue;
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
        if (event.proposal)
          await client.query(
            `INSERT INTO access.notification_proposal_context
          (item_id, proposal, revision, reason) VALUES ($1,$2,$3,$4)`,
            [
              itemId,
              event.proposal.id,
              event.proposal.revision,
              proposalReasons[principalId] ?? 'manual',
            ],
          );
        if (event.display) await client.query(`INSERT INTO access.notification_display_context
          (item_id, kind, actor_agent, realm, group_key) VALUES ($1, $2, $3, $4, $5)`,
        [itemId, event.display.kind, event.display.actorAgent, event.display.realm, event.display.groupKey]);
        // A saved email choice uses the digest path above; an unset choice keeps
        // explicitly registered direct email endpoints eligible.
        const inserted = await client.query(
          `INSERT INTO access.notification_delivery (id, item_id, principal_id,
            endpoint_id, channel, endpoint_generation, next_attempt_at, expires_at)
          SELECT gen_random_uuid(), $1, e.principal_id, e.id, e.channel, e.generation, clock_timestamp(),
            clock_timestamp() + ($5::bigint * interval '1 millisecond')
          FROM (SELECT * FROM access.notification_endpoint
            WHERE principal_id = $2 AND state = 'active' ORDER BY id LIMIT $6) e
          WHERE ($7::boolean AND e.channel <> 'email' AND NOT EXISTS (
            SELECT 1 FROM access.notification_preference p WHERE p.principal_id = e.principal_id
              AND p.purpose = $3 AND p.topic = $4 AND p.channel = e.channel AND p.state = 'disabled'))
            OR (NOT $7::boolean AND ($3 IN ('security', 'account', 'governance') OR NOT EXISTS (
            SELECT 1 FROM access.notification_preference p
            WHERE p.principal_id = e.principal_id AND p.purpose = $3 AND p.topic = $4
              AND p.channel = e.channel
              AND (p.state = 'disabled' OR (e.channel = 'email' AND p.state = 'enabled')))))`,
        [itemId, principalId, event.purpose, event.topic, NOTIFICATION_LIMITS.deliveryTtlMs,
          NOTIFICATION_LIMITS.endpointsPerRecipient,
            event.proposal !== undefined,
          ]);
        results.push({ principalId, itemId, generation: stream.generation, sequence,
          deliveries: inserted.rowCount ?? 0, replayed: false });
        // PostgreSQL publishes this only after commit. The payload is a minimal
        // cursor hint; clients still read the authoritative stream over HTTP.
        await client.query('SELECT pg_notify($1, $2)', [NOTIFICATION_REALTIME_CHANNEL,
          JSON.stringify({ principalId, generation: stream.generation, head: sequence })]);
      }
      if (event.relationshipPlan) await client.query(`UPDATE access.notification_recipient_progress
        SET after_principal=$4,frontier=$6,complete=$5,updated_at=clock_timestamp() WHERE source_owner=$1 AND source_event=$2 AND topic=$3`,
      [event.sourceOwner,event.sourceEvent,event.topic,nextCursor?.afterPrincipal ?? null,nextCursor === null,
        nextCursor ? JSON.stringify(nextCursor) : null]);
      return results;
    };
    return heldClient ? intake(heldClient) : this.transaction(intake);
  }

  /** Resolve only this active Access principal for a verified Account identity. */
  async realtimeRecipientId(principal: VerifiedPrincipal): Promise<string | null> {
    return this.transaction(client => this.reader(client, principal));
  }

  /** Recipient identity is re-read from the active Access principal for owner authorization. */
  async readRecipientIdentity(principalId: string): Promise<VerifiedPrincipal | null> {
    if (!uuidPattern.test(principalId)) throw new NotificationInvalid('invalid recipient id');
    return this.transaction(async client => {
      const row = (await client.query<{ account_issuer: string; account_subject: string }>(
        `SELECT account_issuer, account_subject FROM access.principal
         WHERE id = $1 AND active FOR SHARE`, [principalId])).rows[0];
      return row ? { issuer: row.account_issuer, subject: row.account_subject } : null;
    });
  }

  /** One bounded settings read; absent inbox choices are enabled, email is opt-in. */
  async readSettingsPreferences(principal: VerifiedPrincipal): Promise<SettingsPreference[]> {
    return this.transaction(async client => {
      const principalId = await this.reader(client, principal);
      const rows = principalId ? (await client.query<{ purpose: OptionalPurpose; topic: string;
        channel: 'inbox' | 'push' | 'email'; state: 'enabled' | 'disabled'; revision: string }>(
        `SELECT purpose, topic, channel, state, revision::text FROM access.notification_preference
         WHERE principal_id = $1 AND channel IN ('inbox', 'push', 'email')
           AND topic = ANY($2::text[])`,
        [principalId, SETTINGS_NOTIFICATION_TOPICS.map(item => item.topic)])).rows : [];
      const known = new Map(rows.map(row => [`${row.purpose}:${row.topic}:${row.channel}`, row]));
      return SETTINGS_NOTIFICATION_TOPICS.flatMap(item => (['inbox', 'push', 'email'] as const).map(channel => {
        const saved = known.get(`${item.purpose}:${item.topic}:${channel}`);
        return { ...item, channel, state: saved?.state ?? (channel === 'email' ? 'disabled' : 'enabled'),
          revision: saved?.revision ?? null };
      }));
    });
  }

  /** Idempotent CAS change of one optional-purpose preference with an immutable receipt. */
  async setPreference(principal: VerifiedPrincipal, change: PreferenceChange): Promise<Preference> {
    if (!optionalNotification(change.purpose, change.topic) || !topicPattern.test(change.topic)
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
    limit: number = NOTIFICATION_LIMITS.streamPage,
    selection: { view?: 'inbox' | 'saved' | 'done'; reason?: ProposalSubscriptionReason } = {},
  ): Promise<StreamPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > NOTIFICATION_LIMITS.streamPage
      || (after && (!/^[1-9][0-9]{0,18}$/.test(after.generation) || !/^(0|[1-9][0-9]{0,18})$/.test(after.sequence))) ||
      (selection.view !== undefined && !['inbox', 'saved', 'done'].includes(selection.view)) ||
      (selection.reason !== undefined && !proposalSubscriptionReasons.includes(selection.reason))) {
      throw new NotificationInvalid('stream cursor does not match its profile');
    }
    const { page: result, principalId } = await this.transaction(async client => {
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
        disclosure_basis: string; kind: NotificationKind | null; actor_agent: string | null;
        realm: string | null; group_key: string | null;
          saved: boolean;
          done: boolean;
          triage_revision: string | null;
          reason: ProposalSubscriptionReason | null;
          proposal: string | null;
          proposal_revision: number | null;
          created_at: Date; individually_read: boolean }>(
          `SELECT i.id, i.sequence::text AS sequence, i.purpose,
          i.topic, i.state, i.subject_owner, i.subject_ref, i.subject_revision, i.created_at,
          i.disclosure_basis, c.kind, c.actor_agent, c.realm, c.group_key,
          coalesce(t.saved,false) AS saved, coalesce(t.done,false) AS done, t.revision::text AS triage_revision,
          pc.reason, pc.proposal, pc.revision AS proposal_revision,
          (r.item_id IS NOT NULL) AS individually_read FROM access.notification_item i
        LEFT JOIN access.notification_item_triage t ON t.principal_id = i.principal_id AND t.item_id = i.id
        LEFT JOIN access.notification_proposal_context pc ON pc.item_id = i.id
        LEFT JOIN access.notification_item_read r ON r.principal_id = i.principal_id AND r.item_id = i.id
        LEFT JOIN access.notification_display_context c ON c.item_id = i.id
        WHERE i.principal_id = $1 AND i.stream = 'inbox' AND i.generation = $2 AND i.sequence > $3
          AND ($5::text IS NULL OR $5 = 'inbox' AND NOT coalesce(t.done,false)
            OR $5 = 'saved' AND t.saved OR $5 = 'done' AND t.done)
          AND ($6::text IS NULL OR pc.reason = $6)
        ORDER BY i.sequence LIMIT $4`, [principalId, stream.generation, from, limit + 1,
            selection.view ?? 'inbox',
            selection.reason ?? null,
          ])).rows;
      const watermark = (await client.query<{ read_through: string }>(`SELECT read_through::text
        FROM access.notification_read_watermark WHERE principal_id = $1 AND stream = 'inbox' AND generation = $2`,
      [principalId, stream.generation])).rows[0];
      const page = rows.slice(0, limit);
      const deliveries = new Map<string, StreamItem['deliveries']>();
      for (const item of page) {
        // (item_id, endpoint_id) is a unique index; no recipient history scan.
        deliveries.set(item.id, (await client.query<{ id: string; channel: string }>(`
          SELECT id, channel FROM access.notification_delivery
          WHERE item_id = $1 AND principal_id = $2 ORDER BY endpoint_id LIMIT $3`,
        [item.id, principalId, NOTIFICATION_LIMITS.endpointsPerRecipient])).rows);
      }
      return { principalId, page: {
        generation: stream.generation, head: stream.head_sequence, reset,
        readThrough: watermark?.read_through ?? '0',
        items: page.map(row => ({ id: row.id, sequence: row.sequence, purpose: row.purpose, topic: row.topic,
          deliveries: deliveries.get(row.id)!,
          state: row.state, read: row.individually_read
            || BigInt(row.sequence) <= BigInt(watermark?.read_through ?? '0'),
          createdAt: row.created_at.toISOString(),
            saved: row.saved,
            done: row.done,
            triageRevision: row.triage_revision,
            reason: null,
            proposal: null,
            subject: null, display: null, raw: row })),
        next: rows.length > limit ? `${stream.generation}:${page.at(-1)!.sequence}` : null,
      } };
    });
    const items: StreamItem[] = [];
    const resolutions: SubjectResolution[] = [];
    const pendingActors: { display: NonNullable<StreamItem['display']>; agent: string }[] = [];
    for (const item of result.items) {
      const { raw, ...base } = item;
      const resolver = this.readSubjects.get(raw.disclosure_basis) ?? this.defaultReadSubject;
      if (!principalId || raw.state !== 'active' || !resolver || (raw.actor_agent || raw.realm)
        && !await notificationRecipientAllowed(this.pool,principalId,raw.actor_agent,raw.realm,raw.group_key)) {
        resolutions.push({ status: 'undisclosed' });
        items.push(base); continue; }
      const resolved = await resolver.resolve({ principalId, owner: raw.subject_owner,
        ref: raw.subject_ref, revision: raw.subject_revision, disclosureBasis: raw.disclosure_basis,
        realm: raw.realm, recipientReason: raw.reason, topic: raw.topic })
        .catch(() => { throw new NotificationUnavailable('subject owner is unavailable'); });
      resolutions.push(resolved);
      if (resolved.status !== 'available') { items.push(base); continue; }
      const fields = resolved.subject.fields;
      const environment = raw.topic === 'new-work' ? disclosurePoolReader(this.pool)?.environment : undefined;
      const newWork = environment && fields.linkTarget ? await notificationNewWorkDisplay(this.pool, {
        principalId, owner: raw.subject_owner, ref: raw.subject_ref, work: fields.linkTarget,
      }, async resources => (await readResourceSummaries(environment, undefined, { viewer: disclosureViewer(principal) }, {
        resources, context: DEFAULT_MEDIA_CONTEXT, language: null, channel: 'inbox',
      })).summaries).catch(() => { throw new NotificationUnavailable('notification display owner is unavailable'); }) : null;
      if (newWork) {
        const current = await resolver.resolve({ principalId, owner: raw.subject_owner,
          ref: raw.subject_ref, revision: raw.subject_revision, disclosureBasis: raw.disclosure_basis,
          realm: raw.realm, recipientReason: raw.reason, topic: raw.topic })
          .catch(() => { throw new NotificationUnavailable('subject owner is unavailable'); });
        if (current.status !== 'available' || current.subject.fields.linkTarget !== fields.linkTarget) {
          resolutions[resolutions.length - 1] = { status: 'undisclosed' };
          items.push(base); continue;
        }
      }
      const sanction = sanctionFromFields(fields);
      const display: StreamItem['display'] = raw.kind || newWork ? { kind: newWork ? 'new_work' : raw.kind!,
        actor: null as NotificationAgentSummary | null, realm: fields.realm ?? null,
        realmName: fields.realmName ?? null, realmRouteSegment: fields.realmRouteSegment ?? null,
        roleName: fields.roleName ?? null,
        roleChange: fields.roleChange === 'given' || fields.roleChange === 'taken' ? fields.roleChange : null,
        ...sanction,
        groupKey: raw.group_key, target: {
          title: fields.title ?? null, excerpt: fields.excerpt ?? null,
          language: fields.language ?? null, linkTarget: fields.linkTarget ?? null,
          reviewId: fields.reviewId ?? null,
          ...(fields.href ? { href: fields.href } : {}),
          ...(newWork ?? {}),
        } } : null;
      // A stored actor from an older ban row is not rendered once the receipt is a sanction.
      if (display && raw.actor_agent && !sanction.membershipAction) pendingActors.push({ display, agent: raw.actor_agent });
      items.push({ ...base,
        reason: raw.reason,
        proposal: raw.proposal ? { id: raw.proposal, revision: raw.proposal_revision! } : null,
        subject: { owner: raw.subject_owner, ref: raw.subject_ref, revision: raw.subject_revision },
        display });
    }
    if (pendingActors.length) {
      const actors = await this.notificationActors(pendingActors.map(item => item.agent),
        disclosureViewer(principal), 'inbox').catch(() => {
        throw new NotificationUnavailable('Agent owner is unavailable');
      });
      for (const item of pendingActors) item.display.actor = actors.get(item.agent) ?? null;
    }
    const checked = await discloseNotifications(this.pool, items.map((item, index) => ({
      input: { principalId: principalId!, owner: result.items[index]!.raw.subject_owner,
        ref: result.items[index]!.raw.subject_ref, revision: result.items[index]!.raw.subject_revision,
        disclosureBasis: result.items[index]!.raw.disclosure_basis, realm: result.items[index]!.raw.realm },
      result: resolutions[index]!,
      })), 'inbox', disclosureViewer(principal));
    const disclosed = items.map((item, index) => checked[index]?.status === 'available'
      ? item : { ...item,
            state:
              item.state === 'active' && result.items[index]!.raw.proposal
                && checked[index]?.status !== 'unavailable'
                ? ('withdrawn' as const)
                : item.state,
            subject: null, display: null,
            reason: null,
            proposal: null });
    return { ...result, items: disclosed, groups: groupNotifications(disclosed) };
  }

  /** Exact visible count through 99; an unusually hidden-heavy inbox fails closed after 256 reads. */
  async unreadCount(principal: VerifiedPrincipal): Promise<{ count: number; overflow: boolean }> {
    const { principalId, rows } = await this.transaction(async client => {
      const principalId = await this.reader(client, principal);
      if (!principalId) return { principalId, rows: [] };
      const rows = (await client.query<{ subject_owner: string; subject_ref: string;
        subject_revision: string | null; disclosure_basis: string; realm: string | null; actor_agent: string | null; group_key: string | null;
        reason: ProposalSubscriptionReason | null; topic: string }>(`SELECT i.subject_owner, i.subject_ref,
          i.subject_revision, i.disclosure_basis, c.realm, c.actor_agent, c.group_key, pc.reason, i.topic FROM access.notification_item i
        JOIN access.notification_stream s ON s.principal_id = i.principal_id AND s.stream = i.stream
          AND s.generation = i.generation
        LEFT JOIN access.notification_read_watermark w ON w.principal_id = i.principal_id
          AND w.stream = i.stream AND w.generation = i.generation
        LEFT JOIN access.notification_item_read r ON r.principal_id = i.principal_id AND r.item_id = i.id
        LEFT JOIN access.notification_display_context c ON c.item_id = i.id
        LEFT JOIN access.notification_proposal_context pc ON pc.item_id = i.id
        WHERE i.principal_id = $1 AND i.stream = 'inbox' AND i.state = 'active'
          AND i.sequence > coalesce(w.read_through, 0) AND r.item_id IS NULL
        ORDER BY i.sequence DESC LIMIT $2`, [principalId, NOTIFICATION_LIMITS.unreadScan + 1])).rows;
      return { principalId, rows };
    });
    const subjects = [];
    for (const row of rows.slice(0, NOTIFICATION_LIMITS.unreadScan)) {
      const resolver = this.readSubjects.get(row.disclosure_basis) ?? this.defaultReadSubject;
      if (!resolver) continue;
      const resolved = await resolver.resolve({ principalId: principalId!, owner: row.subject_owner,
        ref: row.subject_ref, revision: row.subject_revision, disclosureBasis: row.disclosure_basis,
        realm: row.realm, recipientReason: row.reason, topic: row.topic, actorAgent: row.actor_agent, relatedResource: row.group_key })
        .catch(() => { throw new NotificationUnavailable('subject owner is unavailable'); });
      subjects.push({ input: { principalId: principalId!, owner: row.subject_owner, ref: row.subject_ref,
        revision: row.subject_revision, disclosureBasis: row.disclosure_basis, realm: row.realm }, result: resolved });
    }
    const visible = await discloseNotifications(this.pool, subjects, 'inbox', disclosureViewer(principal));
    const count = visible.filter(subject => subject.status === 'available').length;
    if (count >= NOTIFICATION_LIMITS.unreadCap) return { count: 99, overflow: true };
    if (rows.length > NOTIFICATION_LIMITS.unreadScan) {
      throw new NotificationUnavailable('unread count exceeds the disclosure scan bound');
    }
    return { count, overflow: false };
  }

  /** CAS one recipient item's independent triage, preserving omitted flags. */
  async setItemTriage(
    principal: VerifiedPrincipal,
    itemId: string,
    input: {
      saved?: boolean;
      done?: boolean;
      expectedRevision: string | null;
    },
  ): Promise<{ id: string; saved: boolean; done: boolean; revision: string }> {
    if (
      !uuidPattern.test(itemId) ||
      (input.saved === undefined && input.done === undefined) ||
      (input.saved !== undefined && typeof input.saved !== 'boolean') ||
      (input.done !== undefined && typeof input.done !== 'boolean') ||
      (input.expectedRevision !== null && !/^[1-9][0-9]{0,18}$/.test(input.expectedRevision))
    ) {
      throw new NotificationInvalid('invalid triage');
    }
    return this.transaction(async (client) => {
      const principalId = await this.recipient(client, principal, false);
      // Serialize even the first insert; another person's item is indistinguishable from missing.
      if (
        !(
          await client.query(
            `SELECT i.id FROM access.notification_item i
        JOIN access.notification_stream s ON s.principal_id = i.principal_id AND s.stream = i.stream
          AND s.generation = i.generation
        WHERE i.id = $2 AND i.principal_id = $1 AND i.state = 'active' FOR UPDATE OF i`,
            [principalId, itemId],
          )
        ).rowCount
      )
        throw new NotificationDenied('item is unavailable');
      const current = (
        await client.query<{ saved: boolean; done: boolean; revision: string }>(
          `
        SELECT saved,done,revision::text FROM access.notification_item_triage
        WHERE principal_id = $1 AND item_id = $2`,
          [principalId, itemId],
        )
      ).rows[0];
      if ((current?.revision ?? null) !== input.expectedRevision)
        throw new NotificationStale('triage revision changed');
      const saved = input.saved ?? current?.saved ?? false,
        done = input.done ?? current?.done ?? false;
      const revision = current ? (BigInt(current.revision) + 1n).toString() : '1';
      if (current)
        await client.query(
          `UPDATE access.notification_item_triage
        SET saved = $3,done = $4,revision = $5 WHERE principal_id = $1 AND item_id = $2`,
          [principalId, itemId, saved, done, revision],
        );
      else
        await client.query(
          `INSERT INTO access.notification_item_triage (principal_id,item_id,saved,done)
        VALUES ($1,$2,$3,$4)`,
          [principalId, itemId, saved, done],
        );
      return { id: itemId, saved, done, revision };
    });
  }

  /** Constant proposal/key reads plus one exact current disclosure check and one CAS write. */
  private async readableProposalRecipient(
    principal: VerifiedPrincipal,
    proposal: string,
  ): Promise<string> {
    if (!uuidPattern.test(proposal)) throw new NotificationInvalid('invalid proposal');
    const { principalId, revision } = await this.transaction(async (client) => ({
      principalId: await this.reader(client, principal),
      revision: (
        await client.query<{ n: number }>(
          `SELECT n FROM access.editorial_revision
        WHERE proposal = $1 ORDER BY n DESC LIMIT 1`,
          [proposal],
        )
      ).rows[0],
    }));
    const resolver = this.readSubjects.get('editorial-proposal-v1');
    if (!principalId || !revision || !resolver)
      throw new NotificationDenied('proposal is unavailable');
    const subject = await resolver
      .resolve({
        principalId,
        owner: 'access',
        ref: proposal,
        revision: String(revision.n),
        disclosureBasis: 'editorial-proposal-v1',
      })
      .catch(() => {
        throw new NotificationUnavailable('proposal owner is unavailable');
      });
    if (subject.status === 'unavailable')
      throw new NotificationUnavailable('proposal owner is unavailable');
    if (subject.status !== 'available') throw new NotificationDenied('proposal is unavailable');
    return principalId;
  }

  /** A readable proposal's own watch state, including its CAS token. */
  async readProposalSubscription(principal: VerifiedPrincipal, proposal: string) {
    const principalId = await this.readableProposalRecipient(principal, proposal);
    return this.transaction(async (client) => {
      await this.recipient(client, principal, false);
      const row = (
        await client.query<{
          reason: ProposalSubscriptionReason;
          level: 'participating' | 'all' | 'ignore';
          revision: string;
        }>(
          `
        SELECT reason,level,revision::text FROM access.watch
        WHERE principal_id = $1 AND proposal = $2`,
          [principalId, proposal],
        )
      ).rows[0];
      // The existing proposal transport has a binary Watch toggle. Generic
      // Watch reads expose the native level; this adapter keeps its on state.
      return { proposal, subscription: row ? { ...row, level: row.level === 'all' ? 'participating' as const : row.level } : null };
    });
  }

  async setProposalSubscription(
    principal: VerifiedPrincipal,
    proposal: string,
    input: {
      level: 'participating' | 'all' | 'ignore';
      expectedRevision: string | null;
    },
  ): Promise<{
    proposal: string;
    level: 'participating' | 'all' | 'ignore';
    reason: ProposalSubscriptionReason;
    revision: string;
  }> {
    if (
      !uuidPattern.test(proposal) ||
      !['participating', 'all', 'ignore'].includes(input.level) ||
      (input.expectedRevision !== null && !/^[1-9][0-9]{0,18}$/.test(input.expectedRevision))
    ) {
      throw new NotificationInvalid('invalid proposal subscription');
    }
    const principalId = await this.readableProposalRecipient(principal, proposal);
    return this.transaction(async (client) => {
      await this.recipient(client, principal, false);
      // A per-key lock also serializes the absent/manual subscription case.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `proposal-subscription:${principalId}:${proposal}`,
      ]);
      const current = (
        await client.query<{ reason: ProposalSubscriptionReason; revision: string }>(
          `
        SELECT reason,revision::text FROM access.watch
        WHERE principal_id = $1 AND proposal = $2 FOR UPDATE`,
          [principalId, proposal],
        )
      ).rows[0];
      if ((current?.revision ?? null) !== input.expectedRevision)
        throw new NotificationStale('subscription revision changed');
      const reason = current?.reason ?? 'manual',
        next = current ? (BigInt(current.revision) + 1n).toString() : '1';
      const level = reason === 'manual' && input.level === 'participating' ? 'all' : input.level;
      if (current) await client.query(`UPDATE access.watch
        SET level = $3,revision = $4,manual_choice=true WHERE principal_id = $1 AND proposal = $2`,
      [principalId,proposal,level,next]);
      else if (!(await client.query(`INSERT INTO access.watch (principal_id,proposal,reason,level)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING principal_id`,
      [principalId,proposal,reason,level])).rowCount) {
        throw new NotificationStale('automatic subscription appeared');
      }
      return { proposal, reason, level: input.level, revision: next };
    });
  }

  /** Mark one current-generation item; repeated requests return the first read time. */
  async markItemRead(principal: VerifiedPrincipal, itemId: string): Promise<{ id: string; readAt: string }> {
    if (!uuidPattern.test(itemId)) throw new NotificationInvalid('invalid item id');
    return this.transaction(async client => {
      const principalId = await this.recipient(client, principal, false);
      const row = (await client.query<{ read_at: Date }>(`WITH current_item AS (
        SELECT i.id FROM access.notification_item i
        JOIN access.notification_stream s ON s.principal_id = i.principal_id AND s.stream = i.stream
          AND s.generation = i.generation
        WHERE i.id = $2 AND i.principal_id = $1 AND i.state = 'active'
      ), inserted AS (
        INSERT INTO access.notification_item_read (principal_id, item_id)
        SELECT $1, id FROM current_item ON CONFLICT DO NOTHING RETURNING read_at
      ) SELECT read_at FROM inserted UNION ALL
        SELECT r.read_at FROM access.notification_item_read r
        JOIN current_item i ON i.id = r.item_id
        WHERE r.principal_id = $1 AND r.item_id = $2
        LIMIT 1`, [principalId, itemId])).rows[0];
      if (!row) throw new NotificationDenied('item is unavailable');
      return { id: itemId, readAt: row.read_at.toISOString() };
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
      await client.query('SELECT pg_notify($1, $2)', [NOTIFICATION_REALTIME_CHANNEL,
        JSON.stringify({ principalId, generation: updated.rows[0].generation, head: '0' })]);
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
      await client.query('DELETE FROM access.notification_digest_candidate WHERE principal_id = ANY($1::uuid[])',
        [principalIds]);
      await client.query('DELETE FROM access.notification_digest_day WHERE principal_id = ANY($1::uuid[])',
        [principalIds]);
      await client.query('DELETE FROM access.notification_seen WHERE principal_id = ANY($1::uuid[])',
        [principalIds]);
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
