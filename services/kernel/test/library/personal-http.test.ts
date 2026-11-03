import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import * as collections from '../../src/library/collection-store.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { capture, measure, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
const routeKey = new Uint8Array(32).fill(93);
const accounts = { owner: newId(0x2200), other: newId(0x2200), suspended: newId(0x2200) };
type Persona = keyof typeof accounts | 'anonymous';
const tokens = new Map<string, string>();
const scopes = [
  'library_entry:read',
  'library_entry:list',
  'library_entry:update',
  'library_entry:delete',
  'copy:create',
  'copy:read',
  'copy:list',
  'copy:update',
  'copy:delete',
  'follow:create',
  'follow:delete',
  'follow:read',
  'follow:list',
  'subject:read',
  'space:read',
  'space:create',
];
const owner: AccountActor = {
  kind: 'account',
  accountId: accounts.owner,
  clientId: 'personal-http',
  scopes,
  requestedBy: null,
  authnEpoch: 1,
};
let now = Date.now();
const clock = () => new Date((now = Math.max(now + 1, Date.now())));
function request(
  method: string,
  path: string,
  body?: unknown,
  as: Persona = 'owner',
  key: string | null = randomUUID(),
) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        'x-request-id': 'personal-http',
        ...(as === 'anonymous' ? {} : { authorization: `Bearer ${tokens.get(as)!}` }),
        ...(key === null ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function json(response: Response, status = 200) {
  expect(response.status).toBe(status);
  return response.json();
}
async function problem(response: Response, status: number, code?: string) {
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const body = await json(response, status);
  expect(body).toMatchObject({ status, ...(code ? { code } : {}) });
  expect(body.type).toBe(`https://rezics.com/problems/${body.code}`);
  const { request_id: requestId, ...stable } = body;
  expect(requestId).toEqual(expect.any(String));
  return stable;
}
async function subject() {
  const key = randomUUID();
  return (
    await createSubject(db.pool, {
      actor: owner,
      target: subjectTarget(routeKey, owner.accountId, key),
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      item: { type: 'schema:Book', labels: { en: key } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    })
  ).subject.id;
}
async function entry(id: string, state = 'planned', revision?: number) {
  return (
    await json(
      await request('PUT', `/v1/libraryEntries/${id}`, { state, ...(revision ? { revision } : {}) }),
      revision ? 200 : 201,
    )
  ).libraryEntry;
}
async function copy(id: string) {
  return (await json(await request('POST', '/v1/copies', { subjectId: id, status: 'owned', note: 'Shelf' }), 201)).copy;
}
async function snapshot() {
  const result = await db.admin.query(`SELECT * FROM (SELECT 'entry' AS kind, to_jsonb(e) AS row FROM library.entry e
    UNION ALL SELECT 'copy', to_jsonb(c) FROM library.copy c
    UNION ALL SELECT 'follow', to_jsonb(f) FROM library.follow f) AS rows ORDER BY kind, row::text`);
  return result.rows;
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await bootstrapRelease(db.pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'personal', alg: 'ES256' };
  app = createKernel({
    pool: db.pool,
    writeRate: createWriteRateLimiter({
      secret: 'personal-http-write-rate-secret-32-bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
    }),
    ratePeer: () => '127.0.0.1',
    routeKey,
    clock,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) },
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
  for (const [persona, id] of Object.entries(accounts)) {
    await db.admin.query(
      `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
      VALUES ($1,$2,'actor',$3,$2)`,
      [routeOf(id), id, 'active'],
    );
    tokens.set(
      persona,
      await new SignJWT({
        client_id: 'personal-http',
        scope: scopes.join(' '),
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'personal', typ: 'at+jwt' })
        .setIssuer('https://auth.example.test')
        .setAudience('https://api.rezics.test')
        .setSubject(id)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signing.privateKey),
    );
  }
  await suspendAccount(db.admin, accounts.suspended);
  await db.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     VALUES ('personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
    [randomUUID()],
  );
});
afterAll(async () => {
  await db?.close();
});

