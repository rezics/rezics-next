import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText, normalizeDocument } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { Pool } from 'pg';
import { notificationAllowed } from '../../src/access/index.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createContentWorkAccess, contentWorkDependencies } from '../../src/content/register.ts';
import { createContentWork } from '../../src/content/work.ts';
import { createAccountErasureEffect } from '../../src/content/account-erasure.ts';
import { contentEffects, contentNoticeEffects } from '../../src/content/relays.ts';
import { postReadableByAccount } from '../../src/content/reads.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { eraseAccountNoticesPage } from '../../src/content/notices.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { effectsRelay } from '../../src/events/effects.ts';
import { startRelays } from '../../src/events/relays.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona, drainEffects } from '../support/account-deletion.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createPersonas } from '../support/personas.ts';
import { testKernel, testRouteKey } from '../support/test-kernel.ts';
import { observeSql } from './support/sql-observer.ts';

let db: GrowthDatabase;
let pagePool: Pool;
let workPool: Pool;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let people: Awaited<ReturnType<typeof createPersonas>>;
let kernel: ReturnType<typeof testKernel>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let work: Awaited<ReturnType<typeof composeWork>>;
let relays: ReturnType<typeof startRelays>;
let workAccess: ReturnType<typeof createContentWorkAccess>;
let noticeEffects: ReturnType<typeof contentNoticeEffects>;
beforeAll(async () => {
  db = await openGrowthDatabase();
  pagePool = new Pool({ connectionString: db.url, max: 1 });
  auth = await nativeFixture(db.pool);
  const service = auth.host.service;
  workPool = db.openPool({ max: 10 });
  client = await createWorkClient(db.url, workPool);
  kernel = testKernel({
    pool: db.pool,
    workClient: client,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'account-notice-erasure-native-test-secret' }),
  });
  people = await createPersonas(kernel, { version: 1, pool: db.pool, auth });
  await bootstrapRelease(db.pool, bundledRelease);
  // The same production Access instance is used for direct delivery before Auth
  // hands the DBOS SDK to Content, and for the registered Content worker effects.
  workAccess = createContentWorkAccess(() => new Date(), workPool);
  noticeEffects = contentNoticeEffects(workPool, workAccess);
}, 360000);

async function startContentWork(options: { relays?: boolean } = {}) {
  // Account deletion finishes with Auth's executor. Content then owns the SDK;
  // its consent reader and the HTTP verifier keep using the open Auth database.
  await auth.host.workflows.close();
  const { readCurrentConsent } = createCurrentConsentReader({ database: auth.authPool });
  work = await composeWork(
    [
      {
        name: 'content',
        async register(context) {
          await createContentWork({
            storage: contentWorkDependencies({}, fetch).storage,
            access: workAccess,
            readConsent: (input) =>
              readCurrentConsent({ actorAccountId: input.actorAccountId, clientId: input.clientId }),
            routeKey: testRouteKey(),
            fetchConfig: { allowedHosts: [] },
            collectionPartitions: [0],
          }).register(context);
          context.addEffects([
            ...contentEffects(context.pool, context.client),
            ...contentNoticeEffects(context.pool, workAccess),
          ]);
        },
      },
    ],
    { databaseUrl: db.url, pool: workPool, client },
  );
  await work.launch();
  if (options.relays ?? true) {
    relays = startRelays(workPool, [effectsRelay(workPool, work.effects)], { intervalMs: 5 });
  }
}

async function grant(accountId: string, action: string, resourceId: string): Promise<void> {
  await db.admin.query(
    `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)',$2) ON CONFLICT DO NOTHING`,
    [routeOf(resourceId), resourceId, accountId, action],
  );
}

function mentionBody(accountIds: readonly string[]) {
  return normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'text',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'notice-mentions' },
          content: accountIds.map((accountId) => ({ type: 'mention', attrs: { accountId } })),
        },
      ],
    },
  });
}

