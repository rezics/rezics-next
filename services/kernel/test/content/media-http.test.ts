import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernelClient } from '../../../../packages/client/src/index.ts';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument, isProblemSchema } from '../../src/http/openapi.ts';
import { actionCatalogue, SESSION_HEADER } from '../../src/http/request.ts';
import { type Access, type AccountActor } from '../../src/request/access.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { decideDownload } from '../../src/content/media.ts';
import { capture, checkGrowth, openGrowthDatabase, seed } from '../support/growth.ts';
import { assertGrowthPointPlans } from './support/media-fixtures.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;
const route = 0x4312;
const board = newId(0x9876);
const thread = newId(route);
const hash = 'a'.repeat(64);
const derivativeHash = 'b'.repeat(64);
const scopes = [
  'media:create',
  'media:complete',
  'media:read_reservation',
  'media:read',
  'thread:read',
  'post:read',
  'board:read',
];
const owner: AccountActor = {
  kind: 'account',
  accountId: newId(0x1234),
  clientId: 'rezics-website',
  scopes,
  requestedBy: null,
  authnEpoch: 1,
};
const identities = new Map<string, AccountActor>([
  ['owner', owner],
  ['other', { ...owner, accountId: newId(0x2345) }],
  ['ordinary', { ...owner, scopes: scopes.filter((s) => s !== 'media:complete') }],
  ['other-client', { ...owner, clientId: 'other-client' }],
  ['zero', { ...owner, accountId: newId(0x3456), scopes: [] }],
]);
let access: Access;
let signingKey: CryptoKey;
const issuer = 'https://media-auth.example.test';
async function bearer(name: string) {
  const actor = identities.get(name)!;
  return new SignJWT({
    client_id: actor.clientId,
    scope: actor.scopes.join(' '),
    authn_epoch: actor.authnEpoch,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'media-http' })
    .setIssuer(issuer)
    .setAudience('https://kernel.test')
    .setSubject(actor.accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
}
async function grant(subject: string, action: string, id = thread) {
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,$4,'(,)',$3) ON CONFLICT DO NOTHING`,
    [routeOf(id), id, subject, action],
  );
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1; // Independently anchored reads must release before the next checkout.
  for (const id of new Set([...identities.values()].map((actor) => actor.accountId)))
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
  await db.admin.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Images','published',1,$3)`,
    [routeOf(board), board, owner.accountId],
  );
  await db.admin.query(
    `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,'Images','published',1,$3)`,
    [route, thread, owner.accountId, board],
  );
  await grant(owner.accountId, 'media:create');
  const pair = await generateKeyPair('ES256');
  signingKey = pair.privateKey;
  const publicKey = {
    ...(await exportJWK(pair.publicKey)),
    kid: 'media-http',
    alg: 'ES256',
    use: 'sig',
  };
  // Exercise native JWT verification, account anchoring, Access and rate identity.
  // The website code/PKCE/private_key_jwt issuance port is absent from current Auth exports.
  access = createAccess({
    actions: new Map(
      [...scopes, 'media:erase'].map((action) => [
        action,
        {
          anonymous: action.endsWith(':read'),
          ...(action === 'media:create' ? { 'x-resource-types': ['content.media'] } : {}),
        },
      ]),
    ),
    auth: {
      issuer,
      audience: 'https://kernel.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => Response.json({ keys: [publicKey] }),
    },
  });
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(7),
    access,
    writeRate: createWriteRateLimiter({
      secret: 'media-http-test-only-secret-at-least-32-bytes',
      overrides: JSON.stringify({
        'new-account': { upload: { maximum: 10000, seconds: 60 } },
      }),
    }),
  });
});
afterAll(() => db?.close());
const input = (containerId = thread) => ({
  containerId,
  purpose: 'post-image',
  mediaType: 'image/png',
  byteCount: 256,
  sha256: hash,
});
async function call(
  method: string,
  path: string,
  token: string | null = 'owner',
  body?: unknown,
  key = Bun.randomUUIDv7(),
  headers: Record<string, string> = {},
) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${await bearer(token)}` }),
        ...(body === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'idempotency-key': JSON.stringify(key),
            }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, status: response.status, body: await response.json() };
}
async function reserve(containerId = thread) {
  const key = Bun.randomUUIDv7();
  const result = await call('POST', '/v1/media', 'owner', input(containerId), key);
  expect(result.status).toBe(201);
  expect(result.response.headers.get('location')).toBe(`/v1/media/${result.body.media.id}`);
  expect(result.response.headers.get(SESSION_HEADER)).toBeString();
  return { id: result.body.media.id as string, key, containerId, result };
}
function completion(media: { key: string; containerId: string }) {
  return {
    containerId: media.containerId,
    reservationRequestId: media.key,
    byteCount: 256,
    sha256: hash,
  };
}
async function upload(containerId = thread) {
  const media = await reserve(containerId);
  const result = await call('POST', `/v1/media/${media.id}:complete`, 'owner', completion(media));
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ media: { id: media.id, state: 'uploaded' } });
  return media;
}
async function available(containerId = thread) {
  const media = await upload(containerId);
  // Fixture setup models the image processor's committed actual variants. No handler accepts these fields.
  await db.admin.query(
    "UPDATE content.media SET state='available',claimed_at=statement_timestamp() WHERE route=$1 AND media_id=$2",
    [route, media.id],
  );
  for (const [format, width] of [
    ['webp', 320],
    ['avif', 320],
  ] as const)
    await db.admin.query(
      `INSERT INTO content.media_variant(route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
      VALUES ($1,$2,$3,$4,10,$5,64,$6,$7,$8)`,
      [
        route,
        media.id,
        format,
        width,
        `image/${format}`,
        derivativeHash,
        `m/${media.id}/${format}-${width}`,
        owner.accountId,
      ],
    );
  return media;
}
const download = (id: string, variant = 'webp-320', token: string | null = null, headers = {}) =>
  call('GET', `/v1/media/${id}:authorizeDownload?variant=${variant}`, token, undefined, undefined, headers);
function absent(result: Awaited<ReturnType<typeof call>>, effectStatus = 'not_applicable') {
  expect(result.status).toBe(404);
  expect(result.body).toMatchObject({
    code: 'not_found',
    effect_status: effectStatus,
  });
  expect(JSON.stringify(result.body)).not.toMatch(/m\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i);
  expect(JSON.stringify(result.body)).not.toMatch(/"(?:key|sha256)"\s*:/);
  expect(JSON.stringify(result.body)).not.toContain(derivativeHash);
}

test('strict media schemas, exact actions, problems and AIP custom methods are published', () => {
  const document = openApiDocument(app);
  for (const [path, method, action, operationId, success] of [
    ['/v1/media', 'post', 'media:create', 'media.create', 201],
    ['/v1/media/{id}', 'get', 'media:read_reservation', 'media.read_reservation', 200],
    ['/v1/media/{id}:complete', 'post', 'media:complete', 'media.complete', 200],
    ['/v1/media/{id}:authorizeDownload', 'get', 'media:read', 'media.authorize_download', 200],
  ] as const) {
    const operation = document.paths[path]?.[method];
    expect(operation).toMatchObject({ operationId, 'x-action': action });
    expect(operation?.responses?.[success]?.content?.['application/json']?.schema).toBeDefined();
    expect(
      isProblemSchema(
        operation?.responses?.[404]?.content?.['application/problem+json']?.schema,
        document.components.schemas,
      ),
    ).toBe(true);
    if (method === 'post')
      expect(operation?.['x-rate-limit']).toEqual({
        family: action === 'media:complete' ? 'write' : 'upload',
        units: 1,
      });
    else expect(operation?.['x-rate-limit']).toBeUndefined();
  }
  expect(actionCatalogue(app).get('media:read')?.anonymous).toBe(true);
  expect(actionCatalogue(app).get('media:read_reservation')?.anonymous).toBe(false);
  expect(Object.keys(document.paths).some((path) => path.includes('/$'))).toBe(false);
});

test('the default media download budget is capped by the enclosing request deadline', async () => {
  const delayMs = 250;
  const budgetMs = 70;
  const pool = {
    connect: () =>
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('simulated delayed pool checkout')), delayMs);
      }),
  } as never;
  const requestDeadline = Date.now() + budgetMs;
  const started = performance.now();
  await expect(
    withRequestDeadline(requestDeadline, () =>
      decideDownload({ pool, access }, newId(route), { kind: 'anonymous' }, 'webp-320'),
    ),
  ).rejects.toMatchObject({ reason: 'deadline' });
  expect(performance.now() - started).toBeLessThan(delayMs - budgetMs);
});

test('uploader reservation preflight and BFF completion use verified subject and exclusive website scope', async () => {
  const media = await reserve();
  expect(routeOf(media.id)).toBe(route);
  const result = await call('GET', `/v1/media/${media.id}`);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    media: {
      id: media.id,
      state: 'reserved',
      byteCount: 256,
      mediaType: 'image/png',
      sha256: null,
      containerId: thread,
      uploaderId: owner.accountId,
      key: `m/${media.id}/original`,
      reservationRequestId: media.key,
    },
  });
  absent(await call('GET', `/v1/media/${media.id}`, 'other'));
  absent(await call('GET', `/v1/media/${newId(route)}`, 'other'));
  for (const token of ['other', 'ordinary', 'other-client']) {
    const denied = await call('POST', `/v1/media/${media.id}:complete`, token, completion(media));
    expect(denied.status).toBe(403);
  }
  for (const patch of [{ uploaderId: owner.accountId }, { verified: true }, { publicCache: true }])
    expect(
      (
        await call('POST', `/v1/media/${media.id}:complete`, 'owner', {
          ...completion(media),
          ...patch,
        })
      ).status,
    ).toBe(400);
  for (const patch of [
    { containerId: newId(route) },
    { reservationRequestId: 'wrong' },
    { byteCount: 255 },
    { sha256: 'c'.repeat(64) },
  ])
    expect(
      (
        await call('POST', `/v1/media/${media.id}:complete`, 'owner', {
          ...completion(media),
          ...patch,
        })
      ).status,
    ).toBe(403);
  const key = Bun.randomUUIDv7();
  const first = await call('POST', `/v1/media/${media.id}:complete`, 'owner', completion(media), key);
  expect(first.status).toBe(200);
  expect((await call('POST', `/v1/media/${media.id}:complete`, 'owner', completion(media), key)).body).toEqual(
    first.body,
  );
  const previous = identities.get('owner')!;
  identities.set('owner', identities.get('ordinary')!);
  try {
    expect((await call('POST', `/v1/media/${media.id}:complete`, 'owner', completion(media), key)).status).toBe(403);
  } finally {
    identities.set('owner', previous);
  }
  absent(await call('POST', `/v1/media/${media.id}/$complete`, 'owner', completion(media)), 'not_applied');
});

test('reservation requires an existing parent grant and creates owner roles atomically', async () => {
  expect((await call('POST', '/v1/media', 'owner', input(newId(route)))).status).toBe(403);
  expect((await call('POST', '/v1/media', 'other', input())).status).toBe(403);
  expect(
    (
      await call('POST', '/v1/media', 'owner', {
        ...input(),
        uploaderId: owner.accountId,
      })
    ).status,
  ).toBe(400);
  const media = await reserve();
  const roles = await db.admin.query(
    'SELECT grant_role FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3',
    [route, media.id, owner.accountId],
  );
  expect(roles.rows).toContainEqual({ grant_role: 'content.media.owner' });
});

test('original privacy, real variants and private cache decisions', async () => {
  const reserved = await reserve();
  absent(await download(reserved.id, 'original', 'owner'));
  const uploaded = await upload();
  expect((await download(uploaded.id, 'original', 'owner')).body).toEqual({
    allowed: true,
    key: `m/${uploaded.id}/original`,
    sha256: hash,
    mediaType: 'image/png',
    byteCount: 256,
    publicCache: false,
    cacheControl: 'private, no-store',
  });
  absent(await download(uploaded.id, 'original', 'other'));
  absent(await download(uploaded.id));
  const media = await available();
  for (const variant of ['webp-320', 'avif-320', 'webp-17']) {
    if (variant === 'webp-17')
      await db.admin.query(
        "UPDATE content.media_variant SET width=17,key=$3 WHERE route=$1 AND media_id=$2 AND format='webp' AND width=320",
        [route, media.id, `m/${media.id}/webp-17`],
      );
    const result = await download(media.id, variant);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      allowed: true,
      key: `m/${media.id}/${variant}`,
      sha256: derivativeHash,
      mediaType: variant.startsWith('webp') ? 'image/webp' : 'image/avif',
      byteCount: 64,
      publicCache: false,
      cacheControl: 'private, no-cache',
    });
    expect(result.response.headers.get('cache-control')).toBe('private, no-cache');
  }
  await db.admin.query(
    "UPDATE content.media_variant SET width=320,key=$3 WHERE route=$1 AND media_id=$2 AND format='webp' AND width=17",
    [route, media.id, `m/${media.id}/webp-320`],
  );
  for (const variant of ['webp-640', 'webp-2560', 'webp-319', 'webp-0320', 'raw', 'original'])
    absent(await download(media.id, variant));
  absent(await call('GET', `/v1/media/${media.id}/$authorizeDownload?variant=webp-320`, null));
  expect((await download(media.id, 'webp-320', 'zero')).status).toBe(200);
  await db.admin.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES ($1,$2,$3,'media:read','resource','(,)',$3)`,
    [route, media.id, identities.get('zero')!.accountId],
  );
  absent(await download(media.id, 'webp-320', 'zero'));
  for (const flag of ['taken_down', 'collection_pending', 'erased']) {
    const target = await upload();
    await db.admin.query(
      `UPDATE content.media SET ${flag}=true,security_revision=security_revision+1 WHERE route=$1 AND media_id=$2`,
      [route, target.id],
    );
    absent(await download(target.id, 'original', 'owner'));
    absent(await download(target.id));
    if (flag === 'erased') expect((await call('GET', `/v1/media/${target.id}`)).body.media.state).toBe('erased');
  }
  const rejected = await upload();
  await db.admin.query(
    "UPDATE content.media SET state='rejected',decision='invalid-image' WHERE route=$1 AND media_id=$2",
    [route, rejected.id],
  );
  absent(await download(rejected.id, 'original', 'owner'));
});

