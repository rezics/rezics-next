import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  createAuthService,
  WEBSITE_CLIENT_ID,
  type AccessAccount,
  type AuthService,
  type PublicJwks,
} from '@rezics/auth';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { fromPlainText } from '@rezics/document';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { threadTarget } from '../../src/content/commands.ts';
import { openGrowthDatabase, checkGrowth, type GrowthDatabase } from '../support/growth.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const audience = 'https://kernel.new-thread-media.example.test';
const password = 'correct horse battery staple';
const routeKey = new Uint8Array(32).fill(37);
const boardId = newId(0x4321);
const subjectId = newId(0x4321);
const authorId = newId(0x1234);
const otherId = newId(0x2345);
const hash = createHash('sha256').update('new-thread-image').digest('hex');
const actionNames = [
  'board:read',
  'board:manage',
  'thread:create',
  'thread:read',
  'post:create',
  'post:read',
  'post:revise',
  'post:erase',
  'report:create',
  'media:create',
  'media:read_reservation',
  'media:read',
  'media:complete',
  'media:erase',
];
const loginScopes = actionNames.filter((action) => action !== 'media:complete');
const websiteScopes = ['openid', 'offline_access', ...actionNames];

let db: GrowthDatabase;
let authAdmin: Pool;
let authPool: Pool;
let auth: AuthService;
let app: ReturnType<typeof createKernel>;
let authorBearer: string;
let otherBearer: string;
let issuer: string;
let redirectUri: string;
let websiteKey: Awaited<ReturnType<typeof generateKeyPair>>;
let websiteKeyId: string;
let authDatabaseName: string;
const accounts = new Map<string, AccessAccount>();
const approvals = new Set<string>();

async function issueWebsite(accountId: string): Promise<string> {
  const login = await auth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `${accountId}@example.test`,
        password,
        client_id: 'thread-media-login',
        scope: loginScopes,
      }),
    }),
  );
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const authorization = new URL(`${issuer}/authorize`);
  authorization.search = new URLSearchParams({
    client_id: WEBSITE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: websiteScopes.join(' '),
    state,
    nonce: state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: audience,
  }).toString();
  const codeResponse = await auth.handler(new Request(authorization, { headers: { cookie }, redirect: 'manual' }));
  expect([302, 303]).toContain(codeResponse.status);
  const code = new URL(codeResponse.headers.get('location')!).searchParams.get('code');
  expect(code).toBeString();
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: websiteKeyId })
    .setIssuer(WEBSITE_CLIENT_ID)
    .setSubject(WEBSITE_CLIENT_ID)
    .setAudience(issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .setJti(randomBytes(24).toString('base64url'))
    .sign(websiteKey.privateKey);
  const token = await auth.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: WEBSITE_CLIENT_ID,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        resource: audience,
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    }),
  );
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  authAdmin = new Pool({ connectionString: db.url, max: 1 });
  authDatabaseName = `new_thread_media_auth_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  await authAdmin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(db.url);
  authUrl.pathname = `/${authDatabaseName}`;
  const { migrate } = await import('../../../auth/scripts/database.ts');
  migrate(authUrl.toString());
  authPool = new Pool({ connectionString: authUrl.toString(), max: 2 });

  const issuerKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'new-thread-media-issuer',
    alg: 'ES256',
  };
  websiteKey = await generateKeyPair('ES256', { extractable: true });
  websiteKeyId = 'new-thread-media-website';
  const publicJwks = {
    keys: [{ ...(await exportJWK(websiteKey.publicKey)), kid: websiteKeyId, alg: 'ES256', use: 'sig' }],
  } as PublicJwks;
  issuer = 'https://auth.new-thread-media.example.test';
  redirectUri = `${issuer}/website/callback`;
  auth = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'new-thread-media-auth-fixture-secret-at-least-32-bytes',
    signing: { activeKid: issuerKey.kid, privateKeys: [issuerKey] },
    siteActions: new Map(actionNames.map((action) => [action, { anonymous: false }])),
    trustedAccess: trustedAccessPorts({
      async readAccount(accountId) {
        return accounts.get(accountId) ?? null;
      },
      async authorizeProvisioning(accountId) {
        if (!approvals.delete(accountId)) throw new Error('Missing trusted account provisioning approval');
        return { accountId };
      },
    }),
  });
  await auth.internal.registerClient({ clientId: 'thread-media-login', firstParty: true, scopes: loginScopes });
  await auth.internal.registerWebsiteClient({
    publicJwks,
    redirectUris: [redirectUri],
    postLogoutRedirectUris: [`${issuer}/`],
    scopes: websiteScopes,
  });

  for (const accountId of [authorId, otherId]) {
    const account: AccessAccount = {
      accountId,
      kind: 'actor',
      state: 'pending',
      authnEpoch: 1,
      automated: false,
    };
    accounts.set(accountId, account);
    approvals.add(accountId);
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
       VALUES ($1,$2,'actor','pending',$2)`,
      [routeOf(accountId), accountId],
    );
    await auth.internal.provisionPassword({
      authorization: accountId,
      email: `${accountId}@example.test`,
      password,
    });
    account.state = 'active';
    await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
      routeOf(accountId),
      accountId,
    ]);
  }
  authorBearer = await issueWebsite(authorId);
  otherBearer = await issueWebsite(otherId);

  const access = createAccess({
    actions: new Map(
      actionNames.map((action) => [
        action,
        {
          anonymous: action.endsWith(':read'),
          ...(action === 'media:create'
            ? { 'x-resource-types': ['content.media'] }
            : action === 'thread:create'
              ? { 'x-resource-types': ['content.thread', 'content.post'] }
              : action === 'post:create'
                ? { 'x-resource-types': ['content.post'] }
                : {}),
        },
      ]),
    ),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async (url, init) => auth.handler(new Request(url, init)),
    },
  });
  app = createKernel({
    pool: db.pool,
    routeKey,
    access,
    writeRate: createWriteRateLimiter({
      secret: 'new-thread-media-rate-limit-secret-at-least-32-bytes',
      overrides: JSON.stringify({
        anonymous: { upload: { maximum: 1000, seconds: 60 } },
        'new-account': { upload: { maximum: 1000, seconds: 60 } },
        member: { upload: { maximum: 1000, seconds: 60 } },
        trusted: { upload: { maximum: 1000, seconds: 60 } },
        service: { upload: { maximum: 1000, seconds: 60 } },
      }),
    }),
  });
  await db.admin.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'New thread media','published',1,$4)`,
    [routeOf(boardId), boardId, subjectId, randomUUID()],
  );
  for (const action of ['thread:create', 'media:create', 'board:read'])
    await db.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES ($1,$2,$3,$4,'(,)',$3)`,
      [routeOf(boardId), boardId, authorId, action],
    );
}, 120_000);

