import type { Pool } from 'pg';
import { logWorkerFault } from '@rezics/observability/log';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { FilterDocument } from '../../../../../model/definitions/filter-document-v1.ts';
import { relationshipEligible } from '../follows/recipients.ts';
import { notificationRecipientAllowed } from '../notification/recipient-policy.ts';
import type { NotificationSubjectReader, SubjectResolution } from '../notification/dispatcher.ts';
import { requireAccessOpen, type NotificationEvent, type NotificationStore } from '../notification/store.ts';
import { matchesSavedView, type SavedViewSubject } from '../saved-filter/match.ts';
import { QueryRejected } from '../query/compile.ts';
import { feedSources } from '../feed/source.ts';
import { resolveTargets } from '../target/resolve.ts';
import { iri, GRAPHS } from '../work/activate.ts';
import { workRead, WorkReadMissing, WorkReadSession } from '../work/read-session.ts';

export const SAVED_VIEW_BASES = ['saved-view-work-v1', 'saved-view-post-v1'] as const;
/** Indexed UUID keyset, eight filters and at most eight writes per tick, even
 * when all filters belong to one follower. A page bound is never an inventory cap. */
export const SAVED_VIEW_PRODUCER_COST = { viewsPerPage: 8, recipientsPerView: 1 } as const;
const progressTopic = 'saved-view-matching-v1';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface View { id: string; principal_id: string; document: FilterDocument; target: string | null }
export interface SavedViewEnvelope { id: string; type: string; data: { receipt?: Record<string, unknown> } }

/** Same follow admission for intake and delivery, including Off and paused
 * follows. The filter remains private to the follow's native principal. */
const followForView = `SELECT target FROM access.follow f
    WHERE f.principal_id=v.principal_id AND f.following
      AND (f.target=v.concept OR f.target='urn:rezics:saved-view:'||v.id::text)
      AND (f.level='all' OR ($1 AND f.level='highlights'))
      AND access.follow_space_notifying(f.principal_id,f.target)
      AND p.active ORDER BY target LIMIT 1`;
const views = `SELECT v.id::text, v.principal_id::text, v.document, f.target
  FROM access.saved_filter v JOIN access.principal p ON p.id=v.principal_id AND p.active
  JOIN LATERAL (${followForView}) f ON true`;

export class SavedViewNotifications implements NotificationSubjectReader {
  constructor(private readonly access: Pool, private readonly deps: MainWorkDependencies,
    private readonly notifications: Pick<NotificationStore, 'enqueue'>) {}

  private read<T>(operation: (session: WorkReadSession) => Promise<T>, realm?: string | null) {
    return workRead(this.deps, new Request('http://main.local/internal/saved-view-notification'),
      { limit: 3, ...(realm ? { scope: 'realm', realm } : {}) }, operation);
  }

  private async subject(session: WorkReadSession, kind: SavedViewSubject['kind'], ref: string): Promise<SavedViewSubject | null> {
    if (kind === 'work') {
      const target = (await resolveTargets(session, [ref], 'discussion'))[0];
      if (!target || target.base !== 'work' || target.resource !== ref) return null;
      return { kind, ref, work: ref, target: ref, actor: null, realm: null, language: null };
    }
    const source = (await feedSources(session, { ids: [ref] }))[0];
    if (!source?.work || !source.reply || !source.realm || !['discussion', 'reply'].includes(source.kind)) return null;
    if (!session.deps.realmReplies || !session.deps.content) throw new Error('Saved view post owners are unavailable');
    const current = await session.deps.realmReplies.visible(source.realm, source.reply);
    if (!current || current.placement !== ref
      || `urn:rezics:content:revision:${current.revisionId}` !== source.contentRevision
      || `urn:rezics:realm-review:${current.reviewDecisionId}` !== source.review) return null;
    const body = (await session.deps.content.readExactBatch([current.revisionId], async ids => new Set(ids)))[0];
    if (!body || ['missing', 'erased', 'denied'].includes(body.status)) return null;
    if (body.status !== 'available' || body.reference.resourceId !== source.reply) throw new Error('Saved view post body is unavailable');
    const after = await session.deps.realmReplies.visible(source.realm, source.reply);
    if (!after || after.placement !== current.placement || after.revisionId !== current.revisionId
      || after.reviewDecisionId !== current.reviewDecisionId) return null;
    return { kind, ref, work: source.work, target: source.reply, actor: source.actor,
      realm: source.realm, language: body.reference.language.kind === 'tag' ? body.reference.language.tag : null };
  }