test('per-request download decisions check full current container chain and exact available variant', async () => {
  const media = await available();
  const conditional = { 'if-none-match': `"${derivativeHash}"` };
  expect((await download(media.id, 'webp-320', null, conditional)).status).toBe(200);
  await db.admin.query(
    "UPDATE content.thread SET visibility='protected',security_revision=security_revision+1 WHERE route=$1 AND thread_id=$2",
    [route, thread],
  );
  try {
    absent(await download(media.id, 'webp-320', null, conditional));
    absent(await download(media.id, 'webp-320', 'other', conditional));
    await grant(owner.accountId, 'thread:read');
    const own = await download(media.id, 'webp-320', 'owner', conditional);
    expect(own.status).toBe(200);
    expect(own.body.cacheControl).toBe('private, no-store');
    await db.admin.query(
      "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='thread:read'",
      [route, thread, owner.accountId],
    );
    absent(await download(media.id, 'webp-320', 'owner', conditional));
  } finally {
    await db.admin.query(
      "UPDATE content.thread SET visibility='published',security_revision=security_revision+1 WHERE route=$1 AND thread_id=$2",
      [route, thread],
    );
  }
  await db.admin.query(
    "UPDATE content.board SET visibility='taken_down',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
    [routeOf(board), board],
  );
  try {
    absent(await download(media.id, 'webp-320', null, conditional));
  } finally {
    await db.admin.query(
      "UPDATE content.board SET visibility='published',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
      [routeOf(board), board],
    );
  }
});

