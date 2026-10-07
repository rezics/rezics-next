import type { PoolClient } from 'pg';
import { mintPartyCredential } from '../public-report/store.ts';
import type { DecisionTargetInput, StatementOfReasons } from './store.ts';
import { GovernanceUnavailable } from './store.ts';
import type { ModerationEffects } from './effects.ts';

/** One subject and one controller page per step, independent of case size.
 * Subject/principal cursors commit with credentials; replay never remints a notice.
 * Row-lock serialization: https://www.postgresql.org/docs/18/explicit-locking.html */
export const SAFETY_NOTICE_RECIPIENT_COST = {
  subjects: 1,
  principals: 50,
  statements: 160,
} as const;
export const unrecordedReasons: StatementOfReasons = {
  facts: 'Reason not recorded.',
  scope: 'Scope not recorded.',
  duration: 'Duration not recorded.',
  // Legacy absence is not evidence that automation was uninvolved.
  automation: true,
  contentLanguage: 'en',
  appealRoute: '/v1/public-reports/{caseId}/correspondence',
};

type Job = {
  ordinal: number;
  target: DecisionTargetInput;
  participant: string | null;
  phase: 'graph' | 'maintainer' | 'participant' | 'done';
  after_subject: string | null;
  subject: string | null;
  after_principal: string | null;
};

export async function prepareDecisionNotices(
  client: PoolClient,
  decisionId: string,
  caseId: string,
  reasons: StatementOfReasons,
  effects?: Pick<ModerationEffects, 'participants'>,
  page: number = SAFETY_NOTICE_RECIPIENT_COST.principals,
): Promise<boolean> {
  const job = (
    await client.query<Job>(
      `SELECT ordinal,target,participant,phase,after_subject,subject,after_principal
    FROM access.safety_notice_job WHERE decision_id = $1 AND phase <> 'done'
    ORDER BY ordinal LIMIT 1 FOR UPDATE`,
      [decisionId],
    )
  ).rows[0];
  if (!job) return true;
  // A step crosses at most the three source families; never loops over subjects.
  for (let family = 0; family < 3 && !job.subject && job.phase !== 'done'; family++) {
    if (job.phase === 'graph') {
      if (job.target.owner === 'graph') {
        if (!effects?.participants)
          throw new GovernanceUnavailable('graph notice participants are unavailable');
        job.subject = (await effects.participants(job.target, job.after_subject, 1))[0] ?? null;
      }
      if (!job.subject) {
        job.phase = 'maintainer';
        job.after_subject = null;
      }
    } else if (job.phase === 'maintainer') {
      job.subject =
        (
          await client.query<{ agent: string }>(
            `SELECT agent FROM access.work_maintainer
        WHERE work = $1 AND ($2::text IS NULL OR agent > $2) ORDER BY agent LIMIT 1`,
            [job.target.resource, job.after_subject],
          )
        ).rows[0]?.agent ?? null;
      if (!job.subject) {
        job.phase = 'participant';
        job.after_subject = null;
      }
    } else {
      job.subject = job.after_subject ? null : job.participant;
      if (!job.subject) job.phase = 'done';
    }
  }
  if (job.subject) {
    // Each branch uses (subject_id,principal_id), and LIMIT is before the union
    // sort. An Agent may have arbitrarily many controllers or representatives.
    const parties = (
      await client.query<{ id: string }>(
        `SELECT principal_id AS id FROM (
      (SELECT principal_id FROM access.agent_provision WHERE agent_id = $1
        AND ($2::uuid IS NULL OR principal_id > $2) ORDER BY principal_id LIMIT $3)
      UNION
      (SELECT DISTINCT principal_id FROM access.representation WHERE subject_id = $1 AND active
        AND valid_until > clock_timestamp() AND ($2::uuid IS NULL OR principal_id > $2)
        ORDER BY principal_id LIMIT $3)
      ) participants ORDER BY principal_id LIMIT $3`,
        [job.subject, job.after_principal, page],
      )
    ).rows;
    const report = (
      await client.query<{ id: string }>(
        `SELECT id FROM access.governance_report
      WHERE case_id = $1 ORDER BY received_at,id LIMIT 1`,
        [caseId],
      )
    ).rows[0];
    if (!report) throw new GovernanceUnavailable('notice report basis is unavailable');
    for (const party of parties) {
      if (
        (
          await client.query(
            `SELECT 1 FROM access.safety_party_notice
        WHERE decision_id = $1 AND principal_id = $2`,
            [decisionId, party.id],
          )
        ).rowCount
      )
        continue;
      const credential = await mintPartyCredential(client, caseId, report.id);
      await client.query(
        `INSERT INTO access.safety_party_notice
        (id,decision_id,principal_id,case_id,credential,statement_of_reasons) VALUES ($1,$2,$3,$4,$5,$6)`,
        [Bun.randomUUIDv7(), decisionId, party.id, caseId, credential, reasons],
      );
    }
    if (parties.length === page) job.after_principal = parties.at(-1)!.id;
    else {
      job.after_subject = job.subject;
      job.subject = null;
      job.after_principal = null;
      if (job.phase === 'participant') job.phase = 'done';
    }
  }
  await client.query(
    `UPDATE access.safety_notice_job SET phase = $3,after_subject = $4,
    subject = $5,after_principal = $6 WHERE decision_id = $1 AND ordinal = $2`,
    [decisionId, job.ordinal, job.phase, job.after_subject, job.subject, job.after_principal],
  );
  return !(
    await client.query(
      `SELECT 1 FROM access.safety_notice_job
    WHERE decision_id = $1 AND phase <> 'done' LIMIT 1`,
      [decisionId],
    )
  ).rowCount;
}
