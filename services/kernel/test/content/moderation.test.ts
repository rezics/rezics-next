import { suspendAccount, reinstateAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { standingFixture } from '../access/standing-fixture.ts';
import { createThread, revisePost } from '../../src/content/commands.ts';
import { takedown, erasePost, eraseStandaloneMedia } from '../../src/content/moderation.ts';
import { readPost } from '../../src/content/reads.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createErasureJob } from '../../src/content/erasure-job.ts';
import { readReservation } from '../../src/content/media.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { Value } from 'typebox/value';
import { mkdir, writeFile } from 'node:fs/promises';
import { CONTENT_EVENTS } from '../../src/content/events.ts';
import { observeSql } from './support/sql-observer.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

let f: Awaited<ReturnType<typeof standingFixture>>;
let actor: Awaited<ReturnType<typeof f.context>>['actor'];
const board = { route: 0x9abc, id: newId(0x9abc) };
const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const context = (idempotencyKey = crypto.randomUUID()) => ({
  idempotencyKey,
  deadline: Date.now() + 10000,
  requestId: crypto.randomUUID(),
});
const deps = () => ({ pool: f.pool, access: f.access, routeKey });
beforeAll(async () => {
  f = await standingFixture();
  actor = (await f.context()).actor;
  await f.reader.query(
    `INSERT INTO content.board
    (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Board','published',1,$2)`,
    [board.route, board.id, newId(0x4321)],
  );
  await f.grant(actor.accountId, 'thread:create', board);
  await f.grant(actor.accountId, 'board:read', board);
});
beforeEach(async () => {
  actor = (await f.context()).actor;
});
afterAll(() => f?.close());
async function fixture() {
  return (
    await createThread(
      deps(),
      actor,
      {
        title: 'Private authored title',
        body: fromPlainText('Original historical bytes'),
        licence: 'MIT',
        subjectIds: [],
        boardId: board.id,
        visibility: 'published',
      },
      context(),
    )
  ).value;
}
test('logical erasure immediately returns current and exact authorized tombstones', async () => {
  const value = await fixture();
  await f.grant(actor.accountId, 'post:erase', { route: routeOf(value.itemId)!, id: value.itemId });
  await f.grant(actor.accountId, 'post:read', { route: routeOf(value.itemId)!, id: value.itemId });
  await erasePost(deps(), actor, { postId: value.itemId, reason: 'Erase' }, context());
  const reads = { ...deps(), tokens };
  const readContext = { actor, deadline: Date.now() + 10000 };
  const exact = await readPost(reads, value.threadId, value.itemId, readContext, value.revisionId);
  expect(exact.value).toMatchObject({
    id: value.itemId,
    revisionId: value.revisionId,
    body: null,
    availability: 'erased',
    licence: 'MIT',
  });
  const current = await readPost(reads, value.threadId, value.itemId, readContext);
  expect(current.value).toMatchObject({ id: value.itemId, body: null, availability: 'erased' });
});

test('point ports exist without an author-scope command', () => {
  expect([takedown, erasePost, eraseStandaloneMedia].every((port) => typeof port === 'function')).toBe(true);
  expect(
    Value.Check(CONTENT_EVENTS['com.rezics.content.post.erased.v1'], {
      postId: board.id,
      securityRevision: '9007199254740994',
    }),
  ).toBe(true);
  expect(
    Value.Check(CONTENT_EVENTS['com.rezics.content.post.erased.v1'], {
      postId: board.id,
      securityRevision: '2',
      body: 'old text',
    }),
  ).toBe(false);
});

async function stored(table: 'board' | 'thread' | 'post' | 'media', id: string) {
  return (await f.reader.query(`SELECT * FROM content.${table} WHERE route=$1 AND ${table}_id=$2`, [routeOf(id), id]))
    .rows[0];
}
async function domainEvent(outcome: { partition: number; position: bigint }) {
  return (
    await f.reader.query(
      'SELECT type,data,event_count FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=0',
      [outcome.partition, outcome.position],
    )
  ).rows[0];
}
async function effects() {
  return (
    await f.reader.query(`SELECT
    (SELECT count(*) FROM core.receipt) AS receipts,
    (SELECT count(*) FROM core.outbox) AS events`)
  ).rows[0];
}
async function permit(id: string, action: string, accountId = actor.accountId) {
  await f.grant(accountId, action, { route: routeOf(id)!, id });
}
async function eraseFixture() {
  const value = await fixture();
  await permit(value.itemId, 'post:erase');
  await permit(value.itemId, 'post:read');
  return value;
}

test('takedown changes only each actual target and native bigint revision; same key has one effect', async () => {
  for (const kind of ['post', 'thread', 'board'] as const) {
    const value = await fixture();
    const id = kind === 'post' ? value.itemId : kind === 'thread' ? value.threadId : board.id;
    const moderator = (await f.context(f.recipient)).actor;
    await permit(id, 'moderation:takedown', moderator.accountId);
    expect(
      (await readPost({ ...deps(), tokens }, value.threadId, value.itemId, { actor, deadline: Date.now() + 10000 }))
        .value?.body,
    ).not.toBeNull();
    const before = await stored(kind, id);
    // Cross the JavaScript safe integer boundary without rounding at the wire.
    await f.reader.query(
      `UPDATE content.${kind} SET security_revision=9007199254740993
      WHERE route=$1 AND ${kind}_id=$2`,
      [routeOf(id), id],
    );
    const prior = await effects();
    const key = crypto.randomUUID();
    const input = { target: { kind, id }, reason: 'Moderate' };
    const first = await takedown(deps(), moderator, input, context(key));
    const repeat = await takedown(deps(), moderator, input, context(key));
    expect(first.value).toEqual({ targetId: id, securityRevision: '9007199254740994' });
    expect(await domainEvent(first)).toEqual({
      type: 'com.rezics.content.moderation.takedown.v1',
      data: { targetKind: kind, targetId: id, securityRevision: first.value.securityRevision },
      event_count: 1,
    });
    expect(repeat).toEqual({ ...first, replayed: true });
    expect(await stored(kind, id)).toEqual({
      ...before,
      visibility: 'taken_down',
      security_revision: '9007199254740994',
    });
    expect(await effects()).toEqual({
      receipts: String(Number(prior.receipts) + 1),
      events: String(Number(prior.events) + 1),
    });
    if (kind !== 'post') expect((await stored('post', value.itemId)).visibility).toBe('published');
    // Actual ancestor visibility conceals descendants immediately.
    expect(
      (
        await readPost({ ...deps(), tokens }, value.threadId, value.itemId, {
          actor,
          deadline: Date.now() + 10000,
        })
      ).value,
    ).toBeNull();
    await f.reader.query(
      `DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3
      AND action='moderation:takedown'`,
      [routeOf(id), id, moderator.accountId],
    );
    const committed = await effects();
    await expect(takedown(deps(), moderator, input, context(key))).rejects.toThrow();
    expect(await effects()).toEqual(committed);
  }
});

test('logical point changes no revision bytes, licence, descendant or media; edits and revoked replay deny', async () => {
  // A separate board keeps the board-takedown test independent.
  await f.reader.query(
    `UPDATE content.board SET visibility='published', security_revision=security_revision+1
    WHERE route=$1 AND board_id=$2`,
    [board.route, board.id],
  );
  const value = await eraseFixture();
  const revision = (
    await revisePost(
      deps(),
      actor,
      {
        threadId: value.threadId,
        itemId: value.itemId,
        body: fromPlainText('Second historical bytes'),
      },
      context(),
    )
  ).value;
  const before = await stored('post', value.itemId);
  const originalRows = (
    await f.reader.query(`SELECT * FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY revision_id`, [
      routeOf(value.itemId),
      value.itemId,
    ])
  ).rows;
  const key = crypto.randomUUID();
  const input = { postId: value.itemId, reason: 'Erase all exact versions logically' };
  const first = await erasePost(deps(), actor, input, context(key));
  expect(first.value).toEqual({
    postId: value.itemId,
    securityRevision: String(BigInt(before.security_revision) + 1n),
  });
  expect(await stored('post', value.itemId)).toEqual({
    ...before,
    availability: 'erased',
    security_revision: first.value.securityRevision,
  });
  expect(
    (
      await f.reader.query(`SELECT * FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY revision_id`, [
        routeOf(value.itemId),
        value.itemId,
      ])
    ).rows,
  ).toEqual(originalRows);
  for (const revisionId of [value.revisionId, revision.revisionId]) {
    const exact = await readPost(
      { ...deps(), tokens },
      value.threadId,
      value.itemId,
      { actor, deadline: Date.now() + 10000 },
      revisionId,
    );
    const original = originalRows.find((row) => row.revision_id === revisionId)!;
    expect(exact.value).toMatchObject({
      id: value.itemId,
      revisionId,
      licence: original.licence,
      sha256: null,
      body: null,
      availability: 'erased',
    });
    expect(
      (
        await readPost(
          { ...deps(), tokens },
          value.threadId,
          value.itemId,
          { actor: { kind: 'anonymous' }, deadline: Date.now() + 10000 },
          revisionId,
        )
      ).value,
    ).toBeNull();
  }
  expect((await erasePost(deps(), actor, input, context(key))).replayed).toBe(true);
  const committed = await effects();
  // A new key on an already erased target cannot emit another physical purge.
  await expect(erasePost(deps(), actor, input, context())).rejects.toThrow();
  expect((await effects()).events).toBe(committed.events);
  await expect(
    revisePost(
      deps(),
      actor,
      { threadId: value.threadId, itemId: value.itemId, body: fromPlainText('Forbidden replacement') },
      context(),
    ),
  ).rejects.toThrow();
  await f.reader.query(`DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action='post:erase'`, [
    routeOf(value.itemId),
    value.itemId,
  ]);
  await f.reader.query('DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
    routeOf(value.itemId),
    value.itemId,
  ]);
  const prior = await effects();
  const observer = observeSql(f.pool);
  try {
    await expect(erasePost(deps(), actor, input, context(key))).rejects.toThrow();
    expect(observer.records.some(({ statement }) => /FROM core\.receipt/i.test(statement))).toBe(false);
  } finally {
    await observer.close();
  }
  expect(await effects()).toEqual(prior);
});

