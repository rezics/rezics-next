import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { Pool } from 'pg';
import { accountEmailQueue } from '../../../services/account/src/email.ts';
import { notificationSafetyApi } from '../../../services/account/src/notification-safety.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import {
  GovernanceUnavailable,
  type DecisionResult,
} from '../../../services/main/src/modules/governance/store.ts';
import {
  MediaStore,
  type CopySuppression,
} from '../../../services/main/src/modules/media/store.ts';
import { RequiredMediaMatchWorker } from '../../../services/main/src/modules/media-screen/required-match-worker.ts';
import { LocalRequiredSafetyMatcher } from '../../../services/main/src/modules/media-screen/required-matcher.ts';
import {
  SafetyAlerts,
  SAFETY_ALERT_BASIS,
  SAFETY_ALERT_COST,
} from '../../../services/main/src/modules/safety-alerts/store.ts';
import { SafetyAlertProvider } from '../../../services/main/src/modules/safety-alerts/provider.ts';
import { NotificationDispatcher } from '../../../services/main/src/modules/notification/dispatcher.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { safetyFixture, json, png, sha, nciiDeclaration, type Receipt } from './g-744-support.ts';
import { startMediaStack } from './media-support.ts';
import { alertRecovery, mandatoryMailRecovery } from './g-925-safety-recovery.ts';