async function postCreatedEvent(postId: string): Promise<CloudEvent> {
  const { rows } = await db.admin.query<{
    id: string;
    partition_no: number;
    epoch: number;
    type: string;
    recorded_at: Date;
    position: string;
    subject: string;
    data: unknown;
  }>(
    `SELECT id::text,partition_no,epoch,type,recorded_at,position::text,subject::text,data
     FROM core.outbox WHERE type='com.rezics.content.post.created.v1' AND data->>'itemId'=$1`,
    [postId],
  );
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  return {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: row.type,
    subject: row.subject,
    time: new Date(row.recorded_at).toISOString(),
    datacontenttype: 'application/json',
    sequence: row.position.padStart(19, '0'),
    data: row.data,
  };
}

async function accountTombstoneEvent(accountId: string): Promise<CloudEvent> {
  const { rows } = await db.admin.query<{
    partition_no: number;
    position: string;
    epoch: number;
    id: string;
    type: string;
    subject: string;
    data: unknown;
    recorded_at: Date;
  }>(
    `SELECT partition_no,position::text,epoch,id::text,type,subject::text,data,recorded_at
     FROM core.outbox
     WHERE type='com.rezics.access.account-tombstoned.v1' AND data->>'accountId'=$1
     ORDER BY position DESC,event_seq LIMIT 1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) throw new Error(`Missing native account tombstone for ${accountId}`);
  return {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: row.type,
    subject: row.subject,
    time: new Date(row.recorded_at).toISOString(),
    datacontenttype: 'application/json',
    sequence: BigInt(row.position).toString().padStart(19, '0'),
    data: row.data,
  };
}

type ErasureWorkerSubject = { accountId: string; bearer: string; scale: number; event: CloudEvent };

async function waitForErasureWorker(accountId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const status = await readErasureStatus(db.admin, accountId);
    const progress = await db.admin.query<{ phase: string; step: string }>(
      'SELECT phase,step::text FROM content.account_erasure_progress WHERE route=$1 AND account_id=$2',
      [routeOf(accountId), accountId],
    );
    const current = progress.rows[0];
    if (status?.participants.content?.outcome === 'erased' && current?.phase === 'complete') {
      expect(status.participants.delivery?.outcome).toBe('none');
      const workflowId = `content-account-erasure:${accountId}:proof:${Number(current.step) - 1}`;
      const workflow = await db.admin.query<{ status: string }>(
        'SELECT status FROM dbos.workflow_status WHERE workflow_uuid=$1',
        [workflowId],
      );
      if (workflow.rows[0]?.status === 'SUCCESS') return;
    }
    if (Date.now() >= deadline) throw new Error(`Native account-erasure worker did not finish for ${accountId}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function measureAccountErasureWorker(subjects: readonly ErasureWorkerSubject[], threadId: string) {
  const scales = [64, 256, 1024] as const;
  const itemRoute = routeOf(threadId);
  if (itemRoute === null) throw new TypeError('Account-erasure worker fixture thread has no route');
  const byScale = new Map<number, ErasureWorkerSubject[]>();
  for (const subject of subjects) byScale.set(subject.scale, [...(byScale.get(subject.scale) ?? []), subject]);
  const effect = createAccountErasureEffect({ client });
  const run = async (subject: ErasureWorkerSubject) => {
    await effect.run(subject.event);
    await waitForErasureWorker(subject.accountId);
    return subject.accountId;
  };
  const report = await checkGrowth(db, {
    name: 'Complete native account-erasure worker',
    scales,
    bounds: { rows: 'linear', blocks: 'linear', statements: 'linear' },
    repetitions: 1,
    warmups: 1,
    async grow(growthDb, scale) {
      const ids = Array.from({ length: scale }, () => newId(itemRoute));
      for (const subject of byScale.get(scale) ?? []) {
        const authorRoute = routeOf(subject.accountId);
        if (authorRoute === null) throw new TypeError('Account-erasure worker fixture account has no route');
        await growthDb.admin.query(
          `INSERT INTO content.author_item
             (route,author_account_id,item_kind,item_id,thread_id,thread_kind,created_at,source_epoch,source_position)
           SELECT $1,$2,'post',row.item_id,$3,'discussion',clock_timestamp(),1,1
           FROM unnest($4::uuid[]) AS row(item_id)`,
          [authorRoute, subject.accountId, threadId, ids],
        );
      }
    },
    async warmup(_growthDb, scale) {
      const warmup = byScale.get(scale)?.[0];
      if (!warmup) throw new Error(`Missing account-erasure worker warmup at scale ${scale}`);
      await run(warmup);
    },
    async operation(_growthDb, scale) {
      const operation = byScale.get(scale)?.[1];
      if (!operation) throw new Error(`Missing account-erasure worker sample at scale ${scale}`);
      return run(operation);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
  for (const subject of subjects) {
    expect(
      (
        await db.admin.query('SELECT 1 FROM content.author_item WHERE route=$1 AND author_account_id=$2', [
          routeOf(subject.accountId),
          subject.accountId,
        ])
      ).rows,
    ).toHaveLength(0);
  }
  console.info(JSON.stringify(report));
}

async function deliverNoticeEffects(postId: string): Promise<void> {
  const event = await postCreatedEvent(postId);
  for (const effect of noticeEffects) if (effect.types.includes(event.type)) await effect.run(event);
}

async function requestKernel<T>(
  path: string,
  body: unknown,
  persona: { accountId: string; bearer: string },
  idempotencyKey = JSON.stringify(crypto.randomUUID()),
): Promise<T> {
  const response = await kernel.handle(
    new Request(`https://ordinary.api.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${persona.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
    }),
  );
  const value = await response.json();
  if (!response.ok) throw new Error(`Kernel request ${path} failed: ${response.status} ${JSON.stringify(value)}`);
  return value as T;
}
afterAll(async () => {
  await relays?.stop();
  await work?.shutdown();
  await client?.close();
  await pagePool?.end();
  await auth?.close();
  await db?.close();
});

test("account notice erasure deletes the account's inbox and seen marker in bounded pages and leaves other recipients' notices", async () => {
  const account = people.alice;
  const other = people.orgOwner;
  const replyActors = [people.bob, people.staff, people.orgOwner, people.operator, people.delegated];
  const route = routeOf(account.accountId)!;
  const otherRoute = routeOf(other.accountId)!;

  // Build the board as ordinary native content data, then create every thread and
  // post through the HTTP API so notice sources use real returned identities.
  const boardRoute = 0x1234;
  const boardId = newId(boardRoute);
  await db.admin.query(
    `INSERT INTO content.board (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Account notice erasure','published',1,$2)`,
    [boardRoute, boardId, newId(boardRoute)],
  );
  for (const person of [account, ...replyActors, people.staff]) await grant(person.accountId, 'board:read', boardId);
  await grant(account.accountId, 'thread:create', boardId);
  await grant(people.staff.accountId, 'thread:create', boardId);

  const createThread = async (
    persona: { accountId: string; bearer: string },
    title: string,
    selectedBoardId = boardId,
    idempotencyKey?: string,
  ) => {
    const value = await requestKernel<{ thread: { id: string; firstPost: { id: string } } }>(
      '/v1/threads',
      {
        title,
        body: fromPlainText('Opening post'),
        licence: 'CC0-1.0',
        subjectIds: [],
        boardId: selectedBoardId,
        visibility: 'published',
      },
      persona,
      idempotencyKey,
    );
    return value.thread;
  };
  const createReply = async (
    threadId: string,
    persona: { accountId: string; bearer: string },
    body: ReturnType<typeof fromPlainText> | ReturnType<typeof mentionBody>,
  ) => {
    const value = await requestKernel<{ post: { id: string } }>(
      `/v1/threads/${threadId}/posts`,
      { body, licence: 'CC0-1.0', subjectIds: [] },
      persona,
    );
    return value.post;
  };

  const accountThread = await createThread(account, 'Account inbox replies');
  for (const persona of [account, ...replyActors]) {
    await grant(persona.accountId, 'thread:read', accountThread.id);
    await grant(persona.accountId, 'post:read', accountThread.firstPost.id);
  }
  for (const persona of replyActors) await grant(persona.accountId, 'post:create', accountThread.id);
  const replyPosts: string[] = [];
  for (let index = 0; index < 102; index++) {
    const persona = replyActors[index % replyActors.length]!;
    const post = await createReply(accountThread.id, persona, fromPlainText(`Reply ${index + 1}`));
    await grant(account.accountId, 'post:read', post.id);
    replyPosts.push(post.id);
    await deliverNoticeEffects(post.id);
  }

  // A separate genuine mention reaches both the erased account and another
  // recipient. A reply authored by the soon-to-be-erased account leaves its
  // identifier in the other recipient's inbox for the normal retention window.
  const mentionThreadIdempotencyKey = JSON.stringify(crypto.randomUUID());
  const mentionBoardRoute = 0x2345;
  const mentionBoardId = newId(mentionBoardRoute);
  await db.admin.query(
    `INSERT INTO content.board (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Mention notice board','published',1,$4)`,
    [mentionBoardRoute, mentionBoardId, newId(mentionBoardRoute), newId(mentionBoardRoute)],
  );
  for (const person of [account, other, people.staff, people.bob])
    await grant(person.accountId, 'board:read', mentionBoardId);
  await grant(people.staff.accountId, 'thread:create', mentionBoardId);
  const otherThread = await createThread(people.staff, 'Account mention', mentionBoardId, mentionThreadIdempotencyKey);
  expect(routeOf(otherThread.id)).not.toBe(mentionBoardRoute);
  for (const persona of [account, other, people.staff, people.bob]) {
    await grant(persona.accountId, 'thread:read', otherThread.id);
    await grant(persona.accountId, 'post:read', otherThread.firstPost.id);
  }
  await grant(people.bob.accountId, 'post:create', otherThread.id);
  await grant(account.accountId, 'post:create', otherThread.id);
  const mentionPost = await createReply(otherThread.id, people.bob, mentionBody([account.accountId, other.accountId]));
  await grant(account.accountId, 'post:read', mentionPost.id);
  await grant(other.accountId, 'post:read', mentionPost.id);
  await grant(people.staff.accountId, 'post:read', mentionPost.id);
  for (const recipient of [account, other]) {
    expect(await notificationAllowed(workPool, { recipient: recipient.accountId, kind: 'mention' })).toBe(true);
    expect(
      await postReadableByAccount(
        { pool: workPool, access: workAccess },
        recipient.accountId,
        otherThread.id,
        mentionPost.id,
        { deadline: Date.now() + 30000 },
      ),
    ).toBe(true);
  }
  const mentionEvent = await postCreatedEvent(mentionPost.id);
  const mentionData = mentionEvent.data as { actorId: string; itemId: string; revisionId: string; threadId: string };
  expect(mentionData).toMatchObject({
    actorId: people.bob.accountId,
    itemId: mentionPost.id,
    threadId: otherThread.id,
  });
  const mentionSource = await db.admin.query<{
    actor_id: string;
    thread_id: string;
    revision_id: string;
    visibility: string;
    availability: string;
    thread_visibility: string;
    thread_availability: string;
    first_post_author_id: string;
    board_id: string;
    body: Buffer;
  }>(
    `SELECT p.author_account_id::text AS actor_id,p.thread_id::text,r.revision_id::text,p.visibility,p.availability,
            t.visibility AS thread_visibility,t.availability AS thread_availability,
            opening.author_account_id::text AS first_post_author_id,t.board_id::text,r.body
     FROM content.post p JOIN content.thread t ON t.route=p.route AND t.thread_id=p.thread_id
     JOIN content.post opening ON opening.route=t.route AND opening.post_id=t.first_post_id
     JOIN content.revision r ON r.route=p.route AND r.thread_id=p.thread_id AND r.post_id=p.post_id
     WHERE p.route=$1 AND p.post_id=$2 AND r.revision_id=$3`,
    [routeOf(mentionPost.id), mentionPost.id, mentionData.revisionId],
  );
  expect(mentionSource.rows).toHaveLength(1);
  expect(mentionSource.rows[0]).toMatchObject({
    actor_id: people.bob.accountId,
    thread_id: otherThread.id,
    revision_id: mentionData.revisionId,
    visibility: 'published',
    availability: 'available',
    thread_visibility: 'published',
    thread_availability: 'available',
    first_post_author_id: people.staff.accountId,
    board_id: mentionBoardId,
  });
  const mentionBoard = await db.admin.query<{ board_id: string; visibility: string }>(
    'SELECT board_id::text,visibility FROM content.board WHERE route=$1 AND board_id=$2',
    [routeOf(mentionBoardId), mentionBoardId],
  );
  expect(mentionBoard.rows).toEqual([{ board_id: mentionBoardId, visibility: 'published' }]);
  expect(mentionSource.rows[0]!.body.toString()).toContain(account.accountId);
  expect(mentionSource.rows[0]!.body.toString()).toContain(other.accountId);
  for (const effect of noticeEffects) if (effect.types.includes(mentionEvent.type)) await effect.run(mentionEvent);
  const [accountMention, otherMention] = await Promise.all([
    db.admin.query(
      `SELECT recipient_id,actor_id,kind FROM content.notice
       WHERE route=$1 AND recipient_id=$2 AND source_id=$3 AND kind='mention'`,
      [route, account.accountId, mentionPost.id],
    ),
    db.admin.query(
      `SELECT recipient_id,actor_id,kind FROM content.notice
       WHERE route=$1 AND recipient_id=$2 AND source_id=$3 AND kind='mention'`,
      [otherRoute, other.accountId, mentionPost.id],
    ),
  ]);
  expect([...accountMention.rows, ...otherMention.rows]).toEqual([
    { recipient_id: account.accountId, actor_id: people.bob.accountId, kind: 'mention' },
    { recipient_id: other.accountId, actor_id: people.bob.accountId, kind: 'mention' },
  ]);
  const replayBefore = await db.admin.query(
    'SELECT recipient_id,kind FROM content.notice WHERE route=$1 AND source_id=$2 ORDER BY recipient_id,kind',
    [route, replyPosts[0]],
  );
  await deliverNoticeEffects(replyPosts[0]!);
  expect(
    (
      await db.admin.query(
        'SELECT recipient_id,kind FROM content.notice WHERE route=$1 AND source_id=$2 ORDER BY recipient_id,kind',
        [route, replyPosts[0]],
      )
    ).rows,
  ).toEqual(replayBefore.rows);
  const authoredMentionPost = await createReply(otherThread.id, account, mentionBody([other.accountId]));
  await grant(other.accountId, 'post:read', authoredMentionPost.id);
  await deliverNoticeEffects(authoredMentionPost.id);

  const accountNotices = (
    await db.admin.query(
      'SELECT notice_id,kind FROM content.notice WHERE route=$1 AND recipient_id=$2 ORDER BY created_at,notice_id',
      [route, account.accountId],
    )
  ).rows;
  expect(accountNotices).toHaveLength(103);
  expect(accountNotices.filter((notice) => notice.kind === 'reply')).toHaveLength(102);
  expect(accountNotices.filter((notice) => notice.kind === 'mention')).toHaveLength(1);
  expect(
    (
      await db.admin.query(
        `SELECT recipient_id,actor_id,kind,post_id FROM content.notice
         WHERE route=$1 AND recipient_id=$2 AND source_id=$3 ORDER BY kind`,
        [otherRoute, other.accountId, authoredMentionPost.id],
      )
    ).rows,
  ).toEqual([
    {
      recipient_id: other.accountId,
      actor_id: account.accountId,
      kind: 'mention',
      post_id: authoredMentionPost.id,
    },
  ]);
  const otherBefore = (
    await db.admin.query('SELECT * FROM content.notice WHERE route=$1 AND recipient_id=$2', [
      otherRoute,
      other.accountId,
    ])
  ).rows;
  const otherFinalizationsBefore = (
    await db.admin.query('SELECT * FROM content.notice_finalization WHERE route=$1 AND recipient_id=$2', [
      otherRoute,
      other.accountId,
    ])
  ).rows;
  const marked = await kernel.handle(
    new Request(`https://ordinary.api.test/v1/accounts/${account.accountId}/notifications:markSeen`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${account.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify({ through: accountNotices[10]!.notice_id }),
    }),
  );
  expect(marked.status).toBe(204);
  const workerPeopleA = await createPersonas(kernel, { version: 1, pool: db.pool, auth, governance: people.staff });
  const workerPeopleB = await createPersonas(kernel, { version: 1, pool: db.pool, auth, governance: people.staff });
  const workerAccounts = [
    workerPeopleA.alice,
    workerPeopleA.bob,
    workerPeopleA.staff,
    await workerPeopleA.unscoped('account:manage'),
    workerPeopleB.alice,
    workerPeopleB.bob,
  ];
  const workerSubjects: ErasureWorkerSubject[] = [];
  for (const [index, subject] of workerAccounts.entries()) {
    const scale = [64, 64, 256, 256, 1024, 1024][index]!;
    await deletePersona({ version: 1, pool: db.pool, auth }, subject);
    workerSubjects.push({ ...subject, scale, event: await accountTombstoneEvent(subject.accountId) });
  }
  await deletePersona({ version: 1, pool: db.pool, auth }, account);
  await startContentWork({ relays: false });
  await measureAccountErasureWorker(workerSubjects, otherThread.id);
  relays = startRelays(workPool, [effectsRelay(workPool, work.effects)], { intervalMs: 5 });
  await drainEffects(db.pool, partitionOf(route));
  const sizes: number[] = [];
  let after: string | null = null;
  for (;;) {
    const trace = observeSql(pagePool);
    let result;
    try {
      result = await eraseAccountNoticesPage({ pool: pagePool }, account.accountId, after);
    } finally {
      await trace.close();
    }
    expect(trace.records.length).toBeLessThanOrEqual(6);
    if (result.found > 0) sizes.push(result.found);
    const marker = await db.admin.query('SELECT 1 FROM content.notice_seen WHERE route=$1 AND account_id=$2', [
      route,
      account.accountId,
    ]);
    expect(marker.rows).toHaveLength(result.next === null ? 0 : 1);
    if (result.next === null) break;
    expect(result.pending).toBeGreaterThan(0);
    after = result.next;
  }
  expect(sizes).toEqual([50, 50, 3]);
  expect(
    (
      await db.admin.query('SELECT 1 FROM content.notice WHERE route=$1 AND recipient_id=$2', [
        route,
        account.accountId,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await db.admin.query('SELECT * FROM content.notice WHERE route=$1 AND recipient_id=$2', [
        otherRoute,
        other.accountId,
      ])
    ).rows,
  ).toEqual(otherBefore);
  expect(
    (
      await db.admin.query('SELECT * FROM content.notice_finalization WHERE route=$1 AND recipient_id=$2', [
        route,
        account.accountId,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await db.admin.query('SELECT * FROM content.notice_finalization WHERE route=$1 AND recipient_id=$2', [
        otherRoute,
        other.accountId,
      ])
    ).rows,
  ).toEqual(otherFinalizationsBefore);
  expect(await eraseAccountNoticesPage({ pool: db.pool }, account.accountId, null)).toEqual({
    next: null,
    found: 0,
    pending: 0,
  });
  // A lost response may redrive a cursor whose selected keys have already gone.
  expect(await eraseAccountNoticesPage({ pool: db.pool }, account.accountId, after)).toEqual({
    next: null,
    found: 0,
    pending: 0,
  });
}, 600_000);

test("a per-thread author erasure through its route leaves the author's inbox intact", async () => {
  const author = people.staff;
  const call = async (
    path: string,
    body: unknown,
    persona = author,
    expected = 201,
    method = 'POST',
    head?: string,
  ) => {
    const response = await kernel.handle(
      new Request(`https://ordinary.api.test${path}`, {
        method,
        headers: {
          ...(head === undefined ? {} : { 'if-match': JSON.stringify(head) }),
          authorization: `Bearer ${persona.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify(body),
      }),
    );
    const value = response.status === 204 ? null : await response.json();
    expect({ status: response.status, value: response.status === expected ? undefined : value }).toEqual({
      status: expected,
      value: undefined,
    });
    return value;
  };
  const boardRoute = 0x1245;
  const boardId = newId(boardRoute);
  await db.admin.query(
    `INSERT INTO content.board (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Inbox erasure','published',1,$4)`,
    [boardRoute, boardId, newId(boardRoute), newId(boardRoute)],
  );
  await grant(author.accountId, 'board:read', boardId);
  await grant(author.accountId, 'thread:create', boardId);
  const created = await call(
    '/v1/threads',
    {
      title: 'Erase this thread only',
      body: fromPlainText('Per-thread content'),
      licence: 'CC0-1.0',
      subjectIds: [],
      boardId,
      visibility: 'published',
    },
    author,
  );
  const thread = created.thread;
  await grant(people.bob.accountId, 'thread:read', thread.id);
  await grant(people.bob.accountId, 'post:create', thread.id);
  const reply = await requestKernel<{ post: { id: string } }>(
    `/v1/threads/${thread.id}/posts`,
    { body: fromPlainText('A real reply before per-thread erasure'), licence: 'CC0-1.0', subjectIds: [] },
    people.bob,
  );
  await grant(author.accountId, 'post:read', reply.post.id);
  await drainEffects(db.pool, partitionOf(routeOf(reply.post.id)!));
  const ownNotice = await db.admin.query<{ notice_id: string }>(
    `SELECT notice_id::text FROM content.notice
     WHERE route=$1 AND recipient_id=$2 AND source_id=$3 AND kind='reply'`,
    [routeOf(author.accountId), author.accountId, reply.post.id],
  );
  expect(ownNotice.rows).toHaveLength(1);
  await call(
    `/v1/accounts/${author.accountId}/notifications:markSeen`,
    { through: ownNotice.rows[0]!.notice_id },
    author,
    204,
  );
  const seenBefore = (
    await db.admin.query('SELECT * FROM content.notice_seen WHERE route=$1 AND account_id=$2', [
      routeOf(author.accountId),
      author.accountId,
    ])
  ).rows;
  const before = (
    await db.admin.query('SELECT * FROM content.notice WHERE route=$1 AND recipient_id=$2', [
      routeOf(author.accountId),
      author.accountId,
    ])
  ).rows;
  expect(before.length).toBeGreaterThan(0);
  const operation = await call(`/v1/threads/${thread.id}:erase`, { authorId: author.accountId }, author, 202);
  const operationId = operation.name.slice('operations/'.length);
  const deadline = Date.now() + 30000;
  let workflowId: string | null = null;
  while (!workflowId && Date.now() < deadline) {
    const row = await db.admin.query(
      'SELECT native_workflow_id FROM content.operation WHERE route=$1 AND operation_id=$2',
      [routeOf(operationId), operationId],
    );
    workflowId = row.rows[0]?.native_workflow_id ?? null;
    if (!workflowId) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(workflowId).not.toBeNull();
  expect(await client.retrieveWorkflow(workflowId!).getResult({ pollingIntervalMs: 10 })).toEqual({
    processedPosts: 1,
    erasedRevisions: 1,
  });
  expect(
    (
      await db.admin.query('SELECT * FROM content.notice WHERE route=$1 AND recipient_id=$2', [
        routeOf(author.accountId),
        author.accountId,
      ])
    ).rows,
  ).toEqual(before);
  expect(
    (
      await db.admin.query('SELECT * FROM content.notice_seen WHERE route=$1 AND account_id=$2', [
        routeOf(author.accountId),
        author.accountId,
      ])
    ).rows,
  ).toEqual(seenBefore);
});

test('notice erasure rejects foreign accounts, versions, stages and malformed keysets before checkout', async () => {
  const accountId = people.orgOwner.accountId;
  const otherRoute = (routeOf(accountId)! + 1) % 65536;
  const valid = {
    version: 1,
    accountId,
    stage: 'notices',
    noticeAfter: null,
    finalizationAfter: null,
  };
  const invalid = [
    '{',
    JSON.stringify({ ...valid, accountId: people.staff.accountId }),
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, stage: 'seen' }),
    JSON.stringify({ ...valid, noticeAfter: { createdAt: 'invalid', noticeId: newId(routeOf(accountId)!) } }),
    JSON.stringify({ ...valid, noticeAfter: { createdAt: new Date().toISOString(), noticeId: newId(otherRoute) } }),
    JSON.stringify({
      ...valid,
      finalizationAfter: { createdAt: new Date().toISOString(), kind: 'reply', sourceId: newId(0x4d33) },
    }),
  ];
  const trace = observeSql(pagePool);
  try {
    for (const cursor of invalid)
      await expect(eraseAccountNoticesPage({ pool: pagePool }, accountId, cursor)).rejects.toThrow(
        'Invalid notice erasure cursor',
      );
  } finally {
    await trace.close();
  }
  expect(trace.records).toEqual([]);
});
