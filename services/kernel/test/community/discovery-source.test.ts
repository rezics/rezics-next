import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID, createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { Pool } from 'pg';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { softDeletePost } from '../../src/content/erase-post.ts';
import { resolveAppeal } from '../../src/content/appeals.ts';
import { readRealmDiscoveryGate } from '../../src/community/discovery-source.ts';
import {
  prepareDiscoveryMutation,
  abortDiscoveryMutation,
  lockDiscoveryMutation,
  projectDiscoveryMutation,
  readDiscoveryOperation,
} from '../../src/content/discovery-mutation.ts';
import { fromPlainText } from '@rezics/document';
import { readDiscoverySource, prepareDiscoverySourceApply } from '../../src/content/discovery.ts';
import { DISCOVERY_DELTA, type DiscoveryDelta } from '../../src/content/discovery-events.ts';
import { lookupEventType } from '../../src/events/catalogue.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createReactionRelayBase } from '../content/reaction-relay-convergence-fixture.ts';

let f: Awaited<ReturnType<typeof createReactionRelayBase>>;
beforeAll(async () => {
  f = await createReactionRelayBase();
}, 120_000);
afterAll(async () => {
  await f?.system.close();
});
const source = (threadId: string) => readDiscoverySource(f.system.database.pool, threadId);
async function deltas(threadId: string, route: number): Promise<DiscoveryDelta[]> {
  const result = await f.system.database.pool.query<{ data: DiscoveryDelta }>(
    'SELECT data FROM core.outbox WHERE partition_no=$1 AND type=$2 AND subject=$3 ORDER BY position,event_seq',
    [partitionOf(route), DISCOVERY_DELTA, threadId],
  );
  return result.rows.map((row) => row.data);
}
async function visibility(realmId: string, value: 'public' | 'protected') {
  const current = await f.call('GET', `/v1/realms/${realmId}`, { bearer: f.author.bearer });
  expect(current.response.status).toBe(200);
  return f.command(
    'PATCH',
    `/v1/realms/${realmId}`,
    { visibility: value },
    {
      expectedStatus: 200,
      headers: { 'if-match': JSON.stringify(current.value!.realm.headRevisionId) },
    },
  );
}

test('only genuinely public discussion starts qualify at authoritative creation time and their native versioned lifecycle deltas never restore protected or removed contributions', async () => {
  const target = await f.createRealmTarget('Original public discovery', 'public');
  const key = randomUUID();
  const body = {
    boardId: target.boardId,
    title: 'Qualifying start',
    body: fromPlainText('Opening'),
    licence: 'MIT',
    subjectIds: [],
    visibility: 'published',
  };
  const first = await f.command<{ thread: { id: string } }>('POST', '/v1/threads', body, { key });
  const repeated = await f.command<{ thread: { id: string } }>('POST', '/v1/threads', body, { key });
  expect(repeated.thread.id).toBe(first.thread.id);
  const original = (await source(first.thread.id))!;
  expect(original).toMatchObject({
    realmId: target.realmId,
    boardId: target.boardId,
    contributing: true,
    sourceVersion: '1',
  });
  const emitted = await deltas(first.thread.id, original.sourceRoute);
  expect(emitted).toEqual([{ ...original, change: 1 }]);
  expect(lookupEventType(DISCOVERY_DELTA)?.Check(emitted[0])).toBe(true);
  expect(lookupEventType(DISCOVERY_DELTA)?.Check({ ...emitted[0], actorId: f.author.accountId })).toBe(false);
  expect(prepareDiscoverySourceApply(emitted[0]!, original, null)?.source).toEqual(original);
  expect(prepareDiscoverySourceApply(emitted[0]!, original, '1')).toBeNull();
  const day = await f.system.database.pool.query<{ day: string }>(
    "SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day FROM content.thread WHERE route=$1 AND thread_id=$2",
    [original.sourceRoute, first.thread.id],
  );
  expect(original.creationDay).toBe(day.rows[0]!.day);
  const draft = await f.createThread(target.boardId, 'Draft does not qualify', 'draft');
  expect(await source(draft.threadId)).toBeNull();
  const protectedBoard = await f.createRealmTarget('Protected board discovery', 'public', 'protected');
  expect(await source(protectedBoard.threadId)).toBeNull();
}, 120_000);

