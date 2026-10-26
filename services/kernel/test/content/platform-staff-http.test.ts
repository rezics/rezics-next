import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createNativeContentSystem, type NativeContentSystem } from './support/native-system.ts';

let system: NativeContentSystem;
type Credential = NativeContentSystem['actors']['author'];
const actions = ['moderation:takedown', 'post:erase', 'media:erase'];

beforeAll(async () => {
  // The native composition migrates Auth, provisions accounts and runs the
  // exported operator bootstrap before mounting the shared Access and Kernel.
  system = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
});
afterAll(async () => {
  await system?.close();
});

async function call(credential: Credential, method: string, path: string, body?: unknown) {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credential.bearer}`,
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const wire = await response.text();
  return {
    status: response.status,
    body: wire ? (JSON.parse(wire) as Record<string, unknown>) : null,
    session: response.headers.get(SESSION_HEADER),
  };
}

async function snapshot() {
  // Include durable command effects as well as content and Access history.
  return Promise.all(
    [
      'content.board',
      'content.thread',
      'content.post',
      'content.revision',
      'content.media',
      'core.partition',
      'core.receipt',
      'core.outbox',
      'access.governance_reach',
    ].map(
      async (table) =>
        (await system.database.pool.query(`SELECT to_jsonb(r) AS value FROM ${table} r ORDER BY to_jsonb(r)::text`))
          .rows,
    ),
  );
}

async function seed(baseRoute = 0x7500) {
  const pool = system.database.pool;
  const authorId = system.actors.author.actor.accountId;
  const boardId = newId(baseRoute + 16);
  await pool.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Unmoderated board','published',1,$4)`,
    [routeOf(boardId), boardId, newId(baseRoute + 16), newId(baseRoute + 16)],
  );
  const targets = [];
  for (const [index, kind] of ['thread', 'post', 'erase', 'media'].entries()) {
    const route = baseRoute + 32 + index * 16;
    const threadId = newId(route);
    const postId = newId(route);
    const revisionId = newId(route);
    const mediaId = newId(route);
    const transactionId = newId(route);
    const body = Buffer.from(serializeDocument(fromPlainText('Another author on an unmoderated board')));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(
        `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
        VALUES ($1,$2,$3,$4,'Staff fixture','published',1,$5)`,
        [route, threadId, authorId, boardId, transactionId],
      );
      await client.query(
        `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at)
        VALUES ($1,$2,$3,$4,$5,'published',1,$6,'2020-01-01T00:00:00Z')`,
        [route, threadId, postId, authorId, revisionId, transactionId],
      );
      await client.query(
        `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
        VALUES ($1,$2,$3,$4,$5,sha256($5),'Staff fixture','CC0-1.0','{}',$6,'available',$7)`,
        [route, threadId, postId, revisionId, body, boardId, transactionId],
      );
      await client.query('UPDATE content.thread SET first_post_id=$3 WHERE route=$1 AND thread_id=$2', [
        route,
        threadId,
        postId,
      ]);
      await client.query(
        `INSERT INTO content.media(route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,declared_sha256,state,key,transaction_id)
        VALUES ($1,$2,$3,$4,$5,'post-image','image/png',256,$6,'reserved',$7,$8)`,
        [
          route,
          mediaId,
          threadId,
          authorId,
          crypto.randomUUID(),
          'a'.repeat(64),
          `m/${mediaId}/original`,
          transactionId,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const id = kind === 'thread' ? threadId : kind === 'media' ? mediaId : postId;
    targets.push({
      route,
      id,
      kind,
      postId,
      revisionId,
      method: kind === 'media' ? 'DELETE' : 'POST',
      path:
        kind === 'thread'
          ? `/v1/threads/${id}:takeDown`
          : kind === 'post'
            ? `/v1/posts/${id}:takeDown`
            : kind === 'erase'
              ? `/v1/posts/${id}:erase`
              : `/v1/media/${id}`,
      action: kind === 'erase' ? 'post:erase' : kind === 'media' ? 'media:erase' : 'moderation:takedown',
    });
  }
  // There is no local moderator or local grant holder on any seeded resource.
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS count FROM access.resource_role_grant WHERE resource_id = ANY($1::uuid[])',
        [[boardId, ...targets.map((target) => target.id)]],
      )
    ).rows[0]!.count,
  ).toBe(0);
  expect(
    (
      await pool.query('SELECT count(*)::int AS count FROM access.resource_grant WHERE resource_id = ANY($1::uuid[])', [
        [boardId, ...targets.map((target) => target.id)],
      ])
    ).rows[0]!.count,
  ).toBe(0);
  return targets;
}

test('Global staff grants authorize unmoderated content through HTTP and revocation restores ordinary denials', async () => {
  const pool = system.database.pool;
  const staff = system.actors.moderator;
  const ordinary = system.actors.other;
  const governanceId = (await pool.query('SELECT account_id FROM access.governance_bootstrap')).rows[0]!
    .account_id as string;
  const governance = await system.auth.issue({
    accountId: governanceId,
    clientId: system.auth.ordinaryClient.id,
    scopes: ['access:grant', ...actions],
  });
  const grant = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: staff.actor.accountId },
    actions,
    valid: '(,)',
  };
  const granted = await call(governance, 'POST', '/v1/grants', grant);
  expect({ status: granted.status, body: granted.body }).toMatchObject({ status: 201 });
  const targets = await seed();
  for (const target of targets) {
    const body = target.kind === 'media' ? undefined : { reason: 'Platform policy' };
    const before = await snapshot();
    const denied = await call(ordinary, target.method, target.path, body);
    expect({ status: denied.status, body: denied.body }).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(denied.session).toBeNull();
    expect(await snapshot()).toEqual(before);

    const allowed = await call(staff, target.method, target.path, body);
    expect({ status: allowed.status, body: allowed.body }).toMatchObject({
      status: target.kind === 'media' ? 204 : 200,
    });
    expect(allowed.session).toBeString();
    const table = target.kind === 'thread' ? 'thread' : target.kind === 'media' ? 'media' : 'post';
    const stored = (
      await pool.query(`SELECT * FROM content.${table} WHERE route=$1 AND ${table}_id=$2`, [target.route, target.id])
    ).rows[0]!;
    if (target.kind === 'thread' || target.kind === 'post') expect(stored.visibility).toBe('taken_down');
    else if (target.kind === 'media') expect(stored.erased).toBe(true);
    else {
      expect(stored.availability).toBe('erased');
      expect(stored.head_revision_id).toBe(target.revisionId);
    }
    const reach = (
      await pool.query(
        'SELECT action,actor_account_id,transaction_id FROM access.governance_reach WHERE route=$1 AND resource_id=$2',
        [target.route, target.id],
      )
    ).rows;
    expect(reach).toEqual([
      { action: target.action, actor_account_id: staff.actor.accountId, transaction_id: expect.any(String) },
    ]);
  }
  // Untouched resources ensure terminal erasure state cannot explain a denial.
  const revokedTargets = await seed(0x7600);
  const revoked = await call(governance, 'POST', '/v1/grants:revoke', grant);
  expect({ status: revoked.status, body: revoked.body }).toMatchObject({ status: 200 });
  for (const target of revokedTargets) {
    const before = await snapshot();
    const denied = await call(
      staff,
      target.method,
      target.path,
      target.kind === 'media' ? undefined : { reason: 'Platform policy' },
    );
    expect({ status: denied.status, body: denied.body }).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(denied.session).toBeNull();
    expect(await snapshot()).toEqual(before);
  }
});
