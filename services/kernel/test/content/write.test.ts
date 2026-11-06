import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import type { Pool } from 'pg';
import {
  createResourceCreationManifest,
  initializeResourceGrants,
  parentCreationAuthorization,
} from '../../src/access/index.ts';
import { createThread, createPost, revisePost, threadTarget } from '../../src/content/commands.ts';
import { runCommand, IdempotencyConflictError } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import type { GrowthDatabase } from '../support/growth.ts';
import type { ThreadInput } from '../../src/content/model.ts';

// Frozen write-path acceptance assertions precede the command implementation.
let f: Awaited<ReturnType<typeof standingFixture>>;
let owner: Awaited<ReturnType<typeof f.context>>['actor'];
const routeKey = new Uint8Array(32).fill(7);
const board = { route: 0x9abc, id: newId(0x9abc) };
const subject = newId(0x8765);
const context = (idempotencyKey = Bun.randomUUIDv7()) => ({
  idempotencyKey,
  deadline: Date.now() + 10000,
  requestId: Bun.randomUUIDv7(),
});
const input = (): ThreadInput => ({
  title: 'Authored title',
  body: fromPlainText('First exact authored body'),
  licence: 'MIT',
  subjectIds: [subject],
  boardId: board.id,
  visibility: 'published',
});
const dependencies = () => ({ clock: () => new Date(), pool: f.pool, access: f.access, routeKey });

beforeAll(async () => {
  // reaction:set is a mounted standing action; without it the thread and post templates drop.
  f = await standingFixture(['reaction:set']);
  await f.reader.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Books','published',1,$4)`,
    [board.route, board.id, subject, Bun.randomUUIDv7()],
  );
}, 30000);
beforeEach(async () => {
  await f.reset();
  owner = (await f.context()).actor;
  await f.grant(owner.accountId, 'thread:create', board);
});
afterAll(() => f?.close());

async function snapshot() {
  return (
    await f.reader.query(`SELECT
      (SELECT count(*) FROM content.thread) AS threads,
      (SELECT count(*) FROM content.post) AS posts,
      (SELECT count(*) FROM content.revision) AS revisions,
      (SELECT count(*) FROM core.receipt) AS receipts,
      (SELECT count(*) FROM core.outbox) AS events,
      (SELECT count(*) FROM access.resource_role_grant) AS roles`)
  ).rows[0];
}
async function revision(id: string) {
  return (await f.reader.query('SELECT * FROM content.revision WHERE route=$1 AND revision_id=$2', [routeOf(id), id]))
    .rows[0];
}
async function create(key = Bun.randomUUIDv7(), original = input()) {
  return createThread(dependencies(), owner, original, context(key));
}

// Expose only the fixture's genuine Auth issuance boundary. Production Access
// authenticates the issued token directly against the observed command pool.
async function observedActor(pool: Pool) {
  const authenticate = f.access.authenticate;
  f.access.authenticate = (token, boundary) =>
    authenticate(token, { ...boundary, pool, deadline: Date.now() + 120000 });
  try {
    return (await f.context()).actor;
  } finally {
    f.access.authenticate = authenticate;
  }
}

