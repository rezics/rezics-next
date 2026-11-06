import { afterAll, beforeAll, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import type { PoolClient } from 'pg';
import { createAccess } from '../../src/access/permission.ts';
import { readAccount } from '../../src/access/account-data.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { reserveMedia } from '../../src/content/media.ts';
import { parentStatement, boardStatement } from '../../src/content/media-parent.ts';
import { createRealmParticipationCheck } from '../../src/community/participation.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import reserveStatement from '../../src/content/reserve-media.sql';
import initialize from '../../src/access/resource-initialization.sql';
import permission from '../../src/access/permission-check.sql';
import insertPost from '../../src/content/insert-post.sql';
import insertRevision from '../../src/content/insert-revision.sql';
import { createHash } from 'node:crypto';
import anchor from '../../src/partition/read.sql';
import { checkGrowth, seed, openGrowthDatabase } from '../support/growth.ts';
import { observeSql, permissionResourceId, type SqlExecution } from './support/sql-observer.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
const containerRoute = 0x4312;
const boardRoute = 0x9876;
const actor: AccountActor = {
  kind: 'account',
  accountId: newId(0x1234),
  clientId: 'rezics-website',
  scopes: ['media:create', 'board:read', 'thread:read', 'post:read'],
  requestedBy: null,
  authnEpoch: 1,
};
let access: ReturnType<typeof createAccess>;
const request = () => ({
  idempotencyKey: Bun.randomUUIDv7(),
  requestId: Bun.randomUUIDv7(),
  deadline: Date.now() + 10000,
});
const dependencies = () => ({ pool: db.pool, access });
const input = (containerId: string) => ({
  containerId,
  purpose: 'post-image' as const,
  mediaType: 'image/png',
  byteCount: 256,
});
async function grant(resource: string, action: string) {
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,$4,'(,)',$3) ON CONFLICT DO NOTHING`,
    [routeOf(resource), resource, actor.accountId, action],
  );
}
async function fixture(visibility = 'published', threadBoardId?: string, realmId: string | null = null) {
  const board = newId(boardRoute),
    thread = newId(containerRoute);
  await db.admin.query(
    `INSERT INTO content.board(route,board_id,realm_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,'Images',$5,1,$4)`,
    [boardRoute, board, realmId, actor.accountId, visibility],
  );
  await db.admin.query(
    `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,'Images','published',1,$3)`,
    [containerRoute, thread, actor.accountId, threadBoardId ?? board],
  );
  await grant(thread, 'media:create');
  return { board, thread };
}

async function realm(visibility: 'public' | 'protected') {
  const realmId = newId(boardRoute);
  const spaceId = newId(boardRoute);
  const spaceRevisionId = newId(boardRoute);
  const realmRevisionId = newId(boardRoute);
  const time = (await db.admin.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0];
  if (!time) throw new Error('Could not read fixture database time');
  const at = time.at;
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
       VALUES ($1,$2,'active',$3,$4,$5)`,
      [boardRoute, spaceId, spaceRevisionId, at, actor.accountId],
    );
    await client.query(
      `INSERT INTO community.space_revision(route,space_id,revision_id,predecessor,address,title,summary,created_at,author)
       VALUES ($1,$2,$3,NULL,NULL,'Media parent host','Media parent host',$4,$5)`,
      [boardRoute, spaceId, spaceRevisionId, at, actor.accountId],
    );
    await client.query(
      `INSERT INTO community.realm(route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator,votes)
       VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,'{"upvote":1,"downvote":-1}'::jsonb)`,
      [boardRoute, realmId, spaceId, visibility, GLOBAL_CONTEXT, realmRevisionId, at, actor.accountId],
    );
    await client.query(
      `INSERT INTO community.realm_revision(route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author,votes)
       VALUES ($1,$2,$3,NULL,'Media parent Realm','Media parent Realm',$4,$5,$6,$7,'{"upvote":1,"downvote":-1}'::jsonb)`,
      [boardRoute, realmId, realmRevisionId, visibility, GLOBAL_CONTEXT, at, actor.accountId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return realmId;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  configureTestReceiptKeys(db.pool);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(actor.accountId), actor.accountId],
  );
  const account = await readAccount(db.admin, routeOf(actor.accountId)!, actor.accountId);
  access = createAccess({
    actions: new Map(
      [
        ...actor.scopes,
        'media:read_reservation',
        'media:read',
        'media:complete',
        'media:erase',
        'realm:read',
        'realm:participate',
        'post:create',
        'post:revise',
        'post:erase',
        'report:create',
        'reaction:set',
      ].map((action) => [
        action,
        action === 'media:create'
          ? { anonymous: false as const, 'x-resource-types': ['content.media'] as const }
          : { anonymous: false as const },
      ]),
    ),
    accountEvidence: () => account,
  });
});
afterAll(() => db?.close());

