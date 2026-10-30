import { afterAll, expect, test } from 'bun:test';
import { partitionOf, routeOf, newId } from '../../src/route/route.ts';
import { seedGovernanceAuthority } from './support/disclosure-fixtures.ts';
import {
  comparePosition,
  createReactionRelayBase,
  snapshotReactionOperation,
  targetFreshness,
  targetProjectionRows,
  type CallResult,
  type NativePerson,
  type Position,
  type ReactionRelayBase,
  type ReactionTarget,
  type ReactionWorkRuntime,
  type ReactionEventCapture,
} from './reaction-relay-convergence-fixture.ts';

let base: ReactionRelayBase | undefined;
let runtime: ReactionWorkRuntime | undefined;

afterAll(async () => {
  await runtime?.stop();
  await base?.system.close();
});

type Counts = Readonly<Record<string, number>>;
type Viewer = 'like' | 'love' | null;

type ThreadRead = {
  thread: { id: string; reactions: Counts; viewerReaction?: Viewer };
  reactionsAsOf: Position | null;
};
type PostsRead = {
  posts: { id: string; reactions: Counts; viewerReaction?: Viewer }[];
  reactionsAsOf: Position | null;
};
type CommittedChange = Readonly<{
  actor: NativePerson;
  targetId: string;
  targetPartition: number;
  targetPosition: Position;
  sourcePosition: Position;
  relayBefore: Position | null;
  capture: ReactionEventCapture;
  envelope: Awaited<ReturnType<ReactionEventCapture['read']>>['envelope'];
  event: Awaited<ReturnType<ReactionEventCapture['read']>>['event'];
  eventSeq: number;
}>;

function expectCounts(result: CallResult, counts: Counts): void {
  expect(result.response.status).toBe(200);
  expect(result.value).not.toBeNull();
  const body = result.value as Record<string, any>;
  if ('thread' in body) expect(body.thread.reactions).toEqual(counts);
  else if ('posts' in body) expect(body.posts[0]?.reactions).toEqual(counts);
  else throw new Error('The current read DTO did not return a thread or post page');
}

async function getThread(base: ReactionRelayBase, target: ReactionTarget, bearer?: string): Promise<CallResult> {
  return base.call('GET', `/v1/threads/${target.threadId}`, bearer ? { bearer } : {});
}

async function getPosts(base: ReactionRelayBase, target: ReactionTarget, bearer?: string): Promise<CallResult> {
  return base.call('GET', `/v1/threads/${target.threadId}/posts?limit=100`, bearer ? { bearer } : {});
}

async function expectThreadRead(
  base: ReactionRelayBase,
  target: ReactionTarget,
  actorA: NativePerson,
  actorAReaction: Viewer,
  actorB: NativePerson,
  actorBReaction: Viewer,
  counts: Counts,
  freshness: Position | null,
): Promise<void> {
  const [a, b, anonymous] = await Promise.all([
    getThread(base, target, actorA.bearer),
    getThread(base, target, actorB.bearer),
    getThread(base, target),
  ]);
  for (const result of [a, b, anonymous]) expectCounts(result, counts);
  expect((a.value as ThreadRead).thread.viewerReaction).toBe(actorAReaction);
  expect((b.value as ThreadRead).thread.viewerReaction).toBe(actorBReaction);
  expect((anonymous.value as ThreadRead).thread).not.toHaveProperty('viewerReaction');
  expect((a.value as ThreadRead).reactionsAsOf).toEqual(freshness);
  expect((b.value as ThreadRead).reactionsAsOf).toEqual(freshness);
  expect((anonymous.value as ThreadRead).reactionsAsOf).toEqual(freshness);
}

