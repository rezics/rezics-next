import { expect, test } from 'bun:test';
import { alertRecovery, mandatoryMailRecovery } from '../integration/g-925-safety-recovery.ts';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { MediaScreenWorker } from '../../../services/main/src/modules/media-screen/worker.ts';
import { MediaScreenStore } from '../../../services/main/src/modules/media-screen/store.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { fixtureReasons } from '../integration/g-565-decision-support.ts';
import {
  safetyFixture,
  json,
  png,
  sha,
  nciiDeclaration,
  type Receipt,
} from '../integration/g-744-support.ts';

test('SAFETY01: anonymous and really suspended Account bearers can report and correspond without posting authority', async () => {
  const f = await safetyFixture('g744-intake');
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['account']);
  const accountPool = new Pool({ connectionString: databases.urls.account });
  let account: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  try {
    account = await ratingAccount(
      { ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as Record<string, string>,
      'openid',
    );
    const image = await f.author.upload(png(70, 70));
    const app = createMainApp(f.stack.fuseki, { ...f.deps, account: account.verifier });
    const body = {
      profile: 'public-report-v1',
      target: `https://rezics.com/id/${image.asset}`,
      category: 'credible_threat',
      statement: 'Please investigate this threat.',
      contentLanguage: 'en',
    };
    await accountPool.query(
      `UPDATE rezics_account_security SET suspended_at = clock_timestamp(),
      suspended_until = NULL, generation = generation + 1 WHERE user_id = $1`,
      [account.a.id],
    );
    await expect(
      account.verifier.verify(
        new Request('http://main.local', {
          headers: { authorization: `Bearer ${account.tokenA}` },
        }),
        [],
      ),
    ).rejects.toBeInstanceOf(AccountAssertionDenied);
    for (const token of [undefined, account.tokenA]) {
      const receipt = await json<Receipt>(
        await app.handle(
          new Request('http://main.local/v1/public-reports', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': randomUUID(),
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
          }),
        ),
        201,
      );
      const status = await f.call(
        'GET',
        `/v1/public-reports/${receipt.caseId}`,
        undefined,
        token,
        randomUUID(),
        receipt.credential,
      );
      expect(status.status).toBe(200);
      expect(status.headers.get('cache-control')).toBe('no-store');
      await json(
        await f.call(
          'POST',
          `/v1/public-reports/${receipt.caseId}/correspondence`,
          { kind: 'message', statement: 'Private follow-up', contentLanguage: 'en' },
          token,
          randomUUID(),
          receipt.credential,
        ),
      );
      const report = (
        await f.stack.accessPool.query(
          'SELECT principal_id FROM access.governance_report WHERE id = $1',
          [receipt.reportId],
        )
      ).rows[0]!;
      expect(report.principal_id).toBeNull();
    }
  } finally {
    await account?.close();
    await accountPool.end();
    await f.stop();
  }
}, 180_000);

