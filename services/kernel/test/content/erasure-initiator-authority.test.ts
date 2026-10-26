import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const issuer = 'https://erasure-authority.auth.test';
const audience = 'https://api.rezics.test';
const scopes = ['account:read', 'access:grant', 'post:erase'];
const governorScopes = ['access:grant', 'post:read', 'post:revise', 'post:erase', 'media:create'];
const routeKey = new Uint8Array(32).fill(41);
const sessionKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(42)]]) };
const nextRoute = { value: 0x6a30 };
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwk: Awaited<ReturnType<typeof exportJWK>> & { kid: string; alg: string };

type Scenario = {
  route: number;
  actorId: string;
  governorId: string;
  threadId: string;
  postId: string;
  revisionId: string;
  boardId: string;
  actorToken: string;
  governorToken: string;
};

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const keys = await generateKeyPair('ES256', { extractable: true });
  privateKey = keys.privateKey;
  jwk = { ...(await exportJWK(keys.publicKey)), kid: 'erasure-authority', alg: 'ES256' };
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens: sessionKeys,
    writeRate: createWriteRateLimiter({ secret: 'erasure-authority-test-rate-secret-at-least-32-bytes' }),
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/jwks`,
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
  });
});

afterAll(async () => {
  await db?.close();
});

async function token(accountId: string, selectedScopes: readonly string[]) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    client_id: 'web',
    scope: selectedScopes.join(' '),
    authn_epoch: 1,
    auth_time: now,
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(accountId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

async function fixture(): Promise<Scenario> {
  const route = nextRoute.value;
  nextRoute.value += 16;
  const actorId = newId(route + 1);
  const governorId = newId(route + 2);
  const threadId = newId(route);
  const postId = newId(route);
  const revisionId = newId(route);
  const boardId = newId(route);
  const body = Buffer.from(serializeDocument(fromPlainText('Erasure authority fixture')));
  const transactionId = newId(route);

  for (const accountId of [actorId, governorId]) {
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,'actor','active',$3)`,
      [routeOf(accountId), accountId, transactionId],
    );
  }
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `INSERT INTO content.thread
        (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
        VALUES ($1,$2,$3,$4,'Erasure fixture','published',1,$5)`,
      [route, threadId, actorId, boardId, transactionId],
    );
    await client.query(
      `INSERT INTO content.post
        (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at)
        VALUES ($1,$2,$3,$4,$5,'published',1,$6,'2020-01-01T00:00:00Z')`,
      [route, threadId, postId, actorId, revisionId, transactionId],
    );
    await client.query(
      `INSERT INTO content.revision
        (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
        VALUES ($1,$2,$3,$4,$5,sha256($5),'Erasure authority fixture','CC0-1.0','{}',$6,'available',$7)`,
      [route, threadId, postId, revisionId, body, boardId, transactionId],
    );
    await client.query('UPDATE content.thread SET first_post_id=$3 WHERE route=$1 AND thread_id=$2', [
      route,
      threadId,
      postId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await db.admin.query(
    `INSERT INTO access.resource_role_grant
      (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
      VALUES ($1,$2,'identity',$3,'','content.post.owner','(,)',$4)`,
    [route, postId, actorId, transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant
      (route,resource_id,subject_id,action,valid,transaction_id)
      VALUES ($1,$2,$3,'account:read','(,)',$4),
        ($5,$6,$7,'access:grant','(,)',$8),($5,$6,$7,'post:read','(,)',$8),
        ($5,$6,$7,'post:revise','(,)',$8),($5,$6,$7,'post:erase','(,)',$8),
        ($5,$6,$7,'media:create','(,)',$8)`,
    [routeOf(actorId), actorId, actorId, transactionId, route, postId, governorId, transactionId],
  );
  return {
    route,
    actorId,
    governorId,
    threadId,
    postId,
    revisionId,
    boardId,
    actorToken: await token(actorId, scopes),
    governorToken: await token(governorId, governorScopes),
  };
}

async function call(
  scenario: Scenario,
  method: string,
  path: string,
  body?: unknown,
  account: 'actor' | 'governor' = 'actor',
  key: string = randomUUID(),
) {
  const bearer = account === 'actor' ? scenario.actorToken : scenario.governorToken;
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function commandPath(kind: 'delete' | 'point' | 'thread', scenario: Scenario) {
  if (kind === 'delete') return { method: 'DELETE', path: `/v1/posts/${scenario.postId}`, body: undefined };
  if (kind === 'point')
    return {
      method: 'POST',
      path: `/v1/posts/${scenario.postId}:erase`,
      body: { reason: 'Initiator authority fixture' },
    };
  return { method: 'POST', path: `/v1/threads/${scenario.threadId}:erase`, body: { authorId: scenario.actorId } };
}

async function roleGrant(scenario: Scenario, operation: 'revoke' | 'create') {
  return call(
    scenario,
    'POST',
    `/v1/roleGrants${operation === 'revoke' ? ':revoke' : ''}`,
    {
      resource: { route: scenario.route, id: scenario.postId },
      subject: { kind: 'account', id: scenario.actorId },
      role: 'content.post.owner',
      valid: '(,)',
    },
    'governor',
  );
}

async function accountRead(scenario: Scenario, present: boolean) {
  if (present) {
    await db.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
      VALUES ($1,$2,$2,'account:read','(,)',$3) ON CONFLICT DO NOTHING`,
      [routeOf(scenario.actorId), scenario.actorId, newId(scenario.route)],
    );
  } else {
    await db.admin.query(
      `DELETE FROM access.resource_grant
      WHERE route=$1 AND resource_id=$2 AND subject_id=$2 AND action='account:read'`,
      [routeOf(scenario.actorId), scenario.actorId],
    );
  }
}

async function effects(scenario: Scenario) {
  const partition = partitionOf(scenario.route);
  const [position, receipts, outbox, operation, post, revisions, roles] = await Promise.all([
    db.admin.query('SELECT * FROM core.partition WHERE partition_no=$1', [partition]),
    db.admin.query('SELECT * FROM core.receipt WHERE partition_no=$1 ORDER BY idempotency_key', [partition]),
    db.admin.query('SELECT * FROM core.outbox WHERE partition_no=$1 ORDER BY position,event_seq', [partition]),
    db.admin.query('SELECT * FROM content.operation WHERE route=$1 ORDER BY operation_id', [scenario.route]),
    db.admin.query('SELECT * FROM content.post WHERE route=$1 AND post_id=$2', [scenario.route, scenario.postId]),
    db.admin.query('SELECT * FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY revision_id', [
      scenario.route,
      scenario.postId,
    ]),
    db.admin.query('SELECT * FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
      scenario.route,
      scenario.postId,
    ]),
  ]);
  return {
    position: position.rows,
    receipts: receipts.rows,
    outbox: outbox.rows,
    operation: operation.rows,
    post: post.rows,
    revisions: revisions.rows,
    roles: roles.rows,
  };
}

