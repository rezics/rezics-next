import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fromPlainText, serializeDocument } from '@rezics/document';
import {
  hasOwnCommandCompletion,
  IdempotencyConflictError,
  mintReadTime,
  noEffect,
  principalCommandIdentity,
  runCommand,
} from '../../src/command/command.ts';
import {
  configureReceiptKeys,
  encodeReceiptKey,
  nativeReceiptKeyCandidates,
  readReceiptKeyRing,
} from '../../src/command/receipt-key.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernelRuntimeDefaults } from '../../src/server.ts';
import { readWorkerConfig } from '../../src/worker.ts';
import { withConnection } from '../../src/database/pool.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import { createRealmMembership, readMembershipInitiator } from '../../src/community/membership.ts';
import { enqueueRealmJoin } from '../../src/community/join.ts';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { workflowApprovalBinding } from '../../src/access/workflow-approvals.ts';
import { beginAuthorErasure } from '../../src/content/operations.ts';
import { readErasureInitiator, readWorkflowErasureOperation } from '../../src/content/erasure-initiator.ts';
import { erasePostLogicalPageAsInitiator } from '../../src/content/erase-post.ts';
import { pageAuthorErasurePosts } from '../../src/content/erasure-workflow.ts';
import { bindAuthorErasureWorkflow } from '../../src/content/erasure-workflow-identity.ts';
import { createContentOperationClient } from '../../src/content/work.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { readBatch, type Envelope } from '../../src/events/log.ts';
import {
  capture,
  checkGrowth,
  costOf,
  growthViolations,
  medianCost,
  openGrowthDatabase,
  type GrowthDatabase,
} from '../support/growth.ts';
import { testTokens } from '../support/test-kernel.ts';
import { testReceiptKeys as dedicatedKeys } from '../support/receipt-keys.ts';
import { statementOccurrences } from '../support/growth-report.ts';
import { assertGrowthAccessPaths } from '../support/growth-access-path.ts';
import { createProductionAccess } from '../community/membership-fixture.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import barrierSQL from '../../src/access/auth-barriers-receipt-read.sql';
import approvalSQL from '../../src/access/workflow-approvals-tombstone-operator.sql';
import checkoutSQL from '../../src/commerce/command-checkout-count.sql';
import membershipSQL from '../../src/community/membership-operation-receipt.sql';
import pageSQL from '../../src/content/read-erasure-page-receipt.sql';
import enqueueSQL from '../../src/content/read-operation-enqueue-receipt.sql';
import workflowSQL from '../../src/content/read-workflow-erasure-receipt.sql';

const privateKey = (surface: string) => `another-person-alice@example.test:${surface}:${randomUUID()}`;
const deadline = () => Date.now() + 30_000;
const context = (key = privateKey('content')) => ({
  deadline: deadline(),
  requestId: randomUUID(),
  idempotencyKey: key,
});
let db: GrowthDatabase;
let fixture: Awaited<ReturnType<typeof standingFixture>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
const probes: {
  name: string;
  statement: { sql: string; params: readonly string[] };
  input: Record<string, unknown>;
  raw: string[];
}[] = [];
function probe(
  name: string,
  statement: { sql: string; params: readonly string[] },
  input: Record<string, unknown>,
  raw: string[],
) {
  probes.push({ name, statement, input, raw });
}
async function stored(transactionId: string, raw?: string) {
  const rows = (await db.admin.query('SELECT * FROM core.receipt WHERE transaction_id=$1', [transactionId])).rows;
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.idempotency_key).toMatch(/^rk1\.1\.[A-Za-z0-9_-]{43}$/);
  if (raw !== undefined) {
    expect(row.idempotency_key).toBe(
      encodeReceiptKey(dedicatedKeys(), row.command_kind, { kind: row.principal_kind, id: row.principal_id }, raw),
    );
    expect(row.idempotency_key).not.toBe(raw);
  }
  return row;
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  configureReceiptKeys(db.pool, dedicatedKeys());
  fixture = await standingFixture(
    [
      'account:read',
      'realm:join',
      'realm:manage',
      'realm:read',
      'realm:participate',
      'offer:create',
      'offer:manage',
      'offer:read',
      'order:create',
    ],
    db.pool,
  );
  client = await createWorkClient(db.url);
}, 60_000);
afterAll(async () => {
  await client?.close();
  await fixture?.close();
  await db?.close();
});

test('production configuration requires dedicated permanent material at every ingress', () => {
  const env = {};
  expect(() => readReceiptKeyRing(env)).toThrow('KERNEL_RECEIPT_KEYS is required');
  expect(() => readWorkerConfig({ DATABASE_URL: db.url })).toThrow('KERNEL_RECEIPT_KEYS is required');
  expect(() => createKernelRuntimeDefaults({ env, tokens: testTokens() })).toThrow('KERNEL_RECEIPT_KEYS is required');
  expect(() =>
    createKernel({ pool: db.pool, routeKey: Buffer.alloc(32), tokens: testTokens(), receiptKeys: testTokens() }),
  ).toThrow('must not reuse');
});

