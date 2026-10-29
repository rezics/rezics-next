import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import type { CollectionView, MemberView } from '../../src/library/collection-reads.ts';
import { syncSubjectListing } from '../../src/library/listing.ts';
import { libraryWorkModule } from '../../src/library/work-module.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { decodeCursor, encodeCursor } from '../../src/tokens/cursor.ts';
import { nativeFixture, cookies, password } from '../access/native-account-bindings-fixture.ts';
import { testKernel, registerTestClient } from '../support/test-kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const owner = newId(0x6c31);
const other = newId(0x6c31);
const suspended = newId(0x6c31);
const unknown = newId(0x6c31);
const routeKey = new Uint8Array(32).fill(73);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(74)]]) };
const scopes = [
  'collection:create',
  'collection:read',
  'collection:update',
  'collection:delete',
  'subject:read',
  'exposure:open',
];
const credentials = new Map<string, string>();
type Persona = 'owner' | 'other' | 'suspended' | 'anonymous';
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let subjectId: string;
let suspendedCollection: CollectionView;

async function request(
  method: string,
  path: string,
  body?: unknown,
  as: Persona = 'owner',
  key: string | null = randomUUID(),
) {
  const account = as === 'owner' ? owner : as === 'other' ? other : as === 'suspended' ? suspended : null;
  return app.handle(
    new Request(`https://kernel.test${path}`, {
      method,
      headers: {
        ...(account ? { authorization: `Bearer ${credentials.get(account)!}` } : {}),
        ...(method !== 'GET' && key !== null ? { 'idempotency-key': JSON.stringify(key) } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return response.json() as Promise<T>;
}
async function problem(response: Response, status: number, code: string) {
  expect(response.headers.get('content-type')).toStartWith('application/problem+json');
  const { request_id: requestId, ...stable } = await json<Record<string, unknown>>(response, status);
  expect(requestId).toBeString();
  expect({ ...stable }).toMatchObject({
    code,
    status,
    type: `https://rezics.com/problems/${code}`,
    title: expect.any(String),
  });
  return stable;
}
async function collection(visibility: 'private' | 'public' | 'unlisted' = 'private', as: Persona = 'owner') {
  return (
    await json<{ collection: CollectionView }>(
      await request(
        'POST',
        '/v1/collections',
        {
          title: 'Shelf',
          description: 'Curated books',
          visibility,
        },
        as,
      ),
      201,
    )
  ).collection;
}
const path = (id: string) => `/v1/collections/${id}`;
const members = (id: string) => `${path(id)}/members`;
async function add(id: string, extras: { after?: string | null; note?: string } = {}) {
  return (await json<{ member: MemberView }>(await request('POST', members(id), { subjectId, ...extras }), 201)).member;
}
type SubjectCollectionCount = { value: number; exact: true };
type CollectionPage<T> = { items: T[]; next: string | null; count?: SubjectCollectionCount };
async function page<T>(
  url: string,
  plural: string,
  as: Persona = 'owner',
  extraKeys: readonly string[] = [],
): Promise<CollectionPage<T>> {
  const result = await json<Record<string, unknown>>(await request('GET', url, undefined, as));
  expect(Object.keys(result).sort()).toEqual([plural, 'next', ...extraKeys].sort());
  let count: Record<string, unknown> | undefined;
  if (extraKeys.includes('count')) {
    expect(result.count).not.toBeNull();
    expect(result.count).toBeDefined();
    count = result.count as Record<string, unknown>;
    expect(count.exact).toBe(true);
    expect(Number.isInteger(count.value) && (count.value as number) >= 0).toBe(true);
  }
  return {
    items: result[plural] as T[],
    next: result.next as string | null,
    ...(count ? { count: count as SubjectCollectionCount } : {}),
  };
}
async function all<T>(
  url: string,
  plural: string,
  as: Persona = 'owner',
  options: { extraKeys?: readonly string[]; countMatchesItems?: boolean } = {},
) {
  const items: T[] = [];
  let count: SubjectCollectionCount | undefined;
  let cursor: string | null = null;
  do {
    const result: CollectionPage<T> = await page<T>(
      `${url}${url.includes('?') ? '&' : '?'}limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      plural,
      as,
      options.extraKeys,
    );
    if (result.count) {
      if (count) expect(result.count).toEqual(count);
      count = result.count;
    }
    items.push(...result.items);
    cursor = result.next;
  } while (cursor);
  if (options.countMatchesItems) expect(count?.value).toBe(items.length);
  return items;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'collections', alg: 'ES256' };
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.collections.test',
          audience: 'https://api.rezics.test',
          jwksUrl: 'https://auth.collections.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
  });
  for (const id of [owner, other, suspended]) {
    await db.admin.query(
      `INSERT INTO access.account
      (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
      VALUES ($1,$2,'actor','active',$2,false,1,true)`,
      [routeOf(id), id],
    );
    credentials.set(
      id,
      await new SignJWT({
        client_id: 'web',
        scope: scopes.join(' '),
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'collections', typ: 'at+jwt' })
        .setIssuer('https://auth.collections.test')
        .setAudience('https://api.rezics.test')
        .setSubject(id)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signing.privateKey),
    );
  }
  await bootstrapGovernance(db.pool, owner);
  await json(await request('POST', '/v1/platform/exposure/collections:open'), 200);
  const requestKey = randomUUID();
  const actor: AccountActor = {
    kind: 'account',
    accountId: owner,
    clientId: 'web',
    scopes,
    requestedBy: null,
    authnEpoch: 1,
  };
  const subject = await createSubject(db.pool, {
    actor,
    target: subjectTarget(routeKey, owner, requestKey),
    idempotencyKey: requestKey,
    digest: createHash('sha256').update(requestKey).digest(),
    item: { type: 'schema:Book', labels: { en: 'Collection HTTP subject' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  subjectId = subject.subject.id;
  // The command module owns a second real pool. Include its SQL in the shared capture.
  const NativePool = pg.Pool;
  pg.Pool = class extends NativePool {
    constructor(config?: pg.PoolConfig) {
      super(config);
      pg.Pool = NativePool;
      return db.openPool(config);
    }
  };
  try {
    suspendedCollection = await collection('private', 'suspended');
  } finally {
    pg.Pool = NativePool;
  }
  await db.admin.query("UPDATE access.account SET state='suspended' WHERE account_id=$1", [suspended]);
});
afterAll(async () => {
  await db?.close();
});

test('all Collection routes mount once and declare their exposure, actions and creation resource type in OpenAPI', () => {
  const document = openApiDocument(app);
  const expected = {
    '/v1/collections': ['get', 'post'],
    '/v1/collections/{collectionId}': ['get', 'patch', 'delete'],
    '/v1/collections/{collectionId}/members': ['get', 'post'],
    '/v1/collections/{collectionId}/members/{memberId}': ['patch', 'delete'],
    '/v1/collections/{collectionId}/members/{memberId}:move': ['post'],
    '/v1/subjects/{id}/collections': ['get'],
  };
  for (const [url, methods] of Object.entries(expected))
    for (const method of methods) {
      expect(document.paths[url]?.[method]?.['x-exposure']).toBe('gate:collections');
    }
  expect(document.paths['/v1/collections']?.post?.['x-resource-types']).toEqual(['library.collection']);
  expect(new Set(app.routes.map((route) => `${route.method} ${route.path}`)).size).toBe(app.routes.length);
  for (const action of scopes.slice(0, 4)) expect(actionCatalogue(app).has(action)).toBe(true);
});

test('curator creates replays updates conflicts and deletes with only the contracted public view', async () => {
  const key = randomUUID();
  const draft = { title: 'First', visibility: 'private' };
  const created = await json<{ collection: CollectionView }>(
    await request('POST', '/v1/collections', draft, 'owner', key),
    201,
  );
  const shelf = created.collection;
  expect(shelf).toEqual({
    id: expect.any(String),
    curatorAccountId: owner,
    title: 'First',
    description: null,
    visibility: 'private',
    revision: 1,
    memberCount: 0,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });
  expect(await json(await request('POST', '/v1/collections', draft, 'owner', key), 201)).toEqual(created);
  await problem(
    await request('POST', '/v1/collections', { ...draft, title: 'Changed' }, 'owner', key),
    422,
    'idempotency_conflict',
  );
  expect(await json(await request('GET', path(shelf.id)))).toEqual(created);
  const changed = (
    await json<{ collection: CollectionView }>(
      await request('PATCH', path(shelf.id), {
        revision: 1,
        title: 'Revised',
        description: 'New description',
        visibility: 'public',
      }),
    )
  ).collection;
  expect(changed).toMatchObject({
    ...shelf,
    title: 'Revised',
    description: 'New description',
    visibility: 'public',
    revision: 2,
    updatedAt: expect.any(String),
  });
  await problem(await request('PATCH', path(shelf.id), { revision: 1, title: 'Lost' }), 409, 'conflict');
  await problem(await request('DELETE', `${path(shelf.id)}?revision=1`), 409, 'conflict');
  expect(await json(await request('GET', path(shelf.id)))).toEqual({ collection: changed });
  const deleted = await request('DELETE', `${path(shelf.id)}?revision=2`);
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe('');
  const deletedProblem = await problem(await request('GET', path(shelf.id)), 404, 'not_found');
  const unknownProblem = await problem(await request('GET', path(unknown)), 404, 'not_found');
  expect(deletedProblem).toEqual(unknownProblem);
});

test('members support duplicate subjects first after last moves notes removal and cursor pages', async () => {
  const shelf = await collection('public');
  const a = await add(shelf.id, { note: 'Original' });
  const b = await add(shelf.id);
  const first = await add(shelf.id, { after: null });
  const middle = await add(shelf.id, { after: a.id });
  expect(a).toEqual({ id: expect.any(String), subjectId, note: 'Original', addedAt: expect.any(String) });
  expect(await all(members(shelf.id), 'members')).toEqual([first, a, middle, b]);
  await json(await request('POST', `${members(shelf.id)}/${b.id}:move`, { after: first.id }));
  await json(await request('PATCH', `${members(shelf.id)}/${a.id}`, { note: 'Revised' }));
  await json(await request('PATCH', `${members(shelf.id)}/${middle.id}`, { note: null }));
  const deleted = await request('DELETE', `${members(shelf.id)}/${middle.id}`);
  expect([200, 204]).toContain(deleted.status);
  const expected = [first, b, { ...a, note: 'Revised' }];
  for (const as of ['owner', 'other', 'anonymous'] as const)
    expect(await all(members(shelf.id), 'members', as)).toEqual(expected);
  expect(
    (await json<{ collection: CollectionView }>(await request('GET', path(shelf.id)))).collection.memberCount,
  ).toBe(3);
  await problem(await request('POST', `${members(shelf.id)}/${b.id}:move`, { after: unknown }), 404, 'not_found');
  await problem(await request('PATCH', `${members(shelf.id)}/${unknown}`, { note: 'Unknown' }), 404, 'not_found');
  await problem(await request('DELETE', `${members(shelf.id)}/${unknown}`), 404, 'not_found');
});

test('private and unknown reads have identical problems while unlisted and public reads admit other and anonymous', async () => {
  const shelves = [await collection('private'), await collection('unlisted'), await collection('public')];
  const [hidden, unlisted, visible] = shelves as [CollectionView, CollectionView, CollectionView];
  for (const as of ['other', 'anonymous'] as const) {
    for (const id of [unlisted.id, visible.id])
      expect(await json(await request('GET', path(id), undefined, as))).toEqual({
        collection: shelves.find((shelf) => shelf.id === id),
      });
    for (const url of [path, members]) {
      const hiddenProblem = await problem(await request('GET', url(hidden.id), undefined, as), 404, 'not_found');
      const unknownProblem = await problem(await request('GET', url(unknown), undefined, as), 404, 'not_found');
      expect(hiddenProblem).toEqual(unknownProblem);
    }
    const listed = await all<CollectionView>(`/v1/collections?curatorAccountId=${owner}`, 'collections', as);
    expect(listed.some((shelf) => shelf.id === visible.id)).toBe(true);
    expect(listed.every((shelf) => shelf.visibility === 'public')).toBe(true);
  }
  const listed = await all<CollectionView>(`/v1/collections?curatorAccountId=${owner}`, 'collections');
  for (const shelf of shelves) expect(listed).toContainEqual(shelf);
});

test('another account and suspended credentials cannot change Collections or members', async () => {
  for (const shelf of [await collection(), await collection('public'), suspendedCollection]) {
    const item = shelf === suspendedCollection ? null : await add(shelf.id);
    const target = item?.id ?? unknown;
    const attempts: [string, string, unknown?][] = [
      ['POST', members(shelf.id), { subjectId }],
      ['PATCH', path(shelf.id), { revision: shelf.revision, title: 'Stolen' }],
      ['DELETE', `${path(shelf.id)}?revision=${shelf.revision}`],
      ['PATCH', `${members(shelf.id)}/${target}`, { note: 'Stolen' }],
      ['POST', `${members(shelf.id)}/${target}:move`, { after: null }],
      ['DELETE', `${members(shelf.id)}/${target}`],
    ];
    const snapshot = async () =>
      (await db.admin.query(`SELECT row_to_json(c) AS row FROM library.collection c ORDER BY collection_id`)).rows;
    const before = await snapshot();
    for (const as of ['other', 'suspended', 'anonymous'] as const)
      for (const [method, url, body] of attempts) {
        const response = await request(method, url, body, as);
        expect(as === 'other' ? [403, 404] : [401, 403]).toContain(response.status);
        expect(response.headers.get('content-type')).toStartWith('application/problem+json');
      }
    expect(await snapshot()).toEqual(before);
  }
  expect([401, 403]).toContain(
    (await request('POST', '/v1/collections', { title: 'Denied', visibility: 'public' }, 'suspended')).status,
  );
});

test('closed bodies malformed identifiers missing keys and invalid pagination fail safely', async () => {
  const shelf = await collection();
  const item = await add(shelf.id);
  const invalid: [string, string, unknown?][] = [
    ['POST', '/v1/collections', { title: 'Invalid', visibility: 'public', curatorAccountId: other }],
    ['POST', '/v1/collections', { title: '', visibility: 'public' }],
    ['POST', '/v1/collections', { title: 'Invalid', visibility: 'secret' }],
    ['PATCH', path(shelf.id), { revision: 1, extra: true }],
    ['PATCH', path(shelf.id), { title: 'No revision' }],
    ['DELETE', path(shelf.id)],
    ['POST', members(shelf.id), { subjectId, extra: true }],
    ['PATCH', `${members(shelf.id)}/${item.id}`, { note: 'Note', extra: true }],
    ['POST', `${members(shelf.id)}/${item.id}:move`, {}],
    ['POST', `${members(shelf.id)}/${item.id}:move`, { after: null, extra: true }],
  ];
  for (const [method, url, body] of invalid) await problem(await request(method, url, body), 400, 'invalid_request');
  for (const [method, url, body] of [
    ['POST', '/v1/collections', { title: 'No key', visibility: 'public' }],
    ['PATCH', path(shelf.id), { revision: 1, title: 'No key' }],
    ['DELETE', `${path(shelf.id)}?revision=1`],
    ['POST', members(shelf.id), { subjectId }],
    ['PATCH', `${members(shelf.id)}/${item.id}`, { note: null }],
    ['DELETE', `${members(shelf.id)}/${item.id}`],
    ['POST', `${members(shelf.id)}/${item.id}:move`, { after: null }],
  ] as const)
    await problem(await request(method, url, body, 'owner', null), 400, 'invalid_request');
  for (const url of [path('malformed'), members('malformed'), '/v1/subjects/malformed/collections']) {
    const malformedProblem = await problem(await request('GET', url), 404, 'not_found');
    const unknownProblem = await problem(await request('GET', path(unknown)), 404, 'not_found');
    expect(malformedProblem).toEqual(unknownProblem);
  }
  await problem(await request('POST', members(shelf.id), { subjectId: 'malformed' }), 404, 'not_found');
  for (const url of [
    members(shelf.id),
    `/v1/collections?curatorAccountId=${owner}`,
    `/v1/subjects/${subjectId}/collections`,
  ]) {
    for (const limit of [0, 101, 1.5])
      await problem(
        await request('GET', `${url}${url.includes('?') ? '&' : '?'}limit=${limit}`),
        400,
        'invalid_request',
      );
    await problem(await request('GET', `${url}${url.includes('?') ? '&' : '?'}cursor=tampered`), 400, 'invalid_cursor');
  }
});

test('full Collections and stale member cursors produce 409 problems without applying changes', async () => {
  const shelf = await collection();
  await add(shelf.id);
  await add(shelf.id);
  const first = await page<MemberView>(`${members(shelf.id)}?limit=1`, 'members');
  expect(first.next).toBeString();
  const binding = { operation: 'library.collection.members', parameters: { collectionId: shelf.id } };
  const decoded = decodeCursor(tokens, binding, first.next!);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error('Expected a valid member cursor');
  const stale = encodeCursor(tokens, binding, { epoch: decoded.epoch + 1, after: decoded.after });
  await problem(await request('GET', `${members(shelf.id)}?cursor=${encodeURIComponent(stale)}`), 409, 'stale_cursor');
  await db.admin.query('UPDATE library.collection SET member_count=5000 WHERE collection_id=$1', [shelf.id]);
  await problem(await request('POST', members(shelf.id), { subjectId }), 409, 'collection_full');
  expect((await all(members(shelf.id), 'members')).length).toBe(2);
});

test('the anonymous subject page exposes only current public Collections with multiplicity', async () => {
  const shelf = await collection('public');
  await add(shelf.id);
  await add(shelf.id);
  await syncSubjectListing({ pool: db.pool }, { subjectId, collectionId: shelf.id });
  const expected = { id: shelf.id, curatorAccountId: owner, title: shelf.title, multiplicity: 2 };
  expect(
    await all(`/v1/subjects/${subjectId}/collections`, 'collections', 'anonymous', {
      extraKeys: ['count'],
      countMatchesItems: true,
    }),
  ).toContainEqual(expected);
  await json(await request('PATCH', path(shelf.id), { revision: shelf.revision, visibility: 'private' }));
  // The source command publishes an event, and cross-home publication completes in native work.
  const workClient = await createWorkClient(db.url);
  const worker = await composeWork([libraryWorkModule], {
    databaseUrl: db.url,
    pool: db.pool,
    client: workClient,
    env: {},
  });
  try {
    await worker.launch();
    const row = (
      await db.admin.query(
        "SELECT * FROM core.outbox WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.library.collection.listing.changed.v1' ORDER BY position DESC LIMIT 1",
        [routeOf(shelf.id)! >> 4, shelf.id],
      )
    ).rows[0]!;
    const event: CloudEvent = {
      specversion: '1.0',
      id: row.id,
      source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
      type: row.type,
      subject: shelf.id,
      time: row.recorded_at.toISOString(),
      sequence: String(row.position).padStart(19, '0'),
      datacontenttype: 'application/json',
      data: row.data,
    };
    await (
      await workClient.enqueue(
        {
          workflowName: 'effect',
          queueName: 'effects',
          queuePartitionKey: String(row.partition_no),
          workflowID: randomUUID(),
        },
        'library_collection_listing',
        event,
      )
    ).getResult({ pollingIntervalMs: 10 });
    await workClient.retrieveWorkflow(event.id).getResult({ pollingIntervalMs: 10 });
  } finally {
    await worker.shutdown();
    await workClient.close();
  }
  expect(
    await all(`/v1/subjects/${subjectId}/collections`, 'collections', 'anonymous', { extraKeys: ['count'] }),
  ).not.toContainEqual(expected);
  await problem(await request('GET', `/v1/subjects/${unknown}/collections`, undefined, 'anonymous'), 404, 'not_found');
});

test('add-member requests and member pages keep equal statements across three unrelated data scales', async () => {
  const shelf = await collection('public');
  await add(shelf.id);
  await add(shelf.id);
  const adds: number[] = [],
    pages: number[] = [];
  let previous = 0;
  for (const scale of [1, 8, 64]) {
    for (let n = previous; n < scale; n++) {
      const unrelated = await collection();
      await add(unrelated.id);
    }
    previous = scale;
    const added = await capture(db, () => add(shelf.id));
    expect(
      added.capture.statements.some((statement) => /INSERT INTO library\.collection_member/i.test(statement)),
    ).toBe(true);
    const paged = await capture(db, () => page(`${members(shelf.id)}?limit=1`, 'members'));
    adds.push(added.capture.statements.length);
    pages.push(paged.capture.statements.length);
  }
  expect(adds[0]).toBeGreaterThan(0);
  expect(pages[0]).toBeGreaterThan(0);
  expect(new Set(adds).size).toBe(1);
  expect(new Set(pages).size).toBe(1);
});

test('native Auth suspension rejects the old Collection bearer and sign-in without hiding anonymous known-ID public reads', async () => {
  const native = await openGrowthDatabase();
  const auth = await nativeFixture(native.pool);
  try {
    const service = auth.host.service;
    const kernel = testKernel({
      pool: native.pool,
      auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
      writeRate: createWriteRateLimiter({ secret: 'collection-native-auth-regression-secret' }),
    });
    const actions = [...actionCatalogue(kernel).keys()];
    await registerTestClient(service, { clientId: 'collections-native', firstParty: true, scopes: actions });
    const root = await auth.person(`root_${randomUUID().replaceAll('-', '')}`);
    const curator = await auth.person(`curator_${randomUUID().replaceAll('-', '')}`);
    await bootstrapGovernance(native.pool, root.accountId);
    async function issue(accountId: string) {
      const signed = await auth.request('/signin', {
        account_id: accountId,
        password,
        client_id: 'collections-native',
        scope: actions,
      });
      expect(signed.status).toBe(200);
      const issued = await auth.request('/token', {}, cookies(signed));
      expect(issued.status).toBe(200);
      return ((await issued.json()) as { access_token: string }).access_token;
    }
    const rootBearer = await issue(root.accountId);
    const curatorBearer = await issue(curator.accountId);
    const call = (bearer: string | null, method: string, path: string, body?: unknown) =>
      kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers: {
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(randomUUID()),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    expect((await call(rootBearer, 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
    await bootstrapRelease(native.pool, bundledRelease);
    expect(
      (
        await call(rootBearer, 'POST', '/v1/grants', {
          resource: PLATFORM_RESOURCE,
          subject: { kind: 'active_accounts' },
          actions: ['subject:create'],
          valid: '(,)',
        })
      ).status,
    ).toBe(201);
    const createdSubject = await call(rootBearer, 'POST', '/v1/subjects', {
      type: 'schema:Book',
      labels: { en: 'Native curator discovery' },
    });
    expect(createdSubject.status).toBe(201);
    const subjectId = ((await createdSubject.json()) as { subject: { id: string } }).subject.id;
    const ids: string[] = [];
    for (const visibility of ['public', 'unlisted', 'private']) {
      const response = await call(curatorBearer, 'POST', '/v1/collections', {
        title: `Native ${visibility}`,
        visibility,
      });
      expect(response.status).toBe(201);
      ids.push(((await response.json()) as { collection: CollectionView }).collection.id);
    }
    expect((await call(curatorBearer, 'POST', `/v1/collections/${ids[0]}/members`, { subjectId })).status).toBe(201);
    await syncSubjectListing({ pool: native.pool }, { subjectId, collectionId: ids[0]! });
    expect((await (await call(null, 'GET', `/v1/subjects/${subjectId}/collections`)).json()).collections).toHaveLength(
      1,
    );
    expect(
      (
        await call(rootBearer, 'POST', `/v1/accounts/${curator.accountId}:suspend`, {
          reason: 'Native Collection regression',
        })
      ).status,
    ).toBe(200);
    for (const path of [
      `/v1/collections/${ids[0]}`,
      `/v1/collections/${ids[1]}`,
      `/v1/collections?curatorAccountId=${curator.accountId}`,
    ]) {
      const refused = await call(curatorBearer, 'GET', path);
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
      expect((await refused.json()).code).toBe('invalid_credentials');
    }
    for (const id of ids.slice(0, 2)) expect((await call(null, 'GET', `/v1/collections/${id}`)).status).toBe(200);
    expect((await call(null, 'GET', `/v1/collections/${ids[2]}`)).status).toBe(404);
    const discovery = await call(null, 'GET', `/v1/collections?curatorAccountId=${curator.accountId}`);
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toEqual({ collections: [], next: null });
    const publicSubjectPage = await call(null, 'GET', `/v1/subjects/${subjectId}/collections`);
    expect(publicSubjectPage.status).toBe(200);
    expect((await publicSubjectPage.json()).collections).toEqual([]);
    const sessions = async () =>
      (await auth.authPool.query('SELECT id FROM session WHERE "userId"=$1 ORDER BY id', [curator.accountId])).rows;
    const before = await sessions();
    const refused = await auth.request('/signin', {
      account_id: curator.accountId,
      password,
      client_id: 'collections-native',
      scope: actions,
    });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).toContain('ACCOUNT_SUSPENDED');
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(await sessions()).toEqual(before);
    const wrong = await auth.request('/signin', {
      account_id: curator.accountId,
      password: 'wrong password',
      client_id: 'collections-native',
      scope: actions,
    });
    expect(wrong.status).toBe(401);
    expect(await sessions()).toEqual(before);
  } finally {
    await auth.close();
    await native.close();
  }
}, 180_000);
