import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import counts from '../../src/content/reaction-count-page.sql';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createAuthorContributionActionsFixture } from './support/author-contribution-actions-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

let f: Awaited<ReturnType<typeof createAuthorContributionActionsFixture>>;
setDefaultTimeout(120_000);
beforeAll(async () => {
  try {
    f = await createAuthorContributionActionsFixture();
  } catch (cause) {
    throw new Error('Author contribution setup failed; no journey outcome reached', { cause });
  }
}, 240_000);
afterAll(async () => {
  await f?.close();
});
let minute = 0;
beforeEach(async () => {
  await f.setTime(Date.now() + ++minute * 60_000);
});

function status(result: Awaited<ReturnType<typeof f.call>>, expected: number) {
  expect(result.response.status, result.text).toBe(expected);
}

for (const view of ['posts', 'discussion', 'reviews'] as const) {
  test(`${view}: public admission and private native advice retain the exact original cohort`, async () => {
    const thread = await f.thread(view === 'reviews' ? 'review' : 'discussion');
    const source = view === 'posts' ? await f.post(thread.id, 'Selected authored reply') : thread;
    const selected = await f.admit(view, null, 1);
    expect(selected.input.references).toHaveLength(1);
    expect(selected.input.references[0]).toMatchObject({
      id: source.id,
      placeId: thread.boardId,
      sourceRevisionId: view === 'posts' ? source.revisionId : thread.firstPost.revisionId,
    });
    expect(selected.page.text).not.toMatch(/viewerSelection|viewerReaction|watching|operations/);
    const original = JSON.stringify({ input: selected.input, next: selected.page.value.next });
    const guest = await selected.read();
    status(guest, 200);
    expect(guest.response.headers.get('cache-control')).toBe('private, no-store');
    expect(guest.value.viewer).toEqual({ kind: 'anonymous' });
    expect(guest.value.selected[0].reply).toEqual({ state: 'sign_in_required' });
    expect(guest.text).not.toMatch(/viewerSelection|watching/);
    for (const person of [f.author, f.other]) {
      const own = await selected.read(person.bearer);
      status(own, 200);
      expect(own.value.viewer).toEqual({ kind: 'account', id: person.accountId });
      expect(own.value.selected.map((item: any) => item.reference)).toEqual(selected.input.references);
      expect(own.value.watch.items).toEqual([{ threadId: thread.id, state: 'current', watching: false }]);
    }
    const suspended = await selected.read(f.system.actors.suspended.bearer);
    status(suspended, 401);
    expect(suspended.value.code).toBe('invalid_credentials');
    expect(JSON.stringify({ input: selected.input, next: selected.page.value.next })).toBe(original);
  });
}

test('unavailable aggregates and absent own slots stay unknown; same-input retry keeps its frontier', async () => {
  await f.thread();
  const selected = await f.admit('discussion', null, 1);
  const observer = observeSql(f.system.database.pool);
  try {
    observer.armFault({
      match: { statement: counts.sql },
      boundary: 'before',
      error: new Error('Aggregate read unavailable'),
    });
    const unavailable = await selected.read(f.other.bearer);
    status(unavailable, 200);
    expect(unavailable.value.reactions).toMatchObject({ state: 'unavailable', retryable: true, reactionsAsOf: null });
    for (const item of unavailable.value.reactions.items) {
      expect(item.state).toBe('unavailable');
      expect(item).not.toHaveProperty('viewerSelection');
      expect(item).not.toHaveProperty('counts');
    }
  } finally {
    await observer.close();
  }
  const retained = JSON.stringify(selected.input);
  const runtime = f.dependencies.viewerActionRuntime;
  Object.defineProperty(f.dependencies, 'viewerActionRuntime', { configurable: true, value: undefined });
  try {
    const unavailableAdvice = await selected.read(f.other.bearer);
    status(unavailableAdvice, 200);
    expect(unavailableAdvice.value.actions).toMatchObject({ state: 'unavailable', retryable: true, references: [] });
  } finally {
    Object.defineProperty(f.dependencies, 'viewerActionRuntime', { configurable: true, value: runtime });
  }
  const retry = await selected.read(f.other.bearer);
  status(retry, 200);
  expect(retry.value.selected.map((item: any) => item.reference)).toEqual(selected.input.references);
  expect(JSON.stringify(selected.input)).toBe(retained);
});

