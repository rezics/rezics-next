import { afterAll, beforeAll, expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText, normalizeDocument } from '@rezics/document';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import {
  call,
  createGlobalBoard,
  createReply,
  createThreadAtomicityWorld,
  documentBytes,
  grant,
  reserveAvailableImage,
  revoke,
  reverseObjectKeys,
  type CallResult,
  type ContentItem,
  type ContentThread,
  type ThreadAtomicityWorld,
} from './thread-transaction-atomicity-fixture.ts';
import { createMediaStorage } from './support/storage.ts';

type PostRead = { readonly post: ContentItem };
type RevisionRow = {
  readonly revision_id: string;
  readonly body: Buffer;
  readonly body_sha256: Buffer;
  readonly licence: string;
  readonly subject_ids: string[];
  readonly media_ids: string[];
};
type Problem = {
  readonly code: string;
  readonly status: number;
  readonly title?: string;
  readonly retryable?: boolean;
  readonly effect_status?: string;
  readonly request_id?: string;
};

let world: ThreadAtomicityWorld;

beforeAll(async () => {
  world = await createThreadAtomicityWorld(`thread_transaction_http_${randomUUID().replaceAll('-', '')}`);
}, 90_000);

afterAll(async () => {
  await world?.system.close();
});

test('Posts, threads and boards: canonical writes commit their complete revision and media references atomically.', async () => {
  expect(world.thread.route).not.toBe(world.board.route);
  expect(routeOf(world.thread.id)).toBe(world.thread.route);
  expect(world.reply.threadId).toBe(world.thread.id);

  await canonicalRevisionReplayAndReads();
  await invalidMediaRollbacksAndPositiveControl();
  await concurrentRevisionRace();
  await nativeDenialsAndControl();
});

