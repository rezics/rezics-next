import { afterAll, beforeAll, expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import { createAccess } from '../../src/access/permission.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument, isProblemSchema } from '../../src/http/openapi.ts';
import { actionCatalogue, SESSION_HEADER } from '../../src/http/request.ts';
import { AuthenticationError, type AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { decideDownload } from '../../src/content/media.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;
const route = 0x4312;
const board = newId(0x9876);
const thread = newId(route);
const hash = 'a'.repeat(64);
const derivativeHash = 'b'.repeat(64);
const scopes = ['media:create', 'media:complete', 'media:read_reservation', 'media:read', 'thread:read', 'post:read', 'board:read'];
const owner: AccountActor = { kind: 'account', accountId: newId(0x1234), clientId: 'rezics-website', scopes, requestedBy: null, authnEpoch: 1 };
const identities = new Map<string, AccountActor>([
  ['owner', owner],
  ['other', { ...owner, accountId: newId(0x2345) }],
  ['ordinary', { ...owner, scopes: scopes.filter(s => s !== 'media:complete') }],
  ['other-client', { ...owner, clientId: 'other-client' }],
  ['zero', { ...owner, accountId: newId(0x3456), scopes: [] }],
]);
const access = createAccess({
  actions: new Map(scopes.map(action => [action, { anonymous: action.endsWith(':read') }])),
  // Only verified identity is substituted. Every authorization is the production Access formula,
  // with native current account, grants, roles and denials. Website OAuth issuance is dependency-owned.
  async authenticate(token, context) {
    const actor = identities.get(token);
    if (!actor || !(await readAccount(context.pool, routeOf(actor.accountId)!, actor.accountId)))
      throw new AuthenticationError(401, 'Bearer error="invalid_token"');
    return actor;
  },
  accountEvidence: () => undefined,
});
async function grant(subject: string, action: string, id = thread) {
  await db.admin.query(`INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,$4,'(,)',$3) ON CONFLICT DO NOTHING`, [routeOf(id), id, subject, action]);
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1; // Independently anchored reads must release before the next checkout.
  for (const id of new Set([...identities.values()].map(actor => actor.accountId)))
    await db.admin.query("INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)", [routeOf(id), id]);
  await db.admin.query(`INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Images','published',1,$3)`, [routeOf(board), board, owner.accountId]);
  await db.admin.query(`INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,'Images','published',1,$3)`, [route, thread, owner.accountId, board]);
  await grant(owner.accountId, 'media:create');
  app = createKernel({ pool: db.pool, routeKey: new Uint8Array(32).fill(7), access,
    writeRate: createWriteRateLimiter({ policy: () => ({ capacity: 10000, refillPerSecond: 10000 }) }) });
});
afterAll(() => db?.close());
const input = (containerId = thread) => ({ containerId, purpose: 'post-image', mediaType: 'image/png', byteCount: 256, sha256: hash });
async function call(method: string, path: string, token: string | null = 'owner', body?: unknown, key = Bun.randomUUIDv7(), headers: Record<string,string> = {}) {
  const response = await app.handle(new Request(`http://kernel.test${path}`, { method,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
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
  return { containerId: media.containerId, reservationRequestId: media.key, byteCount: 256, sha256: hash };
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
  await db.admin.query("UPDATE content.media SET state='available',claimed_at=statement_timestamp() WHERE route=$1 AND media_id=$2", [route, media.id]);
  for (const [format, width] of [['webp', 320], ['avif', 320], ['webp', 17]] as const)
    await db.admin.query(`INSERT INTO content.media_variant(route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
      VALUES ($1,$2,$3,$4,10,$5,64,$6,$7,$8)`, [route, media.id, format, width, `image/${format}`, derivativeHash, `m/${media.id}/${format}-${width}`, owner.accountId]);
  return media;
}
const download = (id: string, variant = 'webp-320', token: string | null = null, headers = {}) =>
  call('GET', `/v1/media/${id}:authorizeDownload?variant=${variant}`, token, undefined, undefined, headers);
function absent(result: Awaited<ReturnType<typeof call>>) {
  expect(result.status).toBe(404);
  expect(result.body).toMatchObject({ code: 'not_found', effect_status: 'not_applicable' });
  expect(JSON.stringify(result.body)).not.toContain('m/');
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
    expect(isProblemSchema(operation?.responses?.[404]?.content?.['application/problem+json']?.schema, document.components.schemas)).toBe(true);
    if (method === 'post') expect(operation?.['x-rate-limit']).toEqual({ family: 'upload', units: 1 });
    else expect(operation?.['x-rate-limit']).toBeUndefined();
  }
  expect(actionCatalogue(app).get('media:read')?.anonymous).toBe(true);
  expect(actionCatalogue(app).get('media:read_reservation')?.anonymous).toBe(false);
  expect(Object.keys(document.paths).some(path => path.includes('/$'))).toBe(false);
});

test('uploader reservation preflight and BFF completion use verified subject and exclusive website scope', async () => {
  const media = await reserve();
  expect(routeOf(media.id)).toBe(route);
  const result = await call('GET', `/v1/media/${media.id}`);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ media: { id: media.id, state: 'reserved', byteCount: 256, mediaType: 'image/png', sha256: null, containerId: thread, uploaderId: owner.accountId, key: `m/${media.id}/original`, reservationRequestId: media.key } });
  absent(await call('GET', `/v1/media/${media.id}`, 'other'));
  absent(await call('GET', `/v1/media/${newId(route)}`, 'other'));
  for (const token of ['other', 'ordinary', 'other-client']) {
    const denied = await call('POST', `/v1/media/${media.id}:complete`, token, completion(media));
    expect(denied.status).toBe(403);
  }
  for (const patch of [{ uploaderId: owner.accountId }, { verified: true }, { publicCache: true }])
    expect((await call('POST', `/v1/media/${media.id}:complete`, 'owner', { ...completion(media), ...patch })).status).toBe(400);
  for (const patch of [{ containerId: newId(route) }, { reservationRequestId: 'wrong' }, { byteCount: 255 }, { sha256: 'c'.repeat(64) }])
    expect((await call('POST', `/v1/media/${media.id}:complete`, 'owner', { ...completion(media), ...patch })).status).toBe(403);
  const key = Bun.randomUUIDv7();
  const first = await call('POST', `/v1/media/${media.id}:complete`, 'owner', completion(media), key);
  expect(first.status).toBe(200);
  expect((await call('POST', `/v1/media/${media.id}:complete`, 'owner', completion(media), key)).body).toEqual(first.body);
  const previous = identities.get('owner')!;
  identities.set('owner', identities.get('ordinary')!);
  try { expect((await call('POST', `/v1/media/${media.id}:complete`, 'owner', completion(media), key)).status).toBe(403); }
  finally { identities.set('owner', previous); }
  absent(await call('POST', `/v1/media/${media.id}/$complete`, 'owner', completion(media)));
});

