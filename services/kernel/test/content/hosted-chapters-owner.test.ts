import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { repairHostedCataloguePage } from '../../src/content/hosted-chapters-index.ts';
import { createAuthorItemEffect } from '../../src/content/author-item-index.ts';
import { readBatch } from '../../src/events/log.ts';
import { listOwnHostedCatalogues, readOwnHostedCatalogue } from '../../src/content/hosted-chapters-owner.ts';
import type { HostedDependencies } from '../../src/content/hosted-chapters-model.ts';
import * as reads from '../../src/content/reads.ts';
import * as partitions from '../../src/partition/partition.ts';
import * as access from '../../src/content/access-port.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { encodeAuthorItemKey } from '../../src/content/author-item-cursor.ts';
import { postPublicationFixture, type PublicationPost } from './support/post-publication-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof postPublicationFixture>>;
let instant: string;
const books: Array<{ id: string; threadId: string; post: PublicationPost; head: string }> = [];
const home = () => `/v1/accounts/${f.author.actor.accountId}/hostedCatalogues`;
const context = () => ({ actor: f.author.actor, deadline: Date.now() + 120_000 });
const deps = (): HostedDependencies => ({
  pool: f.pool,
  access: f.system.access,
  tokens: f.system.tokenKeys,
  clock: () => new Date(instant),
});
async function book(visibility: 'draft' | 'published' = 'draft') {
  const thread = await f.thread(visibility);
  const created = await f.command('/v1/hostedCatalogues', {
    postId: thread.firstPost.id,
    threadId: thread.id,
    placements: [],
  });
  const value = {
    id: thread.firstPost.id,
    threadId: thread.id,
    post: thread.firstPost,
    head: created.revisionId as string,
  };
  books.push(value);
  return value;
}
async function repair() {
  for (let page = 0; page < 128; page++) {
    const result = await repairHostedCataloguePage(f.pool);
    expect(result.examined).toBeLessThanOrEqual(40);
    if (result.complete) return;
  }
  throw new Error('Hosted locator recovery did not reach its bounded frontier');
}
async function erase(id: string) {
  const response = await f.system.kernel.handle(
    new Request(`https://content.test/v1/posts/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${f.author.bearer}`, 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
    }),
  );
  expect(response.status).toBe(204);
}
async function pending(id: string) {
  return (
    await f.pool.query('SELECT hosted_locator_pending FROM content.post WHERE route=$1 AND post_id=$2', [
      routeOf(id),
      id,
    ])
  ).rows[0]!.hosted_locator_pending;
}

beforeAll(async () => {
  f = await postPublicationFixture();
  instant = new Date(Date.now() + 60_000).toISOString();
  await f.system.clock.setCommandTime(instant);
  await book('published');
  await book();
  await book();
});
afterAll(async () => {
  await f?.close();
});

test('native foreign exact selection works before recovery; incomplete empty inventory stays partial', async () => {
  const foreign = books.find((entry) => routeOf(entry.id) !== routeOf(f.author.actor.accountId))!;
  expect(foreign).toBeDefined();
  expect(await pending(foreign.id)).toBe(true);
  const before = await f.call('GET', `${home()}?scope=all-homes`);
  expect(before.status).toBe(200);
  expect(before.value.scope).toEqual({
    kind: 'all-homes',
    route: routeOf(f.author.actor.accountId),
    crossHome: 'partial',
  });
  expect(before.value.items).toEqual([]);
  const exact = await f.call('GET', `${home()}/${foreign.id}`);
  expect(exact.status).toBe(200);
  expect(exact.value.item).toMatchObject({
    catalogueId: foreign.id,
    threadId: foreign.threadId,
    headRevisionId: foreign.head,
  });
  expect(exact.value.scope.crossHome).toBe('partial');
  expect((await f.call('GET', `${home()}/${foreign.id}`, undefined, { other: true })).status).toBe(404);
  expect(
    (
      await f.call(
        'GET',
        `/v1/accounts/${f.system.actors.other.actor.accountId}/hostedCatalogues/${foreign.id}`,
        undefined,
        { other: true },
      )
    ).status,
  ).toBe(404);
  expect((await f.call('GET', `${home()}?scope=all-homes`, undefined, { anonymous: true })).status).toBe(401);
  expect((await f.call('GET', `${home()}?scope=unknown`)).status).toBe(400);
  const same = await f.call('GET', home());
  expect(same.status).toBe(200);
  expect(same.value.scope).toEqual({
    kind: 'same-home',
    route: routeOf(f.author.actor.accountId),
    crossHome: 'unavailable',
  });
  expect(same.value.items.map((entry: any) => entry.catalogueId).sort()).toEqual(
    books
      .filter((entry) => routeOf(entry.id) === routeOf(f.author.actor.accountId))
      .map((entry) => entry.id)
      .sort(),
  );
});