async function expectPostRead(
  base: ReactionRelayBase,
  target: ReactionTarget,
  actorA: NativePerson,
  actorAReaction: Viewer,
  actorB: NativePerson,
  actorBReaction: Viewer,
  counts: Counts,
  freshness: Position | null,
): Promise<void> {
  const [a, b, anonymous] = await Promise.all([
    getPosts(base, target, actorA.bearer),
    getPosts(base, target, actorB.bearer),
    getPosts(base, target),
  ]);
  for (const result of [a, b, anonymous]) expectCounts(result, counts);
  const as = (a.value as PostsRead).posts[0];
  const bs = (b.value as PostsRead).posts[0];
  const publicPost = (anonymous.value as PostsRead).posts[0];
  expect(as).toMatchObject({ id: target.postId, viewerReaction: actorAReaction });
  expect(bs).toMatchObject({ id: target.postId, viewerReaction: actorBReaction });
  expect(publicPost).not.toHaveProperty('viewerReaction');
  expect((a.value as PostsRead).reactionsAsOf).toEqual(freshness);
  expect((b.value as PostsRead).reactionsAsOf).toEqual(freshness);
  expect((anonymous.value as PostsRead).reactionsAsOf).toEqual(freshness);
}

async function commitWhilePaused(
  base: ReactionRelayBase,
  runtime: ReactionWorkRuntime,
  actor: NativePerson,
  targetId: string,
  path: string,
  kind: 'like' | 'love' | null,
): Promise<CommittedChange> {
  const capture = await runtime.captureBeforeWrite(actor.accountId);
  const targetRoute = routeOf(targetId);
  if (targetRoute === null) throw new Error('Reaction target is not routed');
  const targetPartition = partitionOf(targetRoute);
  const targetPosition = await runtime.partitionPosition(targetPartition);
  const sourcePartition = partitionOf(routeOf(actor.accountId)!);
  const relayBefore = await runtime.relayCheckpoint(sourcePartition);
  const key = crypto.randomUUID();
  const response = await base.call(kind === null ? 'DELETE' : 'PUT', path, {
    bearer: actor.bearer,
    key,
    ...(kind === null ? {} : { body: { kind } }),
  });
  expect(response.response.status).toBe(kind === null ? 204 : 200);
  if (kind !== null) expect(response.value).toEqual({ kind });
  else expect(response.text).toBe('');
  const { envelope, event, eventSeq } = await capture.read();
  expect(envelope.partition).toBe(sourcePartition);
  expect(event.type).toBe('com.rezics.content.reaction.changed.v1');
  expect(event.data).toMatchObject({ actorId: actor.accountId, targetId, kind });
  const sourcePosition = await runtime.partitionPosition(sourcePartition);
  expect(sourcePosition).toEqual({ epoch: envelope.epoch, position: envelope.position.toString() });
  expect(await runtime.relayCheckpoint(sourcePartition)).toEqual(relayBefore);
  expect(targetPartition).not.toBe(sourcePartition);
  expect(await runtime.partitionPosition(targetPartition)).toEqual(targetPosition);
  return {
    actor,
    targetId,
    targetPartition,
    targetPosition,
    sourcePosition,
    relayBefore,
    capture,
    envelope,
    event,
    eventSeq,
  };
}

async function waitForChanges(runtime: ReactionWorkRuntime, changes: readonly CommittedChange[]): Promise<void> {
  await runtime.resume();
  for (const change of changes) await runtime.waitForEffect(change.envelope, change.eventSeq);
  for (const change of changes) {
    const checkpoint = await runtime.relayCheckpoint(change.envelope.partition);
    expect(checkpoint).not.toBeNull();
    expect(
      comparePosition(checkpoint, { epoch: change.envelope.epoch, position: change.envelope.position.toString() }),
    ).toBeGreaterThanOrEqual(0);
    expect(await runtime.partitionPosition(change.targetPartition)).toEqual(change.targetPosition);
  }
  await runtime.pause();
}

async function setReaction(
  base: ReactionRelayBase,
  runtime: ReactionWorkRuntime,
  actor: NativePerson,
  targetId: string,
  path: string,
  kind: 'like' | 'love' | null,
): Promise<CommittedChange> {
  await runtime.pause();
  const result = await commitWhilePaused(base, runtime, actor, targetId, path, kind);
  return result;
}

