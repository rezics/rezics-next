import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { cookies, nativeFixture, scopes } from './native-account-bindings-fixture.ts';

const secret = 'rate-tier-write-rate-secret-32bytes';
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: ReturnType<typeof createKernel>;
let staff: Awaited<ReturnType<Awaited<ReturnType<typeof nativeFixture>>['person']>>;
let operator: typeof staff;
let ordinary: typeof staff;
let automated: Awaited<ReturnType<Awaited<ReturnType<typeof nativeFixture>>['automated']>>;
let automatedBearer: string;

function key() {
  return Bun.randomUUIDv7();
}

async function callRateTier(
  bearer: string,
  accountId: string,
  tier: 'ordinary' | 'trusted' | 'service',
  requestKey = key(),
) {
  const response = await kernel.handle(
    new Request(`http://kernel.test/v1/accounts/${accountId}:setRateTier`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(requestKey),
      },
      body: JSON.stringify({ key: requestKey, tier }),
    }),
  );
  return { response, value: await response.json() };
}

async function writeGrant(bearer: string, requestKey = key()) {
  return kernel.handle(
    new Request('http://kernel.test/v1/grants', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(requestKey),
      },
      body: JSON.stringify({
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'account', id: staff.accountId },
        actions: ['context:create'],
        valid: '(,)',
      }),
    }),
  );
}

async function account(accountId: string) {
  return (
    await db.admin.query<{ rate_tier: string; state: string; transaction_id: string }>(
      'SELECT rate_tier, state, transaction_id::text FROM access.account WHERE route=$1 AND account_id=$2',
      [routeOf(accountId), accountId],
    )
  ).rows[0]!;
}

async function rateCount(accountId: string) {
  const digest = createHmac('sha256', secret).update(`account:${accountId}`).digest('hex');
  const row = (
    await db.admin.query<{ count: number }>(
      "SELECT count FROM access.write_rate_counter WHERE identity_digest=$1 AND family='write'",
      [digest],
    )
  ).rows[0];
  return row?.count ?? 0;
}

beforeAll(async () => {
  if (!scopes.includes('account:set_rate_tier')) scopes.push('account:set_rate_tier');
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  fixture = await nativeFixture(db.pool);
  const limiter = createWriteRateLimiter({
    secret,
    overrides: JSON.stringify({
      'new-account': { write: { maximum: 1, seconds: 86400 } },
      trusted: { write: { maximum: 1000, seconds: 86400 } },
      service: { write: { maximum: 2, seconds: 86400 } },
    }),
  });
  kernel = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(81),
    tokens: fixture.referenceKeys,
    access: () => fixture.access,
    writeRate: limiter,
  });

  staff = await fixture.person('rate-tier-staff');
  operator = await fixture.person('rate-tier-operator');
  ordinary = await fixture.person('rate-tier-ordinary');
  const bootstrap = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, '../../scripts/bootstrap-governance.ts'), '--account', staff.accountId],
    { env: { ...process.env, DATABASE_URL: db.url }, stdout: 'pipe', stderr: 'pipe' },
  );
  const exitCode = await bootstrap.exited;
  if (exitCode !== 0)
    throw new Error(
      `Governance bootstrap failed: ${await new Response(bootstrap.stdout).text()}\n${await new Response(bootstrap.stderr).text()}`,
    );

  // Move staff to a larger class so the test actor's one-unit ordinary budget remains observable.
  const promoted = await callRateTier(staff.bearer, staff.accountId, 'trusted');
  expect(promoted.response.status).toBe(200);

  automated = await fixture.automated('rate-tier-operated-bot', operator);
  const operationKey = 'rate-tier-operated-session';
  const operation = {
    kind: 'opening' as const,
    operatorAccountId: operator.accountId,
    subjectAccountId: automated.accountId,
    authorization: 'approval-request',
  };
  const opening = await fixture
    .approval()
    .approve(operator.bearer, { operationKey, operation }, { pool: db.pool, deadline: Date.now() + 10000 });
  const opened = await fixture.host.workflows.openOperatorSession({
    key: operationKey,
    authorization: opening.reference,
    operatorAccountId: operator.accountId,
    subjectAccountId: automated.accountId,
    headers: operator.headers,
  });
  expect(opened.status).toBe(200);
  const token = await fixture.request('/token', {}, cookies(opened));
  expect(token.status).toBe(200);
  automatedBearer = ((await token.json()) as { access_token: string }).access_token;
}, 120000);

afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    await db?.close();
  }
});

