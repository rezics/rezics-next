import { suspendAccount } from '../support/native-suspension-driver.ts';
import { createAccess } from '../../src/access/index.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { type Access } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject as createSemanticSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const issuer = 'https://auth.progress.test';
const audience = 'https://kernel.progress.test';
const accountRoute = 0x2600;
const owner = newId(accountRoute);
const other = newId(accountRoute);
const suspended = newId(accountRoute);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(19)]]) };
const scopes = [
  'subject:create',
  'subject:read',
  'progress_session:create',
  'progress_session:list',
  'progress_session:read',
  'progress_session:update',
  'published_log:create',
  'published_log:read',
  'published_log:delete',
];
const credentials = new Map<string, string>();
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let serial = 0;

const key = () => JSON.stringify(`progress-http-${++serial}`);

async function request(
  as: 'owner' | 'other' | 'suspended' | 'anonymous',
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  requestKey?: string,
) {
  const headers: Record<string, string> = {};
  const account = as === 'owner' ? owner : as === 'other' ? other : as === 'suspended' ? suspended : null;
  if (account) headers.authorization = `Bearer ${credentials.get(account)!}`;
  if (method !== 'GET') headers['idempotency-key'] = requestKey ?? key();
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await app.handle(
    new Request(`https://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

async function createSubject(): Promise<string> {
  const requestKey = randomUUID();
  const created = await createSemanticSubject(db.pool, {
    actor: {
      kind: 'account',
      accountId: owner,
      clientId: 'web',
      scopes,
      requestedBy: null,
      authnEpoch: 1,
    },
    target: subjectTarget(new Uint8Array(32).fill(23), owner, requestKey),
    idempotencyKey: requestKey,
    digest: createHash('sha256').update(requestKey).digest(),
    item: { type: 'schema:Book', labels: { en: `Progress subject ${serial}` } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return created.subject.id;
}

async function start(subjectId: string, mode: string, unit: string, extras: Record<string, unknown> = {}) {
  const result = await request('owner', 'POST', '/v1/progressSessions', { subjectId, mode, unit, ...extras });
  expect(result.response.status).toBe(201);
  return result.body.progressSession as Record<string, any>;
}

async function session(id: string) {
  const result = await request('owner', 'GET', `/v1/progressSessions/${id}`);
  expect(result.response.status).toBe(200);
  return result.body.progressSession as Record<string, any>;
}

async function authoritativeProgressRows() {
  const result = await db.admin.query<{ kind: string; row: Record<string, unknown> }>(
    `SELECT kind, row FROM (
       SELECT 'session' AS kind, to_jsonb(session) AS row FROM library.progress_session session
       UNION ALL
       SELECT 'unit', to_jsonb(unit) FROM library.progress_unit unit
       UNION ALL
       SELECT 'change', to_jsonb(change) FROM library.progress_change change
     ) AS rows
     ORDER BY kind, row::text`,
  );
  return result.rows;
}

async function progressPage<T>(
  path: string,
  plural: string,
  as: 'owner' | 'other' | 'suspended' | 'anonymous' = 'owner',
) {
  const result = await request(as, 'GET', path);
  expect(result.response.status).toBe(200);
  expect(Object.keys(result.body).sort()).toEqual([plural, 'next'].sort());
  expect(Array.isArray(result.body[plural])).toBe(true);
  return result.body[plural] as T[];
}

function stableProblem(body: Record<string, unknown>) {
  const { request_id: _requestId, ...stable } = body;
  return stable;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await bootstrapRelease(db.pool, bundledRelease);

  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'progress-http', alg: 'ES256' };
  const native = createAccess({
    actions: new Map(scopes.map((action) => [action, { anonymous: false }])),
    auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
  });
  const access: Access = deriveAccess(native, {
    async authorize(_client, actor, action) {
      return actor.kind === 'account' && actor.scopes.includes(action);
    },
  });
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(23),
    tokens,
    access,
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
  });

  for (const [accountId, state] of [
    [owner, 'active'],
    [other, 'active'],
    [suspended, 'active'],
  ] as const) {
    await db.admin.query(
      `INSERT INTO access.account(route, account_id, kind, state, transaction_id, membership_inverse_complete)
       VALUES ($1, $2, 'actor', $3, $2, true)`,
      [routeOf(accountId), accountId, state],
    );
  }
  for (const accountId of [owner, other, suspended]) {
    credentials.set(
      accountId,
      await new SignJWT({
        client_id: 'web',
        scope: scopes.join(' '),
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'progress-http', typ: 'at+jwt' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(accountId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signing.privateKey),
    );
  }
  await suspendAccount(db.admin, suspended);
  await db.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     VALUES ('reading_progress', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
    [randomUUID()],
  );
});

afterAll(async () => {
  await db?.close();
});

test('progress HTTP mounts each reading progress operation with its gate exposure', () => {
  const operationIds = [
    'progress_session.create',
    'progress_session.list',
    'progress_session.read',
    'progress_session.record',
    'progress_session.complete',
    'progress_session.abandon',
    'progress_session.units',
    'progress_session.changes',
    'published_log.create',
    'published_log.read',
    'published_log.list',
    'published_log.delete',
  ];
  const added = app.routes.filter((route) => {
    const detail = route.hooks?.detail as Record<string, unknown> | undefined;
    return typeof detail?.operationId === 'string' && operationIds.includes(detail.operationId);
  });
  expect(added).toHaveLength(operationIds.length);
  expect(new Set(added.map((route) => `${route.method} ${route.path}`)).size).toBe(added.length);
  expect(added.map((route) => (route.hooks?.detail as Record<string, unknown>).operationId).sort()).toEqual(
    [...operationIds].sort(),
  );
  for (const route of added) {
    expect((route.hooks?.detail as Record<string, unknown>)['x-exposure']).toBe('gate:reading_progress');
  }

  const document = openApiDocument(app);
  const operations = Object.values(document.paths).flatMap((path) => Object.values(path));
  for (const operation of operations) {
    if (operationIds.includes(operation.operationId as string))
      expect(operation['x-exposure']).toBe('gate:reading_progress');
  }
  expect(operations.filter((operation) => operationIds.includes(operation.operationId as string))).toHaveLength(
    operationIds.length,
  );
});

test('owners start and record every mode, page units and changes, and publish an immutable snapshot', async () => {
  const subjectId = await createSubject();
  const scalar = await start(subjectId, 'scalar_amount', 'minute', { total: '120' });
  const cursor = await start(subjectId, 'cursor_position', 'page');
  let units = await start(subjectId, 'completed_units', 'volume');
  expect((await session(scalar.id)).mode).toBe('scalar_amount');
  expect((await session(cursor.id)).mode).toBe('cursor_position');
  expect((await session(units.id)).mode).toBe('completed_units');

  for (const invalid of [
    { subjectId, unit: 'page' },
    { subjectId, unit: 'page', mode: ['scalar_amount', 'cursor_position'] },
    { subjectId, unit: 'page', mode: 'scalar_amount', unexpected: true },
  ]) {
    const refused = await request('owner', 'POST', '/v1/progressSessions', invalid);
    expect(refused.response.status).toBe(400);
  }

  const beforeMismatch = await session(units.id);
  const mismatch = await request('owner', 'POST', `/v1/progressSessions/${units.id}:record`, {
    revision: units.revision,
    amount: '1',
  });
  expect(mismatch.response.status).toBe(400);
  expect(await session(units.id)).toEqual(beforeMismatch);

  const scalarRecord = await request('owner', 'POST', `/v1/progressSessions/${scalar.id}:record`, {
    revision: scalar.revision,
    amount: '12.5',
  });
  expect(scalarRecord.response.status).toBe(200);
  expect(scalarRecord.body.progressSession).toMatchObject({ amount: '12.5', state: 'active' });
  expect(await session(scalar.id)).toEqual(scalarRecord.body.progressSession);
  const stale = await request('owner', 'POST', `/v1/progressSessions/${scalar.id}:record`, {
    revision: scalar.revision,
    amount: '13',
  });
  expect(stale.response.status).toBe(409);
  expect(await session(scalar.id)).toEqual(scalarRecord.body.progressSession);

  const cursorRecord = await request('owner', 'POST', `/v1/progressSessions/${cursor.id}:record`, {
    revision: cursor.revision,
    locator: 'chapter:three',
    position: '90.5',
  });
  expect(cursorRecord.response.status).toBe(200);
  expect(cursorRecord.body.progressSession).toMatchObject({ locator: 'chapter:three', position: '90.5' });
  expect(await session(cursor.id)).toEqual(cursorRecord.body.progressSession);

  const firstUnits = await request('owner', 'POST', `/v1/progressSessions/${units.id}:record`, {
    revision: units.revision,
    add: ['1', '3', '7'],
  });
  expect(firstUnits.response.status).toBe(200);
  units = firstUnits.body.progressSession;
  expect(units.completedUnitCount).toBe(3);
  expect(
    (await progressPage<string>(`/v1/progressSessions/${units.id}/completedUnits`, 'completedUnits')).sort(),
  ).toEqual(['1', '3', '7']);

  const removeThree = await request('owner', 'POST', `/v1/progressSessions/${units.id}:record`, {
    revision: units.revision,
    remove: ['3'],
  });
  expect(removeThree.response.status).toBe(200);
  units = removeThree.body.progressSession;
  expect(units.completedUnitCount).toBe(2);
  expect(
    (await progressPage<string>(`/v1/progressSessions/${units.id}/completedUnits`, 'completedUnits')).sort(),
  ).toEqual(['1', '7']);
  expect(await session(units.id)).toEqual(units);
  const changes = await progressPage<Record<string, any>>(`/v1/progressSessions/${units.id}/changes`, 'changes');
  expect(changes.map((change) => change.intent)).toEqual([{ add: ['1', '3', '7'] }, { remove: ['3'] }]);
  expect(changes.map((change) => change.revision)).toEqual([2, 3]);
  expect(changes[0]).toMatchObject({ id: expect.any(String), createdAt: expect.any(String) });

  const logResponse = await request('owner', 'POST', '/v1/publishedLogs', {
    sessionId: units.id,
    note: 'A public reading milestone',
  });
  expect(logResponse.response.status).toBe(201);
  const log = logResponse.body.publishedLog;
  expect(structuredClone(log)).toMatchObject({
    id: expect.any(String),
    accountId: owner,
    subjectId,
    sessionState: 'active',
    completedAt: null,
    note: 'A public reading milestone',
    publishedAt: expect.any(String),
  });

  const complete = await request('owner', 'POST', `/v1/progressSessions/${units.id}:complete`, {
    revision: units.revision,
  });
  expect(complete.response.status).toBe(200);
  expect(complete.body.progressSession.state).toBe('completed');
  expect((await request('anonymous', 'GET', `/v1/publishedLogs/${log.id}`)).body).toEqual({ publishedLog: log });
  expect(
    await progressPage<Record<string, any>>(`/v1/publishedLogs?accountId=${owner}`, 'publishedLogs', 'anonymous'),
  ).toEqual([log]);

  const reread = await start(subjectId, 'completed_units', 'volume');
  expect(reread.id).not.toBe(units.id);
  expect((await request('owner', 'GET', `/v1/publishedLogs/${log.id}`)).body).toEqual({ publishedLog: log });

  const toAbandon = await start(subjectId, 'cursor_position', 'page');
  const abandon = await request('owner', 'POST', `/v1/progressSessions/${toAbandon.id}:abandon`, {
    revision: toAbandon.revision,
  });
  expect(abandon.response.status).toBe(200);
  expect(abandon.body.progressSession).toMatchObject({ state: 'abandoned', completedAt: null });
  expect(await session(toAbandon.id)).toEqual(abandon.body.progressSession);

  const sessions = await progressPage<Record<string, any>>(
    `/v1/progressSessions?subjectId=${subjectId}`,
    'progressSessions',
  );
  expect(sessions.map((item) => item.id)).toContain(reread.id);
});

test('owners keep chapter and volume measures independent in one session with revision and replay protection', async () => {
  const subjectId = await createSubject();
  const created = await start(subjectId, 'scalar_amount', 'chapter', {
    total: '24',
    additionalMeasures: [{ unit: 'volume', total: '12' }],
  });
  expect(created.measures).toEqual([
    { unit: 'chapter', amount: null, total: '24' },
    { unit: 'volume', amount: null, total: '12' },
  ]);

  const presented = await request('owner', 'GET', `/v1/progressSessions/${created.id}?presentation=FULL`);
  expect(presented.body.progressSession.measures).toHaveLength(2);
  for (const measure of presented.body.progressSession.measures)
    expect(measure.presentation).toMatchObject({ meaning: 'known', recording: { state: 'supported' } });
  expect((await request('other', 'GET', `/v1/progressSessions/${created.id}`)).response.status).toBe(404);

  const chapter = await request(
    'owner',
    'POST',
    `/v1/progressSessions/${created.id}:record`,
    { revision: 1, measureId: 'chapter', amount: '0' },
  );
  expect(chapter.response.status).toBe(200);
  expect(chapter.body.progressSession.measures).toEqual([
    { unit: 'chapter', amount: '0', total: '24' },
    { unit: 'volume', amount: null, total: '12' },
  ]);
  const staleVolume = await request('owner', 'POST', `/v1/progressSessions/${created.id}:record`, {
    revision: 1,
    measureId: 'volume',
    amount: '3.5',
  });
  expect(staleVolume.response.status).toBe(409);

  const volume = await request('owner', 'POST', `/v1/progressSessions/${created.id}:record`, {
    revision: 2,
    measureId: 'volume',
    amount: '3.5',
  });
  expect(volume.response.status).toBe(200);
  const staleCorrection = await request('owner', 'POST', `/v1/progressSessions/${created.id}:record`, {
    revision: 2,
    measureId: 'chapter',
    amount: '1',
  });
  expect(staleCorrection.response.status).toBe(409);
  const correctionBody = { revision: 3, measureId: 'chapter', amount: '2.5' };
  const corrected = await request('owner', 'POST', `/v1/progressSessions/${created.id}:record`, correctionBody, 'chapter-correction');
  expect(corrected.response.status).toBe(200);
  const replay = await request('owner', 'POST', `/v1/progressSessions/${created.id}:record`, correctionBody, 'chapter-correction');
  expect(replay.body).toEqual(corrected.body);
  const clearedVolume = await request('owner', 'POST', `/v1/progressSessions/${created.id}:record`, {
    revision: 4,
    measureId: 'volume',
    clear: true,
  });
  expect(clearedVolume.body.progressSession.measures).toEqual([
    { unit: 'chapter', amount: '2.5', total: '24' },
    { unit: 'volume', amount: null, total: '12' },
  ]);
  const changes = await progressPage<Record<string, any>>(`/v1/progressSessions/${created.id}/changes`, 'changes');
  expect(changes.map((change) => change.intent)).toEqual([
    { measureId: 'chapter', amount: '0' },
    { measureId: 'volume', amount: '3.5' },
    { measureId: 'chapter', amount: '2.5' },
    { measureId: 'volume', clear: true },
  ]);
  expect(changes.map((change) => change.revision)).toEqual([2, 3, 4, 5]);
  expect(volume.body.progressSession.measures[0].amount).toBe('0');
});

test('hidden private session ids are concealed and suspended writes leave data unchanged', async () => {
  const subjectId = await createSubject();
  const current = await start(subjectId, 'completed_units', 'chapter');
  const unknownId = newId(accountRoute);

  const concealed = await request('other', 'GET', `/v1/progressSessions/${current.id}`);
  const unknown = await request('other', 'GET', `/v1/progressSessions/${unknownId}`);
  const malformed = await request('other', 'GET', '/v1/progressSessions/not-an-id');
  for (const result of [concealed, unknown, malformed]) expect(result.response.status).toBe(404);
  expect(stableProblem(concealed.body)).toEqual(stableProblem(unknown.body));
  expect(stableProblem(malformed.body)).toEqual(stableProblem(unknown.body));

  const anonymous = await request('anonymous', 'GET', `/v1/progressSessions/${current.id}`);
  expect(anonymous.response.status).toBe(404);
  expect(stableProblem(anonymous.body)).toEqual(stableProblem(unknown.body));
  const suspendedRead = await request('suspended', 'GET', `/v1/progressSessions/${current.id}`);
  expect(suspendedRead.response.status).toBe(401);
  expect(stableProblem(suspendedRead.body)).toEqual({
    ...stableProblem(unknown.body),
    status: 401,
    code: 'invalid_credentials',
    title: 'Invalid Credentials',
    type: 'https://rezics.com/problems/invalid_credentials',
  });
  expect(
    await progressPage<Record<string, any>>(`/v1/progressSessions?subjectId=${subjectId}`, 'progressSessions', 'other'),
  ).toEqual([]);
  expect((await request('anonymous', 'GET', `/v1/progressSessions?subjectId=${subjectId}`)).response.status).toBe(401);
  expect((await request('suspended', 'GET', `/v1/progressSessions?subjectId=${subjectId}`)).response.status).toBe(401);

  const logResponse = await request('owner', 'POST', '/v1/publishedLogs', { sessionId: current.id });
  expect(logResponse.response.status).toBe(201);
  const logId = logResponse.body.publishedLog.id as string;
  const otherLog = await request('other', 'GET', `/v1/publishedLogs/${logId}`);
  const anonymousLog = await request('anonymous', 'GET', `/v1/publishedLogs/${logId}`);
  expect(otherLog.body).toEqual(logResponse.body);
  expect(anonymousLog.body).toEqual(logResponse.body);

  const before = await session(current.id);
  const writes: { method: 'POST' | 'DELETE'; path: string; body?: unknown }[] = [
    { method: 'POST', path: '/v1/progressSessions', body: { subjectId, mode: 'completed_units', unit: 'chapter' } },
    {
      method: 'POST',
      path: `/v1/progressSessions/${current.id}:record`,
      body: { revision: current.revision, add: ['1'] },
    },
    { method: 'POST', path: `/v1/progressSessions/${current.id}:complete`, body: { revision: current.revision } },
    { method: 'POST', path: `/v1/progressSessions/${current.id}:abandon`, body: { revision: current.revision } },
    { method: 'POST', path: '/v1/publishedLogs', body: { sessionId: current.id } },
    { method: 'DELETE', path: `/v1/publishedLogs/${logId}` },
  ];
  for (const write of writes) {
    const refused = await request('suspended', write.method, write.path, write.body);
    expect([401, 403]).toContain(refused.response.status);
    expect(await session(current.id)).toEqual(before);
    expect((await request('owner', 'GET', `/v1/publishedLogs/${logId}`)).body).toEqual(logResponse.body);
  }

  const foreignWrite = await request('other', 'POST', `/v1/progressSessions/${current.id}:record`, {
    revision: current.revision,
    add: ['2'],
  });
  expect(foreignWrite.response.status).toBe(404);
  const foreignPublish = await request('other', 'POST', '/v1/publishedLogs', { sessionId: current.id });
  expect(foreignPublish.response.status).toBe(404);
  const foreignRetract = await request('other', 'DELETE', `/v1/publishedLogs/${logId}`);
  expect(foreignRetract.response.status).toBe(404);
  expect(await session(current.id)).toEqual(before);

  const retracted = await request('owner', 'DELETE', `/v1/publishedLogs/${logId}`);
  expect(retracted.response.status).toBe(200);
  const deleted = await request('anonymous', 'GET', `/v1/publishedLogs/${logId}`);
  const absent = await request('anonymous', 'GET', `/v1/publishedLogs/${newId(accountRoute)}`);
  expect(deleted.response.status).toBe(404);
  expect(stableProblem(deleted.body)).toEqual(stableProblem(absent.body));
});

test('record requests and changes pages use equal statements at three data scales', async () => {
  const subjectId = await createSubject();
  const current = await start(subjectId, 'scalar_amount', 'minute');
  const statementCounts: { record: number; changes: number }[] = [];
  let previous = 0;

  for (const scale of [1, 8, 64]) {
    if (scale > previous) {
      await db.admin.query(
        `INSERT INTO library.progress_change(route, session_id, change_no, intent, recorded_at, transaction_id)
         SELECT $1, $2, number, '{"amount":"0"}'::jsonb, now(), gen_random_uuid()
         FROM generate_series($3::integer + 1, $4::integer) AS number`,
        [accountRoute, current.id, previous + 1, scale],
      );
      await db.admin.query('UPDATE library.progress_session SET revision = $3 WHERE route = $1 AND session_id = $2', [
        accountRoute,
        current.id,
        scale,
      ]);
    }
    const recorded = await capture(db, () =>
      request('owner', 'POST', `/v1/progressSessions/${current.id}:record`, {
        revision: scale,
        amount: String(scale),
      }),
    );
    expect(recorded.value.response.status).toBe(200);
    const changes = await capture(db, () =>
      request('owner', 'GET', `/v1/progressSessions/${current.id}/changes?limit=1`),
    );
    expect(changes.value.response.status).toBe(200);
    statementCounts.push({ record: recorded.capture.statements.length, changes: changes.capture.statements.length });
    previous = scale;
  }

  expect(statementCounts[1]).toEqual(statementCounts[0]);
  expect(statementCounts[2]).toEqual(statementCounts[0]);
});

test('a record request with one added id and one hundred removed ids answers 400 invalid_request and changes nothing', async () => {
  const subjectId = await createSubject();
  const current = await start(subjectId, 'completed_units', 'episode');
  const removed = Array.from({ length: 100 }, (_, index) => `opaque-unit:${index}`);
  const before = await authoritativeProgressRows();
  const result = await request('owner', 'POST', `/v1/progressSessions/${current.id}:record`, {
    revision: current.revision,
    add: ['extra'],
    remove: removed,
  });
  expect(result.response.status).toBe(400);
  expect(result.body.code).toBe('invalid_request');
  expect(await authoritativeProgressRows()).toEqual(before);
});
