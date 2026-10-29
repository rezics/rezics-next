import { MAX_CONSENTED_SCOPES } from '@rezics/auth-contract';
import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createCurrentConsentReader } from '../src/current-consent.ts';
import { createAuthService, createBarrierProofVerifier, createProvisioningEvidenceVerifier } from '../src/index.ts';
import { migrate as migrateKernel } from '../../kernel/scripts/database.ts';
import { routeOf } from '../../kernel/src/route/route.ts';
import { capture, checkGrowth, costOf, openGrowthDatabase } from '../../kernel/test/support/growth.ts';

test('native exact consent cost stays fixed as unrelated and same-person other-client/history rows grow', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  try {
    await db.admin.query(`INSERT INTO auth_client VALUES ('selected',false,ARRAY['read']);
      INSERT INTO auth_client_coverage (client_id,ready) VALUES ('selected',true);
      INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ('person','selected',ARRAY['read'])`);
    const read = createCurrentConsentReader({ database: db.pool }).readCurrentConsent;
    const raw: unknown[] = [];
    const report = await checkGrowth(db, {
      name: 'Auth current consent exact tuple',
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_, scale, previous) {
        const range = [previous * 500 + 1, scale * 500];
        await db.admin.query(
          `INSERT INTO auth_client SELECT 'other-'||i,false,ARRAY['read'] FROM generate_series($1::int,$2::int) i`,
          range,
        );
        await db.admin.query(
          `INSERT INTO auth_client_coverage (client_id,ready) SELECT 'other-'||i,true FROM generate_series($1::int,$2::int) i`,
          range,
        );
        await db.admin.query(
          `INSERT INTO auth_consent (account_id,client_id,scopes)
          SELECT 'owner-'||i,'other-'||i,ARRAY['read'] FROM generate_series($1::int,$2::int) i
          UNION ALL SELECT 'person','other-'||i,ARRAY['write'] FROM generate_series($1::int,$2::int) i`,
          range,
        );
        await db.admin.query(
          `INSERT INTO auth_client_reduction_progress (operation_id,client_id,scopes,first_party,completed)
          SELECT 'history-'||i,'other-'||i,ARRAY['read'],false,true FROM generate_series($1::int,$2::int) i`,
          range,
        );
        await db.admin.query(
          `INSERT INTO auth_client_reduction SELECT 'other-'||i,'history-'||i,ARRAY['read'],false FROM generate_series($1::int,$2::int) i`,
          range,
        );
        await db.admin.query('VACUUM (ANALYZE)');
        const sample = await capture(db, () => read({ actorAccountId: 'person', clientId: 'selected' }));
        raw.push({ scale, ...sample });
        expect(sample.capture.plans.length).toBeGreaterThan(0);
        expect(costOf(sample.capture).statements).toBe(1);
        expect(sample.capture.statements.some((sql) => /\b(?:SET|EXPLAIN)\b/i.test(sql))).toBe(false);
      },
      async operation() {
        expect(await read({ actorAccountId: 'person', clientId: 'selected' })).toEqual({
          actorAccountId: 'person',
          clientId: 'selected',
          scopes: ['read'],
        });
      },
    });
    for (const { cost } of report.samples) {
      expect(cost.statements).toBe(1);
      expect(cost.rows).toBeLessThanOrEqual(4);
      expect(cost.relations?.['public.auth_consent']?.rows).toBe(1);
      expect(cost.relations?.['public.auth_client_reduction_progress']).toBeUndefined();
    }
    // Retain full native SQL/auto_explain provenance, not synthetic EXPLAIN or timing.
    await Bun.write('.temp/current-consent-growth.json', JSON.stringify({ report, raw }, null, 2));
    console.info('Native current consent:', JSON.stringify(report));
  } finally {
    await db.close();
    fixture.close();
  }
}, 120000);

