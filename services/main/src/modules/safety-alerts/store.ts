import type { Pool, PoolClient } from 'pg';
import type { NotificationSubjectReader } from '../notification/dispatcher.ts';
import { requireAccessOpen, sha256, type NotificationStore } from '../notification/store.ts';
import type { SafetyResponders } from './roster.ts';

export { safetyResponders, type SafetyResponders } from './roster.ts';

export const SAFETY_ALERT_BASIS = 'safety-deadline-v1';
/** Two active-case deadline selections and one pending page; no inventory-sized writes.
 * Source selections read open platform cases and at most 32 eligible steps per
 * case, then create at most 32 alerts per responder. This is an output bound,
 * not a 32-row scan bound; reads scale with active cases and their due steps.
 * Each tick takes at most 32 source intakes, with one recipient and <=8 endpoints each.
 * PostgreSQL 18 SKIP LOCKED is for queue consumers, not an authoritative case read:
 * https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE */
export const SAFETY_ALERT_COST = {
  batch: 32,
  leadMs: 2 * 3600_000,
  acknowledgementMs: 30 * 60_000,
  statementTimeoutMs: 5000,
  sourceStatements: 14,
  statementsPerIntake: 2,
} as const;

// MATERIALIZED prevents flattening back into a scan from the oldest global
// deadline. The bounded LATERAL read uses safety_case_due for each open case:
// https://www.postgresql.org/docs/18/queries-with.html#QUERIES-WITH-CTE-MATERIALIZATION
export const SAFETY_ALERT_SOURCE_SQL = `WITH open_cases AS MATERIALIZED (
  SELECT id,generation,review_pending FROM access.governance_case
  WHERE authority_kind = 'platform' AND authority_scope_id = 'governance:platform' AND state = 'open'
)
INSERT INTO access.safety_alert
  (step_id,case_id,case_generation,principal_id,responder,reason,due_at,created_at)
SELECT s.id,c.id,c.generation,$1,$2,
  CASE WHEN s.due_at <= $3 THEN 'overdue' WHEN $2 = 'primary' THEN 'approaching' ELSE 'unacknowledged' END,
  s.due_at,$3
FROM open_cases c CROSS JOIN LATERAL (
  SELECT s.id,s.due_at FROM access.governance_process_step s
  WHERE s.case_id = c.id AND s.process IN ('ncii','dmca_512')
    AND s.due_at <= $3::timestamptz + ($4::bigint * interval '1 millisecond')
    AND (c.review_pending OR s.step IN ('restoration_not_before','restoration_not_after'))
    AND NOT EXISTS (SELECT 1 FROM access.moderation_decision d WHERE d.answers_step_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM access.rights_counter_notice j WHERE j.case_id = s.case_id
      AND ((j.restriction_id = s.decision_id AND j.phase IN ('done','stayed'))
        OR (j.report_id = s.report_id AND s.step IN ('restoration_not_before','restoration_not_after')
          AND (s.decision_id IS NULL OR (j.restriction_id = s.decision_id AND s.due_at IS DISTINCT FROM
            CASE s.step WHEN 'restoration_not_before' THEN j.not_before ELSE j.not_after END)))))
    AND NOT EXISTS (SELECT 1 FROM access.safety_alert a WHERE a.step_id = s.id
      AND a.case_generation = c.generation AND a.responder = $2 AND a.principal_id = $1)
    AND ($2 = 'primary' OR s.due_at <= $3 OR NOT $7::boolean OR EXISTS (
      SELECT 1 FROM access.safety_alert a WHERE a.step_id = s.id AND a.case_generation = c.generation
        AND a.responder = 'primary' AND a.principal_id = $5 AND a.state = 'queued'
        AND a.queued_at <= $3::timestamptz - ($6::bigint * interval '1 millisecond')
        AND NOT EXISTS (SELECT 1 FROM access.safety_case_claim claim WHERE claim.case_id = c.id
          AND claim.case_generation = c.generation AND claim.principal_id = $5 AND claim.expires_at > $3)))
  ORDER BY s.due_at,s.id LIMIT $8
) s ORDER BY s.due_at,s.id LIMIT $8 ON CONFLICT DO NOTHING`;
type Recipient = { id: string; account_subject: string; active: boolean };
type Alert = {
  id: string;
  case_id: string;
  principal_id: string;
  responder: 'primary' | 'backup';
  reason: 'approaching' | 'unacknowledged' | 'overdue';
  due_at: Date;
};

