import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { mandatoryMailRecovery } from './g-925-safety-recovery.ts';
import { expect, test } from 'bun:test';
import { safetyFixture, json, png, nciiDeclaration } from './g-744-support.ts';

test('SAFETY03/SAFETY08: G744-H1 overdue NCII alerts the backup when the primary has not responded', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
  ]);
  const f = await safetyFixture('g744-deadline', true, databases.urls);
  try {
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
    // of staff polling the queue. Restart and SMTP outcomes are exercised in SAFETY03/08.
    const alerts = await f.stack.accessPool.query(
      `SELECT d.id,a.reason FROM access.safety_alert a
      JOIN access.notification_item i ON i.subject_ref = a.id::text
      JOIN access.notification_delivery d ON d.item_id = i.id
      WHERE i.principal_id = $1 AND a.case_id = $2 AND a.responder = 'backup'
        AND i.purpose IN ('security','governance')`,
      [f.backup.principalId, receipt.caseId],
    );
    expect(alerts.rowCount, 'G744-H1: overdue primary absence must queue the backup alert').toBe(1);
    expect(alerts.rows[0]!.reason).toBe('overdue');
  } finally {
    await f.stop();
    await databases.close();
  }
}, 180_000);

test(
  'SAFETY07: media enforcement delivers mandatory safety email with optional notifications disabled',
  mandatoryMailRecovery,
  180_000,
);