test('protected creation followed by public transition never qualifies and each visibility transition changes the public epoch', async () => {
  const target = await f.createRealmTarget('Original protected discovery', 'protected');
  expect(await source(target.threadId)).toBeNull();
  await visibility(target.realmId, 'public');
  expect(await source(target.threadId)).toBeNull();
  const firstPublic = await f.createThread(target.boardId, 'First public epoch');
  const first = (await source(firstPublic.threadId))!;
  expect(first.contributing).toBe(true);
  await visibility(target.realmId, 'protected');
  const privateStart = await f.createThread(target.boardId, 'Private interval');
  await visibility(target.realmId, 'public');
  expect(await source(privateStart.threadId)).toBeNull();
  const nextPublic = await f.createThread(target.boardId, 'New public epoch');
  const next = (await source(nextPublic.threadId))!;
  expect(BigInt(next.realmEpoch)).toBeGreaterThan(BigInt(first.realmEpoch));
  expect((await source(firstPublic.threadId))!.realmEpoch).toBe(first.realmEpoch);
}, 120_000);

test('native opening deletion retracts once, delayed positive source facts cannot resurrect it, and protected restoration does not upgrade it', async () => {
  const target = await f.createRealmTarget('Discovery retraction', 'public');
  const original = (await source(target.threadId))!;
  const positive = (await deltas(target.threadId, original.sourceRoute))[0]!;
  const reply = await f.command<{ post: { id: string } }>('POST', `/v1/threads/${target.threadId}/posts`, {
    body: fromPlainText('Reply contributes nothing'),
    licence: 'MIT',
    parentId: target.postId,
  });
  await f.command('DELETE', `/v1/posts/${reply.post.id}`, undefined);
  expect(await source(target.threadId)).toEqual(original);
  const key = randomUUID();
  await f.command('DELETE', `/v1/posts/${target.postId}`, undefined, { key });
  await f.command('DELETE', `/v1/posts/${target.postId}`, undefined, { key });
  const retracted = (await source(target.threadId))!;
  expect(retracted).toEqual({ ...original, contributing: false, sourceVersion: '2' });
  expect(await deltas(target.threadId, original.sourceRoute)).toEqual([positive, { ...retracted, change: -1 }]);
  expect(prepareDiscoverySourceApply(positive, retracted, '1')?.source.contributing).toBe(false);
  expect(prepareDiscoverySourceApply(positive, retracted, '2')).toBeNull();
  expect(prepareDiscoverySourceApply({ ...positive, realmEpoch: '999' }, retracted, null)).toBeNull();
  expect(prepareDiscoverySourceApply({ ...positive, sourceVersion: '3' }, retracted, null)).toBeNull();
  await visibility(target.realmId, 'protected');
  await f.command('POST', `/v1/posts/${target.postId}:restore`, undefined, { expectedStatus: 204 });
  expect(await source(target.threadId)).toEqual(retracted);
}, 120_000);

