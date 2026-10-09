import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { symmetricDecrypt } from 'better-auth/crypto';
import { Pool } from 'pg';
import { safetyFixture, png, json } from './g-744-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { ratingAccount } from '../support/rating-account.ts';
import {
  SafetyDecisionMail,
  SAFETY_NOTICE_MAIL_COST,
  type SafetyNoticeMail,
} from '../../../services/main/src/modules/governance/notices-mail.ts';
import { safetyCorrespondenceApi } from '../../../services/account/src/email-safety.ts';
import { accountEmailQueue } from '../../../services/account/src/email.ts';
import {
  mailSuppressionApi,
  unsubscribeToken,
} from '../../../services/account/src/mail-suppression.ts';

test('SAFETY07 G918: mandatory private mail reaches a suspended uploader and anonymous contact, survives partial intake and keeps credentials out of events', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
    'account',
  ], 'owner');
  const f = await safetyFixture('g918-private-mail', true, databases.urls);
  const pool = new Pool({ connectionString: databases.urls.account });
  const account = await ratingAccount({
    ...Bun.env,
    ACCOUNT_DATABASE_URL: databases.urls.account,
  } as Record<string, string>);
  const secret = Bun.env.ACCOUNT_SECRET!;
  const mainSecret = 'g918-intake-secret';
  const api = safetyCorrespondenceApi(pool, secret, mainSecret, account.issuer);
  const anonymousAddress = 'retained-reporter@example.test';
  const post = (input: SafetyNoticeMail, authorized = true) =>
    api.handle(
      new Request('http://account.local/api/internal/safety-correspondence', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorized ? { authorization: `Bearer ${mainSecret}` } : {}),
        },
        body: JSON.stringify(input),
      }),
    );
  try {
    // Neither delivery requires an optional email endpoint or a working login.
    for (const channel of ['inbox', 'email', 'push'] as const)
      await f.notifications.setPreference(f.author.principal, {
        purpose: 'social',
        topic: 'reply',
        channel,
        state: 'disabled',
        expectedRevision: null,
        idempotencyKey: randomUUID(),
        via: 'settings',
      });
    const image = await f.author.upload(png(81, 81));
    const receipt = await f.report(image, 'harassment', { contactEmail: anonymousAddress });
    const input = await f.input(receipt, image);
    input.reasons!.facts = 'Reviewed <script>alert("x")</script> as plain text.';
    const decision = await f.complete(input);
    const notice = (
      await f.stack.accessPool.query<{ id: string; credential: string }>(
        'SELECT id,credential FROM access.safety_party_notice WHERE decision_id = $1 AND principal_id = $2',
        [decision.decisionId, f.author.principalId],
      )
    ).rows[0]!;
    await f.stack.accessPool.query(
      'UPDATE access.principal SET account_issuer = $1,account_subject = $2,active = false WHERE id = $3',
      [account.issuer, account.a.id, f.author.principalId],
    );
    await pool.query('UPDATE "user" SET locale = $1 WHERE id = $2', ['en', account.a.id]);
    await pool.query(
      'UPDATE rezics_account_security SET suspended_at = now(),suspended_until = NULL WHERE user_id = $1',
      [account.a.id],
    );
    const suppression = mailSuppressionApi(pool, secret);
    for (const address of [account.a.email, anonymousAddress])
      expect(
        (
          await suppression.handle(
            new Request(
              `http://account.local/api/account/mail/unsubscribe?token=${unsubscribeToken(secret, account.a.id, address)}`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: 'List-Unsubscribe=One-Click',
              },
            ),
          )
        ).status,
      ).toBe(204);
    let loseAck = true;
    const submitted: SafetyNoticeMail[] = [];
    f.producer.setSafetyCorrespondence(
      new SafetyDecisionMail(f.stack.accessPool, account.issuer, async (mail) => {
        submitted.push(mail);
        const response = await post(mail);
        expect(response.status, await response.clone().text()).toBe(200);
        if (loseAck) {
          loseAck = false;
          throw new Error('lost committed Account intake acknowledgement');
        }
      }),
    );
    await expect(f.producer.runSafetyCorrespondenceOnce()).rejects.toThrow('lost committed');
    expect((await pool.query('SELECT id FROM rezics_account_email')).rowCount).toBe(1);
    await f.produce();
    await f.produce();
    const queued = (
      await pool.query<{ id: string; user_id: string; payload: string; state: string }>(
        'SELECT id,user_id,payload,state FROM rezics_account_email ORDER BY created_at,id',
      )
    ).rows;
    expect(queued).toHaveLength(2);
    expect(queued.every((row) => row.state === 'queued')).toBe(true);
    const payloads = await Promise.all(
      queued.map(async (row) =>
        JSON.parse(await symmetricDecrypt({ key: secret, data: row.payload })),
      ),
    );
    const affected = payloads.find((payload) => payload.to === account.a.email)!;
    const reporter = payloads.find((payload) => payload.to === anonymousAddress)!;
    expect(affected.message).toContain(notice.credential);
    expect(affected.message).toContain('Decision to restrict');
    expect(affected.message).toContain(input.reasons!.facts);
    expect(reporter.message).not.toContain(notice.credential);
    expect(reporter.message).not.toContain(receipt.credential);
    expect(reporter.retainedContact).toBe(true);
    for (const payload of payloads) {
      expect(payload.purpose).toBe('notice');
      expect(payload.url).not.toContain(notice.credential);
      expect(payload.url).not.toContain(receipt.credential);
      expect(payload.message).not.toContain('Please review the exact retained image.');
    }
    expect(queued.find((row) => row.user_id === account.a.id)).toBeDefined();
    expect(JSON.stringify(queued)).not.toContain(notice.credential);
    expect(JSON.stringify(queued)).not.toContain(anonymousAddress);
    const events = await f.stack.accessPool
      .query(`SELECT row_to_json(e) AS event FROM access.notification_producer_event e
      UNION ALL SELECT row_to_json(o) FROM access.outbox o`);
    expect(JSON.stringify(events.rows)).not.toContain(notice.credential);
    expect(JSON.stringify(events.rows)).not.toContain(receipt.credential);
    const first = submitted[0]!;
    expect((await post(first, false)).status).toBe(403);
    expect(
      (await post({ ...first, recipient: { contactEmail: 'another@example.test' } })).status,
    ).toBe(409);
    const sent: { to: string; text: string; html: string; headers?: Record<string, string> }[] = [];
    await accountEmailQueue(
      pool,
      secret,
      async (mail) => {
        sent.push(mail);
        if (mail.to === anonymousAddress) throw new Error('SMTP acknowledgement lost');
      },
      account.issuer,
    ).drain();
    expect(sent).toHaveLength(2);
    expect(sent.map((mail) => mail.to).sort()).toEqual([account.a.email, anonymousAddress].sort());
    for (const mail of sent) {
      expect(mail.headers).toBeUndefined();
      expect(mail.html).not.toContain('<script>');
      expect(mail.html).toContain('&lt;script&gt;');
      expect(mail.html).not.toContain('href=');
    }
    await new SafetyDecisionMail(f.stack.accessPool, account.issuer, async (mail) => {
      expect((await post(mail)).status).toBe(200);
    }).enqueueDecision(decision.decisionId);
    expect((await pool.query('SELECT id FROM rezics_account_email')).rowCount).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT id FROM rezics_account_email WHERE state IN ('sent','uncertain') AND payload IS NULL",
        )
      ).rowCount,
    ).toBe(2);
    expect(
      (await pool.query("SELECT id FROM rezics_account_email WHERE state = 'uncertain'")).rowCount,
    ).toBe(1);
    await accountEmailQueue(
      pool,
      secret,
      async (mail) => {
        sent.push(mail);
      },
      account.issuer,
    ).drain();
    expect(sent).toHaveLength(2);
    expect(SAFETY_NOTICE_MAIL_COST.page).toBe(256);
  } finally {
    await account.close();
    await pool.end();
    await f.stop();
    await databases.close();
  }
}, 180_000);