test('anonymous, ownership without grant, wrong target grant and absent scope never mutate or produce a receipt', async () => {
  const value = await fixture();
  await f.reader.query('DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
    routeOf(value.itemId),
    value.itemId,
  ]);
  const initial = await stored('post', value.itemId);
  const prior = await effects();
  const input = { target: { kind: 'post' as const, id: value.itemId }, reason: 'Denied' };
  await expect(takedown(deps(), { kind: 'anonymous' }, input, context())).rejects.toThrow();
  await expect(takedown(deps(), actor, input, context())).rejects.toThrow();
  await expect(
    erasePost(deps(), actor, { postId: value.itemId, reason: 'Owner alone is insufficient' }, context()),
  ).rejects.toThrow();
  await permit(value.threadId, 'moderation:takedown');
  await expect(takedown(deps(), actor, input, context())).rejects.toThrow();
  await permit(value.itemId, 'moderation:takedown');
  const withoutScope = (await f.context(f.actor, ['post:read'])).actor;
  await expect(takedown(deps(), withoutScope, input, context())).rejects.toThrow();
  expect(await stored('post', value.itemId)).toEqual(initial);
  expect(await effects()).toEqual(prior);
});

async function media(
  containerId: string,
  state = 'available',
  collectionPending = false,
  atRoute = routeOf(containerId)!,
) {
  const mediaId = newId(atRoute);
  await f.reader.query(
    `INSERT INTO content.media
    (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,
     actual_byte_count,sha256,state,decision,key,transaction_id,collection_pending)
    VALUES ($1,$2::uuid,$3,$4,$2::uuid::text,'post-image','image/png',3,3,$5,$6,$7,$8,$2::uuid,$9)`,
    [
      atRoute,
      mediaId,
      containerId,
      actor.accountId,
      'a'.repeat(64),
      state,
      state === 'rejected' ? 'unsafe' : null,
      `m/${mediaId}/original`,
      collectionPending,
    ],
  );
  await permit(mediaId, 'media:erase');
  await permit(mediaId, 'media:read_reservation');
  return mediaId;
}