test('native reaction retries recover the original receipt once and reauthorize before replay', async () => {
  const thread = await f.thread();
  const selected = await f.admit('discussion', null, 1);
  const advice = await selected.read(f.other.bearer);
  status(advice, 200);
  const reference = advice.value.actions.references.find(
    (item: any) => item.type === 'content.thread' && item.id === thread.id,
  );
  expect(reference.operations).toContainEqual(
    expect.objectContaining({ operationId: 'thread.set_reaction', state: 'available' }),
  );
  const path = `/v1/threads/${thread.id}/reaction`;
  const key = crypto.randomUUID();
  const sender = Object.freeze({ bearer: f.other.bearer, key, body: Object.freeze({ kind: 'like' }) });
  const send = () => f.call('PUT', path, sender);
  // Lose only delivery of the first real committed response. Recovery keeps the
  // original sender, credentials, semantic payload and idempotency key.
  await expect(
    send().then((result) => {
      status(result, 200);
      throw new Error('Committed response delivery lost');
    }),
  ).rejects.toThrow('Committed response delivery lost');
  const readback = await selected.read(sender.bearer);
  status(readback, 200);
  const receipt = await send();
  status(receipt, 200);
  expect(receipt.value).toEqual({ kind: 'like' });
  const retained = await f.admin.query(
    'SELECT count(*)::int AS count FROM core.receipt WHERE principal_id=$1 AND idempotency_key=$2',
    [f.other.accountId, key],
  );
  expect(retained.rows).toEqual([{ count: 1 }]);
  const effects = await f.admin.query(
    `SELECT count(*)::int AS count FROM core.outbox
     WHERE type='com.rezics.content.reaction.changed.v1' AND subject=$1 AND data->>'actorId'=$2`,
    [thread.id, f.other.accountId],
  );
  expect(effects.rows).toEqual([{ count: 1 }]);
  await f.checked('POST', '/v1/grants', {
    bearer: f.governance.bearer,
    body: {
      resource: { route: routeOf(thread.id), id: thread.id },
      subject: { kind: 'account', id: f.other.accountId },
      actions: ['reaction:set'],
      valid: '(,)',
    },
  });
  await f.admin.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
     VALUES ($1,$2,$3,'reaction:set','resource','(,)',$4)`,
    [routeOf(thread.id), thread.id, f.other.accountId, newId(routeOf(thread.id)!)],
  );
  status(await send(), 403);
  const watched = await f.call('PUT', `/v1/threads/${thread.id}/watch`, { bearer: sender.bearer });
  status(watched, 204);
  const refreshed = await selected.read(sender.bearer);
  status(refreshed, 200);
  expect(refreshed.value.watch.items).toEqual([{ threadId: thread.id, state: 'current', watching: true }]);
  const unwatched = await f.call('DELETE', `/v1/threads/${thread.id}/watch`, { bearer: sender.bearer });
  status(unwatched, 204);
  const afterUnwatch = await selected.read(sender.bearer);
  status(afterUnwatch, 200);
  expect(afterUnwatch.value.watch.items).toEqual([{ threadId: thread.id, state: 'current', watching: false }]);
  expect(afterUnwatch.value).not.toHaveProperty('receipt');
});

test('post reaction recovery keeps its original key and registered freshness updates the selected post', async () => {
  const thread = await f.thread();
  const post = await f.post(thread.id, 'Selected post reaction target');
  const selected = await f.admit('posts', null, 1);
  const advice = await selected.read(f.other.bearer);
  status(advice, 200);
  const reference = advice.value.actions.references.find(
    (item: any) => item.type === 'content.post' && item.id === post.id,
  );
  expect(reference.operations).toContainEqual(
    expect.objectContaining({ operationId: 'post.set_reaction', state: 'available' }),
  );
  const path = `/v1/posts/${post.id}/reaction`;
  const sender = Object.freeze({
    bearer: f.other.bearer,
    key: crypto.randomUUID(),
    body: Object.freeze({ kind: 'like' }),
  });
  const send = () => f.call('PUT', path, sender);
  await expect(
    send().then((result) => {
      status(result, 200);
      throw new Error('Committed response delivery lost');
    }),
  ).rejects.toThrow('Committed response delivery lost');
  const readback = await selected.read(sender.bearer);
  status(readback, 200);
  expect(readback.value).not.toHaveProperty('receipt');
  expect(readback.value.reactions.items).toContainEqual(
    expect.objectContaining({ type: 'content.post', id: post.id, state: 'current', viewerSelection: 'like' }),
  );
  const replay = await send();
  status(replay, 200);
  expect(replay.value).toEqual({ kind: 'like' });
  const retained = await f.admin.query(
    'SELECT count(*)::int AS count FROM core.receipt WHERE principal_id=$1 AND idempotency_key=$2',
    [f.other.accountId, sender.key],
  );
  expect(retained.rows).toEqual([{ count: 1 }]);
  const effects = await f.admin.query(
    `SELECT count(*)::int AS count FROM core.outbox
     WHERE type='com.rezics.content.reaction.changed.v1' AND subject=$1 AND data->>'actorId'=$2`,
    [post.id, f.other.accountId],
  );
  expect(effects.rows).toEqual([{ count: 1 }]);
  await f.grant(post.id, f.other.accountId, ['reaction:set']);
  await f.admin.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
     VALUES ($1,$2,$3,'reaction:set','resource','(,)',$4)`,
    [routeOf(post.id), post.id, f.other.accountId, newId(routeOf(post.id)!)],
  );
  status(await send(), 403);
});

