import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CONTENT_OPERATION_PROGRESS } from '../../src/content/work.ts';
import { CONTENT_WORKFLOWS, contentWorkWorkflowId } from '../../src/content/work-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  createAuthorErasureFixture,
  type AuthorErasureFixture,
  type NativeScope,
  type NativeCall,
} from './author-erasure-native-operation-fixture.ts';

const metadata = (scope: NativeScope, authorId: string, posts: number, revisions: number, steps: number) => ({
  type: 'content.author_erasure',
  threadId: scope.threadId,
  authorId,
  processedPosts: posts,
  erasedRevisions: revisions,
  steps,
});

function problem(result: NativeCall, status: number, code: string) {
  expect(result.response.status).toBe(status);
  expect(result.response.headers.get('content-type')).toContain('application/problem+json');
  expect(result.value).toMatchObject({ status, type: expect.stringContaining(code), title: expect.any(String) });
  expect(result.value).not.toHaveProperty('error');
  expect(result.value).not.toHaveProperty('response');
  expect(result.value).not.toHaveProperty('done');
}

async function start(f: AuthorErasureFixture, scope: NativeScope) {
  const key = randomUUID();
  const path = `/v1/threads/${scope.threadId}:erase`;
  const body = { authorId: f.author.actor.accountId };
  const initial = await f.call('POST', path, { body, key, bearer: f.author.bearer });
  expect(initial.response.status).toBe(202);
  expect(initial.value).toEqual({
    name: expect.stringMatching(/^operations\/[0-9a-f-]{36}$/),
    done: false,
    metadata: metadata(scope, f.author.actor.accountId, 0, 0, 0),
  });
  return { key, path, body, initial, id: (initial.value!.name as string).slice('operations/'.length) };
}

async function binding(f: AuthorErasureFixture, id: string) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const row = (
      await f.pool.query<{
        native_workflow_id: string | null;
        source_partition: number;
        source_epoch: number;
        source_position: string;
        source_event_index: number;
      }>(
        `SELECT native_workflow_id, source_partition, source_epoch, source_position::text, source_event_index
        FROM content.operation WHERE route=$1 AND operation_id=$2`,
        [routeOf(id), id],
      )
    ).rows[0];
    if (row?.native_workflow_id) {
      expect(row.native_workflow_id).toBe(
        contentWorkWorkflowId(
          {
            partition: row.source_partition,
            epoch: row.source_epoch,
            position: BigInt(row.source_position),
          },
          row.source_event_index,
          'authorErase',
          id,
        ),
      );
      const workflow = await f.client.getWorkflow(row.native_workflow_id);
      if (workflow) {
        expect(workflow.workflowName).toBe(CONTENT_WORKFLOWS.authorErase);
        expect(workflow.queueName).toBe('governance');
        return row.native_workflow_id;
      }
    }
    if (Date.now() >= deadline) throw new Error('Native erasure relay did not bind the committed operation');
    await Bun.sleep(10);
  }
}

async function status(f: AuthorErasureFixture, id: string, bearer = f.author.bearer) {
  return f.call('GET', `/v1/operations/${id}`, { bearer });
}

async function authorRows(f: AuthorErasureFixture, scope: NativeScope) {
  return (
    await f.pool.query(
      `SELECT p.post_id, p.availability, p.security_revision::text, p.deleted_at, p.purge_started_at,
            r.revision_id, r.availability AS revision_availability,
            encode(r.body,'hex') AS body, encode(r.body_sha256,'hex') AS digest, r.search_text
       FROM content.post p JOIN content.revision r ON r.route=p.route AND r.post_id=p.post_id
      WHERE p.route=$1 AND p.thread_id=$2 AND p.author_account_id=$3
      ORDER BY p.created_at,p.post_id,r.recorded_at,r.revision_id`,
      [scope.route, scope.threadId, f.author.actor.accountId],
    )
  ).rows;
}

async function otherRows(f: AuthorErasureFixture, scope: NativeScope) {
  return (
    await f.pool.query(
      `SELECT p.post_id,p.availability,p.head_revision_id,p.security_revision::text,
            r.revision_id,encode(r.body,'hex') AS body,encode(r.body_sha256,'hex') AS digest,r.search_text
       FROM content.post p JOIN content.revision r ON r.route=p.route AND r.post_id=p.post_id
      WHERE p.route=$1 AND p.thread_id=$2 AND p.author_account_id=$3 ORDER BY p.post_id,r.revision_id`,
      [scope.route, scope.threadId, f.other.actor.accountId],
    )
  ).rows;
}

