import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { productionActions } from '../support/production-actions.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;
let signingKey: CryptoKey;
const accountId = newId(0x4312);
const otherId = newId(0x2345);
const issuer = 'https://avatar-auth.example.test';
const hash = 'a'.repeat(64);

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  for (const id of [accountId, otherId])
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
  // A grant on another account must not authorize choosing its avatar container.
  for (const id of [accountId, otherId])
    await db.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES ($1,$2,$3,'media:create','(,)',$3)`,
      [routeOf(id), id, accountId],
    );
  const pair = await generateKeyPair('ES256');
  signingKey = pair.privateKey;
  const publicKey = { ...(await exportJWK(pair.publicKey)), kid: 'avatar-http', alg: 'ES256', use: 'sig' };
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(7),
    access: createAccess({
      actions: productionActions(),
      auth: {
        issuer,
        audience: 'https://kernel.test',
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: async () => Response.json({ keys: [publicKey] }),
      },
    }),
    writeRate: createWriteRateLimiter({
      secret: 'avatar-http-test-only-secret-at-least-32-bytes',
      overrides: JSON.stringify({ 'new-account': { upload: { maximum: 10000, seconds: 60 } } }),
    }),
  });
});
afterAll(() => db?.close());

async function call(method: string, path: string, body?: unknown, key = Bun.randomUUIDv7()) {
  const token = await new SignJWT({
    client_id: 'rezics-website',
    scope: 'media:create media:complete media:read_reservation',
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'avatar-http' })
    .setIssuer(issuer)
    .setAudience('https://kernel.test')
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, status: response.status, body: await response.json() };
}
const input = (containerId = accountId) => ({
  containerId,
  purpose: 'avatar',
  mediaType: 'image/png',
  byteCount: 256,
});

test('an account reserves and completes an avatar through the media routes with its own account as container, and the reservation response describes the avatar', async () => {
  const key = Bun.randomUUIDv7();
  const reserved = await call('POST', '/v1/media', input(), key);
  expect(reserved.status).toBe(201);
  const id = reserved.body.media.id as string;
  expect(routeOf(id)).toBe(routeOf(accountId));
  expect(reserved.body).toEqual({
    media: {
      id,
      purpose: 'avatar',
      state: 'reserved',
      byteCount: 256,
      mediaType: 'image/png',
      sha256: null,
      containerId: accountId,
      uploaderId: accountId,
      key: `m/${id}/original`,
      reservationRequestId: key,
    },
  });
  expect(reserved.response.headers.get('location')).toBe(`/v1/media/${id}`);
  expect(reserved.response.headers.get(SESSION_HEADER)).toBeString();
  expect(reserved.response.headers.get('cache-control')).toBe('private, no-store');
  expect((await call('POST', '/v1/media', input(), key)).body).toEqual(reserved.body);
  const preflight = await call('GET', `/v1/media/${id}`);
  expect(preflight.status).toBe(200);
  expect(preflight.body).toEqual(reserved.body);

  const completion = { containerId: accountId, reservationRequestId: key, byteCount: 256, sha256: hash };
  const completionKey = Bun.randomUUIDv7();
  const completed = await call('POST', `/v1/media/${id}:complete`, completion, completionKey);
  expect(completed.status).toBe(200);
  expect(completed.body).toEqual({ media: { id, state: 'uploaded' } });
  expect(completed.response.headers.get(SESSION_HEADER)).toBeString();
  expect(completed.response.headers.get('cache-control')).toBe('private, no-store');
  expect((await call('POST', `/v1/media/${id}:complete`, completion, completionKey)).body).toEqual(completed.body);
  expect((await call('GET', `/v1/media/${id}`)).body).toEqual({
    media: { ...reserved.body.media, state: 'uploaded', sha256: hash },
  });
});

test('reserving an avatar for another account is refused as not found', async () => {
  for (const containerId of [otherId, newId(0x2345)]) {
    const result = await call('POST', '/v1/media', input(containerId));
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ code: 'not_found', effect_status: 'not_applied' });
    expect(result.body).not.toHaveProperty('media');
    const rows = await db.admin.query('SELECT media_id FROM content.media WHERE route=$1 AND container_id=$2', [
      routeOf(containerId),
      containerId,
    ]);
    expect(rows.rows).toEqual([]);
  }
});

test('avatar reservations require an account container and reject new-thread targets and unknown fields', async () => {
  const { containerId: _containerId, ...fields } = input();
  for (const body of [
    fields,
    { ...fields, newThread: { boardId: newId(0x9876), idempotencyKey: Bun.randomUUIDv7() } },
    { ...input(), uploaderId: accountId },
  ])
    expect((await call('POST', '/v1/media', body)).status).toBe(400);
});

test('avatar upload advice is a private current observation mounted before media id', async () => {
  const result = await call('GET', '/v1/media/avatar-upload-advice');
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    viewerState: 'signed_in',
    viewer: { accountId },
    target: { containerId: accountId, purpose: 'avatar' },
    constraints: {
      mediaTypes: ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'],
      maxByteCount: 20_971_520,
    },
    allowedActions: ['upload'],
  });
  expect(result.response.headers.get('cache-control')).toBe('private, no-store');
  expect((await call('GET', '/v1/media/avatar-upload-advice?extra=1')).status).toBe(400);
});