async function freshness(base: ReactionRelayBase, targetId: string): Promise<Position | null> {
  return targetFreshness(base.system.database.pool, targetId);
}

async function grantRead(
  base: ReactionRelayBase,
  target: { route: number; id: string },
  person: NativePerson,
  actions: readonly string[],
): Promise<void> {
  for (const action of actions)
    await base.system.database.pool.query(
      `INSERT INTO access.resource_grant
         (route, resource_id, subject_kind, subject_id, subject_role, action, valid, transaction_id)
       VALUES ($1, $2, 'identity', $3, '', $4, '(,)'::tstzrange, $5)`,
      [target.route, target.id, person.accountId, action, crypto.randomUUID()],
    );
}

async function concealmentControl(
  base: ReactionRelayBase,
  target: ReactionTarget,
  viewer: NativePerson,
): Promise<void> {
  for (const result of [await getThread(base, target, viewer.bearer), await getPosts(base, target, viewer.bearer)]) {
    expect(result.response.status).toBe(404);
    expect(result.value).toMatchObject({ code: 'not_found' });
    expect(result.text).not.toContain('viewerReaction');
    expect(result.text).not.toContain('reactionsAsOf');
    expect(result.text).not.toContain('"reactions"');
    expect(result.text).not.toContain('"like"');
    expect(result.text).not.toContain('"love"');
  }
}