test('thread first post and revisions commit atomically in one partition', async () => {
  const key = Bun.randomUUIDv7();
  const before = await snapshot();
  const original = input();
  const result = await create(key, original);
  const { threadId, itemId, revisionId } = result.value;
  expect(Object.keys(result.value).sort()).toEqual(['itemId', 'revisionId', 'threadId']);
  expect(result.replayed).toBe(false);
  const target = threadTarget(routeKey, owner.accountId, key);
  expect(routeOf(threadId)).toBe(target.route);
  expect(partitionOf(target.route)).not.toBe(partitionOf(board.route));
  expect(routeOf(itemId)).toBe(target.route);
  expect(routeOf(revisionId)).toBe(target.route);
  expect(result.partition).toBe(partitionOf(target.route));
  const stored = await revision(revisionId);
  const bytes = Buffer.from(serializeDocument(original.body as DocumentSnapshot));
  expect(stored).toMatchObject({
    body: bytes,
    body_sha256: createHash('sha256').update(bytes).digest(),
    search_text: 'First exact authored body',
    licence: 'MIT',
    subject_ids: [subject],
    board_id: board.id,
    recorded_transaction_id: result.transactionId,
  });
  for (const [table, idColumn, id] of [
    ['thread', 'thread_id', threadId],
    ['post', 'post_id', itemId],
  ]) {
    const row = await f.reader.query(
      `SELECT author_account_id,recorded_transaction_id FROM content.${table} WHERE route=$1 AND ${idColumn}=$2`,
      [target.route, id],
    );
    expect(row.rows).toEqual([{ author_account_id: owner.accountId, recorded_transaction_id: result.transactionId }]);
  }
  const grants = await f.reader.query(
    `SELECT resource_id,grant_role FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=ANY($2::uuid[]) ORDER BY resource_id,grant_role`,
    [target.route, [threadId, itemId]],
  );
  expect(grants.rows).toHaveLength(4);
  expect(grants.rows).toEqual(
    expect.arrayContaining([
      { resource_id: threadId, grant_role: 'content.thread.owner' },
      { resource_id: itemId, grant_role: 'content.post.owner' },
    ]),
  );
  const receipts = await f.reader.query(
    'SELECT response FROM core.receipt WHERE partition_no=$1 AND transaction_id=$2',
    [result.partition, result.transactionId],
  );
  expect(receipts.rows).toEqual([{ response: result.value }]);
  const events = await f.reader.query('SELECT data FROM core.outbox WHERE partition_no=$1 AND position=$2', [
    result.partition,
    result.position.toString(),
  ]);
  expect(events.rows).toEqual([{ data: { ...result.value, actorId: owner.accountId } }]);
  for (const text of ['Authored title', 'First exact authored body']) {
    expect(JSON.stringify([receipts.rows, events.rows])).not.toContain(text);
  }
  const after = await snapshot();
  expect(Number(after.threads) - Number(before.threads)).toBe(1);
  expect(Number(after.posts) - Number(before.posts)).toBe(1);
  expect(Number(after.revisions) - Number(before.revisions)).toBe(1);
  expect(Number(after.receipts) - Number(before.receipts)).toBe(1);
  expect(Number(after.events) - Number(before.events)).toBe(1);
  const replay = await create(key, original);
  expect(replay).toEqual({ ...result, replayed: true });
  expect(await snapshot()).toEqual(after);
  await expect(
    createThread(dependencies(), owner, { ...input(), title: 'Changed digest' }, context(key)),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(await snapshot()).toEqual(after);
  const edited = await revisePost(
    dependencies(),
    owner,
    {
      threadId,
      itemId,
      body: fromPlainText('Second exact authored body'),
    },
    context(),
  );
  expect(edited.value.revisionId).not.toBe(revisionId);
  expect(await revision(revisionId)).toEqual(stored);
  expect(await revision(edited.value.revisionId)).toMatchObject({
    licence: 'MIT',
    subject_ids: [subject],
    board_id: board.id,
  });
  const head = await f.reader.query('SELECT head_revision_id FROM content.post WHERE route=$1 AND post_id=$2', [
    target.route,
    itemId,
  ]);
  expect(head.rows).toEqual([{ head_revision_id: edited.value.revisionId }]);
});

test('parent authorization precedes receipt and denied replay has no disclosure or effect', async () => {
  const key = Bun.randomUUIDv7();
  const db = await openGrowthDatabase();
  try {
    const actor = await observedActor(db.pool);
    const original = input();
    await createThread({ ...dependencies(), pool: db.pool }, actor, original, context(key));
    await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
      board.route,
      board.id,
      actor.accountId,
    ]);
    const before = await snapshot();
    // Observing the actual shared formula preserves production semantics.
    const stages: string[] = [];
    const access = {
      ...f.access,
      async authorize(...args: Parameters<typeof f.access.authorize>) {
        stages.push('authorize');
        expect(args[3]).toMatchObject(board);
        expect(args[5]).toBeDefined();
        return f.access.authorize(...args);
      },
    };
    const { capture } = await import('../support/growth.ts');
    const observed = await capture(db, async () => {
      const denied = await Promise.resolve()
        .then(() =>
          createThread(
            { ...dependencies(), access, pool: db.pool },
            actor,
            { ...original, body: { invalid: true } },
            context(key),
          ),
        )
        .catch((error: unknown) => error);
      expect(denied).toBeInstanceOf(Error);
      expect(denied).not.toHaveProperty('value');
      expect(denied).not.toHaveProperty('port');
    });
    expect(stages).toEqual(['authorize']);
    expect(observed.capture.statements.some((sql) => /FROM core\.receipt/i.test(sql))).toBe(false);
    expect(observed.capture.statements.some((sql) => /INSERT INTO/i.test(sql))).toBe(false);
    expect(await snapshot()).toEqual(before);
  } finally {
    await db.close();
  }
});