async function canonicalRevisionReplayAndReads(): Promise<void> {
  const { system, kernel, conceptId, reply } = world;
  const initial = await currentPost(reply.id);
  const initialRevisionId = initial.post.revisionId;
  const draft = fromPlainText('A canonical edit with Unicode: 雪の結晶、naïve façade, 🧭.');
  const expected = documentBytes(draft);
  const request = {
    body: reverseObjectKeys(draft),
    licence: 'CC-BY-4.0',
    subjectIds: [conceptId],
  };
  const idempotencyKey = randomUUID();
  const first = await call<RevisionResponse>(
    kernel,
    system.actors.author,
    'POST',
    `/v1/posts/${reply.id}/revisions`,
    request,
    idempotencyKey,
    { 'if-match': JSON.stringify(initialRevisionId) },
  );
  expect(first.response.status).toBe(200);
  expect(first.body.post.revisionId).not.toBe(initialRevisionId);
  const revisionId = first.body.post.revisionId;
  const committed = await revisionRow(reply.id, revisionId);
  expect(committed.body.equals(expected.bytes)).toBe(true);
  expect(committed.body_sha256.equals(expected.sha256)).toBe(true);
  expect(committed.licence).toBe('CC-BY-4.0');
  expect(committed.subject_ids).toEqual([conceptId]);
  expect(committed.media_ids).toEqual([]);

  // Existing post-revise-precondition coverage proves If-Match separately; this
  // replay additionally joins normalized body ordering, references and receipt position.
  const beforeReplay = await atomicSnapshot(reply.id, [], idempotencyKey);
  const replay = await call<RevisionResponse>(
    kernel,
    system.actors.author,
    'POST',
    `/v1/posts/${reply.id}/revisions`,
    reverseObjectKeys(request),
    idempotencyKey,
    { 'if-match': JSON.stringify(initialRevisionId) },
  );
  expect(replay.response.status).toBe(200);
  expect(replay.body.post.revisionId).toBe(revisionId);
  expect(replay.response.headers.get(SESSION_HEADER)).toBe(first.response.headers.get(SESSION_HEADER));
  expect(await atomicSnapshot(reply.id, [], idempotencyKey)).toEqual(beforeReplay);

  const current = await currentPost(reply.id);
  const exact = await call<PostRead>(
    kernel,
    system.actors.author,
    'GET',
    `/v1/posts/${reply.id}/revisions/${revisionId}`,
  );
  expect(current.response.status).toBe(200);
  expect(current.post.body).toEqual(expected.body);
  expect(current.post.licence).toBe('CC-BY-4.0');
  expect(current.post.subjectIds).toEqual([conceptId]);
  expect(exact.response.status).toBe(200);
  expect(exact.body.post).toMatchObject({
    revisionId,
    body: expected.body,
    licence: 'CC-BY-4.0',
    subjectIds: [conceptId],
    mediaIds: [],
  });

  const originalBytes = Buffer.from(committed.body);
  const originalDigest = Buffer.from(committed.body_sha256);
  const laterDraft = fromPlainText('The later edit has a different body: déjà vu, 風。');
  const later = await call<RevisionResponse>(
    kernel,
    system.actors.author,
    'POST',
    `/v1/posts/${reply.id}/revisions`,
    { body: laterDraft, licence: 'MIT', subjectIds: [] },
    randomUUID(),
    { 'if-match': JSON.stringify(revisionId) },
  );
  expect(later.response.status).toBe(200);
  expect(later.body.post.revisionId).not.toBe(revisionId);
  const afterLater = await revisionRow(reply.id, revisionId);
  expect(afterLater.body.equals(originalBytes)).toBe(true);
  expect(afterLater.body_sha256.equals(originalDigest)).toBe(true);
  expect(afterLater.licence).toBe('CC-BY-4.0');
  expect(afterLater.subject_ids).toEqual([conceptId]);

  const latest = await currentPost(reply.id);
  const oldExact = await call<PostRead>(
    kernel,
    system.actors.author,
    'GET',
    `/v1/posts/${reply.id}/revisions/${revisionId}`,
  );
  expect(latest.post).toMatchObject({
    revisionId: later.body.post.revisionId,
    body: normalizeDocument(laterDraft),
    licence: 'MIT',
    subjectIds: [],
  });
  expect(oldExact.body.post).toMatchObject({
    revisionId,
    body: expected.body,
    licence: 'CC-BY-4.0',
    subjectIds: [conceptId],
  });
  expect(canonicalize(expected.body)).toBe(expected.bytes.toString('utf8'));
  expect(Buffer.compare(createHash('sha256').update(expected.bytes).digest(), expected.sha256)).toBe(0);
}

