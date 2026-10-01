import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { requireAccessOpen } from '../notification/store.ts';

/** Indexed decision/head read and bounded keyset pages for each party family.
 * Intake keys survive a partial commit or lost Account acknowledgement. */
export const SAFETY_NOTICE_MAIL_COST = { page: 256, decisionReads: 1, timeoutMs: 5_000 } as const;
export interface SafetyNoticeMail {
  deliveryId: string;
  recipient: { userId: string } | { contactEmail: string };
  caseId: string;
  outcome: string;
  contentLanguage: string;
  credential?: string;
  reasons?: { facts: string; scope: string; duration: string; automation: boolean };
}
type NoticeParty = {
  id: string;
  principal_id: string;
  credential: string;
  account_subject: string;
};
type NoticeReporter = {
  id: string;
  received_at: string;
  contact_email: string | null;
  account_subject: string | null;
  content_language: string | null;
};

function reporterDelivery(decisionId: string, reportId: string): string {
  const bytes = createHash('sha256')
    .update(`safety-report-mail-v1\0${decisionId}\0${reportId}`)
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Private service-to-service correspondence. No generic event or provider
 * payload carries a retained contact or case credential. Account's encrypted
 * queue acknowledgement is durable intake, never proof of SMTP delivery.
 * Notices record accepted decisions; effect progress remains in the private
 * status API. Waiting for effects would hold mail behind an unresolved case. */
export class SafetyDecisionMail {
  constructor(
    private readonly access: Pool,
    private readonly issuer: string,
    private readonly intake: (input: SafetyNoticeMail) => Promise<void>,
  ) {}

  async enqueueDecision(decisionId: string): Promise<void> {
    const client = await this.access.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      await requireAccessOpen(client);
      const decision = (
        await client.query<{
          case_id: string;
          outcome: string;
          disclosure: string;
          statement_of_reasons: SafetyNoticeMail['reasons'] & { contentLanguage: string };
        }>(
          `
        SELECT d.case_id,d.outcome,d.disclosure,d.statement_of_reasons
        FROM access.moderation_decision d JOIN access.governance_case c ON c.id = d.case_id
        WHERE d.id = $1 AND c.decision_head = d.id AND d.statement_of_reasons IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM access.safety_decision_operation op
            WHERE op.decision_id = d.id AND op.cancelled)
          FOR SHARE OF c`,
          [decisionId],
        )
      ).rows[0];
      if (!decision) {
        await client.query('COMMIT');
        return;
      }
      const reasons = decision.statement_of_reasons;
      const base = {
        caseId: decision.case_id,
        outcome: decision.outcome,
        contentLanguage: reasons.contentLanguage,
      };
      let afterParty: string | null = null;
      while (true) {
        const parties: NoticeParty[] = (
          await client.query<NoticeParty>(
            `
          SELECT n.id,n.principal_id,n.credential,p.account_subject FROM access.safety_party_notice n
          JOIN access.principal p ON p.id = n.principal_id
          WHERE n.decision_id = $1 AND p.account_issuer = $2
            AND ($3::uuid IS NULL OR n.principal_id > $3)
            AND NOT EXISTS (SELECT 1 FROM access.outbox o
              WHERE o.principal_id = p.id AND o.kind = 'account.deletion_fenced')
          ORDER BY n.principal_id LIMIT $4`,
            [decisionId, this.issuer, afterParty, SAFETY_NOTICE_MAIL_COST.page],
          )
        ).rows;
        for (const party of parties) {
          await this.intake({
            ...base,
            deliveryId: party.id,
            recipient: { userId: party.account_subject },
            credential: party.credential,
            reasons: {
              facts: reasons.facts,
              scope: reasons.scope,
              duration: reasons.duration,
              automation: reasons.automation,
            },
          });
        }
        if (parties.length < SAFETY_NOTICE_MAIL_COST.page) break;
        afterParty = parties.at(-1)!.principal_id;
      }
      let afterReport: Pick<NoticeReporter, 'received_at' | 'id'> | null = null;
      while (true) {
        const reporters: NoticeReporter[] = (
          await client.query<NoticeReporter>(
            `
          SELECT r.id,r.received_at::text,r.contact_email,p.account_subject,r.content_language
          FROM access.governance_report r LEFT JOIN access.principal p ON p.id = r.principal_id
          WHERE r.case_id = $1 AND ((r.principal_id IS NULL AND r.contact_email IS NOT NULL)
            OR (p.account_issuer = $2 AND NOT EXISTS (SELECT 1 FROM access.outbox o
              WHERE o.principal_id = p.id AND o.kind = 'account.deletion_fenced')))
            AND ($3::timestamptz IS NULL OR (r.received_at,r.id) > ($3,$4::uuid))
            AND NOT EXISTS (SELECT 1 FROM access.safety_party_notice n
              WHERE n.decision_id = $5 AND n.principal_id = r.principal_id)
          ORDER BY r.received_at,r.id LIMIT $6`,
            [
              decision.case_id,
              this.issuer,
              afterReport?.received_at ?? null,
              afterReport?.id ?? null,
              decisionId,
              SAFETY_NOTICE_MAIL_COST.page,
            ],
          )
        ).rows;
        for (const report of reporters) {
          await this.intake({
            ...base,
            deliveryId: reporterDelivery(decisionId, report.id),
            recipient: report.account_subject
              ? { userId: report.account_subject }
              : { contactEmail: report.contact_email! },
            contentLanguage: report.content_language ?? base.contentLanguage,
            // Match public-report status disclosure: private reasons belong only to affected parties.
            ...(decision.disclosure !== 'private'
              ? {
                  reasons: {
                    facts: reasons.facts,
                    scope: reasons.scope,
                    duration: reasons.duration,
                    automation: reasons.automation,
                  },
                }
              : {}),
          });
        }
        if (reporters.length < SAFETY_NOTICE_MAIL_COST.page) break;
        afterReport = reporters.at(-1)!;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

export function accountSafetyNoticeIntake(accountUrl: string, secret: string) {
  const url = new URL('/api/internal/safety-correspondence', accountUrl);
  return async (input: SafetyNoticeMail): Promise<void> => {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(SAFETY_NOTICE_MAIL_COST.timeoutMs),
    });
    await response.body?.cancel();
    // Do not log bodies or transport exceptions: they may contain private correspondence.
    if (!response.ok) throw new Error('Account safety correspondence intake unavailable');
  };
}