test('personal routes mount once and declare their gate in OpenAPI', () => {
  const document = openApiDocument(app);
  const expected = {
    '/v1/libraryEntries': ['get'],
    '/v1/libraryEntries/{subjectId}': ['get', 'put', 'delete'],
    '/v1/libraryEntries/{subjectId}/state-history': ['get'],
    '/v1/libraryEntries/{subjectId}/state-history/{changeRevision}': ['get'],
    '/v1/libraryEntries/{subjectId}/state-history/{changeRevision}:restore': ['post'],
    '/v1/copies': ['post', 'get'],
    '/v1/copies/{copyId}': ['get', 'patch', 'delete'],
    '/v1/follows': ['get'],
    '/v1/follows/{targetId}': ['get', 'put', 'delete'],
  };
  for (const [path, methods] of Object.entries(expected))
    for (const method of methods) {
      expect(document.paths[path]?.[method]?.['x-exposure']).toBe('gate:personal_library');
      const native = path.replace(/\{(\w+)\}/g, ':$1');
      const route =
        path.endsWith(':restore')
          ? native.replace(/:restore$/, '/$restore')
          : native;
      expect(
        app.routes.filter(
          (candidate) =>
            candidate.path === route && candidate.method.toLowerCase() === method,
        ),
      ).toHaveLength(1);
    }
});

test('entry states revisions deletion and signed pages use the frozen HTTP views', async () => {
  const id = await subject();
  let current = await entry(id);
  expect(current).toEqual({
    subjectId: id,
    state: 'planned',
    revision: 1,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });
  for (const state of ['in_progress', 'completed', 'paused', 'dropped']) {
    const previous = current;
    current = await entry(id, state, current.revision);
    expect(current).toMatchObject({ state, revision: previous.revision + 1, createdAt: previous.createdAt });
    expect((await json(await request('GET', `/v1/libraryEntries?state=${state}`))).libraryEntries).toContainEqual(
      current,
    );
  }
  const before = await snapshot();
  for (const body of [{ state: 'planned' }, { state: 'planned', revision: 1 }])
    await problem(await request('PUT', `/v1/libraryEntries/${id}`, body), 409, 'conflict');
  for (const suffix of ['', '?revision=1'])
    await problem(await request('DELETE', `/v1/libraryEntries/${id}${suffix}`), 409, 'conflict');
  expect(await snapshot()).toEqual(before);
  expect(await json(await request('GET', `/v1/libraryEntries/${id}`))).toEqual({ libraryEntry: current });
  const second = await entry(await subject());
  const firstPage = await json(await request('GET', '/v1/libraryEntries?limit=1'));
  expect(firstPage.libraryEntries).toEqual([second]);
  const next = await json(
    await request('GET', `/v1/libraryEntries?limit=1&cursor=${encodeURIComponent(firstPage.next)}`),
  );
  expect(next).toEqual({ libraryEntries: [current], next: null });
  await problem(
    await request('GET', `/v1/libraryEntries?state=paused&cursor=${encodeURIComponent(firstPage.next)}`),
    400,
    'invalid_cursor',
  );
  expect((await request('DELETE', `/v1/libraryEntries/${id}?revision=${current.revision}`)).status).toBe(204);
  await problem(await request('GET', `/v1/libraryEntries/${id}`), 404, 'not_found');
});

