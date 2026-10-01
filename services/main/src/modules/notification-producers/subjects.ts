import type { Pool } from 'pg';
import type { NotificationSubjectReader, SubjectResolution } from '../notification/dispatcher.ts';
import { RealmReplyContentStore } from '../realm-reply/content-store.ts';
import { publicReplyRoot } from '../realm-reply/root.ts';
import { visibleRealmReply } from '../realm-reply/store.ts';
import { AccessAdmissionRegistry, type VerifiedPrincipal } from '../access/admission.ts';
import { readRealmPolicy } from '../space/policy.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { reviewSubject } from '../notification/producer-review.ts';
import { notificationRealmDisplay, notificationRoleName, notificationWorkTitle }
  from '../notification/display.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hidden: SubjectResolution = { status: 'undisclosed' };

/** One represented participation candidate; the Access permit makes the final decision. */
async function realmActors(access: Pool, principalId: string, realm: string): Promise<{
  principal: VerifiedPrincipal; actor: string }[]> {
  const rows = (await access.query<{ issuer: string; subject: string; actor: string }>(`
    SELECT DISTINCT p.account_issuer AS issuer, p.account_subject AS subject, r.subject_id AS actor
    FROM access.principal p JOIN access.representation r ON r.principal_id = p.id
    JOIN access.authority_subject s ON s.id = r.subject_id AND s.active AND s.kind = 'agent'
    WHERE p.id = $1 AND p.active AND r.active AND r.valid_until > clock_timestamp()
      AND (EXISTS (SELECT 1 FROM access.private_membership m
        WHERE m.kind = 'realm' AND m.owner_subject = $2 AND m.principal_id = p.id AND m.state = 'joined')
        OR EXISTS (SELECT 1 FROM access.membership m WHERE m.kind = 'realm'
          AND m.owner_subject = $2 AND m.member_subject = r.subject_id AND m.state = 'joined')
        OR EXISTS (SELECT 1 FROM access.permission_grant g WHERE g.scope_id = 'governance:realm:' || $2
          AND g.recipient_subject = r.subject_id AND g.action = 'realm.owner' AND g.active
          AND g.valid_until > clock_timestamp() AND g.membership_id IS NULL))
      AND NOT EXISTS (SELECT 1 FROM access.private_membership_ban b
        WHERE b.kind = 'realm' AND b.owner_subject = $2 AND b.principal_id = p.id AND b.active)
      AND NOT EXISTS (SELECT 1 FROM access.membership_ban b
        WHERE b.kind = 'realm' AND b.owner_subject = $2 AND b.member_subject = r.subject_id
          AND b.active AND (b.expires_at IS NULL OR b.expires_at > clock_timestamp()))
    ORDER BY actor LIMIT 1`, [principalId, realm])).rows;
  return rows.map(row => ({ principal: { issuer: row.issuer, subject: row.subject }, actor: row.actor }));
}

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
  const realmAccess = new AccessAdmissionRegistry(access);
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
      const presented = await present(result, input.realm, row?.work);
      const checked = await reviewSubject(access, env.fuseki, input);
      return checked.status === 'available' && JSON.stringify(checked.subject) === JSON.stringify(result.subject)
        ? presented : hidden;
    }
    if (input.disclosureBasis === 'realm-reply-v1') {
      if (input.owner !== 'graph' || !native.test(input.ref) || !input.realm || !native.test(input.realm)
        || !input.revision?.startsWith('urn:rezics:content:revision:')) return hidden;
      const policy = await readRealmPolicy(env, input.realm);
      if (!policy) return hidden;
      const candidates = policy.visibility === 'private'
        ? await realmActors(access, input.principalId, input.realm) : [];
      if (policy.visibility === 'private' && !candidates.length) return hidden;
      let accepted: { principal?: VerifiedPrincipal; actor?: string } | null = null;
      let placement = policy.visibility === 'private' ? null
        : await visibleRealmReply(replies, realmAccess, env, input.realm, input.ref);
      if (placement) accepted = {};
      for (const candidate of candidates) {
        placement = await visibleRealmReply(replies, realmAccess, env, input.realm, input.ref,
          candidate.principal, candidate.actor);
        if (placement) { accepted = candidate; break; }
      }
      if (!placement || `urn:rezics:content:revision:${placement.revisionId}` !== input.revision) return hidden;
      const reply = await replies.readCurrent(input.ref);
      if (!reply || reply.revisionId !== placement.revisionId) return { status: 'erased' };
      if (!await publicReplyRoot(env.fuseki, reply.rootTarget, reply.rootRevision)) return hidden;
      const result = await present({ status: 'available', subject: { private: policy.visibility !== 'public',
        fields: { linkTarget: input.ref, realm: input.realm, excerpt: reply.body.slice(0, 240) } } },
        input.realm, reply.rootTarget);
      const current = await visibleRealmReply(replies, realmAccess, env, input.realm, input.ref,
        accepted?.principal, accepted?.actor);
      const currentReply = await replies.readCurrent(input.ref);
      if (current?.placement !== placement.placement || current.revisionId !== placement.revisionId
        || currentReply?.revisionId !== placement.revisionId
        || JSON.stringify(await readRealmPolicy(env, input.realm)) !== JSON.stringify(policy)
        || !await publicReplyRoot(env.fuseki, reply.rootTarget, reply.rootRevision)) return hidden;
      return result;
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
        const row = (
          await access.query<{
            case_id: string;
            target_resource: string;
            context: string;
            outcome: string;
            reporter: boolean;
            affected: boolean;
            safety: boolean;
          }>(
            `SELECT d.case_id,
        c.target_resource, c.context, d.outcome, d.statement_of_reasons IS NOT NULL AS safety, EXISTS (
          SELECT 1 FROM access.safety_party_notice n
          WHERE n.decision_id = d.id AND n.principal_id = $2) AS affected, EXISTS (
          SELECT 1 FROM access.governance_report r
          WHERE r.case_id = d.case_id AND r.principal_id = $2) AS reporter
        FROM access.moderation_decision d JOIN access.governance_case c ON c.id = d.case_id
        WHERE d.id = $1 AND c.decision_head = d.id
          AND NOT EXISTS (SELECT 1 FROM access.safety_decision_operation op
            WHERE op.decision_id = d.id AND op.cancelled)`,
            [input.ref, input.principalId],
          )
        ).rows[0];
        if (!row || (input.realm ?? null) !== (native.test(row.context) ? row.context : null))
          return hidden;
        const authors =
          !row.reporter && !row.affected && !row.safety
            ? await currentContributionAuthors(env, row.target_resource)
            : [];
        let ownsTarget = false;
        for (const author of authors) {
          if (await represents(access, input.principalId, author)) {
            ownsTarget = true;
            break;
          }
        }
        if (!row.reporter && !row.affected && !ownsTarget) return hidden;
        return present(
          {
            status: 'available',
            subject: {
              private: true,
              fields: {
                linkTarget: row.target_resource,
                excerpt: row.outcome,
                ...(native.test(row.context) ? { realm: row.context } : {}),
              },
            },
          },
          native.test(row.context) ? row.context : null,
          row.target_resource,
        );
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
