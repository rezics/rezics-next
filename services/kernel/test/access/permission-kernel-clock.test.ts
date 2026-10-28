import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { PoolClient } from 'pg';
import { createAccess as createPermissionAccess } from '../../src/access/permission.ts';
import timeRead from '../../src/access/permission-time.sql';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { accessCheck, type AccessCheck, type AccountActor, type Resource } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
const route = 0x4312;
const board = newId(0x9876);
const thread = newId(route);
const ownerId = newId(0x1234);
const hash = 'a'.repeat(64);
const issuer = 'https://kernel-clock.example.test';
const audience = 'https://kernel.test';
const scopes = ['media:create', 'media:read_reservation'];
const owner: AccountActor = {
  kind: 'account',
  accountId: ownerId,
  clientId: 'rezics-website',
  scopes,
  requestedBy: null,
  authnEpoch: 1,
};
const yearMs = 365.25 * 24 * 60 * 60 * 1000;
let databaseNow = Date.now();
let kernelNow = new Date();
const clock = () => new Date(kernelNow);
let app: ReturnType<typeof createKernel>;
let signingKey: CryptoKey;

function yearsFrom(base: number, years: number): Date {
  const date = new Date(base);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date;
}
async function bearer(at: Date) {
  const issuedAt = Math.floor(at.getTime() / 1000);
  return new SignJWT({
    client_id: owner.clientId,
    scope: owner.scopes.join(' '),
    authn_epoch: owner.authnEpoch,
    auth_time: issuedAt,
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'kernel-clock' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(owner.accountId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(signingKey);
}
async function call(method: string, path: string, body?: unknown, tokenTime = new Date(Date.now())) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await bearer(tokenTime)}`,
        ...(body === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const now = await pool.query<{ at: string }>('SELECT clock_timestamp()::text AS at');
  databaseNow = Date.parse(now.rows[0]!.at);
  kernelNow = yearsFrom(databaseNow, 2);
  await pool.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [routeOf(ownerId), ownerId],
  );
  await pool.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Images','published',1,$3)`,
    [routeOf(board), board, ownerId],
  );
  await pool.query(
    `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,'Images','published',1,$3)`,
    [route, thread, ownerId, board],
  );
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'media:create','(,)',$3)`,
    [route, thread, ownerId],
  );
  const pair = await generateKeyPair('ES256');
  signingKey = pair.privateKey;
  const publicKey = { ...(await exportJWK(pair.publicKey)), kid: 'kernel-clock', alg: 'ES256', use: 'sig' };
  app = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(7),
    clock,
    writeRate: createWriteRateLimiter({
      secret: 'kernel-clock-test-only-secret-at-least-32-bytes',
      overrides: JSON.stringify({ 'new-account': { upload: { maximum: 10000, seconds: 60 } } }),
    }),
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => Response.json({ keys: [publicKey] }),
        },
      }),
  });
}, 30_000);
afterAll(() => pool.end());

test.serial('a create and the following read share a kernel clock two years ahead of PostgreSQL', async () => {
  expect(kernelNow.getTime() - databaseNow).toBeGreaterThan(yearMs);
  const created = await call('POST', '/v1/media', {
    containerId: thread,
    purpose: 'post-image',
    mediaType: 'image/png',
    byteCount: 256,
    sha256: hash,
  });
  expect(created.status).toBe(201);
  const mediaId = created.body.media.id as string;
  const read = await call('GET', `/v1/media/${mediaId}`);
  expect(read.status).toBe(200);
  expect(read.body.media.id).toBe(mediaId);

  const grant = await pool.query<{ starts: string }>(
    `SELECT lower(valid)::text AS starts FROM access.resource_role_grant
    WHERE route = $1 AND resource_id = $2 AND grant_role = 'content.media.owner'`,
    [route, mediaId],
  );
  const starts = Date.parse(grant.rows[0]!.starts);
  expect(starts).toBeGreaterThan(databaseNow + yearMs);

  kernelNow = yearsFrom(databaseNow, -2);
  expect(databaseNow - kernelNow.getTime()).toBeGreaterThan(yearMs);
  expect(starts).toBeGreaterThan(kernelNow.getTime());
  const hidden = await call('GET', `/v1/media/${mediaId}`);
  expect(hidden.status).toBe(404);
  const row = await pool.query('SELECT media_id FROM content.media WHERE route = $1 AND media_id = $2', [
    route,
    mediaId,
  ]);
  expect(row.rowCount).toBe(1);
});

test.serial('a wall-time token is accepted with the kernel clock two years ahead of PostgreSQL', async () => {
  kernelNow = yearsFrom(databaseNow, 2);
  const response = await call(
    'POST',
    '/v1/media',
    {
      containerId: thread,
      purpose: 'post-image',
      mediaType: 'image/png',
      byteCount: 256,
      sha256: hash,
    },
    new Date(),
  );
  expect(response.status).toBe(201);
});

function normalize(statement: string): string {
  return statement.replace(/\s+/g, ' ').trim().replace(/;$/, '');
}
async function timeBinding(check: AccessCheck): Promise<unknown> {
  const client = await pool.connect();
  const calls: { text: string; values: unknown[] }[] = [];
  const wrapped = Object.create(client) as PoolClient;
  wrapped.query = ((...args: unknown[]) => {
    const first = args[0];
    const text =
      typeof first === 'string'
        ? first
        : first && typeof first === 'object' && 'text' in first
          ? String((first as { text: string }).text)
          : '';
    const values =
      first && typeof first === 'object' && 'values' in first && Array.isArray((first as { values: unknown }).values)
        ? (first as { values: unknown[] }).values
        : Array.isArray(args[1])
          ? args[1]
          : [];
    calls.push({ text, values });
    return client.query(...(args as Parameters<PoolClient['query']>));
  }) as PoolClient['query'];
  try {
    await check(wrapped);
  } finally {
    client.release();
  }
  const time = calls.find((call) => normalize(call.text) === normalize(timeRead.sql));
  if (!time) throw new Error(`Permission time statement was not sent:\n${calls.map((call) => call.text).join('\n')}`);
  return time.values[0];
}

test.serial('access without a clock binds an empty instant and reads PostgreSQL time', async () => {
  const actorId = newId(0x2468);
  const current: Resource = { route: 0x1357, id: newId(0x1357) };
  const later: Resource = { route: 0x1357, id: newId(0x1357) };
  const action = 'subject:read';
  const actor: AccountActor = {
    kind: 'account',
    accountId: actorId,
    clientId: 'third-party',
    scopes: [action],
    requestedBy: null,
    authnEpoch: 1,
  };
  await pool.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [routeOf(actorId), actorId],
  );
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,$4,tstzrange(clock_timestamp() - interval '1 day', clock_timestamp() + interval '1 day', '[)'),$3)`,
    [current.route, current.id, actorId, action],
  );
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,$4,tstzrange(clock_timestamp() + interval '1 day', NULL, '[)'),$3)`,
    [later.route, later.id, actorId, action],
  );
  const account = await readAccount(pool, routeOf(actorId)!, actorId);
  const context = { pool, deadline: Date.now() + 5000, account };
  const actions = new Map([[action, { anonymous: false }]]);
  const database = createPermissionAccess({ actions, accountEvidence: (_actor, request) => request.account });
  const ahead = createPermissionAccess({
    actions,
    accountEvidence: (_actor, request) => request.account,
    clock: () => yearsFrom(databaseNow, 2),
  });

  const open = await accessCheck(database, actor, action, current, context);
  expect(await timeBinding(open)).toBe('');
  expect(await open(pool)).toBe(true);
  const unopened = await accessCheck(database, actor, action, later, context);
  expect(await unopened(pool)).toBe(false);
  const shifted = await accessCheck(ahead, actor, action, current, context);
  expect(await timeBinding(shifted)).toBe(yearsFrom(databaseNow, 2).toISOString());
  expect(await shifted(pool)).toBe(false);
});