test('Eden serializes .$complete.post and .$authorizeDownload.get as literal colon paths', async () => {
  const media = await reserve();
  const paths: string[] = [];
  const client = {
    v1: createKernelClient('http://kernel.test', {
      headers: { authorization: `Bearer ${await bearer('owner')}` },
      fetch: (async (url, options) => {
        paths.push(String(url));
        return app.handle(new Request(url, options));
      }) as typeof fetch,
    }),
  };
  const completed = await client.v1.media({ id: media.id }).$complete.post(completion(media), {
    headers: {
      'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
    },
  });
  expect(completed.status).toBe(200);
  const decision = await client.v1.media({ id: media.id }).$authorizeDownload.get({
    query: { variant: 'original' },
    headers: { authorization: `Bearer ${await bearer('owner')}` },
  });
  expect(decision.status).toBe(200);
  expect(paths[0]).toBe(`http://kernel.test/v1/media/${media.id}:complete`);
  expect(paths[1]).toBe(`http://kernel.test/v1/media/${media.id}:authorizeDownload?variant=original`);
});

test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  const media = await available();
  const digestBody = new Bun.CryptoHasher('sha256').update('{}').digest();
  // 16 rows per scale unit puts every growing relation on point plans at N=32.
  const operation = async (database: typeof db) => {
    const decision = await decideDownload({ pool: database.pool, access }, media.id, { kind: 'anonymous' }, 'webp-320');
    expect(decision.allowed).toBe(true);
    const deadline = Date.now() + 10000;
    const authenticated = await access.authenticate(await bearer('owner'), { pool: database.pool, deadline });
    expect(
      (
        await decideDownload(
          { pool: database.pool, access, downloadContext: { deadline } },
          media.id,
          authenticated,
          'webp-320',
        )
      ).allowed,
    ).toBe(true);
  };
  const report = await checkGrowth(db, {
    name: 'media exact variant and current independent container chain decision',
    rule: 'series',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      await seed(
        database,
        {
          name: 'representative media, ancestry and subject-anchored ACL history',
          hotPartition: Math.floor(route / 16),
          rows({ ordinal }) {
            const r = ordinal % 2 === 0 ? route : route + 16;
            const boardRoute = ordinal % 2 === 0 ? routeOf(board)! : routeOf(board)! + 16;
            const id = newId(r),
              actor = newId(r),
              t = newId(r),
              p = newId(r),
              revision = newId(r);
            const b = newId(boardRoute);
            return {
              'access.account': [
                { route: r, account_id: actor, kind: 'actor', state: 'active', transaction_id: actor },
              ],
              'content.board': [
                {
                  route: boardRoute,
                  board_id: b,
                  subject_id: actor,
                  title: 'Unrelated',
                  visibility: 'published',
                  security_revision: 1,
                  recorded_transaction_id: actor,
                },
              ],
              'content.thread': [
                {
                  route: r,
                  thread_id: t,
                  author_account_id: actor,
                  board_id: b,
                  title: 'Unrelated',
                  visibility: 'published',
                  security_revision: 1,
                  recorded_transaction_id: actor,
                },
              ],
              'content.post': [
                {
                  route: r,
                  thread_id: t,
                  post_id: p,
                  author_account_id: actor,
                  head_revision_id: revision,
                  visibility: 'published',
                  security_revision: 1,
                  recorded_transaction_id: actor,
                },
              ],
              'content.revision': [
                {
                  route: r,
                  thread_id: t,
                  post_id: p,
                  revision_id: revision,
                  body: Buffer.from('{}'),
                  body_sha256: Buffer.from(digestBody),
                  search_text: '',
                  licence: 'CC0-1.0',
                  subject_ids: [],
                  board_id: b,
                  availability: 'available',
                  recorded_transaction_id: actor,
                },
              ],
              'content.media': [
                {
                  route: r,
                  media_id: id,
                  container_id: t,
                  uploader_id: owner.accountId,
                  reservation_request_id: `http-distractor-${ordinal}`,
                  purpose: 'post-image',
                  media_type: 'image/png',
                  byte_count: 256,
                  state: 'reserved',
                  key: `m/${id}/original`,
                  transaction_id: actor,
                },
              ],
              'content.media_variant': ['webp', 'avif'].flatMap((format) =>
                [320, 640, 960, 1280, 1920, 2560].map((width) => ({
                  route: r,
                  media_id: id,
                  format,
                  width,
                  height: 200,
                  media_type: `image/${format}`,
                  byte_count: 64,
                  sha256: derivativeHash,
                  key: `m/${id}/${format}-${width}`,
                  transaction_id: actor,
                })),
              ),
              'access.resource_role_grant': [
                {
                  route: r,
                  resource_id: id,
                  subject_id: owner.accountId,
                  grant_role: 'creator',
                  valid: '(,)',
                  transaction_id: actor,
                },
              ],
              'access.resource_grant': [
                {
                  route,
                  resource_id: media.id,
                  subject_id: actor,
                  action: 'media:read',
                  valid: '(,)',
                  transaction_id: actor,
                },
              ],
            };
          },
        },
        { from: previous * 16, to: scale * 16 },
      );
    },
    operation,
    async warmup(database) {
      const measured = await capture(database, () => operation(database));
      assertGrowthPointPlans(measured.capture, {
        'content.media': ['route', 'media_id'],
        'content.media_variant': ['route', 'media_id', 'format', 'width'],
        'content.thread': ['route', 'thread_id'],
        'content.post': ['route', 'post_id'],
        'content.board': ['route', 'board_id'],
        'access.resource_grant': [
          'route',
          'resource_id',
          'subject_id',
          'subject_kind',
          'subject_role',
          'action',
          'valid',
        ],
      });
    },
  });
  console.log('GrowthReport', JSON.stringify(report));
  expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
});

