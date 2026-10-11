import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { safetyFixture, png, json, type Receipt, type Image } from './g-744-support.ts';
import { PublicReports } from '../../../services/main/src/modules/public-report/store.ts';
import { publicReportOwners } from '../../../services/main/src/modules/public-report/owners.ts';
import {
  RightsCounterNotices,
  type CounterNoticeMail,
  type CounterNoticeDelivery,
} from '../../../services/main/src/modules/rights/counter-notice-worker.ts';
import {
  type DecisionInput,
  type DecisionResult,
} from '../../../services/main/src/modules/governance/store.ts';
import { safetyCorrespondenceApi } from '../../../services/account/src/email-safety.ts';
import { accountEmailQueue } from '../../../services/account/src/email.ts';
import { fixtureReasons } from './g-565-decision-support.ts';

const declaration = {
  signature: 'Subscriber signature',
  materialLocation: 'https://rezics.com/media/removed',
  goodFaithMistakeUnderPerjury: true,
  name: 'Subscriber private name',
  address: 'Subscriber private address',
  phone: '+1 555 987 1234',
  courtJurisdiction: 'Federal District Court',
  consentToJurisdiction: true,
  acceptService: true,
} as const;

type PublicStatus = {
  notice: { contactEmail: string | null; declarations: Record<string, unknown> };
  outcome: string | null;
  operation: { status: string } | null;
  items: {
    id: string;
    kind: string;
    dueAt: string | null;
    declarations: Record<string, unknown> | null;
  }[];
};

