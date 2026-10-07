import type { Pool, PoolClient } from 'pg';
import { recordWorkerOutcome, withWorkerTelemetry } from '@rezics/observability/runtime';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import type { NotificationEvent, NotificationStore } from '../notification/store.ts';
import { requireAccessOpen } from '../notification/store.ts';
import { reviewNotification } from '../notification/producer-review.ts';
import { RealmReplyContentStore } from '../realm-reply/content-store.ts';
import { editorialNotification, EDITORIAL_NOTIFICATION_COST } from './editorial.ts';
import { SafetyNoticeContinuation } from '../governance/notices-mail.ts';
import type { EditorialEvent } from '../editorial-review/store.ts';
import type { RelationshipRecipients } from '../follows/recipients.ts';
import { recoverSpaceFollows } from '../follows/recovery.ts';
import { recoverLibraryFollows } from '../library/follows.ts';
import { resourceNotification } from './resources.ts';
import { normalizeAddressAlias } from '@rezics/model/address/aliases';
import type { SavedViewNotifications } from './saved-views.ts';
import { notificationProducerEventsSql } from './access-log.ts';
import { observeHorizonLag } from '../horizon/lag.ts';

/** One indexed commit-safe source page and at most 256 inbox writes per audience batch. */
export const PRODUCER_COST = { accessEventsPerTick: 16, relayEventsPerBatch: 256,
  recipientsPerEvent: 256, pollMs: 1_000 } as const;
const cursorName = 'notification-producer-v1';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type AccessKind = 'submission_decision' | 'moderation_outcome' | 'realm_role_change'
  | 'realm_membership_change' | 'review_created' | 'review_helpful_milestone' | 'realm_invitation'
  | 'chapter_published' | 'feed_post_vote';
interface AccessCursor { epoch: string; xid: string; id: string }
interface AccessEvent extends AccessCursor { kind: AccessKind; event_id: string }
interface RelayEnvelope { id: string; type: string; data: { receipt?: Record<string, unknown> } }

/** The follow owner can call this hook with its durable follow event. */
export type FollowNotificationHook = (event: NotificationEvent & {
  display: { kind: 'follow'; actorAgent: string; realm: null; groupKey: string | null } }) => Promise<void>;

function representedPlan(agent: string, actor: string | null, action?: string): RelationshipRecipients {
  return { targets: [], highlights: false,
    authorityAudience: { kind: 'represented', agent, actor, action } };
}