function nativeBoardTrace(records: readonly SqlExecution[], board: string) {
  const probes = records.filter((r) => r.statement === boardStatement() && r.parameters.includes(board));
  expect(probes.length).toBeGreaterThan(0);
  for (const probe of probes) {
    const index = records.indexOf(probe);
    const begin = records.slice(0, index).findLastIndex((r) => /^BEGIN/.test(r.statement));
    expect(begin).toBeGreaterThanOrEqual(0);
    const transaction = records.slice(begin, index + 1);
    expect(transaction.every((r) => r.connectionId === probe.connectionId)).toBe(true);
    expect(transaction.some((r) => /^(?:COMMIT|ROLLBACK)/.test(r.statement))).toBe(false);
    expect(transaction.filter((r) => r.statement === anchor.sql).map((r) => r.parameters)).toEqual([
      [partitionOf(boardRoute)],
    ]);
    expect(
      transaction
        .filter((r) => [parentStatement(), boardStatement()].includes(r.statement))
        .every((r) => r.parameters.includes(boardRoute)),
    ).toBe(true);
    expect(records.slice(index + 1).find((r) => /^(?:COMMIT|ROLLBACK|BEGIN)/.test(r.statement))?.statement).toBe(
      'COMMIT',
    );
  }
}
test('media reserve reads a remote board on its own native anchor and releases before parent and write checkout', async () => {
  const { board, thread } = await fixture();
  expect(partitionOf(containerRoute)).not.toBe(partitionOf(boardRoute));
  const trace = observeSql(db.pool);
  let held = 0,
    peak = 0;
  const checkouts: { start: number; end: number; client: PoolClient }[] = [];
  const acquire = (client: PoolClient) => {
    peak = Math.max(peak, ++held);
    checkouts.push({ start: trace.records.length, end: -1, client });
  };
  const release = () => {
    held--;
    checkouts.at(-1)!.end = trace.records.length;
  };
  db.pool.on('acquire', acquire);
  db.pool.on('release', release);
  try {
    const result = await reserveMedia({ pool: db.pool, access }, actor, input(thread), request());
    expect(peak).toBe(1);
    expect(held).toBe(0);
    for (const checkout of checkouts) {
      const records = trace.records.slice(checkout.start, checkout.end);
      const partitions = records.flatMap((r) => {
        if ([parentStatement(), boardStatement()].includes(r.statement)) return [partitionOf(Number(r.parameters[0]))];
        if (r.statement === permission.sql)
          return [partitionOf(Number(r.parameters[permission.params.indexOf('route')]))];
        if (r.statement === anchor.sql) return [Number(r.parameters[0])];
        return [];
      });
      expect(new Set(partitions).size).toBeLessThanOrEqual(1);
      expect(new Set(records.map((r) => r.connectionId)).size).toBeLessThanOrEqual(1);
    }
    expect(result.partition).toBe(partitionOf(containerRoute));
    nativeBoardTrace(trace.records, board);
    expect(
      trace.records
        .filter((r) => r.statement === parentStatement())
        .every((r) => !r.statement.includes('content.board')),
    ).toBe(true);
  } finally {
    db.pool.removeListener('acquire', acquire);
    db.pool.removeListener('release', release);
    await trace.close();
  }
});

async function effects() {
  return (
    await db.admin.query(`SELECT
    (SELECT count(*)::integer FROM content.media) AS media,
    (SELECT count(*)::integer FROM access.resource_initialization) AS initializers,
    (SELECT count(*)::integer FROM access.resource_role_grant) AS roles,
    (SELECT count(*)::integer FROM core.receipt) AS receipts,
    (SELECT count(*)::integer FROM core.outbox) AS events`)
  ).rows[0] as Record<string, number>;
}
async function denied(work: () => Promise<unknown>) {
  const before = await effects();
  await expect(work()).rejects.toThrow();
  expect(await effects()).toEqual(before);
}

