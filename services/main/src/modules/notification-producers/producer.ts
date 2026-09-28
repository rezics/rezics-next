import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import type { NotificationEvent, NotificationStore } from '../notification/store.ts';
import { reviewNotification } from '../notification/producer-review.ts';

/** One serialized source position, one bounded owner read and at most 256 inbox writes per event. */
export const PRODUCER_COST = { accessEventsPerTick: 16, relayEventsPerBatch: 256,
  recipientsPerEvent: 256, pollMs: 1_000 } as const;
const cursorName = 'notification-producer-v1';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type AccessKind = 'submission_decision' | 'moderation_outcome' | 'realm_role_change'
  | 'realm_membership_change' | 'review_created' | 'review_helpful_milestone' | 'realm_invitation';
interface AccessEvent { position: string; kind: AccessKind; event_id: string }
interface RelayEnvelope { id: string; type: string; data: { receipt?: Record<string, unknown> } }

/** The follow owner can call this hook with its durable follow event. */
export type FollowNotificationHook = (event: NotificationEvent & {
  display: { kind: 'follow'; actorAgent: string; realm: null; groupKey: string | null } }) => Promise<void>;

async function represented(pool: Pool, agent: string, actor: string | null,
  action?: string): Promise<string[]> {
  if (!native.test(agent)) return [];
  const rows = (await pool.query<{ id: string }>(`SELECT DISTINCT p.id FROM access.representation r
    JOIN access.principal p ON p.id = r.principal_id AND p.active
    JOIN access.authority_subject s ON s.id = r.subject_id AND s.active AND s.kind = 'agent'
    WHERE r.subject_id = $1 AND r.active AND r.valid_until > clock_timestamp()
      AND ($2::uuid IS NULL OR p.id <> $2) AND ($3::text IS NULL OR r.action = $3)
    ORDER BY p.id LIMIT $4`, [agent, actor, action ?? null, PRODUCER_COST.recipientsPerEvent + 1])).rows;
  if (rows.length > PRODUCER_COST.recipientsPerEvent) throw new Error('notification recipient bound exceeded');
  return rows.map(row => row.id);
}

function agentsInImpact(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const result = value as { member?: unknown; impact?: { changes?: { member?: unknown }[] } };
  if (typeof result.member === 'string') return native.test(result.member) ? [result.member] : [];
  return Array.isArray(result.impact?.changes) ? [...new Set(result.impact.changes
    .map(change => change.member).filter((member): member is string => typeof member === 'string' && native.test(member)))] : [];
}

export class NotificationProducer {
  constructor(private readonly access: Pool, private readonly relay: Pool | null,
    private readonly content: Pool, private readonly graph: Pick<FusekiClient, 'query'>,
    private readonly notifications: Pick<NotificationStore, 'enqueue'>,
    private readonly relayConsumer: string | null,
    private readonly relayCheckpoint: Pool | null = relay) {}