async function affectedCredential(
  f: Awaited<ReturnType<typeof safetyFixture>>,
  receipt: Receipt,
  decisionId: string,
): Promise<string> {
  let cursor: string | null = null;
  do {
    const page = await json<{
      items: { caseId: string; decisionId: string; credential: string }[];
      nextCursor: string | null;
    }>(
      await f.call(
        'GET',
        `/v1/safety-notices${cursor ? `?cursor=${cursor}` : ''}`,
        undefined,
        f.author.token,
      ),
    );
    const notice = page.items.find(
      (item) => item.caseId === receipt.caseId && item.decisionId === decisionId,
    );
    if (notice) {
      expect(notice.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return notice.credential;
    }
    cursor = page.nextCursor;
  } while (cursor);
  throw new Error('The affected uploader did not receive the decision notice through the API');
}

async function startRightsFixture(label: string) {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test with the integration tier');
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, [
    'access',
    'content',
    'relay',
    'account',
  ], 'owner');
  const f = await safetyFixture(label, true, databases.urls);
  const accountPool = new Pool({ connectionString: databases.urls.account });
  let now = new Date('2026-10-02T14:37:12Z');
  const setClock = (date: Date | string) => {
    now = typeof date === 'string' ? new Date(date) : date;
    f.setClock(now);
  };
  setClock(now);
  f.deps.publicReports = new PublicReports(
    f.stack.accessPool,
    publicReportOwners(f.deps, f.stack.contentPool, f.stack.content),
    () => now,
  );

  const secret = Bun.env.ACCOUNT_SECRET!;
  const mainSecret = 'rights-notice-private-intake';
  const account = safetyCorrespondenceApi(
    accountPool,
    secret,
    mainSecret,
    'https://accounts.example.test',
  );
  const submitted: CounterNoticeMail[] = [];
  const sent: { to: string; text: string }[] = [];
  const notices = new RightsCounterNotices(
    f.stack.accessPool,
    f.governance,
    async (mail) => {
      submitted.push(mail);
      const response = await account.handle(
        new Request('http://account.local/api/internal/safety-correspondence', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${mainSecret}`,
          },
          body: JSON.stringify(mail),
        }),
      );
      return (await json<{ state: CounterNoticeDelivery }>(response)).state;
    },
    () => now,
  );
  const drain = () =>
    accountEmailQueue(
      accountPool,
      secret,
      async (mail) => {
        sent.push(mail);
      },
      'https://accounts.example.test',
    ).drain();

  return {
    databases,
    f,
    accountPool,
    notices,
    drain,
    submitted,
    sent,
    setClock,
    advance: (ms: number) => setClock(new Date(now.getTime() + ms)),
    close: async () => {
      await accountPool.end();
      await f.stop();
      await databases.close();
    },
  };
}

async function createRightsCase(
  f: Awaited<ReturnType<typeof safetyFixture>>,
  seed: number,
  withParallelRestriction = false,
) {
  const image = await f.author.upload(png(seed, seed));
  const receipt = await f.report(image, 'copyright', {
    contactEmail: `claimant-${seed}@example.test`,
    copyright: {
      signature: 'Claimant private signature',
      claimantName: 'Claimant private name',
      claimantAddress: 'Claimant private address',
      claimantPhone: '+1 555 111 2222',
      claimedWork: 'Original artwork',
      materialLocation: `https://rezics.com/id/${image.asset}`,
      goodFaith: true,
      accurateAndAuthorizedUnderPerjury: true,
    },
  });
  const parallel = withParallelRestriction ? await f.report(image, 'harassment') : null;
  const restriction = await f.complete(await f.input(receipt, image, 'interim_restrict'));
  if (parallel) await f.complete(await f.input(parallel, image));
  const affected = await affectedCredential(f, receipt, restriction.decisionId);
  const counter = await json<{ stepId: string }>(
    await f.call(
      'POST',
      `/v1/public-reports/${receipt.caseId}/correspondence`,
      {
        kind: 'counter_notice',
        statement: 'The material was removed by mistake.',
        contentLanguage: 'en',
        counterNotice: declaration,
      },
      undefined,
      randomUUID(),
      affected,
    ),
  );
  return { image, receipt, restriction, affected, counter, parallel };
}

async function receiptStatus(
  f: Awaited<ReturnType<typeof safetyFixture>>,
  receipt: Receipt,
  credential: string,
): Promise<PublicStatus> {
  return json<PublicStatus>(
    await f.call(
      'GET',
      `/v1/public-reports/${receipt.caseId}`,
      undefined,
      undefined,
      undefined,
      credential,
    ),
  );
}

async function dueReceipt(
  f: Awaited<ReturnType<typeof safetyFixture>>,
  stepId: string,
) {
  return (
    await f.stack.accessPool.query<{
      received_at: Date;
      delivered_at: Date | null;
      not_before: Date;
      not_after: Date;
    }>(
      `SELECT received_at,delivered_at,not_before,not_after
      FROM access.rights_counter_notice WHERE step_id = $1`,
      [stepId],
    )
  ).rows[0]!;
}

async function restoreInput(
  f: Awaited<ReturnType<typeof safetyFixture>>,
  receipt: Receipt,
  image: Image,
  stepId: string,
): Promise<DecisionInput> {
  const view = await json<{
    generation: string;
    reports: { evidenceDigest: string }[];
  }>(await f.read(`/v1/safety-cases/${receipt.caseId}`, f.backup));
  const basis = (
    await f.stack.accessPool.query<{
      rule_ref: string;
      rule_revision: string;
      rule_digest: string;
      disclosure: DecisionInput['disclosure'];
    }>(
      `SELECT rule_ref,rule_revision,rule_digest,disclosure
      FROM access.moderation_decision WHERE id = $1`,
      [
        (
          await f.stack.accessPool.query<{ restriction_id: string }>(
            'SELECT restriction_id FROM access.rights_counter_notice WHERE step_id = $1',
            [stepId],
          )
        ).rows[0]!.restriction_id,
      ],
    )
  ).rows[0]!;
  return {
    caseId: receipt.caseId,
    expectedGeneration: view.generation,
    actingSubject: f.backup.actor,
    outcome: 'restore',
    targets: [f.target(image)],
    rule: { ref: basis.rule_ref, revision: basis.rule_revision, digest: basis.rule_digest },
    evidenceDigest: view.reports[0]!.evidenceDigest,
    reversesDecisionId: null,
    answersStepId: stepId,
    rationale: 'A current responder reviewed the signed counter-notice and due receipt.',
    disclosure: basis.disclosure,
    reasons: {
      ...fixtureReasons,
      facts: 'The claimant received the signed counter-notice and the restoration date arrived.',
      duration: 'The copyright restriction is released.',
      automation: false,
    },
    idempotencyKey: randomUUID(),
  };
}

async function decideAsBackup(
  f: Awaited<ReturnType<typeof safetyFixture>>,
  body: DecisionInput,
): Promise<Response> {
  return f.call(
    'POST',
    `/v1/safety-cases/${body.caseId}/decisions`,
    body,
    f.backup.token,
    body.idempotencyKey,
  );
}

test('A current responder completes a due counter-notice restoration after the original responder loses authority', async () => {
  const h = await startRightsFixture('rights-restoration-authority');
  const { f } = h;
  try {
    const item = await createRightsCase(f, 181);
    expect(await h.notices.runPage()).toEqual({ processed: 1, deferred: 0 });
    await h.drain();
    h.advance(2 * 60_000);
    expect(await h.notices.runPage()).toEqual({ processed: 1, deferred: 0 });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.to).toBe('claimant-181@example.test');
    expect(h.sent[0]!.text).toContain(declaration.address);
    expect(h.sent[0]!.text).not.toContain('Claimant private address');
    expect(h.submitted).toHaveLength(2);
    expect(h.submitted[0]!.deliveryId).toBe(h.submitted[1]!.deliveryId);

    const receiptWindow = await dueReceipt(f, item.counter.stepId);
    expect(receiptWindow.delivered_at).not.toBeNull();
    expect(receiptWindow.not_before.toISOString()).toBe('2026-10-16T14:37:12.000Z');
    expect(receiptWindow.not_after.toISOString()).toBe('2026-10-22T14:37:12.000Z');
    await expect(
      f.stack.accessPool.query(
        `UPDATE access.rights_counter_notice SET not_before = not_before + interval '1 day'
        WHERE step_id = $1`,
        [item.counter.stepId],
      ),
    ).rejects.toThrow();

    const reporter = await receiptStatus(f, item.receipt, item.receipt.credential);
    const affected = await receiptStatus(f, item.receipt, item.affected);
    expect(reporter.notice.declarations.claimantAddress).toBe('Claimant private address');
    expect(
      reporter.items.find((step) => step.kind === 'counter_notice')!.declarations!.address,
    ).toBeUndefined();
    expect(affected.notice.contactEmail).toBeNull();
    expect(affected.notice.declarations.claimantAddress).toBeUndefined();
    expect(JSON.stringify(affected)).not.toContain('claimant-181@example.test');
    expect(
      affected.items.find((step) => step.kind === 'counter_notice')!.declarations!.address,
    ).toBe(declaration.address);

    await f.stack.accessPool.query(
      `UPDATE access.safety_case_claim SET expires_at = $2
      WHERE case_id = $1`,
      [item.receipt.caseId, new Date(receiptWindow.not_before.getTime() + 30 * 60_000)],
    );
    const revoked = await f.stack.accessPool.query(
      `UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = 'governance:platform'
        AND action = 'governance.rights.decide' AND active`,
      [f.staff.actor],
    );
    expect(revoked.rowCount).toBeGreaterThan(0);

    h.setClock(new Date(receiptWindow.not_before.getTime() - 1000));
    expect(await h.notices.runPage()).toEqual({ processed: 0, deferred: 0 });
    h.setClock(receiptWindow.not_before);
    expect(await h.notices.runPage()).toEqual({ processed: 1, deferred: 1 });
    expect((await f.stack.store.readAsset(item.image.asset))!.moderation).toBe('suppressed');
    expect(
      (
        await f.stack.accessPool.query(
          `SELECT id FROM access.moderation_decision
          WHERE case_id = $1 AND outcome = 'restore'`,
          [item.receipt.caseId],
        )
      ).rowCount,
    ).toBe(0);
    expect((await dueReceipt(f, item.counter.stepId)).not_before).toEqual(
      receiptWindow.not_before,
    );

    await f.claim(item.receipt, f.backup);
    const body = await restoreInput(f, item.receipt, item.image, item.counter.stepId);
    const accepted = await json<DecisionResult>(await decideAsBackup(f, body), 202);
    expect(accepted.outcome).toBe('restore');
    const completed = await json<DecisionResult>(await decideAsBackup(f, body), 200);
    expect(completed.operation.status).toBe('completed');
    expect((await f.stack.store.readAsset(item.image.asset))!.moderation).toBe('none');
    expect(await receiptStatus(f, item.receipt, item.receipt.credential)).toMatchObject({
      outcome: 'restore',
      operation: { status: 'completed' },
    });

    const attributed = await f.stack.accessPool.query<{
      id: string;
      acting_subject: string;
      account_subject: string;
      answers_step_id: string | null;
      automation: string | null;
    }>(
      `SELECT d.id,d.acting_subject,p.account_subject,d.answers_step_id,
        d.statement_of_reasons->>'automation' AS automation
      FROM access.moderation_decision d JOIN access.principal p ON p.id = d.principal_id
      WHERE d.case_id = $1 AND d.outcome = 'restore'`,
      [item.receipt.caseId],
    );
    expect(attributed.rows).toEqual([
      {
        id: completed.decisionId,
        acting_subject: f.backup.actor,
        account_subject: f.backup.principal.subject,
        answers_step_id: item.counter.stepId,
        automation: 'false',
      },
    ]);
    expect(await dueReceipt(f, item.counter.stepId)).toEqual(receiptWindow);
  } finally {
    await h.close();
  }
}, 180_000);