test('same selected author proof tolerates unrelated source position advancement', async () => {
  const thread = await f.thread();
  const selected = await f.admit('discussion', null, 1);
  const result = await f.duringAssembly(selected, () => f.post(thread.id, 'Unrelated committed reply'));
  status(result, 200);
  expect(result.value.selected.map((item: any) => item.reference)).toEqual(selected.input.references);
});

test('source partition identity replacement during finish retires the whole selected cohort', async () => {
  const thread = await f.thread();
  const selected = await f.admit('discussion', null, 1);
  const partition = partitionOf(routeOf(thread.id)!);
  const before = await f.admin.query('SELECT node FROM core.partition WHERE partition_no=$1', [partition]);
  const originalNode = before.rows[0]!.node as string;
  try {
    const changed = await f.duringAssembly(selected, () =>
      f.admin.query('UPDATE core.partition SET node=$2 WHERE partition_no=$1', [
        partition,
        `${originalNode}-replacement`,
      ]),
    );
    status(changed, 503);
    expect(changed.value.code).toBe('dependency_unavailable');
    expect(changed.text).not.toContain('operations');
  } finally {
    await f.admin.query('UPDATE core.partition SET node=$2 WHERE partition_no=$1', [partition, originalNode]);
  }
});

test('a moved native source home cannot serve an already admitted action proof', async () => {
  const thread = await f.thread();
  const selected = await f.admit('discussion', null, 1);
  const partition = partitionOf(routeOf(thread.id)!);
  await f.admin.query("UPDATE core.partition SET write_state='moved',moved_to=$2 WHERE partition_no=$1", [
    partition,
    partition + 1,
  ]);
  try {
    const moved = await selected.read(f.other.bearer);
    status(moved, 503);
    expect(moved.value.code).toBe('dependency_unavailable');
    expect(moved.text).not.toContain('operations');
  } finally {
    await f.admin.query("UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=$1", [
      partition,
    ]);
  }
});

test('sparse author pages sign visible rows and failed refresh retries never refill the original selection', async () => {
  const thread = await f.thread();
  const post = await f.post(thread.id, 'Original selected source');
  await f.post(thread.id, 'Sparse draft row', undefined, 'draft');
  const selected = await f.admit('posts', null, 1);
  expect(selected.input.references.map((reference) => reference.id)).toEqual([post.id]);
  const original = JSON.stringify({ input: selected.input, next: selected.page.value.next });
  await f.post(thread.id, 'Newer candidate');
  await f.revise(post.id, post.revisionId, 'Changed before private assembly');
  const changed = await selected.read(f.other.bearer);
  status(changed, 503);
  expect(changed.value.code).toBe('dependency_unavailable');
  expect(changed.text).not.toContain('operations');
  expect(JSON.stringify({ input: selected.input, next: selected.page.value.next })).toBe(original);
  status(await selected.read(f.other.bearer), 503);
});

test('source replacement during finish retires advice and retries keep the original revisions', async () => {
  const thread = await f.thread();
  const post = await f.post(thread.id, 'Original selected body');
  const selected = await f.admit('posts', null, 1);
  const original = JSON.stringify(selected.input);
  const changed = await f.duringAssembly(selected, () => f.revise(post.id, post.revisionId, 'Replaced selected body'));
  status(changed, 503);
  expect(changed.value.code).toBe('dependency_unavailable');
  expect(changed.text).not.toContain('operations');
  status(await selected.read(f.other.bearer), 503);
  expect(JSON.stringify(selected.input)).toBe(original);
});