test('entry state history is private, bounded by change and restores only the reviewed live incarnation', async () => {
  const id = await subject();
  let current = await entry(id);
  current = await entry(id, 'planned', current.revision);
  current = await entry(id, 'in_progress', current.revision);
  current = await entry(id, 'completed', current.revision);

  const first = await json(await request('GET', `/v1/libraryEntries/${id}/state-history?limit=2`));
  expect(first).toMatchObject({
    currentRevision: current.revision,
    coverage: 'complete',
    changes: [{ revision: 4 }, { revision: 3 }],
  });
  expect(first.next).toEqual(expect.any(String));
  const last = await json(
    await request('GET', `/v1/libraryEntries/${id}/state-history?limit=2&cursor=${encodeURIComponent(first.next)}`),
  );
  expect(last).toMatchObject({ coverage: 'complete', changes: [{ revision: 1, beforeState: null }] });
  expect(last.next).toBeNull();
  await problem(await request('GET', `/v1/libraryEntries/${id}/state-history`, undefined, 'other'), 404, 'not_found');

  const review = await json(await request('GET', `/v1/libraryEntries/${id}/state-history/3`));
  expect(review).toMatchObject({
    change: { revision: 3, beforeState: 'planned', afterState: 'in_progress' },
    current: { revision: current.revision, state: 'completed' },
    availability: 'available',
  });
  const restoreKey = randomUUID();
  const restorePath = `/v1/libraryEntries/${id}/state-history/3:restore`;
  const restoreBody = { incarnationId: first.incarnationId, currentRevision: current.revision };
  const restored = await json(await request('POST', restorePath, restoreBody, 'owner', restoreKey));
  expect(restored.libraryEntry).toMatchObject({ state: 'planned', revision: current.revision + 1 });
  expect(await json(await request('POST', restorePath, restoreBody, 'owner', restoreKey))).toEqual(restored);
  expect(
    (await db.admin.query(`SELECT revision,command_kind FROM library.entry_state_change WHERE route=$1 AND account_id=$2 AND subject_id=$3 ORDER BY revision`, [
      routeOf(accounts.owner),
      accounts.owner,
      id,
    ])).rows,
  ).toHaveLength(4);

  const otherId = await subject();
  const otherEntry = await entry(otherId, 'paused');
  const staleReview = await json(await request('GET', `/v1/libraryEntries/${id}/state-history/4`));
  const changed = await entry(id, 'paused', restored.libraryEntry.revision);
  await problem(
    await request(
      'POST',
      `/v1/libraryEntries/${id}/state-history/4:restore`,
      { incarnationId: first.incarnationId, currentRevision: staleReview.current.revision },
    ),
    409,
    'library_entry_state_restore_stale',
  );
  expect((await json(await request('GET', `/v1/libraryEntries/${otherId}`))).libraryEntry).toEqual(otherEntry);

  expect((await request(
    'DELETE',
    `/v1/libraryEntries/${id}?revision=${changed.libraryEntry.revision}&incarnationId=${first.incarnationId}`,
  )).status).toBe(204);
  await problem(await request('GET', `/v1/libraryEntries/${id}/state-history`), 404, 'not_found');
  const recreated = await entry(id, 'planned');
  const recreatedHistory = await json(await request('GET', `/v1/libraryEntries/${id}/state-history`));
  expect(recreatedHistory.incarnationId).not.toBe(first.incarnationId);
  await problem(
    await request(
      'POST',
      `/v1/libraryEntries/${id}/state-history/4:restore`,
      { incarnationId: first.incarnationId, currentRevision: recreated.revision },
    ),
    409,
    'library_entry_state_restore_stale',
  );
});

