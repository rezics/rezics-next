import type { Pool } from 'pg';
import type { EditorialEvent } from '../editorial-review/store.ts';
import type { NotificationEvent, ProposalSubscriptionReason } from '../notification/store.ts';
import type { NotificationSubjectReader, SubjectResolution } from '../notification/dispatcher.ts';
import { AccessAdmissionRegistry } from '../access/admission.ts';
import { resolveTargets, targetRead } from '../target/resolve.ts';
import { WorkReadMissing } from '../work/read-session.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { relationshipRecipients, relationshipEligible, type RelationshipRecipients } from '../follows/recipients.ts';

/** Exhaustive lifecycle contract. A new G-865 event cannot silently miss a producer. */
export const EDITORIAL_NOTIFICATION_TOPICS = {
  created: 'review-requested',
  revised: 'proposal-revised',
  reviewed: 'changes-requested',
  applied: 'proposal-decided',
  rejected: 'proposal-decided',
  withdrawn: 'proposal-withdrawn',
  'reversal-proposed': 'review-requested',
  'apply-pending': null,
  'apply-stale': null,
  'apply-cancelled': null,
} as const satisfies Record<EditorialEvent['kind'], string | null>;
export const EDITORIAL_NOTIFICATION_COST = {
  eventsPerTick: 16,
  recipientsPerEvent: 256,
  representedActorsPerRead: 16,
  targetReadsPerActor: 1,
} as const;

export function editorialNotificationTopic(
  kind: EditorialEvent['kind'],
  review: string | null,
  reverts: string | null,
) {
  if (kind === 'reviewed' && review === 'request_changes') return 'changes-requested';
  // Comments, approvals and owner-delivery progress are not new revisions or
  // final decisions. Their durable timeline remains available on the proposal.
  if (kind === 'reviewed') return null;
  if (kind === 'applied' && reverts) return 'proposal-reverted';
  return EDITORIAL_NOTIFICATION_TOPICS[kind];
}

