import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { symmetricDecrypt } from 'better-auth/crypto';
import { safetyFixture, nciiDeclaration, png } from './g-744-support.ts';
import {
  SafetyAlerts,
  SAFETY_ALERT_BASIS,
  SAFETY_ALERT_COST,
  SAFETY_ALERT_SOURCE_SQL,
} from '../../../services/main/src/modules/safety-alerts/store.ts';
import { SafetyAlertProvider } from '../../../services/main/src/modules/safety-alerts/provider.ts';
import { NotificationProducer } from '../../../services/main/src/modules/notification-producers/producer.ts';
import { NotificationDispatcher } from '../../../services/main/src/modules/notification/dispatcher.ts';
import { notificationSafetyApi } from '../../../services/account/src/notification-safety.ts';
import { accountEmailQueue } from '../../../services/account/src/email.ts';
import {
  mailSuppressionApi,
  unsubscribeToken,
} from '../../../services/account/src/mail-suppression.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';

const deadlineFor = (receivedAt: string) => new Date(Date.parse(receivedAt) + 48 * 3600_000);
async function alertFixture(label: string) {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
  ]);
  try {
    const f = await safetyFixture(label, true, databases.urls);
    return {
      ...f,
      stop: async () => {
        await f.stop();
        await databases.close();
      },
    };
  } catch (error) {
    await databases.close();
    throw error;
  }
}
const alerts = async (f: Awaited<ReturnType<typeof safetyFixture>>) =>
  (
    await f.stack.accessPool.query<{
      id: string;
      responder: string;
      reason: string;
      state: string;
      due_at: Date;
    }>('SELECT * FROM access.safety_alert ORDER BY created_at,responder')
  ).rows;

test('SAFETY03/SAFETY08: G917 approaching deadline, absent primary, current acknowledgement and overdue escalation', async () => {
  const f = await alertFixture('g917-timing');
  try {
    const receipt = await f.report(await f.author.upload(png(70, 70)), 'ncii', nciiDeclaration);
    const deadline = deadlineFor(receipt.receivedAt);
    const approach = new Date(deadline.getTime() - SAFETY_ALERT_COST.leadMs);
    f.setClock(new Date(approach.getTime() - 1));
    await f.produce();
    expect(await alerts(f)).toHaveLength(0);
    f.setClock(approach);
    await Promise.all([f.produce(), f.produce()]);
    expect((await alerts(f)).map((a) => [a.responder, a.reason, a.state])).toEqual([
      ['primary', 'approaching', 'queued'],
    ]);
    await f.claim(receipt);
    f.setClock(new Date(approach.getTime() + SAFETY_ALERT_COST.acknowledgementMs - 1));
    await f.claim(receipt); // Renewed engagement suppresses absence, not the legal deadline.
    f.setClock(new Date(approach.getTime() + SAFETY_ALERT_COST.acknowledgementMs));
    await f.produce();
    expect(await alerts(f)).toHaveLength(1);
    f.setClock(new Date(approach.getTime() + 2 * SAFETY_ALERT_COST.acknowledgementMs));
    await f.produce();
    expect((await alerts(f)).find((a) => a.responder === 'backup')?.reason).toBe('unacknowledged');
    const second = await f.report(await f.author.upload(png(71, 71)), 'ncii', nciiDeclaration);
    const secondDeadline = deadlineFor(second.receivedAt);
    f.setClock(new Date(secondDeadline.getTime() - 1));
    await f.claim(second);
    await f.produce();
    f.setClock(secondDeadline);
    await f.produce();
    const overdue = (
      await f.stack.accessPool.query(
        `SELECT * FROM access.safety_alert
      WHERE case_id = $1 AND responder = 'backup'`,
        [second.caseId],
      )
    ).rows[0];
    expect(overdue.reason).toBe('overdue');
    expect(overdue.due_at.toISOString()).toBe(secondDeadline.toISOString());
    const payload = await f.safetyAlerts.resolve({
      principalId: f.backup.principalId,
      owner: 'access',
      ref: overdue.id,
      revision: null,
      disclosureBasis: SAFETY_ALERT_BASIS,
    });
    expect(payload.status).toBe('available');
    if (payload.status === 'available')
      expect(Object.keys(payload.subject.fields).sort()).toEqual(['alertId', 'deadline', 'reason']);
    expect(
      (
        await f.safetyAlerts.resolve({
          principalId: f.author.principalId,
          owner: 'access',
          ref: overdue.id,
          revision: null,
          disclosureBasis: SAFETY_ALERT_BASIS,
        })
      ).status,
    ).toBe('undisclosed');
  } finally {
    await f.stop();
  }
}, 180_000);

