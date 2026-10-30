import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createKernelClient } from '@rezics/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import sharp from 'sharp';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { testKernel, type TestKernel } from '../support/test-kernel.ts';
import { issuer, nativeFixture, scopes } from './native-account-bindings-fixture.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
type Person = Awaited<ReturnType<Awaited<ReturnType<typeof nativeFixture>>['person']>> & { handle: string };
let owner: Person;
let other: Person;
let avatar: string;
const links = [{ label: 'Website', url: 'https://example.com/about?hello=world#links' }];
const websiteScopes = [
  'openid',
  'offline_access',
  'account:update',
  'account:manage',
  'organization:create',
  'media:create',
  'media:complete',
  'media:read_reservation',
];

async function call(method: string, path: string, body?: unknown, bearer?: string, key = Bun.randomUUIDv7()) {
  const response = await kernel.handle(
    new Request(`https://kernel.test${path}`, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, status: response.status, body: await response.json() };
}
const patch = (person: { accountId: string }, body: unknown, bearer = owner.bearer, key?: string) =>
  call('PATCH', `/v1/accounts/${person.accountId}`, body, bearer, key);
async function profile(person: { handle: string }, bearer?: string) {
  const read = await call('GET', `/v1/accounts?handle=${person.handle}`, undefined, bearer);
  expect(read.status).toBe(200);
  expect(read.body.accounts).toHaveLength(1);
  return read.body.accounts[0];
}

beforeAll(async () => {
  scopes.push('account:update', 'organization:create');
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await bootstrapRelease(db.pool, bundledRelease);
  auth = await nativeFixture(db.pool);
  kernel = testKernel({
    pool: db.pool,
    auth: {
      issuer,
      audience: 'https://ordinary.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => auth.host.service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
    writeRate: createWriteRateLimiter({
      secret: 'profile-http-test-write-rate-secret-32-bytes',
      overrides: JSON.stringify({
        'new-account': {
          write: { maximum: 100000, seconds: 86400 },
          upload: { maximum: 10000, seconds: 86400 },
        },
      }),
    }),
  });

  // Real confidential website issuance is required by the avatar upload routes.
  const pair = await generateKeyPair('ES256');
  const publicKey = await exportJWK(pair.publicKey);
  const redirect = `${issuer}/website/callback`;
  await auth.host.service.internal.registerWebsiteClient({
    publicJwks: {
      keys: [
        { kty: 'EC', crv: 'P-256', x: publicKey.x!, y: publicKey.y!, kid: 'profile-website', alg: 'ES256', use: 'sig' },
      ],
    },
    redirectUris: [redirect],
    postLogoutRedirectUris: [`${issuer}/`],
    scopes: websiteScopes,
  });
  async function person(handle: string): Promise<Person> {
    const registered = await auth.person(handle);
    const verifier = randomBytes(48).toString('base64url');
    const state = Bun.randomUUIDv7();
    const query = new URLSearchParams({
      client_id: 'rezics-website',
      redirect_uri: redirect,
      response_type: 'code',
      scope: websiteScopes.join(' '),
      state,
      nonce: state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: 'https://ordinary.api.test',
    });
    const authorization = await auth.host.service.handler(
      new Request(`${issuer}/authorize?${query}`, {
        headers: registered.headers,
      }),
    );
    expect([302, 303]).toContain(authorization.status);
    const location = new URL(authorization.headers.get('location')!);
    expect(location.searchParams.get('state')).toBe(state);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'profile-website' })
      .setIssuer('rezics-website')
      .setSubject('rezics-website')
      .setAudience(issuer)
      .setIssuedAt()
      .setExpirationTime('2m')
      .setJti(Bun.randomUUIDv7())
      .sign(pair.privateKey);
    const token = await auth.host.service.handler(
      new Request(`${issuer}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'rezics-website',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: assertion,
          resource: 'https://ordinary.api.test',
          grant_type: 'authorization_code',
          code: location.searchParams.get('code')!,
          redirect_uri: redirect,
          code_verifier: verifier,
        }),
      }),
    );
    expect(token.status).toBe(200);
    const issued = (await token.json()) as { access_token: string };
    return { ...registered, handle: handle.replaceAll('-', '_'), bearer: issued.access_token };
  }
  owner = await person('profile-http-owner');
  other = await person('profile-http-other');
  await bootstrapGovernance(db.pool, owner.accountId);
  // Activation supplies the native self grant; Access still checks every upload.
  for (const person of [owner, other]) {
    const grant = await db.admin.query(
      `SELECT count(*)::int AS count FROM access.resource_grant
       WHERE route=$1 AND resource_id=$2 AND subject_kind='identity'
         AND subject_id=$2 AND subject_role='' AND action='media:create'
         AND valid='(,)'::tstzrange AND valid @> clock_timestamp()`,
      [routeOf(person.accountId), person.accountId],
    );
    expect(grant.rows).toEqual([{ count: 1 }]);
  }
}, 120000);

afterAll(async () => {
  try {
    await auth?.close();
  } finally {
    await db?.close();
  }
});

async function upload(person: Person, stage: 'reserved' | 'uploaded' | 'available' = 'available') {
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
  const requestKey = Bun.randomUUIDv7();
  const reservation = await call(
    'POST',
    '/v1/media',
    {
      containerId: person.accountId,
      purpose: 'avatar',
      mediaType: 'image/png',
      byteCount: bytes.byteLength,
    },
    person.bearer,
    requestKey,
  );
  expect(reservation.status).toBe(201);
  const id = reservation.body.media.id as string;
  if (stage === 'reserved') return id;
  const completion = await call(
    'POST',
    `/v1/media/${id}:complete`,
    {
      containerId: person.accountId,
      reservationRequestId: requestKey,
      byteCount: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    person.bearer,
  );
  expect(completion.status).toBe(200);
  if (stage === 'available') {
    const objects = new Map<string, Uint8Array>([[`m/${id}/original`, bytes]]);
    const storage: MediaStorage = {
      async get(key) {
        return objects.get(key) ?? null;
      },
      async put(key, value) {
        objects.set(key, value);
      },
      async deletePrefix(prefix) {
        for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key);
      },
    };
    expect((await createImageJob(db.pool, storage).process(id)).state).toBe('available');
  }
  return id;
}

test('an account edits its display name biography links and avatar and chooses its public views with one PATCH and the public profile read by handle then returns the new values', async () => {
  avatar = await upload(owner);
  const result = await patch(owner, {
    displayName: 'Profile owner',
    biography: 'A biography',
    links,
    avatar,
    publicViews: { posts: false, reviews: false, collections: false, realms: true },
  });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ accountId: owner.accountId });
  expect(result.response.headers.get(SESSION_HEADER)).toBeString();
  expect(result.response.headers.get('cache-control')).toBe('private, no-store');
  const expected = {
    displayName: 'Profile owner',
    bio: 'A biography',
    links,
    avatar: { media: avatar, width: 64, height: 64, credit: null },
    publicViews: { posts: false, reviews: false, collections: false, realms: true },
  };
  for (const bearer of [undefined, owner.bearer, other.bearer])
    expect(await profile(owner, bearer)).toMatchObject(expected);
  const identity = await call('GET', `/v1/accounts?ids=${owner.accountId}`);
  expect(Object.keys(identity.body.accounts[0]).sort()).toEqual([
    'automated',
    'displayName',
    'handle',
    'id',
    'kind',
    'operatorId',
    'state',
  ]);
});

test('fields left out of the patch keep their values and a null clears a nullable field', async () => {
  const before = await profile(owner);
  expect((await patch(owner, { biography: null, publicViews: { reviews: true } })).status).toBe(200);
  expect(await profile(owner)).toEqual({
    ...before,
    bio: null,
    publicViews: { ...before.publicViews, reviews: true },
  });
  expect((await patch(owner, { displayName: null, avatar: null, links: [] })).status).toBe(200);
  expect(await profile(owner)).toMatchObject({ displayName: null, avatar: null, bio: null, links: [] });
});

test("the operator of an automated account edits that account's profile", async () => {
  const bot = await auth.automated('profile-http-bot', other);
  const result = await patch(
    bot,
    { displayName: 'Automated profile', biography: 'Operated biography', links },
    other.bearer,
  );
  expect(result.status).toBe(200);
  expect(await profile({ handle: 'profile_http_bot' })).toMatchObject({
    displayName: 'Automated profile',
    bio: 'Operated biography',
    links,
    automated: true,
    operatorId: other.accountId,
  });
  expect((await patch(bot, { displayName: 'Intruder' }, owner.bearer)).status).toBe(403);
});

test("another account and an anonymous request change nothing and are refused as today's account commands refuse them", async () => {
  const before = await profile(owner);
  for (const [bearer, status, code] of [
    [other.bearer, 403, 'forbidden'],
    [undefined, 401, 'authentication_required'],
  ] as const) {
    const result = await call(
      'PATCH',
      `/v1/accounts/${owner.accountId}`,
      { displayName: 'Intruder', biography: 'Changed' },
      bearer,
    );
    expect(result.status).toBe(status);
    expect(result.body).toMatchObject({ code, effect_status: 'not_applied' });
    expect(await profile(owner)).toEqual(before);
  }
});

test('speakersListed is accepted only for an organization', async () => {
  const before = await profile(other);
  const invalid = await patch(other, { displayName: 'Must roll back', speakersListed: true }, other.bearer);
  expect(invalid.status).toBe(400);
  expect(invalid.body).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
  expect(await profile(other)).toEqual(before);
  const key = 'profile-http-organization';
  const operation = { kind: 'organization' as const, handle: key, authorization: 'request' };
  const approval = await auth.approval().approve(
    other.bearer,
    { operationKey: key, operation },
    {
      pool: db.pool,
      deadline: Date.now() + 30000,
    },
  );
  const org = await auth.host.workflows.createOrganization({ key, handle: key, authorization: approval.reference });
  expect((await patch(org, { displayName: 'Organization', speakersListed: true }, other.bearer)).status).toBe(200);
  expect(await profile({ handle: key })).toMatchObject({ displayName: 'Organization', speakersListed: true });
  expect((await patch(org, { speakersListed: false }, other.bearer)).status).toBe(200);
  expect(await profile({ handle: key })).toMatchObject({ speakersListed: false });
});

test("an avatar that is not the account's own completed media and any unknown field or invalid value answer 400 invalid_request with no change", async () => {
  const before = await profile(owner);
  const badMedia = [
    newId(routeOf(owner.accountId)!),
    await upload(other),
    await upload(owner, 'reserved'),
    await upload(owner, 'uploaded'),
  ];
  const invalid: unknown[] = [
    {},
    null,
    [],
    { avatarUrl: 'https://example.com/avatar' },
    { birthDate: '2000-01-01' },
    { contentPreferences: {} },
    { extra: true },
    { displayName: 5 },
    { displayName: 'a'.repeat(4097) },
    { biography: false },
    { biography: '😀'.repeat(2049) },
    { avatar: 'invalid' },
    { avatar: 1 },
    { publicViews: null },
    { publicViews: [] },
    { publicViews: { unknown: true } },
    { publicViews: { posts: 1 } },
    { speakersListed: null },
    { links: null },
    { links: {} },
    { links: Array(6).fill(links[0]) },
    ...[
      { label: '', url: 'https://example.com' },
      { label: 'a'.repeat(65), url: 'https://example.com' },
      { label: 'Site', url: '/relative' },
      { label: 'Site', url: 'http://example.com' },
      { label: 'Site', url: 'https://user:secret@example.com' },
      { label: 'Site', url: 'https://@example.com' },
      { label: 'Site', url: `https://example.com/${'a'.repeat(2048)}` },
      { label: 'Site', url: 'https://' },
      { label: 'Site', url: 'https://[bad]' },
      { label: 'Site', url: 'https://example.com/\n' },
      { label: 'Site', url: 'https://example.com', extra: true },
    ].map((link) => ({ links: [link] })),
    ...badMedia.map((avatar) => ({ avatar })),
  ];
  for (const body of invalid) {
    const value =
      body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length
        ? { displayName: 'Must not change', ...body }
        : body;
    const result = await patch(owner, value);
    expect([value, result.status, result.body.code]).toEqual([value, 400, 'invalid_request']);
    expect(await profile(owner)).toEqual(before);
  }
  // Boundary values and empty nested merges are valid.
  const maximum = Array.from({ length: 5 }, (_, i) => ({ label: '😀'.repeat(64), url: `https://example.com/${i}` }));
  expect((await patch(owner, { links: maximum, publicViews: {}, biography: 'a'.repeat(4096) })).status).toBe(200);
  expect(await profile(owner)).toMatchObject({ links: maximum, bio: 'a'.repeat(4096) });
});

async function events(accountId: string, type: string) {
  return (await db.admin.query('SELECT data FROM core.outbox WHERE subject=$1 AND type=$2', [accountId, type])).rows;
}
test('a retried request with the same idempotency key applies once', async () => {
  const key = Bun.randomUUIDv7();
  const type = 'com.rezics.access.account-updated.v1';
  const before = (await events(owner.accountId, type)).length;
  const body = { displayName: 'Replay once' };
  const first = await patch(owner, body, owner.bearer, key);
  const second = await patch(owner, body, owner.bearer, key);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(second.body).toEqual(first.body);
  expect((await events(owner.accountId, type)).length).toBe(before + 1);
  const conflict = await patch(owner, { displayName: 'Conflict' }, owner.bearer, key);
  expect(conflict.status).toBe(422);
  expect(conflict.body.code).toBe('idempotency_conflict');
  expect(await profile(owner)).toMatchObject(body);
});

test('the display-name-changed event is emitted only when the display name changes', async () => {
  const type = 'com.rezics.access.account-display-name-changed.v1';
  const before = (await events(owner.accountId, type)).length;
  for (const body of [{ biography: 'Only biography' }, { displayName: 'Replay once' }])
    expect((await patch(owner, body)).status).toBe(200);
  expect((await events(owner.accountId, type)).length).toBe(before);
  expect((await patch(owner, { displayName: 'Changed name' })).status).toBe(200);
  expect(await events(owner.accountId, type)).toHaveLength(before + 1);
  expect((await patch(owner, { displayName: null })).status).toBe(200);
  expect(await events(owner.accountId, type)).toHaveLength(before + 2);
});

test('the served OpenAPI and the generated client list the operation', async () => {
  const document = await call('GET', '/v1/openapi.json', undefined, owner.bearer);
  expect(document.status).toBe(200);
  expect(document.body.paths['/v1/accounts/{accountId}'].patch).toMatchObject({
    operationId: 'account.update',
    'x-action': 'account:update',
    security: [{ bearerAuth: [] }],
  });
  const client = createKernelClient('https://kernel.test', {
    fetch: ((input, init) => kernel.handle(new Request(input, init))) as typeof fetch,
    headers: { authorization: `Bearer ${owner.bearer}`, 'idempotency-key': JSON.stringify(Bun.randomUUIDv7()) },
  });
  const result = await client
    .accounts({ accountId: owner.accountId })
    .patch({ biography: 'Generated client' }, { headers: { 'idempotency-key': JSON.stringify(Bun.randomUUIDv7()) } });
  expect(result.status).toBe(200);
  expect(result.data).toEqual({ accountId: owner.accountId });
  expect(await profile(owner)).toMatchObject({ bio: 'Generated client' });
});

test('the update stays within its bound as accounts grow', async () => {
  const route = routeOf(owner.accountId)!;
  const report = await checkGrowth(db, {
    name: 'HTTP account profile update',
    scales: [64, 512, 4096],
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const ids = Array.from({ length: scale - previous }, () => newId(route));
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
        SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) seed(id)`,
        [route, ids],
      );
    },
    async operation(_database, _scale, repetition) {
      const result = await patch(owner, { displayName: `Growth ${repetition}`, avatar, publicViews: { posts: true } });
      expect(result.status).toBe(200);
    },
  });
  expect(report.samples).toHaveLength(3);
  for (const { cost } of report.samples) {
    expect(cost.statements).toBeGreaterThan(0);
    expect(cost.rows).toBeGreaterThan(0);
    expect(cost.blocks).toBeGreaterThan(0);
  }
}, 120000);
