import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { eraseAccountAuthoredPage, type AuthoredErasureCursor } from '../../src/content/account-erasure-authored.ts';
import { createAuthorItemEffect } from '../../src/content/author-item-index.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { accountDeletionRuntime, deletePersona, drainEffects } from '../support/account-deletion.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from './support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from './support/disclosure-fixtures.ts';

let system: NativeContentSystem;
let worker: ChildProcessWithoutNullStreams;
let growth: GrowthDatabase;
let output = '';
let boardId: string;
let published: Thread;
let draft: Thread;
let deleted: Thread;
let takenDown: Thread;
let longHistory: Thread;
const neighbours: string[] = [];
const moderatorReplies: string[] = [];
type Thread = { id: string; firstPost: { id: string; revisionId: string } };
type ActorName = 'author' | 'other' | 'moderator';

async function http<T>(actor: ActorName, method: string, path: string, body?: unknown, head?: string): Promise<T> {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${system.actors[actor].bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(head ? { 'if-match': JSON.stringify(head) } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const wire = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${wire}`);
  return (wire ? JSON.parse(wire) : undefined) as T;
}
async function grant(actor: ActorName, id: string, actions: string[]) {
  // Seed delegation authority separately from the recipient's real HTTP grant.
  // A self-grant would overlap the grantor's setup rows.
  const grantor = actor === 'other' ? 'author' : 'other';
  await seedGovernanceAuthority(system.database.pool, routeOf(id)!, id, system.actors[grantor].actor.accountId, [
    'access:grant',
    ...actions,
  ]);
  await http(grantor, 'POST', '/v1/grants', {
    resource: { route: routeOf(id), id },
    subject: { kind: 'account', id: system.actors[actor].actor.accountId },
    actions,
    valid: '(,)',
  });
}
async function thread(actor: ActorName, visibility: 'published' | 'draft' = 'published') {
  return (
    await http<{ thread: Thread }>(actor, 'POST', '/v1/threads', {
      title: `${actor} ${visibility} opening`,
      body: fromPlainText('Opening body'),
      licence: 'CC0-1.0',
      subjectIds: [],
      boardId,
      visibility,
    })
  ).thread;
}
async function revise(actor: ActorName, post: { id: string; revisionId: string }) {
  const result = await http<{ post: { id: string; revisionId: string } }>(
    actor,
    'POST',
    `/v1/posts/${post.id}/revisions`,
    { body: fromPlainText(`Revision ${crypto.randomUUID()}`), licence: 'CC0-1.0', subjectIds: [] },
    post.revisionId,
  );
  post.revisionId = result.post.revisionId;
}
async function drainAuthorItems() {
  const pool = system.database.pool;
  const expected = [
    {
      accountId: system.actors.author.actor.accountId,
      threadIds: [published.id, draft.id, deleted.id, takenDown.id],
      postIds: [published.firstPost.id, draft.firstPost.id, takenDown.firstPost.id],
    },
    {
      accountId: system.actors.other.actor.accountId,
      threadIds: [longHistory.id],
      postIds: [longHistory.firstPost.id, ...neighbours],
    },
    {
      accountId: system.actors.moderator.actor.accountId,
      threadIds: [],
      postIds: moderatorReplies,
    },
  ];
  const sourcePartitions = new Set(
    expected.flatMap(({ threadIds, postIds }) => [...threadIds, ...postIds]).map((id) => partitionOf(routeOf(id)!)),
  );
  const sourceThreadIds = expected.flatMap(({ threadIds }) => threadIds);
  const sourcePostIds = [...expected.flatMap(({ postIds }) => postIds), deleted.firstPost.id];
  for (const partition of sourcePartitions) await drainEffects(pool, partition);

  const source = await pool.query<{
    partition_no: number;
    epoch: number;
    position: string;
    id: string;
    type: string;
    subject: string | null;
    data: unknown;
    recorded_at: Date;
  }>(
    `SELECT partition_no,epoch,position::text,id::text,type,subject,data,recorded_at FROM core.outbox
       WHERE (type='com.rezics.content.thread.created.v1' AND data->>'threadId'=ANY($1::text[]))
        OR (type='com.rezics.content.post.created.v1' AND data->>'itemId'=ANY($2::text[]))
        OR (type='com.rezics.content.post.erased.v1' AND data->>'postId'=ANY($2::text[]))
     ORDER BY partition_no,position,event_seq`,
    [sourceThreadIds, sourcePostIds],
  );
  const effect = createAuthorItemEffect(pool);
  for (const row of source.rows) {
    const event: CloudEvent = {
      specversion: '1.0',
      id: row.id,
      source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
      type: row.type,
      ...(row.subject === null ? {} : { subject: row.subject }),
      time: row.recorded_at.toISOString(),
      datacontenttype: 'application/json',
      sequence: BigInt(row.position).toString().padStart(19, '0'),
      data: row.data,
    };
    await effect.run(event);
  }
  for (const items of expected) {
    const wanted = [
      ...items.threadIds.map((id) => ({ kind: 'thread', id })),
      ...items.postIds.map((id) => ({ kind: 'post', id })),
    ];
    if (!wanted.length) continue;
    const { rows } = await pool.query<{ item_kind: string; item_id: string }>(
      `SELECT item_kind,item_id::text FROM content.author_item AS indexed
       WHERE route=$1 AND author_account_id=$2
         AND (item_kind,item_id) IN (SELECT * FROM unnest($3::text[],$4::uuid[]))`,
      [routeOf(items.accountId), items.accountId, wanted.map((item) => item.kind), wanted.map((item) => item.id)],
    );
    if (rows.length !== wanted.length) {
      const present = new Set(rows.map((row) => `${row.item_kind}:${row.item_id}`));
      const missing = wanted.filter((item) => !present.has(`${item.kind}:${item.id}`));
      throw new Error(
        `Content author-item projections are incomplete for ${items.accountId}; ` +
          `missing ${JSON.stringify(missing)}; source events ${source.rows.length}; worker ${output}`,
      );
    }
  }
}

async function drainErasedPosts(postIds: string[]) {
  const routes = postIds.map((id) => routeOf(id)!);
  const erased = await system.database.pool.query<{
    id: string;
    partition_no: number;
    post_id: string;
    account_erasure: boolean;
  }>(
    `SELECT id::text,partition_no,data->>'postId' AS post_id,
            COALESCE((data->>'accountErasure')::boolean,false) AS account_erasure
     FROM core.outbox
     WHERE type='com.rezics.content.post.erased.v1' AND data->>'postId'=ANY($1::text[])`,
    [postIds],
  );
  const missingTerminalEvents = postIds.filter(
    (postId) => !erased.rows.some((event) => event.post_id === postId && event.account_erasure),
  );
  if (missingTerminalEvents.length)
    throw new Error(
      `Content terminal post-erasure events are missing for ${missingTerminalEvents.join(', ')}: ${output}`,
    );
  for (const partition of new Set(erased.rows.map((event) => event.partition_no)))
    await drainEffects(system.database.pool, partition);
  const workflows = erased.rows.map((event) => `content.erasePost:${event.id}`);
  const url = system.database.pool.options.connectionString;
  if (!url) throw new Error('Native database URL is missing');
  const work = await createWorkClient(url);
  try {
    await Promise.all(workflows.map((workflow) => work.retrieveWorkflow(workflow).getResult()));
  } finally {
    await work.close();
  }
  const { rows } = await system.database.pool.query<{ done: boolean }>(
    `WITH expected(route,post_id) AS (SELECT * FROM unnest($1::integer[],$2::uuid[]))
     SELECT NOT EXISTS (
       SELECT 1 FROM expected e LEFT JOIN content.post p USING(route,post_id)
       WHERE p.post_id IS NULL OR p.availability <> 'erased' OR EXISTS (
         SELECT 1 FROM content.revision r
         WHERE r.route=e.route AND r.post_id=e.post_id AND r.availability <> 'erased'
       )
     ) AS done`,
    [routes, postIds],
  );
  if (!rows[0]?.done)
    throw new Error(`Content erased-post workflows returned before physical cleanup: ${postIds.join(', ')}: ${output}`);
}
async function erase(actor: ActorName) {
  const runtime = accountDeletionRuntime(system);
  await deletePersona(
    { version: 1, pool: system.database.pool, auth: runtime.auth },
    {
      accountId: system.actors[actor].actor.accountId,
      bearer: system.actors[actor].bearer,
    },
  );
  await drainEffects(system.database.pool, partitionOf(routeOf(system.actors[actor].actor.accountId)!));
}
async function snapshot(ids: string[]) {
  return (
    await system.database.pool.query(
      `SELECT p.post_id::text,p.availability,p.head_revision_id::text,p.author_account_id::text,
      r.revision_id::text,r.availability AS revision_availability,r.body,r.body_sha256,r.search_text
     FROM content.post p JOIN content.revision r ON r.route=p.route AND r.post_id=p.post_id
     WHERE p.post_id=ANY($1::uuid[]) ORDER BY p.post_id,r.recorded_at,r.revision_id`,
      [ids],
    )
  ).rows;
}
async function finish(accountId: string, cursor: AuthoredErasureCursor | null = null) {
  let pages = 0;
  do {
    const page = await eraseAccountAuthoredPage({ pool: growth.pool }, accountId, cursor);
    expect(page.found).toBeLessThanOrEqual(150);
    cursor = page.next;
    if (++pages > 20) throw new Error('Authored erasure cursor did not finish');
  } while (cursor);
  expect(
    (
      await growth.admin.query('SELECT 1 FROM content.author_item WHERE route=$1 AND author_account_id=$2', [
        routeOf(accountId),
        accountId,
      ])
    ).rows,
  ).toEqual([]);
}

beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    HIGH_RATE_OVERRIDES,
  );
  const pool = system.database.pool;
  // The board uses only these shipped SKOS definitions. Keep its setup independent
  // of unrelated catalogue properties, including wildcard quantity units.
  await bootstrapRelease(pool, {
    ...bundledRelease,
    types: {
      'skos:Concept': { ...bundledRelease.types['skos:Concept']!, properties: ['skos:inScheme'] },
      'skos:ConceptScheme': { ...bundledRelease.types['skos:ConceptScheme']!, properties: [] },
    },
    properties: { 'skos:inScheme': bundledRelease.properties['skos:inScheme']! },
    contexts: {},
    filters: {},
    libraryProfiles: {},
  });
  const url = pool.options.connectionString!;
  growth = await openGrowthDatabase(url);
  growth.pool.options.max = 1; // Every cross-partition checkout must be released.
  worker = spawn(
    process.execPath,
    ['run', new URL('./support/disclosure-fixtures.ts', import.meta.url).pathname, '--disclosure-worker'],
    {
      env: {
        ...process.env,
        DATABASE_URL: url,
        CONTENT_TEST_STORAGE: 'http://127.0.0.1:1',
        CONTENT_TEST_ROUTE_KEY: Buffer.from(system.routeKey).toString('base64url'),
        CONTENT_TEST_DISABLE_ERASURE_PARTICIPANT: 'true',
      },
      stdio: 'pipe',
    },
  );
  worker.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: worker.stdout });
    lines.on('line', (line) => {
      output += line + '\n';
      if (line === 'ready') resolve();
    });
    worker.once('exit', (code) => reject(new Error(`Worker exited ${code}: ${output}`)));
  });
  await ready;
  const { space } = await http<{ space: { spaceId: string } }>('other', 'POST', '/v1/spaces', {
    title: 'Erasure space',
    summary: '',
  });
  const { realm } = await http<{ realm: { realmId: string; headRevisionId: string } }>('other', 'POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Erasure realm',
    summary: '',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  const { subject: scheme } = await http<{ subject: { id: string } }>('other', 'POST', '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Erasure scheme' },
  });
  const { subject: concept } = await http<{ subject: { id: string } }>('other', 'POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Erasure board' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
    },
  });
  await http('other', 'PUT', `/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme.id }, realm.headRevisionId);
  const { board } = await http<{ board: { id: string } }>('other', 'POST', `/v1/realms/${realm.realmId}/boards`, {
    conceptId: concept.id,
    title: 'Erasure board',
    visibility: 'published',
  });
  boardId = board.id;
  for (const actor of ['author', 'moderator'] as const) await grant(actor, boardId, ['thread:create']);
  published = await thread('author');
  await revise('author', published.firstPost);
  await revise('author', published.firstPost);
  draft = await thread('author', 'draft');
  deleted = await thread('author');
  takenDown = await thread('author');
  for (const target of [published, draft, deleted, takenDown]) {
    // Draft threads are intentionally undiscoverable to other accounts, so
    // the HTTP contract cannot create a neighbouring author's reply there.
    if (target === draft) continue;
    await grant('other', target.id, ['post:create', 'thread:read']);
    const { post } = await http<{ post: { id: string } }>('other', 'POST', `/v1/threads/${target.id}/posts`, {
      body: fromPlainText('Other author survives'),
      licence: 'CC0-1.0',
      subjectIds: [],
      parentId: target.firstPost.id,
    });
    neighbours.push(post.id);
  }
  await http('author', 'DELETE', `/v1/posts/${deleted.firstPost.id}`);
  await grant('moderator', takenDown.firstPost.id, ['moderation:takedown']);
  await http('moderator', 'POST', `/v1/posts/${takenDown.firstPost.id}:takeDown`, {
    reason: 'Account erasure fixture',
  });
  longHistory = await thread('other');
  for (let i = 0; i < 102; i++) await revise('other', longHistory.firstPost);
  await grant('moderator', longHistory.id, ['post:create']);
  // Exactly one bounded page of moderator-authored replies is enough for the
  // growth operation; unrelated volume is seeded at each measured scale.
  for (let i = 0; i < 50; i++) {
    const { post } = await http<{ post: { id: string } }>('moderator', 'POST', `/v1/threads/${longHistory.id}/posts`, {
      body: fromPlainText('Growth target'),
      licence: 'CC0-1.0',
      subjectIds: [],
      parentId: longHistory.firstPost.id,
    });
    moderatorReplies.push(post.id);
  }
  await drainAuthorItems();
}, 360000);