test('media reservation prepares native Realm participation on a max-one pool without holding its anchor', async () => {
  const publicRealm = await realm('public');
  const allowed = await fixture('published', undefined, publicRealm);
  const protectedRealm = await realm('protected');
  const deniedParent = await fixture('published', undefined, protectedRealm);
  const realmActor: AccountActor = { ...actor, scopes: [...actor.scopes, 'realm:read', 'realm:participate'] };
  const realmParticipation = createRealmParticipationCheck({ pool: db.pool, access });
  await grant(protectedRealm, 'realm:participate');

  let active = 0;
  let peak = 0;
  const acquire = () => {
    active++;
    peak = Math.max(peak, active);
  };
  const release = () => {
    active--;
  };
  const trace = observeSql(db.pool);
  db.pool.on('acquire', acquire);
  db.pool.on('release', release);
  try {
    const reservation = await reserveMedia(
      { ...dependencies(), realmParticipation },
      realmActor,
      input(allowed.thread),
      request(),
    );
    expect(reservation.value.mediaId).toBeString();
    expect(reservation.partition).toBe(partitionOf(containerRoute));
    expect(
      (await db.admin.query('SELECT container_id FROM content.media WHERE media_id=$1', [reservation.value.mediaId]))
        .rows,
    ).toEqual([{ container_id: allowed.thread }]);
    await denied(() =>
      reserveMedia({ ...dependencies(), realmParticipation }, realmActor, input(deniedParent.thread), request()),
    );

    expect(trace.records.some((record) => /community\.realm/.test(record.statement))).toBe(true);
    expect(active).toBe(0);
    expect(peak).toBe(1);
    expect(db.pool.waitingCount).toBe(0);
  } finally {
    db.pool.removeListener('acquire', acquire);
    db.pool.removeListener('release', release);
    await trace.close();
  }
});

async function revoke(resource: string, action: string) {
  await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action=$3', [
    routeOf(resource),
    resource,
    action,
  ]);
}
async function visibility(kind: 'board' | 'thread' | 'post', id: string, value: string) {
  await db.admin.query(
    `UPDATE content.${kind} SET visibility=$3, security_revision=security_revision+1
    WHERE route=$1 AND ${kind}_id=$2`,
    [routeOf(id), id, value],
  );
}
async function post(f: { thread: string; board: string }, parent: string | null = null) {
  const id = newId(containerRoute),
    revision = newId(containerRoute);
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await insertPost.run(client, {
      route: containerRoute,
      thread_id: f.thread,
      post_id: id,
      reply_to_post_id: parent,
      author_account_id: actor.accountId,
      head_revision_id: revision,
      visibility: 'published',
      security_revision: 1,
      transaction_id: actor.accountId,
    });
    const body = Buffer.from('{}');
    await insertRevision.run(client, {
      route: containerRoute,
      thread_id: f.thread,
      post_id: id,
      revision_id: revision,
      body,
      body_sha256: createHash('sha256').update(body).digest(),
      search_text: '',
      licence: 'CC0-1.0',
      subject_ids: [],
      board_id: f.board,
      availability: 'available',
      transaction_id: actor.accountId,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return id;
}

test('protected remote board requires an actual current grant; replay, revocation and denials add no effect', async () => {
  const f = await fixture('protected'),
    context = request();
  const reserve = () => reserveMedia(dependencies(), actor, input(f.thread), context);
  await denied(reserve);
  await grant(f.board, 'board:read');
  const trace = observeSql(db.pool);
  try {
    const before = await effects(),
      result = await reserve();
    const after = await effects();
    expect(after).toEqual(Object.fromEntries(Object.entries(before).map(([key, count]) => [key, count + 1])));
    expect((await reserve()).value).toEqual(result.value);
    expect(await effects()).toEqual(after);
    await expect(
      reserveMedia(dependencies(), actor, { ...input(f.thread), byteCount: 257 }, context),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await effects()).toEqual(after);
    nativeBoardTrace(trace.records, f.board);
    const checks = trace.records.filter((r) => r.statement === permission.sql);
    expect(
      checks.some((r) => permissionResourceId(r, permission.params) === f.board && r.parameters.includes('board:read')),
    ).toBe(true);
    const parent = checks.find((r) => r.parameters.includes('media:create'))!;
    expect(permissionResourceId(parent, permission.params)).toBe(f.thread);
    const stored = (
      await db.admin.query(
        `SELECT m.created_at::text, m.transaction_id, i.initialized_at::text,
      g.grant_role, g.subject_id, lower(g.valid)::text AS grant_at
      FROM content.media m JOIN access.resource_initialization i ON i.route=m.route AND i.resource_id=m.media_id
      JOIN access.resource_role_grant g ON g.route=m.route AND g.resource_id=m.media_id
      WHERE m.route=$1 AND m.media_id=$2`,
        [containerRoute, result.value.mediaId],
      )
    ).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      transaction_id: result.transactionId,
      grant_role: 'content.media.owner',
      subject_id: actor.accountId,
    });
    expect(Date.parse(stored[0].initialized_at)).toBe(Date.parse(stored[0].created_at));
    expect(Date.parse(stored[0].grant_at)).toBe(Date.parse(stored[0].created_at));
    expect(Date.parse(String(parent.parameters[permission.params.indexOf('at')]))).toBe(
      Date.parse(stored[0].created_at),
    );
    await revoke(f.board, 'board:read');
    await denied(reserve);
    await expect(
      reserveMedia(dependencies(), actor, { ...input(f.thread), byteCount: 257 }, context),
    ).rejects.toBeInstanceOf(GrantDeniedError);
    expect(await effects()).toEqual(after);
    await grant(f.board, 'board:read');
    await db.admin.query(
      `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
      VALUES ($1,$2,$3,'board:read','resource','(,)',$3)`,
      [boardRoute, f.board, actor.accountId],
    );
    await denied(reserve);
    await visibility('board', f.board, 'taken_down');
    await denied(reserve);
  } finally {
    await trace.close();
  }
});

