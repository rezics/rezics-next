import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase } from '../support/growth.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;
let reader: string;
let moderator: string;
let readerToken: string;
let moderatorToken: string;
let issueToken: (id: string, requestedBy?: string) => Promise<string>;
let pause: { postId: string; entered: () => void; released: Promise<void> } | undefined;
const boardRoute = 0x4321;
const threadRoute = 0x1234;
const subjectRoute = 0x6789;
const secret = 'board recheck private body sentinel';
const body = Buffer.from(JSON.stringify(fromPlainText(secret)));
const digest = createHash('sha256').update(body).digest('hex');

beforeAll(async () => {
  db = await openGrowthDatabase();
  const keys = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'board-recheck', alg: 'ES256' };
  const issuer = 'https://board-recheck.auth.test';
  const audience = 'https://kernel.test';
  app = createKernel({
    pool: db.pool,
    writeRate: createWriteRateLimiter({
      secret: 'board-recheck-private-write-rate-secret-32bytes',
      overrides: JSON.stringify({
        'new-account': { write: { maximum: 100000, seconds: 86400 } },
      }),
    }),
    routeKey: new Uint8Array(32).fill(7),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) },
    access(config) {
      const access = createAccess({
        ...config,
        auth: { issuer, audience, jwksUrl: issuer + '/jwks', fetch: async () => Response.json({ keys: [jwk] }) },
      });
      return deriveAccess(access, {
        async prepare(actor, action, resource, context) {
          // A fixture-local dependency barrier, before the opening post's preparation.
          // The identical SQL reads in both chain snapshots cannot be locked independently.
          const held = pause;
          if (action === 'post:read' && resource.id === held?.postId) {
            pause = undefined;
            held.entered();
            await held.released;
          }
          return access.prepare?.(actor, action, resource, context);
        },
      });
    },
  });
  app.compile();
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(app), 'fetch')!.get!.call(app);
  reader = newId(0x3456);
  moderator = newId(0x3456);
  for (const accountId of [reader, moderator]) {
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,membership_inverse_complete,transaction_id)
       VALUES ($1,$2,'actor','active',true,$2)`,
      [routeOf(accountId), accountId],
    );
  }
  issueToken = async (id, requestedBy) => {
    return new SignJWT({
      client_id: 'web',
      ...(requestedBy ? { requested_by: requestedBy } : {}),
      scope: 'thread:read post:read board:read realm:read subject:read moderation:takedown access:grant realm:ban',
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'board-recheck', typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(id)
      .setIssuedAt()
      .setExpirationTime('3m')
      .sign(keys.privateKey);
  };
  readerToken = await issueToken(reader);
  moderatorToken = await issueToken(moderator);
});
afterAll(async () => {
  await db?.close();
});

async function call(method: string, path: string, token?: string, body?: unknown) {
  const response = await app.handle(
    new Request('https://kernel.test' + path, {
      method,
      headers: {
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(body === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, text, value: text ? JSON.parse(text) : null };
}
async function grant(resourceId: string, accountId: string, action: string) {
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id)
     VALUES ($1,$2,$3,'',$4,'(,)',$5) ON CONFLICT DO NOTHING`,
    [routeOf(resourceId), resourceId, accountId, action, newId(routeOf(resourceId)!)],
  );
}

