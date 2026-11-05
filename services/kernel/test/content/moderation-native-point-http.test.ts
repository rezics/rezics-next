import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { CommandUnavailableError } from '../../src/command/command.ts';
import nativeTakedown from '../../src/content/takedown.sql';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { observeSql } from './support/sql-observer.ts';
import {
  capturePointEvent,
  commandEvidence,
  createNativePointFixture,
  partitionHeads,
  pointPath,
  pointReason,
  problemShape,
  retainedRevisions,
  storedTarget,
  targetId,
  type NativePointFixture,
  type PointKind,
} from './moderation-native-point-fixture.ts';
import type { CallResult } from './reaction-relay-convergence-fixture.ts';

let fixture: NativePointFixture;
beforeAll(async () => {
  fixture = await createNativePointFixture();
  expect(
    new Set([
      fixture.author.accountId,
      fixture.other.accountId,
      fixture.reader.accountId,
      fixture.moderator.actor.accountId,
    ]).size,
  ).toBe(4);
}, 120_000);
afterAll(async () => {
  await fixture?.close();
});

function assertProblem(result: CallResult, status: number, code: string, effect = 'not_applied') {
  expect(result.response.status).toBe(status);
  expect(result.value).toMatchObject({ code, effect_status: effect });
  expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
  expect(result.value).not.toHaveProperty('securityRevision');
  expect(result.value).not.toHaveProperty('post');
  expect(result.value).not.toHaveProperty('thread');
}