async function effects(f: AuthorErasureFixture, scope: NativeScope) {
  const [operations, events, receipts] = await Promise.all([
    f.pool.query('SELECT * FROM content.operation WHERE route=$1 AND thread_id=$2 ORDER BY operation_id', [
      scope.route,
      scope.threadId,
    ]),
    f.pool.query(
      `SELECT id,type,subject,data FROM core.outbox WHERE partition_no=$1
      AND (subject=ANY($2::text[]) OR (type='com.rezics.content.author-erasure.requested.v1' AND data->>'threadId'=$3))
      ORDER BY position,event_seq`,
      [partitionOf(scope.route), scope.posts.map(({ id }) => id), scope.threadId],
    ),
    f.pool.query(
      `SELECT idempotency_key,response FROM core.receipt WHERE partition_no=$1 AND principal_id=$2
      AND command_kind LIKE 'content.author-erasure%' ORDER BY idempotency_key`,
      [partitionOf(scope.route), f.author.actor.accountId],
    ),
  ]);
  return { operations: operations.rows, events: events.rows, receipts: receipts.rows };
}

async function noSecrets(f: AuthorErasureFixture, scope: NativeScope, workflowId: string) {
  const [operation, work] = await Promise.all([
    f.pool.query('SELECT * FROM content.operation WHERE route=$1 AND thread_id=$2', [scope.route, scope.threadId]),
    f.pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [workflowId]),
  ]);
  expect(work.rows).toHaveLength(1);
  const stored = JSON.stringify({ operation: operation.rows, work: work.rows });
  for (const credential of [f.author, f.other, f.system.actors.worker, f.governance])
    expect(stored).not.toContain(credential.bearer);
  for (const forbidden of ['access_token', 'refresh_token', 'authorization', 'Private author', 'Surviving unrelated'])
    expect(stored).not.toContain(forbidden);
  const workflow = await f.client.getWorkflow(workflowId);
  expect(workflow?.input).toEqual([
    {
      operationId: operation.rows[0]!.operation_id,
      source: {
        partition: operation.rows[0]!.source_partition,
        epoch: operation.rows[0]!.source_epoch,
        position: String(operation.rows[0]!.source_position),
        eventIndex: operation.rows[0]!.source_event_index,
      },
    },
  ]);
}

async function tombstone(f: AuthorErasureFixture, scope: NativeScope) {
  const first = scope.posts[0]!;
  const publicPost = await f.call('GET', `/v1/posts/${first.id}`);
  expect(publicPost.response.status).toBe(200);
  const expected = {
    id: first.id,
    threadId: scope.threadId,
    parentId: null,
    route: scope.route,
    availability: 'erased',
    removed: true,
    body: null,
    sha256: null,
  };
  expect(publicPost.value!.post).toEqual(expected);
  const thread = await f.call('GET', `/v1/threads/${scope.threadId}`);
  expect(thread.response.status).toBe(200);
  expect(thread.value!.thread.firstPost).toEqual(expected);
  const page = await f.call('GET', `/v1/threads/${scope.threadId}/posts?limit=100`);
  expect(page.response.status).toBe(200);
  expect(page.value!.posts.find((post: { id: string }) => post.id === first.id)).toEqual(expected);
  const erasedRevision = await f.call('GET', `/v1/posts/${first.id}/revisions/${first.revisionId}`, {
    bearer: f.author.bearer,
  });
  problem(erasedRevision, 404, 'not_found');
  const restore = await f.call('POST', `/v1/posts/${first.id}:restore`, { bearer: f.author.bearer, key: randomUUID() });
  problem(restore, 404, 'not_found');
}