test('central native lookups stay bounded in the small current receipt neighborhood with real Access controls', async () => {
  const actor = (await fixture.context()).actor;
  const foreign = (await fixture.context(fixture.recipient)).actor;
  const target = { route: 0xffc0, id: newId(0xffc0) };
  const partition = partitionOf(target.route);
  const kind = 'test.receipt-cutover.current';
  await fixture.grant(actor.accountId, 'subject:update', target);
  const receipt = (surface: string) => ({ kind, key: privateKey(surface), digest: Buffer.alloc(32, 47) });
  const normal = receipt('current-normal');
  const empty = receipt('current-no-effect');
  const missing = receipt('current-missing');
  const options = async (owner = actor) => ({
    ...principalCommandIdentity(owner),
    partition,
    deadline: deadline(),
    authorization: await accessCommandAuthorization(
      fixture.access,
      owner,
      'subject:update',
      target,
      { pool: db.pool, deadline: deadline() },
      () => new Error('Denied current receipt lookup'),
    ),
  });
  let effects = 0;
  const emptyResult = await runCommand(db.pool, { ...(await options()), receipt: empty }, async () => {
    effects++;
    return noEffect({ answer: 'empty' });
  });
  expect(emptyResult.position).toBe(0n);
  const normalResult = await runCommand(db.pool, { ...(await options()), receipt: normal }, async () => {
    effects++;
    return {
      value: { answer: 'normal' },
      events: [{ type: 'com.rezics.test.happened.v1', data: { n: 47 } }],
    };
  });
  await stored(emptyResult.transactionId, empty.key);
  await stored(normalResult.transactionId, normal.key);
  const unexpected = async (): Promise<never> => {
    throw new Error('Receipt control executed the command body');
  };
  const report = await checkGrowth(db, {
    name: 'Current receipt neighborhood through native Access',
    scales: [1, 8, 64],
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    indexProbes: 5,
    async grow(database, scale, previous) {
      const inserted = await database.admin.query(
        `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,
          request_digest,epoch,position,transaction_id,response)
        SELECT $1,'account',$2,$3,'current-noise-'||n,$4,1,0,$5,'null'::jsonb
        FROM generate_series($6::int,$7::int)n`,
        [partition, actor.accountId, kind, Buffer.alloc(32), randomUUID(), previous + 1, scale],
      );
      expect(inserted.rowCount).toBe(scale - previous);
    },
    async operation() {
      expect(await runCommand(db.pool, { ...(await options()), receipt: normal }, unexpected)).toEqual({
        ...normalResult,
        replayed: true,
      });
      expect(await runCommand(db.pool, { ...(await options()), receipt: empty }, unexpected)).toEqual({
        ...emptyResult,
        replayed: true,
      });
      for (const [input, completed] of [
        [normal, true],
        [missing, false],
      ] as const)
        expect(
          (await runCommand(db.pool, await options(), async (tx) => noEffect(await hasOwnCommandCompletion(tx, input))))
            .value,
        ).toBe(completed);
      await expect(
        runCommand(db.pool, { ...(await options()), receipt: { ...normal, digest: Buffer.alloc(32, 48) } }, unexpected),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      await expect(runCommand(db.pool, { ...(await options(foreign)), receipt: normal }, unexpected)).rejects.toThrow(
        'Denied current receipt lookup',
      );
      expect(effects).toBe(2);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  assertGrowthAccessPaths('current native receipt neighborhood', report.samples, ['core.receipt']);
  const readerSamples = report.samples.map((sample) => {
    const repetitions = sample.occurrenceRepetitions.map((repetition) => {
      const readers = repetition.statements.filter(
        (occurrence) => occurrence.error === null && /FROM core\.receipt/.test(occurrence.statement),
      );
      // Five successful reader statements; denied Access never reaches receipt lookup.
      expect(readers).toHaveLength(5);
      for (const reader of readers) expect(reader.plans.length).toBeGreaterThan(0);
      return costOf({
        statements: readers.map(({ statement }) => statement),
        plans: readers.flatMap(({ planDocuments }) => planDocuments),
      });
    });
    return { scale: sample.scale, cost: medianCost(repetitions), repetitions };
  });
  expect(growthViolations(readerSamples, { statements: 'constant', rows: 'constant', blocks: 'logarithmic' })).toEqual(
    [],
  );
}, 90_000);

test('native normal and position-zero no-effect writes tokenize foreign private text and retain exact own completion', async () => {
  const ctx = await fixture.context();
  const actor = ctx.actor;
  const target = { route: 0xffd0, id: newId(0xffd0) };
  await fixture.grant(actor.accountId, 'subject:update', target);
  const authorization = await accessCommandAuthorization(
    fixture.access,
    actor,
    'subject:update',
    target,
    { pool: db.pool, deadline: deadline() },
    () => new Error('Denied'),
  );
  const identity = principalCommandIdentity(actor);
  for (const empty of [true, false]) {
    const key = privateKey(empty ? 'no-effect' : 'normal');
    const receipt = { kind: 'test.receipt-cutover', key, digest: createHash('sha256').update(key).digest() };
    const options = { ...identity, partition: partitionOf(target.route), authorization, receipt, deadline: deadline() };
    let effects = 0;
    const execute = () =>
      runCommand(db.pool, options, async () => {
        effects++;
        return empty
          ? noEffect({ answer: 42 })
          : { value: { answer: 42 }, events: [{ type: 'com.rezics.test.happened.v1', data: { n: 42 } }] };
      });
    const first = await execute();
    if (empty) expect(first.position).toBe(0n);
    const row = await stored(first.transactionId, key);
    expect(await execute()).toEqual({ ...first, replayed: true });
    expect(effects).toBe(1);
    const { receipt: _receipt, ...completionOptions } = options;
    expect(
      (await runCommand(db.pool, completionOptions, async (tx) => noEffect(await hasOwnCommandCompletion(tx, receipt))))
        .value,
    ).toBe(true);
    await expect(
      runCommand(db.pool, { ...options, receipt: { ...receipt, digest: Buffer.alloc(32) } }, async () => {
        effects++;
        return noEffect(null);
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    for (const wrong of [
      { kind: receipt.kind + '.other', owner: actor.accountId },
      { kind: receipt.kind, owner: fixture.recipient },
    ]) {
      const candidates = nativeReceiptKeyCandidates(db.pool, wrong.kind, wrong.owner, key);
      expect(
        (
          await db.admin.query(
            `SELECT 1 FROM core.receipt WHERE partition_no=$1 AND principal_kind='account'
        AND principal_id=$2 AND command_kind=$3 AND idempotency_key=ANY($4::text[])`,
            [row.partition_no, wrong.owner, wrong.kind, candidates],
          )
        ).rows,
      ).toEqual([]);
    }
    expect(effects).toBe(1);
  }
});

test('HTTP uses the original caller key for exact replay and conflicting input refuses an effect', async () => {
  const ctx = await fixture.context();
  const kernel = createKernel({
    pool: db.pool,
    routeKey: Buffer.alloc(32, 9),
    requestDeadlineMs: 30_000,
    writeRate: createWriteRateLimiter({ secret: 'receipt-cutover-native-http-rate-secret-32-bytes' }),
    tokens: testTokens(),
    receiptKeys: dedicatedKeys(),
    access: () => fixture.access,
  });
  const key = privateKey('http');
  for (const action of ['access:grant', 'subject:read', 'subject:update'])
    await fixture.grant(ctx.actor.accountId, action, fixture.resource);
  const body = {
    resource: fixture.resource,
    subject: { kind: 'account', id: fixture.recipient },
    actions: ['subject:read'],
    valid: '(,)',
  };
  const request = (input = body) =>
    kernel.handle(
      new Request('http://kernel.test/v1/grants', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ctx.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(key),
        },
        body: JSON.stringify(input),
      }),
    );
  const first = await request();
  expect(first.status).toBe(201);
  const value = await first.json();
  const count = async () => (await db.admin.query('SELECT count(*)::int AS n FROM core.receipt')).rows[0].n;
  const before = await count();
  const replay = await request();
  expect(replay.status).toBe(first.status);
  expect(await replay.json()).toEqual(value);
  const conflict = await request({ ...body, actions: ['subject:update'] });
  expect(conflict.status).toBe(422);
  expect(await conflict.json()).toMatchObject({ code: 'idempotency_conflict', effect_status: 'not_applied' });
  expect(await count()).toBe(before);
  const rows = (
    await db.admin.query(
      `SELECT * FROM core.receipt WHERE principal_kind='account'
    AND principal_id=$1 AND command_kind='access.grant.create'`,
      [ctx.actor.accountId],
    )
  ).rows;
  const token = encodeReceiptKey(
    dedicatedKeys(),
    'access.grant.create',
    { kind: 'account', id: ctx.actor.accountId },
    `${fixture.resource.route}:${key}`,
  );
  expect(rows.some((r) => r.idempotency_key === token)).toBe(true);
  expect(rows.some((r) => r.idempotency_key === key || r.idempotency_key === `${fixture.resource.route}:${key}`)).toBe(
    false,
  );
});

test('Auth barrier proof and automated-account tombstone approval read tokenized receipts', async () => {
  const auth = await nativeFixture(db.pool);
  try {
    const human = await auth.person(`cutover_${randomUUID().replaceAll('-', '')}`);
    await auth.host.service.internal.registerClient({
      clientId: 'cutover-consent',
      firstParty: false,
      scopes: ['account:manage', 'access:grant'],
    });
    await auth.authPool.query(`INSERT INTO auth_consent(account_id,client_id,scopes) VALUES($1,'cutover-consent',$2)`, [
      human.accountId,
      ['account:manage', 'access:grant'],
    ]);
    const reduced = await auth.request(
      '/consent',
      { client_id: 'cutover-consent', scope: ['account:manage'] },
      human.headers,
    );
    expect(reduced.status).toBe(200);
    const proof = (
      await auth.authPool.query(
        `SELECT * FROM auth_barrier_proof WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [human.accountId],
      )
    ).rows[0];
    expect(proof).toBeDefined();
    const fence = (
      await db.admin.query(
        `SELECT * FROM access.lifecycle_fence_receipt WHERE route=$1 AND account_id=$2
      AND minimum_authn_epoch=$3 AND kind='fence'`,
        [routeOf(human.accountId), human.accountId, Number(proof.previous_epoch) + 1],
      )
    ).rows[0];
    expect(fence).toBeDefined();
    const confirmation = {
      accountId: human.accountId,
      purpose: 'consent-reduction' as const,
      operationKey: proof.operation_key,
      minimumAuthnEpoch: Number(proof.previous_epoch) + 1,
      receiptId: fence.receipt_id,
    };
    expect(await auth.bindings.internalLifecycle.confirmBarrier(confirmation)).toBe(true);
    expect(
      await auth.bindings.internalLifecycle.confirmBarrier({ ...confirmation, operationKey: privateKey('foreign') }),
    ).toBe(false);
    const receipt = await stored(fence.transaction_id);
    probe(
      'auth-barrier',
      barrierSQL,
      {
        route: routeOf(human.accountId),
        partition_no: receipt.partition_no,
        service_id: receipt.principal_id,
        receipt_keys: [receipt.idempotency_key],
        account_id: human.accountId,
        receipt_id: fence.receipt_id,
        minimum_authn_epoch: String(confirmation.minimumAuthnEpoch),
      },
      [`${routeOf(human.accountId)}:consent-reduction:${proof.operation_key}`],
    );

    // A fresh human retains all scopes after the first human's genuine consent reduction.
    const manager = await auth.person(`manager_${randomUUID().replaceAll('-', '')}`);
    const bot = await auth.automated(`bot_${randomUUID().replaceAll('-', '')}`, manager);
    const operation = { kind: 'delete' as const, accountId: bot.accountId, authorization: 'request' };
    const approvals = auth.approval();
    const approved = await approvals.approve(
      manager.bearer,
      { operationKey: privateKey('approval'), operation },
      { pool: db.pool, deadline: deadline() },
    );
    const request = await approvals.resolve(approved.reference, operation, { pool: db.pool, deadline: deadline() });
    const binding = workflowApprovalBinding(request)!;
    const key = `${binding.commandKeyPrefix}:tombstone`;
    const lifecycle = createLifecycleCommands({ pool: db.pool, access: auth.access });
    const first = await lifecycle.tombstone(request, { accountId: bot.accountId, key });
    await stored(first.transactionId, `${routeOf(bot.accountId)}:${key}`);
    expect(await lifecycle.tombstone(request, { accountId: bot.accountId, key })).toEqual({ ...first, replayed: true });
    const row = await stored(first.transactionId);
    probe(
      'workflow-approval',
      approvalSQL,
      {
        route: routeOf(bot.accountId),
        account_id: bot.accountId,
        approval_route: routeOf(bot.accountId),
        approval_id: null,
        partition_no: row.partition_no,
        actor_id: manager.accountId,
        idempotency_keys: [row.idempotency_key],
      },
      [`${routeOf(bot.accountId)}:${key}`],
    );
  } finally {
    await auth.close();
  }
}, 90_000);

test('commerce counts exactly its two tokenized numbered outcomes and replays the original order key', async () => {
  const actor = (await fixture.context()).actor;
  await fixture.grant(actor.accountId, 'offer:create', { route: 0, id: GLOBAL_CONTEXT });
  const production = await createProductionAccess({
    actions: ['offer:create', 'offer:read', 'offer:manage', 'order:create', 'access:grant'],
  });
  const buyer = await production.authenticate(db.pool, actor.accountId, [
    'offer:create',
    'offer:read',
    'offer:manage',
    'order:create',
    'access:grant',
  ]);
  const commands = createCommerceCommands({ clock: () => new Date(), pool: db.pool, access: production.access });
  const offer = (
    await commands.createOffer(
      buyer,
      {
        targetSubjectId: newId(0x5500),
        title: 'Receipt cutover',
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      },
      privateKey('offer'),
    )
  ).value;
  const key = privateKey('order');
  const created = await commands.createOrder(buyer, offer.id, offer.revision, key);
  expect(await commands.createOrder(buyer, offer.id, offer.revision, key)).toEqual({ ...created, replayed: true });
  await stored(created.transactionId, key);
  await commands.recordCheckout(created.value.id, { kind: 'unknown' });
  await commands.recordCheckout(created.value.id, {
    session: { id: 'cs_test_cutover', url: 'https://checkout.test', expiresAt: '2030-01-01T00:00:00Z' },
  });
  const before = await commands.readOrderForAccount(actor.accountId, created.value.id);
  expect(before).toMatchObject({ revision: 3, checkoutSessionId: 'cs_test_cutover' });
  await commands.recordCheckout(created.value.id, { kind: 'failed' });
  expect(await commands.readOrderForAccount(actor.accountId, created.value.id)).toEqual(before);
  const raw = [0, 1].map((n) => `order:${created.value.id}:checkout:${n}`);
  const rows = (
    await db.admin.query(
      `SELECT * FROM core.receipt WHERE principal_kind='account' AND principal_id=$1
    AND command_kind='commerce.checkout.record' ORDER BY idempotency_key`,
      [actor.accountId],
    )
  ).rows;
  const expectedTokens = raw.map((k) =>
    encodeReceiptKey(dedicatedKeys(), 'commerce.checkout.record', { kind: 'account', id: actor.accountId }, k),
  );
  const orderedExpectedTokens = await db.admin.query<{ idempotency_key: string }>(
    'SELECT value AS idempotency_key FROM unnest($1::text[]) AS values(value) ORDER BY value',
    [expectedTokens],
  );
  expect(rows.map((r) => r.idempotency_key)).toEqual(orderedExpectedTokens.rows.map((row) => row.idempotency_key));
  probe(
    'checkout-count',
    checkoutSQL,
    {
      partition: partitionOf(routeOf(created.value.id)!),
      buyer: actor.accountId,
      idempotency_keys: raw.flatMap((k) =>
        nativeReceiptKeyCandidates(db.pool, 'commerce.checkout.record', actor.accountId, k),
      ),
    },
    raw,
  );
});

// Native feature fixtures below seed domain state; every completion is produced by a real command.
test('membership continuation restores the original native command through its token', async () => {
  const actor = (await fixture.context()).actor;
  const route = 0xeff0;
  const realmId = newId(route),
    spaceId = newId(route),
    revision = newId(route);
  await withConnection(db.admin, async (tx) => {
    await tx.query('BEGIN');
    try {
      await tx.query(
        `INSERT INTO community.space(route,space_id,state,head_revision_id,creator,created_at)
        VALUES($1,$2,'active',$3,$4,'2026-01-01T00:00:00Z')`,
        [route, spaceId, revision, actor.accountId],
      );
      await tx.query(
        `INSERT INTO community.realm(route,realm_id,space_id,state,visibility,context_id,head_revision_id,creator,created_at)
        VALUES($1,$2,$3,'active','public',$4,$5,$6,'2026-01-01T00:00:00Z')`,
        [route, realmId, spaceId, GLOBAL_CONTEXT, revision, actor.accountId],
      );
      await tx.query(
        `INSERT INTO community.space_revision(route,space_id,revision_id,predecessor,title,summary,author,created_at)
        VALUES($1,$2,$3,NULL,'Receipt host','',$4,'2026-01-01T00:00:00Z')`,
        [route, spaceId, revision, actor.accountId],
      );
      await tx.query(
        `INSERT INTO community.realm_revision(route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,author,created_at)
        VALUES($1,$2,$3,NULL,'Receipt realm','','public',$4,$5,'2026-01-01T00:00:00Z')`,
        [route, realmId, revision, GLOBAL_CONTEXT, actor.accountId],
      );
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
  await fixture.grant(actor.accountId, 'realm:join', { route, id: realmId });
  const deps = { clock: () => new Date(), pool: db.pool, access: fixture.access, tokens: testTokens(), client };
  const input = {
    actor,
    realmId,
    spaceId,
    memberAccountId: actor.accountId,
    idempotencyKey: privateKey('membership'),
    deadline: deadline(),
  };
  const first = await enqueueRealmJoin(deps, input);
  expect(await enqueueRealmJoin(deps, input)).toEqual(first);
  const row = (
    await db.admin.query(`SELECT * FROM community.realm_membership_operation WHERE route=$1 AND realm_id=$2`, [
      route,
      realmId,
    ])
  ).rows[0];
  const receipt = await stored(row.recorded_transaction_id, row.creation_idempotency_key);
  const operation = { route, id: row.operation_id, kind: row.creation_command_kind, sourceId: row.operation_id };
  const record = await withConnection(db.pool, async (tx) =>
    readMembershipInitiator(tx, operation, await mintReadTime(tx)),
  );
  expect(record?.initiatorAccountId).toBe(actor.accountId);
  expect(record?.creation.idempotencyKey).toBe(row.creation_idempotency_key);
  const workflow = await client.getWorkflow(first.workflowId);
  expect(workflow).not.toBeNull();
  const workInput = (workflow!.input as { authorization: string }[])[0]!;
  const membership = createRealmMembership({
    clock: () => new Date(),
    pool: db.pool,
    access: fixture.access,
    referenceKeys: testTokens(),
    restorer: createInitiatorRestorer({
      pool: db.pool,
      access: fixture.access,
      readOperation: readMembershipInitiator,
      readConsent: fixture.readConsent,
    }),
  });
  const reservationId = newId(routeOf(actor.accountId)!);
  const continuation = {
    kind: 'membership' as const,
    authorization: workInput.authorization,
    principal: { kind: 'realm' as const, id: realmId },
    memberAccountId: actor.accountId,
    role: 'member' as const,
  };
  const restored = await membership.authorize(workInput.authorization, continuation);
  const published = await membership.publish(
    restored,
    continuation,
    { accountId: actor.accountId, principal: continuation.principal, reservationId },
    privateKey('membership-publish'),
  );
  expect(published.value).toMatchObject({ realmId, accountId: actor.accountId, reservationId });
  probe(
    'membership',
    membershipSQL,
    {
      partition_no: receipt.partition_no,
      initiator_account_id: actor.accountId,
      creation_command_kind: row.creation_command_kind,
      creation_idempotency_keys: nativeReceiptKeyCandidates(
        db.pool,
        row.creation_command_kind,
        actor.accountId,
        row.creation_idempotency_key,
      ),
    },
    [row.creation_idempotency_key],
  );
});

test('content initiation, enqueue and committed page completion all consume original keys', async () => {
  const actor = (await fixture.context()).actor;
  const route = 0xefd0;
  const threadId = newId(route),
    postId = newId(route),
    revisionId = newId(route),
    boardId = newId(route);
  const body = Buffer.from(serializeDocument(fromPlainText('Private historical text')));
  await withConnection(db.pool, async (tx) => {
    await tx.query('BEGIN');
    try {
      await tx.query(
        `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES($1,$2,$3,$4,'Receipt cutover','published',1,$2)`,
        [route, threadId, actor.accountId, boardId],
      );
      await tx.query(
        `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at)
    VALUES($1,$2,$3,$4,$5,'published',1,$3,'2026-01-01T00:00:00Z')`,
        [route, threadId, postId, actor.accountId, revisionId],
      );
      await tx.query(
        `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
    VALUES($1,$2,$3,$4,$5,sha256($5),'Private historical text','MIT','{}',$6,'available',$3)`,
        [route, threadId, postId, revisionId, body, boardId],
      );
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
  await fixture.grant(actor.accountId, 'post:erase', { route, id: postId });
  await fixture.grant(actor.accountId, 'account:read', { route: routeOf(actor.accountId)!, id: actor.accountId });
  const workflows = createContentOperationClient({ pool: db.pool, client, clock: () => new Date() });
  const deps = { pool: db.pool, access: fixture.access, clock: () => new Date(), workflows };
  const input = { threadId, authorId: actor.accountId };
  const ctx = context();
  const first = await beginAuthorErasure(deps, actor, input, ctx);
  expect(await beginAuthorErasure(deps, actor, input, ctx)).toEqual({ ...first, replayed: true });
  const receipt = await stored(first.transactionId, ctx.idempotencyKey);
  const operationId = first.value.operationId;
  const operation = { route, id: operationId, kind: 'content.author-erasure', sourceId: operationId };
  const restored = await withConnection(db.pool, async (tx) =>
    readErasureInitiator(tx, operation, await mintReadTime(tx)),
  );
  expect(restored?.initiatorAccountId).toBe(actor.accountId);
  let envelope: Envelope | undefined;
  await readBatch(db.pool, {
    consumer: `cutover_${randomUUID().replaceAll('-', '')}`,
    partition: partitionOf(route),
    apply: async (envelopes) => {
      envelope = envelopes.find((entry) => entry.position === first.position);
    },
  });
  expect(envelope).toBeDefined();
  const eventIndex = envelope!.events.findIndex(
    (event) => event.type === 'com.rezics.content.author-erasure.requested.v1',
  );
  const workflowId = await withConnection(db.pool, (tx) =>
    bindAuthorErasureWorkflow(tx, operationId, envelope!, eventIndex),
  );
  const enqueueInput = { ...input, operationId, actor };
  await workflows.enqueue(enqueueInput, context());
  await workflows.enqueue(enqueueInput, context());
  expect((await client.getWorkflow(workflowId))?.input).toBeDefined();
  const row = await withConnection(db.pool, (tx) =>
    readWorkflowErasureOperation(tx, { partition_no: partitionOf(route), route, operation_id: operationId }),
  );
  expect(row?.receipt_transaction_id).toBe(first.transactionId);
  const receiptInput = {
    partition_no: partitionOf(route),
    initiator_account_id: actor.accountId,
    creation_command_kind: 'content.author-erasure',
    creation_idempotency_keys: nativeReceiptKeyCandidates(
      db.pool,
      'content.author-erasure',
      actor.accountId,
      ctx.idempotencyKey,
    ),
  };
  probe('erasure-workflow', workflowSQL, receiptInput, [ctx.idempotencyKey]);
  probe(
    'operation-enqueue',
    enqueueSQL,
    {
      ...receiptInput,
      recorded_transaction_id: first.transactionId,
      creation_request_digest: Buffer.from(receipt.request_digest).toString('hex'),
      operation_id: operationId,
    },
    [ctx.idempotencyKey],
  );
  const pageKey = `wf:${operationId}:erase:-infinity:${operationId}`;
  const initiator = {
    kind: 'durable-initiator' as const,
    operation,
    accountId: actor.accountId,
    clientId: actor.clientId,
    requestedBy: actor.requestedBy,
    restorer: createInitiatorRestorer({
      pool: db.pool,
      access: fixture.access,
      readOperation: readErasureInitiator,
      readConsent: fixture.readConsent,
    }),
  };
  const pageInput = { threadId, postIds: [postId], reason: 'Author erasure' };
  const erased = await erasePostLogicalPageAsInitiator(deps, initiator, pageInput, context(pageKey));
  expect(erased.value).toEqual({ postIds: [postId], processedPosts: 1, erasedRevisions: 1 });
  await stored(erased.transactionId, pageKey);
  const page = await withConnection(db.pool, (tx) =>
    pageAuthorErasurePosts(tx, {
      partition_no: partitionOf(route),
      initiator_id: actor.accountId,
      operation_id: operationId,
      route,
      thread_id: threadId,
      author_id: actor.accountId,
      after_at: '-infinity',
      after_id: operationId,
      upper_at: row!.upper_created_at!,
      upper_id: row!.upper_post_id!,
    }),
  );
  expect(page).toEqual([{ post_id: postId, at: expect.any(String), committed: true, erased_revisions: '1' }]);
  expect(await erasePostLogicalPageAsInitiator(deps, initiator, pageInput, context(pageKey))).toEqual({
    ...erased,
    replayed: true,
  });
  probe(
    'erasure-page',
    pageSQL,
    {
      partition_no: partitionOf(route),
      initiator_id: actor.accountId,
      idempotency_keys: nativeReceiptKeyCandidates(db.pool, 'content.author-erasure.page', actor.accountId, pageKey),
      post_ids: JSON.stringify([postId]),
    },
    [pageKey],
  );
});

test('each of the seven native reader statements has bounded PK work at 64, 512 and 4096 unrelated receipts', async () => {
  expect(probes.map((p) => p.name).sort()).toEqual([
    'auth-barrier',
    'checkout-count',
    'erasure-page',
    'erasure-workflow',
    'membership',
    'operation-enqueue',
    'workflow-approval',
  ]);
  // Two rotations keep the original version. Every reader probes all retained candidates.
  const keys = {
    current: 3,
    keys: new Map([...dedicatedKeys().keys, [2, Buffer.alloc(32, 18)], [3, Buffer.alloc(32, 19)]]),
  };
  configureReceiptKeys(db.pool, keys);
  for (const p of probes) {
    const candidates = Object.entries(p.input).find(([name]) => name.endsWith('keys'))!;
    const owner = String(
      p.input.initiator_account_id ?? p.input.initiator_id ?? p.input.service_id ?? p.input.actor_id ?? p.input.buyer,
    );
    const kind = String(
      p.input.creation_command_kind ??
        (
          {
            'auth-barrier': 'access.authentication-floor-advanced',
            'workflow-approval': 'access.account-tombstoned',
            'checkout-count': 'commerce.checkout.record',
            'erasure-page': 'content.author-erasure.page',
          } as Record<string, string>
        )[p.name],
    );
    p.input[candidates[0]] = p.raw.flatMap((raw) => nativeReceiptKeyCandidates(db.pool, kind, owner, raw));
    const execute = () =>
      withConnection(db.pool, (tx) =>
        tx.query(
          p.statement.sql,
          p.statement.params.map((name) => p.input[name]),
        ),
      );
    const report = await checkGrowth(db, {
      name: `native receipt ${p.name}`,
      scales: [64, 512, 4096],
      bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
      indexProbes: p.name === 'checkout-count' ? 8 : 4,
      async grow(database, scale, previous) {
        // Same namespace and partition defeat a prefix-only receipt plan.
        const row = (await execute()).rows[0];
        expect(row).toBeDefined();
        const owner =
          p.input.initiator_account_id ??
          p.input.initiator_id ??
          p.input.service_id ??
          p.input.actor_id ??
          p.input.buyer;
        const kind =
          p.input.creation_command_kind ??
          (
            {
              'auth-barrier': 'access.authentication-floor-advanced',
              'workflow-approval': 'access.account-tombstoned',
              'checkout-count': 'commerce.checkout.record',
              'erasure-page': 'content.author-erasure.page',
            } as Record<string, string>
          )[p.name];
        await database.admin.query(
          `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,
          request_digest,epoch,position,transaction_id,response)
          SELECT $1,'account',$2,$3,$4||n,$5,1,0,$6,'null'::jsonb FROM generate_series($7::int,$8::int)n`,
          [
            p.input.partition_no ?? p.input.partition,
            owner,
            kind,
            `${p.name}-unrelated-`,
            Buffer.alloc(32),
            randomUUID(),
            previous + 1,
            scale,
          ],
        );
      },
      async operation() {
        expect((await execute()).rows).toHaveLength(1);
      },
    });
    expect(report.samples.map((s) => s.scale)).toEqual([64, 512, 4096]);
    assertGrowthAccessPaths(`native receipt ${p.name}`, report.samples, ['core.receipt']);
    const evidence = (await capture(db, execute)).capture;
    for (const sample of report.samples)
      for (const repetition of sample.occurrenceRepetitions) {
        const readers = repetition.statements.filter(
          (occurrence) => occurrence.error === null && /(?:FROM|JOIN) core\.receipt/i.test(occurrence.statement),
        );
        expect(readers).toHaveLength(1);
        expect(readers[0]!.plans.length).toBeGreaterThan(0);
      }
    const readers = statementOccurrences(evidence).statements.filter(
      (occurrence) =>
        occurrence.error === null && /(?:FROM|JOIN) core\.receipt/i.test(evidence.statements[occurrence.index]!),
    );
    expect(readers).toHaveLength(1);
    const reader = readers[0]!;
    expect(reader.plans.length).toBeGreaterThan(0);
    const plans = reader.plans.map((index) => {
      expect(evidence.planStatements?.[index]).toBe(reader.index);
      return evidence.plans[index]!;
    });
    const cost = costOf({ statements: [evidence.statements[reader.index]!], plans });
    expect(cost.plans).toBeGreaterThan(0);
    expect(cost.relations['core.receipt']?.nodes).toBeGreaterThan(0);
    expect(cost.relations['core.receipt']?.sequentialScans).toBe(0);
    expect(JSON.stringify(plans)).toContain('"Index Name":"receipt_pkey"');
    const wholeOperationCost = costOf(evidence);
    expect(wholeOperationCost.relations['core.receipt']?.sequentialScans).toBe(0);
  }
}, 90_000);

test('production source coverage enumerates all receipt readers and both fences', () => {
  const root = join(import.meta.dir, '../../src');
  const reads: string[] = [],
    writes: string[] = [],
    centralConsumers: string[] = [];
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:ts|sql)$/.test(file)) {
        const source = readFileSync(file, 'utf8');
        if (/\b(?:FROM|JOIN)\s+core\.receipt\b/i.test(source)) reads.push(relative(root, file));
        if (/\bINSERT\s+INTO\s+core\.receipt\b/i.test(source)) writes.push(relative(root, file));
        if (/import .* from ['"].*read-(?:receipt|own-completion)\.sql['"]/.test(source)) {
          centralConsumers.push(relative(root, file));
          expect(source).toMatch(/(?:nativeReceiptKeyCandidates|receiptKeyCandidates)\(/);
        }
      }
    }
  }
  visit(root);
  expect(reads.sort()).toEqual([
    'access/auth-barriers-receipt-read.sql',
    'access/workflow-approvals-tombstone-operator.sql',
    'command/read-own-completion.sql',
    'command/read-receipt.sql',
    'commerce/command-checkout-count.sql',
    'community/membership-operation-receipt.sql',
    'content/read-erasure-page-receipt.sql',
    'content/read-operation-enqueue-receipt.sql',
    'content/read-workflow-erasure-receipt.sql',
  ]);
  expect(centralConsumers.sort()).toEqual([
    'access/approved-identity.ts',
    'access/durable-identity.ts',
    'access/registration-proof.ts',
    'command/command.ts',
    'library/preparation-native-reader.ts',
  ]);
  expect(writes.sort()).toEqual(['command/fence.sql', 'command/no-effect-fence.sql']);
  for (const file of reads) expect(readFileSync(join(root, file), 'utf8')).toContain('ANY(');
  const checkout = readFileSync(join(root, 'commerce/command-checkout-count.sql'), 'utf8');
  expect(checkout).not.toMatch(/\bLIKE\b|\bidempotency_key\s*[<>]/i);
});