test('durable consent point reader honors native pending reduction ceiling before Access floor and after lost acknowledgement, no extra statements or history scan', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  let release!: () => void;
  let reduction: Promise<Response> | undefined;
  try {
    migrateKernel(fixture.url);
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = fixture.url;
    let native;
    try {
      await import(createRequire(new URL('../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
      native = {
        ...(await import('../../kernel/src/access/lifecycle.ts')),
        ...(await import('../../kernel/src/access/account-data.ts')),
        ...(await import('../../kernel/src/access/registration-proof.ts')),
        ...(await import('../../kernel/src/access/auth-bindings.ts')),
        ...(await import('../../kernel/src/access/auth-barriers.ts')),
      };
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    }
    const database = db.openPool({ max: 1, connectionTimeoutMillis: 5000 });
    const proofs = createBarrierProofVerifier({ database });
    const lifecycle = native.createLifecycleInternals({
      pool: db.pool,
      routeKey: new Uint8Array(32).fill(63),
      provisioningEvidence: createProvisioningEvidenceVerifier({ database }).resolve,
      recoveryEvidence: async () => null,
    });
    const registration = native.createRegistrationProofBindings({
      pool: db.pool,
      referenceKeys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(69)]]) },
    });
    const bindings = native.createAuthBindings({ pool: db.pool, ...registration });
    const barriers = native.createAuthBarrierCapabilities({ lifecycle, proofs });
    const accountId = lifecycle.registrationTarget('current-consent');
    const selected = { actorAccountId: accountId, clientId: 'external' };
    const read = () => createCurrentConsentReader({ database: db.pool }).readCurrentConsent(selected);
    const marker = async () =>
      (await db.admin.query('SELECT * FROM auth_consent WHERE account_id=$1 AND client_id=$2', [accountId, 'external']))
        .rows[0];
    const key = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'native',
    };
    const options = {
      database,
      issuer: 'https://current-consent.auth.test',
      audience: 'https://current-consent.api.test',
      secret: 'current-consent-native-test-secret-32-bytes',
      signing: { activeKid: key.kid, privateKeys: [key] },
      trustedAccess: trustedAccessPorts({
        ...bindings,
        async authorizeProvisioning(reference: string) {
          const approval = await bindings.authorizeProvisioning(reference);
          const receipt = await registration.verifyProvisioningReceipt(reference);
          const account = await native.readAccount(db.pool, routeOf(approval.accountId)!, approval.accountId);
          if (!receipt || !account) throw new Error('Missing native registration');
          return {
            ...approval,
            receipt: {
              registrationId: receipt.registrationId,
              reservationId: receipt.registrationId,
              expiresAt: receipt.expiresAt,
              authnEpoch: Number(account.minimumAuthnEpoch),
            },
          };
        },
        ...barriers.trustedAccess,
      }),
    };
    let auth = await createAuthService(options);
    const request = (path: string, body: unknown, cookie = '') =>
      auth.handler(
        new Request(`${options.issuer}${path}`, {
          method: 'POST',
          headers: { origin: options.issuer, 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        }),
      );
    const cookie = (response: Response) =>
      response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    const scopes = ['read', 'write'];
    for (const clientId of ['web', 'external'])
      await auth.internal.registerClient({ clientId, firstParty: clientId === 'web', scopes });
    const input = { accountId, handle: 'current_consent', key: 'current-consent' };
    const reserved = await lifecycle.reserveHandle(input);
    const pending = { ...input, reservationId: reserved.value.reservationId };
    const outcome = await lifecycle.createPending(pending);
    const authorization = await registration.createProvisioningReference({ input: pending, outcome });
    if (!authorization) throw new Error('Missing native provisioning reference');
    const password = 'current consent native password';
    const provisioned = await auth.internal.provisionPassword({
      authorization,
      email: 'current@example.test',
      password,
    });
    if (!provisioned.provisioningEvidence) throw new Error('Missing native provisioning evidence');
    await lifecycle.claimHandle({
      ...pending,
      key: 'current-consent-claim',
      evidence: provisioned.provisioningEvidence,
    });
    await lifecycle.activate({
      accountId,
      key: 'current-consent-activate',
      evidence: provisioned.provisioningEvidence,
    });
    const login = async () => {
      const response = await request('/signin', { account_id: accountId, password, client_id: 'web', scope: scopes });
      expect(response.status).toBe(200);
      return cookie(response);
    };
    let session = await login();
    const grant = (scope: string[]) => request('/consent', { client_id: 'external', scope }, session);
    expect((await grant(scopes)).status).toBe(200);
    const before = await marker();
    let entered!: () => void;
    const atCallback = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lose = true;
    let reference = '';
    options.trustedAccess.invalidateAccount = async (actual) => {
      reference = actual.proofReference!;
      expect(await marker()).toEqual({ ...before, pending_scopes: ['read'], pending_reference: reference });
      expect(
        await proofs.verify(reference, {
          accountId,
          purpose: 'consent-reduction',
          previousEpoch: actual.previousEpoch,
          operationKey: actual.operationKey!,
        }),
      ).not.toBeNull();
      const committed = (
        await db.admin.query(
          `SELECT c.xmin::text AS consent_transaction,p.xmin::text AS proof_transaction
         FROM auth_consent c JOIN auth_barrier_proof p ON p.reference=c.pending_reference
         WHERE c.account_id=$1 AND c.client_id=$2`,
          [accountId, 'external'],
        )
      ).rows[0];
      if (lose) {
        expect(committed.consent_transaction).toBe(committed.proof_transaction);
        expect((await lifecycle.readFenceState(accountId))?.minimumAuthnEpoch).toBe('1');
        entered();
        await held;
      }
      const receipt = await barriers.trustedAccess.invalidateAccount!(actual);
      if (lose) throw new Error('Lost acknowledgement after native floor commit');
      return receipt;
    };
    reduction = grant(['read']);
    await Promise.race([
      atCallback,
      reduction.then((response) => {
        throw new Error(`Reduction returned ${response.status} before callback`);
      }),
    ]);
    expect(await read()).toEqual({ ...selected, scopes: ['read'] });
    const raw: unknown[] = [];
    const report = await checkGrowth(db, {
      name: 'native pending current consent exact tuple',
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_, scale, previous) {
        const range = [accountId, previous * 500 + 1, scale * 500];
        await db.admin.query(
          `INSERT INTO auth_client SELECT 'history-'||i,false,ARRAY['read','write'] FROM generate_series($1::int,$2::int) i`,
          range.slice(1),
        );
        await db.admin.query(
          `INSERT INTO auth_client_coverage(client_id,ready) SELECT 'history-'||i,true FROM generate_series($1::int,$2::int) i`,
          range.slice(1),
        );
        await db.admin.query(
          `INSERT INTO auth_consent(account_id,client_id,scopes,pending_scopes,pending_reference)
          SELECT $1,'history-'||i,ARRAY['read','write'],ARRAY['read'],'history-'||i FROM generate_series($2::int,$3::int) i
          UNION ALL SELECT 'other-'||i,'external',ARRAY['read','write'],ARRAY['read'],'history-'||i FROM generate_series($2::int,$3::int) i`,
          range,
        );
        await db.admin.query(
          `INSERT INTO auth_client_reduction_progress(operation_id,client_id,scopes,first_party,completed)
          SELECT 'history-'||i,'history-'||i,ARRAY['read'],false,true FROM generate_series($1::int,$2::int) i`,
          range.slice(1),
        );
        await db.admin.query(
          `INSERT INTO auth_client_reduction SELECT 'history-'||i,'history-'||i,ARRAY['read'],false FROM generate_series($1::int,$2::int) i`,
          range.slice(1),
        );
        await db.admin.query(
          `INSERT INTO auth_barrier_proof(reference,account_id,purpose,previous_epoch,operation_key,digest,evidence,created_at,expires_at)
          SELECT md5(i::text)||md5(i::text),$1,'consent-reduction',1,'history-'||i,repeat('0',64),'[]',
          now()-interval '10 minutes',now()-interval '9 minutes' FROM generate_series($2::int,$3::int) i`,
          range,
        );
        await db.admin.query('VACUUM (ANALYZE)');
        const sample = await capture(db, read);
        raw.push({ scale, ...sample });
        expect(sample.capture.plans.length).toBe(1);
        expect(sample.capture.statements).toHaveLength(1);
        expect(sample.capture.statements[0]).toContain('c.pending_scopes');
        expect(sample.capture.statements.some((sql) => /\b(?:SET|EXPLAIN)\b/i.test(sql))).toBe(false);
      },
      async operation() {
        expect(await read()).toEqual({ ...selected, scopes: ['read'] });
      },
    });
    for (const { cost } of report.samples) {
      expect(cost.statements).toBe(1);
      expect(cost.rows).toBeLessThanOrEqual(4);
      expect(
        Object.keys(cost.relations!)
          .filter((name) => name.startsWith('public.'))
          .sort(),
      ).toEqual([
        'public.auth_client',
        'public.auth_client_coverage',
        'public.auth_client_reduction',
        'public.auth_consent',
      ]);
      expect(cost.relations?.['public.auth_consent']?.rows).toBe(1);
      for (const relation of Object.values(cost.relations!)) expect(relation.sequentialScans).toBe(0);
    }
    await Bun.write('.temp/native-pending-current-consent-growth.json', JSON.stringify({ report, raw }, null, 2));
    release();
    expect((await reduction).status).toBe(503);
    expect((await lifecycle.readFenceState(accountId))?.minimumAuthnEpoch).toBe('2');
    auth = await createAuthService(options);
    expect(await read()).toEqual({ ...selected, scopes: ['read'] });
    expect((await marker()).pending_reference).toBe(reference);
    expect((await grant([])).status).toBe(401);
    expect((await marker()).pending_reference).toBe(reference);
    lose = false;
    expect((await grant(['read'])).status).toBe(200);
    expect(await marker()).toMatchObject({ scopes: ['read'], pending_scopes: null, pending_reference: null });
    expect(await read()).toEqual({ ...selected, scopes: ['read'] });
    session = await login();
    expect((await grant(scopes)).status).toBe(200);
    expect(await read()).toEqual({ ...selected, scopes });
    // A new real request remains restrictive even after its source expires and
    // the native collector removes the proof. The marker has no proof FK/TTL.
    await db.admin.query(
      `UPDATE session SET "expiresAt"=statement_timestamp()+interval '3 seconds'
      WHERE "userId"=$1 AND "clientId"='web'`,
      [accountId],
    );
    let abandoned!: Parameters<typeof barriers.trustedAccess.completeBarrier>[0];
    options.trustedAccess.invalidateAccount = async (actual) => {
      reference = actual.proofReference!;
      const receipt = await barriers.trustedAccess.invalidateAccount!(actual);
      abandoned = {
        accountId,
        purpose: 'consent-reduction',
        operationKey: actual.operationKey!,
        receiptId: receipt.receiptId,
        minimumAuthnEpoch: receipt.minimumAuthnEpoch,
      };
      throw new Error('Lost acknowledgement');
    };
    expect((await grant(['read'])).status).toBe(503);
    auth = await createAuthService(options);
    while (
      !(
        await db.admin.query(
          'SELECT expires_at<=statement_timestamp() AS expired FROM auth_barrier_proof WHERE reference=$1',
          [reference],
        )
      ).rows[0]?.expired
    )
      await setImmediate();
    let swept;
    do {
      swept = await proofs.sweep({ limit: 1000 });
    } while (swept.hasMore);
    expect(
      (await db.admin.query('SELECT reference FROM auth_barrier_proof WHERE reference=$1', [reference])).rows,
    ).toEqual([]);
    expect((await marker()).pending_reference).toBe(reference);
    expect(await read()).toEqual({ ...selected, scopes: ['read'] });
    expect((await grant(['read'])).status).toBe(401);
    // The abandoned barrier fenced the account: it signs in again only once Auth completes the barrier.
    expect(
      (await request('/signin', { account_id: accountId, password, client_id: 'web', scope: scopes })).status,
    ).toBe(401);
    await barriers.trustedAccess.completeBarrier(abandoned);
    expect((await lifecycle.readFenceState(accountId))?.fenced).toBe(false);
    session = await login();
    expect((await grant(scopes)).status).toBe(200);
    expect((await marker()).pending_reference).toBeNull();
    expect(await read()).toEqual({ ...selected, scopes });
  } finally {
    release?.();
    await reduction?.catch(() => undefined);
    await db.close();
    fixture.close();
  }
}, 120000);