test('history exposes unknown legacy coverage and refuses a former state outside the current profile', async () => {
  const legacyId = await subject();
  const legacyEntry = await entry(legacyId);
  const legacyPage = await json(await request('GET', `/v1/libraryEntries/${legacyId}/state-history`));
  await db.admin.query(
    `DELETE FROM library.entry_state_change WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
    [routeOf(accounts.owner), accounts.owner, legacyId],
  );
  expect(await json(await request('GET', `/v1/libraryEntries/${legacyId}/state-history`))).toMatchObject({
    incarnationId: legacyPage.incarnationId,
    currentRevision: legacyEntry.revision,
    changes: [],
    coverage: 'unknown',
    next: null,
  });

  const subjectId = await subject();
  const current = await entry(subjectId);
  const history = await json(await request('GET', `/v1/libraryEntries/${subjectId}/state-history`));
  const oldRevision = current.revision + 1;
  await db.admin.query(
    `INSERT INTO library.entry_state_change
      (route,account_id,subject_id,incarnation_id,prior_revision,revision,before_state,after_state,
       command_id,command_kind,changed_at,coverage_complete)
     VALUES($1,$2,$3,$4,$5,$6,'retired.meaning','planned',$7,'library.entry.put',$8,false)`,
    [
      routeOf(accounts.owner),
      accounts.owner,
      subjectId,
      history.incarnationId,
      current.revision,
      oldRevision,
      randomUUID(),
      new Date().toISOString(),
    ],
  );
  expect(await json(await request('GET', `/v1/libraryEntries/${subjectId}/state-history/${oldRevision}`))).toMatchObject({
    change: { beforeState: 'retired.meaning' },
    availability: 'state_unavailable',
  });
  await problem(
    await request(
      'POST',
      `/v1/libraryEntries/${subjectId}/state-history/${oldRevision}:restore`,
      { incarnationId: history.incarnationId, currentRevision: current.revision },
    ),
    409,
    'library_entry_state_restore_unavailable',
  );
});

test('state history prunes at the retained cap and keeps continuation coverage truthful', async () => {
  const subjectId = await subject();
  let current = await entry(subjectId);
  const states = ['in_progress', 'completed', 'paused', 'dropped', 'planned'];
  for (let index = 0; index < 65; index++)
    current = await entry(subjectId, states[index % states.length]!, current.revision);
  const first = await json(await request('GET', `/v1/libraryEntries/${subjectId}/state-history?limit=50`));
  expect(first.changes).toHaveLength(50);
  expect(first.coverage).toBe('partial');
  const second = await json(
    await request('GET', `/v1/libraryEntries/${subjectId}/state-history?limit=50&cursor=${encodeURIComponent(first.next)}`),
  );
  expect(second.changes).toHaveLength(14);
  expect(second.coverage).toBe('partial');
  expect(second.next).toBeNull();
  expect(second.currentRevision).toBe(current.revision);
}, 120_000);

test('copies remain independent and conceal missing and foreign rows before revision conflicts', async () => {
  const id = await subject();
  const a = await copy(id),
    b = await copy(id);
  expect(a).toEqual({
    id: expect.any(String),
    subjectId: id,
    status: 'owned',
    revision: 1,
    location: null,
    source: null,
    acquiredOn: null,
    disposedOn: null,
    note: 'Shelf',
  });
  expect(a.id).not.toBe(b.id);
  const changed = (
    await json(await request('PATCH', `/v1/copies/${a.id}`, { revision: 1, status: 'lent', location: 'Friend' }))
  ).copy;
  expect(changed).toEqual({ ...a, revision: 2, status: 'lent', location: 'Friend' });
  for (const body of [{ status: 'disposed' }, { revision: 1, status: 'disposed' }])
    await problem(await request('PATCH', `/v1/copies/${a.id}`, body), 409, 'conflict');
  expect(await json(await request('GET', `/v1/copies/${b.id}`))).toEqual({ copy: b });
  const page = await json(await request('GET', '/v1/copies?limit=1'));
  expect(page.copies).toHaveLength(1);
  expect(page.next).toBeTruthy();
  expect(
    (await json(await request('GET', `/v1/copies?limit=1&cursor=${encodeURIComponent(page.next)}`))).copies,
  ).toHaveLength(1);
  expect((await request('DELETE', `/v1/copies/${a.id}`)).status).toBe(204);
  await problem(await request('GET', `/v1/copies/${a.id}`), 404, 'not_found');
});

test("copy list filters by subject without exposing another account's copies", async () => {
  const subjectId = await subject();
  const otherSubjectId = await subject();
  const viewerCopy = await copy(subjectId);
  const unrelatedCopy = await copy(otherSubjectId);
  const otherCopy = (await json(await request('POST', '/v1/copies', { subjectId, status: 'owned' }, 'other'), 201))
    .copy;

  const filtered = await json(await request('GET', `/v1/copies?subjectId=${subjectId}`));
  expect(filtered.copies.map((item: { id: string }) => item.id)).toEqual([viewerCopy.id]);
  expect(filtered.copies.some((item: { id: string }) => item.id === otherCopy.id)).toBe(false);

  const unfiltered = await json(await request('GET', '/v1/copies?limit=1'));
  expect(unfiltered.next).toBeString();
  await problem(
    await request('GET', `/v1/copies?subjectId=${subjectId}&limit=1&cursor=${encodeURIComponent(unfiltered.next)}`),
    400,
    'invalid_cursor',
  );

  const malformed = await capture(db, () => request('GET', '/v1/copies?subjectId=not-a-uuid'));
  await problem(malformed.value, 400, 'invalid_request');
  expect(malformed.capture.statements.some((statement) => /FROM library\.copy\b/i.test(statement))).toBe(false);

  expect((await request('DELETE', `/v1/copies/${viewerCopy.id}?revision=${viewerCopy.revision}`)).status).toBe(204);
  expect((await request('DELETE', `/v1/copies/${unrelatedCopy.id}?revision=${unrelatedCopy.revision}`)).status).toBe(
    204,
  );
  expect(
    (await request('DELETE', `/v1/copies/${otherCopy.id}?revision=${otherCopy.revision}`, undefined, 'other')).status,
  ).toBe(204);
});

test('inferred subject and Collection follows return either state but list only following', async () => {
  const id = await subject();
  const shelf = await collections.insertCollection(
    db.admin,
    routeOf(accounts.owner)!,
    {
      id: newId(routeOf(accounts.owner)!),
      curatorAccountId: accounts.owner,
      title: 'Public shelf',
      description: null,
      visibility: 'public',
    },
    { time: clock().toISOString(), transactionId: newId(routeOf(accounts.owner)!) },
  );
  for (const [targetId, targetType] of [
    [id, 'subject'],
    [shelf.id, 'collection'],
  ]) {
    const result = await json(await request('PUT', `/v1/follows/${targetId}`));
    expect(result).toEqual({
      follow: { targetId, targetType, state: 'following', reason: 'explicit', updatedAt: expect.any(String) },
    });
    expect(await json(await request('GET', `/v1/follows/${targetId}`))).toEqual(result);
    await json(await request('DELETE', `/v1/follows/${targetId}`));
    expect((await json(await request('GET', `/v1/follows/${targetId}`))).follow.state).toBe('unfollowed');
    expect(
      (await json(await request('GET', '/v1/follows'))).follows.some(
        (row: { targetId: string }) => row.targetId === targetId,
      ),
    ).toBe(false);
  }
  const implied = await entry(id, 'in_progress');
  expect((await json(await request('GET', `/v1/follows/${id}`))).follow.state).toBe('unfollowed');
  await entry(id, 'paused', implied.revision);
});

test('private reads conceal owner unknown and malformed ids and denied writes leave state unchanged', async () => {
  const id = await subject();
  const owned = await entry(id, 'in_progress'),
    item = await copy(id);
  for (const as of ['other', 'anonymous'] as const) {
    for (const [base, hidden] of [
      ['/v1/libraryEntries', id],
      ['/v1/copies', item.id],
      ['/v1/follows', id],
    ]) {
      const absent = await problem(await request('GET', `${base}/${newId(0x2200)}`, undefined, as), 404, 'not_found');
      expect(await problem(await request('GET', `${base}/${hidden}`, undefined, as), 404, 'not_found')).toEqual(absent);
      expect(await problem(await request('GET', `${base}/bad-id`, undefined, as), 404, 'not_found')).toEqual(absent);
    }
  }
  for (const base of ['/v1/libraryEntries', '/v1/copies', '/v1/follows']) {
    expect(await json(await request('GET', base, undefined, 'other'))).toEqual({
      [base.split('/').at(-1)!]: [],
      next: null,
    });
    await problem(await request('GET', base, undefined, 'anonymous'), 401);
    expect([401, 403]).toContain((await request('GET', base, undefined, 'suspended')).status);
  }
  const before = await snapshot();
  for (const as of ['anonymous', 'suspended'] as const)
    for (const [method, path, body] of [
      ['PUT', `/v1/libraryEntries/${id}`, { state: 'paused', revision: owned.revision }],
      ['DELETE', `/v1/libraryEntries/${id}?revision=${owned.revision}`, undefined],
      ['POST', '/v1/copies', { subjectId: id, status: 'ordered' }],
      ['PATCH', `/v1/copies/${item.id}`, { revision: item.revision, status: 'disposed' }],
      ['DELETE', `/v1/copies/${item.id}`, undefined],
      ['PUT', `/v1/follows/${id}`, undefined],
      ['DELETE', `/v1/follows/${id}`, undefined],
    ] as const) {
      const response = await request(method, path, body, as);
      expect([401, 403]).toContain(response.status);
      await problem(response, response.status);
      expect(await snapshot()).toEqual(before);
    }
  for (const method of ['PATCH', 'DELETE']) {
    const body = method === 'PATCH' ? { revision: 1, status: 'disposed' } : undefined;
    const hidden = await problem(await request(method, `/v1/copies/${item.id}`, body, 'other'), 404, 'not_found');
    expect(
      await problem(await request(method, `/v1/copies/${newId(0x2200)}`, body, 'other'), 404, 'not_found'),
    ).toEqual(hidden);
  }
  expect(await snapshot()).toEqual(before);
});

test('closed schemas keys limits cursors and hidden targets map to problems', async () => {
  const id = await subject();
  for (const path of ['/v1/libraryEntries', '/v1/copies', '/v1/follows']) {
    for (const limit of [0, 101]) await problem(await request('GET', `${path}?limit=${limit}`), 400);
    await problem(await request('GET', `${path}?cursor=bad`), 400, 'invalid_cursor');
  }
  for (const [method, path, body] of [
    ['PUT', `/v1/libraryEntries/${id}`, { state: 'planned' }],
    ['POST', '/v1/copies', { subjectId: id, status: 'owned' }],
    ['PUT', `/v1/follows/${id}`, undefined],
    ['DELETE', `/v1/follows/${id}`, undefined],
  ] as const)
    await problem(await request(method, path, body, 'owner', null), 400);
  await problem(await request('PUT', `/v1/libraryEntries/${id}`, { state: 'planned', extra: true }), 400);
  await problem(await request('POST', '/v1/copies', { subjectId: id, status: 'owned', extra: true }), 400);
  await problem(await request('PUT', `/v1/follows/${id}`, { targetType: 'subject' }), 400);
  for (const target of [newId(0x2200), 'bad-id']) {
    await problem(await request('PUT', `/v1/libraryEntries/${target}`, { state: 'planned' }), 404, 'not_found');
    await problem(await request('POST', '/v1/copies', { subjectId: target, status: 'owned' }), 404, 'not_found');
    for (const method of ['PUT', 'DELETE'])
      await problem(await request(method, `/v1/follows/${target}`), 404, 'not_found');
  }
});

test('HTTP entry puts and follows pages use equal statements at three scales', async () => {
  const id = await subject();
  let current = await entry(id);
  const counts: number[][] = [];
  let previous = 0;
  for (const scale of [1, 8, 64]) {
    for (let index = previous; index < scale; index++) {
      const unrelated = await subject();
      await entry(unrelated, 'in_progress');
      await copy(unrelated);
    }
    previous = scale;
    await request('GET', '/v1/follows?limit=1');
    const put = await measure(db, () =>
      request('PUT', `/v1/libraryEntries/${id}`, { state: 'paused', revision: current.revision }),
    );
    current = (await json(put.value)).libraryEntry;
    const page = await measure(db, () => request('GET', '/v1/follows?limit=1'));
    expect((await json(page.value)).follows).toHaveLength(1);
    expect(put.cost.statements).toBeGreaterThan(0);
    expect(page.cost.statements).toBeGreaterThan(0);
    counts.push([put.cost.statements, page.cost.statements]);
  }
  expect(counts[1]).toEqual(counts[0]);
  expect(counts[2]).toEqual(counts[0]);
}, 120_000);

test('Space inference uses community reads and conceals a denied target like an unknown one', async () => {
  await db.admin.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
    VALUES (0, $1, $2, 'space:create', '(,)', $3)`,
    [GLOBAL_CONTEXT, accounts.owner, randomUUID()],
  );
  const space = (await json(await request('POST', '/v1/spaces', { title: 'Followable Space' }), 201)).space;
  const followed = await json(await request('PUT', `/v1/follows/${space.spaceId}`));
  expect(followed.follow).toMatchObject({ targetId: space.spaceId, targetType: 'space', state: 'following' });
  await json(await request('DELETE', `/v1/follows/${space.spaceId}`));
  await db.admin.query(
    `INSERT INTO access.resource_denial(route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
    VALUES ($1, $2, $3, '', 'space:read', 'resource', '(,)', $4)`,
    [routeOf(space.spaceId), space.spaceId, accounts.owner, randomUUID()],
  );
  const before = await snapshot();
  for (const method of ['PUT', 'DELETE']) {
    const denied = await problem(await request(method, `/v1/follows/${space.spaceId}`), 404, 'not_found');
    expect(await problem(await request(method, `/v1/follows/${newId(0x2200)}`), 404, 'not_found')).toEqual(denied);
  }
  expect(await snapshot()).toEqual(before);
});

