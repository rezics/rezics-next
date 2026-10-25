import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { syncSubjectListing } from '../../src/library/listing.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { capture, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
const accounts = { owner: newId(0x2250), other: newId(0x2250) };
type Persona = keyof typeof accounts | 'anonymous';
const credentials = new Map<Persona, string>();
const routeKey = new Uint8Array(32).fill(95);
const scopes = [
  'collection:create',
  'collection:read',
  'collection:update',
  'collection:delete',
  'library_entry:read',
  'library_entry:list',
  'library_entry:update',
  'copy:create',
  'copy:read',
  'copy:list',
  'follow:create',
  'follow:read',
  'follow:list',
  'progress_session:create',
  'progress_session:read',
  'progress_session:list',
  'published_log:create',
  'published_log:read',
  'subject:read',
  'space:create',
  'space:read',
  'exposure:open',
];
const actor: AccountActor = {
  kind: 'account',
  accountId: accounts.owner,
  clientId: 'full-views',
  scopes,
  requestedBy: null,
  authnEpoch: 1,
};
function request(method: string, path: string, body?: unknown, as: Persona = 'owner') {
  return app.handle(
    new Request(`https://kernel.test${path}`, {
      method,
      headers: {
        ...(as === 'anonymous' ? {} : { authorization: `Bearer ${credentials.get(as)!}` }),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(randomUUID()) }),
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
const viewPath = (path: string, view: string) => `${path}${path.includes('?') ? '&' : '?'}view=${view}`;
async function subject(label = 'Embedded book') {
  const key = randomUUID();
  return (
    await createSubject(db.pool, {
      actor,
      target: subjectTarget(routeKey, actor.accountId, key),
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      item: { type: 'schema:Book', labels: { en: label } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    })
  ).subject.id;
}
async function fixture() {
  const subjectId = await subject();
  const versionSubjectId = await subject('Embedded version');
  const collection = (
    await json(await request('POST', '/v1/collections', { title: 'Books', visibility: 'public' }), 201)
  ).collection;
  const member = (await json(await request('POST', `/v1/collections/${collection.id}/members`, { subjectId }), 201))
    .member;
  const entry = (await json(await request('PUT', `/v1/libraryEntries/${subjectId}`, { state: 'planned' })))
    .libraryEntry;
  const copy = (await json(await request('POST', '/v1/copies', { subjectId, status: 'owned' }), 201)).copy;
  const session = (
    await json(
      await request('POST', '/v1/progressSessions', {
        subjectId,
        versionSubjectId,
        mode: 'scalar_amount',
        unit: 'page',
      }),
      201,
    )
  ).progressSession;
  const log = (await json(await request('POST', '/v1/publishedLogs', { sessionId: session.id }), 201)).publishedLog;
  await json(await request('PUT', `/v1/follows/${subjectId}`));
  await json(await request('PUT', `/v1/follows/${collection.id}`));
  await syncSubjectListing(db.pool, { subjectId });
  return { subjectId, versionSubjectId, collection, member, entry, copy, session, log };
}
const account = { id: accounts.owner, handle: 'full-owner', displayName: 'Full Owner' };
const summary = (id: string, label = 'Embedded book') => ({ id, type: 'schema:Book', label });

beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'full', alg: 'ES256' };
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(96)]]) },
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.full.test',
          audience: 'https://api.rezics.test',
          jwksUrl: 'https://auth.full.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
  });
  for (const [persona, id] of Object.entries(accounts)) {
    await db.admin.query(
      `INSERT INTO access.account
      (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete, handle, display_name)
      VALUES ($1,$2,'actor','active',$2,false,1,true,$3,$4)`,
      [routeOf(id), id, `full-${persona}`, persona === 'owner' ? 'Full Owner' : 'Full Other'],
    );
    credentials.set(
      persona as Persona,
      await new SignJWT({
        client_id: 'full-views',
        scope: scopes.join(' '),
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'full', typ: 'at+jwt' })
        .setIssuer('https://auth.full.test')
        .setAudience('https://api.rezics.test')
        .setSubject(id)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(signing.privateKey),
    );
  }
  await bootstrapGovernance(db.pool, accounts.owner);
  for (const group of ['collections', 'personal_library', 'reading_progress'])
    await json(await request('POST', `/v1/platform/exposure/${group}:open`));
});
afterAll(async () => {
  await db?.close();
});