test('current board takedown and grant revocation after preparation and before its native anchor fail closed', async () => {
  for (const revokeGrant of [false, true]) {
    const f = await fixture(revokeGrant ? 'protected' : 'published');
    if (revokeGrant) await grant(f.board, 'board:read');
    const trace = observeSql(db.pool);
    const barrier = trace.hold({ statement: anchor.sql, occurrence: 2 }, 'before');
    const before = await effects();
    const pending = reserveMedia(dependencies(), actor, input(f.thread), request());
    const outcome = pending.then(
      () => null,
      (error) => error,
    );
    try {
      const entered = await barrier.entered;
      expect(entered.parameters).toEqual([partitionOf(boardRoute)]);
      if (revokeGrant) await revoke(f.board, 'board:read');
      else await visibility('board', f.board, 'taken_down');
      barrier.release();
      expect(await outcome).toBeInstanceOf(Error);
      expect(await effects()).toEqual(before);
    } finally {
      barrier.release();
      await trace.close();
      await outcome;
    }
  }
});

test('private reply, post and thread ancestors need read authority in addition to media:create on the actual container', async () => {
  const f = await fixture();
  const root = await post(f),
    reply = await post(f, root);
  await grant(reply, 'media:create');
  for (const [kind, id] of [
    ['post', reply],
    ['post', root],
    ['thread', f.thread],
  ] as const) {
    await visibility(kind, id, 'protected');
    await denied(() => reserveMedia(dependencies(), actor, input(reply), request()));
    await grant(id, `${kind}:read`);
  }
  const context = request();
  await reserveMedia(dependencies(), actor, input(reply), context);
  await revoke(root, 'post:read');
  await denied(() => reserveMedia(dependencies(), actor, input(reply), context));
  await grant(root, 'post:read');
  await revoke(reply, 'media:create');
  // A thread grant is not authority to create media on a post.
  await denied(() => reserveMedia(dependencies(), actor, input(reply), request()));
  await grant(reply, 'media:create');
  for (const [kind, id] of [
    ['post', reply],
    ['post', root],
    ['thread', f.thread],
  ] as const) {
    await visibility(kind, id, 'taken_down');
    await denied(() => reserveMedia(dependencies(), actor, input(reply), context));
    await visibility(kind, id, 'protected');
  }
  await db.admin.query(
    `UPDATE content.post SET availability='erased', security_revision=security_revision+1
    WHERE route=$1 AND post_id=$2`,
    [containerRoute, root],
  );
  await db.admin.query(
    `UPDATE content.revision SET availability='erased', body=NULL, body_sha256=NULL, search_text=NULL
    WHERE route=$1 AND post_id=$2`,
    [containerRoute, root],
  );
  await denied(() => reserveMedia(dependencies(), actor, input(reply), context));
});