test('Court filings and parallel restrictions still keep due counter-notice cases restricted', async () => {
  const h = await startRightsFixture('rights-restoration-fences');
  const { f } = h;
  try {
    const filed = await createRightsCase(f, 182);
    const parallel = await createRightsCase(f, 183, true);
    expect(await h.notices.runPage()).toEqual({ processed: 2, deferred: 0 });
    await h.drain();
    h.advance(2 * 60_000);
    expect(await h.notices.runPage()).toEqual({ processed: 2, deferred: 0 });
    expect(h.sent).toHaveLength(2);

    const filing = {
      kind: 'claimant_action',
      statement: 'An action seeking a court order has been filed.',
      contentLanguage: 'en',
      courtFiling: {
        court: 'District Court',
        caseNumber: 'fixture-182',
        documentDigest: 'a'.repeat(64),
      },
    };
    await json(
      await f.call(
        'POST',
        `/v1/public-reports/${filed.receipt.caseId}/correspondence`,
        filing,
        undefined,
        randomUUID(),
        filed.receipt.credential,
      ),
    );
    const filedWindow = await dueReceipt(f, filed.counter.stepId);
    const parallelWindow = await dueReceipt(f, parallel.counter.stepId);
    for (const item of [filed, parallel]) {
      const window = item === filed ? filedWindow : parallelWindow;
      await f.stack.accessPool.query(
        `UPDATE access.safety_case_claim SET expires_at = $2 WHERE case_id = $1`,
        [item.receipt.caseId, new Date(window.not_before.getTime() + 30 * 60_000)],
      );
    }
    const revoked = await f.stack.accessPool.query(
      `UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = 'governance:platform'
        AND action = 'governance.rights.decide' AND active`,
      [f.staff.actor],
    );
    expect(revoked.rowCount).toBeGreaterThan(0);

    h.setClock(filedWindow.not_before);
    expect(await h.notices.runPage()).toEqual({ processed: 2, deferred: 1 });
    expect(
      (
        await f.stack.accessPool.query<{ phase: string }>(
          `SELECT phase FROM access.rights_counter_notice WHERE step_id = $1`,
          [filed.counter.stepId],
        )
      ).rows[0]!.phase,
    ).toBe('stayed');
    expect((await f.stack.store.readAsset(filed.image.asset))!.moderation).toBe('suppressed');
    expect((await f.stack.store.readAsset(parallel.image.asset))!.moderation).toBe('suppressed');

    await f.claim(parallel.receipt, f.backup);
    const blockedRestore = await restoreInput(
      f,
      parallel.receipt,
      parallel.image,
      parallel.counter.stepId,
    );
    const response = await decideAsBackup(f, blockedRestore);
    expect(response.status).toBe(409);
    expect((await f.stack.store.readAsset(parallel.image.asset))!.moderation).toBe('suppressed');
    expect(
      (
        await f.stack.accessPool.query(
          `SELECT id FROM access.moderation_decision
          WHERE case_id = $1 AND outcome = 'restore'`,
          [parallel.receipt.caseId],
        )
      ).rowCount,
    ).toBe(0);
    expect((await dueReceipt(f, filed.counter.stepId)).not_before).toEqual(
      filedWindow.not_before,
    );
    expect((await dueReceipt(f, parallel.counter.stepId)).not_before).toEqual(
      parallelWindow.not_before,
    );
  } finally {
    await h.close();
  }
}, 180_000);
