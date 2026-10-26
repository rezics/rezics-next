import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { bindAuthorErasureWorkflow } from '../../src/content/erasure-workflow-identity.ts';
import { runAuthorErasure } from '../../src/content/erasure-workflow.ts';
import { CONTENT_QUEUES, CONTENT_WORKFLOWS } from '../../src/content/work-contract.ts';
import { readBatch, type Envelope } from '../../src/events/log.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { readPartition } from '../../src/partition/partition.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const originalText = 'original-erased-sentinel';
const replyText = 'reply-erased-sentinel';
const editedText = 'edited-erased-sentinel';
const freshReviseText = 'fresh-revise-erased-sentinel';
const freshReplyText = 'fresh-reply-erased-sentinel';
const sentinels = [originalText, replyText, editedText, freshReviseText, freshReplyText];

describe('replay after the author erases the thread', () => {
  let fixture: Awaited<ReturnType<typeof standingFixture>>;
  let app: ReturnType<typeof createKernel>;
  let publicApp: ReturnType<typeof createKernel>;
  let actor: AccountActor;
  let bearer: string;
  let other: AccountActor;
  let otherBearer: string;
  let client: Awaited<ReturnType<typeof createWorkClient>>;
  let work: Awaited<ReturnType<typeof composeWork>>;
  let systemPool: Pool;
  const boardId = newId(0x4321);

  beforeAll(async () => {
    fixture = await standingFixture(['account:read']);
    await fixture.reset();
    ({ actor, token: bearer } = await signIn());
    ({ actor: other, token: otherBearer } = await signIn(fixture.recipient));
    app = createKernel({
      pool: fixture.pool,
      routeKey,
      tokens,
      access: fixture.access,
      writeRate: createWriteRateLimiter({
        secret: 'content-replay-after-erasure-secret-32b',
        overrides: '{"new-account":{"write":{"maximum":100000,"seconds":60}}}',
      }),
    });
    // Production reads admit the public floor. The fixture catalogue is bearer-only,
    // so an ungranted account is not an ordinary reader there.
    publicApp = createKernel({ pool: fixture.pool, routeKey, tokens });
    await fixture.grant(actor.accountId, 'thread:create', { route: routeOf(boardId)!, id: boardId });
    await fixture.grant(actor.accountId, 'board:read', { route: routeOf(boardId)!, id: boardId });
    await fixture.grant(actor.accountId, 'account:read', { route: routeOf(actor.accountId)!, id: actor.accountId });
    await fixture.reader.query(
      `INSERT INTO content.board
         (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
       VALUES ($1, $2, $3, 'Replay erasure board', 'published', 1, $4)`,
      [routeOf(boardId), boardId, newId(0x6789), randomUUID()],
    );
    systemPool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 10 });
    client = await createWorkClient(process.env.DATABASE_URL!);
    work = await composeWork(
      [
        {
          name: 'replay-after-erasure',
          register() {
            DBOS.registerWorkflow(
              async (operationId: string) =>
                runAuthorErasure(
                  {
                    pool: fixture.pool,
                    access: fixture.access,
                    readConsent: fixture.readConsent,
                    currentTime: () => new Date(),
                    durableStep: (name, action) =>
                      DBOS.runStep(() => action(), {
                        name,
                        retriesAllowed: true,
                        maxAttempts: 2,
                        intervalSeconds: 0.001,
                      }),
                    checkpoint: {
                      read: (id) => DBOS.getEvent(id, 'progress', 0),
                      write: (_id, progress) => DBOS.setEvent('progress', progress),
                    },
                  },
                  operationId,
                ),
              { name: CONTENT_WORKFLOWS.authorErase },
            );
          },
        },
      ],
      { databaseUrl: process.env.DATABASE_URL!, pool: systemPool, client },
    );
    await work.launch();
  });

  afterAll(async () => {
    await work?.shutdown();
    await client?.close();
    await systemPool?.end();
    await fixture?.close();
  });

  async function signIn(id = fixture.actor) {
    let token = '';
    const authenticate = fixture.access.authenticate;
    fixture.access.authenticate = (presented, boundary) => {
      token = presented;
      return authenticate(presented, boundary);
    };
    try {
      const signed = (await fixture.context(id)).actor;
      if (signed.kind !== 'account') throw new Error('Fixture account did not authenticate');
      return { actor: signed, token };
    } finally {
      fixture.access.authenticate = authenticate;
    }
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
    token: string | null = bearer,
    target = app,
  ) {
    return target.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  async function marks(postId: string) {
    const [posts, revisions, receipts, outbox, head] = await Promise.all([
      fixture.reader.query<{ count: string }>('SELECT count(*)::text AS count FROM content.post'),
      fixture.reader.query<{ count: string }>('SELECT count(*)::text AS count FROM content.revision'),
      fixture.reader.query<{ count: string }>('SELECT count(*)::text AS count FROM core.receipt'),
      fixture.reader.query<{ count: string }>('SELECT count(*)::text AS count FROM core.outbox'),
      fixture.reader.query<{ head_revision_id: string; availability: string }>(
        'SELECT head_revision_id, availability FROM content.post WHERE post_id = $1',
        [postId],
      ),
    ]);
    return {
      posts: posts.rows[0]!.count,
      revisions: revisions.rows[0]!.count,
      receipts: receipts.rows[0]!.count,
      outbox: outbox.rows[0]!.count,
      head: head.rows[0]!.head_revision_id,
      availability: head.rows[0]!.availability,
    };
  }

  function operationIdOf(data: unknown): string | undefined {
    if (typeof data !== 'object' || data === null || !('operationId' in data)) return undefined;
    return typeof data.operationId === 'string' ? data.operationId : undefined;
  }

  async function requestedEvent(
    partition: number,
    operationId: string,
  ): Promise<{ envelope: Envelope; index: number }> {
    let found: { envelope: Envelope; index: number } | undefined;
    const consumer = `replay_erasure_${randomUUID().replaceAll('-', '')}`;
    while (!found) {
      const batch = await readBatch(fixture.pool, {
        partition,
        consumer,
        apply: async (envelopes) => {
          for (const envelope of envelopes) {
            const index = envelope.events.findIndex(
              (event) =>
                event.type === 'com.rezics.content.author-erasure.requested.v1' &&
                operationIdOf(event.data) === operationId,
            );
            if (index >= 0) found = { envelope, index };
          }
        },
      });
      if (batch.status !== 'read' || batch.envelopes === 0) break;
    }
    if (!found) throw new Error('Author erasure did not publish its requested event');
    return found;
  }

  function hidesBytes(value: unknown) {
    const rendered = JSON.stringify(value);
    for (const sentinel of sentinels) expect(rendered).not.toContain(sentinel);
  }

  function stableProblem(value: Record<string, unknown>) {
    const { request_id: _requestId, ...problem } = value;
    return problem;
  }

  test('exact replays return the receipt tombstone and fresh keys or lost authority write nothing', async () => {
    const threadKey = randomUUID();
    const replyKey = randomUUID();
    const reviseKey = randomUUID();
    const threadBody = {
      title: 'Erased replay thread',
      body: fromPlainText(originalText),
      licence: 'CC-BY-SA-4.0' as const,
      subjectIds: [] as string[],
      boardId,
      visibility: 'published' as const,
    };
    const created = await call('POST', '/v1/threads', threadBody, threadKey);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      thread: { id: string; firstPost: { id: string; revisionId: string } };
    };
    const threadId = createdBody.thread.id;
    const postId = createdBody.thread.firstPost.id;
    const openingRevisionId = createdBody.thread.firstPost.revisionId;
    const replyBody = {
      body: fromPlainText(replyText),
      licence: 'CC-BY-SA-4.0',
      subjectIds: [],
      parentId: postId,
    };
    const replied = await call('POST', `/v1/threads/${threadId}/posts`, replyBody, replyKey);
    expect(replied.status).toBe(201);
    const repliedPayload = (await replied.json()) as { post: { id: string; revisionId: string } };
    const replyId = repliedPayload.post.id;
    const replyRevisionId = repliedPayload.post.revisionId;
    const reviseBody = { body: fromPlainText(editedText) };
    const revised = await call('POST', `/v1/posts/${replyId}/revisions`, reviseBody, reviseKey);
    expect(revised.status).toBe(200);
    const revisedPayload = (await revised.json()) as { post: { revisionId: string } };
    const editedRevisionId = revisedPayload.post.revisionId;
    expect(editedRevisionId).not.toBe(replyRevisionId);

    const erased = await call('POST', `/v1/threads/${threadId}:erase`, { authorId: actor.accountId }, randomUUID());
    expect(erased.status).toBe(202);
    const operation = (await erased.json()) as { name: string; done: boolean };
    expect(operation.done).toBe(false);
    const operationId = operation.name.slice('operations/'.length);
    const source = await requestedEvent(partitionOf(routeOf(threadId)!), operationId);
    const tx = await fixture.pool.connect();
    let workflowId: string;
    try {
      await tx.query('BEGIN');
      await readPartition(tx, partitionOf(routeOf(threadId)!));
      workflowId = await bindAuthorErasureWorkflow(tx, operationId, source.envelope, source.index);
      await tx.query('COMMIT');
    } finally {
      tx.release();
    }
    const handle = await client.enqueue(
      { workflowName: CONTENT_WORKFLOWS.authorErase, queueName: CONTENT_QUEUES.authorErase, workflowID: workflowId! },
      operationId,
    );
    const outcome = (await handle.getResult()) as { processedPosts: number; erasedRevisions: number };
    expect(outcome.processedPosts).toBe(2);
    expect(outcome.erasedRevisions).toBe(3);
    const stored = await fixture.reader.query<{ body: Buffer | null; availability: string }>(
      'SELECT body, availability FROM content.revision WHERE thread_id = $1',
      [threadId],
    );
    expect(stored.rows).toHaveLength(3);
    for (const row of stored.rows) {
      expect(row.body).toBeNull();
      expect(row.availability).toBe('erased');
    }
    const afterErasure = await marks(replyId);
    expect(afterErasure.availability).toBe('erased');
    expect(afterErasure.head).toBe(editedRevisionId);

    async function replay(method: string, path: string, body: unknown, key: string, status: number) {
      const observer = observeSql(fixture.pool);
      const response = await call(method, path, body, key);
      const statements = observer.records.map((record) => record.statement);
      await observer.close();
      expect(response.status).toBe(status);
      const payload: unknown = await response.json();
      hidesBytes(payload);
      expect(statements.some((statement) => /FROM core\.receipt/i.test(statement))).toBe(true);
      expect(
        statements.filter((statement) =>
          /INSERT INTO (?:content\.post|content\.revision|core\.receipt|core\.outbox)\b/i.test(statement),
        ),
      ).toEqual([]);
      expect(await marks(replyId)).toEqual(afterErasure);
      return payload;
    }

    const threadReplay = (await replay('POST', '/v1/threads', threadBody, threadKey, created.status)) as {
      thread: { firstPost: { revisionId: string } };
    };
    expect(threadReplay.thread.firstPost).toEqual(
      expect.objectContaining({
        id: postId,
        revisionId: openingRevisionId,
        availability: 'erased',
        body: null,
        sha256: null,
        removed: true,
      }),
    );
    const replyReplay = (await replay(
      'POST',
      `/v1/threads/${threadId}/posts`,
      replyBody,
      replyKey,
      replied.status,
    )) as { post: { revisionId: string } };
    expect(replyReplay.post).toEqual(
      expect.objectContaining({
        id: replyId,
        revisionId: replyRevisionId,
        availability: 'erased',
        body: null,
        sha256: null,
        removed: true,
      }),
    );
    const reviseReplay = (await replay(
      'POST',
      `/v1/posts/${replyId}/revisions`,
      reviseBody,
      reviseKey,
      revised.status,
    )) as { post: { revisionId: string } };
    expect(reviseReplay.post).toEqual(
      expect.objectContaining({
        id: replyId,
        revisionId: editedRevisionId,
        availability: 'erased',
        body: null,
        sha256: null,
        removed: true,
      }),
    );

    const placeholder = {
      removed: true,
      availability: 'erased',
      body: null,
      sha256: null,
    };
    const authorCurrent = await call('GET', `/v1/posts/${replyId}`);
    expect(authorCurrent.status).toBe(200);
    const authorCurrentBody = (await authorCurrent.json()) as { post: Record<string, unknown> };
    expect(authorCurrentBody.post).toMatchObject({ id: replyId, parentId: postId, ...placeholder });
    expect(authorCurrentBody.post).not.toHaveProperty('revisionId');
    hidesBytes(authorCurrentBody);
    const authorExact = await call('GET', `/v1/posts/${replyId}/revisions/${editedRevisionId}`);
    expect(authorExact.status).toBe(404);
    expect(await authorExact.json()).toMatchObject({ status: 404, code: 'not_found' });
    const authorHistory = await call('GET', `/v1/posts/${replyId}/revisions`);
    expect(authorHistory.status).toBe(200);
    expect(await authorHistory.json()).toEqual({ revisions: [], next: null });

    const ungranted = await call('GET', `/v1/posts/${replyId}`, undefined, undefined, otherBearer);
    expect(ungranted.status).toBe(404);
    const publicCurrent = await call('GET', `/v1/posts/${replyId}`, undefined, undefined, null, publicApp);
    expect(publicCurrent.status).toBe(200);
    expect(((await publicCurrent.json()) as { post: Record<string, unknown> }).post).toMatchObject(placeholder);
    expect(
      (await call('GET', `/v1/posts/${replyId}/revisions/${replyRevisionId}`, undefined, undefined, null, publicApp))
        .status,
    ).toBe(404);
    const publicHistory = await call('GET', `/v1/posts/${replyId}/revisions`, undefined, undefined, null, publicApp);
    expect(publicHistory.status).toBe(200);
    expect(await publicHistory.json()).toEqual({ revisions: [], next: null });

    await fixture.grant(other.accountId, 'board:read', { route: routeOf(boardId)!, id: boardId });
    await fixture.grant(other.accountId, 'thread:read', { route: routeOf(threadId)!, id: threadId });
    // The erased parent stays in the chain. Explicit post:read on the reply is what
    // discloses that reply; the parent grant only admits the chain.
    await fixture.grant(other.accountId, 'post:read', { route: routeOf(postId)!, id: postId });
    await fixture.grant(other.accountId, 'post:read', { route: routeOf(replyId)!, id: replyId });
    const held = await call('GET', `/v1/posts/${replyId}`, undefined, undefined, otherBearer);
    expect(held.status).toBe(200);
    const heldBody = (await held.json()) as { post: { revisionId: string; body: null; sha256: null } };
    expect(heldBody.post).toEqual(
      expect.objectContaining({
        id: replyId,
        revisionId: editedRevisionId,
        availability: 'erased',
        body: null,
        sha256: null,
        removed: true,
      }),
    );
    hidesBytes(heldBody);
    const heldExact = await call(
      'GET',
      `/v1/posts/${replyId}/revisions/${replyRevisionId}`,
      undefined,
      undefined,
      otherBearer,
    );
    expect(heldExact.status).toBe(200);
    const heldExactBody = (await heldExact.json()) as { post: { revisionId: string } };
    expect(heldExactBody.post).toEqual(
      expect.objectContaining({
        revisionId: replyRevisionId,
        availability: 'erased',
        body: null,
        sha256: null,
        removed: true,
      }),
    );
    hidesBytes(heldExactBody);
    const heldHistory = await call('GET', `/v1/posts/${replyId}/revisions`, undefined, undefined, otherBearer);
    expect(heldHistory.status).toBe(200);
    const history = (await heldHistory.json()) as {
      revisions: { revisionId: string; body: null; sha256: null; availability: string }[];
    };
    expect(history.revisions.map((revision) => revision.revisionId).sort()).toEqual(
      [replyRevisionId, editedRevisionId].sort(),
    );
    for (const revision of history.revisions) {
      expect(revision).toMatchObject({ availability: 'erased', body: null, sha256: null, removed: true });
    }
    hidesBytes(history);
    const authorStillOrdinary = await call('GET', `/v1/posts/${replyId}/revisions/${editedRevisionId}`);
    expect(authorStillOrdinary.status).toBe(404);

    const freshRevise = { body: fromPlainText(freshReviseText) };
    const freshReply = {
      body: fromPlainText(freshReplyText),
      licence: 'CC-BY-SA-4.0',
      subjectIds: [],
      parentId: postId,
    };
    const authorFreshRevise = await call('POST', `/v1/posts/${replyId}/revisions`, freshRevise, randomUUID());
    const authorFreshReply = await call('POST', `/v1/threads/${threadId}/posts`, freshReply, randomUUID());
    expect(authorFreshRevise.status).toBe(404);
    expect(authorFreshReply.status).toBe(404);
    const authorReviseProblem = (await authorFreshRevise.json()) as Record<string, unknown>;
    const authorReplyProblem = (await authorFreshReply.json()) as Record<string, unknown>;
    expect(authorReviseProblem).toMatchObject({ status: 404, code: 'not_found', effect_status: 'not_applied' });
    expect(authorReplyProblem).toMatchObject({ status: 404, code: 'not_found', effect_status: 'not_applied' });
    const otherFreshRevise = await call(
      'POST',
      `/v1/posts/${replyId}/revisions`,
      freshRevise,
      randomUUID(),
      otherBearer,
    );
    const otherFreshReply = await call('POST', `/v1/threads/${threadId}/posts`, freshReply, randomUUID(), otherBearer);
    expect(stableProblem((await otherFreshRevise.json()) as Record<string, unknown>)).toEqual(
      stableProblem(authorReviseProblem),
    );
    expect(stableProblem((await otherFreshReply.json()) as Record<string, unknown>)).toEqual(
      stableProblem(authorReplyProblem),
    );
    const anonymousRevise = await call('POST', `/v1/posts/${replyId}/revisions`, freshRevise, randomUUID(), null);
    const anonymousReply = await call('POST', `/v1/threads/${threadId}/posts`, freshReply, randomUUID(), null);
    expect(anonymousRevise.status).toBe(401);
    expect(anonymousReply.status).toBe(401);
    expect(await anonymousRevise.json()).toMatchObject({
      status: 401,
      code: 'authentication_required',
      effect_status: 'not_applied',
    });
    expect(await marks(replyId)).toEqual(afterErasure);
    const freshStored = await fixture.reader.query<{ body: string | null }>(
      'SELECT body::text AS body FROM content.revision WHERE thread_id = $1',
      [threadId],
    );
    expect(freshStored.rows.every((row) => row.body === null)).toBe(true);

    await fixture.reader.query(
      `DELETE FROM access.resource_role_grant
        WHERE route = $1 AND resource_id = $2 AND subject_id = $3 AND grant_role = 'content.post.owner'`,
      [routeOf(replyId), replyId, actor.accountId],
    );
    const deniedObserver = observeSql(fixture.pool);
    const denied = await call('POST', `/v1/posts/${replyId}/revisions`, reviseBody, reviseKey);
    const deniedStatements = deniedObserver.records.map((record) => record.statement);
    await deniedObserver.close();
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as Record<string, unknown>;
    expect(deniedBody).toMatchObject({ status: 403, code: 'forbidden' });
    expect(deniedBody).not.toHaveProperty('post');
    hidesBytes(deniedBody);
    expect(JSON.stringify(deniedBody)).not.toContain(editedRevisionId);
    expect(deniedStatements.some((statement) => /FROM core\.receipt/i.test(statement))).toBe(false);
    expect(await marks(replyId)).toEqual(afterErasure);
  });
});
