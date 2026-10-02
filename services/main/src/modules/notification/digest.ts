import type { Pool } from 'pg';
import { withWorkerTelemetry } from '@rezics/observability/runtime';
import type { NotificationStore, ProposalSubscriptionReason } from './store.ts';

/** One day and up to 51 event checks per tick. Account deduplicates the day
 * before its SMTP queue, so a lost HTTP acknowledgement can be retried. */
export const DIGEST_COST = { candidatesPerDay: 50, daysPerTick: 1, intervalMs: 1_000 } as const;
interface Day { principal_id: string; day: string; account_subject: string }
interface Candidate { topic: string; purpose: string; subject_owner: string; subject_ref: string;
  subject_revision: string | null; disclosure_basis: string; realm: string | null; proposal_reason: ProposalSubscriptionReason | null }

export class NotificationDigestWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly access: Pool, private readonly notifications: NotificationStore,
    private readonly issuer: string, private readonly accountUrl: string,
    private readonly clientSecret: string) {}

  async runOnce(): Promise<boolean> {
    const claimed = await this.access.query<Day>(`UPDATE access.notification_digest_day d
      SET state = 'sending', lease_until = clock_timestamp() + interval '2 minutes'
      FROM (SELECT d.principal_id, d.day FROM access.notification_digest_day d
        WHERE d.day < (clock_timestamp() AT TIME ZONE 'UTC')::date
          AND (d.state = 'pending' OR d.state = 'sending' AND d.lease_until < clock_timestamp())
        ORDER BY d.day, d.principal_id LIMIT 1 FOR UPDATE SKIP LOCKED) due,
        access.principal p
      WHERE d.principal_id = due.principal_id AND d.day = due.day
        AND p.id = d.principal_id
      RETURNING d.principal_id, d.day::text, p.account_subject`);
    const day = claimed.rows[0];
    if (!day) return false;
    try {
      const current = (await this.access.query<{ account_issuer: string; active: boolean }>(
        'SELECT account_issuer, active FROM access.principal WHERE id = $1', [day.principal_id])).rows[0];
      const counts = new Map<string, number>();
      let more = false;
      if (current?.active && current.account_issuer === this.issuer) {
        const candidates = (await this.access.query<Candidate>(
            `SELECT c.topic, c.purpose,
          c.subject_owner, c.subject_ref, c.subject_revision, c.disclosure_basis, c.realm, c.proposal_reason
          FROM access.notification_digest_candidate c
          JOIN access.notification_preference n ON n.principal_id = c.principal_id
            AND n.purpose = c.purpose AND n.topic = c.topic AND n.channel = 'email'
            AND n.state = 'enabled'
          WHERE c.principal_id = $1 AND c.day = $2
            AND NOT EXISTS (SELECT 1 FROM access.proposal_subscription sub
              WHERE sub.principal_id = c.principal_id AND sub.proposal = c.proposal
                AND sub.level = 'ignore' AND c.disclosure_basis = 'editorial-proposal-v1')
          ORDER BY c.source_event, c.topic LIMIT $3`,
        [day.principal_id, day.day, DIGEST_COST.candidatesPerDay + 1])).rows;
        const inputs = candidates.map(candidate => ({ principalId: day.principal_id,
            owner: candidate.subject_owner, ref: candidate.subject_ref,
            revision: candidate.subject_revision, disclosureBasis: candidate.disclosure_basis,
            realm: candidate.realm, recipientReason: candidate.proposal_reason }));
        const disclosed = typeof this.notifications.resolveDigestSubjects === 'function'
          ? await this.notifications.resolveDigestSubjects(inputs)
          : await Promise.all(inputs.map(input => this.notifications.resolveDigestSubject(input)));
        for (const [index, candidate] of candidates.entries()) {
          const subject = disclosed[index]!;
          if (subject.status === 'unavailable') throw new Error('digest subject unavailable');
          if (subject.status !== 'available') continue;
          if (index === DIGEST_COST.candidatesPerDay) { more = true; continue; }
          counts.set(candidate.topic,
            (counts.get(candidate.topic) ?? 0) + 1);
        }
      }
      if (counts.size) {
        const enabled = (await this.access.query<{ topic: string }>(`SELECT topic
          FROM access.notification_preference WHERE principal_id = $1 AND channel = 'email'
            AND state = 'enabled' AND topic = ANY($2::text[])`,
        [day.principal_id, [...counts.keys()]])).rows;
        const topics = new Set(enabled.map(row => row.topic));
        const body = { userId: day.account_subject, day: day.day,
          counts: [...counts].filter(([topic]) => topics.has(topic))
            .map(([topic, count]) => ({ topic, count })), more };
        if (body.counts.length) {
          const response = await fetch(this.accountUrl, { method: 'POST',
            headers: { authorization: `Bearer ${this.clientSecret}`, 'content-type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
          if (response.status !== 204) throw new Error('Account digest intake unavailable');
        }
      }
      await this.access.query(`DELETE FROM access.notification_digest_candidate
        WHERE principal_id = $1 AND day = $2`, [day.principal_id, day.day]);
      await this.access.query(`UPDATE access.notification_digest_day
        SET state = 'sent', lease_until = NULL WHERE principal_id = $1 AND day = $2
          AND state = 'sending'`, [day.principal_id, day.day]);
    } catch (error) {
      await this.access.query(`UPDATE access.notification_digest_day
        SET state = 'pending', lease_until = NULL WHERE principal_id = $1 AND day = $2
          AND state = 'sending'`, [day.principal_id, day.day]).catch(() => {});
      throw error;
    }
    return true;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = withWorkerTelemetry('main.notification.digest', () => this.runOnce(), worked => ({
        outcome: worked ? 'worked' : 'idle', processed: worked ? 1 : 0, unit: 'day',
      })).then(() => {}, () => {
        console.error('Notification digest intake unavailable');
      }).finally(() => { this.running = null; });
    }, DIGEST_COST.intervalMs);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