async function represented(pool: Pool | PoolClient, agent: string, actor: string | null,
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

export class NotificationProducer {
  private safetyCorrespondence?: { enqueueDecision(decisionId: string): Promise<void> };
  private savedViews?: Pick<SavedViewNotifications, 'run'>;

  setSavedViews(producer: Pick<SavedViewNotifications, 'run'>): void {
    this.savedViews = producer;
  }

  setSafetyCorrespondence(sender: { enqueueDecision(decisionId: string): Promise<void> }): void {
    this.safetyCorrespondence = sender;
  }
  constructor(private readonly access: Pool, private readonly relay: Pool | null,
    private readonly content: Pool, private readonly graph: Pick<FusekiClient, 'query'>,
    private readonly notifications: Pick<NotificationStore, 'enqueue'>,
    private readonly relayConsumer: string | null,
    private readonly relayCheckpoint: Pool | null = relay,
    private readonly safetyAlerts?: { runOnce(): Promise<number> }) {}

  async observeLag(): Promise<void> { await observeHorizonLag(this.access); }

  /** Source and recipient identities are read after their owner commits. */
  private async accessNotification(event: AccessEvent, client: PoolClient): Promise<NotificationEvent | null> {
    if (event.kind === 'chapter_published') {
      const row = (await client.query<{ activity: string; work: string; author: string;
        content_revision: string }>(`SELECT activity, work, author, content_revision
        FROM access.chapter_notification_event WHERE id = $1`, [event.event_id])).rows[0];
      if (!row) return null;
      const authors = new Set(await represented(client, row.author, null));
      const language = (await this.content.query<{ language_tag: string | null }>(`SELECT v.language_tag
        FROM content.revision r JOIN content.variant v ON v.id=r.variant_id WHERE r.id=$1`,
      [row.content_revision.replace(/^urn:rezics:content:revision:/,'')])).rows[0]?.language_tag;
      const relationshipPlan: RelationshipRecipients = { targets: [row.work,row.author],highlights: false,
        except: [...authors],languages: language ? [language] : [] };
      return { sourceOwner: 'access', sourceEvent: `chapter:${event.event_id}`,
        purpose: 'subscription', topic: 'followed-chapter',
        subject: { owner: 'graph', ref: row.activity, revision: row.content_revision },
        disclosureBasis: 'followed-chapter-v1', recipients: [], relationshipPlan,
        display: { kind: 'chapter', actorAgent: row.author, realm: null, groupKey: row.work } };
    }
    if (event.kind === 'feed_post_vote') {
      const row = (await client.query<{ target: string; author: string; voter: string;
        voter_principal: string; vote_revision: string }>(`SELECT e.target, e.author, e.voter,
          e.voter_principal::text, e.vote_revision::text FROM access.feed_post_vote_event e
          JOIN access.feed_vote v ON v.principal_id = e.voter_principal AND v.target = e.target
            AND v.revision = e.vote_revision AND v.value <> 0 WHERE e.id = $1`, [event.event_id])).rows[0];
      if (!row) return null;
      return { sourceOwner: 'access', sourceEvent: `post-vote:${event.event_id}`,
        purpose: 'social', topic: 'post-vote',
        subject: { owner: 'graph', ref: row.target, revision: row.vote_revision },
        disclosureBasis: 'post-vote-v1', recipients: [],
        relationshipPlan: representedPlan(row.author, row.voter_principal),
        display: { kind: 'post_vote', actorAgent: row.voter, realm: null, groupKey: row.target } };
    }
    if (event.kind === 'realm_invitation') {
      const row = (await client.query<{ realm: string; member: string; inviter: string;
        principal_id: string }>(`SELECT realm, member, inviter, principal_id
        FROM access.realm_invitation WHERE id = $1 AND state = 'pending'
          AND expires_at > clock_timestamp()`, [event.event_id])).rows[0];
      if (!row) return null;
      return { sourceOwner: 'access', sourceEvent: `realm-invitation:${event.event_id}`,
        purpose: 'governance', topic: 'realm-invitation',
        subject: { owner: 'access', ref: event.event_id, revision: null },
        disclosureBasis: 'realm-invitation-v1', recipients: [],
        relationshipPlan: representedPlan(row.member, row.principal_id),
        display: { kind: 'realm_invitation', actorAgent: row.inviter,
          realm: row.realm, groupKey: null } };
    }
    if (event.kind === 'review_created' || event.kind === 'review_helpful_milestone') {
      return reviewNotification(client, this.graph, event.kind, event.event_id);
    }
    if (event.kind === 'submission_decision') {
      const row = (await client.query<{ id: string; realm: string; work: string;
        submitting_agent: string; reviewer: string; state: string; actor: string }>(`
        SELECT s.id, s.realm, s.work, s.submitting_agent, s.reviewer, s.state,
          a.principal_id AS actor FROM access.realm_submission_revision h
        JOIN access.realm_submission s ON s.id = h.submission_id
        JOIN access.admission a ON a.id = (h.snapshot->>'decision_operation')::uuid
        WHERE h.revision = $1 AND h.snapshot->>'state' IN ('accepted','rejected','changes-requested')`,
      [event.event_id])).rows[0];
      if (!row) return null;
      if (row.submitting_agent === row.reviewer) return null;
      return { sourceOwner: 'access', sourceEvent: `submission:${event.event_id}`,
        purpose: 'governance', topic: 'submission-decision',
        subject: { owner: 'access', ref: row.id, revision: event.event_id },
        disclosureBasis: 'submission-decision-v1', recipients: [],
        relationshipPlan: representedPlan(row.submitting_agent, row.actor, 'submission.submit'),
        display: { kind: 'submission_decision', actorAgent: row.reviewer, realm: row.realm, groupKey: row.id } };
    }
    if (event.kind === 'moderation_outcome') {
      const row = (
        await client.query<{
          case_id: string;
          principal_id: string;
          acting_subject: string;
          context: string;
          target_resource: string;
          statement_of_reasons: unknown;
        }>(
          `
        SELECT d.case_id, d.principal_id, d.acting_subject, d.context,
          c.target_resource, d.statement_of_reasons FROM access.moderation_decision d
        JOIN access.governance_case c ON c.id = d.case_id
        WHERE d.id = $1 AND c.decision_head = d.id
          AND NOT EXISTS (SELECT 1 FROM access.safety_decision_operation op
            WHERE op.decision_id = d.id AND op.cancelled)`,
          [event.event_id],
        )
      ).rows[0];
      if (!row) return null;
      // Safety decisions use their recorded private parties, including targets
      // withdrawn by enforcement. Legacy decisions discover authors serially.
      const relationshipPlan: RelationshipRecipients = { targets: [], highlights: false,
        authorityAudience: { kind: 'moderation', decision: event.event_id,
          caseId: row.case_id, actor: row.principal_id,
          nextAuthor: row.statement_of_reasons ? undefined
            : after => this.nextContributionAuthor(row.target_resource, after, row.acting_subject) } };
      return {
        sourceOwner: 'access',
        sourceEvent: `moderation:${event.event_id}`,
        purpose: 'governance',
        topic: 'moderation-outcome',
        subject: { owner: 'access', ref: event.event_id, revision: null },
        disclosureBasis: 'moderation-outcome-v1',
        recipients: [], relationshipPlan,
        display: {
          kind: 'moderation_outcome',
          actorAgent: row.acting_subject,
          realm: native.test(row.context) ? row.context : null,
          groupKey: row.case_id,
        },
      };
    }
    const row = (await client.query<{ realm: string; principal_id: string;
      acting_subject: string }>(`SELECT realm, principal_id, acting_subject
      FROM access.realm_admin_receipt WHERE id = $1`, [event.event_id])).rows[0];
    if (!row) return null;
    const relationshipPlan: RelationshipRecipients = { targets: [], highlights: false,
      authorityAudience: { kind: 'realm', receipt: event.event_id,
        actor: row.principal_id, actingSubject: row.acting_subject } };
    return { sourceOwner: 'access', sourceEvent: `realm:${event.event_id}`,
      purpose: 'governance', topic: event.kind === 'realm_role_change'
        ? 'realm-role-change' : 'realm-membership-change',
      subject: { owner: 'access', ref: event.event_id, revision: null },
      disclosureBasis: 'realm-role-change-v1', recipients: [], relationshipPlan,
      display: { kind: 'realm_role_change', actorAgent: row.acting_subject,
        realm: row.realm, groupKey: row.realm } };
  }

  private async nextContributionAuthor(resource: string, after: string | null,
    actor: string): Promise<string | null> {
    if (!native.test(resource)) return null;
    const rows = (await this.graph.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?author WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?contribution a rv:TextContribution ;
        rv:author ?author ; rv:publicationHead ?decision .
        { ?contribution rv:work ${iri(resource)} } UNION
        { FILTER(?contribution = ${iri(resource)}) } }
      GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:disclosure rv:Public . }
      FILTER(REGEX(STR(?author), "^https://rezics[.]com/id/[0-9a-f-]{36}$"))
      FILTER(?author != ${iri(actor)})
      ${after ? `FILTER(STR(?author) > ${lit(after)})` : ''}
    } ORDER BY STR(?author) LIMIT 1`, 16_384)).results?.bindings ?? [];
    return rows[0]?.author?.value ?? null;
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
    } LIMIT 2`, 16_384)).results?.bindings ?? [];
    return rows.map(row => row.author?.value ?? '').filter(author => native.test(author));
  }

  async runAccessOnce(): Promise<number> {
    let mail = 0;
    try {
      mail = await this.runSafetyCorrespondenceOnce();
    } catch {
      // Account intake has an independent cursor: an outage cannot hold staff
      // deadline alerts, editorial mail or relay notifications behind it.
      console.error('Safety correspondence intake unavailable');
      recordWorkerOutcome({ outcome: 'deferred' });
    }
    const count = (await this.runOtherAccessOnce()) + (await this.runEditorialOnce());
    try {
      return count + mail + ((await this.safetyAlerts?.runOnce()) ?? 0);
    } catch (error) {
      // A missing responder or failed safety intake must not stall the other
      // Access producers or prevent the worker's following relay tick.
      console.error('Safety alerts:', error);
      recordWorkerOutcome({ outcome: 'deferred' });
      return count + mail;
    }
  }

  async runRelationshipRecoveryOnce(): Promise<number> {
    // Bounded expiry batches; no feed writer or global head is involved.
    await this.access.query(`DELETE FROM access.watch WHERE (principal_id,target) IN
      (SELECT principal_id,target FROM access.watch WHERE kind='thread' AND reason<>'manual' AND NOT manual_choice
        AND changed_at<clock_timestamp()-interval '90 days' ORDER BY changed_at,principal_id,target LIMIT 256)`);
    await this.access.query(`DELETE FROM access.follow_activity WHERE target IN
      (SELECT target FROM access.follow_activity WHERE activity_at<clock_timestamp()-interval '90 days'
        ORDER BY activity_at,target LIMIT 256)`);
    await this.access.query(`DELETE FROM access.notification_recipient_progress WHERE (source_owner,source_event,topic) IN
      (SELECT source_owner,source_event,topic FROM access.notification_recipient_progress
        WHERE complete AND updated_at<clock_timestamp()-interval '30 days' ORDER BY updated_at LIMIT 256)`);
    let count = 0;
    for (const recover of [() => recoverSpaceFollows(this.access,this.graph),
      () => recoverLibraryFollows(this.content,this.access)]) {
      try { count += await recover(); }
      catch (error) { console.warn('Relationship recovery deferred', error); }
    }
    return count;
  }

  private async runOtherAccessOnce(): Promise<number> {
    const client = await this.access.connect();
    let count = 0;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      await requireAccessOpen(client);
      await client.query(`INSERT INTO access.notification_producer_cursor (consumer)
        VALUES ($1) ON CONFLICT DO NOTHING`, [cursorName]);
      const cursor = (await client.query<AccessCursor>(`SELECT epoch::text, xid::text, id::text
        FROM access.notification_producer_cursor WHERE consumer = $1 FOR UPDATE SKIP LOCKED`,
      [cursorName])).rows[0];
      if (!cursor) { await client.query('COMMIT'); return 0; }
      const events = (await client.query<AccessEvent>(notificationProducerEventsSql,
      [cursor.epoch, cursor.xid, cursor.id, PRODUCER_COST.accessEventsPerTick])).rows;
      for (const event of events) {
        const notice = await this.accessNotification(event, client);
        if (notice && (await this.notifications.enqueue(notice, client))?.complete === false) { count++; break; }
        await client.query(`UPDATE access.notification_producer_cursor
          SET epoch = $2, xid = $3, id = $4, updated_at = clock_timestamp() WHERE consumer = $1`,
        [cursorName, event.epoch, event.xid, event.id]);
        count++;
        await client.query('COMMIT');
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '10s'");
        await requireAccessOpen(client);
        const current = (await client.query<AccessCursor>(`SELECT epoch::text,xid::text,id::text
          FROM access.notification_producer_cursor WHERE consumer=$1 FOR UPDATE SKIP LOCKED`, [cursorName])).rows[0];
        if (!current || current.epoch !== event.epoch || current.xid !== event.xid || current.id !== event.id) break;
      }
      await client.query('COMMIT');
      return count;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Separate durable position; only queue intake advances it. Incomplete or
   * lost acknowledgements replay the immutable private delivery identities. */
  async runSafetyCorrespondenceOnce(): Promise<number> {
    if (!this.safetyCorrespondence) return 0;
    const consumer = 'safety-correspondence-v1';
    await requireAccessOpen(this.access);
    const cursor = (await this.access.query<AccessCursor>(`SELECT epoch::text,xid::text,id::text
      FROM access.notification_producer_cursor WHERE consumer=$1`, [consumer])).rows[0]
      ?? { epoch: '0', xid: '0', id: '0' };
    const events = (await this.access.query<AccessEvent>(notificationProducerEventsSql,
      [cursor.epoch, cursor.xid, cursor.id, PRODUCER_COST.accessEventsPerTick])).rows;
    let checkpointed = 0;
    for (const event of events) {
      if (event.kind === 'moderation_outcome') {
        try {
          await this.safetyCorrespondence.enqueueDecision(event.event_id);
        } catch (error) {
          if (!(error instanceof SafetyNoticeContinuation)) throw error;
          // One committed page is progress. This event stays at the cursor so
          // the next tick resumes its remaining pages, and later events wait.
          return checkpointed + 1;
        }
      }
      // Concurrent replays share immutable intake identities. A checkpoint may
      // advance only after intake, and an older acknowledgement cannot rewind it.
      const client = await this.access.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '10s'");
        await requireAccessOpen(client);
        await client.query(`INSERT INTO access.notification_producer_cursor(consumer,epoch,xid,id)
          VALUES($1,$2,$3,$4) ON CONFLICT(consumer) DO UPDATE
          SET epoch=EXCLUDED.epoch,xid=EXCLUDED.xid,id=EXCLUDED.id,updated_at=clock_timestamp()
          WHERE (notification_producer_cursor.epoch,notification_producer_cursor.xid,notification_producer_cursor.id)
            < (EXCLUDED.epoch,EXCLUDED.xid,EXCLUDED.id)`, [consumer,event.epoch,event.xid,event.id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
      checkpointed++;
    }
    return checkpointed;
  }

  /** Cursor advances only after every recipient intake commits. Partial retries
   * deduplicate by the immutable editorial event id, just like the other sources. */
  async runEditorialOnce(): Promise<number> {
    await this.access.query('SELECT access.sequence_editorial_events($1)',
      [EDITORIAL_NOTIFICATION_COST.eventsPerTick]);
    const client = await this.access.connect();
    let count = 0;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      await requireAccessOpen(client);
      const cursor = (
        await client.query<{ position: string }>(`SELECT position::text
        FROM access.notification_producer_cursor WHERE consumer = 'editorial-notification-v1'
        FOR UPDATE SKIP LOCKED`)
      ).rows[0];
      if (!cursor) {
        await client.query('COMMIT');
        return 0;
      }
      const events = (
        await client.query<EditorialEvent>(
          `SELECT e.sequence::text,e.id,e.proposal,e.revision,e.kind,e.actor,
        e.created_at::text AS "occurredAt" FROM access.editorial_event e WHERE e.sequence > $1
        ORDER BY e.sequence LIMIT $2`,
          [cursor.position, EDITORIAL_NOTIFICATION_COST.eventsPerTick],
        )
      ).rows;
      for (const event of events) {
        const notice = await editorialNotification(client, event);
        count++;
        if (notice && (await this.notifications.enqueue(notice, client))?.complete === false) break;
        await client.query(
          `UPDATE access.notification_producer_cursor SET position = $1,
          updated_at = clock_timestamp() WHERE consumer = 'editorial-notification-v1'`,
          [event.sequence],
        );
        await client.query('COMMIT');
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '10s'");
        await requireAccessOpen(client);
        const current = (await client.query<{ position: string }>(`SELECT position::text
          FROM access.notification_producer_cursor WHERE consumer='editorial-notification-v1'
          FOR UPDATE SKIP LOCKED`)).rows[0];
        if (!current || current.position !== event.sequence) break;
      }
      await client.query('COMMIT');
      return count;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  private async replyNotifications(envelope: RelayEnvelope): Promise<NotificationEvent[]> {
    if (envelope.type !== 'com.rezics.realm.reply-placed.v1') return [];
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
    const actor = (await this.access.query<{ principal_id: string }>(`
      SELECT principal_id FROM access.admission WHERE id = $1`, [admission])).rows[0]?.principal_id;
    if (!actor) throw new Error('reply admission is unavailable');
    const events: NotificationEvent[] = [];
    const event = (topic: string, recipients: string[]): NotificationEvent => ({ sourceOwner: 'graph',
      sourceEvent: envelope.id, purpose: 'social', topic,
      subject: { owner: 'graph', ref: reply as string, revision: revision as string },
      disclosureBasis: 'realm-reply-v1', recipients,
      display: { kind: 'reply', actorAgent: author as string, realm: realm as string,
        groupKey: topic === 'mention' ? `mention:${reply}`
          : typeof parent === 'string' ? parent : root as string } });
    if (targetAuthor && targetAuthor !== author) {
      const recipients = await represented(this.access, targetAuthor, actor);
      if (recipients.length) events.push(event('reply', recipients));
    }
    const current = await new RealmReplyContentStore(this.content).readCurrent(reply as string);
    if (current && current.author === author && revision === `urn:rezics:content:revision:${current.revisionId}`) {
      const handles = [...new Set([...current.body.matchAll(/(?:^|[^\p{L}\p{N}_-])@([a-z0-9_-]+)(?![\p{L}\p{N}_-])/giu)]
        .flatMap(match => {
          try { return [normalizeAddressAlias(match[1]!, 'ascii-handle').key]; }
          catch { return []; }
        }))].slice(0, 20);
      if (handles.length) {
        const mentioned = (await this.access.query<{ agent_id: string }>(`SELECT holder AS agent_id
          FROM access.alias_registry WHERE scope = 'agent' AND key = ANY($1::text[]) AND state = 'current'
          ORDER BY holder LIMIT 21`, [handles])).rows;
        if (mentioned.length > 20) throw new Error('mention target bound exceeded');
        const recipients = new Set<string>();
        for (const agent of mentioned) {
          if (agent.agent_id === author) continue;
          for (const id of await represented(this.access, agent.agent_id, actor)) recipients.add(id);
        }
        if (recipients.size > PRODUCER_COST.recipientsPerEvent) throw new Error('mention recipient bound exceeded');
        if (recipients.size) events.push(event('mention', [...recipients]));
      }
    }
    const direct = [...new Set(events.filter(notice => notice.topic === 'reply').flatMap(notice => [...notice.recipients]))];
    const participants = await represented(this.access,author as string,null,'agent.control');
    const watchTargets = [root as string, ...typeof parent === 'string' ? [parent] : []];
    if (participants.length) {
      await this.access.query(`INSERT INTO access.watch(principal_id,target,kind,reason,level)
        SELECT id,target,'thread','reviewer','participating' FROM unnest($1::uuid[]) id
          CROSS JOIN unnest($2::text[]) target ON CONFLICT DO NOTHING`, [participants,watchTargets]);
      await this.access.query(`INSERT INTO access.watch_participation(principal_id,target)
        SELECT principal_id,target FROM access.watch WHERE principal_id=ANY($1::uuid[]) AND target=ANY($2::text[])
        ON CONFLICT DO NOTHING`, [participants,watchTargets]);
    }
    const relationshipPlan: RelationshipRecipients = { targets: [realm as string,author as string],
      highlights: false, watches: watchTargets,
      except: [actor,...direct] };
    events.push({ ...event('reply',[]), disclosureBasis: 'relationship-reply-v1', relationshipPlan });
    return events;
  }

  async runRelayOnce(): Promise<number> {
    return this.runRelayConsumerOnce(cursorName);
  }

  /** Matching can need several ticks or wait for a query owner. Its durable
   * cursor must not hold direct replies and mentions behind that work. */
  async runSavedViewsRelayOnce(): Promise<number> {
    if (!this.savedViews) return 0;
    return this.runRelayConsumerOnce('notification-saved-views-v1', true);
  }

  private async runRelayConsumerOnce(consumer: string, savedViewsOnly = false): Promise<number> {
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
        VALUES ($1, $2) ON CONFLICT DO NOTHING`, [consumer, upstream.data_epoch]);
      const cursor = (await client.query<{ data_epoch: string; sequence: string }>(`
        SELECT data_epoch, sequence::text FROM relay.notification_producer_cursor
        WHERE consumer = $1 FOR UPDATE SKIP LOCKED`, [consumer])).rows[0];
      if (!cursor) { await client.query('COMMIT'); return 0; }
      if (cursor.data_epoch !== upstream.data_epoch) {
        // A restored source starts a new epoch. Replaying its batches is safe:
        // Access deduplicates each recipient by the immutable event identity.
        await client.query(`UPDATE relay.notification_producer_cursor SET data_epoch = $2,
          sequence = 0, updated_at = clock_timestamp() WHERE consumer = $1`,
        [consumer, upstream.data_epoch]);
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
      let pending = false;
      for (const event of events) {
        if (savedViewsOnly) {
          const matched = await this.savedViews!.run(event.envelope);
          produced += matched.produced;
          if (!matched.complete) { pending = true; break; }
          continue;
        }
        const resource = await resourceNotification(this.access,this.graph,event.envelope);
        if (resource) {
          const result = await this.notifications.enqueue(resource);
          if (!result || result.length || result.complete === false) produced++;
          if (result?.complete === false) { pending = true; break; }
        }
        for (const notice of await this.replyNotifications(event.envelope)) {
          const result = await this.notifications.enqueue(notice);
          if (!result || result.length || result.complete === false) produced++;
          if (result?.complete === false) { pending = true; break; }
        }
        if (pending) break;
      }
      if (!pending) await client.query(`UPDATE relay.notification_producer_cursor SET sequence = $2,
        updated_at = clock_timestamp() WHERE consumer = $1`, [consumer, batch.sequence]);
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
  setSavedViews(producer: Pick<SavedViewNotifications, 'run'>): void {
    this.producer.setSavedViews(producer);
  }
  setSafetyCorrespondence(sender: { enqueueDecision(decisionId: string): Promise<void> }): void {
    this.producer.setSafetyCorrespondence(sender);
  }
  start(): void {
    if (this.timer) throw new Error('notification producer worker is already started');
    const poll = () => {
      if (this.running) return;
      this.running = withWorkerTelemetry('main.notification.producer', async () => {
        await this.producer.observeLag().catch(() => {
          console.warn('Horizon lag observation unavailable');
          recordWorkerOutcome({ outcome: 'deferred' });
        });
        await this.producer.runRelationshipRecoveryOnce().catch(error => { console.warn('Relationship recovery paused',error); });
        const access = await this.producer.runAccessOnce();
        const relay = await this.producer.runRelayOnce();
        let matched = 0;
        try { matched = await this.producer.runSavedViewsRelayOnce(); }
        catch (error) { console.warn('Saved view notifications deferred', error); recordWorkerOutcome({ outcome: 'deferred' }); }
        return access + relay + matched;
      }, count => ({ outcome: count ? 'worked' : 'idle', processed: count, unit: 'item' }))
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