for (const kind of ['board', 'thread', 'post'] as const) {
  test(`Native ${kind} takedown changes only its home, preserves evidence and conceals current exact reads`, async () => {
    const target = await fixture.fresh(`Native ${kind} target`, kind === 'board');
    const control = await fixture.fresh(`Surviving ${kind} control`);
    const pool = fixture.system.database.pool;
    const id = targetId(target, kind);
    await fixture.grant(id, ['moderation:takedown']);
    const before = await storedTarget(pool, kind, id);
    const untouched = await Promise.all(
      (['board', 'thread', 'post'] as const)
        .filter((otherKind) => otherKind !== kind)
        .map(async (otherKind) => ({
          kind: otherKind,
          id: targetId(target, otherKind),
          row: await storedTarget(pool, otherKind, targetId(target, otherKind)),
        })),
    );
    const replyBefore = await storedTarget(pool, 'post', target.replyId);
    const evidence = await retainedRevisions(pool, target.postId);
    const controlEvidence = await retainedRevisions(pool, control.postId);
    const controlRead = await fixture.call('GET', `/v1/posts/${control.postId}`);
    expect(controlRead.response.status).toBe(200);
    for (const bearer of [undefined, fixture.author.bearer, fixture.reader.bearer]) {
      const visible = await fixture.call('GET', `/v1/posts/${target.postId}`, bearer ? { bearer } : {});
      expect(visible.response.status).toBe(200);
      expect(visible.value!.post.body).not.toBeNull();
    }
    expect(target.threadRoute).toBe(target.postRoute);
    expect(partitionOf(target.threadRoute)).not.toBe(partitionOf(target.boardRoute));
    const readEvent = await capturePointEvent(pool, id);
    const heads = await partitionHeads(pool);
    const key = randomUUID();
    const observer = observeSql(pool);
    let result: CallResult;
    try {
      result = await fixture.call('POST', pointPath(kind, id), {
        body: pointReason,
        key,
        bearer: fixture.moderator.bearer,
      });
      expect(result.response.status).toBe(200);
      const writes = observer.records.filter(({ statement }) => statement === nativeTakedown.sql);
      expect(writes).toHaveLength(1);
      const args = Object.fromEntries(nativeTakedown.params.map((name, index) => [name, writes[0]!.parameters[index]]));
      expect(args).toMatchObject({ route: routeOf(id), kind, id });
    } finally {
      await observer.close();
    }
    const changedHeads = (await partitionHeads(pool)).filter((row, index) => row.position !== heads[index]!.position);
    expect(changedHeads.map((row) => row.partition_no)).toEqual([partitionOf(routeOf(id)!)]);
    const after = await storedTarget(pool, kind, id);
    expect(after.visibility).toBe('taken_down');
    for (const other of untouched) expect(await storedTarget(pool, other.kind, other.id)).toEqual(other.row);
    expect(await storedTarget(pool, 'post', target.replyId)).toEqual(replyBefore);
    expect(BigInt(after.security_revision)).toBe(BigInt(before.security_revision) + 1n);
    expect(result!.value!.securityRevision).toBe(String(after.security_revision));
    expect(await retainedRevisions(pool, target.postId)).toEqual(evidence);
    const envelope = await readEvent();
    expect(envelope.partition).toBe(partitionOf(routeOf(id)!));
    expect(envelope.events).toHaveLength(1);
    expect(envelope.events[0]!.type).toBe('com.rezics.content.moderation.takedown.v1');
    expect(envelope.events[0]!.data).toEqual({
      targetKind: kind,
      targetId: id,
      securityRevision: String(after.security_revision),
    });
    const committed = await commandEvidence(pool, fixture.moderator.actor.accountId, key, id);
    expect(committed.receipts).toHaveLength(1);
    expect(committed.events).toHaveLength(1);
    const replayHeads = await partitionHeads(pool);
    const replay = await fixture.call('POST', pointPath(kind, id), {
      body: pointReason,
      key,
      bearer: fixture.moderator.bearer,
    });
    expect(replay.response.status).toBe(200);
    expect(replay.value).toEqual(result!.value);
    expect(replay.response.headers.get(SESSION_HEADER)).toBe(result!.response.headers.get(SESSION_HEADER));
    expect(await commandEvidence(pool, fixture.moderator.actor.accountId, key, id)).toEqual(committed);
    expect(await partitionHeads(pool)).toEqual(replayHeads);

    for (const bearer of [undefined, fixture.author.bearer, fixture.reader.bearer, fixture.other.bearer]) {
      const options = bearer ? { bearer } : {};
      for (const revision of target.revisions) {
        const hidden = await fixture.call('GET', `/v1/posts/${target.postId}/revisions/${revision}`, options);
        assertProblem(hidden, 404, 'not_found', 'not_applicable');
        expect(hidden.text).not.toContain(target.sentinel);
        const unknown = await fixture.call(
          'GET',
          `/v1/posts/${newId(target.postRoute)}/revisions/${revision}`,
          options,
        );
        expect(problemShape(hidden)).toEqual(problemShape(unknown));
      }
      assertProblem(
        await fixture.call('GET', `/v1/posts/${target.postId}/revisions`, options),
        404,
        'not_found',
        'not_applicable',
      );
      const hidden = await fixture.call('GET', `/v1/posts/${target.postId}`, options);
      assertProblem(hidden, 404, 'not_found', 'not_applicable');
      const page = await fixture.call('GET', `/v1/threads/${target.threadId}/posts?limit=20`, options);
      if (kind === 'post') {
        expect(page.response.status).toBe(200);
        const withheld = page.value!.posts.find((post: { id: string }) => post.id === target.postId);
        expect(withheld).toMatchObject({
          id: target.postId,
          availability: 'withheld',
          removed: true,
          body: null,
          sha256: null,
        });
        expect(withheld).not.toHaveProperty('restorableUntil');
        if (bearer === fixture.author.bearer) expect(withheld.decisionId).toBeString();
        else expect(withheld).not.toHaveProperty('decisionId');
        expect(page.text).not.toContain(target.sentinel);
      } else {
        assertProblem(page, 404, 'not_found', 'not_applicable');
        assertProblem(
          await fixture.call('GET', `/v1/posts/${target.replyId}`, options),
          404,
          'not_found',
          'not_applicable',
        );
        const boardList = await fixture.call('GET', `/v1/boards/${target.boardId}/threads?limit=20`, options);
        if (kind === 'board') assertProblem(boardList, 404, 'not_found', 'not_applicable');
        else {
          expect(boardList.response.status).toBe(200);
          expect(boardList.value!.threads.map((thread: { id: string }) => thread.id)).not.toContain(target.threadId);
        }
      }
    }
    expect((await fixture.call('GET', `/v1/posts/${control.postId}`)).value).toEqual(controlRead.value);
    expect(await retainedRevisions(pool, control.postId)).toEqual(controlEvidence);
  }, 90_000);
}

test('Native authority revocation denies replay before the stored receipt without an extra effect', async () => {
  const target = await fixture.fresh('Revoked moderator');
  const id = target.threadId;
  const grant = await fixture.grant(id, ['moderation:takedown']);
  const key = randomUUID();
  const first = await fixture.call('POST', pointPath('thread', id), {
    key,
    body: pointReason,
    bearer: fixture.moderator.bearer,
  });
  expect(first.response.status).toBe(200);
  const pool = fixture.system.database.pool;
  const committed = await commandEvidence(pool, fixture.moderator.actor.accountId, key, id);
  await fixture.command('POST', '/v1/grants:revoke', grant, { bearer: fixture.governance.bearer, expectedStatus: 200 });
  const heads = await partitionHeads(pool);
  const denied = await fixture.call('POST', pointPath('thread', id), {
    key,
    body: pointReason,
    bearer: fixture.moderator.bearer,
  });
  assertProblem(denied, 403, 'forbidden');
  expect(await commandEvidence(pool, fixture.moderator.actor.accountId, key, id)).toEqual(committed);
  expect(await partitionHeads(pool)).toEqual(heads);
});