test('standalone media commits one ID-only purge source and retries prefix failure without reopening access', async () => {
  const value = await fixture();
  const mediaId = await media(value.itemId);
  const unrelated = await media(value.itemId);
  const prior = await stored('media', mediaId);
  const untouched = await stored('media', unrelated);
  const key = crypto.randomUUID();
  const input = { mediaId, reason: 'Erase standalone object' };
  const first = await eraseStandaloneMedia(deps(), actor, input, context(key));
  expect(first.value).toEqual({ targetId: mediaId, securityRevision: '1' });
  expect(await domainEvent(first)).toEqual({
    type: 'com.rezics.content.media.erased.v1',
    data: { mediaId, containerId: value.itemId },
    event_count: 1,
  });
  expect((await eraseStandaloneMedia(deps(), actor, input, context(key))).replayed).toBe(true);
  expect(await stored('media', mediaId)).toEqual({ ...prior, erased: true, security_revision: '1' });
  expect(await stored('media', unrelated)).toEqual(untouched);
  const metadata = await readReservation(deps(), mediaId, { actor, deadline: Date.now() + 10000 });
  expect(metadata).toMatchObject({ id: mediaId, erased: true, sha256: prior.sha256 });
  const objects = new Map<string, Uint8Array>([
    [`m/${mediaId}/original`, new Uint8Array([1, 2, 3])],
    [`m/${mediaId}/avif-320`, new Uint8Array([1, 2, 3])],
    [`m/${unrelated}/original`, new Uint8Array([1, 2, 3])],
  ]);
  let fail = true;
  const storage: MediaStorage = {
    async get(id) {
      return objects.get(id) ?? null;
    },
    async put(id, bytes) {
      objects.set(id, bytes);
    },
    async deletePrefix(prefix) {
      expect(prefix).toBe(`m/${mediaId}/`);
      // The production job must release its database connection first.
      expect(f.pool.idleCount).toBe(f.pool.totalCount);
      if (fail) {
        fail = false;
        throw new Error('Remote storage unavailable');
      }
      for (const id of objects.keys()) if (id.startsWith(prefix)) objects.delete(id);
    },
  };
  await expect(createErasureJob(f.pool, storage).purgeObject(mediaId)).rejects.toThrow('Remote storage unavailable');
  expect((await stored('media', mediaId)).erased).toBe(true);
  expect(await createErasureJob(f.pool, storage).purgeObject(mediaId)).toMatchObject({ outcome: 'purged' });
  expect([...objects.keys()]).toEqual([`m/${unrelated}/original`]);
  const committed = await effects();
  await f.reader.query(`DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action='media:erase'`, [
    routeOf(mediaId),
    mediaId,
  ]);
  await expect(eraseStandaloneMedia(deps(), actor, input, context(key))).rejects.toThrow();
  expect(await effects()).toEqual(committed);
  for (const [state, pending] of [
    ['rejected', false],
    ['available', true],
  ] as const) {
    const id = await media(value.itemId, state, pending);
    if (pending) {
      const before = await effects();
      await expect(
        eraseStandaloneMedia(deps(), actor, { mediaId: id, reason: 'Pending collection' }, context()),
      ).rejects.toThrow();
      expect(await effects()).toEqual(before);
      expect((await stored('media', id)).collection_pending).toBe(true);
    } else {
      await eraseStandaloneMedia(deps(), actor, { mediaId: id, reason: 'Already rejected' }, context());
      expect(await stored('media', id)).toMatchObject({ erased: true, state: 'rejected', decision: 'unsafe' });
    }
  }
});