  /** Source and recipient identities are read after their owner commits. */
  private async accessNotification(event: AccessEvent): Promise<NotificationEvent | null> {
    if (event.kind === 'realm_invitation') {
      const row = (await this.access.query<{ realm: string; member: string; inviter: string;
        principal_id: string }>(`SELECT realm, member, inviter, principal_id
        FROM access.realm_invitation WHERE id = $1 AND state = 'pending'
          AND expires_at > clock_timestamp()`, [event.event_id])).rows[0];
      if (!row) return null;
      const recipients = await represented(this.access, row.member, row.principal_id);
      if (!recipients.length) return null;
      return { sourceOwner: 'access', sourceEvent: `realm-invitation:${event.event_id}`,
        purpose: 'governance', topic: 'realm-invitation',
        subject: { owner: 'access', ref: event.event_id, revision: null },
        disclosureBasis: 'realm-invitation-v1', recipients,
        display: { kind: 'realm_invitation', actorAgent: row.inviter,
          realm: row.realm, groupKey: null } };
    }
    if (event.kind === 'review_created' || event.kind === 'review_helpful_milestone') {
      return reviewNotification(this.access, this.graph, event.kind, event.event_id);
    }
    if (event.kind === 'submission_decision') {
      const row = (await this.access.query<{ id: string; realm: string; work: string;
        submitting_agent: string; reviewer: string; state: string; actor: string }>(`
        SELECT s.id, s.realm, s.work, s.submitting_agent, s.reviewer, s.state,
          a.principal_id AS actor FROM access.realm_submission_revision h
        JOIN access.realm_submission s ON s.id = h.submission_id
        JOIN access.admission a ON a.id = (h.snapshot->>'decision_operation')::uuid
        WHERE h.revision = $1 AND h.snapshot->>'state' IN ('accepted','rejected','changes-requested')`,
      [event.event_id])).rows[0];
      if (!row) return null;
      if (row.submitting_agent === row.reviewer) return null;
      const recipients = await represented(this.access, row.submitting_agent, row.actor, 'submission.submit');
      if (!recipients.length) return null;
      return { sourceOwner: 'access', sourceEvent: `submission:${event.event_id}`,
        purpose: 'governance', topic: 'submission-decision',
        subject: { owner: 'access', ref: row.id, revision: event.event_id },
        disclosureBasis: 'submission-decision-v1', recipients,
        display: { kind: 'submission_decision', actorAgent: row.reviewer, realm: row.realm, groupKey: row.id } };
    }
    if (event.kind === 'moderation_outcome') {
      const row = (await this.access.query<{ case_id: string; principal_id: string;
        acting_subject: string; context: string; target_resource: string }>(`
        SELECT d.case_id, d.principal_id, d.acting_subject, d.context,
          c.target_resource FROM access.moderation_decision d
        JOIN access.governance_case c ON c.id = d.case_id WHERE d.id = $1`, [event.event_id])).rows[0];
      if (!row) return null;
      const reporters = (await this.access.query<{ id: string }>(`
        SELECT DISTINCT p.id FROM access.governance_report r
        JOIN access.principal p ON p.id = r.principal_id AND p.active
        WHERE r.case_id = $1 AND p.id <> $2 ORDER BY p.id LIMIT $3`,
      [row.case_id, row.principal_id, PRODUCER_COST.recipientsPerEvent + 1])).rows;
      if (reporters.length > PRODUCER_COST.recipientsPerEvent) throw new Error('moderation reporter bound exceeded');
      const recipients = new Set(reporters.map(reporter => reporter.id));
      for (const author of await this.contributionAuthors(row.target_resource)) {
        if (author === row.acting_subject) continue;
        for (const id of await represented(this.access, author, row.principal_id)) recipients.add(id);
      }
      if (recipients.size > PRODUCER_COST.recipientsPerEvent) throw new Error('moderation recipient bound exceeded');
      if (!recipients.size) return null;
      return { sourceOwner: 'access', sourceEvent: `moderation:${event.event_id}`,
        purpose: 'governance', topic: 'moderation-outcome',
        subject: { owner: 'access', ref: event.event_id, revision: null },
        disclosureBasis: 'moderation-outcome-v1', recipients: [...recipients],
        display: { kind: 'moderation_outcome', actorAgent: row.acting_subject,
          realm: native.test(row.context) ? row.context : null, groupKey: row.case_id } };
    }
    const row = (await this.access.query<{ realm: string; principal_id: string;
      acting_subject: string; result: unknown }>(`SELECT realm, principal_id, acting_subject, result
      FROM access.realm_admin_receipt WHERE id = $1`, [event.event_id])).rows[0];
    if (!row) return null;
    const effects = event.kind === 'realm_role_change'
      ? (await this.access.query<{ member: string }>(`SELECT member FROM access.notification_realm_effect
        WHERE receipt_id = $1 ORDER BY member LIMIT $2`,
      [event.event_id, PRODUCER_COST.recipientsPerEvent + 1])).rows.map(effect => effect.member) : [];
    if (effects.length > PRODUCER_COST.recipientsPerEvent) throw new Error('Realm effect bound exceeded');
    const members = [...new Set([...effects, ...agentsInImpact(row.result)])]
      .filter(member => member !== row.acting_subject);
    const recipients = new Set<string>();
    for (const member of members) for (const id of await represented(this.access, member, row.principal_id)) {
      recipients.add(id);
    }
    if (recipients.size > PRODUCER_COST.recipientsPerEvent) throw new Error('Realm recipient bound exceeded');
    if (!recipients.size) return null;
    return { sourceOwner: 'access', sourceEvent: `realm:${event.event_id}`,
      purpose: 'governance', topic: event.kind === 'realm_role_change'
        ? 'realm-role-change' : 'realm-membership-change',
      subject: { owner: 'access', ref: event.event_id, revision: null },
      disclosureBasis: 'realm-role-change-v1', recipients: [...recipients],
      display: { kind: 'realm_role_change', actorAgent: row.acting_subject,
        realm: row.realm, groupKey: row.realm } };
  }