  private async eligible(view: View, subject: SavedViewSubject) {
    return !!view.target && await relationshipEligible(this.access, view.principal_id, {
      targets: [view.target], highlights: subject.kind === 'work',
      languages: subject.language ? [subject.language] : [],
    }) && await notificationRecipientAllowed(this.access, view.principal_id, subject.actor, subject.realm, subject.work);
  }

  private async matching(view: View, kind: SavedViewSubject['kind'], ref: string) {
    try {
      return await this.read(async session => {
        const subject = await this.subject(session, kind, ref);
        if (!subject || !await this.eligible(view, subject)) return null;
        const scoped = subject.realm ? new WorkReadSession(session.deps, session.request,
          { ...session.options, scope: 'realm', realm: subject.realm }, session.position) : session;
        if (!await matchesSavedView(scoped, view.document, subject)) return null;
        const after = await this.subject(session, kind, ref);
        return after && JSON.stringify(after) === JSON.stringify(subject)
          && await this.eligible(view, after) ? after : null;
      });
    } catch (error) {
      if (error instanceof WorkReadMissing) return null;
      throw error;
    }
  }

  /** Enqueue before advancing durable matching progress. A lost ACK replays
   * the same native recipient/source identity; the relay waits for the last page. */
  async run(envelope: SavedViewEnvelope): Promise<{ complete: boolean; produced: number }> {
    const receipt = envelope.data.receipt;
    const selected = envelope.type === 'com.rezics.publication.selection-changed.v1';
    const kind = selected || envelope.type === 'com.rezics.work.created.v1' ? 'work'
      : envelope.type === 'com.rezics.realm.reply-placed.v1' ? 'post' : null;
    if (!kind) return { complete: true, produced: 0 };
    const ref = kind === 'work' ? receipt?.work : receipt?.placement;
    if (typeof ref !== 'string' || !native.test(ref)) return { complete: true, produced: 0 };
    if (selected) {
      const selection = receipt?.selection;
      if (typeof selection !== 'string' || !native.test(selection)) return { complete: true, produced: 0 };
      const first = await this.read(session => session.query(`SELECT ?selection WHERE {
        VALUES ?selection { ${iri(selection)} } GRAPH ${iri(GRAPHS.revisions)} {
          ?selection a rv:PublicationSelection . FILTER NOT EXISTS { ?selection rv:predecessor ?previous }
        } } LIMIT 2`, 1));
      if (!first.length) return { complete: true, produced: 0 };
    }
    // Do not seal a hidden Work's progress: its first public selection must
    // still match under the shared work-public identity.
    try { if (!await this.read(session => this.subject(session, kind, ref))) return { complete: true, produced: 0 }; }
    catch (error) { if (error instanceof WorkReadMissing) return { complete: true, produced: 0 }; throw error; }
    const source = kind === 'work' ? `work-public:${ref}` : envelope.id;
    const client = await this.access.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      await requireAccessOpen(client);
      await client.query(`INSERT INTO access.notification_recipient_progress(source_owner,source_event,topic)
        VALUES('graph',$1,$2) ON CONFLICT DO NOTHING`, [source, progressTopic]);
      const progress = (await client.query<{ after_principal: string | null; complete: boolean }>(`
        SELECT after_principal,complete FROM access.notification_recipient_progress
        WHERE source_owner='graph' AND source_event=$1 AND topic=$2 FOR UPDATE`, [source, progressTopic])).rows[0]!;
      if (progress.complete) { await client.query('COMMIT'); return { complete: true, produced: 0 }; }
      // after_principal is an unreferenced UUID keyset slot. This producer's
      // separate topic uses it for saved_filter.id, which already has a PK index.
      // LIMIT precedes follow admission. Even an inventory full of Off or
      // inactive follows costs only one raw page and advances its UUID frontier.
      const page = (await client.query<View>(`WITH candidates AS (
        SELECT id,principal_id,document,concept FROM access.saved_filter
        WHERE ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3
      ) SELECT v.id::text,v.principal_id::text,v.document,f.target FROM candidates v
        LEFT JOIN access.principal p ON p.id=v.principal_id
        LEFT JOIN LATERAL (${followForView}) f ON true ORDER BY v.id`,
      [kind === 'work', progress.after_principal, SAVED_VIEW_PRODUCER_COST.viewsPerPage + 1])).rows;
      let produced = 0;
      for (const view of page.slice(0, SAVED_VIEW_PRODUCER_COST.viewsPerPage)) {
        if (!view.target) continue;
        let subject: SavedViewSubject | null;
        try { subject = await this.matching(view, kind, ref); }
        catch (error) {
          if (!(error instanceof QueryRejected)) throw error;
          // A saved document can outlive an executable template. Its typed
          // refusal must not stall unrelated followers behind it.
          logWorkerFault('main.notification.saved-views', Object.assign(error, { code: error.refusal }));
          continue;
        }
        if (!subject) continue;
        const notice: NotificationEvent = { sourceOwner: 'graph', sourceEvent: `${source}:${view.id}`,
          purpose: kind === 'work' ? 'subscription' : 'social', topic: kind === 'work' ? 'new-work' : 'reply',
          // Access owns this recipient's saved-view match. Its selected
          // occurrence is re-read by this basis, never passed as a Content
          // revision to the common notification disclosure adapter.
          subject: { owner: 'access', ref: view.id, revision: ref },
          disclosureBasis: kind === 'work' ? SAVED_VIEW_BASES[0] : SAVED_VIEW_BASES[1],
          recipients: [view.principal_id],
          ...(kind === 'post' ? { display: { kind: 'reply' as const, actorAgent: subject.actor,
            realm: subject.realm, groupKey: subject.work } } : {}) };
        if ((await this.notifications.enqueue(notice))?.complete === false) {
          await client.query('COMMIT'); return { complete: false, produced };
        }
        produced++;
      }
      const complete = page.length <= SAVED_VIEW_PRODUCER_COST.viewsPerPage;
      await client.query(`UPDATE access.notification_recipient_progress
        SET after_principal=$3,complete=$4,updated_at=clock_timestamp()
        WHERE source_owner='graph' AND source_event=$1 AND topic=$2`,
      [source, progressTopic, complete ? null : page[SAVED_VIEW_PRODUCER_COST.viewsPerPage - 1]!.id, complete]);
      await client.query('COMMIT');
      return { complete, produced };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async resolve(input: Parameters<NotificationSubjectReader['resolve']>[0]): Promise<SubjectResolution> {
    const hidden: SubjectResolution = { status: 'undisclosed' };
    if (input.owner !== 'access' || !uuid.test(input.ref) || !native.test(input.revision ?? '')
      || !(SAVED_VIEW_BASES as readonly string[]).includes(input.disclosureBasis)) return hidden;
    const kind = input.disclosureBasis === SAVED_VIEW_BASES[0] ? 'work' : 'post';
    const view = (await this.access.query<View>(`${views} WHERE v.id=$2 AND v.principal_id=$3`,
      [kind === 'work', input.ref, input.principalId])).rows[0];
    if (!view) return hidden;
    let subject: SavedViewSubject | null;
    try { subject = await this.matching(view, kind, input.revision!); }
    catch (error) { if (error instanceof QueryRejected) return hidden; throw error; }
    if (!subject) return hidden;
    // Removing the view/follow concurrently with hydration revokes delivery.
    const after = (await this.access.query<View>(`${views} WHERE v.id=$2 AND v.principal_id=$3`,
      [kind === 'work', input.ref, input.principalId])).rows[0];
    if (!after || after.target !== view.target || JSON.stringify(after.document) !== JSON.stringify(view.document)) return hidden;
    return { status: 'available', subject: { private: false, fields: { linkTarget: subject.target } } };
  }
}
