import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { Value } from 'typebox/value';
import { createAccess } from '../../src/access/index.ts';
import { runCommand, type CommandEvent, type CommandOutcome } from '../../src/command/command.ts';
import { createThread, createPost } from '../../src/content/commands.ts';
import { takedown } from '../../src/content/moderation.ts';
import { liftTakedown } from '../../src/content/lift-takedown.ts';
import { CONTENT_EVENTS } from '../../src/content/events.ts';
import { readPost, readThread } from '../../src/content/reads.ts';
import { createAuthorItemEffect } from '../../src/content/author-item-index.ts';
import { createBoardEffect } from '../../src/content/board-projection.ts';
import { createSubjectThreadEffect } from '../../src/content/subject-thread-index.ts';
import { listAuthorPosts, listAuthorThreads } from '../../src/content/author-item-reads.ts';
import { listBoardThreads } from '../../src/content/boards.ts';
import { listSubjectThreads } from '../../src/content/subject-threads.ts';
import { listSitemapBoards, listSitemapThreads } from '../../src/content/sitemap.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { standingFixture } from '../access/standing-fixture.ts';

let f: Awaited<ReturnType<typeof standingFixture>>;
let actor: Awaited<ReturnType<typeof f.context>>['actor'];
let sitemapAccess: ReturnType<typeof createAccess>;
const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const deps = () => ({ pool: f.pool, access: f.access, routeKey, tokens });
const context = () => ({
  idempotencyKey: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
  deadline: Date.now() + 30000,
});
const reader = () => ({ actor, deadline: Date.now() + 30000 });

beforeAll(async () => {
  f = await standingFixture();
  actor = (await f.context()).actor;
  // The standing fixture mounts bearer-only actions. Feeds use the native public read catalogue.
  sitemapAccess = createAccess({ actions: actionCatalogue(createKernel({ pool: f.pool, routeKey, tokens })) });
});
afterAll(() => f?.close());