test('reservation requires an existing parent grant and creates owner roles atomically', async () => {
  expect((await call('POST', '/v1/media', 'owner', input(newId(route)))).status).toBe(403);
  expect((await call('POST', '/v1/media', 'other', input())).status).toBe(403);
  expect((await call('POST', '/v1/media', 'owner', { ...input(), uploaderId: owner.accountId })).status).toBe(400);
  const media = await reserve();
  const roles = await db.admin.query('SELECT grant_role FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [route, media.id, owner.accountId]);
  expect(roles.rows).toContainEqual({ grant_role: 'content.media.owner' });
});

test('original privacy, real variants and private cache decisions', async () => {
  const reserved = await reserve();
  absent(await download(reserved.id, 'original', 'owner'));
  const uploaded = await upload();
  expect((await download(uploaded.id, 'original', 'owner')).body).toEqual({ allowed: true, key: `m/${uploaded.id}/original`, sha256: hash, mediaType: 'image/png', byteCount: 256, publicCache: false, cacheControl: 'private, no-store' });
  absent(await download(uploaded.id, 'original', 'other'));
  absent(await download(uploaded.id));
  const media = await available();
  for (const variant of ['webp-320', 'avif-320', 'webp-17']) {
    const result = await download(media.id, variant);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ allowed: true, key: `m/${media.id}/${variant}`, sha256: derivativeHash, mediaType: variant.startsWith('webp') ? 'image/webp' : 'image/avif', byteCount: 64, publicCache: false, cacheControl: 'private, no-cache' });
    expect(result.response.headers.get('cache-control')).toBe('private, no-cache');
  }
  for (const variant of ['webp-640', 'webp-2560', 'webp-319', 'webp-0320', 'raw', 'original']) absent(await download(media.id, variant));
  absent(await call('GET', `/v1/media/${media.id}/$authorizeDownload?variant=webp-320`, null));
  expect((await download(media.id, 'webp-320', 'zero')).status).toBe(200);
  await db.admin.query(`INSERT INTO access.resource_denial(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'media:read','(,)',$3)`, [route, media.id, identities.get('zero')!.accountId]);
  absent(await download(media.id, 'webp-320', 'zero'));
  for (const flag of ['taken_down', 'collection_pending', 'erased']) {
    const target = await upload();
    await db.admin.query(`UPDATE content.media SET ${flag}=true,security_revision=security_revision+1 WHERE route=$1 AND media_id=$2`, [route, target.id]);
    absent(await download(target.id, 'original', 'owner'));
    absent(await download(target.id));
    if (flag === 'erased') expect((await call('GET', `/v1/media/${target.id}`)).body.media.state).toBe('erased');
  }
  const rejected = await upload();
  await db.admin.query("UPDATE content.media SET state='rejected',decision='invalid-image' WHERE route=$1 AND media_id=$2", [route, rejected.id]);
  absent(await download(rejected.id, 'original', 'owner'));
});