async function invalidMediaRollbacksAndPositiveControl(): Promise<void> {
  const { system, kernel, governance, conceptId, thread, reply } = world;
  const storage = createMediaStorage();
  try {
    await grant(
      system,
      kernel,
      governance,
      { route: thread.route, id: thread.id },
      system.actors.other.actor.accountId,
      ['media:create'],
    );
    const first = await reserveAvailableImage(
      system,
      kernel,
      system.actors.worker,
      system.actors.worker,
      thread.id,
      storage,
    );
    const foreignUploader = await reserveAvailableImage(
      system,
      kernel,
      system.actors.otherWorker,
      system.actors.otherWorker,
      thread.id,
      storage,
    );
    const otherContainer = await reserveAvailableImage(
      system,
      kernel,
      system.actors.worker,
      system.actors.worker,
      reply.id,
      storage,
    );

    const original = await currentPost(reply.id);
    const rejectedBody = {
      body: fromPlainText('This edit must roll back when a later image cannot be claimed.'),
      licence: 'CC-BY-4.0',
      subjectIds: [conceptId],
    };
    const foreignKey = randomUUID();
    const foreignBefore = await atomicSnapshot(reply.id, [first.id, foreignUploader.id], foreignKey);
    const foreignResult = await call<Problem>(
      kernel,
      system.actors.author,
      'POST',
      `/v1/posts/${reply.id}/revisions`,
      { ...rejectedBody, mediaIds: [first.id, foreignUploader.id] },
      foreignKey,
      { 'if-match': JSON.stringify(original.post.revisionId) },
    );
    expect(foreignResult.response.status).toBe(409);
    expect(foreignResult.body).toMatchObject({
      code: 'media_unavailable',
      status: 409,
      retryable: false,
      effect_status: 'not_applied',
    });
    expect(await atomicSnapshot(reply.id, [first.id, foreignUploader.id], foreignKey)).toEqual(foreignBefore);

    const containerKey = randomUUID();
    const containerBefore = await atomicSnapshot(reply.id, [first.id, otherContainer.id], containerKey);
    const containerResult = await call<Problem>(
      kernel,
      system.actors.author,
      'POST',
      `/v1/posts/${reply.id}/revisions`,
      { ...rejectedBody, mediaIds: [first.id, otherContainer.id] },
      containerKey,
      { 'if-match': JSON.stringify(original.post.revisionId) },
    );
    expect(containerResult.response.status).toBe(409);
    expect(containerResult.body).toMatchObject({
      code: 'media_unavailable',
      status: 409,
      retryable: false,
      effect_status: 'not_applied',
    });
    expect(problemWithoutRequestId(containerResult.body)).toEqual(problemWithoutRequestId(foreignResult.body));
    expect(await atomicSnapshot(reply.id, [first.id, otherContainer.id], containerKey)).toEqual(containerBefore);

    const second = await reserveAvailableImage(
      system,
      kernel,
      system.actors.worker,
      system.actors.worker,
      thread.id,
      storage,
    );
    const positiveKey = randomUUID();
    const positiveBefore = await atomicSnapshot(reply.id, [first.id, second.id], positiveKey);
    const positive = await call<RevisionResponse>(
      kernel,
      system.actors.author,
      'POST',
      `/v1/posts/${reply.id}/revisions`,
      { ...rejectedBody, mediaIds: [first.id, second.id] },
      positiveKey,
      { 'if-match': JSON.stringify(original.post.revisionId) },
    );
    expect(positive.response.status).toBe(200);
    expect(positive.body.post.mediaIds).toEqual([first.id, second.id]);
    const positiveAfter = await atomicSnapshot(reply.id, [first.id, second.id], positiveKey);
    expect(positiveAfter.revisionKeys).toHaveLength(positiveBefore.revisionKeys.length + 1);
    expect(positiveAfter.head).not.toBe(positiveBefore.head);
    expect(positiveAfter.partitionPosition).toBe(positiveBefore.partitionPosition + 1);
    expect(positiveAfter.outboxRows).toHaveLength(positiveBefore.outboxRows.length + 1);
    expect(positiveAfter.writeBasisRows).toHaveLength(positiveBefore.writeBasisRows.length + 1);
    expect(positiveAfter.keyReceipt).not.toBeNull();
    expect(positiveAfter.mediaClaims).toEqual(
      [first, second]
        .map((media) => ({
          media_id: media.id,
          container_id: thread.id,
          uploader_id: system.actors.author.actor.accountId,
          state: 'available',
          claimed_item_id: reply.id,
          claimed_at: expect.any(Date),
        }))
        .sort((a, b) => a.media_id.localeCompare(b.media_id)),
    );
    const committed = await revisionRow(reply.id, positive.body.post.revisionId);
    expect(committed.media_ids).toEqual([first.id, second.id]);
    expect((await currentPost(reply.id)).post.revisionId).toBe(positive.body.post.revisionId);
  } finally {
    storage.close();
  }
}