test('native completion and conditional disclosure exercise current authority independently of reservation GET', async () => {
  const media = await reserve();
  for (const token of ['other', 'ordinary', 'other-client'])
    expect((await call('POST', `/v1/media/${media.id}:complete`, token, completion(media))).status).toBe(403);
  for (const patch of [{ uploaderId: owner.accountId }, { verified: true }, { publicCache: true }])
    expect(
      (
        await call('POST', `/v1/media/${media.id}:complete`, 'owner', {
          ...completion(media),
          ...patch,
        })
      ).status,
    ).toBe(400);
  for (const patch of [
    { containerId: newId(route) },
    { reservationRequestId: 'wrong' },
    { byteCount: 255 },
    { sha256: 'c'.repeat(64) },
  ])
    expect(
      (
        await call('POST', `/v1/media/${media.id}:complete`, 'owner', {
          ...completion(media),
          ...patch,
        })
      ).status,
    ).toBe(403);
  const key = Bun.randomUUIDv7();
  expect((await call('POST', `/v1/media/${media.id}:complete`, 'owner', completion(media), key)).status).toBe(200);
  expect((await call('POST', `/v1/media/${media.id}:complete`, 'owner', completion(media), key)).status).toBe(200);
  const internalAlias = await call('POST', `/v1/media/${media.id}/$complete`, 'owner', completion(media));
  expect(internalAlias.status).toBe(404);
  expect(internalAlias.body.effect_status).toBe('not_applied');
  identities.set('owner', identities.get('ordinary')!);
  try {
    expect((await call('POST', `/v1/media/${media.id}:complete`, 'owner', completion(media), key)).status).toBe(403);
  } finally {
    identities.set('owner', owner);
  }
  const own = await download(media.id, 'original', 'owner');
  expect(own.status).toBe(200);
  expect(own.body).toMatchObject({
    publicCache: false,
    cacheControl: 'private, no-store',
    sha256: hash,
  });
  const missing = await download(media.id, 'original', 'other');
  expect(missing.status).toBe(404);
  expect(missing.body).not.toHaveProperty('key');
  expect(missing.body).not.toHaveProperty('sha256');

  const sanitized = await available();
  const conditional = { 'if-none-match': `"${derivativeHash}"` };
  const visible = await download(sanitized.id, 'webp-320', 'zero', conditional);
  expect(visible.status).toBe(200);
  expect(visible.body).toMatchObject({
    key: `m/${sanitized.id}/webp-320`,
    sha256: derivativeHash,
    publicCache: false,
    cacheControl: 'private, no-cache',
  });
  await db.admin.query(
    "UPDATE content.thread SET visibility='protected',security_revision=security_revision+1 WHERE route=$1 AND thread_id=$2",
    [route, thread],
  );
  try {
    expect((await download(sanitized.id, 'webp-320', null, conditional)).status).toBe(404);
    await grant(owner.accountId, 'thread:read');
    const protectedBytes = await download(sanitized.id, 'webp-320', 'owner', conditional);
    expect(protectedBytes.status).toBe(200);
    expect(protectedBytes.body.cacheControl).toBe('private, no-store');
    await db.admin.query(
      "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='thread:read'",
      [route, thread, owner.accountId],
    );
    expect((await download(sanitized.id, 'webp-320', 'owner', conditional)).status).toBe(404);
  } finally {
    await db.admin.query(
      "UPDATE content.thread SET visibility='published',security_revision=security_revision+1 WHERE route=$1 AND thread_id=$2",
      [route, thread],
    );
  }
  await db.admin.query(
    "INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id) VALUES ($1,$2,$3,'media:read','resource','(,)',$3)",
    [route, sanitized.id, identities.get('zero')!.accountId],
  );
  expect((await download(sanitized.id, 'webp-320', 'zero', conditional)).status).toBe(404);
  await db.admin.query(
    'UPDATE content.media SET erased=true,security_revision=security_revision+1 WHERE route=$1 AND media_id=$2',
    [route, sanitized.id],
  );
  expect((await download(sanitized.id, 'webp-320', null, conditional)).status).toBe(404);
  expect((await download(sanitized.id, 'original', 'owner', conditional)).status).toBe(404);
});