test.serial(
  'Posts, threads and boards: current viewer reactions and target aggregates converge through real routed effects.',
  async () => {
    // The narrower owner suites check viewer-only writes and projection-only reads; this joins actual HTTP commands,
    // current DTO readers, the registered production effect and its real relay.
    base = await createReactionRelayBase();
    const publicTarget = base.mainTarget;
    const draftTarget = await base.createThread(
      base.mainBoardId,
      `Reaction target concealment ${crypto.randomUUID()}`,
      'draft',
    );
    const protectedBoardTarget = await base.createRealmTarget(
      `Protected board thread ${crypto.randomUUID()}`,
      'public',
      'protected',
    );
    const protectedRealmTarget = await base.createRealmTarget(
      `Protected reaction Realm ${crypto.randomUUID()}`,
      'protected',
    );
    const permittedRealmTarget = await base.createRealmTarget(
      `Permitted reaction Realm ${crypto.randomUUID()}`,
      'protected',
    );
    for (const [route, id, actions] of [
      [routeOf(permittedRealmTarget.realmId)!, permittedRealmTarget.realmId, ['realm:read']],
      [permittedRealmTarget.boardRoute, permittedRealmTarget.boardId, ['board:read']],
      [permittedRealmTarget.threadRoute, permittedRealmTarget.threadId, ['thread:read']],
      [permittedRealmTarget.postRoute, permittedRealmTarget.postId, ['post:read']],
    ] as const)
      await grantRead(base, { route, id }, base.other, actions);

    runtime = await base.startEffects();
    const sourceA = partitionOf(routeOf(base.author.accountId)!);
    const sourceB = partitionOf(routeOf(base.other.accountId)!);
    const targetPartition = partitionOf(publicTarget.threadRoute);
    expect(sourceA).not.toBe(targetPartition);
    expect(sourceB).not.toBe(targetPartition);
    expect(publicTarget.threadRoute).not.toBe(routeOf(base.author.accountId));
    expect(publicTarget.threadRoute).not.toBe(routeOf(base.other.accountId));

    await expectThreadRead(base, publicTarget, base.author, null, base.other, null, {}, null);
    await expectPostRead(base, publicTarget, base.author, null, base.other, null, {}, null);

    // Hold actual effects delivery while both accounts commit independent events to one target.
    await runtime.pause();
    const initialCheckpoints = new Map<number, Position | null>();
    for (const partition of new Set([sourceA, sourceB]))
      initialCheckpoints.set(partition, await runtime.relayCheckpoint(partition));
    const threadLikeA = await commitWhilePaused(
      base,
      runtime,
      base.author,
      publicTarget.threadId,
      `/v1/threads/${publicTarget.threadId}/reaction`,
      'like',
    );
    const threadLikeB = await commitWhilePaused(
      base,
      runtime,
      base.other,
      publicTarget.threadId,
      `/v1/threads/${publicTarget.threadId}/reaction`,
      'like',
    );
    for (const partition of new Set([sourceA, sourceB])) {
      expect(initialCheckpoints.has(partition)).toBe(true);
      expect(await runtime.relayCheckpoint(partition)).toEqual(initialCheckpoints.get(partition) ?? null);
    }
    await expectThreadRead(base, publicTarget, base.author, 'like', base.other, 'like', {}, null);
    await waitForChanges(runtime, [threadLikeA, threadLikeB]);
    const threadProjectionBeforeReplay = await targetProjectionRows(base.system.database.pool, publicTarget.threadId);
    const threadFreshness = await freshness(base, publicTarget.threadId);
    expect(threadFreshness).not.toBeNull();
    await expectThreadRead(base, publicTarget, base.author, 'like', base.other, 'like', { like: 2 }, threadFreshness);
    for (const change of [threadLikeA, threadLikeB]) await runtime.replay(change.event);
    expect(await targetProjectionRows(base.system.database.pool, publicTarget.threadId)).toEqual(
      threadProjectionBeforeReplay,
    );
    await expectThreadRead(base, publicTarget, base.author, 'like', base.other, 'like', { like: 2 }, threadFreshness);

    const threadLoveA = await setReaction(
      base,
      runtime,
      base.author,
      publicTarget.threadId,
      `/v1/threads/${publicTarget.threadId}/reaction`,
      'love',
    );
    const staleThreadFreshness = await freshness(base, publicTarget.threadId);
    await expectThreadRead(
      base,
      publicTarget,
      base.author,
      'love',
      base.other,
      'like',
      { like: 2 },
      staleThreadFreshness,
    );
    await waitForChanges(runtime, [threadLoveA]);
    const lovedThreadFreshness = await freshness(base, publicTarget.threadId);
    await expectThreadRead(
      base,
      publicTarget,
      base.author,
      'love',
      base.other,
      'like',
      { like: 1, love: 1 },
      lovedThreadFreshness,
    );

    const threadClearA = await setReaction(
      base,
      runtime,
      base.author,
      publicTarget.threadId,
      `/v1/threads/${publicTarget.threadId}/reaction`,
      null,
    );
    await expectThreadRead(
      base,
      publicTarget,
      base.author,
      null,
      base.other,
      'like',
      { like: 1, love: 1 },
      await freshness(base, publicTarget.threadId),
    );
    await waitForChanges(runtime, [threadClearA]);
    const clearedThreadFreshness = await freshness(base, publicTarget.threadId);
    await expectThreadRead(
      base,
      publicTarget,
      base.author,
      null,
      base.other,
      'like',
      { like: 1 },
      clearedThreadFreshness,
    );

    // The same joined sequence on the HTTP-created first post checks the page DTO's private slot and public totals.
    await expectPostRead(base, publicTarget, base.author, null, base.other, null, {}, null);
    const postLikeA = await commitWhilePaused(
      base,
      runtime,
      base.author,
      publicTarget.postId,
      `/v1/posts/${publicTarget.postId}/reaction`,
      'like',
    );
    const postLikeB = await commitWhilePaused(
      base,
      runtime,
      base.other,
      publicTarget.postId,
      `/v1/posts/${publicTarget.postId}/reaction`,
      'like',
    );
    await expectPostRead(base, publicTarget, base.author, 'like', base.other, 'like', {}, null);
    await waitForChanges(runtime, [postLikeA, postLikeB]);
    const postProjectionBeforeReplay = await targetProjectionRows(base.system.database.pool, publicTarget.postId);
    const postFreshness = await freshness(base, publicTarget.postId);
    expect(postFreshness).not.toBeNull();
    await expectPostRead(base, publicTarget, base.author, 'like', base.other, 'like', { like: 2 }, postFreshness);
    for (const change of [postLikeA, postLikeB]) await runtime.replay(change.event);
    expect(await targetProjectionRows(base.system.database.pool, publicTarget.postId)).toEqual(
      postProjectionBeforeReplay,
    );

    const postLoveA = await setReaction(
      base,
      runtime,
      base.author,
      publicTarget.postId,
      `/v1/posts/${publicTarget.postId}/reaction`,
      'love',
    );
    await expectPostRead(base, publicTarget, base.author, 'love', base.other, 'like', { like: 2 }, postFreshness);
    await waitForChanges(runtime, [postLoveA]);
    const lovedPostFreshness = await freshness(base, publicTarget.postId);
    await expectPostRead(
      base,
      publicTarget,
      base.author,
      'love',
      base.other,
      'like',
      { like: 1, love: 1 },
      lovedPostFreshness,
    );

    const postClearA = await setReaction(
      base,
      runtime,
      base.author,
      publicTarget.postId,
      `/v1/posts/${publicTarget.postId}/reaction`,
      null,
    );
    await expectPostRead(
      base,
      publicTarget,
      base.author,
      null,
      base.other,
      'like',
      { like: 1, love: 1 },
      lovedPostFreshness,
    );
    await waitForChanges(runtime, [postClearA]);
    const clearedPostFreshness = await freshness(base, publicTarget.postId);
    await expectPostRead(base, publicTarget, base.author, null, base.other, 'like', { like: 1 }, clearedPostFreshness);

    // A changed semantic intent conflicts before changing the actor slot, receipt, event or public aggregate.
    const guarded = await base.createThread(base.mainBoardId, `Reaction idempotency ${crypto.randomUUID()}`);
    const guardedPath = `/v1/threads/${guarded.threadId}/reaction`;
    const guardedKey = crypto.randomUUID();
    const capture = await runtime.captureBeforeWrite(base.other.accountId);
    const accepted = await base.call('PUT', guardedPath, {
      bearer: base.other.bearer,
      key: guardedKey,
      body: { kind: 'like' },
    });
    expect(accepted.response.status).toBe(200);
    const guardedEvent = await capture.read();
    await waitForChanges(runtime, [
      {
        actor: base.other,
        targetId: guarded.threadId,
        targetPartition: partitionOf(guarded.threadRoute),
        targetPosition: await runtime.partitionPosition(partitionOf(guarded.threadRoute)),
        sourcePosition: await runtime.partitionPosition(guardedEvent.envelope.partition),
        relayBefore: null,
        capture,
        ...guardedEvent,
      },
    ]);
    const beforeConflict = await snapshotReactionOperation(
      base.system.database.pool,
      base.other.accountId,
      guarded.threadId,
      guardedKey,
    );
    const conflict = await base.call('PUT', guardedPath, {
      bearer: base.other.bearer,
      key: guardedKey,
      body: { kind: 'love' },
    });
    expect(conflict.response.status).toBe(422);
    expect(conflict.value).toMatchObject({ code: 'idempotency_conflict', effect_status: 'not_applied' });
    expect(
      await snapshotReactionOperation(base.system.database.pool, base.other.accountId, guarded.threadId, guardedKey),
    ).toEqual(beforeConflict);

    const standing = await base.system.database.pool.query<{ valid: string }>(
      `SELECT valid::text AS valid FROM access.resource_role_grant
        WHERE route=$1 AND resource_id=$2 AND subject_kind='active_accounts'
          AND grant_role='content.thread.standing'`,
      [guarded.threadRoute, guarded.threadId],
    );
    expect(standing.rows).toHaveLength(1);
    const roleBody = {
      resource: { route: guarded.threadRoute, id: guarded.threadId },
      subject: { kind: 'active_accounts' },
      role: 'content.thread.standing',
      valid: standing.rows[0]!.valid,
    };
    await seedGovernanceAuthority(
      base.system.database.pool,
      guarded.threadRoute,
      guarded.threadId,
      base.governance.accountId,
      ['post:create', 'media:create', 'reaction:set', 'report:create'],
    );
    await base.command('POST', '/v1/roleGrants:revoke', roleBody, {
      method: 'POST',
      bearer: base.governance.bearer,
      expectedStatus: 200,
    });
    const deniedReplay = await base.call('PUT', guardedPath, {
      bearer: base.other.bearer,
      key: guardedKey,
      body: { kind: 'like' },
    });
    expect(deniedReplay.response.status).toBe(403);
    expect(deniedReplay.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
    expect(deniedReplay.text).not.toContain('"kind":"like"');
    expect(
      await snapshotReactionOperation(base.system.database.pool, base.other.accountId, guarded.threadId, guardedKey),
    ).toEqual(beforeConflict);
    await base.command('POST', '/v1/roleGrants', roleBody, {
      bearer: base.governance.bearer,
      expectedStatus: 201,
    });
    const restoredReplay = await base.call('PUT', guardedPath, {
      bearer: base.other.bearer,
      key: guardedKey,
      body: { kind: 'like' },
    });
    expect(restoredReplay.response.status).toBe(200);
    expect(restoredReplay.value).toEqual({ kind: 'like' });
    expect(
      await snapshotReactionOperation(base.system.database.pool, base.other.accountId, guarded.threadId, guardedKey),
    ).toEqual(beforeConflict);
    const guardedCounts = await getThread(base, guarded, base.other.bearer);
    expect(guardedCounts.response.status).toBe(200);
    expect((guardedCounts.value as ThreadRead).thread.reactions).toEqual({ like: 1 });

    // Strict production request DTO failures and mismatched/unknown targets do not leave command evidence behind.
    const errorTarget = await base.createThread(base.mainBoardId, `Reaction rejection ${crypto.randomUUID()}`);
    const errorPath = `/v1/threads/${errorTarget.threadId}/reaction`;
    const noPriorWrite = await snapshotReactionOperation(
      base.system.database.pool,
      base.author.accountId,
      errorTarget.threadId,
      'no-prior-key',
    );
    const malformed = await base.call('PUT', errorPath, {
      bearer: base.author.bearer,
      key: crypto.randomUUID(),
      rawBody: '{',
    });
    expect(malformed.response.status).toBe(400);
    expect(malformed.value).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
    const unsupported = await base.call('PUT', errorPath, {
      bearer: base.author.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'wow' },
    });
    expect(unsupported.response.status).toBe(400);
    expect(unsupported.value).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
    const malformedDto = await base.call('PUT', errorPath, {
      bearer: base.author.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'like', unexpected: true },
    });
    expect(malformedDto.response.status).toBe(400);
    expect(malformedDto.value).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
    const mismatch = await base.call('PUT', `/v1/threads/${errorTarget.postId}/reaction`, {
      bearer: base.author.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'like' },
    });
    expect(mismatch.response.status).toBe(404);
    expect(mismatch.value).toMatchObject({ code: 'not_found', effect_status: 'not_applied' });
    const unknownId = newId(errorTarget.threadRoute);
    const unknown = await base.call('PUT', `/v1/threads/${unknownId}/reaction`, {
      bearer: base.author.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'like' },
    });
    expect(unknown.response.status).toBe(404);
    expect(unknown.value).toMatchObject({ code: 'not_found', effect_status: 'not_applied' });
    expect(
      await snapshotReactionOperation(
        base.system.database.pool,
        base.author.accountId,
        errorTarget.threadId,
        'no-prior-key',
      ),
    ).toEqual(noPriorWrite);
    const noWriteView = await getThread(base, errorTarget, base.author.bearer);
    expect((noWriteView.value as ThreadRead).thread.viewerReaction).toBeNull();
    expect((noWriteView.value as ThreadRead).thread.reactions).toEqual({});
    expect((noWriteView.value as ThreadRead).reactionsAsOf).toBeNull();

    // Use the actual reader on denied ancestors and Realms; the same reads still disclose permitted controls.
    const hiddenDraft = await setReaction(
      base,
      runtime,
      base.author,
      draftTarget.threadId,
      `/v1/threads/${draftTarget.threadId}/reaction`,
      'love',
    );
    await waitForChanges(runtime, [hiddenDraft]);
    await concealmentControl(base, draftTarget, base.other);
    const ownerDraft = await getThread(base, draftTarget, base.author.bearer);
    expect(ownerDraft.response.status).toBe(200);
    expect((ownerDraft.value as ThreadRead).thread.viewerReaction).toBe('love');
    expect((ownerDraft.value as ThreadRead).thread.reactions).toEqual({ love: 1 });

    const hiddenBoard = await setReaction(
      base,
      runtime,
      base.author,
      protectedBoardTarget.threadId,
      `/v1/threads/${protectedBoardTarget.threadId}/reaction`,
      'like',
    );
    await waitForChanges(runtime, [hiddenBoard]);
    await concealmentControl(base, protectedBoardTarget, base.other);
    const ownerBoard = await getThread(base, protectedBoardTarget, base.author.bearer);
    expect(ownerBoard.response.status).toBe(200);
    expect((ownerBoard.value as ThreadRead).thread.reactions).toEqual({ like: 1 });

    const hiddenRealm = await setReaction(
      base,
      runtime,
      base.author,
      protectedRealmTarget.threadId,
      `/v1/threads/${protectedRealmTarget.threadId}/reaction`,
      'love',
    );
    await waitForChanges(runtime, [hiddenRealm]);
    await concealmentControl(base, protectedRealmTarget, base.other);
    const ownerRealm = await getThread(base, protectedRealmTarget, base.author.bearer);
    expect(ownerRealm.response.status).toBe(200);
    expect((ownerRealm.value as ThreadRead).thread.viewerReaction).toBe('love');
    expect((ownerRealm.value as ThreadRead).thread.reactions).toEqual({ love: 1 });

    const permitted = await setReaction(
      base,
      runtime,
      base.author,
      permittedRealmTarget.threadId,
      `/v1/threads/${permittedRealmTarget.threadId}/reaction`,
      'like',
    );
    await waitForChanges(runtime, [permitted]);
    const separatelyPermittedThread = await getThread(base, permittedRealmTarget, base.other.bearer);
    const separatelyPermittedPosts = await getPosts(base, permittedRealmTarget, base.other.bearer);
    expect(separatelyPermittedThread.response.status).toBe(200);
    expect(separatelyPermittedPosts.response.status).toBe(200);
    expect((separatelyPermittedThread.value as ThreadRead).thread).toMatchObject({
      viewerReaction: null,
      reactions: { like: 1 },
    });
    expect((separatelyPermittedPosts.value as PostsRead).posts[0]).toMatchObject({
      viewerReaction: null,
      reactions: {},
    });
    expect((separatelyPermittedThread.value as ThreadRead).reactionsAsOf).toEqual(
      await freshness(base, permittedRealmTarget.threadId),
    );
    expect((await getThread(base, publicTarget, base.other.bearer)).response.status).toBe(200);
    expect((await getPosts(base, publicTarget, base.other.bearer)).response.status).toBe(200);
    expect((await getThread(base, protectedRealmTarget, base.author.bearer)).response.status).toBe(200);
    expect((await getThread(base, publicTarget, base.author.bearer)).response.status).toBe(200);
  },
  180_000,
);