  private async contributionAuthors(resource: string, revision?: string): Promise<string[]> {
    if (!native.test(resource)) return [];
    const rows = (await this.graph.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?author WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?contribution a rv:TextContribution ;
        rv:author ?author ; rv:publicationHead ?decision .
        { ?contribution rv:work ${iri(resource)} } UNION
        { FILTER(?contribution = ${iri(resource)}) } }
      GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:disclosure rv:Public .
        ${revision ? `?decision rv:selectedDraft ${iri(revision)} .` : ''} }
    } LIMIT ${PRODUCER_COST.recipientsPerEvent + 1}`, 16_384)).results?.bindings ?? [];
    if (rows.length > PRODUCER_COST.recipientsPerEvent) throw new Error('notification author bound exceeded');
    return rows.map(row => row.author?.value ?? '').filter(author => native.test(author));
  }

  async runAccessOnce(): Promise<number> {
    const client = await this.access.connect();
    let count = 0;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query(`INSERT INTO access.notification_producer_cursor (consumer)
        VALUES ($1) ON CONFLICT DO NOTHING`, [cursorName]);
      const cursor = (await client.query<{ position: string }>(`SELECT position::text
        FROM access.notification_producer_cursor WHERE consumer = $1 FOR UPDATE SKIP LOCKED`,
      [cursorName])).rows[0];
      if (!cursor) { await client.query('COMMIT'); return 0; }
      const events = (await client.query<AccessEvent>(`SELECT position::text, kind, event_id
        FROM access.notification_producer_event WHERE position > $1 ORDER BY position LIMIT $2`,
      [cursor.position, PRODUCER_COST.accessEventsPerTick])).rows;
      for (const event of events) {
        const notice = await this.accessNotification(event);
        if (notice) await this.notifications.enqueue(notice);
        await client.query(`UPDATE access.notification_producer_cursor
          SET position = $2, updated_at = clock_timestamp() WHERE consumer = $1`,
        [cursorName, event.position]);
        count++;
      }
      await client.query('COMMIT');
      return count;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  private async replyNotification(envelope: RelayEnvelope): Promise<NotificationEvent | null> {
    if (envelope.type !== 'com.rezics.realm.reply-placed.v1') return null;
    const receipt = envelope.data.receipt;
    if (!receipt) throw new Error('reply relay event has no receipt');
    const realm = receipt.realm;
    const reply = receipt.reply;
    const root = receipt.rootTarget;
    const rootRevision = receipt.rootRevision;
    const revision = receipt.contentRevision;
    const author = receipt.author;
    const parent = receipt.parentReply;
    const admission = receipt.admissionId;
    if (![realm, reply, root, author].every(value => typeof value === 'string' && native.test(value))
      || typeof rootRevision !== 'string' || typeof revision !== 'string'
      || typeof admission !== 'string' || !uuid.test(admission)) throw new Error('invalid reply relay event');
    let targetAuthor: string | null;
    if (typeof parent === 'string') {
      const parentRow = (await this.content.query<{ author: string }>(`SELECT author FROM content.reply_author
        WHERE reply = $1`, [parent])).rows[0];
      targetAuthor = parentRow?.author ?? null;
    } else {
      const authors = await this.contributionAuthors(root as string, rootRevision as string);
      targetAuthor = authors.length === 1 ? authors[0]! : null;
    }
    if (!targetAuthor || targetAuthor === author) return null;
    const actor = (await this.access.query<{ principal_id: string }>(`
      SELECT principal_id FROM access.admission WHERE id = $1`, [admission])).rows[0]?.principal_id;
    if (!actor) throw new Error('reply admission is unavailable');
    const recipients = await represented(this.access, targetAuthor, actor);
    if (!recipients.length) return null;
    return { sourceOwner: 'graph', sourceEvent: envelope.id, purpose: 'social', topic: 'reply',
      subject: { owner: 'graph', ref: reply as string, revision: revision as string },
      disclosureBasis: 'realm-reply-v1', recipients,
      display: { kind: 'reply', actorAgent: author as string, realm: realm as string,
        groupKey: typeof parent === 'string' ? parent : root as string } };
  }

  async runRelayOnce(): Promise<number> {
    if (!this.relay || !this.relayCheckpoint || !this.relayConsumer) return 0;
    const upstream = (await this.relayCheckpoint.query<{ data_epoch: string; sequence: string }>(`
      SELECT data_epoch, sequence::text FROM relay.checkpoint WHERE consumer = $1`,
    [this.relayConsumer])).rows[0];
    if (!upstream) throw new Error('graph relay checkpoint is unavailable');
    const client: PoolClient = await this.relay.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query(`INSERT INTO relay.notification_producer_cursor (consumer, data_epoch)
        VALUES ($1, $2) ON CONFLICT DO NOTHING`, [cursorName, upstream.data_epoch]);
      const cursor = (await client.query<{ data_epoch: string; sequence: string }>(`
        SELECT data_epoch, sequence::text FROM relay.notification_producer_cursor
        WHERE consumer = $1 FOR UPDATE SKIP LOCKED`, [cursorName])).rows[0];
      if (!cursor) { await client.query('COMMIT'); return 0; }
      if (cursor.data_epoch !== upstream.data_epoch) {
        // A restored source starts a new epoch. Replaying its batches is safe:
        // Access deduplicates each recipient by the immutable event identity.
        await client.query(`UPDATE relay.notification_producer_cursor SET data_epoch = $2,
          sequence = 0, updated_at = clock_timestamp() WHERE consumer = $1`,
        [cursorName, upstream.data_epoch]);
        cursor.data_epoch = upstream.data_epoch;
        cursor.sequence = '0';
      } else if (BigInt(cursor.sequence) > BigInt(upstream.sequence)) {
        throw new Error('notification cursor exceeds graph relay checkpoint');
      }
      const batch = (await client.query<{ sequence: string; event_count: number }>(`
        SELECT batch.sequence::text, event_count FROM relay.delivered_batch AS batch
        WHERE data_epoch = $1 AND batch.sequence > $2 AND batch.sequence <= $3
        ORDER BY batch.sequence LIMIT 1`,
      [cursor.data_epoch, cursor.sequence, upstream.sequence])).rows[0];
      if (!batch) { await client.query('COMMIT'); return 0; }
      if (batch.event_count > PRODUCER_COST.relayEventsPerBatch) throw new Error('relay event bound exceeded');
      const events = (await client.query<{ envelope: RelayEnvelope }>(`
        SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2
        ORDER BY (envelope->'data'->>'ordinal')::int LIMIT $3`,
      [cursor.data_epoch, batch.sequence, PRODUCER_COST.relayEventsPerBatch + 1])).rows;
      if (events.length !== batch.event_count) throw new Error('relay batch is incomplete');
      let produced = 0;
      for (const event of events) {
        const notice = await this.replyNotification(event.envelope);
        if (notice) { await this.notifications.enqueue(notice); produced++; }
      }
      await client.query(`UPDATE relay.notification_producer_cursor SET sequence = $2,
        updated_at = clock_timestamp() WHERE consumer = $1`, [cursorName, batch.sequence]);
      await client.query('COMMIT');
      return produced;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
}

export class NotificationProducerWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly producer: NotificationProducer) {}
  start(): void {
    if (this.timer) throw new Error('notification producer worker is already started');
    const poll = () => {
      if (this.running) return;
      this.running = this.producer.runAccessOnce().then(() => this.producer.runRelayOnce())
        .then(() => undefined).catch(error => { console.error('Notification producers:', error); })
        .finally(() => { this.running = null; });
    };
    poll();
    this.timer = setInterval(poll, PRODUCER_COST.pollMs);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
