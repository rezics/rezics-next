import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createAuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { applyReportEffect } from '../../src/content/report-effect.ts';
import { createTurnstileVerifier } from '../../src/content/turnstile.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { isProblemSchema, openApiDocument } from '../../src/http/openapi.ts';
import { ProblemError, problemResponse } from '../../src/http/problem.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { createAuthDatabase } from '../support/auth-database.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { seedReportGrowth, type ReportGrowthBoard, type ReportGrowthRow } from './support/report-growth.ts';

const routeKey = new Uint8Array(32).fill(47);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(48)]]) };
const secret = 'report-http-test-budget-secret-at-least-32-bytes';
const reportEvent = 'com.rezics.content.report.created.v1';
const paths = ['/v1/reports/{id}', ...['boards', 'threads', 'posts'].map((kind) => `/v1/${kind}/{id}/reports`)];

// This emulates remote Siteverify transport. Only opaque, one-use provider tokens
// succeed; JSON booleans never enter the trusted verifier contract.
function provider() {
  const issued = new Set<string>();
  let calls = 0;
  const verifier = createTurnstileVerifier({
    secret: 'provider-test-secret',
    hostname: 'kernel.test',
    action: 'report',
    fetch: async (url, init) => {
      calls++;
      expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('secret')).toBe('provider-test-secret');
      expect(init?.signal).toBeDefined();
      const token = form.get('response')!;
      if (token === 'provider-unavailable') return new Response('', { status: 503 });
      return Response.json({ success: issued.delete(token), hostname: 'kernel.test', action: 'report' });
    },
  });
  return {
    verifier,
    get calls() {
      return calls;
    },
    mint() {
      const token = randomUUID();
      issued.add(token);
      return token;
    },
  };
}

const contractPool = new Pool({ connectionString: 'postgres://kernel.invalid/reports-contract' });
afterAll(() => contractPool.end());

test('report routes publish closed schemas, shared report cost, actions and problem responses', () => {
  const app = createKernel({ pool: contractPool, routeKey, tokens });
  const document = openApiDocument(app);
  const post = document.paths['/v1/reports']?.post;
  expect(post).toBeDefined();
  expect(post?.['x-action']).toBe('report:create');
  expect(post?.['x-rate-limit']).toEqual({ family: 'report', units: 1 });
  expect(post?.security).toEqual([{ bearerAuth: [] }, {}]);
  expect(actionCatalogue(app).get('report:create')?.anonymous).toBe(true);
  const body = post?.requestBody?.content?.['application/json']?.schema;
  expect(body).toMatchObject({ additionalProperties: false });
  expect(JSON.stringify(body)).toContain('botToken');
  expect(JSON.stringify(body)).not.toContain('verified');
  for (const code of [400, 401, 403, 404, 413, 422, 429, 500, 503])
    expect(
      isProblemSchema(
        post?.responses?.[code]?.content?.['application/problem+json']?.schema,
        document.components.schemas,
      ),
    ).toBe(true);
  for (const path of paths) {
    const get = document.paths[path]?.get;
    expect(get).toBeDefined();
    expect(get?.['x-action']).toBe('moderation:read_reports');
    expect(get?.['x-rate-limit']).toBeUndefined();
    expect(get?.security).toEqual([{ bearerAuth: [] }]);
    expect(
      isProblemSchema(
        get?.responses?.[404]?.content?.['application/problem+json']?.schema,
        document.components.schemas,
      ),
    ).toBe(true);
  }
});

test('read_reports problems are read effects regardless of method', async () => {
  for (const method of ['GET', 'POST']) {
    const response = problemResponse(new ProblemError('not_found'), {
      method,
      id: randomUUID(),
      action: 'moderation:read_reports',
    });
    expect(await response.json()).toMatchObject({ effect_status: 'not_applicable', code: 'not_found' });
  }
});

