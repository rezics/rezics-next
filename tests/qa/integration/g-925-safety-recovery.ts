import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { accountEmailQueue, smtpSender } from '../../../services/account/src/email.ts';
import { notificationSafetyApi } from '../../../services/account/src/notification-safety.ts';
import { safetyCorrespondenceApi } from '../../../services/account/src/email-safety.ts';
import {
  mailSuppressionApi,
  unsubscribeToken,
} from '../../../services/account/src/mail-suppression.ts';
import {
  SafetyAlerts,
  SAFETY_ALERT_BASIS,
  SAFETY_ALERT_COST,
} from '../../../services/main/src/modules/safety-alerts/store.ts';
import { SafetyAlertProvider } from '../../../services/main/src/modules/safety-alerts/provider.ts';
import { NotificationDispatcher } from '../../../services/main/src/modules/notification/dispatcher.ts';
import { SafetyDecisionMail } from '../../../services/main/src/modules/governance/notices-mail.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { safetyFixture, png, nciiDeclaration, json } from './g-744-support.ts';

/** Real owner storage and Account intake, with SMTP acceptance and mailbox reads.
 * Each recovery journey gets independent owner databases, not shared pending jobs. */
async function fixture(label: string) {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
    'account',
  ], 'owner');
  const f = await safetyFixture(label, true, databases.urls);
  const pool = new Pool({ connectionString: databases.urls.account });
  const account = await ratingAccount({
    ...Bun.env,
    ACCOUNT_DATABASE_URL: databases.urls.account,
  } as Record<string, string>);
  const secret = Bun.env.ACCOUNT_SECRET!;
  const mainSecret = randomUUID();
  const alertsApi = notificationSafetyApi(pool, secret, mainSecret, account.issuer);
  const mailApi = safetyCorrespondenceApi(pool, secret, mainSecret, account.issuer);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname.includes('safety-correspondence')
        ? mailApi.handle(request)
        : alertsApi.handle(request),
  });
  const compose = readEnv(
    join(
      resolve(import.meta.dir, '../../..'),
      '.temp/stack',
      `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`,
      'compose.env',
    ),
  );
  const queue = accountEmailQueue(
    pool,
    secret,
    smtpSender({
      host: '127.0.0.1',
      port: Number(compose.MAILPIT_SMTP_PORT),
      secure: false,
      requireTLS: false,
      user: '',
      password: '',
      from: 'REZICS QA <qa@example.test>',
    }),
    account.issuer,
  );
  const mailbox = async (address: string) => {
    const response = await fetch(
      `http://127.0.0.1:${compose.MAILPIT_HTTP_PORT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { messages: { ID: string }[] };
  };
  const message = async (id: string) => {
    const response = await fetch(
      `http://127.0.0.1:${compose.MAILPIT_HTTP_PORT}/api/v1/message/${id}`,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { Text: string; HTML: string };
  };
  const suppress = async (member: typeof f.author, user: typeof account.a) => {
    for (const channel of ['inbox', 'email', 'push'] as const)
      await f.notifications.setPreference(member.principal, {
        purpose: 'social',
        topic: 'reply',
        channel,
        state: 'disabled',
        expectedRevision: null,
        idempotencyKey: randomUUID(),
        via: 'settings',
      });
    const api = mailSuppressionApi(pool, secret);
    const response = await api.handle(
      new Request(
        `http://account.local/api/account/mail/unsubscribe?token=${unsubscribeToken(secret, user.id, user.email)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
        },
      ),
    );
    expect(response.status).toBe(204);
  };
  const remap = (member: typeof f.author, user: typeof account.a) =>
    f.stack.accessPool.query(
      'UPDATE access.principal SET account_issuer = $1,account_subject = $2 WHERE id = $3',
      [account.issuer, user.id, member.principalId],
    );
  return {
    f,
    pool,
    account,
    secret,
    mainSecret,
    server,
    queue,
    mailbox,
    message,
    suppress,
    remap,
    close: async () => {
      await server.stop(true);
      await account.close();
      await pool.end();
      await f.stop();
      await databases.close();
    },
  };
}

export async function alertRecovery(responder: 'primary' | 'backup') {
  const h = await fixture(`g925-${responder}`);
  const { f, pool, account } = h;
  try {
    const receipt = await f.report(
      await f.author.upload(png(responder === 'primary' ? 90 : 91, 90)),
      'ncii',
      nciiDeclaration,
    );
    const deadline = new Date(Date.parse(receipt.receivedAt) + 48 * 3600_000);
    const now = new Date(deadline.getTime() - SAFETY_ALERT_COST.leadMs);
    await h.remap(f.staff, account.a);
    await h.remap(f.backup, account.b);
    await pool.query(
      'UPDATE "user" SET "emailVerified" = true,locale = $1 WHERE id = ANY($2::text[])',
      ['en', [account.a.id, account.b.id]],
    );
    const target = responder === 'primary' ? account.a : account.b;
    await h.suppress(responder === 'primary' ? f.staff : f.backup, target);
    if (responder === 'backup')
      await f.stack.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [
        f.staff.principalId,
      ]);
    const roster = { issuer: account.issuer, primary: account.a.id, backup: account.b.id };
    let loseAck = true;
    const crashed = new SafetyAlerts(
      f.stack.accessPool,
      {
        registerEndpoint: f.notifications.registerEndpoint.bind(f.notifications),
        enqueue: async (event) => {
          const result = await f.notifications.enqueue(event);
          if (loseAck) {
            loseAck = false;
            throw new Error('lost committed alert intake acknowledgement');
          }
          return result;
        },
      },
      roster,
      () => now,
    );
    await expect(crashed.runOnce()).rejects.toThrow('lost committed alert');
    const source = new SafetyAlerts(f.stack.accessPool, f.notifications, roster, () => now);
    await source.runOnce();
    await source.runOnce();
    const alerts = (
      await f.stack.accessPool.query(
        'SELECT id,responder,reason,state FROM access.safety_alert WHERE case_id = $1',
        [receipt.caseId],
      )
    ).rows;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      responder,
      reason: responder === 'primary' ? 'approaching' : 'unacknowledged',
      state: 'queued',
    });
    const dispatcher = () =>
      new NotificationDispatcher(
        f.stack.accessPool,
        new SafetyAlertProvider(
          f.stack.accessPool,
          account.issuer,
          h.server.url.toString(),
          h.mainSecret,
        ),
        source,
        { retryMs: 0, disclosureBasis: SAFETY_ALERT_BASIS },
      );
    expect((await dispatcher().runOnce()).uncertain).toBe(1);
    expect((await pool.query('SELECT id FROM rezics_account_email')).rowCount).toBe(1);
    // Restart before SMTP acknowledgement reconciles the committed intake without resending.
    expect((await dispatcher().runOnce()).uncertain).toBe(1);
    expect((await pool.query('SELECT id FROM rezics_account_email')).rowCount).toBe(1);
    expect((await h.mailbox(target.email)).messages).toHaveLength(0);
    await h.queue.drain();
    expect((await dispatcher().runOnce()).reconciled).toBe(1);
    const received = (await h.mailbox(target.email)).messages;
    expect(received).toHaveLength(1);
    const mail = await h.message(received[0]!.ID);
    expect(mail.Text).toContain(deadline.toISOString());
    expect(mail.Text).not.toContain(receipt.credential);
    expect(mail.Text).not.toContain('exact retained image');
    const outcomes = (
      await f.stack.accessPool.query(
        'SELECT responder,delivery_state FROM access.safety_alert_delivery',
      )
    ).rows;
    expect(outcomes).toEqual([{ responder, delivery_state: 'delivered' }]);
    await source.runOnce();
    await dispatcher().runOnce();
    await h.queue.drain();
    expect((await h.mailbox(target.email)).messages).toHaveLength(1);
    expect(
      (await h.mailbox(responder === 'primary' ? account.b.email : account.a.email)).messages,
    ).toHaveLength(0);
  } finally {
    await h.close();
  }
}

export async function mandatoryMailRecovery() {
  const h = await fixture('g925-mandatory-mail');
  const { f, pool, account } = h;
  try {
    await h.suppress(f.author, account.a);
    const image = await f.author.upload(png(92, 92));
    const receipt = await f.report(image);
    const decision = await f.complete(await f.input(receipt, image));
    const notices = await json<{ items: { caseId: string; credential: string }[] }>(
      await f.call('GET', '/v1/safety-notices', undefined, f.author.token),
    );
    const notice = notices.items.find((item) => item.caseId === receipt.caseId)!;
    expect(notice).toBeDefined();
    await h.remap(f.author, account.a);
    await pool.query('UPDATE "user" SET locale = $1 WHERE id = $2', ['en', account.a.id]);
    let loseAck = true;
    const sender = () =>
      new SafetyDecisionMail(f.stack.accessPool, account.issuer, async (mail) => {
        const response = await fetch(new URL('/api/internal/safety-correspondence', h.server.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${h.mainSecret}` },
          body: JSON.stringify(mail),
        });
        expect(response.status, await response.text()).toBe(200);
        if (loseAck) {
          loseAck = false;
          throw new Error('lost committed mandatory mail acknowledgement');
        }
      });
    f.producer.setSafetyCorrespondence(sender());
    await expect(f.producer.runSafetyCorrespondenceOnce()).rejects.toThrow(
      'lost committed mandatory',
    );
    f.producer.setSafetyCorrespondence(sender());
    await f.produce();
    await f.produce();
    expect((await pool.query('SELECT id,state FROM rezics_account_email')).rows).toHaveLength(1);
    expect((await h.mailbox(account.a.email)).messages).toHaveLength(0);
    await h.queue.drain();
    const received = (await h.mailbox(account.a.email)).messages;
    expect(received).toHaveLength(1);
    const mail = await h.message(received[0]!.ID);
    expect(mail.Text).toContain('Decision to restrict');
    expect(mail.Text).toContain(notice.credential);
    expect(mail.Text).not.toContain(receipt.credential);
    expect((await pool.query('SELECT state,payload FROM rezics_account_email')).rows).toEqual([
      { state: 'sent', payload: null },
    ]);
    await sender().enqueueDecision(decision.decisionId);
    await f.produce();
    await h.queue.drain();
    expect((await h.mailbox(account.a.email)).messages).toHaveLength(1);
    expect((await pool.query('SELECT id FROM rezics_account_email')).rowCount).toBe(1);
  } finally {
    await h.close();
  }
}