afterAll(async () => {
  await authPool?.end();
  if (authAdmin && authDatabaseName) await dropTestDatabase(authAdmin, authDatabaseName);
  await authAdmin?.end();
  await db?.close();
});

function snapshot(text: string) {
  return fromPlainText(text);
}

function threadInput(mediaIds: string[] = []) {
  return {
    title: 'Opening image',
    body: snapshot('Opening post with its reserved image'),
    licence: 'CC-BY-SA-4.0',
    subjectIds: [],
    boardId,
    visibility: 'published',
    mediaIds,
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  key = randomUUID(),
  bearer: string | null = authorBearer,
) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: await response.json() };
}

async function reserveNewThread(threadKey: string, requestKey = randomUUID()) {
  return call(
    'POST',
    '/v1/media',
    {
      newThread: { boardId, idempotencyKey: threadKey },
      purpose: 'post-image',
      mediaType: 'image/png',
      byteCount: 256,
      sha256: hash,
    },
    requestKey,
  );
}

function completion(media: { id: string; containerId: string; reservationRequestId: string }) {
  return {
    containerId: media.containerId,
    reservationRequestId: media.reservationRequestId,
    byteCount: 256,
    sha256: hash,
  };
}

async function markAvailable(mediaId: string) {
  const route = routeOf(mediaId)!;
  await db.admin.query(
    "UPDATE content.media SET state='available',actual_byte_count=byte_count,sha256=$3 WHERE route=$1 AND media_id=$2",
    [route, mediaId, hash],
  );
}

async function rowCounts(route: number) {
  const partition = partitionOf(route);
  const names = ['content.thread', 'content.post', 'content.revision', 'content.media', 'core.receipt', 'core.outbox'];
  return Promise.all(
    names.map(async (name) => {
      const where = name === 'core.receipt' || name === 'core.outbox' ? 'partition_no=$1' : 'route=$1';
      const value = await db.admin.query(`SELECT count(*)::integer AS count FROM ${name} WHERE ${where}`, [
        name === 'core.receipt' || name === 'core.outbox' ? partition : route,
      ]);
      return value.rows[0]!.count;
    }),
  );
}

