import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { followPagePlan } from '../../src/library/follow-operation-bounds.ts';
import { bindCommandHistoryEvidence } from '../../src/history/application/index.ts';
import { ACCOUNT_ROLE_BITS } from '../../src/history/contract/contracts.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import {
  assertGrowth,
  capture,
  costOf,
  measure,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthSample,
} from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(93);
const scopes = ['follow:create', 'follow:list', 'subject:read'];
const fixtureId = (prefix: string, route: number, ordinal: number) =>
  `${prefix}-0000-7000-8000-${route.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
let database: GrowthDatabase | undefined;
let request: (method: string, path: string) => Promise<Response> = async () => {
  throw new Error('Following growth request is not initialized');
};
let accountId = '';
let route = 0;

afterAll(async () => {
  if (database) {
    await database.admin.query('DELETE FROM library.follow WHERE route = $1 AND account_id = $2', [route, accountId]);
    await database.close();
  }
});

test('FULL kind pages keep a fixed whole-request cost as matching and nonmatching follows grow', async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
  await bootstrapRelease(database.pool, bundledRelease);
  accountId = newId(0x2200);
  route = routeOf(accountId)!;
  const actor: AccountActor = {
    kind: 'account',
    accountId,
    clientId: 'following-kind-growth',
    scopes,
    requestedBy: null,
    authnEpoch: 1,
  };
  await database.admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
       VALUES ($1, $2, 'actor', 'active', $2)`,
    [route, accountId],
  );
  await database.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
       VALUES ('personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
    [randomUUID()],
  );

  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'following-kind-growth', alg: 'ES256' };
  const app = createKernel({
    pool: database.pool,
    writeRate: createWriteRateLimiter({ secret: 'following-kind-growth-write-secret-32b' }),
    ratePeer: () => '127.0.0.1',
    routeKey,
    receiptKeys: testReceiptKeys(),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(18)]]) },
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.example.test',
          audience: 'https://api.rezics.test',
          jwksUrl: 'https://auth.example.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
  });
  const token = await new SignJWT({
    client_id: actor.clientId,
    scope: scopes.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'following-kind-growth', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  request = (method, path) =>
    app.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': 'following-kind-growth',
          'idempotency-key': JSON.stringify(randomUUID()),
        },
      }),
    );

  const subjectKey = randomUUID();
  const subject = await createSubject(database.pool, {
    actor,
    target: subjectTarget(routeKey, accountId, subjectKey),
    idempotencyKey: subjectKey,
    digest: createHash('sha256').update(subjectKey).digest(),
    item: { type: 'schema:Book', labels: { en: subjectKey } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: {
      action: 'subject:create',
      resource: subjectTarget(routeKey, accountId, subjectKey),
      denied: () => new Error('Subject growth fixture authorization failed'),
      async authorize(tx) {
        bindCommandHistoryEvidence(tx, [
          {
            accountRoute: route,
            accountId,
            roles: ACCOUNT_ROLE_BITS.principal | ACCOUNT_ROLE_BITS.actor | ACCOUNT_ROLE_BITS['acting-human'],
          },
        ]);
        return 'execute';
      },
    },
  });
  expect((await request('PUT', `/v1/follows/${subject.subject.id}`)).status).toBe(200);
  await database.admin.query(
    `INSERT INTO library.follow
         (route, account_id, target_id, target_type, state, reason, created_at, updated_at, transaction_id)
       SELECT $1, $2,
              ($3::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid,
              'subject', 'following', 'explicit', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z',
              ($3::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid
       FROM generate_series(1, 101) AS n`,
    [route, accountId, '40000000'],
  );

  const runSeries = async (kind: 'subject' | 'collection', prefix: string) => {
    let previous = 0;
    const samples: GrowthSample[] = [];
    const maximumSamples: GrowthSample[] = [];
    for (const scale of [64, 512, 4096]) {
      await database!.admin.query(
        `INSERT INTO library.follow
             (route, account_id, target_id, target_type, state, reason, created_at, updated_at, transaction_id)
           SELECT $1, $2,
                  ($5::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid,
                  $4, 'following', 'explicit', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z',
                  ($5::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid
           FROM generate_series($3::int + 1, $6::int) AS n`,
        [route, accountId, previous, kind, prefix, scale],
      );
      await database!.admin.query('ANALYZE library.follow');
      const measured = await measure(database!, async () => {
        const response = await request('GET', '/v1/follows?targetType=subject&limit=20&view=FULL');
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.follows.map((follow: { targetId: string }) => follow.targetId)).toEqual(
          Array.from({ length: 20 }, (_, index) => fixtureId('40000000', route, index + 1)),
        );
        expect(body.next).toEqual(expect.any(String));
        return body;
      });
      samples.push({ scale, cost: measured.cost });
      const maximum = await measure(database!, async () => {
        const response = await request('GET', '/v1/follows?targetType=subject&limit=100');
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.follows).toHaveLength(100);
        expect(body.next).toEqual(expect.any(String));
        return body;
      });
      maximumSamples.push({ scale, cost: maximum.cost });
      const deep = await request(
        'GET',
        `/v1/follows?targetType=subject&limit=100&cursor=${encodeURIComponent(maximum.value.next)}`,
      );
      expect(deep.status).toBe(200);
      const deepBody = await deep.json();
      expect(deepBody.follows[0].targetId).toBe(fixtureId('40000000', route, 101));
      expect(
        deepBody.follows.some((row: { targetId: string }) =>
          maximum.value.follows.some((first: { targetId: string }) => first.targetId === row.targetId),
        ),
      ).toBe(false);
      previous = scale;
    }
    assertGrowth(samples, { rows: 'constant', blocks: 'logarithmic', statements: 'constant' });
    assertGrowth(maximumSamples, { rows: 'constant', blocks: 'logarithmic', statements: 'constant' });
    await database!.admin.query(
      'DELETE FROM library.follow WHERE route = $1 AND account_id = $2 AND target_id::text LIKE $3',
      [route, accountId, `${prefix}-%`],
    );
  };

  await runSeries('subject', '50000000');
  await runSeries('collection', '60000000');

  const unrelatedAccount = newId(route);
  await database.admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
     VALUES ($1, $2, 'actor', 'active', $2)`,
    [route, unrelatedAccount],
  );
  const foreignFollowSamples: Record<string, GrowthSample[]> = { first: [], deep: [], empty: [], denied: [] };
  const sharedHistorySamples: Record<string, GrowthSample[]> = { first: [], deep: [], empty: [], denied: [] };
  const restrictedToken = await new SignJWT({
    client_id: actor.clientId,
    scope: scopes.filter((scope) => scope !== 'follow:list').join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'following-kind-growth', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  const revisionResult = Bun.spawnSync(['git', 'rev-parse', 'HEAD']);
  const revision = revisionResult.exitCode === 0 ? revisionResult.stdout.toString().trim() : 'unknown';
  const seed =
    '40000000:fixed-selected-subject;50000000:unrelated-followers;71000000:receipt;72000000:outbox;73000000:write-basis';
  const fixedSelectedIds = Array.from({ length: 20 }, (_, index) => fixtureId('40000000', route, index + 1));

  const seedForeignFollows = async (previous: number, scale: number) => {
    await database!.admin.query(
      `INSERT INTO library.follow
         (route, account_id, target_id, target_type, state, reason, created_at, updated_at, transaction_id)
       SELECT $1, $2,
              ($3::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid,
              'subject', 'following', 'explicit', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z',
              ($4::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid
       FROM generate_series($5::int + 1, $6::int) AS n`,
      [route, unrelatedAccount, '50000000', '51000000', previous, scale],
    );
  };
  const seedSharedHistory = async (previous: number, scale: number) => {
    await database!.admin.query(
      `INSERT INTO core.receipt
         (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
          epoch, position, transaction_id, response)
       SELECT $1 >> 4, 'account', $2, 'library.follow.growth.seed',
              'following-growth-' || n::text, decode(repeat('00', 32), 'hex'),
              1, 3000000000::bigint + n,
              ($3::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid,
              '{}'::jsonb
       FROM generate_series($4::int + 1, $5::int) AS n`,
      [route, unrelatedAccount, '71000000', previous, scale],
    );
    await database!.admin.query(
      `INSERT INTO core.outbox
         (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       SELECT $1 >> 4, 3100000000::bigint + n, 0, 1, 1,
              ($3::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid,
              'com.rezics.library.follow.updated.v1', $2::text, '{}'::jsonb
       FROM generate_series($4::int + 1, $5::int) AS n`,
      [route, unrelatedAccount, '72000000', previous, scale],
    );
    await database!.admin.query(
      `INSERT INTO editorial.write_basis
         (partition_no, transaction_id, epoch, position, principal_kind, principal_id, client_id, requested_by)
       SELECT $1 >> 4,
              ($3::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid,
              1, 3200000000::bigint + n, 'account', $2, 'following-kind-growth', NULL
       FROM generate_series($4::int + 1, $5::int) AS n`,
      [route, unrelatedAccount, '73000000', previous, scale],
    );
  };
  const requestAs = (path: string, authToken: string) =>
    app.handle(
      new Request('http://kernel.test' + path, {
        method: 'GET',
        headers: {
          authorization: 'Bearer ' + authToken,
          'x-request-id': 'following-kind-growth',
          'idempotency-key': JSON.stringify(randomUUID()),
        },
      }),
    );
  const measurePath = async (
    scale: number,
    samples: GrowthSample[],
    path: string,
    kind: 'first' | 'deep' | 'empty' | 'denied',
    expectedLength: number,
    authToken = token,
  ) => {
    const measured = await capture(database!, async () => {
      const response = await requestAs(path, authToken);
      return { status: response.status, body: await response.json() };
    });
    const cost = costOf(measured.capture);
    expect(measured.value.status).toBe(kind === 'denied' ? 403 : 200);
    if (kind === 'denied') expect(measured.value.body.code).toBe('forbidden');
    else expect(measured.value.body.follows).toHaveLength(expectedLength);
    const pageSql = measured.capture.statements.filter((statement) =>
      /FROM library\.follow AS follow/i.test(statement),
    );
    const pageStatementIndexes = measured.capture.statements.flatMap((statement, index) =>
      /FROM library\.follow AS follow/i.test(statement) ? [index] : [],
    );
    expect(pageSql).toHaveLength(kind === 'denied' ? 0 : 1);
    const selectedRelation = cost.relations['library.follow'];
    if (kind !== 'denied') {
      expect(selectedRelation).toBeDefined();
      expect(selectedRelation!.sequentialScans).toBe(0);
      expect(selectedRelation!.rows).toBeLessThanOrEqual(kind === 'deep' ? 192 : 108);
    }
    samples.push({ scale, cost });
    const pagePlans = measured.capture.plans.filter((_, index) =>
      pageStatementIndexes.includes(measured.capture.planStatements?.[index] ?? -1),
    );
    const planSummary = pagePlans.map((document) => {
      const root = (document as Record<string, unknown>)['Plan'] as Record<string, unknown> | undefined;
      return {
        node: root?.['Node Type'],
        actualRows: root?.['Actual Rows'],
        sharedHitBlocks: root?.['Shared Hit Blocks'],
        sharedReadBlocks: root?.['Shared Read Blocks'],
      };
    });
    const nativePlan =
      kind === 'denied'
        ? null
        : followPagePlan({
            route,
            account_id: accountId,
            target_type: kind === 'empty' ? 'space' : 'subject',
            has_target_type: true,
            after_updated_at: kind === 'deep' ? '2099-01-01T00:00:00.000Z' : '2026-01-01T00:00:00.000Z',
            after_target_id:
              kind === 'deep' ? fixtureId('40000000', route, 100) : '00000000-0000-0000-0000-000000000000',
            has_cursor: kind === 'deep',
            limit: 21,
          });
    console.info(
      'following-kind-growth-evidence: ' +
        JSON.stringify({
          revision,
          seed,
          scale,
          kind,
          request: path.replace(/cursor=[^&]+/, 'cursor=[sealed]'),
          status: measured.value.status,
          resultCount: measured.value.body.follows?.length ?? 0,
          targetIds: measured.value.body.follows?.slice(0, 2).map((follow: { targetId: string }) => follow.targetId),
          hasNext: typeof measured.value.body.next === 'string',
          sql: pageSql,
          binds: nativePlan?.operands,
          derived: nativePlan?.total,
          plans: pagePlans,
          planSummary,
          nativeRows: cost.rows,
          relationRows: selectedRelation?.rows ?? 0,
          buffers: { hit: cost.sharedHit, read: cost.sharedRead },
          statements: cost.statements,
          requestBytes: measured.capture.requestBytes,
          responseBytes: measured.capture.responseBytes,
        }),
    );
    return measured.value.body;
  };
  const runFixedNeighborhood = async (
    scale: number,
    previous: number,
    axis: 'foreign-follows' | 'shared-history',
    samples: Record<string, GrowthSample[]>,
  ) => {
    if (axis === 'foreign-follows') await seedForeignFollows(previous, scale);
    else await seedSharedHistory(previous, scale);
    await database!.admin.query('ANALYZE library.follow');
    await database!.admin.query('ANALYZE core.receipt');
    await database!.admin.query('ANALYZE core.outbox');
    await database!.admin.query('ANALYZE editorial.write_basis');
    const firstPath = '/v1/follows?targetType=subject&limit=20&view=FULL';
    const first = await measurePath(scale, samples.first!, firstPath, 'first', 20);
    expect(first.follows.map((follow: { targetId: string }) => follow.targetId)).toEqual(fixedSelectedIds);
    expect(first.next).toEqual(expect.any(String));

    const maximumResponse = await request('GET', '/v1/follows?targetType=subject&limit=100');
    const maximum = await maximumResponse.json();
    expect(maximumResponse.status).toBe(200);
    expect(maximum.follows).toHaveLength(100);
    expect(maximum.next).toEqual(expect.any(String));
    const deepPath = '/v1/follows?targetType=subject&limit=20&view=FULL&cursor=' + encodeURIComponent(maximum.next);
    const deep = await measurePath(scale, samples.deep!, deepPath, 'deep', 2);
    expect(deep.follows.map((follow: { targetId: string }) => follow.targetId)).toEqual([
      fixtureId('40000000', route, 101),
      subject.subject.id,
    ]);
    expect(deep.next).toBeNull();
    const empty = await measurePath(
      scale,
      samples.empty!,
      '/v1/follows?targetType=space&limit=20&view=FULL',
      'empty',
      0,
    );
    expect(empty).toEqual({ follows: [], next: null });
    const denied = await measurePath(scale, samples.denied!, firstPath, 'denied', 0, restrictedToken);
    expect(denied.code).toBe('forbidden');
  };
  let previous = 0;
  for (const scale of [64, 512, 4096]) {
    await runFixedNeighborhood(scale, previous, 'foreign-follows', foreignFollowSamples);
    previous = scale;
  }
  previous = 0;
  for (const scale of [64, 512, 4096]) {
    await runFixedNeighborhood(scale, previous, 'shared-history', sharedHistorySamples);
    previous = scale;
  }
  const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
  for (const samples of [foreignFollowSamples, sharedHistorySamples]) {
    for (const path of Object.values(samples)) {
      assertGrowth(path, bounds);
      for (const metric of ['requestBytes', 'responseBytes'] as const) {
        const values = path.map(({ cost }) => cost[metric]).filter((value): value is number => value !== undefined);
        if (values.length === path.length) expect(new Set(values).size).toBe(1);
      }
    }
  }
  const selected = await database.admin.query(
    `SELECT count(*)::int AS count FROM library.follow
     WHERE route = $1 AND account_id = $2 AND target_type = 'subject' AND state = 'following'`,
    [route, accountId],
  );
  expect(selected.rows[0]?.count).toBe(102);
  const firstPlan = followPagePlan({
    route,
    account_id: accountId,
    target_type: 'subject',
    has_target_type: true,
    after_updated_at: '2026-01-01T00:00:00.000Z',
    after_target_id: '00000000-0000-0000-0000-000000000000',
    has_cursor: false,
    limit: 21,
  });
  const deepPlan = followPagePlan({
    route,
    account_id: accountId,
    target_type: 'subject',
    has_target_type: true,
    after_updated_at: '2099-01-01T00:00:00.000Z',
    after_target_id: fixtureId('40000000', route, 100),
    has_cursor: true,
    limit: 21,
  });
  expect(firstPlan.total.nativeRows).toBe(108);
  expect(firstPlan.total.candidateKeys).toBe(21);
  expect(deepPlan.total.nativeRows).toBe(192);
  expect(deepPlan.total.candidateKeys).toBe(42);
}, 300_000);