test('HTTP write receipts replay entries and copies and reject a reused key with changed input', async () => {
  const id = await subject();
  for (const [method, path, body, changed, status] of [
    ['PUT', `/v1/libraryEntries/${id}`, { state: 'planned' }, { state: 'paused' }, 201],
    ['POST', '/v1/copies', { subjectId: id, status: 'owned' }, { subjectId: id, status: 'lent' }, 201],
  ] as const) {
    const key = randomUUID();
    const first = await json(await request(method, path, body, 'owner', key), status);
    const before = await snapshot();
    expect(await json(await request(method, path, body, 'owner', key), status)).toEqual(first);
    await problem(await request(method, path, changed, 'owner', key), 422, 'idempotency_conflict');
    expect(await snapshot()).toEqual(before);
  }
});

test('a library entry put that creates the entry answers 201 and one that updates it answers 200', async () => {
  const id = await subject();
  const created = await json(await request('PUT', `/v1/libraryEntries/${id}`, { state: 'planned' }), 201);
  expect(created.libraryEntry).toEqual({
    subjectId: id,
    state: 'planned',
    revision: 1,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });
  const updated = await json(
    await request('PUT', `/v1/libraryEntries/${id}`, { state: 'in_progress', revision: 1 }),
    200,
  );
  expect(updated.libraryEntry).toMatchObject({
    subjectId: id,
    state: 'in_progress',
    revision: 2,
    createdAt: created.libraryEntry.createdAt,
  });
});