test('platform governance sets a human trusted or ordinary and replay keeps one receipt and effect', async () => {
  const requestKey = key();
  const trusted = await callRateTier(staff.bearer, operator.accountId, 'trusted', requestKey);
  expect(trusted.response.status).toBe(200);
  expect(trusted.value).toMatchObject({ rateTier: { accountId: operator.accountId, tier: 'trusted' } });
  const receiptId = (trusted.value as { rateTier: { receiptId: string } }).rateTier.receiptId;
  const stateAfterFirst = await account(operator.accountId);
  const receiptsAfterFirst = Number(
    (
      await db.admin.query(
        "SELECT count(*)::int AS count FROM core.receipt WHERE command_kind='access.account.set_rate_tier' AND idempotency_key=$1",
        [requestKey],
      )
    ).rows[0]!.count,
  );
  const eventsAfterFirst = Number(
    (
      await db.admin.query(
        "SELECT count(*)::int AS count FROM core.outbox WHERE type='com.rezics.access.account.rate-tier-set.v1' AND subject=$1",
        [operator.accountId],
      )
    ).rows[0]!.count,
  );

  const replay = await callRateTier(staff.bearer, operator.accountId, 'trusted', requestKey);
  expect(replay.response.status).toBe(200);
  expect(replay.value).toEqual(trusted.value);
  expect((replay.value as { rateTier: { receiptId: string } }).rateTier.receiptId).toBe(receiptId);
  expect(await account(operator.accountId)).toEqual(stateAfterFirst);
  expect(
    Number(
      (
        await db.admin.query(
          "SELECT count(*)::int AS count FROM core.receipt WHERE command_kind='access.account.set_rate_tier' AND idempotency_key=$1",
          [requestKey],
        )
      ).rows[0]!.count,
    ),
  ).toBe(receiptsAfterFirst);
  expect(
    Number(
      (
        await db.admin.query(
          "SELECT count(*)::int AS count FROM core.outbox WHERE type='com.rezics.access.account.rate-tier-set.v1' AND subject=$1",
          [operator.accountId],
        )
      ).rows[0]!.count,
    ),
  ).toBe(eventsAfterFirst);

  const ordinaryTier = await callRateTier(staff.bearer, operator.accountId, 'ordinary');
  expect(ordinaryTier.response.status).toBe(200);
  expect((await account(operator.accountId)).rate_tier).toBe('ordinary');
});

test('an operated automated account gets the service write budget on its next authenticated request', async () => {
  expect((await account(automated.accountId)).rate_tier).toBe('ordinary');
  const ordinaryAttempt = await writeGrant(automatedBearer);
  expect(ordinaryAttempt.status).toBe(403);
  expect(await rateCount(automated.accountId)).toBe(1);

  const changed = await callRateTier(staff.bearer, automated.accountId, 'service');
  expect(changed.response.status).toBe(200);
  expect((await account(automated.accountId)).rate_tier).toBe('service');

  const serviceAttempt = await writeGrant(automatedBearer);
  expect(serviceAttempt.status).toBe(403);
  expect(await rateCount(automated.accountId)).toBe(2);
});

test('an ordinary account without platform governance is refused', async () => {
  const before = await account(operator.accountId);
  const denied = await callRateTier(ordinary.bearer, operator.accountId, 'trusted');
  expect(denied.response.status).toBe(403);
  expect(await account(operator.accountId)).toEqual(before);
});

test('service without a current operator and pending or deleted accounts return not_applied without mutation', async () => {
  const noOperatorBefore = await account(staff.accountId);
  const noOperator = await callRateTier(staff.bearer, staff.accountId, 'service');
  expect(noOperator.response.status).toBe(409);
  expect(noOperator.value).toMatchObject({ code: 'conflict', effect_status: 'not_applied' });
  expect(await account(staff.accountId)).toEqual(noOperatorBefore);

  const pendingId = newId(routeOf(staff.accountId)!);
  await db.admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','pending',$2)",
    [routeOf(pendingId), pendingId],
  );
  const pendingBefore = await account(pendingId);
  const pendingResult = await callRateTier(staff.bearer, pendingId, 'trusted');
  expect(pendingResult.response.status).toBe(409);
  expect(pendingResult.value).toMatchObject({ code: 'conflict', effect_status: 'not_applied' });
  expect(await account(pendingId)).toEqual(pendingBefore);

  const deleted = await fixture.person('rate-tier-deleted');
  await db.admin.query("UPDATE access.account SET state='deleted' WHERE route=$1 AND account_id=$2", [
    routeOf(deleted.accountId),
    deleted.accountId,
  ]);
  const deletedBefore = await account(deleted.accountId);
  const deletedResult = await callRateTier(staff.bearer, deleted.accountId, 'trusted');
  expect(deletedResult.response.status).toBe(409);
  expect(deletedResult.value).toMatchObject({ code: 'conflict', effect_status: 'not_applied' });
  expect(await account(deleted.accountId)).toEqual(deletedBefore);
});