test('concealed parents and erased sources never substitute current context for original advice', async () => {
  const thread = await f.thread();
  const parent = await f.post(thread.id, 'Parent which will be concealed');
  const child = await f.post(thread.id, 'Exact selected child', parent.id);
  const selected = await f.admit('posts', null, 1);
  expect(selected.input.references[0]!.id).toBe(child.id);
  await f.grant(parent.id, f.system.actors.moderator.actor.accountId, ['moderation:takedown']);
  await f.checked(
    'POST',
    `/v1/posts/${parent.id}:takeDown`,
    {
      bearer: f.system.actors.moderator.bearer,
      body: { reason: 'Concealed parent' },
    },
    200,
  );
  status(await selected.read(f.author.bearer), 503);
  const otherThread = await f.thread();
  const erased = await f.admit('discussion', null, 1);
  expect(erased.input.references[0]!.id).toBe(otherThread.id);
  await f.checked('DELETE', `/v1/threads/${otherThread.id}`, { bearer: f.author.bearer }, 204);
  status(await erased.read(f.author.bearer), 503);
});

test('publication withdrawal during finish fails the selected cohort without moving its cursor', async () => {
  await f.thread();
  const selected = await f.admit('discussion', null, 1);
  const original = JSON.stringify({ input: selected.input, next: selected.page.value.next });
  const result = await f.duringAssembly(selected, () =>
    f.checked(
      'PATCH',
      `/v1/accounts/${f.author.accountId}`,
      {
        bearer: f.author.bearer,
        body: { publicViews: { posts: false } },
      },
      200,
    ),
  );
  status(result, 503);
  expect(result.value.code).toBe('dependency_unavailable');
  status(await selected.read(f.author.bearer), 404);
  expect(JSON.stringify({ input: selected.input, next: selected.page.value.next })).toBe(original);
  await f.checked(
    'PATCH',
    `/v1/accounts/${f.author.accountId}`,
    {
      bearer: f.author.bearer,
      body: { publicViews: { posts: true } },
    },
    200,
  );
});

for (const view of ['discussion', 'posts'] as const) {
  test(`${view}: exact report and reply commands recover their own original receipts`, async () => {
    const thread = await f.thread();
    const source = view === 'posts' ? await f.post(thread.id, 'Selected reply target') : thread.firstPost;
    const selected = await f.admit(view, null, 1);
    await f.grant(thread.id, f.other.accountId, ['post:create']);
    const advice = await selected.read(f.other.bearer);
    status(advice, 200);
    expect(advice.value.selected[0].reply).toEqual({ state: 'available' });
    const target = { kind: view === 'posts' ? 'post' : 'thread', id: view === 'posts' ? source.id : thread.id };
    const reportAdvice = advice.value.actions.references.find(
      (item: any) => item.type === `content.${target.kind}` && item.id === target.id,
    );
    expect(reportAdvice.operations).toContainEqual(
      expect.objectContaining({ operationId: 'report.create', state: 'available' }),
    );
    const commands = [
      { path: '/v1/reports', body: { target, revisionId: source.revisionId, reason: 'spam' }, field: 'reportId' },
      {
        path: `/v1/threads/${thread.id}/posts`,
        body: {
          body: fromPlainText('Reply to the exact selected contribution'),
          licence: 'CC0-1.0',
          subjectIds: [],
          visibility: 'published',
          parentId: source.id,
        },
        field: 'post',
      },
    ];
    for (const command of commands) {
      const sender = Object.freeze({ bearer: f.other.bearer, key: crypto.randomUUID(), body: command.body });
      const send = () => f.call('POST', command.path, sender);
      let committed: unknown;
      await expect(
        send().then((response) => {
          status(response, 201);
          committed = response.value[command.field];
          throw new Error('Committed response delivery lost');
        }),
      ).rejects.toThrow('Committed response delivery lost');
      const readback = await selected.read(sender.bearer);
      status(readback, 200);
      expect(readback.value.selected.map((item: any) => item.reference)).toEqual(selected.input.references);
      expect(readback.value).not.toHaveProperty('receipt');
      const recovered = await send();
      status(recovered, 201);
      expect(recovered.value[command.field]).toEqual(committed);
      const receipts = await f.admin.query(
        'SELECT count(*)::int AS count FROM core.receipt WHERE principal_id=$1 AND idempotency_key=$2',
        [f.other.accountId, sender.key],
      );
      expect(receipts.rows).toEqual([{ count: 1 }]);
      if (command.field === 'post') {
        expect(recovered.value.post).toMatchObject({ threadId: thread.id, parentId: source.id });
      } else {
        const report = await f.call('GET', `/v1/reports/${recovered.value.reportId}`, { bearer: sender.bearer });
        status(report, 200);
        expect(report.value.report).toMatchObject({ target, revisionId: source.revisionId });
      }
    }
    status(await f.call('PUT', `/v1/threads/${thread.id}/watch`, { bearer: f.other.bearer }), 204);
    const watched = await selected.read(f.other.bearer);
    status(watched, 200);
    expect(watched.value.watch.items).toEqual([{ threadId: thread.id, state: 'current', watching: true }]);
  });
}