export async function editorialNotification(
  access: Pool,
  event: EditorialEvent,
): Promise<NotificationEvent | null> {
  const row = (
    await access.query<{
      proposer_principal: string;
      reverts: string | null;
      review: string | null;
      actor_principal: string | null;
      resource: string; work: string; context: string;
    }>(
      `
    SELECT p.proposer_principal,p.reverts,p.resource,p.work,p.context,r.outcome AS review,
      CASE WHEN $5 = 'reviewed' THEN r.principal
        WHEN $5 IN ('applied','rejected') THEN d.principal
        ELSE p.proposer_principal END AS actor_principal
    FROM access.editorial_proposal p
    LEFT JOIN LATERAL (SELECT r.outcome,r.principal FROM access.editorial_review r
      WHERE r.proposal = p.id AND r.revision = $2 AND r.reviewer = $3 AND r.created_at <= $4
      ORDER BY r.sequence DESC LIMIT 1) r ON true
    LEFT JOIN access.editorial_decision d ON d.proposal = p.id AND d.revision = $2
      AND d.actor = $3 AND d.created_at <= $4
    WHERE p.id = $1`,
      [event.proposal, event.revision, event.actor, event.occurredAt, event.kind],
    )
  ).rows[0];
  if (!row) return null;
  const topic = editorialNotificationTopic(event.kind, row.review, row.reverts);
  if (!topic) return null;
  // Required Work stewards subscribe once. Existing manual watches and mutes win.
  const stewards = (
    await access.query<{ id: string }>(
      `SELECT DISTINCT ctrl.principal_id::text AS id
    FROM access.editorial_proposal p JOIN access.work_maintainer m ON m.work = p.work
    JOIN access.representation ctrl ON ctrl.subject_id = m.agent AND ctrl.action = 'agent.control'
    JOIN access.principal who ON who.id = ctrl.principal_id AND who.active
    JOIN access.authority_subject agent ON agent.id = ctrl.subject_id AND agent.active
    WHERE p.id = $1 AND ctrl.active AND ctrl.valid_until > clock_timestamp()
      AND ctrl.principal_id <> p.proposer_principal ORDER BY id LIMIT 257`,
      [event.proposal],
    )
  ).rows;
  if (stewards.length > 256) throw new Error('editorial steward bound exceeded');
  if (stewards.length)
    await access.query(
      `INSERT INTO access.watch (principal_id,proposal,reason,level)
    SELECT id,$2,'steward','participating' FROM unnest($1::uuid[]) AS id ON CONFLICT DO NOTHING`,
      [stewards.map((item) => item.id), event.proposal],
    );
  const recipients = (
    await access.query<{ principal_id: string; reason: ProposalSubscriptionReason }>(
      `
    WITH involved AS (SELECT s.principal_id,CASE
      WHEN proposal.proposer_principal=s.principal_id THEN 'author'
      WHEN EXISTS(SELECT 1 FROM access.editorial_review review WHERE review.proposal=s.proposal
        AND review.principal=s.principal_id) THEN 'reviewer'
      WHEN s.principal_id=ANY($6::uuid[]) AND s.reason<>'manual' THEN 'steward' ELSE NULL END AS reason
      FROM access.watch s JOIN access.editorial_proposal proposal ON proposal.id=s.proposal
      WHERE s.proposal=$1 OR ($2::uuid IS NOT NULL AND s.proposal=$2))
    SELECT DISTINCT ON (s.principal_id) s.principal_id::text,s.reason
    FROM involved s JOIN access.principal p ON p.id = s.principal_id AND p.active
    WHERE s.reason IS NOT NULL
      AND ($3 <> 'review-requested' OR s.reason <> 'author')
      AND s.principal_id IS DISTINCT FROM $4::uuid
      AND NOT EXISTS (SELECT 1 FROM access.representation self
        WHERE self.principal_id = s.principal_id AND self.subject_id = $5
          AND self.action = 'agent.control' AND self.active AND self.valid_until > clock_timestamp())
    ORDER BY s.principal_id, CASE s.reason WHEN 'author' THEN 0 WHEN 'reviewer' THEN 1 WHEN 'steward' THEN 2 ELSE 3 END
    LIMIT 257`,
      [event.proposal, topic === 'proposal-reverted' ? row.reverts : null, topic, row.actor_principal, event.actor,
        stewards.map(steward => steward.id)],
    )
  ).rows;
  if (recipients.length > 256) throw new Error('editorial recipient bound exceeded');
  const relationshipPlan: RelationshipRecipients = { targets: [row.resource===row.work ? null : row.resource,row.context,event.actor].filter((id): id is string => !!id),
    highlights: ['proposal-decided','proposal-reverted'].includes(topic),
    watches: [`urn:rezics:proposal:${event.proposal}`],
    direct: recipients.filter(item => ['author','reviewer'].includes(item.reason)).map(item => item.principal_id),
    relationships: stewards.map(item => item.id),
    except: row.actor_principal ? [row.actor_principal] : [] };
  const related = await relationshipRecipients(access,relationshipPlan);
  if (!related.length) return null;
  return {
    sourceOwner: 'access',
    sourceEvent: `editorial:${event.id}`,
    purpose: 'governance',
    topic,
    subject: { owner: 'access', ref: event.proposal, revision: String(event.revision) },
    disclosureBasis: 'editorial-proposal-v1',
    recipients: related, relationshipPlan,
    proposal: {
      id: event.proposal,
      revision: event.revision,
      reasons: { ...Object.fromEntries(related.map(id => [id,'manual' as const])),
        ...Object.fromEntries(recipients.map((item) => [item.principal_id, item.reason])) },
    },
  };
}

/* Stewardship is a current authority, not a permanent watch. Check it on every
 * inbox, digest and delivery read, in addition to the target's disclosure.
 * Historic reviews, author status and manual watches grant no read access. */