async function seedMedia(input: {
  containerId: string;
  uploaderId: string;
  state: 'available' | 'rejected';
  reservationRequestId: string;
}) {
  const route = routeOf(input.containerId)!;
  const mediaId = newId(route);
  await db.admin.query(
    `INSERT INTO content.media
      (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,
       actual_byte_count,sha256,state,decision,key,transaction_id)
     VALUES ($1,$2,$3,$4,$5,'post-image','image/png',256,256,$6,$7,$8,$9,$10)`,
    [
      route,
      mediaId,
      input.containerId,
      input.uploaderId,
      input.reservationRequestId,
      hash,
      input.state,
      input.state === 'rejected' ? 'fixture-rejected' : null,
      `m/${mediaId}/original`,
      newId(route),
    ],
  );
  return mediaId;
}

test('author reserves and uploads images for a new thread, then claims them on its opening post', async () => {
  const key = randomUUID();
  const reserved = await reserveNewThread(key);
  expect(reserved.response.status).toBe(201);
  const media = reserved.body.media as { id: string; containerId: string; reservationRequestId: string };
  const target = threadTarget(routeKey, authorId, key);
  expect(media.containerId).toBe(target.id);
  expect(routeOf(media.id)).toBe(target.route);

  const uploaded = await call('POST', `/v1/media/${media.id}:complete`, completion(media));
  expect(uploaded.response.status).toBe(200);
  expect(uploaded.body).toEqual({ media: { id: media.id, state: 'uploaded' } });
  await markAvailable(media.id);

  const created = await call('POST', '/v1/threads', threadInput([media.id]), key);
  expect(created.response.status).toBe(201);
  expect(created.response.headers.get(SESSION_HEADER)).toBeTruthy();
  expect(created.body.thread.id).toBe(target.id);
  expect(created.body.thread.firstPost.mediaIds).toEqual([media.id]);
  const claimed = await db.admin.query(
    'SELECT container_id,claimed_at FROM content.media WHERE route=$1 AND media_id=$2',
    [target.route, media.id],
  );
  expect(claimed.rows).toHaveLength(1);
  expect(claimed.rows[0]).toMatchObject({ container_id: target.id });
  expect(claimed.rows[0].claimed_at).not.toBeNull();

  const conflicting = await call('POST', '/v1/threads', threadInput([]), key);
  expect(conflicting.response.status).toBe(422);
  expect(conflicting.body.code).toBe('idempotency_conflict');

  const beforeConflict = await rowCounts(target.route);
  const existingTarget = await reserveNewThread(key, randomUUID());
  expect(existingTarget.response.status).toBe(409);
  expect(existingTarget.body.code).toBe('conflict');
  expect(await rowCounts(target.route)).toEqual(beforeConflict);
  const existingContainer = await call('POST', '/v1/media', {
    containerId: target.id,
    purpose: 'post-image',
    mediaType: 'image/png',
    byteCount: 256,
    sha256: hash,
  });
  expect(existingContainer.response.status).toBe(201);
  expect(existingContainer.body.media.containerId).toBe(target.id);
});

test('invalid ownership, reservation key, availability, and anonymous requests do not create or claim content', async () => {
  const otherKey = randomUUID();
  const otherTarget = threadTarget(routeKey, otherId, otherKey);
  const beforeOtherReservation = await rowCounts(otherTarget.route);
  const otherReservation = await call(
    'POST',
    '/v1/media',
    {
      newThread: { boardId, idempotencyKey: otherKey },
      purpose: 'post-image',
      mediaType: 'image/png',
      byteCount: 256,
      sha256: hash,
    },
    randomUUID(),
    otherBearer,
  );
  expect(otherReservation.response.status).toBe(403);
  expect(await rowCounts(otherTarget.route)).toEqual(beforeOtherReservation);

  const cases = [
    {
      label: 'another account owns the media',
      async mediaId(containerId: string) {
        return seedMedia({
          containerId,
          uploaderId: otherId,
          state: 'available',
          reservationRequestId: `other-owner-${randomUUID()}`,
        });
      },
    },
    {
      label: 'media is reserved under another key',
      async mediaId(_containerId: string) {
        const result = await reserveNewThread(randomUUID());
        expect(result.response.status).toBe(201);
        return result.body.media.id as string;
      },
    },
    {
      label: 'media is unavailable',
      async mediaId(containerId: string) {
        return seedMedia({
          containerId,
          uploaderId: authorId,
          state: 'rejected',
          reservationRequestId: `unavailable-${randomUUID()}`,
        });
      },
    },
  ];
  for (const entry of cases) {
    const key = randomUUID();
    const target = threadTarget(routeKey, authorId, key);
    const mediaId = await entry.mediaId(target.id);
    const before = await rowCounts(target.route);
    const result = await call('POST', '/v1/threads', threadInput([mediaId]), key);
    expect(result.response.status, entry.label).toBe(409);
    expect(result.body.code, entry.label).toBe('media_unavailable');
    expect(await rowCounts(target.route), entry.label).toEqual(before);
    const row = await db.admin.query('SELECT claimed_at FROM content.media WHERE route=$1 AND media_id=$2', [
      routeOf(mediaId),
      mediaId,
    ]);
    expect(row.rows[0]?.claimed_at, entry.label).toBeNull();
  }

  const anonymousKey = randomUUID();
  const anonymousTarget = threadTarget(routeKey, authorId, anonymousKey);
  const before = await rowCounts(anonymousTarget.route);
  const anonymousReserveAttempt = await call(
    'POST',
    '/v1/media',
    {
      newThread: { boardId, idempotencyKey: anonymousKey },
      purpose: 'post-image',
      mediaType: 'image/png',
      byteCount: 256,
      sha256: hash,
    },
    randomUUID(),
    null,
  );
  expect(anonymousReserveAttempt.response.status).toBe(401);
  const anonymousCreate = await call('POST', '/v1/threads', threadInput(), anonymousKey, null);
  expect(anonymousCreate.response.status).toBe(401);
  expect(await rowCounts(anonymousTarget.route)).toEqual(before);
});