/** Only process metadata crosses the notification boundary; evidence never does. */
export class SafetyAlerts implements NotificationSubjectReader {
  constructor(
    private readonly pool: Pool,
    private readonly notifications: Pick<NotificationStore, 'enqueue' | 'registerEndpoint'>,
    private readonly responders: SafetyResponders,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async recipients(client: Pick<PoolClient, 'query'>) {
    const rows = (
      await client.query<Recipient>(
        `SELECT id, account_subject, active FROM access.principal
      WHERE account_issuer = $1 AND account_subject = ANY($2::text[]) ORDER BY id`,
        [this.responders.issuer, [this.responders.primary, this.responders.backup]],
      )
    ).rows;
    const primary = rows.find((row) => row.account_subject === this.responders.primary);
    const backup = rows.find((row) => row.account_subject === this.responders.backup);
    if (!primary || !backup)
      throw new Error('Safety responder Account subjects must already exist in Access');
    return { primary, backup };
  }

  /** Operator configuration does not grant moderation or evidence authority. */
  async initialize(): Promise<void> {
    const recipients = await this.recipients(this.pool);
    for (const row of [recipients.primary, recipients.backup]) {
      if (!row.active) throw new Error('Safety responder must be an active Access principal');
      // The endpoint represents Account identity, never an email address. Reuse an
      // existing email endpoint so startup does not rotate/cancel durable deliveries.
      if (
        !(
          await this.pool.query(
            `SELECT 1 FROM access.notification_endpoint
        WHERE principal_id = $1 AND channel = 'email' AND state = 'active'`,
            [row.id],
          )
        ).rowCount
      ) {
        await this.notifications.registerEndpoint(
          { issuer: this.responders.issuer, subject: row.account_subject },
          {
            channel: 'email',
            deviceId: null,
            address: null,
            addressDigest: sha256(
              `safety-account-v1:${this.responders.issuer}:${row.account_subject}`,
            ),
            lockScreenDisclosure: false,
          },
        );
      }
    }
  }

  async resolve(input: Parameters<NotificationSubjectReader['resolve']>[0]) {
    if (
      input.owner !== 'access' ||
      input.disclosureBasis !== SAFETY_ALERT_BASIS ||
      !/^[0-9a-f-]{36}$/.test(input.ref)
    )
      return { status: 'undisclosed' as const };
    const row = (
      await this.pool.query<Alert>(
        `SELECT a.id,a.case_id,a.principal_id,a.responder,a.reason,a.due_at
      FROM access.safety_alert a JOIN access.principal p ON p.id = a.principal_id AND p.active
      JOIN access.governance_case c ON c.id = a.case_id AND c.generation = a.case_generation
      WHERE a.id = $1 AND a.principal_id = $2 AND a.state <> 'cancelled'
        AND p.account_issuer = $3 AND p.account_subject = CASE a.responder WHEN 'primary' THEN $4 ELSE $5 END
        AND c.state = 'open' AND (c.review_pending OR EXISTS (
          SELECT 1 FROM access.governance_process_step s WHERE s.id = a.step_id
            AND s.step IN ('restoration_not_before','restoration_not_after')))
        AND NOT EXISTS (SELECT 1 FROM access.moderation_decision d WHERE d.answers_step_id = a.step_id)
        AND NOT EXISTS (SELECT 1 FROM access.governance_process_step s JOIN access.rights_counter_notice j
          ON j.case_id = s.case_id WHERE s.id = a.step_id
            AND ((j.restriction_id = s.decision_id AND j.phase IN ('done','stayed'))
              OR (j.report_id = s.report_id AND s.step IN ('restoration_not_before','restoration_not_after')
                AND (s.decision_id IS NULL OR (j.restriction_id = s.decision_id AND s.due_at IS DISTINCT FROM
                  CASE s.step WHEN 'restoration_not_before' THEN j.not_before ELSE j.not_after END)))))`,
        [
          input.ref,
          input.principalId,
          this.responders.issuer,
          this.responders.primary,
          this.responders.backup,
        ],
      )
    ).rows[0];
    return row
      ? {
          status: 'available' as const,
          subject: {
            private: true,
            fields: {
              alertId: row.id,
              deadline: row.due_at.toISOString(),
              reason: row.due_at <= this.clock() ? 'overdue' : row.reason,
            },
          },
        }
      : { status: 'undisclosed' as const };
  }

  /** Source commits before notification intake. A crash on either side of intake
   * replays the same alert id through NotificationStore's durable seen key. */
  async runOnce(): Promise<number> {
    const now = this.clock();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      await requireAccessOpen(client);
      const { primary, backup } = await this.recipients(client);
      for (const [responder, recipient] of [
        ['primary', primary],
        ['backup', backup],
      ] as const) {
        if (!recipient.active) continue;
        await client.query(SAFETY_ALERT_SOURCE_SQL, [
          recipient.id,
          responder,
          now,
          SAFETY_ALERT_COST.leadMs,
          primary.id,
          SAFETY_ALERT_COST.acknowledgementMs,
          primary.active,
          SAFETY_ALERT_COST.batch,
        ]);
      }
      await client.query('COMMIT');
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      await requireAccessOpen(client);
      const alerts = (
        await client.query<Alert>(
          `SELECT id,case_id,principal_id,responder,reason,due_at
        FROM access.safety_alert WHERE state = 'pending' ORDER BY created_at,id
        LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [SAFETY_ALERT_COST.batch],
        )
      ).rows;
      for (const alert of alerts) {
        const visible = await this.resolve({
          principalId: alert.principal_id,
          owner: 'access',
          ref: alert.id,
          revision: null,
          disclosureBasis: SAFETY_ALERT_BASIS,
        });
        const intake =
          visible.status === 'available'
            ? (
                await this.notifications.enqueue({
                  sourceOwner: 'access',
                  sourceEvent: `safety-alert:${alert.id}`,
                  purpose: 'security',
                  topic: 'safety-deadline',
                  subject: { owner: 'access', ref: alert.id, revision: null },
                  disclosureBasis: SAFETY_ALERT_BASIS,
                  recipients: [alert.principal_id],
                })
              )[0]
            : undefined;
        await client.query(
          `UPDATE access.safety_alert SET state = $2,item_id = $3,queued_at = $4 WHERE id = $1`,
          [alert.id, intake ? 'queued' : 'cancelled', intake?.itemId ?? null, intake ? now : null],
        );
      }
      await client.query('COMMIT');
      return alerts.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
