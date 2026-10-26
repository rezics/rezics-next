import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { RATE_LIMIT_V1 } from '../../src/access/write-rate-budgets.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { routeOf, newId } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const issuer = 'https://media-complete-rate.example.test';
const audience = 'https://kernel.test';
const secret = 'media-complete-rate-test-secret-at-least-32-bytes';
const routeKey = new Uint8Array(32).fill(19);
const actions = [
  'media:create',
  'media:complete',
  'media:read_reservation',
  'media:read',
  'thread:read',
  'post:read',
  'board:read',
];
const sha256 = 'a'.repeat(64);

type Fixture = { accountId: string; boardId: string; threadId: string; route: number };
type CallResult = { status: number; body: unknown };

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let signingKey: CryptoKey;

beforeAll(async () => {
  db = await openGrowthDatabase();
  const pair = await generateKeyPair('ES256');
  signingKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'media-complete-rate', alg: 'ES256', use: 'sig' };
  const access = createAccess({
    actions: new Map(
      [...actions, 'media:erase'].map((action) => [
        action,
        {
          anonymous: action.endsWith(':read'),
          ...(action === 'media:create' ? { 'x-resource-types': ['content.media'] } : {}),
        },
      ]),
    ),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  app = createKernel({
    pool: db.pool,
    routeKey,
    access,
    writeRate: createWriteRateLimiter({ secret, overrides: '{}' }),
  });
});

afterAll(() => db?.close());

async function fixture(slot: number): Promise<Fixture> {
  const route = 0x5100 + slot * 16;
  const accountId = newId(route);
  const boardId = newId(route);
  const threadId = newId(route);
  await db.admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [route, accountId],
  );
  await db.admin.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Rate fixture','published',1,$3)`,
    [route, boardId, accountId],
  );
  await db.admin.query(
    `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,'Rate fixture','published',1,$3)`,
    [route, threadId, accountId, boardId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'media:create','(,)',$3)`,
    [route, threadId, accountId],
  );
  return { accountId, boardId, threadId, route };
}

async function bearer(accountId: string): Promise<string> {
  return new SignJWT({
    client_id: 'rezics-website',
    scope: actions.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'media-complete-rate' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
}

async function call(method: string, path: string, accountId: string, body: unknown, key: string): Promise<CallResult> {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await bearer(accountId)}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}

function reservationBody(threadId: string) {
  return {
    containerId: threadId,
    purpose: 'post-image',
    mediaType: 'image/png',
    byteCount: 256,
    sha256,
  };
}

function completionBody(threadId: string, reservationKey: string) {
  return {
    containerId: threadId,
    reservationRequestId: reservationKey,
    byteCount: 256,
    sha256,
  };
}

async function reserve(target: Fixture) {
  const reservationKey = Bun.randomUUIDv7();
  const result = await call('POST', '/v1/media', target.accountId, reservationBody(target.threadId), reservationKey);
  expect(result.status).toBe(201);
  const mediaId = (result.body as { media: { id: string } }).media.id;
  return { mediaId, reservationKey };
}

async function rateCount(accountId: string, family: 'upload' | 'write'): Promise<number> {
  const identity = createHmac('sha256', secret).update(`account:${accountId}`).digest('hex');
  const result = await db.admin.query<{ count: number }>(
    'SELECT count FROM access.write_rate_counter WHERE route=$1 AND identity_digest=$2 AND family=$3',
    [routeOf(accountId), identity, family],
  );
  return result.rows[0]?.count ?? 0;
}

test.serial('a new account completes five uploads within the production daily upload budget', async () => {
  const target = await fixture(1);
  for (let index = 0; index < RATE_LIMIT_V1['new-account'].upload.maximum; index++) {
    const reservationKey = Bun.randomUUIDv7();
    const reserved = await call(
      'POST',
      '/v1/media',
      target.accountId,
      reservationBody(target.threadId),
      reservationKey,
    );
    expect(reserved.status).toBe(201);
    const mediaId = (reserved.body as { media: { id: string } }).media.id;
    const completed = await call(
      'POST',
      `/v1/media/${mediaId}:complete`,
      target.accountId,
      completionBody(target.threadId, reservationKey),
      Bun.randomUUIDv7(),
    );
    expect(completed.status).toBe(200);
  }

  expect(await rateCount(target.accountId, 'upload')).toBe(RATE_LIMIT_V1['new-account'].upload.maximum);
  expect(await rateCount(target.accountId, 'write')).toBe(RATE_LIMIT_V1['new-account'].upload.maximum);
  const deniedReservation = await call(
    'POST',
    '/v1/media',
    target.accountId,
    reservationBody(target.threadId),
    Bun.randomUUIDv7(),
  );
  expect(deniedReservation.status).toBe(429);
  expect(await rateCount(target.accountId, 'upload')).toBe(RATE_LIMIT_V1['new-account'].upload.maximum);
});

test.serial('a denied completion spends no upload unit', async () => {
  const target = await fixture(2);
  const reserved = await reserve(target);
  const removed = await db.admin.query(
    `DELETE FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
       AND grant_role='content.media.owner'`,
    [target.route, reserved.mediaId, target.accountId],
  );
  expect(removed.rowCount).toBe(1);

  const denied = await call(
    'POST',
    `/v1/media/${reserved.mediaId}:complete`,
    target.accountId,
    completionBody(target.threadId, reserved.reservationKey),
    Bun.randomUUIDv7(),
  );
  expect(denied.status).toBe(403);
  expect(await rateCount(target.accountId, 'upload')).toBe(1);
  expect(await rateCount(target.accountId, 'write')).toBe(1);
});

test.serial('completion uses the completing principal write budget', async () => {
  const target = await fixture(3);
  const reserved = await reserve(target);
  const identity = createHmac('sha256', secret).update(`account:${target.accountId}`).digest('hex');
  const writeMaximum = RATE_LIMIT_V1['new-account'].write.maximum;
  await db.admin.query(
    `INSERT INTO access.write_rate_counter(route,identity_digest,family,count,expires_at)
     VALUES ($1,$2,'write',$3,statement_timestamp() + interval '60 seconds')`,
    [routeOf(target.accountId), identity, writeMaximum - 1],
  );

  const completed = await call(
    'POST',
    `/v1/media/${reserved.mediaId}:complete`,
    target.accountId,
    completionBody(target.threadId, reserved.reservationKey),
    Bun.randomUUIDv7(),
  );
  expect(completed.status).toBe(200);
  expect(await rateCount(target.accountId, 'write')).toBe(writeMaximum);
  expect(await rateCount(target.accountId, 'upload')).toBe(1);

  const exhausted = await call(
    'POST',
    `/v1/media/${reserved.mediaId}:complete`,
    target.accountId,
    completionBody(target.threadId, reserved.reservationKey),
    Bun.randomUUIDv7(),
  );
  expect(exhausted.status).toBe(429);
  expect(await rateCount(target.accountId, 'write')).toBe(writeMaximum);
  expect(await rateCount(target.accountId, 'upload')).toBe(1);
});
