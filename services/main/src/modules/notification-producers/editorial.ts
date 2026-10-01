import type { Pool } from 'pg';
import type { EditorialEvent } from '../editorial-review/store.ts';
import type { NotificationEvent, ProposalSubscriptionReason } from '../notification/store.ts';
import type { NotificationSubjectReader, SubjectResolution } from '../notification/dispatcher.ts';
import { AccessAdmissionRegistry } from '../access/admission.ts';
import { resolveTargets, targetRead } from '../target/resolve.ts';
import { WorkReadMissing } from '../work/read-session.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

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
    }>(
      `
    SELECT p.proposer_principal,p.reverts, (SELECT r.outcome FROM access.editorial_review r
      WHERE r.proposal = p.id AND r.revision = $2 AND r.reviewer = $3 AND r.created_at <= $4
      ORDER BY r.sequence DESC LIMIT 1) AS review
    FROM access.editorial_proposal p WHERE p.id = $1`,
      [event.proposal, event.revision, event.actor, event.occurredAt],
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
      `INSERT INTO access.proposal_subscription (principal_id,proposal,reason,level)
    SELECT id,$2,'steward','participating' FROM unnest($1::uuid[]) AS id ON CONFLICT DO NOTHING`,
      [stewards.map((item) => item.id), event.proposal],
    );
  const recipients = (
    await access.query<{ principal_id: string; reason: ProposalSubscriptionReason }>(
      `
    SELECT DISTINCT ON (s.principal_id) s.principal_id::text,s.reason
    FROM access.proposal_subscription s JOIN access.principal p ON p.id = s.principal_id AND p.active
    WHERE (s.proposal = $1 OR ($2::uuid IS NOT NULL AND s.proposal = $2)) AND s.level = 'participating'
      AND NOT EXISTS (SELECT 1 FROM access.proposal_subscription mute
        WHERE mute.principal_id = s.principal_id AND mute.proposal = $1 AND mute.level = 'ignore')
      AND ($3 <> 'review-requested' OR s.reason <> 'author')
    ORDER BY s.principal_id, CASE s.reason WHEN 'author' THEN 0 WHEN 'reviewer' THEN 1 WHEN 'steward' THEN 2 ELSE 3 END
    LIMIT 257`,
      [event.proposal, topic === 'proposal-reverted' ? row.reverts : null, topic],
    )
  ).rows;
  if (recipients.length > 256) throw new Error('editorial recipient bound exceeded');
  if (!recipients.length) return null;
  return {
    sourceOwner: 'access',
    sourceEvent: `editorial:${event.id}`,
    purpose: 'governance',
    topic,
    subject: { owner: 'access', ref: event.proposal, revision: String(event.revision) },
    disclosureBasis: 'editorial-proposal-v1',
    recipients: recipients.map((item) => item.principal_id),
    proposal: {
      id: event.proposal,
      revision: event.revision,
      reasons: Object.fromEntries(recipients.map((item) => [item.principal_id, item.reason])),
    },
  };
}

/** Reuse the target owner's current disclosure, including private Work and Realm
 * proofs. Subscription, historic reviews and author status grant no access. */
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
        await access.query<{ resource: string; context: string }>(
          `SELECT p.resource,p.context
      FROM access.editorial_proposal p JOIN access.editorial_revision r ON r.proposal = p.id
      WHERE p.id = $1 AND r.n = $2`,
          [input.ref, input.revision],
        )
      ).rows[0];
      if (!row) return { status: 'undisclosed' };
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