test('a replayed creating put with the same idempotency key answers 201 with the same body and writes nothing', async () => {
  const id = await subject();
  const key = randomUUID();
  const first = await request('PUT', `/v1/libraryEntries/${id}`, { state: 'planned' }, 'owner', key);
  const created = await json(first, 201);
  const before = await snapshot();
  const replay = await request('PUT', `/v1/libraryEntries/${id}`, { state: 'planned' }, 'owner', key);
  expect(replay.status).toBe(first.status);
  expect(replay.status).toBe(201);
  expect(await json(replay, 201)).toEqual(created);
  expect(await snapshot()).toEqual(before);
  expect((await json(await request('GET', `/v1/libraryEntries/${id}`))).libraryEntry.revision).toBe(1);
});

test('following pages keep their order and bind cursors to the account', async () => {
  const all = await json(await request('GET', '/v1/follows?limit=100'));
  expect(all.next).toBeNull();
  expect(all.follows.length).toBeGreaterThan(20);
  expect((await json(await request('GET', '/v1/follows'))).follows).toEqual(all.follows.slice(0, 20));
  const first = await json(await request('GET', '/v1/follows?limit=7'));
  expect(first.next).toEqual(expect.any(String));
  await problem(
    await request('GET', `/v1/follows?cursor=${encodeURIComponent(first.next)}`, undefined, 'other'),
    400,
    'invalid_cursor',
  );
  const rows = [...first.follows];
  let cursor = first.next;
  while (cursor !== null) {
    const page = await json(await request('GET', `/v1/follows?limit=7&cursor=${encodeURIComponent(cursor)}`));
    rows.push(...page.follows);
    cursor = page.next;
  }
  expect(rows).toEqual(all.follows);
  expect(rows.every((row) => row.state === 'following')).toBe(true);
});