test('per-request download decisions check full current container chain and exact available variant', async () => {
  const media = await available();
  const conditional = { 'if-none-match': `"${derivativeHash}"` };
  expect((await download(media.id, 'webp-320', null, conditional)).status).toBe(200);
  await db.admin.query("UPDATE content.thread SET visibility='protected',security_revision=security_revision+1 WHERE route=$1 AND thread_id=$2", [route, thread]);
  try {
    absent(await download(media.id, 'webp-320', null, conditional));
    absent(await download(media.id, 'webp-320', 'other', conditional));
    await grant(owner.accountId, 'thread:read');
    const own = await download(media.id, 'webp-320', 'owner', conditional);
    expect(own.status).toBe(200);
    expect(own.body.cacheControl).toBe('private, no-store');
    await db.admin.query("DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='thread:read'", [route, thread, owner.accountId]);
    absent(await download(media.id, 'webp-320', 'owner', conditional));
  } finally { await db.admin.query("UPDATE content.thread SET visibility='published',security_revision=security_revision+1 WHERE route=$1 AND thread_id=$2", [route, thread]); }
  await db.admin.query("UPDATE content.board SET visibility='taken_down',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2", [routeOf(board), board]);
  try { absent(await download(media.id, 'webp-320', null, conditional)); }
  finally { await db.admin.query("UPDATE content.board SET visibility='published',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2", [routeOf(board), board]); }
});

test('Eden serializes .$complete.post and .$authorizeDownload.get as literal colon paths', async () => {
  const media = await reserve();
  const paths: string[] = [];
  const client = treaty<ReturnType<typeof createKernel>>('http://kernel.test', { fetcher: async (url, options) => {
    paths.push(String(url));
    return app.handle(new Request(url, options));
  } });
  const completed = await client.v1.media({ id: media.id }).$complete.post(completion(media), { headers: { authorization: 'Bearer owner', 'idempotency-key': JSON.stringify(Bun.randomUUIDv7()) } });
  expect(completed.status).toBe(200);
  const decision = await client.v1.media({ id: media.id }).$authorizeDownload.get({ query: { variant: 'original' }, headers: { authorization: 'Bearer owner' } });
  expect(decision.status).toBe(200);
  expect(paths[0]).toBe(`http://kernel.test/v1/media/${media.id}:complete`);
  expect(paths[1]).toBe(`http://kernel.test/v1/media/${media.id}:authorizeDownload?variant=original`);
});

test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  const media = await available();
  const report = await checkGrowth(db, {
    name: 'media exact variant and current independent container chain decision',
    scales: [32, 256, 2048], bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      for (let index = previous; index < scale; index++) {
        const r = index % 2 === 0 ? route : route + 16;
        const id = newId(r);
        await database.admin.query(`INSERT INTO content.media(route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,state,key,transaction_id)
          VALUES ($1,$2,$3,$4,$5,'post-image','image/png',256,'reserved',$6,$4)`, [r, id, r === route ? thread : newId(r), owner.accountId, `http-distractor-${index}`, `m/${id}/original`]);
      }
      await database.admin.query('ANALYZE content.media');
      await database.admin.query('ANALYZE content.media_variant');
    },
    async operation(database) {
      const decision = await decideDownload({ pool: database.pool, access }, media.id, { kind: 'anonymous' }, 'webp-320');
      expect(decision.allowed).toBe(true);
    },
  });
  console.log('GrowthReport', JSON.stringify(report));
  expect(report.samples.map(sample => sample.scale)).toEqual([32, 256, 2048]);
});
