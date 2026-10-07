import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { counterDeclaration, validContentLanguage } from '../public-report/contract.ts';
import type { Static } from 'typebox';
import { GovernanceDenied, GovernanceInvalid, GovernanceStale } from '../governance/store.ts';
import { mintPartyCredential } from '../public-report/store.ts';

export type CounterDeclaration = Static<typeof counterDeclaration>;
/** Indexed probes and five inserts including two receipt-window trigger appends;
 * never enumerate a case's reports. Each deadline examines at most 20 UTC days. */
export const COUNTER_NOTICE_COST = {
  statements: 8,
  page: 8,
  targetsPerCase: 64,
  retryMs: 60_000,
} as const;

/** Both transports call this after authenticating the affected party. The caller
 * holds the case row lock, also used by claimant filings and restoration. */
export async function recordCounterNotice(
  client: PoolClient,
  input: {
    caseId: string;
    reportId: string;
    decisionId?: string;
    principalId?: string;
    partySubject?: string | null;
    statement: string;
    contentLanguage: string;
    declarations: CounterDeclaration;
    key: string;
    requestDigest: string;
    now: Date;
  },
): Promise<string> {
  if (
    !Value.Check(counterDeclaration, input.declarations) ||
    !input.statement.trim() ||
    input.statement.length > 8000 ||
    !validContentLanguage(input.contentLanguage)
  ) {
    throw new GovernanceInvalid('Counter-notice requires the signed subscriber declarations');
  }
  const basis = (
    await client.query<{ decision_head: string | null; outcome: string }>(
      `SELECT c.decision_head,d.outcome
    FROM access.governance_case c JOIN access.governance_report r ON r.case_id = c.id
    JOIN access.rights_complaint rc ON rc.report_id = r.id AND rc.process = 'dmca_512'
    LEFT JOIN access.moderation_decision d ON d.id = c.decision_head
    WHERE c.id = $1 AND r.id = $2 AND c.state = 'open'`,
      [input.caseId, input.reportId],
    )
  ).rows[0];
  if (!basis) throw new GovernanceDenied('Counter-notice requires an affected copyright party');
  if (
    !basis.decision_head ||
    !['interim_restrict', 'final_restrict'].includes(basis.outcome) ||
    (input.decisionId && input.decisionId !== basis.decision_head)
  ) {
    throw new GovernanceStale('Counter-notice must answer the current copyright restriction');
  }
  if (
    (
      await client.query(
        `SELECT 1 FROM access.rights_counter_notice
    WHERE case_id = $1 AND report_id = $2 AND restriction_id = $3`,
        [input.caseId, input.reportId, basis.decision_head],
      )
    ).rowCount
  ) {
    throw new GovernanceStale(
      'This notice already has a counter-notice; its deadline cannot be reset',
    );
  }
  const id = Bun.randomUUIDv7();
  await client.query(
    `INSERT INTO access.governance_process_step
    (id,case_id,report_id,decision_id,process,step,principal_id,party_subject,idempotency_key,
      request_digest,statement,occurred_at,content_language,declarations,party)
    VALUES ($1,$2,$3,$4,'dmca_512','counter_notice',$5,$6,$7,$8,$9,$10,$11,$12,'affected')`,
    [
      id,
      input.caseId,
      input.reportId,
      basis.decision_head,
      input.principalId ?? null,
      input.partySubject ?? null,
      input.key,
      input.requestDigest,
      input.statement.trim(),
      input.now,
      input.contentLanguage,
      input.declarations,
    ],
  );
  await client.query(
    `INSERT INTO access.rights_counter_notice
    (step_id,case_id,report_id,restriction_id,delivery_id,next_attempt_at,claimant_credential)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      input.caseId,
      input.reportId,
      basis.decision_head,
      randomUUID(),
      input.now,
      await mintPartyCredential(client, input.caseId, input.reportId, 'reporter'),
    ],
  );
  return id;
}

/** A field allowlist avoids disclosing future private additions by accident.
 * The full statutory copy travels only through mandatory encrypted claimant mail. */
export function partyDeclarations(
  kind: string,
  declarations: Record<string, unknown> | null,
  own: boolean,
): Record<string, unknown> | null {
  if (!declarations || own) return declarations;
  const fields =
    kind === 'intake'
      ? [
          'claimedWork',
          'claimedRight',
          'noticeDigest',
          'materialLocation',
          'goodFaith',
          'accurateAndAuthorizedUnderPerjury',
        ]
      : kind === 'counter_notice'
        ? [
            'materialLocation',
            'goodFaithMistakeUnderPerjury',
            'consentToJurisdiction',
            'acceptService',
          ]
        : [];
  return Object.fromEntries(
    fields.filter((field) => field in declarations).map((field) => [field, declarations[field]]),
  );
}

/** Called under the case lock at acceptance and again before each owner effect.
 * A queued counter-notice cannot be skipped, even after its receipt window opens. */
export async function assertCounterNoticeRestoration(
  client: PoolClient,
  caseId: string,
  restrictionId: string,
  now: Date,
): Promise<void> {
  const dmca = (
    await client.query(
      `SELECT 1 FROM access.rights_complaint
    WHERE case_id = $1 AND process = 'dmca_512' LIMIT 1`,
      [caseId],
    )
  ).rowCount;
  if (!dmca) return;
  const eligible = (
    await client.query(
      `SELECT 1 WHERE
    EXISTS (SELECT 1 FROM access.rights_counter_notice WHERE case_id = $1 AND restriction_id = $2
      AND delivered_at IS NOT NULL AND not_before <= $3)
    AND NOT EXISTS (SELECT 1 FROM access.rights_counter_notice WHERE case_id = $1 AND restriction_id = $2
      AND (delivered_at IS NULL OR not_before > $3))
    AND NOT EXISTS (SELECT 1 FROM access.governance_process_step WHERE case_id = $1
      AND process = 'dmca_512' AND step = 'claimant_action'
      AND (decision_id = $2 OR decision_id IS NULL))`,
      [caseId, restrictionId, now],
    )
  ).rowCount;
  if (!eligible)
    throw new GovernanceStale(
      'DMCA restoration is before the receipt waiting period, awaiting confirmed claimant delivery or stayed by claimant action',
    );
}

export async function assertNoParallelRestriction(
  client: PoolClient,
  target: {
    owner: string;
    resource: string;
    component: string;
    revision: string | null;
  },
  restrictionId: string,
): Promise<void> {
  if (
    (
      await client.query(
        `SELECT 1 FROM access.governance_enforcement
    WHERE owner = $1 AND resource = $2 AND component = $3 AND state = 'restricted'
      AND (revision IS NULL OR $4::text IS NULL OR revision = $4) AND decision_id <> $5 LIMIT 1`,
        [target.owner, target.resource, target.component, target.revision, restrictionId],
      )
    ).rowCount
  ) {
    throw new GovernanceStale('Another active restriction blocks restoration');
  }
}