test('non-author cannot revise and wrong reply containment rolls back', async () => {
  const first = await create();
  const second = await create();
  const other = (await f.context(f.recipient)).actor;
  const target = { route: routeOf(first.value.itemId)!, id: first.value.itemId };
  await f.grant(other.accountId, 'moderation:takedown', target);
  // Even an explicit edit grant cannot change immutable body authorship.
  await f.grant(other.accountId, 'post:revise', target);
  const before = await snapshot();
  await expect(
    Promise.resolve().then(() =>
      revisePost(
        dependencies(),
        other,
        {
          threadId: first.value.threadId,
          itemId: first.value.itemId,
          body: fromPlainText('Forged edit'),
        },
        context(),
      ),
    ),
  ).rejects.toThrow();
  await expect(
    Promise.resolve().then(() =>
      createPost(
        dependencies(),
        owner,
        {
          threadId: first.value.threadId,
          parentId: second.value.itemId,
          body: fromPlainText('Wrong container'),
          licence: 'MIT',
        },
        context(),
      ),
    ),
  ).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  const reply = await createPost(
    dependencies(),
    other,
    {
      threadId: first.value.threadId,
      parentId: first.value.itemId,
      body: fromPlainText('Ordinary standing reply'),
      licence: 'CC0-1.0',
      subjectIds: [],
      boardId: board.id,
    },
    context(),
  );
  expect(await revision(reply.value.revisionId)).toMatchObject({
    subject_ids: [],
    licence: 'CC0-1.0',
    board_id: board.id,
  });
});

test('transaction failure rolls back bodies, grants, receipts and events', async () => {
  const before = await snapshot();
  const key = Bun.randomUUIDv7();
  await f.reader.query(`
    CREATE FUNCTION public.fail_content_effect() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'controlled outbox failure'; END $$;
    CREATE TRIGGER fail_content_effect BEFORE INSERT ON core.outbox
    FOR EACH ROW EXECUTE FUNCTION public.fail_content_effect()`);
  try {
    await expect(Promise.resolve().then(() => create(key))).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  } finally {
    await f.reader.query('DROP TRIGGER fail_content_effect ON core.outbox; DROP FUNCTION public.fail_content_effect()');
  }
  expect((await create(key)).replayed).toBe(false);
});

test('shared parent capability initializes thread and first-post roles in one transaction', async () => {
  const thread = { route: 0x4567, id: newId(0x4567) };
  const post = { route: thread.route, id: newId(thread.route) };
  const ctx = await f.context();
  const creation = {
    async validate(tx: Parameters<Parameters<typeof runCommand>[2]>[0], resource: { route: number; id: string }) {
      return (
        (
          await tx.query(
            'SELECT 1 FROM public.standing_resource WHERE route=$1 AND id=$2 AND creation_xid=pg_current_xact_id()',
            [resource.route, resource.id],
          )
        ).rowCount === 1
      );
    },
  };
  const authorization = parentCreationAuthorization({
    access: f.access,
    actor: ctx.actor,
    action: 'thread:create',
    parent: {
      resource: board,
      async validate(client) {
        return (
          (await client.query('SELECT 1 FROM content.board WHERE route=$1 AND board_id=$2', [board.route, board.id]))
            .rowCount === 1
        );
      },
    },
    context: {
      ...ctx,
      resource: thread,
      creation,
      manifest: createResourceCreationManifest([
        { resource: thread, type: 'content.thread', creator: owner.accountId, creation },
        { resource: post, type: 'content.post', creator: owner.accountId, creation },
      ]),
    },
  });
  const before = await snapshot();
  await runCommand(
    f.pool,
    {
      partition: partitionOf(thread.route),
      deadline: ctx.deadline,
      authorization,
      basis: { actorAccountId: owner.accountId, clientId: owner.clientId, requestedBy: owner.requestedBy },
    },
    async (tx) => {
      // Privileged fixture INSERTs prove unique creation in this live transaction;
      // authorization, capability validation and grant initialization are real shared exports.
      await tx.query('INSERT INTO public.standing_resource(route,id) VALUES ($1,$2),($1,$3)', [
        thread.route,
        thread.id,
        post.id,
      ]);
      await initializeResourceGrants(tx, { resource: thread, type: 'content.thread', creator: owner.accountId });
      await initializeResourceGrants(tx, { resource: post, type: 'content.post', creator: owner.accountId });
      return {
        value: { threadId: thread.id, itemId: post.id },
        events: [{ type: 'com.rezics.fixture.created.v1', data: {} }],
      };
    },
  );
  expect(Number((await snapshot()).roles) - Number(before.roles)).toBe(4);
});

