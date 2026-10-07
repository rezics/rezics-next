import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { requireAccessOpen } from '../notification/store.ts';
import { prepareDecisionNotices, unrecordedReasons } from './notices.ts';
import type { ModerationEffects } from './effects.ts';
import type { StatementOfReasons } from './store.ts';

/** Indexed decision/head read and bounded keyset pages for each party family.
 * Intake keys survive a partial commit or lost Account acknowledgement. */
export const SAFETY_NOTICE_MAIL_COST = {
  page: 256,
  recipientPagesPerInvocation: 1,
  decisionReads: 1,
  timeoutMs: 5_000,
} as const;

/** Saved progress is retryable; the existing producer must retain its event cursor. */
export class SafetyNoticeContinuation extends Error {
  constructor() {
    super('Safety notice continuation pending');
  }
}
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
  deliverable: boolean;
};
type NoticeReporter = {
  id: string;
  received_at: string;
  contact_email: string | null;
  account_subject: string | null;
  content_language: string | null;
  deliverable: boolean;
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
    private readonly effects?: Pick<ModerationEffects, 'participants'>,
    private readonly pageSize: number = SAFETY_NOTICE_MAIL_COST.page,
  ) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SAFETY_NOTICE_MAIL_COST.page)
      throw new Error('Invalid safety notice page size');
  }

  async enqueueDecision(decisionId: string): Promise<void> {
    if (!(await this.enqueuePage(decisionId))) throw new SafetyNoticeContinuation();
  }

  /** True means complete. False commits exactly one discovery or delivery page. */
  async enqueuePage(decisionId: string): Promise<boolean> {
    const client = await this.access.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireAccessOpen(client);
      const decision = (
        await client.query<{
          case_id: string;
          outcome: string;
          disclosure: string;
          statement_of_reasons: StatementOfReasons | null;
        }>(
          `SELECT d.case_id,d.outcome,d.disclosure,d.statement_of_reasons
        FROM access.moderation_decision d JOIN access.governance_case c ON c.id = d.case_id
        WHERE d.id = $1 AND NOT EXISTS (SELECT 1 FROM access.safety_decision_operation op
          WHERE op.decision_id = d.id AND op.cancelled) FOR SHARE OF c`,
          [decisionId],
        )
      ).rows[0];
      if (!decision) {
        await client.query('COMMIT');
        return true;
      }
      const created = await client.query(
        `INSERT INTO access.safety_notice_mail_cursor(decision_id)
        VALUES ($1) ON CONFLICT DO NOTHING RETURNING decision_id`,
        [decisionId],
      );
      const cursor = (
        await client.query<{
          phase: 'parties' | 'reporters' | 'done';
          after_party: string | null;
          after_report_at: string | null;
          after_report: string | null;
        }>(
          `SELECT phase,after_party,after_report_at::text,after_report
        FROM access.safety_notice_mail_cursor WHERE decision_id = $1 FOR UPDATE`,
          [decisionId],
        )
      ).rows[0]!;
      if (cursor.phase === 'done') {
        await client.query('COMMIT');
        return true;
      }
      const reasons = decision.statement_of_reasons ?? unrecordedReasons;
      if (created.rowCount) {
        // Legacy decisions have no discovery jobs. This bounded copy also makes
        // their absent reasons explicit without mutating the immutable decision.
        await client.query(
          `INSERT INTO access.safety_notice_job(decision_id,ordinal,target,participant)
          SELECT t.decision_id,t.ordinal,jsonb_build_object('owner',t.owner,'resource',t.resource,
            'component',t.component,'locator',t.locator,'revision',t.revision,
            'scopeKind',t.scope_kind,'expectedHead',t.expected_head,'effect',t.effect),t.participant_subject
          FROM access.moderation_decision_target t WHERE t.decision_id = $1
          ORDER BY t.ordinal LIMIT 64 ON CONFLICT DO NOTHING`,
          [decisionId],
        );
      }
      if (
        !(await prepareDecisionNotices(
          client,
          decisionId,
          decision.case_id,
          reasons,
          this.effects,
          Math.min(this.pageSize, 50),
        ))
      ) {
        await client.query('COMMIT');
        return false;
      }
      const base = {
        caseId: decision.case_id,
        outcome: decision.outcome,
        contentLanguage: reasons.contentLanguage,
      };
      const send = async (input: SafetyNoticeMail) => {
        if (
          (
            await client.query(
              `SELECT 1 FROM access.safety_notice_mail_receipt
          WHERE delivery_id = $1`,
              [input.deliveryId],
            )
          ).rowCount
        )
          return;
        // Account intake binds this identity to an encrypted immutable queue
        // receipt. A lost acknowledgement replays that identity, never SMTP.
        await this.intake(input);
        await client.query(
          `INSERT INTO access.safety_notice_mail_receipt(delivery_id,decision_id)
          VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [input.deliveryId, decisionId],
        );
      };
      if (cursor.phase === 'parties') {
        const parties = (
          await client.query<NoticeParty>(
            `WITH page AS MATERIALIZED (
          SELECT id,principal_id,credential FROM access.safety_party_notice
          WHERE decision_id = $1 AND ($3::uuid IS NULL OR principal_id > $3)
          ORDER BY principal_id LIMIT $4
        ) SELECT n.id,n.principal_id,n.credential,p.account_subject,
          (p.account_issuer = $2 AND NOT EXISTS (SELECT 1 FROM access.outbox o
            WHERE o.principal_id = p.id AND o.kind = 'account.deletion_fenced')) AS deliverable
          FROM page n JOIN access.principal p ON p.id = n.principal_id ORDER BY n.principal_id`,
            [decisionId, this.issuer, cursor.after_party, this.pageSize],
          )
        ).rows;
        for (const party of parties) {
          if (party.deliverable === false) continue;
          await send({
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
        await client.query(
          `UPDATE access.safety_notice_mail_cursor SET after_party = $2,phase = $3
          WHERE decision_id = $1`,
          [
            decisionId,
            parties.at(-1)?.principal_id ?? cursor.after_party,
            parties.length < this.pageSize ? 'reporters' : 'parties',
          ],
        );
        await client.query('COMMIT');
        return false;
      }
      const reporters = (
        await client.query<NoticeReporter>(
          `WITH page AS MATERIALIZED (
        SELECT id,received_at,contact_email,principal_id,content_language FROM access.governance_report
        WHERE case_id = $1 AND ($3::timestamptz IS NULL OR (received_at,id) > ($3,$4::uuid))
        ORDER BY received_at,id LIMIT $6
      ) SELECT r.id,r.received_at::text,r.contact_email,p.account_subject,r.content_language,
        COALESCE(((r.principal_id IS NULL AND r.contact_email IS NOT NULL)
          OR (p.account_issuer = $2 AND NOT EXISTS (SELECT 1 FROM access.outbox o
            WHERE o.principal_id = p.id AND o.kind = 'account.deletion_fenced')))
          AND NOT EXISTS (SELECT 1 FROM access.safety_party_notice n
            WHERE n.decision_id = $5 AND n.principal_id = r.principal_id),false) AS deliverable
        FROM page r LEFT JOIN access.principal p ON p.id = r.principal_id
        ORDER BY r.received_at,r.id`,
          [
            decision.case_id,
            this.issuer,
            cursor.after_report_at,
            cursor.after_report,
            decisionId,
            this.pageSize,
          ],
        )
      ).rows;
      for (const report of reporters) {
        if (report.deliverable === false) continue;
        await send({
          ...base,
          deliveryId: reporterDelivery(decisionId, report.id),
          recipient: report.account_subject
            ? { userId: report.account_subject }
            : { contactEmail: report.contact_email! },
          contentLanguage: report.content_language ?? base.contentLanguage,
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
      const done = reporters.length < this.pageSize;
      await client.query(
        `UPDATE access.safety_notice_mail_cursor SET after_report_at = $2,
        after_report = $3,phase = $4 WHERE decision_id = $1`,
        [
          decisionId,
          reporters.at(-1)?.received_at ?? cursor.after_report_at,
          reporters.at(-1)?.id ?? cursor.after_report,
          done ? 'done' : 'reporters',
        ],
      );
      await client.query('COMMIT');
      return done;
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
