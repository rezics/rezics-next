import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { safetyFixture, png, json, type Receipt } from './g-744-support.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { PublicReports } from '../../../services/main/src/modules/public-report/store.ts';
import { publicReportOwners } from '../../../services/main/src/modules/public-report/owners.ts';
import {
  RightsCounterNotices,
  type CounterNoticeMail,
  type CounterNoticeDelivery,
} from '../../../services/main/src/modules/rights/counter-notice-worker.ts';
import { safetyCorrespondenceApi } from '../../../services/account/src/email-safety.ts';
import { accountEmailQueue } from '../../../services/account/src/email.ts';
import { addBusinessDays } from '../../../services/main/src/modules/public-report/contract.ts';
import {
  GovernanceStore,
  GOVERNANCE_OPERATION_COST,
} from '../../../services/main/src/modules/governance/store.ts';
import {
  ownerEvidenceCapture,
  ownerTargetHeads,
} from '../../../services/main/src/modules/governance/evidence.ts';
import { ownerModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';
import { ContentModeration } from '../../../services/content/src/moderation.ts';

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
type Status = {
  notice: { statement: string; contactEmail: string | null; declarations: Record<string, unknown> };
  outcome: string | null;
  operation: { status: string } | null;
  steps: {
    id: string;
    kind: string;
    dueAt: string | null;
    statement: string | null;
    declarations: Record<string, unknown> | null;
  }[];
  nextCursor: string | null;
};

test('Copyright counter-notices reach the claimant once; delivered deadlines restore real content, filings and parallel restrictions keep it down', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test with the integration tier');
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, [
    'access',
    'content',
    'relay',
    'account',
  ]);
  const f = await safetyFixture('rights-counter-notice', true, databases.urls);
  const accountPool = new Pool({ connectionString: databases.urls.account });
  let now = new Date('2026-10-02T14:37:12Z');
  const setClock = (date: string) => {
    now = new Date(date);
    f.setClock(now);
  };
  f.setClock(now);
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
  const submitted: CounterNoticeMail[] = [],
    sent: { to: string; text: string }[] = [];
  let loseAck = true;
  const notices = new RightsCounterNotices(
    f.stack.accessPool,
    f.governance,
    async (mail) => {
      submitted.push(mail);
      const response = await account.handle(
        new Request('http://account.local/api/internal/safety-correspondence', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${mainSecret}` },
          body: JSON.stringify(mail),
        }),
      );
      const result = await json<{ state: CounterNoticeDelivery }>(response);
      if (loseAck) {
        loseAck = false;
        throw new Error('Lost Account intake acknowledgement');
      }
      return result.state;
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
  const status = async (receipt: Receipt, credential = receipt.credential, cursor?: string) =>
    json<Status>(
      await f.call(
        'GET',
        `/v1/public-reports/${receipt.caseId}${cursor ? `?cursor=${cursor}` : ''}`,
        undefined,
        undefined,
        undefined,
        credential,
      ),
    );
  const correspond = (receipt: Receipt, credential: string, body: object, key = randomUUID()) =>
    f.call(
      'POST',
      `/v1/public-reports/${receipt.caseId}/correspondence`,
      body,
      undefined,
      key,
      credential,
    );
  const counter = {
    kind: 'counter_notice',
    statement: 'The material was removed by mistake.',
    contentLanguage: 'en',
    counterNotice: declaration,
  };
  const createCase = async (seed: number, parallel = false, authenticatedNotice = false) => {
    const image = await f.author.upload(png(seed, seed));
    let receipt: Receipt;
    if (authenticatedNotice) {
      const key = randomUUID();
      const complaint = await json<{ caseId: string; reportId: string }>(
        await f.call(
          'POST',
          '/v1/rights/complaints',
          {
            profile: 'rights-complaint-v1',
            actingSubject: f.staff.actor,
            authority: { kind: 'platform', scopeId: 'governance:platform' },
            context: 'urn:rezics:context:global',
            target: {
              owner: 'content',
              resource: `https://rezics.com/id/${image.asset}`,
              component: 'body',
            },
            disclosure: 'parties',
            reasonCode: 'copyright',
            statement: 'Please review the exact retained image.',
            evidence: [
              {
                owner: 'content',
                resource: `https://rezics.com/id/${image.asset}`,
                component: 'body',
                revision: image.revision,
                locator: null,
              },
            ],
            idempotencyKey: key,
            complaint: {
              process: 'dmca_512',
              claimantKind: 'rights_holder',
              claimantName: 'Claimant private name',
              claimantContact: `claimant-${seed}@example.test`,
              claimedWork: 'Original artwork',
              claimedRight: 'copyright',
              noticeDigest: 'a'.repeat(64),
              noticeReceivedAt: now.toISOString(),
            },
          },
          f.staff.token,
          key,
        ),
        201,
      );
      receipt = { ...complaint, credential: '', receivedAt: now.toISOString() };
    } else
      receipt = await f.report(image, 'copyright', {
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
    const other = parallel ? await f.report(image, 'harassment') : null;
    const restricted = await f.complete(await f.input(receipt, image, 'interim_restrict'));
    const affected = (
      await f.stack.accessPool.query<{ credential: string }>(
        `SELECT credential
      FROM access.safety_party_notice WHERE case_id = $1 AND principal_id = $2 AND decision_id = $3`,
        [receipt.caseId, f.author.principalId, restricted.decisionId],
      )
    ).rows[0]!.credential;
    return { image, receipt, restricted, affected, other };
  };
  try {
    const restored = await createCase(91);
    const key = randomUUID();
    const concurrent = await Promise.all(
      [
        correspond(restored.receipt, restored.affected, counter, key),
        correspond(restored.receipt, restored.affected, counter, key),
      ].map(async (response) => json<{ stepId: string; replayed: boolean }>(await response)),
    );
    const response = concurrent[0]!;
    expect(concurrent[1]!.stepId).toBe(response.stepId);
    expect(concurrent.filter((item) => item.replayed)).toHaveLength(1);
    expect(
      await json(await correspond(restored.receipt, restored.affected, counter, key)),
    ).toMatchObject({ stepId: response.stepId, replayed: true });
    expect((await correspond(restored.receipt, restored.receipt.credential, counter)).status).toBe(
      404,
    );
    expect((await correspond(restored.receipt, restored.affected, counter)).status).toBe(409);
    expect(
      (await status(restored.receipt)).steps.some((step) => step.kind === 'counter_notice'),
    ).toBe(true);
    const passes = await Promise.all([notices.runPage(), notices.runPage()]);
    expect(passes.reduce((count, pass) => count + pass.processed, 0)).toBe(1);
    expect(passes.reduce((count, pass) => count + pass.deferred, 0)).toBe(1);
    expect((await accountPool.query('SELECT id FROM rezics_account_email')).rowCount).toBe(1);
    expect(
      (await status(restored.receipt)).steps.some((step) => step.kind === 'restoration_not_before'),
    ).toBe(false);
    setClock('2026-10-02T14:39:12Z');
    expect(await notices.runPage()).toEqual({ processed: 1, deferred: 0 });
    expect((await accountPool.query('SELECT id FROM rezics_account_email')).rowCount).toBe(1);
    expect(
      (await status(restored.receipt)).steps.some((step) => step.kind === 'restoration_not_before'),
    ).toBe(false);
    await drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('claimant-91@example.test');
    expect(sent[0]!.text).toContain(declaration.signature);
    expect(sent[0]!.text).toContain(declaration.address);
    expect(sent[0]!.text).not.toContain('Claimant private address');
    setClock('2026-10-02T14:41:12Z');
    expect(await notices.runPage()).toEqual({ processed: 1, deferred: 0 });
    expect(submitted[0]!.deliveryId).toBe(submitted[2]!.deliveryId);
    const reporter = await status(restored.receipt),
      affected = await status(restored.receipt, restored.affected);
    expect(reporter.notice.declarations.claimantAddress).toBe('Claimant private address');
    expect(
      reporter.steps.find((step) => step.kind === 'counter_notice')!.declarations!.address,
    ).toBeUndefined();
    expect(affected.notice.contactEmail).toBeNull();
    expect(affected.notice.declarations.claimantAddress).toBeUndefined();
    expect(
      affected.steps.find((step) => step.kind === 'counter_notice')!.declarations!.address,
    ).toBe(declaration.address);
    expect(reporter.steps.find((step) => step.kind === 'restoration_not_before')!.dueAt).toBe(
      '2026-10-16T14:41:12.000Z',
    );
    expect(reporter.steps.find((step) => step.kind === 'restoration_not_after')!.dueAt).toBe(
      '2026-10-22T14:41:12.000Z',
    );
    expect((await f.stack.store.readAsset(restored.image.asset))!.moderation).toBe('suppressed');
    setClock('2026-10-16T14:41:11Z');
    expect((await notices.runPage()).processed).toBe(0);
    await expect(
      f.stack.accessPool.query(
        `UPDATE access.rights_counter_notice SET
      not_before = not_before + interval '1 day' WHERE step_id = $1`,
        [response.stepId],
      ),
    ).rejects.toThrow();
    setClock('2026-10-16T14:41:12Z');
    expect(await notices.runPage()).toEqual({ processed: 1, deferred: 0 });
    expect((await f.stack.store.readAsset(restored.image.asset))!.moderation).toBe('none');
    expect(await status(restored.receipt)).toMatchObject({
      outcome: 'restore',
      operation: { status: 'completed' },
    });
    expect(
      (
        await f.stack.accessPool.query(
          `SELECT phase FROM access.rights_counter_notice
      WHERE step_id = $1`,
          [response.stepId],
        )
      ).rows[0]!.phase,
    ).toBe('done');
    expect((await notices.runPage()).processed).toBe(0);
    expect(
      (await f.governance.safety.due(f.staff.principal, f.staff.actor)).items.some(
        (step) => step.caseId === restored.receipt.caseId,
      ),
    ).toBe(false);

    setClock('2026-10-02T14:37:12Z');
    const stayed = await createCase(92);
    await json(await correspond(stayed.receipt, stayed.affected, counter));
    await notices.runPage();
    await drain();
    setClock('2026-10-02T14:39:12Z');
    await notices.runPage();
    const filing = {
      kind: 'claimant_action',
      statement: 'An action seeking a court order has been filed.',
      contentLanguage: 'en',
      courtFiling: {
        court: 'District Court',
        caseNumber: 'fixture-123',
        documentDigest: 'a'.repeat(64),
      },
    };
    expect((await correspond(stayed.receipt, stayed.affected, filing)).status).toBe(404);
    await json(await correspond(stayed.receipt, stayed.receipt.credential, filing));
    setClock('2026-10-23T14:41:12Z');
    expect((await notices.runPage()).deferred).toBe(0);
    expect((await f.stack.store.readAsset(stayed.image.asset))!.moderation).toBe('suppressed');
    expect(
      (await status(stayed.receipt)).steps.some((step) => step.kind === 'claimant_action'),
    ).toBe(true);
    expect(
      (
        await f.stack.accessPool.query(
          `SELECT phase FROM access.rights_counter_notice
      WHERE case_id = $1`,
          [stayed.receipt.caseId],
        )
      ).rows[0]!.phase,
    ).toBe('stayed');

    setClock('2026-10-02T14:37:12Z');
    const blocked = await createCase(93, true);
    await f.complete(await f.input(blocked.other!, blocked.image));
    await json(await correspond(blocked.receipt, blocked.affected, counter));
    await notices.runPage();
    await drain();
    setClock('2026-10-02T14:39:12Z');
    await notices.runPage();
    setClock('2026-10-23T14:41:12Z');
    expect((await notices.runPage()).deferred).toBe(1);
    expect((await f.stack.store.readAsset(blocked.image.asset))!.moderation).toBe('suppressed');
    expect((await status(blocked.receipt)).outcome).toBe('interim_restrict');

    // Authenticated intake uses exactly the same declaration, delivery and deadline operation.
    setClock('2026-10-02T14:37:12Z');
    const authenticated = await createCase(94, false, true);
    await f.author.grant('governance:platform', 'governance.appeal');
    const authKey = randomUUID();
    const body = {
      profile: 'governance-process-step-v1',
      caseId: authenticated.receipt.caseId,
      decisionId: authenticated.restricted.decisionId,
      actingSubject: f.author.actor,
      process: 'dmca_512',
      step: 'counter_notice',
      partySubject: f.author.actor,
      statement: counter.statement,
      documentDigest: null,
      occurredAt: now.toISOString(),
      dueAt: null,
      idempotencyKey: authKey,
      counterNotice: declaration,
      contentLanguage: 'en',
    };
    const authResponse = await json<{ stepId: string }>(
      await f.call('POST', '/v1/governance/process-steps', body, f.author.token, authKey),
      201,
    );
    expect(
      await json(
        await f.call('POST', '/v1/governance/process-steps', body, f.author.token, authKey),
      ),
    ).toMatchObject({ stepId: authResponse.stepId, replayed: true });
    await notices.runPage();
    authenticated.receipt.credential = submitted.find(
      (mail) => mail.caseId === authenticated.receipt.caseId,
    )!.credential;
    await drain();
    setClock('2026-10-02T14:39:12Z');
    await notices.runPage();
    const authStatus = await status(authenticated.receipt);
    expect(authStatus.notice).toMatchObject({
      contactEmail: 'claimant-94@example.test',
      declarations: {
        claimantName: 'Claimant private name',
        claimedWork: 'Original artwork',
        claimedRight: 'copyright',
      },
    });
    const authAffected = await status(authenticated.receipt, authenticated.affected);
    expect(authAffected.notice.declarations).toMatchObject({
      claimedWork: 'Original artwork',
      claimedRight: 'copyright',
    });
    expect(authAffected.notice.declarations.claimantName).toBeUndefined();
    expect(authAffected.notice.declarations.claimantContact).toBeUndefined();
    expect(authAffected.notice.contactEmail).toBeNull();
    expect(authStatus.steps.find((step) => step.kind === 'restoration_not_before')!.dueAt).toBe(
      '2026-10-16T14:39:12.000Z',
    );
    expect(sent.filter((mail) => mail.to === 'claimant-94@example.test')).toHaveLength(1);

    // Staff steps have no report_id; both parties can still traverse those records.
    const staffKey = randomUUID();
    await json(
      await f.call(
        'POST',
        '/v1/governance/process-steps',
        {
          ...body,
          counterNotice: undefined,
          actingSubject: f.staff.actor,
          partySubject: null,
          step: 'uploader_notice',
          statement: 'Staff recorded the removal.',
          idempotencyKey: staffKey,
        },
        f.staff.token,
        staffKey,
      ),
      201,
    );
    expect(
      (await status(authenticated.receipt)).steps.some(
        (step) => step.statement === 'Staff recorded the removal.',
      ),
    ).toBe(true);
    expect(
      (await status(authenticated.receipt, authenticated.affected)).steps.some(
        (step) => step.statement === 'Staff recorded the removal.',
      ),
    ).toBe(true);

    const client = await f.stack.accessPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT step_id FROM access.rights_counter_notice WHERE phase IN ('delivery','waiting','restoring')
        AND next_attempt_at <= $1 ORDER BY next_attempt_at,step_id LIMIT 8`,
        [now],
      );
      expect(JSON.stringify(plan.rows)).toContain('rights_counter_notice_due');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await accountPool.end();
    await f.stop();
    await databases.close();
  }
}, 180_000);

test('Upgrade forwards previously signed counter-notices once and replaces their intake-based timing basis', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test with the integration tier');
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, [
    'access',
    'content',
    'relay',
  ]);
  const f = await safetyFixture('rights-counter-notice-upgrade', true, databases.urls);
  let now = new Date();
  f.setClock(now);
  const notices = new RightsCounterNotices(
    f.stack.accessPool,
    f.governance,
    async () => 'sent',
    () => now,
  );
  try {
    const image = await f.author.upload(png(96, 96));
    const receipt = await f.report(image, 'copyright', {
      contactEmail: 'upgrade-claimant@example.test',
      copyright: {
        signature: 'Claimant',
        claimantName: 'Claimant',
        claimantAddress: 'Address',
        claimantPhone: 'Phone',
        claimedWork: 'Original artwork',
        materialLocation: image.asset,
        goodFaith: true,
        accurateAndAuthorizedUnderPerjury: true,
      },
    });
    const restriction = await f.complete(await f.input(receipt, image, 'interim_restrict'));
    now = new Date();
    const legacyReceived = now;
    const oldCounter = Bun.randomUUIDv7();
    await f.stack.accessPool.query(
      `INSERT INTO access.governance_process_step
      (id,case_id,report_id,process,step,idempotency_key,request_digest,statement,occurred_at,content_language,declarations,party)
      VALUES ($1::uuid,$2,$3,'dmca_512','counter_notice',$1::text,$4,'Legacy signed counter-notice',clock_timestamp(),'en',$5,'affected')`,
      [oldCounter, receipt.caseId, receipt.reportId, 'a'.repeat(64), declaration],
    );
    const oldWindows: string[] = [];
    for (const [kind, days] of [
      ['restoration_not_before', 10],
      ['restoration_not_after', 14],
    ] as const) {
      const id = Bun.randomUUIDv7();
      oldWindows.push(id);
      await f.stack.accessPool.query(
        `INSERT INTO access.governance_process_step
        (id,case_id,report_id,process,step,idempotency_key,request_digest,occurred_at,due_at)
        VALUES ($1::uuid,$2,$3,'dmca_512',$4,$1::text,$5,$6,$7)`,
        [
          id,
          receipt.caseId,
          receipt.reportId,
          kind,
          'a'.repeat(64),
          legacyReceived,
          addBusinessDays(legacyReceived, days),
        ],
      );
    }
    const migration = readFileSync(
      new URL(
        '../../../services/main/migrations/access/1426_pending_rights_counter_notices.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await f.stack.accessPool.query(migration);
    await f.stack.accessPool.query(migration);
    expect(
      (
        await f.stack.accessPool.query(
          `SELECT step_id FROM access.rights_counter_notice
      WHERE case_id = $1`,
          [receipt.caseId],
        )
      ).rows,
    ).toEqual([{ step_id: oldCounter }]);
    now = new Date(now.getTime() + 3 * 86_400_000);
    f.setClock(now);
    expect(await notices.runPage()).toEqual({ processed: 1, deferred: 0 });
    const delivered = (
      await f.stack.accessPool.query<{
        delivered_at: Date;
        not_before: Date;
        claimant_credential: string;
      }>(
        `
      SELECT delivered_at,not_before,claimant_credential FROM access.rights_counter_notice WHERE step_id = $1`,
        [oldCounter],
      )
    ).rows[0]!;
    expect(delivered.delivered_at.toISOString()).toBe(now.toISOString());
    expect(delivered.not_before.toISOString()).toBe(addBusinessDays(now, 10).toISOString());
    expect(delivered.claimant_credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      (await f.deps.publicReports!.status(receipt.caseId, delivered.claimant_credential)).reportId,
    ).toBe(receipt.reportId);
    // Retained legacy windows belong in the case history, not the due queue or alerts.
    const deliveryTime = now;
    now = addBusinessDays(legacyReceived, 10);
    f.setClock(now);
    expect(
      (await f.governance.safety.due(f.staff.principal, f.staff.actor)).items.some(
        (item) => item.caseId === receipt.caseId,
      ),
    ).toBe(false);
    expect((await notices.runPage()).processed).toBe(0);
    await f.produce();
    expect(
      (
        await f.stack.accessPool.query(
          'SELECT 1 FROM access.safety_alert WHERE step_id = ANY($1::uuid[])',
          [oldWindows],
        )
      ).rowCount,
    ).toBe(0);
    now = addBusinessDays(deliveryTime, 10);
    f.setClock(now);
    expect(await notices.runPage()).toEqual({ processed: 1, deferred: 0 });
    expect((await f.stack.store.readAsset(image.asset))!.moderation).toBe('none');
    expect(
      (
        await f.stack.accessPool.query(
          `SELECT restoration_id FROM access.rights_counter_notice
      WHERE step_id = $1`,
          [oldCounter],
        )
      ).rows[0]!.restoration_id,
    ).not.toBe(restriction.decisionId);
    now = addBusinessDays(deliveryTime, 14);
    f.setClock(now);
    expect(
      (await f.governance.safety.due(f.staff.principal, f.staff.actor)).items.some(
        (item) => item.caseId === receipt.caseId,
      ),
    ).toBe(false);
  } finally {
    await f.stop();
    await databases.close();
  }
}, 180_000);

test('Deadline restoration resumes a lost owner acknowledgement without duplicating the effect', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test with the integration tier');
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, [
    'access',
    'content',
    'relay',
  ]);
  const f = await safetyFixture('rights-restoration-recovery', true, databases.urls);
  let now = new Date('2026-10-02T12:00:00Z');
  f.setClock(now);
  f.deps.publicReports = new PublicReports(
    f.stack.accessPool,
    publicReportOwners(f.deps, f.stack.contentPool, f.stack.content),
    () => now,
  );
  const owner = ownerModerationEffects(new ContentModeration(f.stack.contentPool), f.stack.env, {
    pool: f.stack.contentPool,
    core: f.stack.content,
  });
  let loseAck = true;
  const transactions: number[] = [];
  const measuredPool = new Proxy(f.stack.accessPool, {
    get(pool, property) {
      if (property === 'connect')
        return async () => {
          const client = await pool.connect();
          let statements = 0;
          return new Proxy(client, {
            get(connection, key) {
              if (key === 'query')
                return (...args: unknown[]) => {
                  statements++;
                  return Reflect.apply(connection.query, connection, args);
                };
              if (key === 'release')
                return () => {
                  transactions.push(statements);
                  connection.release();
                };
              const value = Reflect.get(connection, key);
              return typeof value === 'function' ? value.bind(connection) : value;
            },
          });
        };
      const value = Reflect.get(pool, property);
      return typeof value === 'function' ? value.bind(pool) : value;
    },
  });
  const recovering = new GovernanceStore(
    measuredPool,
    ownerEvidenceCapture({
      content: { core: f.stack.content, canRead: async (_principal, _actor, ids) => new Set(ids) },
    }),
    ownerTargetHeads({ graph: f.stack.env, content: f.stack.contentPool }),
    f.deps.governance!.rules!,
    {
      ...owner,
      apply: async (...args) => {
        const result = await owner.apply(...args);
        if (loseAck) {
          loseAck = false;
          throw new Error('Lost committed owner acknowledgement');
        }
        return result;
      },
    },
    undefined,
    () => now,
  );
  const notices = new RightsCounterNotices(
    f.stack.accessPool,
    recovering,
    async () => 'sent',
    () => now,
  );
  try {
    const image = await f.author.upload(png(95, 95));
    const receipt = await f.report(image, 'copyright', {
      contactEmail: 'recovery-claimant@example.test',
      copyright: {
        signature: 'Claimant',
        claimantName: 'Claimant',
        claimantAddress: 'Test address',
        claimantPhone: 'Test phone',
        claimedWork: 'Original artwork',
        materialLocation: image.asset,
        goodFaith: true,
        accurateAndAuthorizedUnderPerjury: true,
      },
    });
    const restriction = await f.complete(await f.input(receipt, image, 'interim_restrict'));
    const credential = (
      await f.stack.accessPool.query<{ credential: string }>(
        `SELECT credential
      FROM access.safety_party_notice WHERE decision_id = $1 AND principal_id = $2`,
        [restriction.decisionId, f.author.principalId],
      )
    ).rows[0]!.credential;
    const counter = await json<{ stepId: string }>(
      await f.call(
        'POST',
        `/v1/public-reports/${receipt.caseId}/correspondence`,
        {
          kind: 'counter_notice',
          statement: 'Mistaken removal.',
          contentLanguage: 'en',
          counterNotice: declaration,
        },
        undefined,
        randomUUID(),
        credential,
      ),
    );
    expect(await notices.runPage()).toEqual({ processed: 1, deferred: 0 });
    now = new Date('2026-10-16T12:00:00Z');
    f.setClock(now);
    expect(await notices.runPage()).toEqual({ processed: 1, deferred: 0 });
    const job = (
      await f.stack.accessPool.query<{ phase: string; restoration_id: string }>(
        `
      SELECT phase,restoration_id FROM access.rights_counter_notice WHERE step_id = $1`,
        [counter.stepId],
      )
    ).rows[0]!;
    expect(job.phase).toBe('restoring');
    expect(
      (
        await f.stack.accessPool.query(
          `SELECT state FROM access.safety_decision_effect WHERE decision_id = $1`,
          [job.restoration_id],
        )
      ).rows[0]!.state,
    ).toBe('uncertain');
    expect((await f.governance.readEnforcement(f.target(image)))[0]!.state).toBe('restricted');
    const applied = await f.stack.store.readAsset(image.asset);
    now = new Date('2026-10-16T12:01:01Z');
    f.setClock(now);
    transactions.length = 0;
    expect(await notices.runPage()).toEqual({ processed: 1, deferred: 0 });
    expect(Math.max(...transactions)).toBeLessThanOrEqual(
      GOVERNANCE_OPERATION_COST.accessStatementsPerTransaction,
    );
    const resumed = (
      await f.stack.accessPool.query<{ phase: string; restoration_id: string }>(
        `
      SELECT phase,restoration_id FROM access.rights_counter_notice WHERE step_id = $1`,
        [counter.stepId],
      )
    ).rows[0]!;
    expect(resumed).toEqual({ ...job, phase: 'done' });
    expect(await f.stack.store.readAsset(image.asset)).toEqual(applied);
    expect((await f.governance.readEnforcement(f.target(image)))[0]!.state).toBe('released');
    expect(
      (
        await f.stack.accessPool.query(
          `SELECT id FROM access.moderation_decision
      WHERE case_id = $1 AND outcome = 'restore'`,
          [receipt.caseId],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    await f.stop();
    await databases.close();
  }
}, 180_000);