test('malformed media reference lists return invalid requests without creating content', async () => {
  const route = routeOf(boardId)!;
  const repeatedId = newId(route);
  const malformed: unknown[] = [null, Array.from({ length: 33 }, () => newId(route)), [1], [repeatedId, repeatedId]];
  const before = await rowCounts(route);
  for (const mediaIds of malformed) {
    const result = await call('POST', '/v1/threads', { ...threadInput(), mediaIds });
    expect(result.response.status).toBe(400);
    expect(result.body.code).toBe('invalid_request');
  }
  expect(await rowCounts(route)).toEqual(before);
});

test('new-thread reservation stays bounded as other uploaders add same-route media rows', async () => {
  const threadKey = randomUUID();
  const target = threadTarget(routeKey, authorId, threadKey);
  const r = target.route;
  const report = await checkGrowth(db, {
    name: 'new-thread media reservation',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      // Neighbouring grants and receipts keep every key index worth its cost to the planner at the smallest scale,
      // where it would otherwise scan a table of a few dozen rows once per probe.
      if (previous === 0)
        for (const neighbourRoute of [r, 0x5678]) {
          const resources = Array.from({ length: 2048 }, () => newId(neighbourRoute));
          const transaction = randomUUID();
          await database.admin.query(
            `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
             SELECT $1,resource_id,$2,'media:read','(,)',$3 FROM unnest($4::uuid[]) AS resource_id`,
            [neighbourRoute, otherId, transaction, resources],
          );
          await database.admin.query(
            `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
             SELECT $1,resource_id,$2,'content.media.owner','(,)',$3 FROM unnest($4::uuid[]) AS resource_id`,
            [neighbourRoute, otherId, transaction, resources],
          );
          await database.admin.query(
            `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
             SELECT $1,'account',$2,'content.media.reserve',key,sha256(convert_to(key,'UTF8')),1,1,$3,'{}'
             FROM unnest($4::text[]) AS key`,
            [partitionOf(neighbourRoute), otherId, transaction, resources],
          );
        }
      const batchSize = 1000;
      for (let start = previous; start < scale; start += batchSize) {
        const values = Array.from({ length: Math.min(batchSize, scale - start) }, (_, offset) => {
          const index = start + offset;
          const mediaId = newId(r);
          return {
            route: r,
            media_id: mediaId,
            container_id: newId(r),
            uploader_id: otherId,
            reservation_request_id: `new-thread-distractor-${index}`,
            purpose: 'post-image',
            media_type: 'image/png',
            byte_count: 256,
            state: 'reserved',
            key: `m/${mediaId}/original`,
            transaction_id: newId(r),
          };
        });
        await database.admin.query(
          `INSERT INTO content.media
             (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,state,key,transaction_id)
           SELECT route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,state,key,transaction_id
           FROM jsonb_populate_recordset(NULL::content.media,$1::jsonb)`,
          [JSON.stringify(values)],
        );
      }
      await database.admin.query('ANALYZE content.media');
    },
    async operation() {
      const reserved = await reserveNewThread(threadKey);
      expect(reserved.response.status).toBe(201);
      expect(reserved.body.media.containerId).toBe(target.id);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
  expect(report.bounds).toEqual({ rows: 'constant', statements: 'constant', blocks: 'logarithmic' });
});