test('SAFETY02: NCII receipt closes original, known identical uses and later identical uploads inside 48 hours', async () => {
  const f = await safetyFixture('g744-ncii');
  try {
    const bytes = png(71, 71);
    const first = await f.author.upload(bytes),
      copy = await f.author.upload(bytes);
    const independent = await f.stack.member('independent-uploader');
    const privateCopy = await independent.upload(bytes, 'private');
    const work = await f.stack.publicWork(f.author.actor);
    const basis = await f.stack.store.publicationBasis([copy.asset], f.author.actor);
    const use = randomUUID();
    await f.stack.store.createPublicationUses(randomUUID(), f.author.actor, work.work, [
      { ...basis[0]!, use },
    ]);
    const visible = await f.call('GET', `/v1/media/uses/${use}`);
    expect(visible.status).toBe(200);
    expect(visible.headers.get('cache-control')).toBe('public, no-cache');
    const receipt = await f.report(first, 'ncii', nciiDeclaration);
    const status = await json<{ steps: { kind: string; dueAt: string | null }[] }>(
      await f.call(
        'GET',
        `/v1/public-reports/${receipt.caseId}`,
        undefined,
        undefined,
        randomUUID(),
        receipt.credential,
      ),
    );
    const dueAt = status.steps.find((step) => step.kind === 'removal_deadline')!.dueAt!;
    expect(Date.parse(dueAt) - Date.parse(receipt.receivedAt)).toBe(48 * 3600_000);
    const input = await f.input(receipt, first);
    const decision = await f.complete(input);
    expect(decision.operation.status).toBe('completed');
    const receipts = await f.stack.contentPool.query<{ created_at: Date }>(
      `SELECT created_at
      FROM media.suppressed_digest WHERE digest = $1 AND decision_id = $2`,
      [sha(bytes), decision.decisionId],
    );
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]!.created_at.getTime()).toBeLessThan(Date.parse(dueAt));
    for (const image of [first, copy, privateCopy]) {
      expect((await f.stack.store.readAsset(image.asset))!.moderation).toBe('suppressed');
      expect(await f.clearance(image)).toBe('rejected');
    }
    expect((await f.call('GET', `/v1/media/uses/${use}`)).status).toBe(404);
    expect(
      (
        await f.app.handle(
          new Request(`http://main.local/v1/media/uses/${use}`, {
            headers: { 'if-none-match': visible.headers.get('etag')! },
          }),
        )
      ).status,
    ).toBe(404);
    const later = await f.author.upload(bytes);
    expect(await f.clearance(later)).toBe('rejected');
    const replay = await json<{ operation: { status: string } }>(await f.decide(input));
    expect(replay.operation.status).toBe('completed');
  } finally {
    await f.stop();
  }
}, 180_000);

test('SAFETY04: scanner outage holds new uploads and retains a recoverable specialist case', async () => {
  const f = await safetyFixture('g744-scanner', false);
  try {
    const image = await f.author.upload(png(72, 72));
    const store = new MediaScreenStore(f.stack.contentPool);
    const worker = new MediaScreenWorker(
      store,
      {
        classify: async () => {
          throw new Error('scanner offline');
        },
      },
      f.stack.objects,
      f.governance,
    );
    // Drain other files' queued uploads in this disposable tier, then locate our result.
    for (let i = 0; i < 100; i++) {
      await worker.tick();
      if ((await f.stack.store.readUpload(image.upload))?.clearance === 'held') break;
    }
    expect((await f.stack.store.readUpload(image.upload))?.clearance).toBe('held');
    expect(await f.clearance(image)).toBe('held');
    const review = (
      await f.stack.contentPool.query<{ case_id: string; reason: string }>(
        `SELECT q.case_id,r.reason
      FROM media.screen_review q JOIN media.screen_result r ON r.job_id = q.job_id
      JOIN media.transform_job j ON j.id = q.job_id WHERE j.source_id = $1`,
        [image.representation],
      )
    ).rows[0]!;
    expect(review.reason).toBe('screen-unavailable');
    expect(review.case_id).toBeString();
    expect((await f.read(`/v1/safety-cases/${review.case_id}`)).status).toBe(200);
    const work = await f.stack.publicWork(f.author.actor);
    const basis = await f.stack.store.publicationBasis([image.asset], f.author.actor);
    const use = randomUUID();
    await f.stack.store.createPublicationUses(randomUUID(), f.author.actor, work.work, [
      { ...basis[0]!, use },
    ]);
    const delivery = await f.call('GET', `/v1/media/uses/${use}`);
    expect(delivery.status).toBe(404);
    expect(await delivery.text()).not.toContain(image.representation);
  } finally {
    await f.stop();
  }
}, 180_000);