test('parent validation observes current security revisions and private authority after reference preparation', async () => {
  for (const revokeGrant of [false, true]) {
    const f = await fixture();
    if (revokeGrant) {
      await visibility('thread', f.thread, 'protected');
      await grant(f.thread, 'thread:read');
    }
    const trace = observeSql(db.pool);
    const barrier = trace.hold({ statement: parentStatement(), occurrence: 2 }, 'before');
    const before = await effects();
    const outcome = reserveMedia(dependencies(), actor, input(f.thread), request()).then(
      () => null,
      (error) => error,
    );
    try {
      expect((await barrier.entered).parameters).toContain(f.thread);
      if (revokeGrant) await revoke(f.thread, 'thread:read');
      else
        await db.admin.query(
          'UPDATE content.thread SET security_revision=security_revision+1 WHERE route=$1 AND thread_id=$2',
          [containerRoute, f.thread],
        );
      barrier.release();
      expect(await outcome).toBeInstanceOf(Error);
      expect(await effects()).toEqual(before);
    } finally {
      barrier.release();
      await trace.close();
      await outcome;
    }
  }
});

test('serialization retries resolve native references again and preserve one media initializer and effect', async () => {
  for (const takeDown of [false, true]) {
    const f = await fixture();
    const trace = observeSql(db.pool);
    trace.armFault({
      match: { statement: reserveStatement.sql },
      boundary: 'after',
      error: Object.assign(new Error('retry'), { code: '40001' }),
    });
    const barrier = trace.hold({ statement: parentStatement(), occurrence: 3 }, 'before');
    const before = await effects();
    const outcome = reserveMedia(dependencies(), actor, input(f.thread), request()).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      expect((await barrier.entered).parameters).toContain(f.thread);
      if (takeDown) await visibility('board', f.board, 'taken_down');
      barrier.release();
      const result = await outcome;
      if (takeDown) {
        expect(result).toHaveProperty('error');
        expect(await effects()).toEqual(before);
      } else {
        expect(result).toHaveProperty('value');
        expect(await effects()).toEqual(
          Object.fromEntries(Object.entries(before).map(([key, count]) => [key, count + 1])),
        );
        nativeBoardTrace(trace.records, f.board);
        expect(
          trace.records.filter(
            (r) => [parentStatement(), boardStatement()].includes(r.statement) && r.parameters.includes(f.board),
          ),
        ).toHaveLength(2);
      }
    } finally {
      barrier.release();
      await trace.close();
      await outcome;
    }
  }
});

test('deadline, missing references, route mismatch and reply depth cap deny without writes', async () => {
  const f = await fixture();
  await denied(() => reserveMedia(dependencies(), actor, input(f.thread), { ...request(), deadline: Date.now() - 1 }));
  await denied(() => reserveMedia(dependencies(), actor, input(newId(containerRoute)), request()));
  await expect(post(f, newId(containerRoute + 1))).rejects.toMatchObject({ code: '23514' });
  const wrongRoute = newId(containerRoute + 1);
  const mismatched = await fixture('published', wrongRoute);
  await denied(() => reserveMedia(dependencies(), actor, input(mismatched.thread), request()));
  let target: string | null = null;
  for (let depth = 0; depth < 33; depth++) target = await post(f, target);
  await grant(target!, 'media:create');
  await reserveMedia(dependencies(), actor, input(target!), request());
  target = await post(f, target);
  await grant(target, 'media:create');
  await denied(() => reserveMedia(dependencies(), actor, input(target!), request()));
});