async function concurrentRevisionRace(): Promise<void> {
  const { system, kernel, conceptId, thread } = world;
  const racePost = await createReply(system, kernel, system.actors.author, thread, {
    body: fromPlainText('Initial race post'),
    licence: 'MIT',
    subjectIds: [conceptId],
    parentId: thread.firstPost.id,
  });
  const storage = createMediaStorage();
  try {
    const firstMedia = await reserveAvailableImage(
      system,
      kernel,
      system.actors.worker,
      system.actors.worker,
      thread.id,
      storage,
    );
    const secondMedia = await reserveAvailableImage(
      system,
      kernel,
      system.actors.worker,
      system.actors.worker,
      thread.id,
      storage,
    );
    const expected = racePost.revisionId;
    const leftKey = randomUUID();
    const rightKey = randomUUID();
    const secret = `losing-body-secret-${randomUUID()}`;
    const leftBody = {
      body: fromPlainText('Concurrent edit one: 東京'),
      licence: 'CC-BY-4.0',
      subjectIds: [conceptId],
      mediaIds: [firstMedia.id],
    };
    const rightBody = {
      body: fromPlainText(secret),
      licence: 'MIT',
      subjectIds: [conceptId],
      mediaIds: [secondMedia.id],
    };
    const before = await atomicSnapshot(racePost.id, [firstMedia.id, secondMedia.id], leftKey);
    const [left, right] = await Promise.all([
      call<RevisionResponse | Problem>(
        kernel,
        system.actors.author,
        'POST',
        `/v1/posts/${racePost.id}/revisions`,
        leftBody,
        leftKey,
        { 'if-match': JSON.stringify(expected) },
      ),
      call<RevisionResponse | Problem>(
        kernel,
        system.actors.author,
        'POST',
        `/v1/posts/${racePost.id}/revisions`,
        rightBody,
        rightKey,
        { 'if-match': JSON.stringify(expected) },
      ),
    ]);
    const pair = [left, right];
    expect(pair.map(({ response }) => response.status).sort()).toEqual([200, 412]);
    const winner = pair.find(({ response }) => response.status === 200)! as CallResult<RevisionResponse>;
    const loser = pair.find(({ response }) => response.status === 412)! as CallResult<Problem>;
    expect(loser.body).toMatchObject({
      code: 'precondition_failed',
      status: 412,
      retryable: false,
      effect_status: 'not_applied',
    });
    expect(JSON.stringify(loser.body)).not.toContain(secret);

    const winningKey = winner === left ? leftKey : rightKey;
    const losingKey = winner === left ? rightKey : leftKey;
    const winningMedia = winner === left ? firstMedia : secondMedia;
    const losingMedia = winner === left ? secondMedia : firstMedia;
    const winningInput = winner === left ? leftBody : rightBody;
    const committedRevisionId = winner.body.post.revisionId;
    expect(committedRevisionId).not.toBe(expected);
    const after = await atomicSnapshot(racePost.id, [firstMedia.id, secondMedia.id], winningKey);
    expect(after.revisionKeys).toHaveLength(before.revisionKeys.length + 1);
    expect(after.head).toBe(committedRevisionId);
    expect(after.partitionPosition).toBe(before.partitionPosition + 1);
    expect(after.outboxRows).toHaveLength(before.outboxRows.length + 1);
    expect(after.writeBasisRows).toHaveLength(before.writeBasisRows.length + 1);
    expect(after.keyReceipt).not.toBeNull();
    expect(await receiptFor(racePost.id, losingKey)).toBeNull();
    expect(after.mediaClaims).toEqual(
      [
        {
          media_id: winningMedia.id,
          container_id: thread.id,
          uploader_id: system.actors.author.actor.accountId,
          state: 'available',
          claimed_item_id: racePost.id,
          claimed_at: expect.any(Date),
        },
        {
          media_id: losingMedia.id,
          container_id: thread.id,
          uploader_id: system.actors.author.actor.accountId,
          state: 'available',
          claimed_item_id: null,
          claimed_at: null,
        },
      ].sort((a, b) => a.media_id.localeCompare(b.media_id)),
    );
    const committed = await revisionRow(racePost.id, committedRevisionId);
    expect(committed.media_ids).toEqual(winningInput.mediaIds);
    expect(committed.body.equals(documentBytes(winningInput.body).bytes)).toBe(true);
    const winnerReceipt = await receiptFor(racePost.id, winningKey);
    expect(winnerReceipt).toMatchObject({ position: String(after.partitionPosition) });
    expect(after.outboxForPost).toHaveLength(before.outboxForPost.length + 1);
    expect(after.outboxForPost.at(-1)).toMatchObject({
      position: String(after.partitionPosition),
      type: 'com.rezics.content.revision.created.v1',
      subject: racePost.id,
    });

    const beforeReplay = await atomicSnapshot(racePost.id, [firstMedia.id, secondMedia.id], winningKey);
    const replay = await call<RevisionResponse>(
      kernel,
      system.actors.author,
      'POST',
      `/v1/posts/${racePost.id}/revisions`,
      winningInput,
      winningKey,
      { 'if-match': JSON.stringify(expected) },
    );
    expect(replay.response.status).toBe(200);
    expect(replay.body.post.revisionId).toBe(committedRevisionId);
    expect(replay.response.headers.get(SESSION_HEADER)).toBe(winner.response.headers.get(SESSION_HEADER));
    expect(await atomicSnapshot(racePost.id, [firstMedia.id, secondMedia.id], winningKey)).toEqual(beforeReplay);
  } finally {
    storage.close();
  }
}