test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  const db = await openGrowthDatabase();
  let seedRoute: number;
  async function grow(database: GrowthDatabase, scale: number, previous: number) {
    // Setup is unmeasured. Neighbouring rows keep every key index worth its cost to the planner at the smallest scale,
    // where it would otherwise scan a table of a few dozen rows once per probe.
    if (previous === 0)
      for (const route of [seedRoute, 0x5678]) {
        const resources = Array.from({ length: 2048 }, () => newId(route));
        const posts = resources.map(() => newId(route));
        const revisions = resources.map(() => newId(route));
        const transaction = Bun.randomUUIDv7();
        const body = Buffer.from('Neighbour body');
        await database.admin.query(
          `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
           SELECT $1,resource_id,$2,'post:read','(,)',$3 FROM unnest($4::uuid[]) AS resource_id`,
          [route, newId(0x2345), transaction, resources],
        );
        await database.admin.query(
          `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
           SELECT $1,resource_id,$2,'content.post.owner','(,)',$3 FROM unnest($4::uuid[]) AS resource_id`,
          [route, newId(0x2345), transaction, resources],
        );
        const client = await database.admin.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
             SELECT $1,thread_id,$2,$3,'Neighbour','published',1,$4 FROM unnest($5::uuid[]) AS thread_id`,
            [route, owner.accountId, board.id, transaction, resources],
          );
          await client.query(
            `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
             SELECT $1,thread_id,post_id,$2,revision_id,'published',1,$3
             FROM unnest($4::uuid[],$5::uuid[],$6::uuid[]) AS row(thread_id,post_id,revision_id)`,
            [route, owner.accountId, transaction, resources, posts, revisions],
          );
          await client.query(
            `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
             SELECT $1,thread_id,post_id,revision_id,$2,sha256($2),'neighbour','MIT','{}',$3,'available',$4
             FROM unnest($5::uuid[],$6::uuid[],$7::uuid[]) AS row(thread_id,post_id,revision_id)`,
            [route, body, board.id, transaction, resources, posts, revisions],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        await database.admin.query(
          `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
           SELECT $1,'account',$2,'content.post.create',key,sha256(convert_to(key,'UTF8')),1,1,$3,'{}'
           FROM unnest($4::text[]) AS key`,
          [partitionOf(route), newId(0x2345), transaction, resources],
        );
      }
    // Grow both hot-route and unrelated-route content.
    for (let i = previous; i < scale; i++) {
      for (const route of [seedRoute, 0x5678]) {
        await database.admin.query(
          `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
           VALUES ($1,$2,$3,$4,'Distractor','published',1,$5)`,
          [route, newId(route), owner.accountId, board.id, Bun.randomUUIDv7()],
        );
      }
    }
    await database.admin.query('ANALYZE content.thread');
  }
  try {
    const actor = await observedActor(db.pool);
    const thread = await createThread({ ...dependencies(), pool: db.pool }, actor, input(), context());
    seedRoute = routeOf(thread.value.threadId)!;
    const report = await checkGrowth(db, {
      name: 'content write with fixed body, references and changed rows',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow,
      async operation(database, _scale, repetition) {
        await createPost(
          { ...dependencies(), pool: database.pool },
          actor,
          {
            threadId: thread.value.threadId,
            body: fromPlainText('Fixed measured body'),
            licence: 'MIT',
            subjectIds: [],
          },
          context(`growth-${repetition}`),
        );
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
    console.log(JSON.stringify(report));
  } finally {
    await db.close();
  }
}, 60000);
