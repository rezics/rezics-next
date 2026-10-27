import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createNativeContentSystem, type NativeContentSystem } from '../content/support/native-system.ts';

let system: NativeContentSystem;
type Credential = NativeContentSystem['actors']['author'];

beforeAll(async () => {
  system = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
});

afterAll(async () => {
  await system?.close();
});

async function call(credential: Credential, method: string, path: string, key: string, body?: unknown) {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credential.bearer}`,
        'idempotency-key': JSON.stringify(key),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const wire = await response.text();
  return { status: response.status, body: wire ? JSON.parse(wire) : null };
}

async function seedMedia(route: number, uploaderId: string) {
  const mediaId = newId(route);
  await system.database.pool.query(
    `INSERT INTO content.media
       (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,
        actual_byte_count,sha256,state,key,claimed_at,transaction_id,security_revision)
     VALUES ($1,$2,$3,$4,$5,'post-image','image/png',12,12,$6,'available',$7,
             '2020-01-01T00:00:00Z',$8,1)`,
    [
      route,
      mediaId,
      newId(route),
      uploaderId,
      crypto.randomUUID(),
      'a'.repeat(64),
      `m/${mediaId}/original`,
      newId(route),
    ],
  );
  return mediaId;
}

async function seedPost(route: number, authorId: string) {
  const boardId = newId(route);
  const threadId = newId(route);
  const postId = newId(route);
  const revisionId = newId(route);
  const transactionId = newId(route);
  const body = Buffer.from(serializeDocument(fromPlainText('Governance reach command fixture')));
  const client = await system.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `INSERT INTO content.board
         (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,'Governance reach board','published',1,$4)`,
      [route, boardId, newId(route), transactionId],
    );
    await client.query(
      `INSERT INTO content.thread
         (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,
          first_post_id)
       VALUES ($1,$2,$3,$4,'Governance reach thread','published',1,$5,$6)`,
      [route, threadId, authorId, boardId, transactionId, postId],
    );
    await client.query(
      `INSERT INTO content.post
         (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,
          recorded_transaction_id,created_at)
       VALUES ($1,$2,$3,$4,$5,'published',1,$6,'2020-01-01T00:00:00Z')`,
      [route, threadId, postId, authorId, revisionId, transactionId],
    );
    await client.query(
      `INSERT INTO content.revision
         (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,
          availability,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,sha256($5),'Governance reach fixture','CC0-1.0','{}',$6,'available',$7)`,
      [route, threadId, postId, revisionId, body, boardId, transactionId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return postId;
}

async function transactionFor(key: string) {
  const rows = (
    await system.database.pool.query(
      'SELECT transaction_id::text FROM core.receipt WHERE idempotency_key=$1 ORDER BY transaction_id',
      [key],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0]!.transaction_id as string;
}

async function reachFor(transactionId: string) {
  return (
    await system.database.pool.query(
      `SELECT route,transaction_id::text,action,resource_id::text,actor_account_id::text
       FROM access.governance_reach WHERE transaction_id=$1`,
      [transactionId],
    )
  ).rows;
}

test.serial('mounted commands commit governance reach only with their successful receipt transaction', async () => {
  const pool = system.database.pool;
  const governanceId = (
    await pool.query('SELECT account_id FROM access.governance_bootstrap WHERE route=$1 AND resource_id=$2', [
      PLATFORM_RESOURCE.route,
      PLATFORM_RESOURCE.id,
    ])
  ).rows[0]!.account_id as string;
  const actions = ['moderation:takedown', 'post:erase', 'media:erase'];
  const governance = await system.auth.issue({
    accountId: governanceId,
    clientId: system.auth.ordinaryClient.id,
    scopes: actions,
  });
  const authorId = system.actors.author.actor.accountId;
  const media = await seedMedia(0x7411, authorId);
  const failedMedia = await seedMedia(0x7421, authorId);
  const deniedMedia = await seedMedia(0x7431, authorId);
  const localMedia = await seedMedia(0x7441, authorId);
  const erasedMedia = await seedMedia(0x7451, authorId);
  const post = await seedPost(0x7461, authorId);

  for (const [id, action] of [
    [media, 'moderation:takedown'],
    [failedMedia, 'moderation:takedown'],
    [deniedMedia, 'moderation:takedown'],
    [erasedMedia, 'media:erase'],
    [post, 'post:erase'],
  ] as const)
    expect(
      await pool.query(
        `SELECT 1 FROM access.resource_grant
         WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4`,
        [routeOf(id), id, governanceId, action],
      ),
    ).toMatchObject({ rowCount: 0 });

  const takedownKey = crypto.randomUUID();
  expect(
    await call(governance, 'POST', `/v1/media/${media}:takeDown`, takedownKey, { reason: 'Platform policy' }),
  ).toMatchObject({ status: 200 });
  const takedownTransaction = await transactionFor(takedownKey);
  expect(await reachFor(takedownTransaction)).toEqual([
    {
      route: routeOf(media),
      transaction_id: takedownTransaction,
      action: 'moderation:takedown',
      resource_id: media,
      actor_account_id: governanceId,
    },
  ]);

  expect(
    await call(governance, 'POST', `/v1/media/${media}:takeDown`, takedownKey, { reason: 'Platform policy' }),
  ).toMatchObject({ status: 200 });
  expect(await reachFor(takedownTransaction)).toHaveLength(1);

  const failedKey = crypto.randomUUID();
  expect(
    await call(governance, 'POST', `/v1/media/${failedMedia}:takeDown`, failedKey, { reason: 'Platform policy' }),
  ).toMatchObject({ status: 200 });
  const failedBaseline = await transactionFor(failedKey);
  expect(await reachFor(failedBaseline)).toHaveLength(1);
  const afterAuthorizationKey = crypto.randomUUID();
  const beforeFailedCommand = (await pool.query('SELECT count(*)::int AS count FROM access.governance_reach')).rows[0]!
    .count;
  expect(
    await call(governance, 'POST', `/v1/media/${failedMedia}:takeDown`, afterAuthorizationKey, {
      reason: 'Different command',
    }),
  ).toMatchObject({ status: 403 });
  expect(
    await pool.query('SELECT 1 FROM core.receipt WHERE idempotency_key=$1', [afterAuthorizationKey]),
  ).toMatchObject({ rowCount: 0 });
  expect((await pool.query('SELECT count(*)::int AS count FROM access.governance_reach')).rows[0]!.count).toBe(
    beforeFailedCommand,
  );

  const deniedBefore = (await pool.query('SELECT count(*)::int AS count FROM access.governance_reach')).rows[0]!.count;
  expect(
    await call(system.actors.other, 'POST', `/v1/media/${deniedMedia}:takeDown`, crypto.randomUUID(), {
      reason: 'Not authorized',
    }),
  ).toMatchObject({ status: 403 });
  expect((await pool.query('SELECT count(*)::int AS count FROM access.governance_reach')).rows[0]!.count).toBe(
    deniedBefore,
  );

  await pool.query(
    `INSERT INTO access.resource_grant
       (route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'moderation:takedown','(,)',$4)`,
    [routeOf(localMedia), localMedia, system.actors.moderator.actor.accountId, newId(routeOf(localMedia)!)],
  );
  const localKey = crypto.randomUUID();
  expect(
    await call(system.actors.moderator, 'POST', `/v1/media/${localMedia}:takeDown`, localKey, {
      reason: 'Local moderation',
    }),
  ).toMatchObject({ status: 200 });
  expect(await reachFor(await transactionFor(localKey))).toEqual([]);

  const postKey = crypto.randomUUID();
  expect(
    await call(governance, 'POST', `/v1/posts/${post}:erase`, postKey, { reason: 'Platform erasure' }),
  ).toMatchObject({ status: 200 });
  const postTransaction = await transactionFor(postKey);
  expect(await reachFor(postTransaction)).toEqual([
    {
      route: routeOf(post),
      transaction_id: postTransaction,
      action: 'post:erase',
      resource_id: post,
      actor_account_id: governanceId,
    },
  ]);

  const mediaEraseKey = crypto.randomUUID();
  expect(await call(governance, 'DELETE', `/v1/media/${erasedMedia}`, mediaEraseKey)).toMatchObject({ status: 204 });
  const mediaEraseTransaction = await transactionFor(mediaEraseKey);
  expect(await reachFor(mediaEraseTransaction)).toEqual([
    {
      route: routeOf(erasedMedia),
      transaction_id: mediaEraseTransaction,
      action: 'media:erase',
      resource_id: erasedMedia,
      actor_account_id: governanceId,
    },
  ]);
});