test('SAFETY07 G918: accepted decisions queue once before effect completion; cancelled and superseded decisions are skipped; Content notice reads use the decision index', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
  ], 'owner');
  const f = await safetyFixture('g918-current', true, databases.urls);
  try {
    const image = await f.author.upload(png(82, 82));
    const receipt = await f.report(image);
    const body = await f.input(receipt, image);
    const accepted = (await (await f.decide(body)).json()) as { decisionId: string };
    const sent: SafetyNoticeMail[] = [];
    const source = new SafetyDecisionMail(
      f.stack.accessPool,
      f.author.principal.issuer,
      async (mail) => {
        sent.push(mail);
      },
    );
    f.producer.setSafetyCorrespondence(source);
    // A committed recipient page is producer progress. Its event stays at the
    // cursor for continuation, without throwing or waiting for owner effects.
    expect(await f.producer.runSafetyCorrespondenceOnce()).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.deliveryId).toBe(
      (
        await f.stack.accessPool.query(
          'SELECT id FROM access.safety_party_notice WHERE decision_id = $1',
          [accepted.decisionId],
        )
      ).rows[0]!.id,
    );
    const decision = await json<{ decisionId: string }>(await f.decide(body));
    await f.producer.runSafetyCorrespondenceOnce();
    expect(sent).toHaveLength(1);
    const next = await f.input(receipt, image, 'dismiss');
    next.targets = [];
    await f.governance.decide(f.staff.principal, next);
    sent.length = 0;
    await source.enqueueDecision(decision.decisionId);
    expect(sent).toHaveLength(0);
    const cancelledImage = await f.author.upload(png(83, 83));
    const cancelledReceipt = await f.report(cancelledImage);
    const cancelledBody = await f.input(cancelledReceipt, cancelledImage);
    const cancelled = await json<{ decisionId: string }>(await f.decide(cancelledBody), 202);
    await f.governance.cancelDecision(f.staff.principal, f.staff.actor, cancelled.decisionId);
    await source.enqueueDecision(cancelled.decisionId);
    expect(sent).toHaveLength(0);
    await f.stack.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    await expect(source.enqueueDecision(decision.decisionId)).rejects.toThrow('recovery');
    await f.stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
    const client = await f.stack.accessPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query(
        `EXPLAIN (ANALYZE,FORMAT JSON) SELECT n.principal_id
        FROM access.safety_party_notice n WHERE n.decision_id = $1 ORDER BY n.principal_id LIMIT $2`,
        [decision.decisionId, SAFETY_NOTICE_MAIL_COST.page + 1],
      );
      const serialized = JSON.stringify(plan.rows);
      expect(serialized).toContain('Index');
      expect(serialized).toContain('decision_id');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await f.stop();
    await databases.close();
  }
}, 180_000);