// All growth setup is privileged fixture work outside observation. One method
// grows unrelated posts, revisions and media in the actual hot thread/route.
// The actor, lineage, input bytes and three point writes stay fixed.
test('checkGrowth proves point writes include shared Access within the three-scale bound', async () => {
  const db = await openGrowthDatabase();
  const base = await fixture();
  const route = routeOf(base.threadId)!;
  const targets: { postId: string; mediaId: string }[] = [];
  const population = (postId: string, revisionId: string) => ({ postId, revisionId, mediaId: newId(route) });
  async function insertRows(rows: { postId: string; revisionId: string }[]) {
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO content.post
        (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
        SELECT $1,$2,x."postId",$3,x."revisionId",'published',1,x."postId"
        FROM jsonb_to_recordset($4::jsonb) x("postId" uuid,"revisionId" uuid)`,
        [route, base.threadId, actor.accountId, JSON.stringify(rows)],
      );
      await client.query(
        `INSERT INTO content.revision
        (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
        SELECT $1,$2,x."postId",x."revisionId",$3,sha256($3),'Distractor','MIT','{}',$4,'available',x."revisionId"
        FROM jsonb_to_recordset($5::jsonb) x("postId" uuid,"revisionId" uuid)`,
        [route, base.threadId, Buffer.from('fixture bytes'), board.id, JSON.stringify(rows)],
      );
      await client.query(
        `INSERT INTO content.media
        (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,
         actual_byte_count,sha256,state,key,transaction_id)
        SELECT $1,x."mediaId",$2,$3,x."mediaId"::text,'post-image','image/png',3,3,$4,'available',
          'm/' || x."mediaId"::text || '/original',x."mediaId"
        FROM jsonb_to_recordset($5::jsonb) x("mediaId" uuid)`,
        [route, base.itemId, actor.accountId, 'a'.repeat(64), JSON.stringify(rows)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function grow(growthDb: GrowthDatabase, scale: number, previous: number) {
    // Neighbouring rows keep every key index worth its cost to the planner at the smallest scale, where it would
    // otherwise scan a table of a few dozen rows once per probe and add every earlier receipt and grant to the cost.
    if (previous === 0) {
      const neighbours = Array.from({ length: 2048 }, () => population(newId(route), newId(route)));
      await insertRows(neighbours);
      const resources = neighbours.map(({ postId }) => postId);
      const transaction = Bun.randomUUIDv7();
      await growthDb.admin.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
         SELECT $1,resource_id,$2,'post:read','(,)',$3 FROM unnest($4::uuid[]) AS resource_id`,
        [route, newId(0x2345), transaction, resources],
      );
      await growthDb.admin.query(
        `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
         SELECT $1,resource_id,$2,'content.post.owner','(,)',$3 FROM unnest($4::uuid[]) AS resource_id`,
        [route, newId(0x2345), transaction, resources],
      );
      await growthDb.admin.query(
        `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
         SELECT $1,'account',$2,'content.post.create',key,sha256(convert_to(key,'UTF8')),1,1,$3,'{}'
         FROM unnest($4::text[]) AS key`,
        [partitionOf(route), newId(0x2345), transaction, resources],
      );
    }
    await insertRows(Array.from({ length: scale - previous }, () => population(newId(route), newId(route))));
    // Six real changed sets per scale: one warmup and five measured operations.
    const points = Array.from({ length: 6 }, () => population(newId(route), newId(route)));
    await insertRows(points);
    for (const point of points) {
      await permit(point.postId, 'post:erase');
      await permit(point.postId, 'moderation:takedown');
      const mediaId = await media(point.postId);
      targets.push({ postId: point.postId, mediaId });
    }
    await growthDb.admin.query('ANALYZE content.post');
    await growthDb.admin.query('ANALYZE content.revision');
    await growthDb.admin.query('ANALYZE content.media');
  }
  // Bind the real authenticated identity to the observed production pool.
  const authenticate = f.access.authenticate;
  f.access.authenticate = (token, boundary) =>
    authenticate(token, { ...boundary, pool: db.pool, deadline: Date.now() + 120000 });
  try {
    const report = await checkGrowth(db, {
      name: 'point moderation and logical erasure',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow,
      async operation(growthDb, _scale, repetition) {
        const verified = (await f.context()).actor;
        const point = targets[repetition]!;
        const observed = { ...deps(), pool: growthDb.pool };
        await takedown(
          observed,
          verified,
          { target: { kind: 'post', id: point.postId }, reason: 'Fixed bytes' },
          context(),
        );
        await erasePost(observed, verified, { postId: point.postId, reason: 'Fixed bytes' }, context());
        const result = await eraseStandaloneMedia(
          observed,
          verified,
          { mediaId: point.mediaId, reason: 'Fixed bytes' },
          context(),
        );
        expect(result.partition).toBe(partitionOf(route));
      },
    });
    await mkdir('.temp', { recursive: true });
    await writeFile('.temp/moderation-growth-report.json', JSON.stringify(report, null, 2));
    console.info(
      'GrowthReport',
      JSON.stringify({
        name: report.name,
        bounds: report.bounds,
        samples: report.samples.map(({ scale, cost }) => ({
          scale,
          rows: cost.rows,
          blocks: cost.blocks,
          statements: cost.statements,
        })),
      }),
    );
    expect(report.samples.map(({ scale }) => scale)).toEqual([32, 256, 2048]);
    for (const { cost } of report.samples) {
      expect(cost.relations?.['content.post']?.rows).toBeGreaterThan(0);
      expect(cost.relations?.['access.resource_grant']?.rows).toBeGreaterThan(0);
      expect(cost.relations?.['content.revision']).toBeUndefined();
    }
  } finally {
    f.access.authenticate = authenticate;
    await db.close();
  }
}, 90000);