test('a terminal source CAS excludes late application, retries retain their own fence, and an applied winner cannot abort', async () => {
  const target = await f.createRealmTarget('Guarded discovery outcome', 'public');
  const original = (await source(target.threadId))!;
  const actor = f.system.actors.author.actor;
  const identity = principalCommandIdentity(actor);
  const key = randomUUID();
  const point = {
    action: 'post:erase',
    kind: 'post',
    id: target.postId,
    reason: 'Deleted by author',
    softDelete: true,
  };
  const receipt = {
    kind: 'content.post:erase',
    key,
    digest: createHash('sha256')
      .update(canonicalize([identity, point])!)
      .digest(),
  };
  const deps = { pool: f.system.database.pool, access: f.system.access, routeKey: f.system.routeKey };
  const authorization = await accessCommandAuthorization(
    deps.access,
    actor,
    'post:erase',
    { route: original.sourceRoute, id: target.postId },
    { pool: deps.pool, deadline: Date.now() + 30_000 },
    () => new Error('Denied'),
  );
  const first = (await prepareDiscoveryMutation(deps, {
    identity,
    authorization,
    receipt,
    deadline: Date.now() + 30_000,
    target: { kind: 'post', id: target.postId },
    effect: 'retract',
  }))!;
  expect((await readRealmDiscoveryGate(deps.pool, target.realmId))!.settled).toBe(false);
  await abortDiscoveryMutation(deps.pool, first);
  await expect(
    runCommand(
      deps.pool,
      {
        ...identity,
        partition: partitionOf(original.sourceRoute),
        authorization,
        receipt,
        deadline: Date.now() + 30_000,
      },
      async (tx) => {
        await lockDiscoveryMutation(tx, first);
        throw new Error('Late native effect reached mutation');
      },
    ),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await source(target.threadId)).toEqual(original);
  await softDeletePost(
    deps,
    actor,
    { postId: target.postId, reason: point.reason },
    {
      idempotencyKey: key,
      deadline: Date.now() + 30_000,
      requestId: randomUUID(),
    },
  );
  const rows = await deps.pool.query<{ route: number; intent: string; generation: string }>(
    'SELECT route,intent,generation::text FROM content.realm_discovery_operation WHERE route=$1 AND intent=$2 ORDER BY generation',
    [first.route, first.intent],
  );
  expect(rows.rows.map((row) => row.generation)).toEqual(['1', '2']);
  const second = rows.rows[1]!;
  await projectDiscoveryMutation(deps.pool, first);
  expect((await readRealmDiscoveryGate(deps.pool, target.realmId))!.settled).toBe(false);
  await abortDiscoveryMutation(deps.pool, second);
  expect((await readDiscoveryOperation(deps.pool, second))!.phase).toBe('applied');
  await projectDiscoveryMutation(deps.pool, second);
  expect((await readRealmDiscoveryGate(deps.pool, target.realmId))!.settled).toBe(true);
  expect((await source(target.threadId))!.contributing).toBe(false);
  await f.command('POST', `/v1/posts/${target.postId}:restore`, undefined, { expectedStatus: 204 });
  expect(await source(target.threadId)).toEqual({ ...original, sourceVersion: '3' });
}, 120_000);

test('appeal reversal prepares its Realm fence outside the target transaction and preserves independent review before receipts', async () => {
  const target = await f.createRealmTarget('Appeal discovery restoration', 'public');
  await f.command(
    'POST',
    `/v1/threads/${target.threadId}:takeDown`,
    { reason: 'Review this decision' },
    { expectedStatus: 200 },
  );
  expect((await source(target.threadId))!.contributing).toBe(false);
  const decision = (
    await f.system.database.pool.query<{ decision_id: string }>(
      'SELECT decision_id FROM content.moderation_decision WHERE route=$1 AND target_id=$2 ORDER BY decided_at DESC LIMIT 1',
      [routeOf(target.threadId), target.threadId],
    )
  ).rows[0]!;
  const appeal = await f.command<{ id: string }>('POST', `/v1/moderation-decisions/${decision.decision_id}:appeal`, {
    statement: 'Please reconsider',
  });
  const before = await f.system.database.pool.query(
    'SELECT intent,generation FROM content.realm_discovery_operation WHERE route=$1 ORDER BY intent,generation',
    [routeOf(target.threadId)],
  );
  await f.command(
    'POST',
    `/v1/moderation-appeals/${appeal.id}:resolve`,
    {
      outcome: 'reverse',
      statement: 'Same decider cannot resolve',
    },
    { expectedStatus: 403 },
  );
  expect(
    (
      await f.system.database.pool.query(
        'SELECT intent,generation FROM content.realm_discovery_operation WHERE route=$1 ORDER BY intent,generation',
        [routeOf(target.threadId)],
      )
    ).rows,
  ).toEqual(before.rows);
  const credential = await f.system.auth.issue({
    accountId: f.governance.accountId,
    clientId: f.system.auth.ordinaryClient.id,
    scopes: f.system.auth.ordinaryScopes,
  });
  // One connection makes an accidental nested source/Realm checkout observable.
  const single = new Pool({ ...f.system.database.pool.options, max: 1 });
  try {
    const input = { outcome: 'reverse' as const, statement: 'Independent review' };
    const context = { idempotencyKey: randomUUID(), deadline: Date.now() + 30_000, requestId: randomUUID() };
    const deps = { pool: single, access: f.system.access };
    const resolved = await resolveAppeal(deps, credential.actor, appeal.id, input, context);
    expect(resolved.value).toEqual({ id: appeal.id });
    const replay = await resolveAppeal(deps, credential.actor, appeal.id, input, {
      ...context,
      deadline: Date.now() + 30_000,
    });
    expect(replay.replayed).toBe(true);
    expect((await source(target.threadId))!).toMatchObject({ contributing: true, sourceVersion: '3' });
  } finally {
    await single.end();
  }
}, 120_000);
