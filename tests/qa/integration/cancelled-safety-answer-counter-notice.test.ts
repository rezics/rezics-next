import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  GovernanceDenied,
  GovernanceStale,
  GovernanceUnavailable,
  type DecisionResult,
} from '../../../services/main/src/modules/governance/store.ts';
import { MediaStore } from '../../../services/main/src/modules/media/store.ts';
import { RightsCounterNotices } from '../../../services/main/src/modules/rights/counter-notice-worker.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { json, png, safetyFixture, sha } from './g-744-support.ts';

type Fixture = Awaited<ReturnType<typeof safetyFixture>>;
type CounterJob = {
  received_at: Date;
  delivered_at: Date;
  not_before: Date;
  not_after: Date;
};

async function dueCounter(f: Fixture, size: number) {
  const oldConstraint = await f.stack.accessPool.query(`SELECT 1 FROM pg_constraint
    WHERE conrelid = 'access.moderation_decision'::regclass
      AND conname = 'moderation_decision_answers_step_id_key'`);
  if (oldConstraint.rowCount)
    await f.stack.accessPool.query(
      readFileSync(
        new URL(
          '../../../services/main/migrations/access/1750_cancelled_safety_answer.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
  const index = await f.stack.accessPool.query<{ definition: string }>(
    "SELECT pg_get_indexdef('access.moderation_decision_answers_step'::regclass) AS definition",
  );
  if (!index.rows[0]!.definition.includes('case_sequence DESC'))
    await f.stack.accessPool.query(
      readFileSync(
        new URL(
          '../../../services/main/migrations/access/1751_current_safety_answer.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
  const image = await f.author.upload(png(size, size));
  const receipt = await f.report(image, 'copyright', {
    contactEmail: 'claimant@example.test',
    copyright: {
      signature: 'Claimant',
      claimantName: 'Claimant',
      claimedWork: 'Original image',
      claimantAddress: 'Private address',
      claimantPhone: '+1 555 0100',
      materialLocation: 'Reported image',
      goodFaith: true,
      accurateAndAuthorizedUnderPerjury: true,
    },
  });
  const restriction = await f.input(receipt, image, 'interim_restrict');
  // The Access search owner confirms before the media owner. Recovery must
  // preserve that first release and dispatch only the still-restricted image.
  restriction.targets = [{ ...f.target(image), effect: 'search' }, f.target(image)];
  const restricted = await f.complete(restriction);
  await f.author.grant('governance:platform', 'governance.appeal');
  const counter = await f.governance.recordStep(f.author.principal, {
    caseId: receipt.caseId,
    decisionId: restricted.decisionId,
    actingSubject: f.author.actor,
    process: 'dmca_512',
    step: 'counter_notice',
    partySubject: f.author.actor,
    statement: 'The image was mistakenly identified.',
    documentDigest: null,
    occurredAt: new Date().toISOString(),
    dueAt: null,
    idempotencyKey: randomUUID(),
    contentLanguage: 'en',
    counterNotice: {
      signature: 'Uploader',
      name: 'Uploader',
      address: 'Private address',
      phone: '+1 555 0101',
      materialLocation: 'Reported original',
      courtJurisdiction: 'US district court',
      goodFaithMistakeUnderPerjury: true,
      consentToJurisdiction: true,
      acceptService: true,
    },
  });
  let now = new Date();
  const worker = new RightsCounterNotices(
    f.stack.accessPool,
    f.governance,
    async () => 'sent',
    () => now,
  );
  expect(await worker.runPage()).toEqual({ processed: 1, deferred: 0 });
  const job = async () =>
    (
      await f.stack.accessPool.query<CounterJob>(
        `
    SELECT received_at,delivered_at,not_before,not_after
    FROM access.rights_counter_notice WHERE step_id = $1`,
        [counter.stepId],
      )
    ).rows[0]!;
  const originalClock = await job();
  now = new Date(originalClock.not_after.getTime() + 1);
  f.setClock(now);
  await f.claim(receipt);
  const answer = await f.input(receipt, image, 'restore', null, counter.stepId);
  answer.targets = restriction.targets;
  answer.idempotencyKey = `rights-deadline:${counter.stepId}`;
  const accepted = await f.governance.decide(f.staff.principal, answer, true);
  expect(accepted.operation.status).toBe('accepted');
  const deadlines = (
    await f.stack.accessPool.query<{ id: string }>(
      `
    SELECT id FROM access.governance_process_step WHERE case_id = $1
      AND step IN ('restoration_not_before','restoration_not_after')`,
      [receipt.caseId],
    )
  ).rows;
  expect(deadlines).toHaveLength(2);
  const assertDue = async (due: boolean) => {
    const rows = await json<{ items: Array<{ stepId: string }> }>(
      await f.read('/v1/safety-cases/due-steps'),
    );
    for (const deadline of deadlines)
      expect(rows.items.some((item) => item.stepId === deadline.id)).toBe(due);
  };
  const cancel = async (decisionId: string) => {
    const key = randomUUID();
    const result = await json<DecisionResult>(
      await f.call(
        'POST',
        `/v1/safety-decisions/${decisionId}/cancellation`,
        { actingSubject: f.staff.actor, idempotencyKey: key },
        f.staff.token,
        key,
      ),
    );
    expect(result.operation.status).toBe('cancelled');
    return result;
  };
  return { image, receipt, counter, restricted, accepted, job, originalClock, assertDue, cancel };
}

test('cancelled counter-notice restoration replaces accepted and partial answers without resetting receipt deadlines', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
  ]);
  const f = await safetyFixture('counter-answer-recovery', true, databases.urls);
  let fault: ReturnType<typeof spyOn> | undefined;
  try {
    const c = await dueCounter(f, 141);
    await c.assertDue(true);
    await c.cancel(c.accepted.decisionId);
    await c.assertDue(true);

    const original = MediaStore.prototype.moderateOriginal;
    let interrupted = false;
    fault = spyOn(MediaStore.prototype, 'moderateOriginal').mockImplementation(async function (
      this: MediaStore,
      ...args
    ) {
      if (!args[3] && !interrupted) {
        interrupted = true;
        throw new GovernanceUnavailable('synthetic media owner interruption');
      }
      return original.apply(this, args);
    });
    const partial = await f.governance.restoreCounterNotice(c.counter.stepId);
    expect(interrupted).toBe(true);
    expect(partial.phase).toBe('restoring');
    expect(partial.decisionId).not.toBe(c.accepted.decisionId);
    const partialId = partial.decisionId!;
    const cancelled = await c.cancel(partialId);
    expect(cancelled.operation.items.map((item) => item.state)).toEqual(['confirmed', 'uncertain']);
    const firstReceipt = cancelled.operation.items[0]!.receipt;
    expect(firstReceipt).not.toBeNull();
    expect((await f.stack.store.readAsset(c.image.asset))!.moderation).toBe('suppressed');
    await c.assertDue(true);
    expect(await c.job()).toEqual(c.originalClock);
    fault.mockRestore();
    fault = undefined;

    await f.stack.accessPool.query(
      `UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = 'governance:platform'
        AND action = 'governance.rights.decide'`,
      [f.staff.actor],
    );
    await expect(f.governance.restoreCounterNotice(c.counter.stepId)).rejects.toBeInstanceOf(
      GovernanceDenied,
    );
    await f.stack.accessPool.query(
      `UPDATE access.permission_grant SET active = true
      WHERE recipient_subject = $1 AND scope_id = 'governance:platform'
        AND action = 'governance.rights.decide'`,
      [f.staff.actor],
    );
    await f.claim(c.receipt, f.backup);
    await expect(f.governance.restoreCounterNotice(c.counter.stepId)).rejects.toBeInstanceOf(
      GovernanceStale,
    );
    expect(
      (
        await f.stack.accessPool.query(
          `SELECT id FROM access.moderation_decision
      WHERE answers_step_id = $1`,
          [c.counter.stepId],
        )
      ).rows,
    ).toHaveLength(2);

    // The claim lease is an Access fixture, so expire it without advancing the
    // statutory receipt clock again; automatic continuation reacquires it.
    await f.stack.accessPool.query(
      `UPDATE access.safety_case_claim
      SET claimed_at = $2::timestamptz - interval '1 second',expires_at = $2
      WHERE case_id = $1`,
      [c.receipt.caseId, c.originalClock.not_before],
    );
    const retried = await Promise.allSettled([
      f.governance.restoreCounterNotice(c.counter.stepId),
      f.governance.restoreCounterNotice(c.counter.stepId),
    ]);
    const completed = retried
      .flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
      .find((result) => result.phase === 'done');
    expect(completed).toBeDefined();
    expect(completed!.decisionId).not.toBe(partialId);
    const answers = (
      await f.stack.accessPool.query<{ id: string; idempotency_key: string; cancelled: boolean }>(
        `
      SELECT d.id,d.idempotency_key,o.cancelled FROM access.moderation_decision d
      JOIN access.safety_decision_operation o ON o.decision_id = d.id
      WHERE d.answers_step_id = $1 ORDER BY d.case_sequence`,
        [c.counter.stepId],
      )
    ).rows;
    expect(answers).toHaveLength(3);
    expect(answers.map((answer) => answer.cancelled)).toEqual([true, true, false]);
    expect(new Set(answers.map((answer) => answer.idempotency_key)).size).toBe(3);
    expect(
      (
        await f.stack.accessPool.query(
          `SELECT state,receipt FROM access.safety_decision_effect
      WHERE decision_id = $1 AND ordinal = 1`,
          [partialId],
        )
      ).rows[0],
    ).toEqual({ state: 'confirmed', receipt: firstReceipt });
    expect(
      (
        await f.stack.accessPool.query(
          `SELECT decision_id,state FROM access.governance_enforcement
      WHERE resource = $1 AND effect = 'search'`,
          [f.target(c.image).resource],
        )
      ).rows[0],
    ).toEqual({ decision_id: partialId, state: 'released' });
    expect((await f.stack.store.readAsset(c.image.asset))!.moderation).toBe('none');
    expect(await c.job()).toEqual(c.originalClock);
    await c.assertDue(false);
    expect(await f.governance.restoreCounterNotice(c.counter.stepId)).toEqual({
      phase: 'done',
      decisionId: completed!.decisionId,
    });
    expect(
      (await f.governance.resumeDecision(f.staff.principal, f.staff.actor, partialId)).operation
        .status,
    ).toBe('cancelled');
  } finally {
    fault?.mockRestore();
    await f.stop();
    await databases.close();
  }
}, 180_000);

test('a claimant action stays replacement of a cancelled counter-notice restoration', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
  ]);
  const f = await safetyFixture('counter-answer-stay', true, databases.urls);
  try {
    const c = await dueCounter(f, 142);
    await c.cancel(c.accepted.decisionId);
    await f.governance.recordStep(f.staff.principal, {
      caseId: c.receipt.caseId,
      decisionId: c.restricted.decisionId,
      actingSubject: f.staff.actor,
      process: 'dmca_512',
      step: 'claimant_action',
      partySubject: null,
      statement: 'Claimant filed an action seeking a court order.',
      documentDigest: sha('claimant action'),
      occurredAt: new Date().toISOString(),
      dueAt: null,
      idempotencyKey: randomUUID(),
    });
    expect(await f.governance.restoreCounterNotice(c.counter.stepId)).toEqual({
      phase: 'stayed',
      decisionId: null,
    });
    expect(
      (
        await f.stack.accessPool.query(
          `SELECT id FROM access.moderation_decision
      WHERE answers_step_id = $1`,
          [c.counter.stepId],
        )
      ).rows,
    ).toHaveLength(1);
    expect((await f.stack.store.readAsset(c.image.asset))!.moderation).toBe('suppressed');
    expect(await c.job()).toEqual(c.originalClock);
  } finally {
    await f.stop();
    await databases.close();
  }
}, 180_000);