test('post:erase receipts require current self account read across all command routes', async () => {
  for (const kind of ['delete', 'point', 'thread'] as const) {
    const scenario = await fixture();
    const command = commandPath(kind, scenario);
    const key = `erasure-${kind}-${randomUUID()}`;
    const first = await call(scenario, command.method, command.path, command.body, 'actor', key);
    const firstWire = await first.text();
    expect(first.status).toBe(kind === 'thread' ? 202 : kind === 'delete' ? 204 : 200);

    const revoked = await roleGrant(scenario, 'revoke');
    expect(revoked.status).toBe(200);
    const receiptOnly = await call(scenario, command.method, command.path, command.body, 'actor', key);
    expect(receiptOnly.status).toBe(first.status);
    expect(await receiptOnly.text()).toBe(firstWire);

    const committed = await effects(scenario);
    await accountRead(scenario, false);
    const denied = await call(scenario, command.method, command.path, command.body, 'actor', key);
    expect(denied.status).toBe(403);
    expect(JSON.parse(await denied.text()).code).toBe('forbidden');
    expect(denied.headers.get(SESSION_HEADER)).toBeNull();
    expect(await effects(scenario)).toEqual(committed);
  }
});

test('operation status follows current account read and the original post erase anchor', async () => {
  const scenario = await fixture();
  const started = await call(scenario, 'POST', `/v1/threads/${scenario.threadId}:erase`, {
    authorId: scenario.actorId,
  });
  expect(started.status).toBe(202);
  const startWire = await started.text();
  const operationId = (JSON.parse(startWire) as { name: string }).name.slice('operations/'.length);
  const anchor = await db.admin.query(
    'SELECT anchor_post_id FROM content.operation WHERE route=$1 AND operation_id=$2',
    [scenario.route, operationId],
  );
  expect(anchor.rows[0]?.anchor_post_id).toBe(scenario.postId);

  const visible = async () => call(scenario, 'GET', `/v1/operations/${operationId}`);
  const initial = await visible();
  expect(initial.status).toBe(200);
  const visibleWire = await initial.text();

  await accountRead(scenario, false);
  const accountHidden = await visible();
  expect(accountHidden.status).toBe(404);
  expect(JSON.parse(await accountHidden.text()).code).toBe('not_found');
  await accountRead(scenario, true);
  const accountRestored = await visible();
  expect(accountRestored.status).toBe(200);
  expect(await accountRestored.text()).toBe(visibleWire);

  const revoked = await roleGrant(scenario, 'revoke');
  expect(revoked.status).toBe(200);
  const postHidden = await visible();
  expect(postHidden.status).toBe(404);
  expect(JSON.parse(await postHidden.text()).code).toBe('not_found');
  const restored = await roleGrant(scenario, 'create');
  expect(restored.status).toBe(201);
  const postRestored = await visible();
  expect(postRestored.status).toBe(200);
  expect(await postRestored.text()).toBe(visibleWire);
});