test('SAFETY05: staff decide an affected-party appeal with reasons and replay the same owner receipt', async () => {
  const f = await safetyFixture('g744-appeal');
  try {
    const image = await f.author.upload(png(73, 73));
    const receipt = await f.report(image);
    const restriction = await f.complete(await f.input(receipt, image));
    const notices = await json<{ items: { caseId: string; credential: string }[] }>(
      await f.call('GET', '/v1/safety-notices', undefined, f.author.token),
    );
    const notice = notices.items.find((item) => item.caseId === receipt.caseId)!;
    const appeal = await json<{ stepId: string }>(
      await f.call(
        'POST',
        `/v1/public-reports/${receipt.caseId}/correspondence`,
        { kind: 'appeal', statement: 'The report misidentified the image.', contentLanguage: 'en' },
        undefined,
        randomUUID(),
        notice.credential,
      ),
    );
    expect(await f.clearance(image)).toBe('rejected');
    const input = await f.input(receipt, image, 'reverse', restriction.decisionId, appeal.stepId);
    input.reasons = {
      ...fixtureReasons,
      facts: 'The retained appeal established mistaken identification.',
    };
    const reversal = await f.complete(input);
    const status = await json<{ statementOfReasons: typeof input.reasons; outcome: string }>(
      await f.call(
        'GET',
        `/v1/public-reports/${receipt.caseId}`,
        undefined,
        undefined,
        randomUUID(),
        notice.credential,
      ),
    );
    expect(status.statementOfReasons).toMatchObject(input.reasons);
    expect(status.outcome).toBe('reverse');
    expect(await f.clearance(image)).toBe('cleared');
    const replay = await json<typeof reversal>(await f.decide(input));
    expect(replay.decisionId).toBe(reversal.decisionId);
    expect(replay.operation.items.map((item) => item.receipt)).toEqual(
      reversal.operation.items.map((item) => item.receipt),
    );
  } finally {
    await f.stop();
  }
}, 180_000);

test('SAFETY06: deleting held media retains bytes, evidence and an attributable postponement', async () => {
  const f = await safetyFixture('g744-hold');
  try {
    const bytes = png(74, 74),
      image = await f.author.upload(bytes);
    const receipt = await f.report(image, 'child_exploitation');
    const resource = `https://rezics.com/id/${image.asset}`;
    const before = await f.stack.store.readAsset(image.asset);
    const result = await f.author.send('POST', `/v1/media/assets/${image.asset}/state`, {
      profile: 'media-asset-state-v1',
      expectedState: before!.state,
      disclosure: 'public',
      lifecycle: 'erased',
      actingSubject: f.author.actor,
    });
    expect(result.status).toBe(403);
    expect((await f.stack.store.readAsset(image.asset))!.lifecycle).toBe('active');
    const record = (
      await f.stack.contentPool.query<{ object_namespace: string }>(
        `SELECT a.object_namespace FROM media.asset a JOIN media.representation p ON p.asset_id = a.id
       WHERE p.id = $1`,
        [image.representation],
      )
    ).rows[0]!;
    expect(sha(await f.stack.objects(record.object_namespace).get(sha(bytes)))).toBe(sha(bytes));
    const retained = await f.stack.accessPool.query(
      `SELECT h.reason,p.operation_id FROM access.governance_preservation_hold h
      JOIN access.governance_erasure_postponement p ON p.hold_id = h.id
      WHERE h.case_id = $1 AND h.target_resource = $2 AND h.released_at IS NULL`,
      [receipt.caseId, resource],
    );
    expect(retained.rows).toHaveLength(1);
    expect(retained.rows[0]!.reason).toBe('child_exploitation');
    expect(retained.rows[0]!.operation_id).toBeString();
  } finally {
    await f.stop();
  }
}, 180_000);

test(
  'SAFETY03: automatic NCII deadline alert reaches the primary once after intake and dispatcher restarts',
  () => alertRecovery('primary'),
  180_000,
);
test(
  'SAFETY07: mandatory safety mail arrives with optional notifications disabled after lost intake acknowledgement',
  mandatoryMailRecovery,
  180_000,
);
test(
  'SAFETY08: configured absent-primary escalation reaches the backup once after restart',
  () => alertRecovery('backup'),
  180_000,
);