async function stored(kind: 'thread' | 'post', id: string) {
  return (await f.reader.query(`SELECT * FROM content.${kind} WHERE route=$1 AND ${kind}_id=$2`, [routeOf(id), id]))
    .rows[0];
}
async function outbox(outcome: Pick<CommandOutcome<unknown>, 'partition' | 'position'>): Promise<CloudEvent[]> {
  const { rows } = await f.reader.query(
    'SELECT * FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq',
    [outcome.partition, outcome.position],
  );
  return rows.map((row) => ({
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${outcome.partition}.${row.epoch}`,
    type: row.type,
    subject: row.subject,
    time: row.recorded_at.toISOString(),
    datacontenttype: 'application/json',
    sequence: outcome.position.toString().padStart(19, '0'),
    data: row.data,
  }));
}
async function fixture() {
  const subjectId = newId(0x4321);
  const boardId = newId(0x9abc);
  await f.reader.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision) VALUES ($1,$2,'schema:Book',$2,'visible',1)`,
    [routeOf(subjectId), subjectId],
  );
  await f.grant(actor.accountId, 'subject:read', { route: routeOf(subjectId)!, id: subjectId });
  await f.reader.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id) VALUES ($1,$2,$3,'Restorable board','published',1,$2)`,
    [routeOf(boardId), boardId, subjectId],
  );
  await f.grant(actor.accountId, 'thread:create', { route: routeOf(boardId)!, id: boardId });
  await f.grant(actor.accountId, 'board:read', { route: routeOf(boardId)!, id: boardId });
  const created = await createThread(
    deps(),
    actor,
    {
      boardId,
      subjectIds: [subjectId],
      title: 'Retained title',
      body: fromPlainText('Retained opening'),
      licence: 'MIT',
      visibility: 'published',
    },
    context(),
  );
  const reply = await createPost(
    deps(),
    actor,
    { threadId: created.value.threadId, body: fromPlainText('Retained reply'), licence: 'MIT' },
    context(),
  );
  for (const outcome of [created, reply]) {
    for (const event of await outbox(outcome)) {
      await createAuthorItemEffect(f.pool).run(event);
      await createBoardEffect(f.pool).run(event);
      await createSubjectThreadEffect(f.pool).run(event);
    }
  }
  return { ...created.value, postId: reply.value.itemId, subjectId, boardId };
}

async function listed(value: Awaited<ReturnType<typeof fixture>>, kind: 'thread' | 'post', visible: boolean) {
  const expected = visible
    ? expect.arrayContaining([kind === 'thread' ? value.threadId : value.postId])
    : expect.not.arrayContaining([kind === 'thread' ? value.threadId : value.postId]);
  const authorPage =
    kind === 'thread'
      ? await listAuthorThreads(deps(), actor.accountId, reader())
      : await listAuthorPosts(deps(), actor.accountId, reader());
  expect(authorPage.entries.map((entry) => entry.id)).toEqual(expected);
  if (kind === 'post') return;
  const threadExpected = visible
    ? expect.arrayContaining([value.threadId])
    : expect.not.arrayContaining([value.threadId]);
  expect((await listBoardThreads(deps(), value.boardId, reader())).entries.map((entry) => entry.id)).toEqual(
    threadExpected,
  );
  expect(
    (
      await listSubjectThreads(deps(), value.subjectId, reader(), { place: GLOBAL_CONTEXT, kind: 'discussion' })
    ).entries.map((entry) => entry.id),
  ).toEqual(threadExpected);
  const sitemap = { ...deps(), access: sitemapAccess };
  expect((await listSitemapThreads(sitemap, Date.now() + 30000)).items.map((entry) => entry.id)).toEqual(
    threadExpected,
  );
  expect((await listSitemapBoards(sitemap, Date.now() + 30000)).items.map((entry) => entry.id)).toEqual(
    visible ? expect.arrayContaining([value.boardId]) : expect.not.arrayContaining([value.boardId]),
  );
}

test('lifting a thread or post takedown makes it readable again with its data intact, raises its security revision and emits one restored event', async () => {
  for (const kind of ['thread', 'post'] as const) {
    const value = await fixture();
    const id = kind === 'thread' ? value.threadId : value.postId;
    const target = { kind, id };
    const before = await stored(kind, id);
    const original =
      kind === 'thread'
        ? (await readThread(deps(), id, reader())).value
        : (await readPost(deps(), value.threadId, id, reader())).value;
    expect(original).not.toBeNull();
    if (!original) throw new Error('Expected a readable fixture');
    await listed(value, kind, true);
    await f.grant(actor.accountId, 'moderation:takedown', { route: routeOf(id)!, id });
    await takedown(deps(), actor, { target, reason: 'Reversible decision' }, context());
    await f.reader.query(
      `UPDATE content.${kind} SET security_revision=9007199254740993 WHERE route=$1 AND ${kind}_id=$2`,
      [routeOf(id), id],
    );
    expect((await readPost(deps(), value.threadId, value.postId, reader())).value).toBeNull();
    await listed(value, kind, false);
    const restore = () =>
      runCommand(
        f.pool,
        {
          partition: partitionOf(routeOf(id)!),
          receipt: {
            actorAccountId: actor.accountId,
            kind: 'content.fixture.restore',
            key: crypto.randomUUID(),
            digest: new Uint8Array(32),
          },
        },
        async (client) => {
          const events: CommandEvent[] = [];
          expect(await liftTakedown(client, { target }, { events })).toEqual({
            targetId: id,
            securityRevision: '9007199254740994',
          });
          expect(await liftTakedown(client, { target }, { events })).toBeNull();
          return { value: null, events };
        },
      );
    // A caller failure must roll the row and event back together.
    await expect(
      runCommand(f.pool, { partition: partitionOf(routeOf(id)!) }, async (client) => {
        await liftTakedown(client, { target }, { events: [] });
        throw new Error('Appeal aborted');
      }),
    ).rejects.toThrow('Appeal aborted');
    expect((await stored(kind, id)).visibility).toBe('taken_down');
    const outcome = await restore();
    const events = await outbox(outcome);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'com.rezics.content.moderation.restored.v1',
      subject: id,
      data: { targetKind: kind, targetId: id, securityRevision: '9007199254740994' },
    });
    expect(Value.Check(CONTENT_EVENTS[events[0]!.type as keyof typeof CONTENT_EVENTS], events[0]!.data)).toBe(true);
    for (const invalid of [
      { ...(events[0]!.data as object), targetKind: 'board' },
      { ...(events[0]!.data as object), body: 'Retained bytes' },
      { ...(events[0]!.data as object), securityRevision: 2 },
    ]) {
      expect(Value.Check(CONTENT_EVENTS['com.rezics.content.moderation.restored.v1'], invalid)).toBe(false);
    }
    expect(await stored(kind, id)).toEqual({ ...before, security_revision: '9007199254740994' });
    const restored =
      kind === 'thread'
        ? (await readThread(deps(), id, reader())).value
        : (await readPost(deps(), value.threadId, id, reader())).value;
    expect(restored).toEqual({ ...original, securityRevision: '9007199254740994' });
    await listed(value, kind, true);
  }
});

test('lifting a target that is not taken down changes nothing and emits nothing', async () => {
  const value = await fixture();
  for (const kind of ['thread', 'post'] as const) {
    const id = kind === 'thread' ? value.threadId : value.postId;
    for (const visibility of ['published', 'draft', 'protected']) {
      await f.reader.query(
        `UPDATE content.${kind} SET visibility=$3, security_revision=security_revision+1 WHERE route=$1 AND ${kind}_id=$2`,
        [routeOf(id), id, visibility],
      );
      const before = await stored(kind, id);
      const count = (await f.reader.query('SELECT count(*) FROM core.outbox')).rows[0];
      const client = await f.reader.connect();
      const events: CommandEvent[] = [];
      try {
        await client.query('BEGIN');
        expect(await liftTakedown(client, { target: { kind, id } }, { events })).toBeNull();
        expect(await liftTakedown(client, { target: { kind, id: newId(routeOf(id)!) } }, { events })).toBeNull();
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      expect(events).toEqual([]);
      expect(await stored(kind, id)).toEqual(before);
      expect((await f.reader.query('SELECT count(*) FROM core.outbox')).rows[0]).toEqual(count);
    }
  }
});