test('bounded native recovery distinguishes catalogue membership and continues exact timestamp ties', async () => {
  const ordinary = await f.thread();
  await repair();
  expect(await repairHostedCataloguePage(f.pool)).toEqual({ complete: true, examined: 0 });
  const page = await f.call('GET', `${home()}?scope=all-homes`);
  expect(page.status).toBe(200);
  expect(page.value.scope.crossHome).toBe('complete');
  const ids = books.map((entry) => entry.id).sort();
  expect(page.value.items.map((entry: any) => entry.catalogueId)).toEqual(ids);
  expect(new Set(page.value.items.map((entry: any) => entry.createdAt)).size).toBe(1);
  expect(JSON.stringify(page.value)).not.toContain(ordinary.firstPost.id);
  expect(page.value.items.every((entry: any) => !('body' in entry) && !('title' in entry))).toBe(true);
  let cursor: string | null = null;
  const seen: string[] = [];
  for (let index = 0; index < ids.length; index++) {
    const next = await f.call(
      'GET',
      `${home()}?scope=all-homes&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    expect(next.status).toBe(200);
    seen.push(...next.value.items.map((entry: any) => entry.catalogueId));
    cursor = next.value.nextCursor;
  }
  expect(seen).toEqual(ids);
  expect(cursor).toBeNull();
  const response = await f.system.kernel.handle(
    new Request(`https://content.test${home()}?scope=all-homes`, {
      headers: { authorization: `Bearer ${f.author.bearer}` },
    }),
  );
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

test('source epochs are independent of the author anchor; cursors retain scope, limit, client, scopes and epoch', async () => {
  const readPartition = partitions.readPartition;
  const authorPartition = partitionOf(routeOf(f.author.actor.accountId)!);
  const actor = f.author.actor;
  const originalCursor = encodeAuthorItemKey(
    f.system.tokenKeys,
    {
      operation: 'content.hosted-catalogue.owner.list',
      parameters: {
        accountId: actor.accountId,
        route: routeOf(actor.accountId)!,
        scope: 'same-home',
        limit: 1,
        clientId: actor.clientId,
        requestedBy: actor.requestedBy,
        authnEpoch: actor.authnEpoch,
        scopes: [...actor.scopes].sort().join(' '),
      },
    },
    { createdAt: instant, itemId: newId(routeOf(actor.accountId)!) },
    (await readPartition(f.pool, authorPartition))!.epoch,
    Date.parse(instant),
  );
  expect((await f.call('GET', `${home()}?limit=1&cursor=${encodeURIComponent(originalCursor)}`)).status).toBe(200);
  const hook = spyOn(partitions, 'readPartition').mockImplementation(async (client, number) => {
    const value = await readPartition(client, number);
    return value ? { ...value, epoch: number === authorPartition ? 11 : 7 } : null;
  });
  try {
    const exact = await readOwnHostedCatalogue(deps(), f.author.actor.accountId, books[0]!.id, context());
    expect(exact.value.item.catalogueId).toBe(books[0]!.id);
    const page = await listOwnHostedCatalogues(deps(), f.author.actor.accountId, context(), {
      scope: 'all-homes',
      limit: 1,
    });
    expect(page.value.items).toHaveLength(1);
    expect(page.anchors.some((anchor) => anchor.partition.partitionNo !== authorPartition && anchor.epoch === 7)).toBe(
      true,
    );
    const cursor = page.value.nextCursor!;
    expect(cursor).toBeString();
    for (const selection of [
      { scope: 'same-home' as const, limit: 1 },
      { scope: 'all-homes' as const, limit: 2 },
    ]) {
      await expect(
        listOwnHostedCatalogues(deps(), f.author.actor.accountId, context(), { ...selection, cursor }),
      ).rejects.toThrow('Invalid hosted catalogue cursor');
    }
    for (const actor of [
      { ...f.author.actor, clientId: 'changed-client' },
      { ...f.author.actor, scopes: [...f.author.actor.scopes].slice(1) },
      { ...f.author.actor, authnEpoch: f.author.actor.authnEpoch + 1 },
      { ...f.author.actor, requestedBy: f.system.actors.other.actor.accountId },
    ]) {
      await expect(
        listOwnHostedCatalogues(
          deps(),
          f.author.actor.accountId,
          { ...context(), actor },
          { scope: 'all-homes', limit: 1, cursor },
        ),
      ).rejects.toThrow();
    }
    hook.mockRestore();
    await expect(
      listOwnHostedCatalogues(deps(), f.author.actor.accountId, context(), { scope: 'all-homes', limit: 1, cursor }),
    ).rejects.toThrow('Invalid hosted catalogue cursor');
  } finally {
    hook.mockRestore();
  }
});

test('sparse pages consume hidden candidates without exposing boundaries; current revise authority is required', async () => {
  const first = [...books].sort((left, right) => left.id.localeCompare(right.id))[0]!;
  const check = access.accessCheck;
  const denied = spyOn(access, 'accessCheck').mockImplementation(async (...args) => {
    if (args[2] === 'post:revise' && args[3].id === first.id) return async () => false;
    return check(...args);
  });
  try {
    const page = await f.call('GET', `${home()}?scope=all-homes&limit=1`);
    expect(page.status).toBe(200);
    expect(page.value.items).toEqual([]);
    expect(page.value.nextCursor).toBeString();
    expect(JSON.stringify(page.value)).not.toContain(first.id);
    expect(Buffer.from(page.value.nextCursor.split('.')[0], 'base64url').toString()).not.toContain(first.id);
    const next = await f.call(
      'GET',
      `${home()}?scope=all-homes&limit=1&cursor=${encodeURIComponent(page.value.nextCursor)}`,
    );
    expect(next.status).toBe(200);
    expect(next.value.items).toHaveLength(1);
    expect(next.value.items[0].catalogueId).not.toBe(first.id);
    expect((await f.call('GET', `${home()}/${first.id}`)).status).toBe(404);
  } finally {
    denied.mockRestore();
  }
  const failed = spyOn(reads, 'readPost').mockRejectedValue(new Error('source dependency unavailable'));
  try {
    await expect(
      listOwnHostedCatalogues(deps(), f.author.actor.accountId, context(), { scope: 'all-homes' }),
    ).rejects.toThrow('source dependency unavailable');
  } finally {
    failed.mockRestore();
  }
});

// Change native state after the last account snapshot, while all checkouts are
// released. The retained source must close after this foreign admission work.
async function duringFinalAccount<T>(run: () => Promise<T>, change: () => Promise<void>, observations = 4) {
  const snapshot = reads.snapshot;
  let count = 0;
  const hook = spyOn(reads, 'snapshot').mockImplementation(async (...args) => {
    const value = await snapshot(...args);
    if (args[1] === f.author.actor.accountId && ++count === observations) await change();
    return value;
  });
  try {
    return await run();
  } finally {
    hook.mockRestore();
  }
}

test('changed heads and erasure during final admission cannot disclose an earlier private entry', async () => {
  const current = books[0]!;
  const selected = await duringFinalAccount(
    () => f.call('GET', `${home()}/${current.id}`),
    async () => {
      const value = await f.command(
        `/v1/hostedCatalogues/${current.id}:revise`,
        { expectedRevisionId: current.head, placements: [] },
        200,
      );
      current.head = value.revisionId;
    },
    routeOf(current.id) === routeOf(f.author.actor.accountId) ? 2 : 3,
  );
  expect(selected.status).toBe(404);
  expect(selected.value).not.toHaveProperty('item');
  const revised = await f.revise(current.post, { body: fromPlainText('Current manuscript') });
  expect(revised.status).toBe(200);
  current.post = revised.value.post;
  const page = await duringFinalAccount(
    () => f.call('GET', `${home()}?scope=all-homes`),
    () => erase(current.id),
  );
  expect(page.status).toBe(200);
  expect(page.value.items.some((entry: any) => entry.catalogueId === current.id)).toBe(false);
  expect((await f.call('GET', `${home()}/${current.id}`)).status).toBe(404);
});

test('restoration and failed acknowledgement retain partial coverage until the committed locator is recovered', async () => {
  const current = books[0]!;
  const restored = await f.system.kernel.handle(
    new Request(`https://content.test/v1/posts/${current.id}:restore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${f.author.bearer}`, 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
    }),
  );
  expect(restored.status).toBe(204);
  expect(await pending(current.id)).toBe(true);
  expect((await f.call('GET', `${home()}?scope=all-homes`)).value.scope.crossHome).toBe('partial');
  const observer = observeSql(f.pool);
  try {
    await repair();
    const acknowledge = observer.records.find((row) =>
      row.statement.includes('UPDATE content.post SET hosted_locator_pending=false'),
    )!.statement;
    const next = await book();
    observer.armFault({
      match: { statement: acknowledge },
      boundary: 'before',
      error: new Error('hosted acknowledgement interrupted'),
    });
    await expect(repairHostedCataloguePage(f.pool)).rejects.toThrow('hosted acknowledgement interrupted');
    expect(await pending(next.id)).toBe(true);
    const partial = await f.call('GET', `${home()}?scope=all-homes`);
    expect(partial.value.scope.crossHome).toBe('partial');
    expect(partial.value.items.some((entry: any) => entry.catalogueId === next.id)).toBe(true);
    await repair();
    expect(await pending(next.id)).toBe(false);
    expect((await f.call('GET', `${home()}?scope=all-homes`)).value.scope.crossHome).toBe('complete');
  } finally {
    await observer.close();
  }
});