describe('real migrated report HTTP and shared admission', () => {
  let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
  let authPool: Pool;
  let auth: Awaited<ReturnType<typeof createAuthService>>;
  let app: ReturnType<typeof createKernel>;
  let noVerifier: ReturnType<typeof createKernel>;
  const remote = provider();
  let author = newId(0x1234);
  let moderator = newId(0x2345);
  let other = newId(0x3456);
  let board = newId(0x4567);
  let secondBoard = newId(0x789a);
  let grantor = newId(0x3467);
  let peer = 0;
  const roleRanges = new Map<string, string>();
  const issuer = 'https://report-auth.test';
  const audience = 'https://kernel.test';
  const password = 'report fixture password for native issuance';
  const actions = ['report:create', 'board:read', 'moderation:read_reports', 'access:grant'];
  const authDatabase = `reports_auth_${process.pid}`;
  const approvals = new Set<string>();
  const input = (targetId = board) => ({
    target: { kind: 'board', id: targetId },
    reason: 'spam',
    evidence: 'Report evidence',
  });

  beforeAll(async () => {
    db = await openGrowthDatabase();
    const authUrl = await createAuthDatabase(db.url, authDatabase);
    authPool = new Pool({ connectionString: authUrl });
    const signingKey = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'report-http',
      alg: 'ES256',
    };
    auth = await createAuthService({
      database: authPool,
      issuer,
      audience,
      secret: 'report-auth-test-secret-at-least-32-bytes',
      signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
      trustedAccess: trustedAccessPorts({
        async readAccount(id) {
          const row = await readAccount(db.admin, routeOf(id)!, id);
          return (
            row && {
              accountId: row.accountId,
              kind: row.kind,
              state: row.state,
              authnEpoch: Number(row.minimumAuthnEpoch),
              automated: false,
            }
          );
        },
        async authorizeProvisioning(reference) {
          if (!approvals.delete(reference)) throw new Error('Missing fixture provisioning approval');
          return { accountId: reference };
        },
      }),
    });
    await auth.internal.registerClient({ clientId: 'web', firstParty: true, scopes: actions });
    const access = (config: Parameters<typeof createAccess>[0]) =>
      createAccess({
        ...config,
        resourceRoles: { roles: { 'report.moderator': ['moderation:read_reports'] }, types: {} },
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async (url, init) => auth.handler(new Request(url, init)),
        },
      });
    const dependencies = {
      pool: db.pool,
      routeKey,
      tokens,
      access,
      writeRate: createWriteRateLimiter({ secret }),
      // Distinct trusted network fixtures keep unrelated scenarios and seed
      // requests within native budgets without changing product limits.
      ratePeer: () => `2001:db8:${(++peer).toString(16)}::1`,
    };
    app = createKernel({ ...dependencies, reports: { anonymousVerifier: remote.verifier } });
    noVerifier = createKernel(dependencies);
  });
  beforeEach(async () => {
    author = newId(0x1234);
    moderator = newId(0x2345);
    other = newId(0x3456);
    grantor = newId(0x3467);
    board = newId(0x4567);
    secondBoard = newId(0x789a);
    roleRanges.clear();
    for (const id of [author, moderator, other, grantor]) {
      approvals.add(id);
      await db.admin.query(
        "INSERT INTO access.account (route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','pending',$2)",
        [routeOf(id), id],
      );
      await auth.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
      await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
        routeOf(id),
        id,
      ]);
    }
    for (const id of [board, secondBoard]) {
      await db.admin.query(
        `INSERT INTO content.board (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,'Report board','published',1,$4)`,
        [routeOf(id), id, newId(0x5678), randomUUID()],
      );
      // Only privileged setup rows grant the fixture grantor standing. Later
      // grants and revocations go through the mounted production routes.
      await db.admin.query(
        `INSERT INTO access.resource_grant
           (route,resource_id,subject_kind,subject_id,subject_role,action,valid,transaction_id)
         SELECT $1,$2,'identity',$3,'',action,'(,)'::tstzrange,$4
         FROM unnest($5::text[]) AS action`,
        [routeOf(id), id, grantor, randomUUID(), ['access:grant', 'report:create', 'moderation:read_reports']],
      );
    }
  });
  afterAll(async () => {
    await authPool?.end();
    if (db) {
      await dropTestDatabase(db.admin, authDatabase);
      await db.close();
    }
  });

  async function issue(id: string, scopes = actions) {
    const signed = await auth.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: id, password, client_id: 'web', scope: scopes }),
      }),
    );
    expect(signed.status).toBe(200);
    const cookie = signed.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const issued = await auth.handler(
      new Request(`${issuer}/token`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: '{}',
      }),
    );
    expect(issued.status).toBe(200);
    return ((await issued.json()) as { access_token: string }).access_token;
  }
  async function call(
    method: string,
    path: string,
    body?: unknown,
    options: { key?: string | null; bearer?: string; kernel?: typeof app } = {},
  ) {
    const response = await (options.kernel ?? app).handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                ...(options.key === null ? {} : { 'idempotency-key': JSON.stringify(options.key ?? randomUUID()) }),
              }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { response, body: await response.json() };
  }
  async function effects() {
    // Administrative inspection is outside measured production operations.
    // Mounted fixture grants have their own receipts/effects. This snapshot
    // follows the report operation, including the actual private record table.
    return Promise.all(
      [
        { table: 'core.receipt', where: "WHERE command_kind='content.report.create'" },
        { table: 'core.outbox', where: `WHERE type='${reportEvent}'` },
        { table: 'content.report', where: '' },
        { table: 'content.board', where: '' },
      ].map(
        async ({ table, where }) =>
          (await db.admin.query(`SELECT to_jsonb(r) AS row FROM ${table} r ${where} ORDER BY to_jsonb(r)::text`)).rows,
      ),
    );
  }
  async function create(targetId = board, key: string = randomUUID()) {
    const proof = remote.mint();
    const before = remote.calls;
    const result = await call('POST', '/v1/reports', { ...input(targetId), botToken: proof }, { key });
    expect(result.response.status).toBe(201);
    expect(Object.keys(result.body)).toEqual(['reportId']);
    expect(result.response.headers.get('location')).toBe(`/v1/reports/${result.body.reportId}`);
    expect(remote.calls - before).toBe(1);
    expect(JSON.stringify(await effects())).not.toContain(proof);
    return result.body.reportId as string;
  }
  async function permission(path: string, body: unknown) {
    const result = await call('POST', path, body, { bearer: await issue(grantor) });
    if (!result.response.ok)
      throw new Error(`Fixture permission ${path}: ${result.response.status} ${JSON.stringify(result.body)}`);
    return result.body as { grant: { valid: string } };
  }
  async function grant(id: string, action: string, target = board) {
    await permission('/v1/grants', {
      resource: { route: routeOf(target), id: target },
      subject: { kind: 'account', id },
      actions: [action],
      valid: '(,)',
    });
  }
  async function moderation(enabled: boolean, target = board) {
    if (!enabled && !roleRanges.has(target)) return;
    const result = await permission(enabled ? '/v1/roleGrants' : '/v1/roleGrants:revoke', {
      resource: { route: routeOf(target), id: target },
      subject: { kind: 'account', id: moderator },
      role: 'report.moderator',
      valid: enabled ? '(,)' : roleRanges.get(target),
    });
    if (enabled) roleRanges.set(target, result.grant.valid);
    else roleRanges.delete(target);
  }
  async function barrier(reportId: string) {
    const rows = await db.admin.query(
      "SELECT * FROM core.outbox WHERE partition_no=$1 AND type=$2 AND data->>'reportId'=$3 ORDER BY position,event_seq",
      [partitionOf(routeOf(reportId)!), reportEvent, reportId],
    );
    expect(rows.rows).toHaveLength(1);
    for (const row of rows.rows) {
      const event: CloudEvent = {
        specversion: '1.0',
        id: row.id,
        source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
        type: reportEvent,
        subject: row.subject,
        time: row.recorded_at.toISOString(),
        datacontenttype: 'application/json',
        sequence: String(row.position).padStart(19, '0'),
        data: row.data,
      };
      await applyReportEffect(db.pool, event);
      await applyReportEffect(db.pool, event);
    }
  }

  test('anonymous proof missing invalid unavailable and absent verifier fail closed before receipts', async () => {
    const before = await effects();
    const key = randomUUID();
    for (const botToken of [undefined, 'invalid-proof', 'provider-unavailable']) {
      const result = await call('POST', '/v1/reports', { ...input(), ...(botToken ? { botToken } : {}) }, { key });
      expect(result.response.status).toBe(botToken === 'provider-unavailable' ? 503 : 403);
      expect(result.body.effect_status).toBe('not_applied');
      expect(result.body.reportId).toBeUndefined();
      expect(await effects()).toEqual(before);
    }
    const absent = await call(
      'POST',
      '/v1/reports',
      { ...input(), botToken: remote.mint() },
      { key, kernel: noVerifier },
    );
    expect(absent.response.status).toBe(404);
    expect(await effects()).toEqual(before);
    await create(board, key);
  });

  test('spoofed fields, oversized credentials, malformed targets and non-v4 anonymous keys reject without mutation', async () => {
    const before = await effects();
    for (const extra of [
      { verified: true },
      { actor: { kind: 'account', accountId: author } },
      { action: 'report:create' },
      { botToken: 'x'.repeat(2049) },
      { target: { kind: 'account', id: author } },
      { reason: '' },
      { evidence: 'x'.repeat(8193) },
    ]) {
      const result = await call('POST', '/v1/reports', { ...input(), botToken: remote.mint(), ...extra });
      expect(result.response.status).toBe(400);
    }
    for (const key of [null, 'bot-report', newId(0x1234)]) {
      const result = await call('POST', '/v1/reports', { ...input(), botToken: remote.mint() }, { key });
      expect(result.response.status).toBe(400);
    }
    expect(await effects()).toEqual(before);
  });

  test('fresh-proof case-normalized UUIDv4 replay has one record and effect; semantic changes conflict', async () => {
    const key = randomUUID();
    const id = await create(board, key.toUpperCase());
    const before = await effects();
    expect(await create(board, key)).toBe(id);
    expect(await effects()).toEqual(before);
    for (const change of [
      { reason: 'other' },
      { evidence: 'Different evidence' },
      { target: { kind: 'board', id: secondBoard } },
    ]) {
      const result = await call('POST', '/v1/reports', { ...input(), ...change, botToken: remote.mint() }, { key });
      expect(result.response.status).toBe(422);
      expect(result.body).toMatchObject({ code: 'idempotency_conflict', effect_status: 'not_applied' });
      expect(JSON.stringify(result.body)).not.toContain(id);
    }
    expect(await effects()).toEqual(before);
    await barrier(id);
  });

  test('revoked target public eligibility denies anonymous replay without stored report disclosure', async () => {
    const key = randomUUID();
    const id = await create(board, key);
    await db.admin.query(
      "UPDATE content.board SET visibility='protected',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
      [routeOf(board), board],
    );
    try {
      const before = await effects();
      const result = await call('POST', '/v1/reports', { ...input(), botToken: remote.mint() }, { key });
      expect(result.response.status).toBe(404);
      expect(result.body.code).toBe('not_found');
      expect(JSON.stringify(result.body)).not.toContain(id);
      expect(JSON.stringify(result.body)).not.toContain(input().evidence);
      expect(await effects()).toEqual(before);
    } finally {
      await db.admin.query(
        "UPDATE content.board SET visibility='published',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
        [routeOf(board), board],
      );
    }
  });

  test('account requires independent grant and scope without proof; invalid bearer never becomes anonymous', async () => {
    const before = await effects();
    const full = await issue(author);
    const denied = await call('POST', '/v1/reports', input(), { bearer: full, key: 'ordinary-account-key' });
    expect([403, 404]).toContain(denied.response.status);
    await grant(author, 'report:create');
    const noScope = await call('POST', '/v1/reports', input(), {
      bearer: await issue(author, ['board:read']),
      key: 'ordinary-account-key',
    });
    expect([403, 404]).toContain(noScope.response.status);
    const invalid = await call(
      'POST',
      '/v1/reports',
      { ...input(), botToken: remote.mint() },
      { bearer: 'invalid-token' },
    );
    expect(invalid.response.status).toBe(401);
    expect(invalid.body.code).toBe('invalid_credentials');
    expect(await effects()).toEqual(before);
    const calls = remote.calls;
    const positive = await call('POST', '/v1/reports', input(), { bearer: full, key: 'ordinary-account-key' });
    expect(positive.response.status).toBe(201);
    expect(remote.calls).toBe(calls);
  });

  test('report family exhaustion returns shared 429 without a second charge or command effects', async () => {
    const limited = createKernel({
      pool: db.pool,
      routeKey,
      tokens,
      reports: { anonymousVerifier: remote.verifier },
      ratePeer: () => '198.51.100.147',
      writeRate: createWriteRateLimiter({
        secret,
        overrides: JSON.stringify({
          anonymous: { report: { maximum: 1, seconds: 86400 }, write: { maximum: 1, seconds: 86400 } },
        }),
      }),
    });
    const first = await call('POST', '/v1/reports', { ...input(), botToken: remote.mint() }, { kernel: limited });
    expect(first.response.status).toBe(201);
    const before = await effects();
    const calls = remote.calls;
    const second = await call('POST', '/v1/reports', { ...input(), botToken: remote.mint() }, { kernel: limited });
    expect(second.response.status).toBe(429);
    expect(second.response.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
    expect(second.body).toMatchObject({ code: 'rate_limited', effect_status: 'not_applied' });
    expect(await effects()).toEqual(before);
    expect(remote.calls).toBe(calls);
  });

  test('private inspection uses current moderator role, independently anchored reverse fill, and signed bounded pages', async () => {
    const id = await create();
    const otherId = await create(secondBoard);
    await barrier(id);
    await barrier(otherId);
    await moderation(true);
    await moderation(true, secondBoard);
    const bearer = await issue(moderator);
    const read = await call('GET', `/v1/reports/${id}`, undefined, { bearer });
    expect(read.response.status).toBe(200);
    expect(read.body.report).toMatchObject({ id, target: input().target, reason: input().reason });
    expect(partitionOf(routeOf(id)!)).not.toBe(partitionOf(routeOf(board)!));
    const page = await call('GET', `/v1/boards/${board}/reports?limit=1`, undefined, { bearer });
    expect(page.response.status).toBe(200);
    expect(page.body.reports).toHaveLength(1);
    expect(page.body.reports[0].target).toEqual(input().target);
    expect(page.body.reports.map((report: { id: string }) => report.id)).not.toContain(otherId);
    expect(page.body.next === null || typeof page.body.next === 'string').toBe(true);
    const invalidCursor = await call(
      'GET',
      `/v1/boards/${board}/reports?cursor=${encodeURIComponent(JSON.stringify({ id }))}`,
      undefined,
      { bearer },
    );
    expect(invalidCursor.response.status).toBe(400);
    expect((await call('GET', `/v1/boards/${board}/reports?limit=101`, undefined, { bearer })).response.status).toBe(
      400,
    );
    await moderation(false);
    for (const credential of [bearer, await issue(author), await issue(other), undefined]) {
      for (const path of [`/v1/reports/${id}`, `/v1/reports/${newId(0xabcd)}`, `/v1/boards/${board}/reports`]) {
        const denied = await call('GET', path, undefined, { ...(credential ? { bearer: credential } : {}) });
        expect(denied.response.status).toBe(404);
        expect(denied.body).toMatchObject({ code: 'not_found', effect_status: 'not_applicable' });
        expect(JSON.stringify(denied.body)).not.toContain(input().evidence);
        expect(JSON.stringify(denied.body)).not.toContain(id);
      }
    }
  });

  test('checkGrowth proves constant report HTTP work with unrelated and hot-partition growth at three scales', async () => {
    const report = await checkGrowth(db, {
      // Verification itself uses no SQL. The stored HTTP create probes the board PK,
      // inserts one report and adds C (receipt, partition, write basis and outbox).
      // At fixed admitted input this is constant rows/statements and logarithmic indexed blocks.
      name: 'report HTTP admission and create',
      scales: [32, 256, 2048],
      rule: 'series',
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      warmups: 5,
      async grow(database, scale, previous) {
        // At 64 rows per scale unit, board/report/command indexes start with 2,048 rows.
        // Setup is unmeasured. Half the targets share the real target's route.
        const rows: ReportGrowthRow[] = [];
        const distractorBoards: ReportGrowthBoard[] = [];
        for (let ordinal = previous * 64; ordinal < scale * 64; ordinal++) {
          const route = ordinal % 2 ? routeOf(board)! : (ordinal * 31) % 65536;
          const id = newId(route);
          distractorBoards.push({ id, route, subjectId: newId(0x5678), transactionId: randomUUID() });
          const reportRoute = (ordinal * 31) % 65536;
          rows.push({
            reportId: newId(reportRoute),
            reportRoute,
            targetKind: 'board',
            targetId: id,
            targetRoute: route,
            createdAt: '2026-01-01T00:00:00.000Z',
            transactionId: randomUUID(),
            idempotencyKey: randomUUID(),
          });
        }
        await seedReportGrowth(database.admin, rows, distractorBoards, {
          projectTargets: false,
          commandEvents: { principalId: '00000000-0000-0000-0000-000000000000', principalKind: 'anonymous' },
        });
      },
      async operation(database, _scale, repetition) {
        expect(database.pool).toBe(db.pool);
        const proof = remote.mint();
        const result = await call(
          'POST',
          '/v1/reports',
          { ...input(), botToken: proof },
          { key: `00000000-0000-4000-8000-${String(repetition + 1).padStart(12, '0')}` },
        );
        expect(result.response.status).toBe(201);
        expect(JSON.stringify(await effects())).not.toContain(proof);
      },
    });
    expect(report.rule).toBe('series');
    expect(report.samples).toHaveLength(3);
    for (const sample of report.samples) {
      expect(sample.cost.rows).toBeGreaterThan(0);
      expect(sample.cost.statements).toBeGreaterThan(0);
    }
    console.info(JSON.stringify(report));
  }, 180_000);
});