test('initializer failure rolls back media, roles, receipt and outbox', async () => {
  const f = await fixture(),
    trace = observeSql(db.pool);
  trace.armFault({ match: { statement: initialize.sql }, boundary: 'after', error: new Error('initializer failed') });
  try {
    await denied(() => reserveMedia(dependencies(), actor, input(f.thread), request()));
  } finally {
    await trace.close();
  }
});

test('checkGrowth keeps fixed ancestry and one media effect constant across populated native partitions', async () => {
  const f = await fixture('protected');
  const root = await post(f),
    reply = await post(f, root);
  for (const [kind, id] of [
    ['board', f.board],
    ['thread', f.thread],
    ['post', root],
    ['post', reply],
  ] as const) {
    if (kind !== 'board') await visibility(kind, id, 'protected');
    await grant(id, `${kind}:read`);
  }
  await grant(reply, 'media:create');
  const body = Buffer.from('{}'),
    digest = createHash('sha256').update(body).digest();
  const report = await checkGrowth(db, {
    name: 'native media reserve with fixed private reply ancestry',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      await seed(
        database,
        {
          name: 'media parent storage and formula',
          hotPartition: partitionOf(containerRoute),
          async write({ admin }, { ordinal, hot }) {
            const r = hot ? containerRoute : containerRoute + 16;
            const board = newId(boardRoute),
              thread = newId(r),
              post = newId(r),
              revision = newId(r),
              media = newId(r);
            const account = newId(routeOf(actor.accountId)!);
            const principal = { subject_id: account, valid: '(,)', transaction_id: account };
            const tables = {
              'content.board': [
                {
                  route: boardRoute,
                  board_id: board,
                  subject_id: actor.accountId,
                  title: 'Board',
                  visibility: 'published',
                  security_revision: 1,
                  recorded_transaction_id: account,
                },
              ],
              'content.thread': [
                {
                  route: r,
                  thread_id: thread,
                  author_account_id: actor.accountId,
                  board_id: board,
                  title: 'Thread',
                  visibility: 'published',
                  security_revision: 1,
                  recorded_transaction_id: account,
                },
              ],
              'content.post': [
                {
                  route: r,
                  thread_id: thread,
                  post_id: post,
                  author_account_id: actor.accountId,
                  head_revision_id: revision,
                  visibility: 'published',
                  security_revision: 1,
                  recorded_transaction_id: account,
                },
              ],
              'content.revision': [
                {
                  route: r,
                  thread_id: thread,
                  post_id: post,
                  revision_id: revision,
                  body: `\\x${body.toString('hex')}`,
                  body_sha256: `\\x${digest.toString('hex')}`,
                  search_text: '',
                  licence: 'CC0-1.0',
                  subject_ids: [],
                  board_id: board,
                  availability: 'available',
                  recorded_transaction_id: account,
                },
              ],
              'content.media': [
                {
                  route: r,
                  media_id: media,
                  container_id: thread,
                  uploader_id: actor.accountId,
                  reservation_request_id: `seed-${ordinal}`,
                  purpose: 'post-image',
                  media_type: 'image/png',
                  byte_count: 256,
                  actual_byte_count: 256,
                  sha256: 'a'.repeat(64),
                  state: 'available',
                  key: `m/${media}/original`,
                  transaction_id: account,
                },
              ],
              'content.media_variant': [
                {
                  route: r,
                  media_id: media,
                  format: 'webp',
                  width: 320,
                  height: 320,
                  media_type: 'image/webp',
                  byte_count: 128,
                  sha256: 'a'.repeat(64),
                  key: `m/${media}/webp-320`,
                  transaction_id: account,
                },
              ],
              'access.account': [
                {
                  route: routeOf(account)!,
                  account_id: account,
                  kind: 'actor',
                  state: 'active',
                  transaction_id: account,
                },
              ],
              'access.membership_inverse': [
                {
                  route: routeOf(account)!,
                  account_id: account,
                  kind: 'organization',
                  group_id: newId(r),
                  reservation_id: account,
                  transaction_id: account,
                },
              ],
              // Grow ACL fanout on the measured resources, not only unrelated resources.
              'access.resource_grant': [
                { route: containerRoute, resource_id: reply, action: 'media:create', ...principal },
                { route: boardRoute, resource_id: f.board, action: 'board:read', ...principal },
              ],
              'access.resource_role_grant': [
                { route: containerRoute, resource_id: reply, grant_role: 'content.post.owner', ...principal },
              ],
              'access.resource_denial': [
                { route: containerRoute, resource_id: reply, action: 'media:create', reason: 'resource', ...principal },
              ],
              'access.resource_initialization': [
                {
                  route: r,
                  resource_id: media,
                  resource_type: 'content.media',
                  creator_id: actor.accountId,
                  initialized_at: '2020-01-01T00:00:00Z',
                },
              ],
              'core.receipt': [
                {
                  partition_no: partitionOf(r),
                  principal_kind: 'account',
                  principal_id: actor.accountId,
                  command_kind: 'content.media.reserve',
                  idempotency_key: `seed-${ordinal}`,
                  request_digest: `\\x${digest.toString('hex')}`,
                  epoch: 1,
                  position: 1,
                  transaction_id: account,
                  response: { mediaId: media },
                },
              ],
            };
            // Keep each linked thread/post/revision population in one transaction.
            const client = await admin.connect();
            try {
              await client.query('BEGIN');
              for (const [table, rows] of Object.entries(tables)) {
                const columns = Object.keys(rows[0]!).join(', ');
                await client.query(
                  `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`,
                  [JSON.stringify(rows)],
                );
              }
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          },
        },
        { from: previous, to: scale },
      );
    },
    async operation(_database, _scale, repetition) {
      const result = await reserveMedia(dependencies(), actor, input(reply), {
        ...request(),
        idempotencyKey: `growth-${repetition}`,
      });
      expect(result.replayed).toBe(false);
      expect(result.partition).toBe(partitionOf(containerRoute));
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
  expect(new Set(report.samples.map((sample) => sample.cost.rows)).size).toBe(1);
  expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
  for (const sample of report.samples) {
    for (const relation of [
      'content.board',
      'content.thread',
      'content.post',
      'content.revision',
      'content.media',
      'content.media_variant',
    ]) {
      expect(sample.cost.relations?.[relation]).toBeDefined();
      expect(sample.cost.relations?.[relation]?.sequentialScans).toBe(0);
    }
  }
  await Bun.write(
    new URL('../../../../.temp/refs/media-parent-growth.json', import.meta.url),
    JSON.stringify(report, null, 2),
  );
  console.info('Media parent GrowthReport', JSON.stringify(report));
}, 120_000);

test('existing standing parent authority still creates only the media owner role', async () => {
  const f = await fixture();
  await revoke(f.thread, 'media:create');
  await db.admin.query(
    `INSERT INTO access.resource_role_grant(route,resource_id,subject_kind,subject_id,grant_role,valid,transaction_id)
    VALUES ($1,$2,'active_accounts','00000000-0000-0000-0000-000000000000','content.thread.standing','(,)',$3)`,
    [containerRoute, f.thread, actor.accountId],
  );
  const result = await reserveMedia(dependencies(), actor, input(f.thread), request());
  expect(
    (
      await db.admin.query(
        'SELECT grant_role,subject_kind,subject_id FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2',
        [containerRoute, result.value.mediaId],
      )
    ).rows,
  ).toEqual([{ grant_role: 'content.media.owner', subject_kind: 'identity', subject_id: actor.accountId }]);
});

test('deadline during an anchored board read denies and releases its sole client', async () => {
  const f = await fixture(),
    context = { ...request(), deadline: Date.now() + 1000 };
  const trace = observeSql(db.pool),
    barrier = trace.hold({ statement: boardStatement() }, 'before');
  const before = await effects();
  const outcome = reserveMedia(dependencies(), actor, input(f.thread), context).then(
    () => null,
    (error) => error,
  );
  try {
    await Promise.race([
      barrier.entered,
      outcome.then(() => {
        throw new Error('Did not reach board read');
      }),
    ]);
    await Bun.sleep(Math.max(0, context.deadline - Date.now() + 10));
    expect(await outcome).toBeInstanceOf(Error);
    barrier.release();
    await db.pool.query('SELECT 1');
    expect(await effects()).toEqual(before);
    expect(db.pool.waitingCount).toBe(0);
  } finally {
    barrier.release();
    await trace.close();
    await outcome;
  }
});