test('outbox failure rolls back target visibility, security revision, receipt and effect together', async () => {
  const value = await fixture();
  await permit(value.itemId, 'moderation:takedown');
  const input = { target: { kind: 'post' as const, id: value.itemId }, reason: 'Atomic point' };
  const observer = observeSql(f.pool);
  try {
    await takedown(deps(), actor, input, context());
    const statement = observer.records.find(({ statement }) => /INSERT INTO core.outbox/.test(statement))!.statement;
    observer.armFault({ match: { statement }, boundary: 'before', error: new Error('outbox unavailable') });
    const before = await stored('post', value.itemId);
    const committed = await effects();
    await expect(takedown(deps(), actor, input, context())).rejects.toThrow('outbox unavailable');
    expect(await stored('post', value.itemId)).toEqual(before);
    expect(await effects()).toEqual(committed);
  } finally {
    await observer.close();
  }
});

test('suspended authentication cannot establish a point-command actor even with a target grant', async () => {
  const value = await fixture();
  await permit(value.itemId, 'moderation:takedown');
  const before = await stored('post', value.itemId);
  // Capture the genuine issuer token, then exercise native authentication again
  // after current account suspension. No synthetic Actor or policy is supplied.
  const authenticate = f.access.authenticate;
  let token = '';
  f.access.authenticate = (issued, boundary) => {
    token = issued;
    return authenticate(issued, boundary);
  };
  try {
    await f.context();
  } finally {
    f.access.authenticate = authenticate;
  }
  await suspendAccount(f.reader, actor.accountId);
  const committed = await effects();
  try {
    await expect(
      (async () => {
        const verified = await authenticate(token, { pool: f.pool, deadline: Date.now() + 10000 });
        return takedown(
          deps(),
          verified,
          { target: { kind: 'post', id: value.itemId }, reason: 'Suspended' },
          context(),
        );
      })(),
    ).rejects.toThrow();
    expect(await stored('post', value.itemId)).toEqual(before);
    expect(await effects()).toEqual(committed);
  } finally {
    await reinstateAccount(f.reader, actor.accountId);
  }
});