async function nativeDenialsAndControl(): Promise<void> {
  const { system, kernel, governance, conceptId, reply, board } = world;
  const publicHead = await currentPost(reply.id);
  const deniedBody = {
    body: fromPlainText('A well-formed denied edit with 正しい文書構造.'),
    licence: 'CC-BY-4.0',
    subjectIds: [conceptId],
  };

  const anotherAuthorKey = randomUUID();
  const anotherAuthorBefore = await atomicSnapshot(reply.id, [], anotherAuthorKey);
  const anotherAuthor = await call<Problem>(
    kernel,
    system.actors.other,
    'POST',
    `/v1/posts/${reply.id}/revisions`,
    deniedBody,
    anotherAuthorKey,
    { 'if-match': JSON.stringify(publicHead.post.revisionId) },
  );
  expect(anotherAuthor.response.status).toBe(403);
  expect(anotherAuthor.body).toMatchObject({ code: 'forbidden', status: 403, effect_status: 'not_applied' });
  expect(await atomicSnapshot(reply.id, [], anotherAuthorKey)).toEqual(anotherAuthorBefore);

  const noBearerKey = randomUUID();
  const noBearerBefore = await atomicSnapshot(reply.id, [], noBearerKey);
  const noBearer = await call<Problem>(
    kernel,
    null,
    'POST',
    `/v1/posts/${reply.id}/revisions`,
    deniedBody,
    noBearerKey,
    { 'if-match': JSON.stringify(publicHead.post.revisionId) },
  );
  expect(noBearer.response.status).toBe(401);
  expect(noBearer.body).toMatchObject({ code: 'authentication_required', status: 401, effect_status: 'not_applied' });
  expect(await atomicSnapshot(reply.id, [], noBearerKey)).toEqual(noBearerBefore);

  const limited = await system.auth.issue({
    accountId: system.actors.author.actor.accountId,
    clientId: system.auth.websiteClient.id,
    scopes: [...system.actions.keys()].filter((scope) => scope !== 'post:revise'),
  });
  const limitedKey = randomUUID();
  const limitedBefore = await atomicSnapshot(reply.id, [], limitedKey);
  const insufficient = await call<Problem>(
    kernel,
    limited,
    'POST',
    `/v1/posts/${reply.id}/revisions`,
    deniedBody,
    limitedKey,
    { 'if-match': JSON.stringify(publicHead.post.revisionId) },
  );
  expect(insufficient.response.status).toBe(403);
  expect(insufficient.body).toMatchObject({ code: 'forbidden', status: 403, effect_status: 'not_applied' });
  expect(await atomicSnapshot(reply.id, [], limitedKey)).toEqual(limitedBefore);

  const protectedConceptResult = await call<SubjectResponse>(kernel, system.actors.other, 'POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: `Protected-parent ${randomUUID()}` },
  });
  expect(protectedConceptResult.response.status).toBe(201);
  const protectedConceptId = protectedConceptResult.body.subject.id;
  const protectedBoard = await createGlobalBoard(system, kernel, governance, system.actors.other, protectedConceptId, {
    title: `Protected parent ${randomUUID()}`,
    visibility: 'protected',
  });
  const authorId = system.actors.author.actor.accountId;
  const protectedResource = { route: protectedBoard.route, id: protectedBoard.id };
  await grant(system, kernel, governance, protectedResource, authorId, ['board:read', 'thread:create']);
  const protectedThreadKey = randomUUID();
  const protectedTarget = await call<ThreadResponse>(
    kernel,
    system.actors.author,
    'POST',
    '/v1/threads',
    {
      title: 'Thread whose current parent authority will be revoked',
      body: fromPlainText('Protected board opening post'),
      licence: 'MIT',
      subjectIds: [protectedConceptId],
      boardId: protectedBoard.id,
      visibility: 'published',
    },
    protectedThreadKey,
  );
  expect(protectedTarget.response.status).toBe(201);
  const protectedPost = protectedTarget.body.thread.firstPost;
  await revoke(kernel, governance, protectedResource, authorId, ['board:read']);

  const parentKey = randomUUID();
  const parentBefore = await atomicSnapshot(protectedPost.id, [], parentKey);
  const parentDenied = await call<Problem>(
    kernel,
    system.actors.author,
    'POST',
    `/v1/posts/${protectedPost.id}/revisions`,
    deniedBody,
    parentKey,
    { 'if-match': JSON.stringify(protectedPost.revisionId) },
  );
  expect(parentDenied.response.status).toBe(404);
  expect(parentDenied.body).toMatchObject({ code: 'not_found', status: 404, effect_status: 'not_applied' });
  expect(await atomicSnapshot(protectedPost.id, [], parentKey)).toEqual(parentBefore);

  const controlKey = randomUUID();
  const controlBefore = await atomicSnapshot(reply.id, [], controlKey);
  const controlDraft = fromPlainText('An unrelated authorized edit still commits: контроль.');
  const control = await call<RevisionResponse>(
    kernel,
    system.actors.author,
    'POST',
    `/v1/posts/${reply.id}/revisions`,
    { body: controlDraft, licence: 'CC-BY-4.0', subjectIds: [conceptId] },
    controlKey,
    { 'if-match': JSON.stringify(publicHead.post.revisionId) },
  );
  expect(control.response.status).toBe(200);
  const controlAfter = await atomicSnapshot(reply.id, [], controlKey);
  expect(controlAfter.revisionKeys).toHaveLength(controlBefore.revisionKeys.length + 1);
  expect(controlAfter.head).toBe(control.body.post.revisionId);
  expect(controlAfter.partitionPosition).toBe(controlBefore.partitionPosition + 1);
  expect(controlAfter.keyReceipt).not.toBeNull();
  expect(controlAfter.outboxRows).toHaveLength(controlBefore.outboxRows.length + 1);
  expect(controlAfter.writeBasisRows).toHaveLength(controlBefore.writeBasisRows.length + 1);
  expect(board.visibility).toBe('published');
}