test('Posts: durable author erasure operation, current authority and bounded recovery through actual native APIs and producer outcomes', async () => {
  const f = await createAuthorErasureFixture();
  try {
    const scope = await f.scope(205, 3, true);
    // One affected post also crosses the independent 100-revision cleanup page.
    for (let index = 0; index < 97; index++) await f.revise(scope.posts[0]!, `Private author long history ${index}`);
    scope.revisionCount += 97;
    const survivors = await otherRows(f, scope);
    expect(survivors).toHaveLength(scope.otherPosts.length * 2);
    const started = await start(f, scope);
    problem(await f.call('GET', `/v1/operations/${started.id}`), 404, 'not_found');
    problem(await status(f, started.id, f.other.bearer), 404, 'not_found');
    const running = await f.startWorker(true);
    await running.pageBoundary();
    const workflowId = await binding(f, started.id);
    const progress = await status(f, started.id);
    expect(progress.response.status).toBe(200);
    expect(progress.value).toEqual({
      name: started.initial.value!.name,
      done: false,
      metadata: metadata(scope, f.author.actor.accountId, 100, 398, 1),
    });
    expect((await authorRows(f, scope)).filter((row) => row.availability === 'erased')).toHaveLength(398);
    await noSecrets(f, scope, workflowId);
    // Kill only this fixture's executor, after a genuine committed page. Relaunch
    // the same supported worker identity; DBOS recovers its own native checkpoints.
    await f.stopWorker(true);
    await f.startWorker();
    const result = await f.client.retrieveWorkflow(workflowId).getResult({ pollingIntervalMs: 10 });
    expect(result).toEqual({ processedPosts: 205, erasedRevisions: scope.revisionCount });
    expect((await f.client.getWorkflow(workflowId))?.status).toBe('SUCCESS');
    const done = await status(f, started.id);
    expect(done.response.status).toBe(200);
    expect(done.value).toEqual({
      name: started.initial.value!.name,
      done: true,
      metadata: metadata(scope, f.author.actor.accountId, 205, scope.revisionCount, 3),
      response: result,
    });
    const erased = await authorRows(f, scope);
    expect(erased).toHaveLength(scope.revisionCount);
    for (const row of erased)
      expect(row).toMatchObject({
        availability: 'erased',
        revision_availability: 'erased',
        body: null,
        digest: null,
        search_text: null,
        deleted_at: null,
      });
    expect(await otherRows(f, scope)).toEqual(survivors);
    const media = (
      await f.pool.query('SELECT erased,claimed_item_id FROM content.media WHERE route=$1 AND media_id=$2', [
        scope.route,
        scope.mediaId,
      ])
    ).rows;
    expect(media).toEqual([{ erased: true, claimed_item_id: scope.posts[0]!.id }]);
    expect(f.objects.inspect().filter(({ key }) => key.startsWith(`m/${scope.mediaId}/`))).toEqual([]);
    await tombstone(f, scope);
    const before = await effects(f, scope);
    expect(before.operations).toHaveLength(1);
    expect(before.events.filter((event) => event.type === 'com.rezics.content.post.erased.v1')).toHaveLength(205);
    const replay = await f.call('POST', started.path, {
      body: started.body,
      key: started.key,
      bearer: f.author.bearer,
    });
    expect(replay.response.status).toBe(202);
    expect(replay.text).toBe(started.initial.text);
    expect(await effects(f, scope)).toEqual(before);
    expect(await authorRows(f, scope)).toEqual(erased);
    await noSecrets(f, scope, workflowId);
    // The committed creation receipt cannot restore an author's erased grant.
    const anchor = scope.posts[0]!;
    const owner = (
      await f.pool.query<{ valid: string }>(
        `SELECT valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3
       AND grant_role='content.post.owner'`,
        [scope.route, anchor.id, f.author.actor.accountId],
      )
    ).rows[0]!;
    await f.command(
      '/v1/roleGrants:revoke',
      {
        resource: { route: scope.route, id: anchor.id },
        subject: { kind: 'account', id: f.author.actor.accountId },
        role: 'content.post.owner',
        valid: owner.valid,
      },
      f.governance,
      200,
    );
    problem(
      await f.call('POST', started.path, { body: started.body, key: started.key, bearer: f.author.bearer }),
      403,
      'forbidden',
    );
    problem(await status(f, started.id), 404, 'not_found');
    expect(await effects(f, scope)).toEqual(before);
  } finally {
    await f.close();
  }
}, 240_000);

