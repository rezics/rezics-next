import { expect, test } from 'bun:test';
import { safetyFixture, json, png, sha, nciiDeclaration } from './g-744-support.ts';

test('SAFETY03/SAFETY08: G744-H1 overdue NCII alerts the backup when the primary has not responded', async () => {
  const f = await safetyFixture('g744-deadline');
  try {
    await f.notifications.registerEndpoint(f.backup.principal, {
      channel: 'email',
      deviceId: null,
      address: null,
      addressDigest: sha('account-owned-backup-address'),
      lockScreenDisclosure: false,
    });
    const image = await f.author.upload(png(60, 60));
    const receipt = await f.report(image, 'ncii', nciiDeclaration);
    await f.claim(receipt); // The primary becomes absent without completing a decision.
    const deadline = Date.parse(receipt.receivedAt) + 48 * 3600_000;
    f.setClock(new Date(deadline - 1));
    const before = await json<{ items: { caseId: string }[] }>(
      await f.read('/v1/safety-cases/due-steps'),
    );
    expect(before.items.some((item) => item.caseId === receipt.caseId)).toBe(false);
    f.setClock(new Date(deadline));
    const due = await json<{ items: { caseId: string; dueAt: string }[] }>(
      await f.read('/v1/safety-cases/due-steps', f.backup),
    );
    expect(due.items.find((item) => item.caseId === receipt.caseId)?.dueAt).toBe(
      new Date(deadline).toISOString(),
    );
    await f.produce();
    // The installed producer creates a durable external delivery independently
    // of staff polling the queue. Account/SMTP outcomes are exercised in G-917.
    const alerts = await f.stack.accessPool.query(
      `SELECT d.id FROM access.notification_delivery d
      JOIN access.notification_item i ON i.id = d.item_id WHERE i.principal_id = $1
        AND i.purpose IN ('security','governance')`,
      [f.backup.principalId],
    );
    expect(
      alerts.rowCount,
      'G744-H1: overdue primary absence must queue the backup alert',
    ).toBeGreaterThan(0);
  } finally {
    await f.stop();
  }
}, 180_000);

// Fails until G-918 queues mandatory safety mail; G-918 turns this back into test().
test.todo('SAFETY07: G744-M1 media enforcement queues mandatory safety email with optional notifications disabled', async () => {
  const f = await safetyFixture('g744-safety-mail');
  try {
    await f.notifications.registerEndpoint(f.author.principal, {
      channel: 'email',
      deviceId: null,
      address: null,
      addressDigest: sha('account-owned-uploader-address'),
      lockScreenDisclosure: false,
    });
    for (const channel of ['inbox', 'email', 'push'] as const) {
      await f.notifications.setPreference(f.author.principal, {
        purpose: 'social',
        topic: 'reply',
        channel,
        state: 'disabled',
        expectedRevision: null,
        idempotencyKey: crypto.randomUUID(),
        via: 'settings',
      });
    }
    const image = await f.author.upload(png(61, 61));
    const receipt = await f.report(image);
    const decision = await f.complete(await f.input(receipt, image));
    const notices = await json<{ items: { caseId: string }[] }>(
      await f.call('GET', '/v1/safety-notices', undefined, f.author.token),
    );
    expect(notices.items.some((item) => item.caseId === receipt.caseId)).toBe(true);
    await f.produce();
    const deliveries = await f.stack.accessPool.query(
      `SELECT d.id FROM access.notification_delivery d
      JOIN access.notification_item i ON i.id = d.item_id WHERE i.principal_id = $1
        AND i.source_event = $2 AND i.purpose = 'governance' AND d.channel = 'email'`,
      [f.author.principalId, `moderation:${decision.decisionId}`],
    );
    expect(
      deliveries.rowCount,
      'G744-M1: media authors never enter moderation email recipients; owner brief G744-FIX-SAFETY-MAIL',
    ).toBeGreaterThan(0);
  } finally {
    await f.stop();
  }
}, 180_000);