test('reply media rechecks ancestor revision availability and the independently anchored board', async () => {
  const parent = newId(route);
  const child = newId(route);
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    for (const [id, replyTo] of [
      [parent, null],
      [child, parent],
    ]) {
      const revision = newId(route);
      await client.query(
        `INSERT INTO content.post(route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
        VALUES ($1,$2,$3,$4,$5,$6,'published',1,$5)`,
        [route, thread, id, replyTo, owner.accountId, revision],
      );
      await client.query(
        `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
        VALUES ($1,$2,$3,$4,$5,sha256($5),'','CC0-1.0','{}',$6,'available',$7)`,
        [route, thread, id, revision, Buffer.from('{}'), board, owner.accountId],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await grant(owner.accountId, 'media:create', child);
  const media = await available(child);
  const conditional = { 'if-none-match': `"${derivativeHash}"` };
  expect((await download(media.id, 'webp-320', null, conditional)).status).toBe(200);
  await db.admin.query(
    "UPDATE content.post SET visibility='protected',security_revision=security_revision+1 WHERE route=$1 AND post_id=$2",
    [route, parent],
  );
  expect((await download(media.id, 'webp-320', null, conditional)).status).toBe(404);
  expect((await download(media.id, 'webp-320', 'owner', conditional)).status).toBe(404);
  await grant(owner.accountId, 'post:read', parent);
  const protectedBytes = await download(media.id, 'webp-320', 'owner', conditional);
  expect(protectedBytes.status).toBe(200);
  expect(protectedBytes.body.cacheControl).toBe('private, no-store');
  await db.admin.query(
    "UPDATE content.board SET visibility='taken_down',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
    [routeOf(board), board],
  );
  try {
    expect((await download(media.id, 'webp-320', 'owner', conditional)).status).toBe(404);
  } finally {
    await db.admin.query(
      "UPDATE content.board SET visibility='published',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
      [routeOf(board), board],
    );
  }
  await db.admin.query(
    "UPDATE content.post SET availability='erased',security_revision=security_revision+1 WHERE route=$1 AND post_id=$2",
    [route, parent],
  );
  await db.admin.query(
    "UPDATE content.revision SET availability='erased',body=NULL,body_sha256=NULL,search_text=NULL WHERE route=$1 AND post_id=$2",
    [route, parent],
  );
  expect((await download(media.id, 'webp-320', 'owner', conditional)).status).toBe(404);
});

test('cover download inherits its readable subject and current source fence through bounded point reads', async () => {
  const { tupleRoute } = await import('../../src/content/imported-contract.ts');
  const { capture, costOf } = await import('../support/growth.ts');
  const routeKey = new Uint8Array(32).fill(7);
  const subject = newId(route);
  const id = newId(route);
  const source = 'media-http-catalogue';
  const externalId = 'cover-record';
  const home = tupleRoute(routeKey, source, externalId);
  const provenance = {
    source,
    external_id: externalId,
    record_revision: 'edition-1',
    digest: hash,
    converter_revision: 'converter-1',
    field_group: 'cover',
    references: [
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/cover' } }] },
    ],
  };
  // Setup is outside the capture, including unrelated rows in the same homes.
  const distractors = Array.from({ length: 2048 }, (_, index) => ({
    route,
    id: newId(route),
    external_id: `unrelated-cover-${index}`,
    home: tupleRoute(routeKey, source, `unrelated-cover-${index}`),
  }));
  await db.admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id)
     SELECT route,id,'schema:Book',id FROM jsonb_to_recordset($1::jsonb) AS x(route integer,id uuid)`,
    [JSON.stringify([{ route, id: subject }, ...distractors])],
  );
  await db.admin.query(
    `INSERT INTO content.source_fences(route,source,external_id,field_group,taken_down,security_revision)
     SELECT home,$2,external_id,'cover',false,1
     FROM jsonb_to_recordset($1::jsonb) AS x(home integer,external_id text)`,
    [JSON.stringify([{ home, external_id: externalId }, ...distractors]), source],
  );
  await db.admin.query(
    `INSERT INTO content.media(route,media_id,container_id,uploader_id,reservation_request_id,purpose,
      media_type,byte_count,actual_byte_count,sha256,state,key,claimed_at,transaction_id,source_url,credit,provenance,
      width,height,thumbhash,average_color)
     VALUES ($1,$2::uuid,$3,$4,$2::text,'cover','image/png',256,256,$5,'available',$6,NULL,$4,$7,$8,$9,
       320,200,decode('010203','hex'),'#123456')`,
    [
      route,
      id,
      subject,
      owner.accountId,
      hash,
      `m/${id}/original`,
      'https://example.test/cover.png',
      {
        rightsHolder: 'Cover Artist',
        via: { name: 'Example Catalogue', url: 'https://example.test/cover' },
        license: 'CC0-1.0',
        obligations: [],
      },
      provenance,
    ],
  );
  await db.admin.query(
    `INSERT INTO content.media_variant(route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
     VALUES ($1,$2,'webp',320,200,'image/webp',64,$3,$4,$5)`,
    [route, id, derivativeHash, `m/${id}/webp-320`, owner.accountId],
  );
  for (const table of ['semantic.subject', 'content.source_fences', 'content.media', 'content.media_variant'])
    await db.admin.query(`ANALYZE ${table}`);
  const pair = await generateKeyPair('ES256');
  const publicKey = { ...(await exportJWK(pair.publicKey)), kid: 'cover-http', alg: 'ES256', use: 'sig' };
  const coverApp = createKernel({
    pool: db.pool,
    routeKey,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience: 'https://kernel.test',
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => Response.json({ keys: [publicKey] }),
        },
      }),
  });
  const token = await new SignJWT({
    client_id: 'rezics-website',
    scope: 'media:read subject:read',
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'cover-http' })
    .setIssuer(issuer)
    .setAudience('https://kernel.test')
    .setSubject(owner.accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(pair.privateKey);
  const request = async (variant = 'webp-320', authenticated = false) => {
    const response = await coverApp.handle(
      new Request(`http://kernel.test/v1/media/${id}:authorizeDownload?variant=${variant}`, {
        headers: {
          'if-none-match': `"${derivativeHash}"`,
          ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        },
      }),
    );
    return { response, status: response.status, body: await response.json() };
  };
  const observed = await capture(db, () => request());
  expect(observed.value.status).toBe(200);
  expect(observed.value.body).toEqual({
    allowed: true,
    key: `m/${id}/webp-320`,
    sha256: derivativeHash,
    mediaType: 'image/webp',
    byteCount: 64,
    publicCache: false,
    cacheControl: 'private, no-cache',
  });
  expect(observed.value.response.headers.get('cache-control')).toBe('private, no-cache');
  const cost = costOf(observed.capture);
  console.log('CoverPointReadCost', JSON.stringify(cost));
  expect(cost.relations['content.media']?.rows).toBe(3);
  expect(cost.relations['content.media_variant']?.rows).toBe(3);
  expect(cost.relations['semantic.subject']?.rows).toBe(3);
  expect(cost.relations['content.source_fences']?.rows).toBe(2);
  for (const table of ['content.media', 'content.media_variant', 'semantic.subject', 'content.source_fences'])
    expect(cost.relations[table]?.sequentialScans).toBe(0);
  expect(
    observed.capture.statements.some((statement) => /content.media_reference|semantic.candidate/.test(statement)),
  ).toBe(false);
  await db.admin.query(
    "UPDATE content.source_fences SET taken_down=true,taken_down_at=now(),takedown_id=gen_random_uuid(),security_revision=2 WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group='cover'",
    [home, source, externalId],
  );
  const fenced = await request();
  absent(fenced);
  await db.admin.query(
    "UPDATE content.source_fences SET taken_down=false,taken_down_at=NULL,takedown_id=NULL,security_revision=3 WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group='cover'",
    [home, source, externalId],
  );
  await db.admin.query('UPDATE content.media SET taken_down=true,security_revision=1 WHERE route=$1 AND media_id=$2', [
    route,
    id,
  ]);
  const takenDown = await request();
  absent(takenDown);
  const withoutRequestId = (body: typeof fenced.body) => {
    expect(body.request_id).toBeString();
    const { request_id: _requestId, ...problem } = body;
    return problem;
  };
  expect(withoutRequestId(takenDown.body)).toEqual(withoutRequestId(fenced.body));
  await db.admin.query(
    "UPDATE content.media SET taken_down=false,state='rejected',decision='invalid-image',claimed_at=NULL,security_revision=2 WHERE route=$1 AND media_id=$2",
    [route, id],
  );
  const rejected = await request('original', true);
  absent(rejected);
  expect(withoutRequestId(rejected.body)).toEqual(withoutRequestId(fenced.body));
});
