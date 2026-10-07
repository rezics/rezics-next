import type { Pool, PoolClient } from 'pg';
import { GovernanceUnavailable, type GovernanceStore } from '../governance/store.ts';
import { requireAccessOpen } from '../notification/store.ts';
import { COUNTER_NOTICE_COST, type CounterDeclaration } from './counter-notice.ts';

export interface CounterNoticeMail {
  deliveryId: string;
  recipient: { contactEmail: string } | { userId: string };
  caseId: string;
  outcome: 'counter_notice';
  contentLanguage: string;
  credential: string;
  counterNotice: { statement: string; declaration: string; receivedAt: string };
}
export type CounterNoticeDelivery =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'uncertain'
  | 'expired'
  | 'unavailable';

/** Durable due index, one leased page per invocation, at most one Account call
 * and one existing 64-target restoration operation per job. Queue intake is
 * not delivery: Account's sent state is a release gate independent of the
 * intake receipt clock. Receipt windows surface undelivered cases to staff. */
export class RightsCounterNotices {
  constructor(
    private readonly pool: Pool,
    private readonly governance: GovernanceStore,
    private readonly send: (mail: CounterNoticeMail) => Promise<CounterNoticeDelivery>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireAccessOpen(client);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async runPage(
    limit: number = COUNTER_NOTICE_COST.page,
  ): Promise<{ processed: number; deferred: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > COUNTER_NOTICE_COST.page)
      throw new RangeError('Invalid due page');
    const now = this.clock();
    const jobs = await this.transaction(
      async (client) =>
        (
          await client.query<{ step_id: string; phase: string }>(
            `
      WITH page AS (SELECT step_id FROM access.rights_counter_notice
        WHERE phase IN ('delivery','waiting','restoring') AND next_attempt_at <= $1
        ORDER BY next_attempt_at,step_id LIMIT $2 FOR UPDATE SKIP LOCKED)
      UPDATE access.rights_counter_notice j SET next_attempt_at = $3 FROM page
      WHERE j.step_id = page.step_id RETURNING j.step_id,j.phase`,
            [now, limit, new Date(now.getTime() + COUNTER_NOTICE_COST.retryMs)],
          )
        ).rows,
    );
    let deferred = 0;
    for (const job of jobs) {
      try {
        if (job.phase === 'delivery') await this.deliver(job.step_id);
        else {
          const result = await this.governance.restoreCounterNotice(job.step_id);
          await this.transaction(async (client) => {
            await client.query(
              `UPDATE access.rights_counter_notice SET phase = $2,restoration_id = $3
              WHERE step_id = $1 AND phase IN ('waiting','restoring')`,
              [job.step_id, result.phase, result.decisionId],
            );
          });
        }
      } catch {
        // The durable lease expires for retries. Do not log mail bodies, contacts,
        // credentials or owner errors that might contain private correspondence.
        deferred++;
      }
    }
    return { processed: jobs.length, deferred };
  }

  private async deliver(stepId: string): Promise<void> {
    const mail = await this.transaction(async (client) => {
      const row = (
        await client.query<{
          case_id: string;
          delivery_id: string;
          claimant_credential: string;
          content_language: string;
          statement: string;
          declarations: CounterDeclaration;
          contact: string | null;
          received_at: Date;
        }>(
          `
        SELECT j.case_id,j.delivery_id,j.claimant_credential,j.received_at,s.content_language,s.statement,s.declarations,
          COALESCE(r.contact_email,rc.claimant_contact) AS contact
        FROM access.rights_counter_notice j JOIN access.governance_process_step s ON s.id = j.step_id
        JOIN access.governance_report r ON r.id = j.report_id
        JOIN access.rights_complaint rc ON rc.report_id = r.id
        WHERE j.step_id = $1 AND j.phase = 'delivery'`,
          [stepId],
        )
      ).rows[0];
      if (!row) return null;
      // A retained claimant contact is the notice's designated recipient, even
      // when a staff principal recorded it on the claimant's behalf.
      const recipient =
        row.contact && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.contact)
          ? { contactEmail: row.contact }
          : null;
      if (!recipient) throw new GovernanceUnavailable('Claimant delivery address is unavailable');
      return {
        deliveryId: row.delivery_id,
        recipient,
        caseId: row.case_id,
        outcome: 'counter_notice' as const,
        contentLanguage: row.content_language,
        credential: row.claimant_credential,
        counterNotice: {
          statement: row.statement,
          declaration: JSON.stringify(row.declarations, null, 2),
          receivedAt: row.received_at.toISOString(),
        },
      };
    });
    if (!mail) return;
    const state = await this.send(mail);
    if (state === 'queued' || state === 'sending') return;
    if (state !== 'sent') throw new GovernanceUnavailable('Claimant delivery needs reconciliation');
    await this.transaction(async (client) => {
      const row = (
        await client.query<{ case_id: string; report_id: string; restriction_id: string }>(
          `
        SELECT case_id,report_id,restriction_id FROM access.rights_counter_notice WHERE step_id = $1`,
          [stepId],
        )
      ).rows[0]!;
      await client.query('SELECT id FROM access.governance_case WHERE id = $1 FOR UPDATE', [
        row.case_id,
      ]);
      const held = await client.query(
        'SELECT 1 FROM access.rights_counter_notice WHERE step_id = $1 AND phase = $2 FOR UPDATE',
        [stepId, 'delivery'],
      );
      if (!held.rowCount) return;
      const delivered = this.clock();
      await client.query(
        `INSERT INTO access.governance_process_step
          (id,case_id,report_id,decision_id,process,step,idempotency_key,request_digest,occurred_at,due_at)
          SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,'dmca_512','claimant_notice',$1::text,request_digest,$5::timestamptz,NULL
          FROM access.governance_process_step WHERE id = $6`,
        [Bun.randomUUIDv7(), row.case_id, row.report_id, row.restriction_id, delivered, stepId],
      );
      await client.query(
        `UPDATE access.rights_counter_notice SET delivered_at = $2,
        next_attempt_at = GREATEST(not_before,$2),phase = 'waiting' WHERE step_id = $1`,
        [stepId, delivered],
      );
    });
  }
}

export function accountCounterNoticeIntake(accountUrl: string, secret: string) {
  const url = new URL('/api/internal/safety-correspondence', accountUrl);
  return async (input: CounterNoticeMail): Promise<CounterNoticeDelivery> => {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GovernanceUnavailable('Counter-notice delivery is unavailable');
    }
    const result = (await response.json()) as { state: CounterNoticeDelivery };
    return result.state;
  };
}

export class RightsCounterNoticeWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly notices: RightsCounterNotices) {}
  start(): void {
    if (this.timer) throw new Error('Rights counter-notice worker already started');
    const poll = () => {
      if (this.running) return;
      this.running = this.notices
        .runPage()
        .then((result) => {
          if (result.deferred)
            console.warn('Rights counter-notice work deferred:', result.deferred);
        })
        .catch(() => {
          console.warn('Rights counter-notice pass unavailable');
        })
        .finally(() => {
          this.running = null;
        });
    };
    poll();
    this.timer = setInterval(poll, COUNTER_NOTICE_COST.retryMs);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