type RevisionResponse = { readonly post: ContentItem };
type SubjectResponse = { readonly subject: { readonly id: string } };
type ThreadResponse = { readonly thread: ContentThread };

async function currentPost(postId: string): Promise<{ readonly response: Response; readonly post: ContentItem }> {
  const result = await call<PostRead>(world.kernel, world.system.actors.author, 'GET', `/v1/posts/${postId}`);
  return { response: result.response, post: result.body.post };
}

async function revisionRow(postId: string, revisionId: string): Promise<RevisionRow> {
  const route = routeOf(postId)!;
  const result = await world.system.database.pool.query<RevisionRow>(
    `SELECT revision_id,body,body_sha256,licence,subject_ids,media_ids
     FROM content.revision WHERE route=$1 AND post_id=$2 AND revision_id=$3`,
    [route, postId, revisionId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function atomicSnapshot(postId: string, mediaIds: readonly string[], idempotencyKey: string) {
  const system = world.system;
  const route = routeOf(postId)!;
  const partition = partitionOf(route);
  const authorId = system.actors.author.actor.accountId;
  const [post, revisions, mediaClaims, keyReceipt, receipts, writeBasisRows, outboxRows, partitionRows] =
    await Promise.all([
      system.database.pool.query<{ head: string; availability: string; security_revision: string }>(
        'SELECT head_revision_id AS head,availability,security_revision::text FROM content.post WHERE route=$1 AND post_id=$2',
        [route, postId],
      ),
      system.database.pool.query<{ revision_id: string }>(
        'SELECT revision_id::text FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY revision_id',
        [route, postId],
      ),
      system.database.pool.query(
        `SELECT media_id::text,container_id::text,uploader_id::text,state,claimed_item_id::text,claimed_at
       FROM content.media WHERE route=$1 AND media_id=ANY($2::uuid[]) ORDER BY media_id`,
        [route, [...mediaIds]],
      ),
      system.database.pool.query(
        `SELECT principal_kind,principal_id::text,command_kind,idempotency_key,epoch,position::text,transaction_id::text
       FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
         AND command_kind='content.post.revise' AND idempotency_key=$3`,
        [partition, authorId, idempotencyKey],
      ),
      system.database.pool.query(
        `SELECT principal_kind,principal_id::text,command_kind,idempotency_key,epoch,position::text,transaction_id::text
       FROM core.receipt WHERE partition_no=$1 ORDER BY position,principal_kind,principal_id,command_kind,idempotency_key`,
        [partition],
      ),
      system.database.pool.query(
        `SELECT transaction_id::text,epoch,position::text,principal_kind,principal_id::text,client_id,requested_by
       FROM editorial.write_basis WHERE partition_no=$1 ORDER BY position,transaction_id`,
        [partition],
      ),
      system.database.pool.query(
        `SELECT position::text,event_seq,id::text,type,subject,data::text
       FROM core.outbox WHERE partition_no=$1 ORDER BY position,event_seq`,
        [partition],
      ),
      system.database.pool.query<{ position: string }>(
        'SELECT position::text FROM core.partition WHERE partition_no=$1',
        [partition],
      ),
    ]);
  const receipt = keyReceipt.rows[0] ?? null;
  const basisForReceipt = receipt
    ? (writeBasisRows.rows.find((row) => row.transaction_id === receipt.transaction_id) ?? null)
    : null;
  const outboxForPost = outboxRows.rows.filter(
    (row) => row.subject === postId && row.type === 'com.rezics.content.revision.created.v1',
  );
  return {
    head: post.rows[0]?.head ?? null,
    post: post.rows[0] ?? null,
    revisionKeys: revisions.rows.map((row) => row.revision_id),
    mediaClaims: mediaClaims.rows,
    keyReceipt: receipt,
    basisForReceipt,
    receipts: receipts.rows,
    writeBasisRows: writeBasisRows.rows,
    outboxRows: outboxRows.rows,
    outboxForPost,
    partitionPosition: Number(partitionRows.rows[0]?.position ?? -1),
  };
}

async function receiptFor(postId: string, idempotencyKey: string) {
  const result = await world.system.database.pool.query<{ position: string; transaction_id: string }>(
    `SELECT position::text,transaction_id::text FROM core.receipt
     WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
       AND command_kind='content.post.revise' AND idempotency_key=$3`,
    [partitionOf(routeOf(postId)!), world.system.actors.author.actor.accountId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

function problemWithoutRequestId(problem: Problem): Omit<Problem, 'request_id'> {
  const { request_id: _requestId, ...stable } = problem;
  return stable;
}