test('current consent keeps one point statement and fixed rows at 16, 103 and 512 scopes', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  try {
    await db.admin.query(`INSERT INTO auth_client VALUES ('scope-bound',false,ARRAY['read']);
      INSERT INTO auth_client_coverage (client_id,ready) VALUES ('scope-bound',true);
      INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ('person','scope-bound',ARRAY['read'])`);
    const read = createCurrentConsentReader({ database: db.pool }).readCurrentConsent;
    const costs = [];
    for (const count of [16, 103, MAX_CONSENTED_SCOPES, MAX_CONSENTED_SCOPES + 1]) {
      const scopes = Array.from({ length: count }, (_, i) => `scope:${i}:`.padEnd(128, 'a'));
      await db.admin.query("UPDATE auth_client SET scopes=$1 WHERE client_id='scope-bound'", [scopes]);
      await db.admin.query("UPDATE auth_consent SET scopes=$1 WHERE client_id='scope-bound'", [scopes]);
      const sample = await capture(db, () => read({ actorAccountId: 'person', clientId: 'scope-bound' }));
      expect(sample.value).toEqual(
        count > MAX_CONSENTED_SCOPES
          ? null
          : {
              actorAccountId: 'person',
              clientId: 'scope-bound',
              scopes: [...scopes].sort(),
            },
      );
      const cost = costOf(sample.capture);
      costs.push([cost.statements, cost.rows]);
    }
    expect(costs[0]![0]).toBe(1);
    expect(costs).toEqual([costs[0], costs[0], costs[0], costs[0]]);
  } finally {
    await db.close();
    fixture.close();
  }
});