test('FULL embeds every library view and page and BASIC is byte for byte unchanged', async () => {
  const f = await fixture();
  const checks = [
    [`/v1/collections/${f.collection.id}`, 'collection', { curator: account }],
    [`/v1/collections?curatorAccountId=${accounts.owner}`, 'collections', { curator: account }],
    [`/v1/collections/${f.collection.id}/members`, 'members', { subject: summary(f.subjectId) }],
    [`/v1/subjects/${f.subjectId}/collections`, 'collections', { curator: account }],
    [`/v1/libraryEntries/${f.subjectId}`, 'libraryEntry', { subject: summary(f.subjectId) }],
    ['/v1/libraryEntries', 'libraryEntries', { subject: summary(f.subjectId) }],
    [`/v1/copies/${f.copy.id}`, 'copy', { subject: summary(f.subjectId) }],
    ['/v1/copies', 'copies', { subject: summary(f.subjectId) }],
    [
      `/v1/progressSessions/${f.session.id}`,
      'progressSession',
      { subject: summary(f.subjectId), versionSubject: summary(f.versionSubjectId, 'Embedded version') },
    ],
    [
      `/v1/progressSessions?subjectId=${f.subjectId}`,
      'progressSessions',
      { subject: summary(f.subjectId), versionSubject: summary(f.versionSubjectId, 'Embedded version') },
    ],
    [`/v1/publishedLogs/${f.log.id}`, 'publishedLog', { subject: summary(f.subjectId), account }],
    [`/v1/publishedLogs?accountId=${accounts.owner}`, 'publishedLogs', { subject: summary(f.subjectId), account }],
    [`/v1/follows/${f.subjectId}`, 'follow', { target: summary(f.subjectId) }],
    ['/v1/follows', 'follows', { target: summary(f.subjectId) }],
    [
      `/v1/follows/${f.collection.id}`,
      'follow',
      { target: { id: f.collection.id, type: 'collection', label: 'Books' } },
    ],
    [`/v1/progressSessions/${f.session.id}/completedUnits`, 'completedUnits', null],
    [`/v1/progressSessions/${f.session.id}/changes`, 'changes', null],
  ] as const;
  for (const [path, field, embedded] of checks) {
    const basic = await request('GET', path);
    expect(basic.status).toBe(200);
    const text = await basic.text();
    expect(await (await request('GET', viewPath(path, 'BASIC'))).text()).toBe(text);
    const full = await json(await request('GET', viewPath(path, 'FULL')));
    if (embedded) {
      const values = Array.isArray(full[field]) ? full[field] : [full[field]];
      expect(values).toContainEqual(expect.objectContaining(embedded));
      const strip = (value: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(value).filter(
            ([key]) => !['subject', 'versionSubject', 'target', 'curator', 'account'].includes(key),
          ),
        );
      expect({ ...full, [field]: Array.isArray(full[field]) ? full[field].map(strip) : strip(full[field]) }).toEqual(
        JSON.parse(text),
      );
    } else expect(full).toEqual(JSON.parse(text));
    expect((await request('GET', viewPath(path, 'INVALID'))).status).toBe(400);
  }
  expect(JSON.parse(await (await request('GET', `/v1/libraryEntries/${f.subjectId}`)).text())).toEqual({
    libraryEntry: f.entry,
  });
  for (const as of ['owner', 'other', 'anonymous'] as const) {
    for (const [path, field] of checks.filter(
      ([path]) =>
        path.startsWith('/v1/collections') || path.includes('/collections') || path.startsWith('/v1/publishedLogs'),
    )) {
      const full = await json(await request('GET', viewPath(path, 'FULL'), undefined, as));
      expect(full[field]).toBeDefined();
    }
  }
  for (const as of ['other', 'anonymous'] as const) {
    for (const path of [
      `/v1/libraryEntries/${f.subjectId}`,
      `/v1/copies/${f.copy.id}`,
      `/v1/progressSessions/${f.session.id}`,
      `/v1/follows/${f.subjectId}`,
    ])
      expect([401, 404]).toContain((await request('GET', viewPath(path, 'FULL'), undefined, as)).status);
  }
});