test('parent revision replacement during finish withholds the entire original selection', async () => {
  const thread = await f.thread();
  const parent = await f.post(thread.id, 'Original parent');
  const child = await f.post(thread.id, 'Unchanged selected child', parent.id);
  const selected = await f.admit('posts', null, 1);
  expect(selected.input.references[0]!.id).toBe(child.id);
  const original = JSON.stringify({ input: selected.input, next: selected.page.value.next });
  const replaced = await f.duringAssembly(selected, () => f.revise(parent.id, parent.revisionId, 'Replaced parent'));
  status(replaced, 503);
  expect(replaced.value.code).toBe('dependency_unavailable');
  expect(replaced.text).not.toContain('operations');
  expect(JSON.stringify({ input: selected.input, next: selected.page.value.next })).toBe(original);
});

test('a source epoch change during finish cannot inherit the previous source observation', async () => {
  const thread = await f.thread();
  const selected = await f.admit('discussion', null, 1);
  const partition = partitionOf(routeOf(thread.id)!);
  const before = await f.admin.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [partition]);
  const originalEpoch = before.rows[0]!.epoch as number;
  try {
    const replaced = await f.duringAssembly(selected, () =>
      f.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [partition]),
    );
    status(replaced, 503);
    expect(replaced.value.code).toBe('dependency_unavailable');
    expect(replaced.text).not.toContain('operations');
  } finally {
    await f.admin.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [partition, originalEpoch]);
  }
});

test('replacement viewer credentials retain the public selection and revoked credentials disclose no advice', async () => {
  await f.thread();
  const selected = await f.admit('discussion', null, 1);
  const replacement = await f.system.auth.issue({
    accountId: f.other.accountId,
    clientId: f.system.auth.ordinaryClient.id,
    scopes: f.system.auth.ordinaryScopes,
  });
  expect(replacement.bearer).not.toBe(f.other.bearer);
  const current = await selected.read(replacement.bearer);
  status(current, 200);
  expect(current.value.viewer).toEqual({ kind: 'account', id: f.other.accountId });
  expect(current.value.selected.map((item: any) => item.reference)).toEqual(selected.input.references);
  const suspended = await f.duringAssembly(
    selected,
    () =>
      f.admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
        routeOf(f.other.accountId)!,
        f.other.accountId,
      ]),
    replacement.bearer,
  );
  status(suspended, 401);
  expect(suspended.value.code).toBe('invalid_credentials');
  await f.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
    routeOf(f.other.accountId)!,
    f.other.accountId,
  ]);
  const finishCredential = await f.system.auth.issue({
    accountId: f.other.accountId,
    clientId: f.system.auth.ordinaryClient.id,
    scopes: f.system.auth.ordinaryScopes,
  });
  const replacedDuringFinish = await f.duringAssembly(
    selected,
    async () => {
      await f.system.nativeAuth.internal.revokeSessions(f.other.accountId);
      await f.system.auth.issue({
        accountId: f.other.accountId,
        clientId: f.system.auth.ordinaryClient.id,
        scopes: f.system.auth.ordinaryScopes,
      });
    },
    finishCredential.bearer,
  );
  status(replacedDuringFinish, 401);
  expect(replacedDuringFinish.value.code).toBe('invalid_credentials');
  await f.system.nativeAuth.internal.revokeSessions(f.other.accountId);
  for (const bearer of [f.other.bearer, replacement.bearer, finishCredential.bearer]) {
    const revoked = await selected.read(bearer);
    status(revoked, 401);
    expect(revoked.value.code).toBe('invalid_credentials');
    expect(revoked.text).not.toContain('operations');
  }
  status(await selected.read(), 200);
});