test('SAFETY03/SAFETY08: G917 restart replays partial intake once and recovery holds stop the job', async () => {
  const f = await alertFixture('g917-restart');
  try {
    const image = await f.author.upload(png(72, 72));
    const receipt = await f.report(image, 'ncii', nciiDeclaration);
    f.setClock(deadlineFor(receipt.receivedAt));
    let loseAck = true;
    const crashed = new SafetyAlerts(
      f.stack.accessPool,
      {
        registerEndpoint: f.notifications.registerEndpoint.bind(f.notifications),
        enqueue: async (event) => {
          const result = await f.notifications.enqueue(event);
          if (loseAck) {
            loseAck = false;
            throw new Error('lost committed intake acknowledgement');
          }
          return result;
        },
      },
      {
        issuer: f.staff.principal.issuer,
        primary: f.staff.principal.subject,
        backup: f.backup.principal.subject,
      },
      () => deadlineFor(receipt.receivedAt),
    );
    await expect(crashed.runOnce()).rejects.toThrow('lost committed');
    expect((await alerts(f)).every((a) => a.state === 'pending')).toBe(true);
    await f.produce();
    await f.produce();
    expect((await alerts(f)).every((a) => a.state === 'queued')).toBe(true);
    const items = await f.stack.accessPool.query(
      `SELECT id FROM access.notification_item WHERE disclosure_basis = $1`,
      [SAFETY_ALERT_BASIS],
    );
    expect(items.rowCount).toBe(2);
    const delivery = await f.stack.accessPool.query(
      `SELECT delivery_state FROM access.safety_alert_delivery`,
    );
    expect(delivery.rows.map((row) => row.delivery_state)).toEqual(['pending', 'pending']);
    await f.stack.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    await expect(f.safetyAlerts.runOnce()).rejects.toThrow('recovery');
    await f.stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
    const step = (
      await f.stack.accessPool.query(
        'SELECT id FROM access.governance_process_step WHERE case_id = $1 AND step = $2',
        [receipt.caseId, 'removal_deadline'],
      )
    ).rows[0];
    await f.complete(await f.input(receipt, image, 'dismiss', null, step.id));
    const old = (await alerts(f))[0]!;
    expect(
      (
        await f.safetyAlerts.resolve({
          principalId: old.responder === 'primary' ? f.staff.principalId : f.backup.principalId,
          owner: 'access',
          ref: old.id,
          revision: null,
          disclosureBasis: SAFETY_ALERT_BASIS,
        })
      ).status,
    ).toBe('undisclosed');
    await f.produce();
    expect(await alerts(f)).toHaveLength(2);
  } finally {
    await f.stop();
  }
}, 180_000);