async function fixture(
  protectedBoard = false,
  realmVisibility: 'public' | 'protected' = 'public',
  existingRealm?: string,
) {
  const realm = existingRealm ?? newId(boardRoute),
    realmRevision = newId(boardRoute),
    space = newId(boardRoute);
  const board = newId(boardRoute),
    subject = newId(subjectRoute),
    thread = newId(threadRoute);
  const post = newId(threadRoute),
    revision = newId(threadRoute),
    author = newId(0x9abc);
  const at = '2026-10-01T00:00:00.000Z';
  const reply = newId(threadRoute),
    replyRevision = newId(threadRoute);
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES ($1,$2,'actor','active',$2)`,
      [routeOf(author), author],
    );
    if (!existingRealm) {
      const spaceRevision = newId(boardRoute);
      await client.query(
        `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
      VALUES ($1,$2,'active',$3,$4,$5)`,
        [boardRoute, space, spaceRevision, at, moderator],
      );
      await client.query(
        `INSERT INTO community.space_revision(route,space_id,revision_id,title,summary,created_at,author)
      VALUES ($1,$2,$3,'Read Space','',$4,$5)`,
        [boardRoute, space, spaceRevision, at, moderator],
      );
      await client.query(
        `INSERT INTO community.realm(route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
    VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8)`,
        [boardRoute, realm, space, realmVisibility, GLOBAL_CONTEXT, realmRevision, at, moderator],
      );
      await client.query(
        `INSERT INTO community.realm_revision(route,realm_id,revision_id,title,summary,visibility,context_id,created_at,author)
    VALUES ($1,$2,$3,'Read Realm','',$4,$5,$6,$7)`,
        [boardRoute, realm, realmRevision, realmVisibility, GLOBAL_CONTEXT, at, moderator],
      );
    }
    await client.query(
      `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
    VALUES ($1,$2,'schema:Book',$2,'visible',1)`,
      [subjectRoute, subject],
    );
    await client.query(
      `INSERT INTO content.board(route,board_id,realm_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,'Read board',$5,1,$2)`,
      [boardRoute, board, realm, subject, protectedBoard ? 'protected' : 'published'],
    );
    await client.query(
      `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
    VALUES ($1,$2,$3,$4,'Private title','published',1,$2,$5)`,
      [threadRoute, thread, author, board, post],
    );
    await client.query(
      `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,$5,'published',1,$3)`,
      [threadRoute, thread, post, author, revision],
    );
    await client.query(
      `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'MIT',$7,$8,'available',$4)`,
      [threadRoute, thread, post, revision, body, secret, [subject], board],
    );
    await client.query(
      `INSERT INTO content.subject_thread(route,subject_id,thread_route,thread_id,place_id,kind,last_activity_at,source_epoch,source_position)
    VALUES ($1,$2,$3,$4,$5,'discussion',now(),1,1)`,
      [subjectRoute, subject, threadRoute, thread, realm],
    );
    await client.query(
      `INSERT INTO content.post(route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,$5,$6,'published',1,$3)`,
      [threadRoute, thread, reply, post, author, replyRevision],
    );
    await client.query(
      `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'MIT',$7,$8,'available',$4)`,
      [threadRoute, thread, reply, replyRevision, body, secret, [subject], board],
    );
    for (const [kind, id] of [
      ['thread', thread],
      ['post', reply],
    ]) {
      await client.query(
        `INSERT INTO content.author_item(route,author_account_id,item_kind,item_id,thread_id,thread_kind,created_at,source_epoch,source_position)
      VALUES ($1,$2,$3,$4,$5,'discussion',now(),1,1)`,
        [routeOf(author), author, kind, id, thread],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await grant(board, moderator, 'moderation:takedown');
  await grant(board, moderator, 'access:grant');
  await grant(board, moderator, 'board:read');
  await grant(realm, moderator, 'realm:ban');
  if (realmVisibility === 'protected') await grant(realm, reader, 'realm:read');
  if (protectedBoard) {
    const created = await call('POST', '/v1/grants', moderatorToken, grantBody(board));
    expect(created).toMatchObject({ status: 201 });
  }
  return { board, realm, subject, thread, post, revision, reply, replyRevision, author };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function grantBody(board: string) {
  return {
    resource: { route: boardRoute, id: board },
    subject: { kind: 'account', id: reader },
    actions: ['board:read'],
    valid: '(,)',
  };
}
function surfaces(f: Fixture) {
  return [
    `/v1/threads/${f.thread}`,
    `/v1/posts/${f.post}`,
    `/v1/posts/${f.post}/revisions/${f.revision}`,
    `/v1/subjects/${f.subject}/threads?place=${f.realm}&kind=discussion`,
    `/v1/accounts/${f.author}/threads`,
    `/v1/accounts/${f.author}/posts`,
  ];
}
async function hidden(path: string, f: Fixture, result: Awaited<ReturnType<typeof call>>) {
  // Collection resources remain readable and filter concealed item candidates.
  if (path.includes('?') || path.includes('/accounts/')) {
    expect(result.status).toBe(200);
    expect(result.value.items ?? result.value.threads ?? result.value.posts).toEqual([]);
  } else expect(result.status).toBe(404);
  for (const value of [secret, digest, 'Private title', f.thread, f.post, f.revision, f.reply, f.replyRevision])
    expect(result.text).not.toContain(value);
}
async function heldRead(path: string, f: Fixture, change: () => Promise<void>) {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  pause = { postId: f.post, entered: () => entered.resolve(), released: released.promise };
  const response = call('GET', path, readerToken);
  try {
    await Promise.race([
      entered.promise,
      response.then((result) => {
        throw new Error(`Read missed preparation barrier: ${result.status} ${result.text}`);
      }),
    ]);
    await change();
  } finally {
    released.resolve();
    pause = undefined;
  }
  return response;
}

test('a board taken down after its check and before post preparation discloses no thread, post, revision or bytes', async () => {
  for (let index = 0; index < 6; index++) {
    const f = await fixture();
    const path = surfaces(f)[index]!;
    const result = await heldRead(path, f, async () => {
      expect(
        await call('POST', `/v1/boards/${f.board}:takeDown`, moderatorToken, { reason: 'Privacy reduced' }),
      ).toMatchObject({ status: 200 });
    });
    await hidden(path, f, result);
  }
}, 120_000);

test('a protected board read grant revoked in the same window discloses nothing through any item read', async () => {
  for (let index = 0; index < 6; index++) {
    const f = await fixture(true, 'protected');
    const path = surfaces(f)[index]!;
    const result = await heldRead(path, f, async () => {
      expect(await call('POST', '/v1/grants:revoke', moderatorToken, grantBody(f.board))).toMatchObject({
        status: 200,
      });
    });
    await hidden(path, f, result);
  }
}, 120_000);

test('an unchanged board still discloses the item after the recheck', async () => {
  const f = await fixture(true, 'protected');
  for (const path of surfaces(f)) {
    const result = await heldRead(path, f, async () => {});
    expect(result.status).toBe(200);
    expect(result.text).toContain(secret);
  }
}, 120_000);

test("a banned account holding an independent read grant cannot read a non-public board's threads or posts in a public Realm", async () => {
  const f = await fixture(true);
  const request = newId(routeOf(reader)!);
  await db.admin.query(
    `INSERT INTO access.principal_assignment(route,principal_id,creator_principal_id,request_id,assigned_actor_id,valid,transaction_id)
    VALUES ($1,$2,$2,$3,$4,'(,)',$3)`,
    [routeOf(reader), reader, request, moderator],
  );
  const delegated = await issueToken(moderator, `urn:rezics:request:${reader}:${request}`);
  for (const path of surfaces(f)) {
    const delegatedBefore = await call('GET', path, delegated);
    expect(delegatedBefore.status).toBe(200);
    expect(delegatedBefore.text).toContain(secret);
    const before = await call('GET', path, readerToken);
    expect(before.status).toBe(200);
    expect(before.text).toContain(secret);
  }
  expect(
    await call('PUT', `/v1/realms/${f.realm}/bans/${reader}`, moderatorToken, { reason: 'Realm ban' }),
  ).toMatchObject({ status: 200 });
  for (const path of surfaces(f)) {
    await hidden(path, f, await call('GET', path, readerToken));
    await hidden(path, f, await call('GET', path, delegated));
  }
  const publicSibling = await fixture(false, 'public', f.realm);
  for (const path of surfaces(publicSibling)) {
    const anonymous = await call('GET', path);
    const banned = await call('GET', path, readerToken);
    expect(anonymous.status).toBe(200);
    expect(anonymous.text).toContain(secret);
    expect(banned.status).toBe(200);
    // Account reads additionally carry viewer reactions, but disclose the same item.
    expect(banned.text).toContain(secret);
  }
}, 120_000);