test('a newer live projection cannot make recovery acknowledge a missing hosted fact or regress draft state', async () => {
  const observer = observeSql(f.pool);
  try {
    const probe = await book();
    await repair();
    const sourceQuery = observer.records.find((row) =>
      row.statement.includes('AS eligible,p.security_revision'),
    )!.statement;
    const current = await book();
    const barrier = observer.hold({ statement: sourceQuery }, 'after');
    const recovery = repairHostedCataloguePage(f.pool);
    try {
      await barrier.entered;
      const revised = await f.revise(current.post, { body: fromPlainText('Newer live draft') });
      expect(revised.status).toBe(200);
      const effect = createAuthorItemEffect(f.pool);
      const events: Parameters<typeof effect.run>[0][] = [];
      for (;;) {
        const page = await readBatch(f.pool, {
          partition: partitionOf(routeOf(current.id)!),
          consumer: `hosted_${current.id.replaceAll('-', '')}`,
          apply: async (envelopes) => {
            for (const envelope of envelopes)
              events.push(
                ...envelope.events.filter(
                  (event) =>
                    effect.types.includes(event.type) && (event.data as { itemId?: string }).itemId === current.id,
                ),
              );
          },
        });
        expect(page.status).toBe('read');
        if (page.status !== 'read' || page.envelopes < 64) break;
      }
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) await effect.run(event);
      barrier.release();
      expect((await recovery).complete).toBe(false);
      const projected = (
        await f.pool.query(
          `SELECT hosted_catalogue,draft_revision_id FROM content.author_item
         WHERE route=$1 AND author_account_id=$2 AND item_kind='post' AND item_id=$3`,
          [routeOf(f.author.actor.accountId), f.author.actor.accountId, current.id],
        )
      ).rows[0]!;
      expect(projected).toEqual({ hosted_catalogue: true, draft_revision_id: revised.value.post.revisionId });
      expect(await pending(current.id)).toBe(true);
      await repair();
      expect(await pending(current.id)).toBe(false);
      expect((await f.call('GET', `${home()}/${probe.id}`)).status).toBe(200);
    } finally {
      barrier.release();
      await recovery;
    }
  } finally {
    await observer.close();
  }
});