test('a revoked native post grant stops the next attributed page, retains truthful progress and returns google.rpc.Status', async () => {
  const f = await createAuthorErasureFixture();
  try {
    const scope = await f.scope(102, 3);
    const survivors = await otherRows(f, scope);
    const started = await start(f, scope);
    const running = await f.startWorker(true);
    await running.pageBoundary();
    const workflowId = await binding(f, started.id);
    const deniedPost = scope.posts[100]!;
    const grant = (
      await f.pool.query<{ valid: string }>(
        `SELECT valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3
       AND grant_role='content.post.owner'`,
        [scope.route, deniedPost.id, f.author.actor.accountId],
      )
    ).rows[0]!;
    await f.command(
      '/v1/roleGrants:revoke',
      {
        resource: { route: scope.route, id: deniedPost.id },
        subject: { kind: 'account', id: f.author.actor.accountId },
        role: 'content.post.owner',
        valid: grant.valid,
      },
      f.governance,
      200,
    );
    await running.release();
    await expect(f.client.retrieveWorkflow(workflowId).getResult({ pollingIntervalMs: 10 })).rejects.toMatchObject({
      name: 'ErasurePermissionDenied',
    });
    expect((await f.client.getWorkflow(workflowId))?.status).toBe('ERROR');
    const done = await status(f, started.id);
    expect(done.response.status).toBe(200);
    expect(done.response.headers.get('content-type')).toContain('application/json');
    expect(done.value).toEqual({
      name: started.initial.value!.name,
      done: true,
      metadata: metadata(scope, f.author.actor.accountId, 100, 300, 2),
      error: { code: 7, message: 'Permission denied' },
    });
    const rows = await authorRows(f, scope);
    expect(rows.filter((row) => row.availability === 'erased')).toHaveLength(300);
    for (const row of rows.slice(0, 300)) expect(row).toMatchObject({ body: null, digest: null, search_text: null });
    expect(rows.slice(300).every((row) => row.availability === 'available' && row.body !== null)).toBe(true);
    expect(await otherRows(f, scope)).toEqual(survivors);
    const before = await effects(f, scope);
    const replay = await f.call('POST', started.path, {
      bearer: f.author.bearer,
      key: started.key,
      body: started.body,
    });
    expect(replay.response.status).toBe(202);
    expect(replay.text).toBe(started.initial.text);
    expect((await status(f, started.id)).value).toEqual(done.value);
    problem(
      await f.call('POST', `/v1/posts/${deniedPost.id}:erase`, {
        bearer: f.author.bearer,
        key: randomUUID(),
        body: { reason: 'Current grant is revoked' },
      }),
      403,
      'forbidden',
    );
    expect(await effects(f, scope)).toEqual(before);
    await noSecrets(f, scope, workflowId);
  } finally {
    await f.close();
  }
}, 240_000);

test('real account suspension at a committed page invalidates the prior bearer and cannot restore workflow authority', async () => {
  const f = await createAuthorErasureFixture();
  try {
    const scope = await f.scope(102, 3);
    const survivors = await otherRows(f, scope);
    const started = await start(f, scope);
    const running = await f.startWorker(true);
    await running.pageBoundary();
    const workflowId = await binding(f, started.id);
    await f.command(
      `/v1/accounts/${f.author.actor.accountId}:suspend`,
      { reason: 'Native erasure step boundary' },
      f.governance,
      200,
    );
    await running.release();
    await expect(f.client.retrieveWorkflow(workflowId).getResult({ pollingIntervalMs: 10 })).rejects.toMatchObject({
      name: 'ErasurePermissionDenied',
    });
    expect(await f.client.getEvent(workflowId, CONTENT_OPERATION_PROGRESS, -1)).toEqual({
      processedPosts: 100,
      erasedRevisions: 300,
      steps: 2,
    });
    expect((await f.client.getWorkflow(workflowId))?.status).toBe('ERROR');
    const before = await effects(f, scope);
    // Accounts' native floor revokes this actual person's old bearer. A valid
    // bearer defensive-403 case would be a different authentication scenario.
    problem(await status(f, started.id), 401, 'invalid_credentials');
    problem(
      await f.call('POST', started.path, { bearer: f.author.bearer, key: started.key, body: started.body }),
      401,
      'invalid_credentials',
    );
    problem(
      await f.call('POST', `/v1/posts/${scope.posts[0]!.id}:restore`, { bearer: f.author.bearer, key: randomUUID() }),
      401,
      'invalid_credentials',
    );
    expect(await effects(f, scope)).toEqual(before);
    const rows = await authorRows(f, scope);
    expect(rows.filter((row) => row.availability === 'erased')).toHaveLength(300);
    expect(
      rows.slice(0, 300).every((row) => row.body === null && row.digest === null && row.search_text === null),
    ).toBe(true);
    expect(rows.slice(300).every((row) => row.availability === 'available' && row.body !== null)).toBe(true);
    expect(await otherRows(f, scope)).toEqual(survivors);
    await noSecrets(f, scope, workflowId);
  } finally {
    await f.close();
  }
}, 240_000);
