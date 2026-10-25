import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ACTIVE_ACCOUNTS, grantSubject } from '../../src/access/grant-subject.ts';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createNativeContentSystem } from './support/native-system.ts';

let system: Awaited<ReturnType<typeof createNativeContentSystem>>;

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  system = await createNativeContentSystem({ databaseUrl });
}, 60_000);

afterAll(async () => system?.close());

async function addRole(
  client: PoolClient,
  resource: { route: number; id: string },
  subject: { kind: string; id: string; role: string },
  role: string,
) {
  await client.query(
    `INSERT INTO access.resource_role_grant
      (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,'(,)'::tstzrange,$7)`,
    [resource.route, resource.id, subject.kind, subject.id, subject.role, role, randomUUID()],
  );
}

async function initializeFixtureRoles(
  client: PoolClient,
  resource: { route: number; id: string },
  type: string,
  creatorId: string,
) {
  const template = resourceRoleCatalogue(system.access)?.types.get(type);
  if (!template) throw new Error(`No mounted resource role template for ${type}`);
  const activeAccounts = grantSubject(ACTIVE_ACCOUNTS)!;
  for (const role of template.standing) await addRole(client, resource, activeAccounts, role);
  if (template.owner) await addRole(client, resource, { kind: 'identity', id: creatorId, role: '' }, template.owner);
}

async function seedContent(creatorId: string) {
  const board = { route: 0x5231, id: newId(0x5231) };
  const thread = { route: 0x4231, id: newId(0x4231) };
  const post = { route: thread.route, id: newId(thread.route) };
  const revision = newId(thread.route);
  const transactionId = randomUUID();
  const client = await system.database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `INSERT INTO content.board
      (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Standing role board','published',1,$4)`,
      [board.route, board.id, creatorId, transactionId],
    );
    await client.query(
      `INSERT INTO content.thread
      (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
     VALUES ($1,$2,$3,$4,'Standing role thread','published',1,$5,$6)`,
      [thread.route, thread.id, creatorId, board.id, transactionId, post.id],
    );
    await client.query(
      `INSERT INTO content.post
      (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,$5,'published',1,$6)`,
      [post.route, thread.id, post.id, creatorId, revision, transactionId],
    );
    const document = Buffer.from(JSON.stringify(fromPlainText('Standing role report and reaction fixture')));
    await client.query(
      `INSERT INTO content.revision
      (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'MIT','{}',$7,'available',$8)`,
      [
        post.route,
        thread.id,
        post.id,
        revision,
        document,
        'Standing role report and reaction fixture',
        board.id,
        transactionId,
      ],
    );

    await initializeFixtureRoles(client, board, 'content.board', creatorId);
    await initializeFixtureRoles(client, thread, 'content.thread', creatorId);
    await initializeFixtureRoles(client, post, 'content.post', creatorId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { board, thread, post };
}

async function request(method: string, path: string, body: unknown, options: { bearer?: string; key?: string } = {}) {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(options.key ?? randomUUID()),
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { response, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

async function reportCount() {
  const result = await system.database.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM content.report',
  );
  return result.rows[0]!.count;
}

test('active accounts without target grants report on standing content and react to a standing post', async () => {
  const creator = system.actors.author.actor.accountId;
  const targets = await seedContent(creator);
  const reporters = [system.actors.author, system.actors.other, system.actors.moderator];
  const reports = [
    { target: { kind: 'board', id: targets.board.id }, actor: reporters[0]! },
    { target: { kind: 'thread', id: targets.thread.id }, actor: reporters[1]! },
    { target: { kind: 'post', id: targets.post.id }, actor: reporters[2]! },
  ];

  for (const { target, actor } of reports) {
    const grants = await system.database.pool.query(
      'SELECT 1 FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3',
      [routeOf(target.id), target.id, actor.actor.accountId],
    );
    expect(grants.rowCount).toBe(0);
    const result = await request('POST', '/v1/reports', { target, reason: 'spam' }, { bearer: actor.bearer });
    expect(result.response.status).toBe(201);
    expect(typeof result.body?.reportId).toBe('string');
  }

  const reactionActor = system.actors.author;
  const reactionGrant = await system.database.pool.query(
    'SELECT 1 FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4',
    [targets.post.route, targets.post.id, reactionActor.actor.accountId, 'reaction:set'],
  );
  expect(reactionGrant.rowCount).toBe(0);
  const reaction = await request(
    'PUT',
    `/v1/posts/${targets.post.id}/reaction`,
    { kind: 'like' },
    { bearer: reactionActor.bearer },
  );
  expect(reaction.response.status).toBe(200);

  const beforeDenied = await reportCount();
  const anonymous = await request('PUT', `/v1/posts/${targets.post.id}/reaction`, { kind: 'love' });
  expect(anonymous.response.status).toBe(401);
  const suspended = await request(
    'POST',
    '/v1/reports',
    { target: { kind: 'post', id: targets.post.id }, reason: 'spam' },
    { bearer: system.actors.suspended.bearer },
  );
  expect(suspended.response.status).toBe(401);
  expect(await reportCount()).toBe(beforeDenied);
});