afterAll(async () => {
  if (worker && worker.exitCode === null) {
    const exited = once(worker, 'exit');
    worker.stdin.end('stop\n');
    await exited;
  }
  await growth?.close();
  await system?.close();
}, 60000);

test("account erasure keeps a published post with only its current revision and erases the account's draft, deleted and taken-down posts", async () => {
  const before = await snapshot(neighbours);
  // Ordinary published history remains immutable before the committed obligation.
  const old = (await snapshot([published.firstPost.id])).find((r) => r.revision_id !== published.firstPost.revisionId)!;
  await expect(
    growth.admin.query(
      "UPDATE content.revision SET body=NULL,body_sha256=NULL,search_text=NULL,availability='erased' WHERE route=$1 AND revision_id=$2",
      [routeOf(published.id), old.revision_id],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await erase('author');
  await finish(system.actors.author.actor.accountId);
  await drainErasedPosts([draft.firstPost.id, deleted.firstPost.id, takenDown.firstPost.id]);
  const revisions = await snapshot([published.firstPost.id]);
  expect(revisions).toHaveLength(3);
  expect(revisions.filter((r) => r.revision_availability === 'available')).toMatchObject([
    {
      revision_id: published.firstPost.revisionId,
      head_revision_id: published.firstPost.revisionId,
      author_account_id: system.actors.author.actor.accountId,
      availability: 'available',
    },
  ]);
  for (const row of revisions.filter((r) => r.revision_id !== published.firstPost.revisionId))
    expect(row).toMatchObject({ body: null, body_sha256: null, search_text: null, revision_availability: 'erased' });
  for (const row of await snapshot([draft.firstPost.id, deleted.firstPost.id, takenDown.firstPost.id]))
    expect(row).toMatchObject({
      availability: 'erased',
      body: null,
      body_sha256: null,
      search_text: null,
      revision_availability: 'erased',
    });
  expect(await snapshot(neighbours)).toEqual(before);
  expect(
    (
      await system.database.pool.query('SELECT title FROM content.thread WHERE thread_id=ANY($1::uuid[])', [
        [draft.id, deleted.id, takenDown.id],
      ])
    ).rows,
  ).toHaveLength(3);
  expect(
    (
      await system.database.pool.query('SELECT title FROM content.thread WHERE thread_id=ANY($1::uuid[])', [
        [draft.id, deleted.id, takenDown.id],
      ])
    ).rows.every((row) => row.title === null),
  ).toBe(true);
  // Retention authority must never permit clearing the retained head.
  await expect(
    growth.admin.query(
      "UPDATE content.revision SET body=NULL,body_sha256=NULL,search_text=NULL,availability='erased' WHERE route=$1 AND revision_id=$2",
      [routeOf(published.id), published.firstPost.revisionId],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  const read = await http<{ post: { authorId: string; revisionId: string } }>(
    'moderator',
    'GET',
    `/v1/posts/${published.firstPost.id}`,
  );
  expect(read.post).toMatchObject({
    authorId: system.actors.author.actor.accountId,
    revisionId: published.firstPost.revisionId,
  });
}, 120000);

test("an account erasure page touches only the account's authored items and repeating it changes nothing", async () => {
  await erase('other');
  const foreign = await snapshot([published.firstPost.id]);
  const accountId = system.actors.other.actor.accountId;
  const first = await eraseAccountAuthoredPage({ pool: growth.pool }, accountId, null);
  expect(first.next?.revisionAfter).toBeDefined();
  expect(first.found).toBeLessThanOrEqual(150);
  const before = await snapshot([longHistory.firstPost.id, ...neighbours]);
  expect(
    before.filter((r) => r.post_id === longHistory.firstPost.id && r.revision_availability === 'erased'),
  ).toHaveLength(100);
  const position = (
    await growth.admin.query('SELECT partition_no,position::text FROM core.partition ORDER BY partition_no')
  ).rows;
  expect(await eraseAccountAuthoredPage({ pool: growth.pool }, accountId, null)).toEqual(first);
  expect(await snapshot([longHistory.firstPost.id, ...neighbours])).toEqual(before);
  expect(
    (await growth.admin.query('SELECT partition_no,position::text FROM core.partition ORDER BY partition_no')).rows,
  ).toEqual(position);
  await finish(accountId, first.next);
  expect(await snapshot([published.firstPost.id])).toEqual(foreign);
  expect(
    (await snapshot([longHistory.firstPost.id])).filter((r) => r.revision_availability === 'available'),
  ).toHaveLength(1);
}, 120000);

test("an account erasure page stays within its bound as other authors' items grow", async () => {
  await erase('moderator');
  const accountId = system.actors.moderator.actor.accountId;
  const authorRoute = routeOf(accountId)!;
  const itemRoute = routeOf(longHistory.id)!;
  let cursor: AuthoredErasureCursor | null = null;
  const page = async () => {
    const result = await eraseAccountAuthoredPage({ pool: growth.pool }, accountId, cursor);
    expect(result.found).toBe(50);
    cursor = result.next;
  };
  const seedAccountItems = async (db: GrowthDatabase) => {
    await db.admin.query(
      `INSERT INTO content.author_item(route,author_account_id,item_kind,item_id,thread_id,thread_kind,created_at,source_epoch,source_position)
       SELECT $1,$2,'post',p.post_id,p.thread_id,t.kind,p.created_at,1,1
       FROM content.post p JOIN content.thread t ON t.route=p.route AND t.thread_id=p.thread_id
       WHERE p.route=$1 AND p.author_account_id=$2 AND p.post_id=ANY($3::uuid[])
       ON CONFLICT DO NOTHING`,
      [authorRoute, accountId, moderatorReplies],
    );
  };
  const report = await checkGrowth(growth, {
    name: "an account erasure page stays within its bound as other authors' items grow",
    rule: 'series',
    scales: [256, 1024, 4096],
    warmups: 1,
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(db, scale, previous) {
      cursor = null;
      await seedAccountItems(db);
      const ids = Array.from({ length: scale - previous }, () => newId(itemRoute));
      const others = ids.map(() => newId(authorRoute));
      // Native same-thread reply shape, with unrelated authors in both hot partitions.
      const client = await db.admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
        SELECT $1,$2,id,author,id,'published',1,id FROM unnest($3::uuid[],$4::uuid[]) AS x(id,author)`,
          [itemRoute, longHistory.id, ids, others],
        );
        await client.query(
          `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
        SELECT $1,$2,id,id,r.body,r.body_sha256,r.search_text,r.licence,r.subject_ids,r.board_id,'available',id
        FROM unnest($3::uuid[]) AS x(id) CROSS JOIN content.revision r WHERE r.route=$1 AND r.revision_id=$4`,
          [itemRoute, longHistory.id, ids, longHistory.firstPost.revisionId],
        );
        await client.query(
          `INSERT INTO content.author_item(route,author_account_id,item_kind,item_id,thread_id,thread_kind,created_at,source_epoch,source_position)
        SELECT $1,author,'post',id,$2,'discussion',clock_timestamp(),1,1 FROM unnest($3::uuid[],$4::uuid[]) AS x(id,author)`,
          [authorRoute, longHistory.id, ids, others],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    warmup: page,
    operation: page,
    async prepare(db) {
      cursor = null;
      await seedAccountItems(db);
    },
  });
  expect(report.samples.map((s) => s.scale)).toEqual([256, 1024, 4096]);
  await finish(accountId, cursor);
}, 120000);