test('Native strangers and a real suspended prior bearer disclose no command payload for any target kind', async () => {
  const target = await fixture.fresh('Denial control');
  const pool = fixture.system.database.pool;
  for (const kind of ['board', 'thread', 'post'] as PointKind[]) {
    const id = targetId(target, kind);
    await fixture.grant(id, ['moderation:takedown'], fixture.system.actors.suspended.actor.accountId);
    const before = await storedTarget(pool, kind, id);
    const heads = await partitionHeads(pool);
    for (const [bearer, status, code] of [
      [fixture.other.bearer, 403, 'forbidden'],
      [fixture.system.actors.suspended.bearer, 401, 'invalid_credentials'],
    ] as const) {
      const key = randomUUID();
      const result = await fixture.call('POST', pointPath(kind, id), { body: pointReason, key, bearer });
      assertProblem(result, status, code);
      expect(result.text).not.toContain(target.sentinel);
      if (code === 'invalid_credentials')
        assertProblem(
          await fixture.call('GET', `/v1/posts/${target.postId}`, { bearer }),
          401,
          'invalid_credentials',
          'not_applicable',
        );
      expect(
        await commandEvidence(
          pool,
          bearer === fixture.other.bearer ? fixture.other.accountId : fixture.system.actors.suspended.actor.accountId,
          key,
          id,
        ),
      ).toEqual({ receipts: [], events: [] });
    }
    expect(await storedTarget(pool, kind, id)).toEqual(before);
    expect(await partitionHeads(pool)).toEqual(heads);
  }
});

test('Malformed and unknown identities and deadline-unavailable commands leave no receipt or target effect', async () => {
  const target = await fixture.fresh('Failure control');
  const pool = fixture.system.database.pool;
  await fixture.grant(target.postId, ['moderation:takedown']);
  for (const kind of ['board', 'thread', 'post'] as const) {
    for (const id of ['not-an-id', newId(routeOf(targetId(target, kind))!)]) {
      const response = await fixture.call('POST', pointPath(kind, id), {
        body: pointReason,
        key: randomUUID(),
        bearer: fixture.moderator.bearer,
      });
      assertProblem(response, 403, 'forbidden');
    }
    const invalid = await fixture.call('GET', `/v1/${kind}s/not-an-id`);
    assertProblem(invalid, 404, 'not_found', 'not_applicable');
    const unknown = await fixture.call('GET', `/v1/${kind}s/${newId(routeOf(targetId(target, kind))!)}`);
    assertProblem(unknown, 404, 'not_found', 'not_applicable');
  }
  const before = await storedTarget(pool, 'post', target.postId);
  const observer = observeSql(pool);
  const key = randomUUID();
  const heads = await partitionHeads(pool);
  try {
    observer.armFault({
      match: { statement: nativeTakedown.sql },
      boundary: 'before',
      error: new CommandUnavailableError('deadline', partitionOf(target.postRoute)),
    });
    const unavailable = await fixture.call('POST', pointPath('post', target.postId), {
      body: pointReason,
      key,
      bearer: fixture.moderator.bearer,
    });
    assertProblem(unavailable, 503, 'deadline_exceeded');
    expect(observer.records.some(({ statement }) => /^ROLLBACK/.test(statement))).toBe(true);
  } finally {
    await observer.close();
  }
  expect(await storedTarget(pool, 'post', target.postId)).toEqual(before);
  expect(await partitionHeads(pool)).toEqual(heads);
  expect(await commandEvidence(pool, fixture.moderator.actor.accountId, key, target.postId)).toEqual({
    receipts: [],
    events: [],
  });
});

