import type { Pool } from 'pg';
import type { NotificationSubjectReader, SubjectResolution } from '../notification/dispatcher.ts';
import { readPlacementHead } from '../realm-reply/graph.ts';
import { RealmReplyContentStore } from '../realm-reply/content-store.ts';
import { publicReplyRoot } from '../realm-reply/root.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { reviewSubject } from '../notification/producer-review.ts';
import { notificationRealmDisplay, notificationRoleName, notificationWorkTitle }
  from '../notification/display.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hidden: SubjectResolution = { status: 'undisclosed' };

async function represents(access: Pool, principalId: string, agent: string, action?: string): Promise<boolean> {
  if (!native.test(agent)) return false;
  const row = await access.query(`SELECT 1 FROM access.representation r
    JOIN access.principal p ON p.id = r.principal_id AND p.active
    JOIN access.authority_subject s ON s.id = r.subject_id AND s.active AND s.kind = 'agent'
    WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.active
      AND r.valid_until > clock_timestamp() AND ($3::text IS NULL OR r.action = $3) LIMIT 1`,
  [principalId, agent, action ?? null]);
  return !!row.rowCount;
}

async function currentContributionAuthors(env: WorkActivationEnvironment, resource: string): Promise<string[]> {
  if (!native.test(resource)) return [];
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?author WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?contribution a rv:TextContribution ;
      rv:author ?author ; rv:publicationHead ?decision .
      { ?contribution rv:work ${iri(resource)} } UNION
      { FILTER(?contribution = ${iri(resource)}) } }
    GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:disclosure rv:Public . }
  } LIMIT 257`, 16_384)).results?.bindings ?? [];
  if (rows.length > 256) throw new Error('notification author bound exceeded');
  return rows.map(row => row.author?.value ?? '').filter(author => native.test(author));
}

/** Each resolution rechecks current recipient authority and exact owner state. */
export function notificationProducerSubjectReader(access: Pool, content: Pool,
  env: WorkActivationEnvironment): NotificationSubjectReader {
  const replies = new RealmReplyContentStore(content);
  const present = async (result: SubjectResolution, realm: string | null | undefined,
    work?: string, publicOnly = true): Promise<SubjectResolution> => {
    if (result.status !== 'available') return result;
    const place = realm ? await notificationRealmDisplay(env, realm) : {};
    const title = work ? await notificationWorkTitle(env, work, publicOnly) : null;
    return { status: 'available', subject: { ...result.subject,
      fields: { ...result.subject.fields, ...place, ...(title ? { title } : {}) } } };
  };
  return { async resolve(input): Promise<SubjectResolution> {
    if (input.disclosureBasis === 'review-created-v1' || input.disclosureBasis === 'review-helpful-v1') {
      const result = await reviewSubject(access, env.fuseki, input);
      if (result.status !== 'available') return result;
      const row = (await access.query<{ work: string }>(`SELECT work FROM access.reader_review
        WHERE id = $1`, [input.ref])).rows[0];
      return present(result, input.realm, row?.work);
    }
    if (input.disclosureBasis === 'realm-reply-v1') {
      if (input.owner !== 'graph' || !native.test(input.ref) || !input.realm || !native.test(input.realm)
        || !input.revision?.startsWith('urn:rezics:content:revision:')) return hidden;
      const placement = await readPlacementHead(env, input.realm, input.ref);
      if (!placement || `urn:rezics:content:revision:${placement.revisionId}` !== input.revision) return hidden;
      const reply = await replies.readCurrent(input.ref);
      if (!reply || reply.revisionId !== placement.revisionId) return { status: 'erased' };
      if (!await publicReplyRoot(env.fuseki, reply.rootTarget, reply.rootRevision)) return hidden;
      return present({ status: 'available', subject: { private: false,
        fields: { linkTarget: input.ref, realm: input.realm, excerpt: reply.body.slice(0, 240) } } },
      input.realm, reply.rootTarget);
    }
    if (input.owner !== 'access' || !uuid.test(input.ref)) return hidden;
    if (input.disclosureBasis === 'realm-invitation-v1') {
      const row = (await access.query<{ realm: string; member: string }>(`SELECT realm, member
        FROM access.realm_invitation WHERE id = $1 AND state = 'pending'
          AND expires_at > clock_timestamp()`, [input.ref])).rows[0];
      if (!row || row.realm !== input.realm || !await represents(access, input.principalId, row.member)) return hidden;
      return present({ status: 'available', subject: { private: true,
        fields: { linkTarget: row.realm, realm: row.realm } } }, row.realm);
    }
    if (input.disclosureBasis === 'submission-decision-v1') {
      if (!input.revision || !uuid.test(input.revision)) return hidden;
      const row = (await access.query<{ realm: string; work: string; submitting_agent: string;
        state: string }>(`SELECT s.realm, s.work, s.submitting_agent,
          h.snapshot->>'state' AS state FROM access.realm_submission_revision h
        JOIN access.realm_submission s ON s.id = h.submission_id
        WHERE s.id = $1 AND h.revision = $2`, [input.ref, input.revision])).rows[0];
      if (!row || row.realm !== input.realm || !['accepted', 'rejected', 'changes-requested'].includes(row.state)
        || !await represents(access, input.principalId, row.submitting_agent, 'submission.submit')) return hidden;
      return present({ status: 'available', subject: { private: true,
        fields: { linkTarget: row.work, realm: row.realm, excerpt: row.state } } },
      row.realm, row.work, false);
    }
    if (input.disclosureBasis === 'moderation-outcome-v1') {
      const row = (await access.query<{ case_id: string; target_resource: string;
        context: string; outcome: string; reporter: boolean }>(`SELECT d.case_id,
        c.target_resource, c.context, d.outcome, EXISTS (
          SELECT 1 FROM access.governance_report r
          WHERE r.case_id = d.case_id AND r.principal_id = $2) AS reporter
        FROM access.moderation_decision d JOIN access.governance_case c ON c.id = d.case_id
        WHERE d.id = $1`, [input.ref, input.principalId])).rows[0];
      if (!row || (input.realm ?? null) !== (native.test(row.context) ? row.context : null)) return hidden;
      const authors = !row.reporter
        ? await currentContributionAuthors(env, row.target_resource) : [];
      let ownsTarget = false;
      for (const author of authors) {
        if (await represents(access, input.principalId, author)) { ownsTarget = true; break; }
      }
      if (!row.reporter && !ownsTarget) return hidden;
      return present({ status: 'available', subject: { private: true,
        fields: { linkTarget: row.target_resource, excerpt: row.outcome,
          ...(native.test(row.context) ? { realm: row.context } : {}) } } },
      native.test(row.context) ? row.context : null, row.target_resource);
    }
    if (input.disclosureBasis === 'realm-role-change-v1') {
      const row = (await access.query<{ realm: string; result: unknown }>(`
        SELECT realm, result FROM access.realm_admin_receipt WHERE id = $1
          AND action IN ('realm.roles.manage', 'realm.members.manage')`, [input.ref])).rows[0];
      if (!row || row.realm !== input.realm) return hidden;
      const result = row.result as { member?: unknown; impact?: { changes?: { member?: unknown }[] };
        notificationRole?: unknown; auditDetail?: { kind?: unknown; member?: unknown; assigned?: unknown } };
      const members = typeof result.member === 'string' ? [result.member]
        : Array.isArray(result.impact?.changes) ? result.impact.changes.map(change => change.member) : [];
      const effects = (await access.query<{ member: string }>(`
        SELECT member FROM access.notification_realm_effect WHERE receipt_id = $1
        ORDER BY member LIMIT 257`, [input.ref])).rows;
      if (effects.length > 256) return { status: 'unavailable' };
      for (const member of [...members, ...effects.map(effect => effect.member)]) {
        if (typeof member === 'string' && await represents(access, input.principalId, member)) {
          const roleName = await notificationRoleName(access, row.realm, member, result.notificationRole);
          return present({ status: 'available', subject: { private: true,
            fields: { linkTarget: row.realm, realm: row.realm,
              ...(roleName ? { roleName } : {}),
              ...(result.auditDetail?.kind === 'assignment' && result.auditDetail.member === member
                && typeof result.auditDetail.assigned === 'boolean'
                ? { roleChange: result.auditDetail.assigned ? 'given' : 'taken' } : {}) } } }, row.realm);
        }
      }
      return hidden;
    }
    return hidden;
  } };
}