test('SAFETY01: launch intake and private correspondence use real suspended Account assertions without restoring upload authority', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
    'account',
  ]);
  const f = await safetyFixture('launch-intake', true, databases.urls);
  const pool = new Pool({ connectionString: databases.urls.account });
  let account: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  try {
    account = await ratingAccount(
      { ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as Record<string, string>,
      'openid',
    );
    const image = await f.author.upload(png(101, 101));
    const app = createMainApp(f.stack.fuseki, { ...f.deps, account: account.verifier });
    await pool.query(
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
      const call = (method: string, path: string, body?: unknown, credential?: string) =>
        app.handle(
          new Request(`http://main.local${path}`, {
            method,
            headers: {
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              ...(body ? { 'content-type': 'application/json' } : {}),
              ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
              ...(credential ? { 'x-rezics-case-credential': credential } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        );
      const receipt = await json<Receipt>(
        await call('POST', '/v1/public-reports', {
          profile: 'public-report-v1',
          target: `https://rezics.com/id/${image.asset}`,
          category: 'credible_threat',
          statement: 'Synthetic launch notice.',
          contentLanguage: 'en',
        }),
        201,
      );
      const path = `/v1/public-reports/${receipt.caseId}`;
      const status = await call('GET', path, undefined, receipt.credential);
      expect(status.status).toBe(200);
      expect(status.headers.get('cache-control')).toBe('no-store');
      expect((await call('GET', path)).status).toBe(404);
      await json(
        await call(
          'POST',
          `${path}/correspondence`,
          {
            kind: 'message',
            statement: 'Private synthetic follow-up.',
            contentLanguage: 'en',
          },
          receipt.credential,
        ),
      );
      expect(
        (
          await f.stack.accessPool.query(
            'SELECT principal_id FROM access.governance_report WHERE id = $1',
            [receipt.reportId],
          )
        ).rows[0].principal_id,
      ).toBeNull();
      const denied = await call('POST', '/v1/media/uploads', {
        profile: 'media-image-upload-v1',
        asset: null,
        mediaType: 'image/png',
        byteLength: 97,
        sha256: sha(png(102, 102)),
        disclosure: 'public',
        actingSubject: f.author.actor,
      });
      expect(denied.status).toBe(401);
    }
  } finally {
    await account?.close();
    await pool.end();
    await f.stop();
    await databases.close();
  }
}, 180_000);

for (const fault of ['before-copy-closure', 'after-copy-closure'] as const) {
  test(`SAFETY02/SAFETY03: launch suppression ${fault} interruption retains due alerts until all owner effects confirm`, async () => {
    const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
      'access',
      'content',
      'relay',
    ]);
    const f = await safetyFixture(`launch-${fault}`, true, databases.urls);
    let probe: ReturnType<typeof spyOn> | undefined;
    try {
      const bytes = png(103, 103);
      const first = await f.author.upload(bytes);
      const copy = await f.author.upload(bytes);
      const secondBytes = png(104, 104);
      const second = await f.author.upload(secondBytes);
      const secondCopy = await f.author.upload(secondBytes);
      const cached = await f.call(
        'GET',
        `/v1/media/representations/${secondCopy.representation}/bytes`,
      );
      expect(cached.status).toBe(200);
      const etag = cached.headers.get('etag');
      expect(etag).not.toBeNull();
      const receipt = await f.report(first, 'ncii', nciiDeclaration);
      const key = randomUUID();
      await json(
        await f.call(
          'POST',
          '/v1/reports',
          {
            profile: 'content-report-v1',
            actingSubject: f.staff.actor,
            authority: { kind: 'platform', scopeId: 'governance:platform' },
            context: 'urn:rezics:context:global',
            target: {
              owner: 'content',
              resource: `https://rezics.com/id/${first.asset}`,
              component: 'body',
            },
            disclosure: 'private',
            reasonCode: 'ncii',
            statement: 'Both synthetic originals were reviewed.',
            evidence: [first, second].map((image) => ({
              owner: 'content',
              resource: `https://rezics.com/id/${image.asset}`,
              component: 'body',
              revision: image.revision,
              locator: null,
            })),
            idempotencyKey: key,
          },
          f.staff.token,
          key,
        ),
        201,
      );
      const step = (
        await f.stack.accessPool.query<{ id: string; due_at: Date }>(
          "SELECT id,due_at FROM access.governance_process_step WHERE case_id = $1 AND step = 'removal_deadline'",
          [receipt.caseId],
        )
      ).rows[0]!;
      const input = await f.input(receipt, first, 'restrict', null, step.id);
      input.targets.push(f.target(second));
      const accepted = await json<DecisionResult>(await f.decide(input), 202);
      expect(accepted.operation.status).toBe('accepted');
      let interrupted = false;
      const original = MediaStore.prototype.suppressIdenticalCopies;
      probe = spyOn(MediaStore.prototype, 'suppressIdenticalCopies').mockImplementation(
        async function (this: MediaStore, ...args) {
          const interrupt = args[0] !== sha(bytes) && !interrupted;
          if (interrupt && fault === 'before-copy-closure') {
            interrupted = true;
            throw new GovernanceUnavailable('synthetic owner unavailable');
          }
          const result = await original.apply(this, args);
          if (interrupt) {
            interrupted = true;
            throw new GovernanceUnavailable('synthetic owner acknowledgement lost');
          }
          return result;
        },
      );
      const partial = await json<DecisionResult>(await f.decide(input), 202);
      expect(interrupted).toBe(true);
      expect(partial.operation.status).toBe('partial');
      expect(partial.operation.items.map((item) => item.state)).toEqual(['confirmed', 'uncertain']);
      if (fault === 'before-copy-closure') {
        expect((await f.stack.store.readAsset(secondCopy.asset))!.moderation).toBe('none');
        expect(await f.clearance(secondCopy)).toBe('rejected');
      }
      // Original suppression commits before copy closure; even an uncertain
      // acknowledgement must never restore the original's public delivery.
      for (const image of [first, copy, second, secondCopy]) {
        expect(
          (await f.call('GET', `/v1/media/representations/${image.representation}/bytes`)).status,
        ).toBe(404);
      }
      expect(
        (
          await f.app.handle(
            new Request(
              `http://main.local/v1/media/representations/${secondCopy.representation}/bytes`,
              { headers: { 'if-none-match': etag! } },
            ),
          )
        ).status,
      ).toBe(404);
      const later = await f.author.upload(bytes);
      expect(await f.clearance(later)).toBe('rejected');
      const laterSecond = await f.author.upload(secondBytes);
      expect(await f.clearance(laterSecond)).toBe('rejected');
      f.setClock(step.due_at);
      const due = await json<{ items: { stepId: string }[] }>(
        await f.read('/v1/safety-cases/due-steps'),
      );
      expect(due.items.map((item) => item.stepId)).toContain(step.id);
      await f.safetyAlerts.runOnce();
      const alerts = (
        await f.stack.accessPool.query<{ id: string; principal_id: string; responder: string }>(
          'SELECT id,principal_id,responder FROM access.safety_alert WHERE step_id = $1 ORDER BY responder',
          [step.id],
        )
      ).rows;
      expect(alerts.map((alert) => alert.responder)).toEqual(['backup', 'primary']);
      for (const alert of alerts)
        expect(
          (
            await f.safetyAlerts.resolve({
              principalId: alert.principal_id,
              owner: 'access',
              ref: alert.id,
              revision: null,
              disclosureBasis: SAFETY_ALERT_BASIS,
            })
          ).status,
        ).toBe('available');
      // Resume under a current claim using the original idempotency key.
      await f.claim(receipt);
      const restarted = createMainApp(f.stack.fuseki, f.deps);
      const replay = () =>
        restarted.handle(
          new Request(`http://main.local/v1/safety-cases/${receipt.caseId}/decisions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${f.staff.token}`,
              'idempotency-key': input.idempotencyKey,
            },
            body: JSON.stringify(input),
          }),
        );
      const [resumed, concurrent] = await Promise.all([
        replay().then((response) => json<DecisionResult>(response)),
        replay().then((response) => json<DecisionResult>(response)),
      ]);
      expect(resumed.operation.status).toBe('completed');
      expect(concurrent.operation.status).toBe('completed');
      expect(concurrent.decisionId).toBe(resumed.decisionId);
      expect(resumed.operation.items[0]!.receipt).toBe(partial.operation.items[0]!.receipt);
      expect(
        (
          await f.stack.contentPool.query(
            'SELECT id FROM media.asset_state WHERE operation_id = $1',
            [`governance-moderation:${accepted.decisionId}:2`],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (await json<{ items: { stepId: string }[] }>(await f.read('/v1/safety-cases/due-steps')))
          .items,
      ).toEqual([]);
      for (const alert of alerts)
        expect(
          (
            await f.safetyAlerts.resolve({
              principalId: alert.principal_id,
              owner: 'access',
              ref: alert.id,
              revision: null,
              disclosureBasis: SAFETY_ALERT_BASIS,
            })
          ).status,
        ).toBe('undisclosed');
    } finally {
      probe?.mockRestore();
      await f.stop();
      await databases.close();
    }
  }, 180_000);
}

test('SAFETY02: recovery of an older original receipt installs its missing copy fence without duplicate state', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
  ]);
  const f = await safetyFixture('launch-original-receipt', true, databases.urls);
  try {
    const bytes = png(110, 110);
    const image = await f.author.upload(bytes),
      copy = await f.author.upload(bytes);
    const receipt = await f.report(image, 'ncii', nciiDeclaration);
    const input = await f.input(receipt, image);
    const accepted = await json<DecisionResult>(await f.decide(input), 202);
    const saved = (
      await f.stack.accessPool.query<{
        plan: { media: { state: string; source: string }; suppression: CopySuppression };
      }>('SELECT plan FROM access.safety_decision_effect WHERE decision_id = $1 AND ordinal = 1', [
        accepted.decisionId,
      ])
    ).rows[0]!.plan;
    const operationId = `governance-moderation:${accepted.decisionId}:1`;
    await expect(
      f.stack.store.moderateOriginal(
        operationId,
        saved.media.source,
        randomUUID(),
        true,
        undefined,
        saved.suppression,
      ),
    ).rejects.toThrow('media state changed');
    expect(
      (
        await f.stack.contentPool.query(
          'SELECT id FROM media.suppressed_digest WHERE digest = $1',
          [sha(bytes)],
        )
      ).rowCount,
    ).toBe(0);
    // Reproduce a pre-upgrade owner's committed original receipt before its
    // next digest-registration call. The immutable Access plan remains pending.
    await f.stack.store.moderateOriginal(operationId, saved.media.source, saved.media.state, true);
    expect(
      (
        await f.stack.contentPool.query(
          'SELECT id FROM media.suppressed_digest WHERE digest = $1',
          [sha(bytes)],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await f.call('GET', `/v1/media/representations/${copy.representation}/bytes`)).status,
    ).toBe(200);
    const resumed = await json<DecisionResult>(await f.decide(input));
    expect(resumed.operation.status).toBe('completed');
    expect(
      (await f.call('GET', `/v1/media/representations/${copy.representation}/bytes`)).status,
    ).toBe(404);
    expect(
      (
        await f.stack.contentPool.query(
          'SELECT id FROM media.asset_state WHERE operation_id = $1',
          [operationId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await f.stack.contentPool.query(
          'SELECT operation_id FROM content.receipt WHERE operation_id = $1',
          [operationId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await f.stack.contentPool.query(
          'SELECT id FROM media.suppressed_digest WHERE digest = $1',
          [sha(bytes)],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    await f.stop();
    await databases.close();
  }
}, 180_000);

test('SAFETY03: accepted and cancelled answers remain in the due queue and deliverable alert source', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
  ]);
  const f = await safetyFixture('launch-cancelled-answer', true, databases.urls);
  try {
    const image = await f.author.upload(png(109, 109));
    const receipt = await f.report(image, 'ncii', nciiDeclaration);
    const step = (
      await f.stack.accessPool.query<{ id: string; due_at: Date }>(
        "SELECT id,due_at FROM access.governance_process_step WHERE case_id = $1 AND step = 'removal_deadline'",
        [receipt.caseId],
      )
    ).rows[0]!;
    const input = await f.input(receipt, image, 'restrict', null, step.id);
    const accepted = await json<DecisionResult>(await f.decide(input), 202);
    f.setClock(step.due_at);
    await f.claim(receipt);
    for (const state of ['accepted', 'cancelled']) {
      if (state === 'cancelled') {
        const key = randomUUID();
        const cancelled = await json<DecisionResult>(
          await f.call(
            'POST',
            `/v1/safety-decisions/${accepted.decisionId}/cancellation`,
            { actingSubject: f.staff.actor, idempotencyKey: key },
            f.staff.token,
            key,
          ),
        );
        expect(cancelled.operation.status).toBe('cancelled');
      }
      expect(
        (
          await json<{ items: { stepId: string }[] }>(await f.read('/v1/safety-cases/due-steps'))
        ).items.map((item) => item.stepId),
      ).toContain(step.id);
      await f.safetyAlerts.runOnce();
      const alerts = (
        await f.stack.accessPool.query<{ id: string; principal_id: string }>(
          'SELECT id,principal_id FROM access.safety_alert WHERE step_id = $1',
          [step.id],
        )
      ).rows;
      expect(alerts).toHaveLength(2);
      for (const alert of alerts)
        expect(
          (
            await f.safetyAlerts.resolve({
              principalId: alert.principal_id,
              owner: 'access',
              ref: alert.id,
              revision: null,
              disclosureBasis: SAFETY_ALERT_BASIS,
            })
          ).status,
        ).toBe('available');
    }
    expect((await f.stack.store.readAsset(image.asset))!.moderation).toBe('none');
  } finally {
    await f.stop();
    await databases.close();
  }
}, 180_000);

test('launch configured matcher outage and recovery bind clearance to exact synthetic bytes', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
  ]);
  const directory = `.temp/safety-launch-matcher-${randomUUID()}`;
  mkdirSync(directory, { recursive: true });
  const corpus = `${directory}/corpus.json`;
  const f = await startMediaStack('launch-matcher', {
    ownerUrls: databases.urls,
    matcherMode: `local:${corpus}`,
    matchUploads: false,
    autoClearUploads: false,
  });
  try {
    const author = await f.member('matcher-author');
    const outsider = await f.member('matcher-outsider');
    const clearBytes = png(105, 105),
      blockedBytes = png(106, 106);
    const clear = await author.upload(clearBytes),
      blocked = await author.upload(blockedBytes);
    const worker = () =>
      new RequiredMediaMatchWorker(
        f.store.matching,
        new LocalRequiredSafetyMatcher(corpus),
        f.objects,
        1000,
        1000,
      );
    for (const [image, bytes] of [
      [clear, clearBytes],
      [blocked, blockedBytes],
    ] as const) {
      await worker().tick(image.representation); // Missing corpus is an actual local provider outage.
      expect((await f.store.readUpload(image.upload))?.clearanceReason).toBe(
        'required-matcher-pending',
      );
      const path = `/v1/media/representations/${image.representation}/bytes`;
      expect((await f.call('GET', path)).status).toBe(404);
      expect((await outsider.read(path)).status).toBe(404);
      const privateBytes = await author.read(path);
      expect(privateBytes.status).toBe(200);
      expect(privateBytes.headers.get('cache-control')).toBe('private, no-store');
      expect(new Uint8Array(await privateBytes.arrayBuffer())).toEqual(new Uint8Array(bytes));
    }
    await Bun.write(corpus, JSON.stringify([sha(blockedBytes)]));
    await Bun.sleep(1050); // Let both durable leases expire before fresh workers recover.
    await worker().tick(clear.representation);
    await worker().tick(blocked.representation);
    expect((await f.store.readUpload(clear.upload))?.clearance).toBe('cleared');
    expect((await f.store.readUpload(blocked.upload))?.clearance).toBe('rejected');
    const delivery = await f.call('GET', `/v1/media/representations/${clear.representation}/bytes`);
    expect(delivery.status).toBe(200);
    expect(delivery.headers.get('cache-control')).toBe('public, no-cache');
    expect(new Uint8Array(await delivery.arrayBuffer())).toEqual(new Uint8Array(clearBytes));
    expect(
      (await f.call('GET', `/v1/media/representations/${blocked.representation}/bytes`)).status,
    ).toBe(404);
    expect(
      (await outsider.read(`/v1/media/representations/${blocked.representation}/bytes`)).status,
    ).toBe(404);
    expect(
      (
        await f.contentPool.query(
          'SELECT job_id FROM media.screen_result WHERE source_id = ANY($1::uuid[])',
          [[clear.representation, blocked.representation]],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.stop();
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test(
  'SAFETY03: launch primary alert reaches local SMTP after lost intake acknowledgement',
  () => alertRecovery('primary'),
  180_000,
);
test(
  'SAFETY08: launch absent primary escalates to backup local SMTP without polling',
  () => alertRecovery('backup'),
  180_000,
);
test(
  'SAFETY07: launch mandatory uploader mail recovers while optional mail is disabled',
  mandatoryMailRecovery,
  180_000,
);

test('SAFETY03/SAFETY08: active responder absence delivers backup mail at thirty minutes and overdue despite a current primary claim', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, [
    'access',
    'content',
    'relay',
    'account',
  ]);
  const f = await safetyFixture('launch-active-absence', true, databases.urls);
  const pool = new Pool({ connectionString: databases.urls.account });
  const account = await ratingAccount({
    ...Bun.env,
    ACCOUNT_DATABASE_URL: databases.urls.account,
  } as Record<string, string>);
  const secret = Bun.env.ACCOUNT_SECRET!;
  const mainSecret = randomUUID();
  const api = notificationSafetyApi(pool, secret, mainSecret, account.issuer);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => api.handle(request),
  });
  try {
    await pool.query(
      'UPDATE "user" SET "emailVerified" = true,locale = $1 WHERE id = ANY($2::text[])',
      ['en', [account.a.id, account.b.id]],
    );
    for (const [member, user] of [
      [f.staff, account.a],
      [f.backup, account.b],
    ] as const)
      await f.stack.accessPool.query(
        'UPDATE access.principal SET account_issuer = $1,account_subject = $2 WHERE id = $3',
        [account.issuer, user.id, member.principalId],
      );
    // Roster remapping affects the verifier too; case claims still require the same principal.
    Object.assign(f.staff.principal, { issuer: account.issuer, subject: account.a.id });
    const receipt = await f.report(await f.author.upload(png(107, 107)), 'ncii', nciiDeclaration);
    const deadline = new Date(Date.parse(receipt.receivedAt) + 48 * 3600_000);
    let now = new Date(deadline.getTime() - SAFETY_ALERT_COST.leadMs);
    const source = new SafetyAlerts(
      f.stack.accessPool,
      f.notifications,
      { issuer: account.issuer, primary: account.a.id, backup: account.b.id },
      () => now,
    );
    const dispatcher = () =>
      new NotificationDispatcher(
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
    const sent: { to: string; text: string }[] = [];
    const deliver = async () => {
      await dispatcher().runOnce();
      await accountEmailQueue(
        pool,
        secret,
        async (mail) => {
          sent.push(mail);
        },
        account.issuer,
      ).drain();
      await dispatcher().runOnce();
    };
    await source.runOnce();
    await deliver();
    expect(sent.map((mail) => mail.to)).toEqual([account.a.email]);
    now = new Date(now.getTime() + SAFETY_ALERT_COST.acknowledgementMs - 1);
    await source.runOnce();
    await deliver();
    expect(sent).toHaveLength(1);
    now = new Date(now.getTime() + 1);
    await source.runOnce();
    await deliver();
    expect(sent.map((mail) => mail.to)).toEqual([account.a.email, account.b.email]);
    expect(
      (
        await f.stack.accessPool.query(
          'SELECT responder,reason,delivery_state FROM access.safety_alert_delivery ORDER BY responder',
        )
      ).rows,
    ).toEqual([
      { responder: 'backup', reason: 'unacknowledged', delivery_state: 'delivered' },
      { responder: 'primary', reason: 'approaching', delivery_state: 'delivered' },
    ]);
    // A second case reaches its deadline with a current primary claim; absence
    // acknowledgement cannot postpone the deadline or require the backup to poll.
    const overdue = await f.report(await f.author.upload(png(108, 108)), 'ncii', nciiDeclaration);
    now = new Date(Date.parse(overdue.receivedAt) + 48 * 3600_000);
    f.setClock(now);
    await f.claim(overdue);
    await source.runOnce();
    await deliver();
    expect(
      (
        await f.stack.accessPool.query(
          'SELECT responder,reason,delivery_state FROM access.safety_alert_delivery WHERE case_id = $1 ORDER BY responder',
          [overdue.caseId],
        )
      ).rows,
    ).toEqual([
      { responder: 'backup', reason: 'overdue', delivery_state: 'delivered' },
      { responder: 'primary', reason: 'overdue', delivery_state: 'delivered' },
    ]);
    for (const mail of sent) {
      expect(mail.text).not.toContain(receipt.credential);
      expect(mail.text).not.toContain(overdue.credential);
      expect(mail.text).not.toContain('exact retained image');
    }
  } finally {
    await server.stop(true);
    await account.close();
    await pool.end();
    await f.stop();
    await databases.close();
  }
}, 180_000);
