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
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
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
  'space:manage',
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
function request(
  method: string,
  path: string,
  body?: unknown,
  as: Persona = 'owner',
  extraHeaders: Record<string, string> = {},
) {
  return app.handle(
    new Request(`https://kernel.test${path}`, {
      method,
      headers: {
        ...(as === 'anonymous' ? {} : { authorization: `Bearer ${credentials.get(as)!}` }),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function json(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
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
  const entry = (await json(await request('PUT', `/v1/libraryEntries/${subjectId}`, { state: 'planned' }), 201))
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
  await syncSubjectListing({ pool: db.pool }, { subjectId, collectionId: collection.id });
  return { subjectId, versionSubjectId, collection, member, entry, copy, session, log };
}
const account = { id: accounts.owner, handle: 'full-owner', displayName: 'Full Owner' };
const summary = (id: string, label = 'Embedded book') => ({
  id,
  type: 'schema:Book',
  types: ['schema:Book', ...bundledRelease.types['schema:Book']!.bases],
  label: { value: label, language: 'en' },
  creativeWork: true,
  cover: null,
});

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
        .setExpirationTime('5m')
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
  await db.admin.query(
    "UPDATE semantic.subject SET visibility='hidden', security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
    [routeOf(f.subjectId), f.subjectId],
  );
  for (const as of ['other', 'anonymous'] as const) {
    const hidden = await json(await request('GET', viewPath(`/v1/publishedLogs/${f.log.id}`, 'FULL'), undefined, as));
    expect(hidden.publishedLog.subject).toBeNull();
    expect(JSON.stringify(hidden)).not.toContain('Embedded book');
  }

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
  for (let i = 1; i < 20; i++) await json(await request('POST', '/v1/publishedLogs', { sessionId: f.session.id }), 201);
  const counts: number[] = [];
  const logCounts: number[] = [];
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
          const collectionId = newId(route),
            subjectId = newId(route);
          const at = '2020-01-01T00:00:00.000Z';
          return {
            'access.account': [{ route, account_id: id, kind: 'actor', state: 'active', transaction_id: id }],
            'semantic.subject': [
              {
                route,
                subject_id: subjectId,
                type: 'schema:Book',
                recorded_transaction_id: id,
                current_release: bundledDigest,
              },
            ],
            'library.collection': [
              {
                route,
                collection_id: collectionId,
                curator_account_id: id,
                title: 'Unrelated',
                visibility: 'public',
                state: 'active',
                revision: 1,
                member_count: 1,
                order_epoch: 0,
                created_at: at,
                updated_at: at,
                transaction_id: id,
              },
            ],
            'library.collection_member': [
              {
                route,
                collection_id: collectionId,
                member_id: newId(route),
                subject_id: subjectId,
                ordinal_key: 'a0',
                added_at: at,
                transaction_id: id,
              },
            ],
            'library.published_log': [
              {
                route,
                log_id: newId(route),
                account_id: id,
                session_id: newId(route),
                subject_id: subjectId,
                session_state: 'active',
                started_at: at,
                completed_at: null,
                published_at: at,
                transaction_id: id,
              },
            ],
          };
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
    const logs = await capture(db, () =>
      request('GET', `/v1/publishedLogs?accountId=${accounts.owner}&view=FULL&limit=20`),
    );
    const body = await json(logs.value);
    expect(body.publishedLogs).toHaveLength(20);
    expect(
      body.publishedLogs.every(
        (log: { account: unknown; subject: unknown }) =>
          JSON.stringify(log.account) === JSON.stringify(account) &&
          JSON.stringify(log.subject) === JSON.stringify(summary(f.subjectId)),
      ),
    ).toBe(true);
    expect(logs.capture.statements.filter((sql) => sql.includes('FROM semantic.subject AS s'))).toHaveLength(1);
    expect(
      logs.capture.statements.filter((sql) => sql.includes("CASE WHEN state <> 'deleted' THEN handle")),
    ).toHaveLength(1);
    logCounts.push(logs.capture.statements.length);
  }
  expect(counts[1]).toBe(counts[0]);
  expect(counts[2]).toBe(counts[0]);
  expect(logCounts[1]).toBe(logCounts[0]);
  expect(logCounts[2]).toBe(logCounts[0]);
});

test('version subjects have independent authorization and sessions without a version omit the embedding', async () => {
  const f = await fixture();
  await db.admin.query(
    `INSERT INTO access.resource_denial
    (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
    VALUES ($1,$2,$3,'','subject:read','resource','(,)'::tstzrange,$4)`,
    [routeOf(f.versionSubjectId), f.versionSubjectId, accounts.owner, randomUUID()],
  );
  const full = await json(await request('GET', viewPath(`/v1/progressSessions/${f.session.id}`, 'FULL')));
  expect(full.progressSession.subject).toEqual(summary(f.subjectId));
  expect(full.progressSession.versionSubject).toBeNull();
  expect(JSON.stringify(full)).not.toContain('Embedded version');
  const session = (
    await json(
      await request('POST', '/v1/progressSessions', {
        subjectId: f.subjectId,
        mode: 'scalar_amount',
        unit: 'page',
      }),
      201,
    )
  ).progressSession;
  const plain = await json(await request('GET', viewPath(`/v1/progressSessions/${session.id}`, 'FULL')));
  expect(plain.progressSession.subject).toEqual(summary(f.subjectId));
  expect(plain.progressSession).not.toHaveProperty('versionSubject');
});

test('Space follow summaries use the readable current Space name and conceal denied names', async () => {
  await db.admin.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
    VALUES (0,$1,$2,'space:create','(,)'::tstzrange,$3)`,
    [GLOBAL_CONTEXT, accounts.owner, randomUUID()],
  );
  const space = (await json(await request('POST', '/v1/spaces', { title: 'Named Space' }), 201)).space;
  await json(await request('PUT', `/v1/follows/${space.spaceId}`));
  const path = viewPath(`/v1/follows/${space.spaceId}`, 'FULL');
  const full = await json(await request('GET', path));
  expect(full.follow.target).toEqual({
    id: space.spaceId,
    type: 'space',
    label: 'Named Space',
  });
  expect(full.follow.destination).toEqual({ kind: 'unavailable' });
  expect(full.follow.actions).toEqual({ status: 'unavailable' });
  await db.admin.query(
    `INSERT INTO access.resource_denial
    (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
    VALUES ($1,$2,$3,'','space:read','resource','(,)'::tstzrange,$4)`,
    [routeOf(space.spaceId), space.spaceId, accounts.owner, randomUUID()],
  );
  const hidden = await json(await request('GET', path));
  expect(hidden.follow.target).toBeNull();
  expect(hidden.follow.destination).toEqual({ kind: 'unavailable' });
  expect(hidden.follow.actions).toEqual({ status: 'unavailable' });
  expect(JSON.stringify(hidden)).not.toContain('Named Space');
});

test('FULL Following opens mixed destinations and refreshes a changed Space address', async () => {
  const followed = await fixture();
  await db.admin.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
    VALUES (0,$1,$2,'space:create','(,)'::tstzrange,$3)`,
    [GLOBAL_CONTEXT, accounts.owner, randomUUID()],
  );
  const space = (await json(await request('POST', '/v1/spaces', { title: 'Following home' }), 201)).space;
  await json(await request('PUT', `/v1/follows/${space.spaceId}`));
  const firstAddress = `following-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const first = await json(
    await request('PUT', `/v1/spaces/${space.spaceId}/address`, { address: firstAddress }, 'owner', {
      'if-match': JSON.stringify(space.headRevisionId),
    }),
  );
  const secondAddress = `following-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await json(
    await request('PUT', `/v1/spaces/${space.spaceId}/address`, { address: secondAddress }, 'owner', {
      'if-match': JSON.stringify(first.space.headRevisionId),
    }),
  );

  const response = await request('GET', '/v1/follows?view=FULL&limit=100');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const page = await json(response);
  const subjectRow = page.follows.find((row: { targetId: string }) => row.targetId === followed.subjectId);
  const collectionRow = page.follows.find((row: { targetId: string }) => row.targetId === followed.collection.id);
  const spaceRow = page.follows.find((row: { targetId: string }) => row.targetId === space.spaceId);
  expect(subjectRow.target).toEqual(summary(followed.subjectId));
  expect(collectionRow.target).toEqual({ id: followed.collection.id, type: 'collection', label: 'Books' });
  expect(spaceRow).toMatchObject({
    target: { id: space.spaceId, type: 'space', label: 'Following home' },
    destination: { kind: 'space', spaceId: space.spaceId, address: secondAddress },
    actions: {
      status: 'available',
      resourceType: 'community.space',
      resourceId: space.spaceId,
      viewerActions: expect.arrayContaining([
        expect.objectContaining({ action: 'space:read', operations: expect.any(Array) }),
      ]),
    },
  });
});

test('FULL members preserve private Collection access and interoperate with BASIC cursors', async () => {
  const subjectId = await subject();
  const collection = (
    await json(await request('POST', '/v1/collections', { title: 'Private books', visibility: 'private' }), 201)
  ).collection;
  for (let i = 0; i < 3; i++)
    await json(await request('POST', `/v1/collections/${collection.id}/members`, { subjectId }), 201);
  const path = `/v1/collections/${collection.id}/members?limit=1`;
  const basic = await json(await request('GET', path));
  const full = await json(await request('GET', viewPath(path, 'FULL')));
  expect(full.members).toEqual(basic.members.map((member: object) => ({ ...member, subject: summary(subjectId) })));
  expect(full.next).toBeString();
  const basicAfterFull = await json(await request('GET', `${path}&cursor=${encodeURIComponent(full.next)}`));
  const fullAfterBasic = await json(await request('GET', `${path}&view=FULL&cursor=${encodeURIComponent(basic.next)}`));
  expect(fullAfterBasic.members).toEqual(
    basicAfterFull.members.map((member: object) => ({ ...member, subject: summary(subjectId) })),
  );
  for (const as of ['other', 'anonymous'] as const)
    await json(await request('GET', viewPath(path, 'FULL'), undefined, as), 404);
  await json(await request('GET', `${path}&view=FULL&cursor=invalid`), 400);
});