export function editorialNotificationSubjectReader(
  access: Pool,
  env: WorkActivationEnvironment,
): NotificationSubjectReader {
  const authority = new AccessAdmissionRegistry(access);
  return {
    async resolve(input): Promise<SubjectResolution> {
      if (
        input.owner !== 'access' ||
        !/^[0-9a-f-]{36}$/.test(input.ref) ||
        !/^[1-9][0-9]*$/.test(input.revision ?? '')
      )
        return { status: 'undisclosed' };
      const row = (
        await access.query<{ resource: string; context: string; work: string }>(
          `SELECT p.resource,p.context,p.work
      FROM access.editorial_proposal p JOIN access.editorial_revision r ON r.proposal = p.id
      WHERE p.id = $1 AND r.n = $2
        AND ($4::text IS DISTINCT FROM 'steward' OR EXISTS (
          SELECT 1 FROM access.work_maintainer m
          JOIN access.representation ctrl ON ctrl.subject_id = m.agent AND ctrl.action = 'agent.control'
          JOIN access.principal who ON who.id = ctrl.principal_id AND who.active
          JOIN access.authority_subject agent ON agent.id = m.agent AND agent.active AND agent.kind = 'agent'
          WHERE m.work = p.work AND ctrl.principal_id = $3
            AND ctrl.active AND ctrl.valid_until > clock_timestamp())
          OR EXISTS(SELECT 1 FROM access.watch watch WHERE watch.principal_id=$3
            AND watch.proposal=p.id AND watch.level='all'))`,
          [input.ref, input.revision, input.principalId, input.recipientReason ?? null],
        )
      ).rows[0];
      if (!row) return { status: 'undisclosed' };
      if (['manual','steward'].includes(input.recipientReason ?? '') && !await relationshipEligible(access,input.principalId,{
        targets: [row.resource===row.work ? null : row.resource,row.context].filter((id): id is string => !!id),
        relationships: input.recipientReason==='steward' ? [input.principalId] : [], highlights: ['proposal-decided','proposal-reverted'].includes(input.topic ?? ''),
        watches: [`urn:rezics:proposal:${input.ref}`] })) {
        return { status: 'undisclosed' };
      }
      const candidates = (
        await access.query<{ issuer: string; subject: string; actor: string | null }>(
          `
      SELECT p.account_issuer AS issuer,p.account_subject AS subject,r.subject_id AS actor
      FROM access.principal p LEFT JOIN access.representation r ON r.principal_id = p.id
        AND r.action = 'agent.control' AND r.active AND r.valid_until > clock_timestamp()
        AND EXISTS (SELECT 1 FROM access.authority_subject s WHERE s.id = r.subject_id AND s.active AND s.kind = 'agent')
      WHERE p.id = $1 AND p.active ORDER BY r.subject_id LIMIT 17`,
          [input.principalId],
        )
      ).rows;
      for (const candidate of candidates.slice(0,EDITORIAL_NOTIFICATION_COST.representedActorsPerRead)) {
        const principal = { issuer: candidate.issuer, subject: candidate.subject };
        try {
          await targetRead(
            env,
            { access: authority, principal, actingSubject: candidate.actor ?? undefined },
            (session) => resolveTargets(session, [row.resource], 'discussion'),
          );
          if (
            row.context !== 'urn:rezics:context:global' &&
            (!candidate.actor ||
              !(await authority.realmReadProof(principal, candidate.actor, row.context)))
          )
            continue;
          return {
            status: 'available',
            subject: {
              private: true,
              fields: {
                proposal: input.ref,
                revision: input.revision!,
                linkTarget: row.resource,
              },
            },
          };
        } catch (error) {
          if (!(error instanceof WorkReadMissing)) throw error;
        }
      }
      return { status: candidates.length > EDITORIAL_NOTIFICATION_COST.representedActorsPerRead ? 'unavailable' : 'undisclosed' };
    },
  };
}