test('FULL never discloses a subject denied after insertion or a private follow target', async () => {
  const f = await fixture();
  await db.admin.query(
    `INSERT INTO access.resource_denial
    (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
    VALUES ($1,$2,$3,'','subject:read','resource','(,)'::tstzrange,$4)`,
    [routeOf(f.subjectId), f.subjectId, accounts.owner, randomUUID()],
  );
  const checks = [
    [`/v1/libraryEntries/${f.subjectId}`, 'libraryEntry'],
    [`/v1/copies/${f.copy.id}`, 'copy'],
    [`/v1/progressSessions/${f.session.id}`, 'progressSession'],
    [`/v1/publishedLogs/${f.log.id}`, 'publishedLog'],
    ['/v1/libraryEntries', 'libraryEntries'],
    ['/v1/copies', 'copies'],
    [`/v1/progressSessions?subjectId=${f.subjectId}`, 'progressSessions'],
    [`/v1/publishedLogs?accountId=${accounts.owner}`, 'publishedLogs'],
  ];
  for (const [path, field] of checks) {
    const full = await json(await request('GET', viewPath(path!, 'FULL')));
    const value = Array.isArray(full[field!])
      ? full[field!].find((row: { subjectId: string }) => row.subjectId === f.subjectId)
      : full[field!];
    expect(value.subject).toBeNull();
    expect(JSON.stringify(value)).not.toContain('Embedded book');
  }
  expect((await json(await request('GET', viewPath(`/v1/follows/${f.subjectId}`, 'FULL')))).follow.target).toBeNull();
  expect(
    (await json(await request('GET', viewPath(`/v1/collections/${f.collection.id}/members`, 'FULL')))).members,
  ).toEqual([]);
  await json(await request('PUT', `/v1/follows/${f.collection.id}`, undefined, 'other'));
  await json(
    await request('PATCH', `/v1/collections/${f.collection.id}`, {
      revision: f.collection.revision,
      visibility: 'private',
    }),
  );
  expect(
    (await json(await request('GET', viewPath(`/v1/follows/${f.collection.id}`, 'FULL'), undefined, 'other'))).follow
      .target,
  ).toBeNull();
});

test('deleted and pending curators and log accounts embed null through public account reads', async () => {
  const f = await fixture();
  for (const state of ['deleted', 'pending']) {
    await db.admin.query('UPDATE access.account SET state=$1 WHERE account_id=$2', [state, accounts.owner]);
    try {
      expect(
        (
          await json(
            await request('GET', viewPath(`/v1/collections/${f.collection.id}`, 'FULL'), undefined, 'anonymous'),
          )
        ).collection.curator,
      ).toBeNull();
      expect(
        (await json(await request('GET', viewPath(`/v1/publishedLogs/${f.log.id}`, 'FULL'), undefined, 'anonymous')))
          .publishedLog.account,
      ).toBeNull();
    } finally {
      await db.admin.query("UPDATE access.account SET state='active' WHERE account_id=$1", [accounts.owner]);
    }
  }
});

test('a hundred repeated member subjects reuse the page authorization read once', async () => {
  const f = await fixture();
  for (let i = 1; i < 100; i++)
    await json(await request('POST', `/v1/collections/${f.collection.id}/members`, { subjectId: f.subjectId }), 201);
  const path = `/v1/collections/${f.collection.id}/members?limit=100`;
  const basic = await capture(db, () => request('GET', path));
  const full = await capture(db, () => request('GET', viewPath(path, 'FULL')));
  const body = await json(full.value);
  expect(body.members).toHaveLength(100);
  expect(
    body.members.every(
      (row: { subject: unknown }) => JSON.stringify(row.subject) === JSON.stringify(summary(f.subjectId)),
    ),
  ).toBe(true);
  expect(full.capture.statements.filter((sql) => sql.includes('FROM semantic.subject AS s'))).toHaveLength(1);
  expect(full.capture.statements.length).toBeLessThanOrEqual(basic.capture.statements.length + 4);
});

test('FULL pages of twenty have constant SQL at three unrelated scales and bounded distinct reads', async () => {
  const f = await fixture();
  for (let i = 1; i < 20; i++) {
    const id = await subject(`Page book ${i}`);
    await json(await request('POST', `/v1/collections/${f.collection.id}/members`, { subjectId: id }), 201);
  }
  const counts: number[] = [];
  for (const [from, to] of [
    [0, 20],
    [20, 160],
    [160, 1280],
  ] as const) {
    await seed(
      db,
      {
        name: 'full-unrelated-accounts',
        hotPartition: routeOf(accounts.owner)! >>> 4,
        rows: ({ route }) => {
          const id = newId(route);
          return { 'access.account': [{ route, account_id: id, kind: 'actor', state: 'active', transaction_id: id }] };
        },
      },
      { from, to },
    );
    const measured = await capture(db, () =>
      request('GET', `/v1/collections/${f.collection.id}/members?view=FULL&limit=20`),
    );
    expect((await json(measured.value)).members).toHaveLength(20);
    expect(measured.capture.statements.filter((sql) => sql.includes('FROM semantic.subject AS s'))).toHaveLength(20);
    expect(measured.capture.statements.filter((sql) => sql.includes('display_name')).length).toBeLessThanOrEqual(20);
    counts.push(measured.capture.statements.length);
  }
  expect(counts[1]).toBe(counts[0]);
  expect(counts[2]).toBe(counts[0]);
});