test('SAFETY03/SAFETY08: G917 open-case scan excludes closed and answered history, drains pages and survives primary revocation', async () => {
  const f = await alertFixture('g917-bounds');
  try {
    const receipt = await f.report(await f.author.upload(png(73, 73)), 'ncii', nciiDeclaration);
    const deadline = deadlineFor(receipt.receivedAt);
    const answeredImage = await f.author.upload(png(76, 76));
    const answered = await f.report(answeredImage, 'ncii', nciiDeclaration);
    const answeredStep = (
      await f.stack.accessPool.query(
        `SELECT id FROM access.governance_process_step WHERE case_id = $1 AND step = 'removal_deadline'`,
        [answered.caseId],
      )
    ).rows[0].id;
    await f.complete(await f.input(answered, answeredImage, 'restrict', null, answeredStep));
    // Keep this answered case in the active set to exercise the answer anti-join.
    await f.stack.accessPool.query(
      'UPDATE access.governance_case SET review_pending = true WHERE id = $1',
      [answered.caseId],
    );
    expect(
      (
        await f.stack.accessPool.query('SELECT state FROM access.governance_case WHERE id = $1', [
          answered.caseId,
        ])
      ).rows[0].state,
    ).toBe('open');
    const historyPrefix = `g917-closed-${randomUUID()}:`;
    await f.stack.accessPool.query(
      `WITH history AS (
        INSERT INTO access.governance_case
          (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure,opened_at)
        SELECT gen_random_uuid(),kind,authority_kind,authority_scope_id,context,target_owner,
          $2 || n::text,target_component,disclosure,opened_at - interval '1 year'
        FROM access.governance_case,generate_series(1,2000) n WHERE id = $1 RETURNING id
      ) INSERT INTO access.governance_process_step
        (id,case_id,report_id,process,step,idempotency_key,request_digest,occurred_at,due_at,content_language)
      SELECT gen_random_uuid(),history.id,s.report_id,s.process,s.step,gen_random_uuid()::text,s.request_digest,
        s.occurred_at - interval '1 year',s.due_at - interval '1 year',s.content_language
      FROM history CROSS JOIN access.governance_process_step s
      WHERE s.case_id = $1 AND s.step = 'removal_deadline'`,
      [receipt.caseId, historyPrefix],
    );
    await f.stack.accessPool.query(
      `UPDATE access.governance_case SET state = 'closed',closed_at = $2
        WHERE starts_with(target_resource,$1)`,
      [historyPrefix, deadline],
    );
    // One owner-created case; isolated copies of its deadline exercise >1 work page.
    await f.stack.accessPool.query(
      `INSERT INTO access.governance_process_step
      (id,case_id,report_id,process,step,idempotency_key,request_digest,occurred_at,due_at,content_language)
      SELECT gen_random_uuid(),case_id,report_id,process,step,gen_random_uuid()::text,request_digest,
        occurred_at,due_at,content_language FROM access.governance_process_step,
        generate_series(1,$2::int) WHERE case_id = $1 AND step = 'removal_deadline'`,
      [receipt.caseId, SAFETY_ALERT_COST.batch + 1],
    );
    await f.stack.accessPool.query(
      'ANALYZE access.governance_case,access.governance_process_step,access.moderation_decision',
    );
    const client = await f.stack.accessPool.connect();
    try {
      await client.query('BEGIN');
      // Exercise the exact production INSERT and undo its output before the job.
      const plan = await client.query<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SAFETY_ALERT_SOURCE_SQL}`,
        [
          f.staff.principalId,
          'primary',
          deadline,
          SAFETY_ALERT_COST.leadMs,
          f.staff.principalId,
          SAFETY_ALERT_COST.acknowledgementMs,
          true,
          SAFETY_ALERT_COST.batch,
        ],
      );
      const nodes: Record<string, unknown>[] = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? [])
          visit(child);
      };
      visit(plan.rows[0]!['QUERY PLAN'][0].Plan);
      const caseScan = nodes.find((node) => node['Relation Name'] === 'governance_case');
      expect(caseScan).toBeDefined();
      expect(caseScan?.['Node Type']).not.toBe('Seq Scan');
      expect(
        Number(caseScan?.['Actual Rows']) + Number(caseScan?.['Rows Removed by Filter'] ?? 0),
      ).toBeLessThanOrEqual(2);
      const stepScans = nodes.filter((node) => node['Relation Name'] === 'governance_process_step');
      expect(stepScans.length).toBeGreaterThan(0);
      for (const scan of stepScans) {
        expect(scan['Node Type']).not.toBe('Seq Scan');
        expect(String(scan['Index Cond'])).toContain('case_id');
      }
      const stepsRead = stepScans.reduce(
        (sum, scan) =>
          sum +
          Number(scan['Actual Loops']) *
            (Number(scan['Actual Rows']) + Number(scan['Rows Removed by Filter'] ?? 0)),
        0,
      );
      expect(stepsRead).toBeLessThanOrEqual(SAFETY_ALERT_COST.batch + 4);
      expect((await client.query('SELECT DISTINCT case_id FROM access.safety_alert')).rows).toEqual(
        [{ case_id: receipt.caseId }],
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    f.setClock(deadline);
    expect(await f.safetyAlerts.runOnce()).toBe(SAFETY_ALERT_COST.batch);
    await f.produce();
    expect(await alerts(f)).toHaveLength((SAFETY_ALERT_COST.batch + 2) * 2);
    expect((await alerts(f)).every((a) => a.state === 'queued')).toBe(true);
    const second = await f.report(await f.author.upload(png(74, 74)), 'ncii', nciiDeclaration);
    await f.stack.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [
      f.staff.principalId,
    ]);
    f.setClock(new Date(deadlineFor(second.receivedAt).getTime() - SAFETY_ALERT_COST.leadMs));
    await f.produce();
    const escalated = (
      await f.stack.accessPool.query('SELECT * FROM access.safety_alert WHERE case_id = $1', [
        second.caseId,
      ])
    ).rows;
    expect(escalated).toHaveLength(1);
    expect(escalated[0].responder).toBe('backup');
    expect(escalated[0].reason).toBe('unacknowledged');
  } finally {
    await f.stop();
  }
}, 180_000);

test('SAFETY03/SAFETY08: G917 mandatory Account mail, lost acknowledgement, SMTP failure and confirmed delivery', async () => {
  const f = await alertFixture('g917-account');
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['account']);
  const pool = new Pool({ connectionString: databases.urls.account });
  const account = await ratingAccount({
    ...Bun.env,
    ACCOUNT_DATABASE_URL: databases.urls.account,
  } as Record<string, string>);
  const secret = Bun.env.ACCOUNT_SECRET!;
  const mainSecret = 'g917-main-client-secret';
  const api = notificationSafetyApi(pool, secret, mainSecret, account.issuer);
  let loseAck = true;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const response = await api.handle(request);
      if (request.method === 'POST' && response.ok && loseAck) {
        loseAck = false;
        return new Response(null, { status: 503 });
      }
      return response;
    },
  });
  try {
    const receipt = await f.report(await f.author.upload(png(75, 75)), 'ncii', nciiDeclaration);
    await pool.query(
      'UPDATE "user" SET "emailVerified" = true, locale = $1 WHERE id = ANY($2::text[])',
      ['en', [account.a.id, account.b.id]],
    );
    await f.stack.accessPool.query(
      'UPDATE access.principal SET account_issuer = $1,account_subject = $2 WHERE id = $3',
      [account.issuer, account.a.id, f.staff.principalId],
    );
    await f.stack.accessPool.query(
      'UPDATE access.principal SET account_issuer = $1,account_subject = $2 WHERE id = $3',
      [account.issuer, account.b.id, f.backup.principalId],
    );
    // Optional inbox/email/push preferences and Account unsubscribe cannot stop safety.
    for (const channel of ['inbox', 'email', 'push'] as const) {
      await f.notifications.setPreference(
        { issuer: account.issuer, subject: account.a.id },
        {
          purpose: 'social',
          topic: 'reply',
          channel,
          state: 'disabled',
          expectedRevision: null,
          idempotencyKey: randomUUID(),
          via: 'settings',
        },
      );
    }
    const unsubscribe = mailSuppressionApi(pool, secret);
    expect(
      (
        await unsubscribe.handle(
          new Request(
            `http://account.test/api/account/mail/unsubscribe?token=${unsubscribeToken(secret, account.a.id, account.a.email)}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: 'List-Unsubscribe=One-Click',
            },
          ),
        )
      ).status,
    ).toBe(204);
    const now = deadlineFor(receipt.receivedAt);
    const source = new SafetyAlerts(
      f.stack.accessPool,
      f.notifications,
      { issuer: account.issuer, primary: account.a.id, backup: account.b.id },
      () => now,
    );
    const producer = new NotificationProducer(
      f.stack.accessPool,
      null,
      f.stack.contentPool,
      f.stack.fuseki,
      f.notifications,
      null,
      null,
      source,
    );
    await producer.runAccessOnce();
    const optional = (
      await f.notifications.enqueue({
        sourceOwner: 'access',
        sourceEvent: `g917-optional:${randomUUID()}`,
        purpose: 'social',
        topic: 'mention',
        subject: { owner: 'access', ref: randomUUID(), revision: null },
        disclosureBasis: 'unrelated-optional-v1',
        recipients: [f.backup.principalId],
      })
    )[0]!;
    const provider = new SafetyAlertProvider(
      f.stack.accessPool,
      account.issuer,
      server.url.toString(),
      mainSecret,
    );
    const dispatcher = new NotificationDispatcher(f.stack.accessPool, provider, source, {
      retryMs: 0,
      disclosureBasis: SAFETY_ALERT_BASIS,
    });
    dispatcher.registerSubjectReader(SAFETY_ALERT_BASIS, source);
    const first = await dispatcher.runOnce();
    expect(first.delivered).toBe(0);
    expect(first.uncertain, JSON.stringify(first)).toBe(2);
    const queued = (
      await pool.query<{ id: string; user_id: string; payload: string }>(
        'SELECT id,user_id,payload FROM rezics_account_email',
      )
    ).rows;
    expect(queued).toHaveLength(2);
    for (const row of queued) {
      const input = JSON.parse(await symmetricDecrypt({ key: secret, data: row.payload }));
      expect(input.purpose).toBe('notice');
      expect(input.message).toContain(now.toISOString());
      expect(input.message).not.toContain(receipt.credential);
      expect(input.message).not.toContain('exact retained image');
      expect(input.url).not.toContain(receipt.caseId);
    }
    // A new Main dispatcher looks up the same Account queue rows, never resends.
    const restarted = new NotificationDispatcher(
      f.stack.accessPool,
      new SafetyAlertProvider(
        f.stack.accessPool,
        account.issuer,
        server.url.toString(),
        mainSecret,
      ),
      source,
      { retryMs: 0, disclosureBasis: SAFETY_ALERT_BASIS },
    );
    expect((await restarted.runOnce()).uncertain).toBe(2);
    expect((await pool.query('SELECT id FROM rezics_account_email')).rowCount).toBe(2);
    const sent: { to: string; text: string }[] = [];
    await accountEmailQueue(
      pool,
      secret,
      async (mail) => {
        if (mail.to === account.b.email) throw new Error('SMTP acknowledgement lost');
        sent.push(mail);
      },
      account.issuer,
    ).drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(account.a.email);
    expect(sent[0]!.text).toContain(now.toISOString());
    const confirmed = await restarted.runOnce();
    expect(confirmed.reconciled).toBe(1);
    expect(confirmed.uncertain).toBe(1);
    const outcomes = (
      await f.stack.accessPool.query(
        `SELECT responder,delivery_state FROM access.safety_alert_delivery ORDER BY responder`,
      )
    ).rows;
    expect(outcomes).toEqual([
      { responder: 'backup', delivery_state: 'uncertain' },
      { responder: 'primary', delivery_state: 'delivered' },
    ]);
    expect(
      (
        await f.stack.accessPool.query(
          'SELECT state FROM access.notification_delivery WHERE item_id = $1',
          [optional.itemId],
        )
      ).rows[0].state,
    ).toBe('pending');
    expect(
      (
        await fetch(new URL('/api/internal/safety-alerts', server.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            deliveryId: randomUUID(),
            userId: account.a.id,
            deadline: now.toISOString(),
            reason: 'overdue',
          }),
        })
      ).status,
    ).toBe(403);
  } finally {
    await server.stop(true);
    await account.close();
    await pool.end();
    await databases.close();
    await f.stop();
  }
}, 180_000);