test('Author restore preserves canonical history while irreversible point erasure completes native NULL cleanup', async () => {
  const restored = await fixture.fresh('Restorable author post');
  const erased = await fixture.fresh('Immediate point erasure');
  const pool = fixture.system.database.pool;
  const canonical = await retainedRevisions(pool, restored.postId);
  const available = await fixture.call('GET', `/v1/posts/${restored.postId}`);
  await fixture.command('DELETE', `/v1/posts/${restored.postId}`, undefined);
  expect(await retainedRevisions(pool, restored.postId)).toEqual(canonical);
  const deleted = await fixture.call('GET', `/v1/posts/${restored.postId}`, { bearer: fixture.author.bearer });
  expect(deleted.response.status).toBe(200);
  expect(deleted.value!.post).toMatchObject({
    id: restored.postId,
    removed: true,
    body: null,
    sha256: null,
    availability: 'erased',
  });
  expect(deleted.value!.post.restorableUntil).toBeString();
  for (const revision of restored.revisions)
    assertProblem(
      await fixture.call('GET', `/v1/posts/${restored.postId}/revisions/${revision}`),
      404,
      'not_found',
      'not_applicable',
    );
  await fixture.command('POST', `/v1/posts/${restored.postId}:restore`, undefined, { expectedStatus: 204 });
  expect(await retainedRevisions(pool, restored.postId)).toEqual(canonical);
  const restoredRead = await fixture.call('GET', `/v1/posts/${restored.postId}`);
  expect(restoredRead.response.status).toBe(200);
  expect(restoredRead.value!.post).toEqual({
    ...available.value!.post,
    securityRevision: String(BigInt(available.value!.post.securityRevision) + 2n),
  });

  const evidence = await retainedRevisions(pool, erased.postId);
  await fixture.grant(erased.postId, ['post:read']);
  await fixture.grant(erased.threadId, ['thread:read']);
  const exactBefore = new Map<string, Record<string, any>>();
  for (const revision of erased.revisions) {
    const exact = await fixture.call('GET', `/v1/posts/${erased.postId}/revisions/${revision}`, {
      bearer: fixture.moderator.bearer,
    });
    expect(exact.response.status).toBe(200);
    exactBefore.set(revision, exact.value!.post);
  }
  const readEvent = await capturePointEvent(pool, erased.postId);
  const key = randomUUID();
  const result = await fixture.call('POST', `/v1/posts/${erased.postId}:erase`, {
    body: pointReason,
    key,
    bearer: fixture.author.bearer,
  });
  expect(result.response.status).toBe(200);
  const event = await readEvent();
  expect(event.events).toHaveLength(1);
  expect(event.events[0]!.type).toBe('com.rezics.content.post.erased.v1');
  expect(event.events[0]!.data).toEqual({ postId: erased.postId, securityRevision: result.value!.securityRevision });
  const runtime = await fixture.startWork();
  await runtime.produce(event, ['content_post_erased']);
  const cleaned = await retainedRevisions(pool, erased.postId);
  expect(cleaned).toHaveLength(evidence.length);
  for (const [index, row] of cleaned.entries())
    expect(row).toEqual({
      ...evidence[index],
      body: null,
      body_sha256: null,
      search_text: null,
      availability: 'erased',
    });
  const beforeReplay = await commandEvidence(pool, fixture.author.accountId, key, erased.postId);
  const replay = await fixture.call('POST', `/v1/posts/${erased.postId}:erase`, {
    body: pointReason,
    key,
    bearer: fixture.author.bearer,
  });
  expect(replay.response.status).toBe(200);
  expect(replay.value).toEqual(result.value);
  expect(await commandEvidence(pool, fixture.author.accountId, key, erased.postId)).toEqual(beforeReplay);
  await runtime.produce(event, ['content_post_erased']);
  expect(await retainedRevisions(pool, erased.postId)).toEqual(cleaned);
  for (const revision of erased.revisions) {
    const exact = await fixture.call('GET', `/v1/posts/${erased.postId}/revisions/${revision}`, {
      bearer: fixture.moderator.bearer,
    });
    expect(exact.response.status).toBe(200);
    expect(exact.value!.post).toEqual({
      ...exactBefore.get(revision),
      securityRevision: result.value!.securityRevision,
      removed: true,
      body: null,
      sha256: null,
      availability: 'erased',
      voteCitation: null,
    });
    for (const bearer of [undefined, fixture.other.bearer])
      assertProblem(
        await fixture.call('GET', `/v1/posts/${erased.postId}/revisions/${revision}`, bearer ? { bearer } : {}),
        404,
        'not_found',
        'not_applicable',
      );
  }
  assertProblem(
    await fixture.call('POST', `/v1/posts/${erased.postId}:restore`, {
      key: randomUUID(),
      bearer: fixture.author.bearer,
    }),
    404,
    'not_found',
  );
  expect(await retainedRevisions(pool, restored.postId)).toEqual(canonical);
}, 120_000);
