import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { routeOf } from '../../src/route/route.ts';
import { testTokens } from '../support/test-kernel.ts';
import { assertMemberPageCurrent, listMemberPage } from '../../src/library/member-viewer-currentness.ts';
import { assertShelfPageCurrent } from '../../src/library/shelf-viewer-currentness.ts';
import viewerEntries from '../../src/library/viewer-facts-entries.sql';
import { createListPresentationFixture } from '../semantic/support/list-presentation-fixture.ts';

let fixture: Awaited<ReturnType<typeof createListPresentationFixture>>;

beforeAll(async () => {
  fixture = await createListPresentationFixture({ poolMax: 1 });
  await fixture.grant('editor', 'gate:collections');
  await fixture.grant('editor', 'gate:personal_library');
}, 180_000);

afterAll(async () => {
  await fixture?.close();
}, 180_000);

function interleaveViewerEntries(mutate: () => Promise<{ rowCount: number | null }>) {
  const pool = fixture.pool;
  const selected = viewerEntries['~standard'].query.text;
  const wrapped = new Map<PoolClient, { original: PoolClient['query']; observer: PoolClient['query'] }>();
  let active = true;
  let mutation: Promise<{ rowCount: number | null }> | undefined;
  const acquire = (client: PoolClient) => {
    if (wrapped.has(client)) return;
    const original = client.query;
    // The native work observer wraps this same checkout. Capture the underlying method once.
    const observer = new Proxy(original, {
      apply(query, receiver, args) {
        const input = args[0];
        const text = typeof input === 'string' ? input : input?.text;
        if (active && !mutation && (text === selected || text === viewerEntries.sql)) {
          mutation = mutate();
          return mutation.then(() => Reflect.apply(query, receiver, args));
        }
        return Reflect.apply(query, receiver, args);
      },
    });
    wrapped.set(client, { original, observer });
    client.query = observer;
  };
  pool.on('acquire', acquire);
  return {
    mutation: () => mutation,
    restore() {
      active = false;
      pool.off('acquire', acquire);
      for (const [client, { original, observer }] of wrapped) {
        if (client.query === observer) client.query = original;
      }
      wrapped.clear();
    },
  };
}

test('member currentness preserves occurrence identity and refuses changed or unavailable pages', async () => {
  const observed = {
    members: [
      { id: 'first', subjectId: 'same', note: 'first note', addedAt: '2026-01-01', orderKey: 'a' },
      { id: 'second', subjectId: 'same', note: 'second note', addedAt: '2026-01-02', orderKey: 'b' },
    ],
    next: 'opaque-first-cursor',
  };
  await assertMemberPageCurrent(
    observed,
    {
      ...observed,
      members: observed.members.map((member) => ({ ...member, subject: { id: member.subjectId }, facts: {} })),
    },
    { listFactsAttached: true },
  );
  await expect(
    assertMemberPageCurrent(observed, {
      ...observed,
      members: [{ ...observed.members[0]!, note: 'changed' }, observed.members[1]!],
    }),
  ).rejects.toMatchObject({ code: 'stale_cursor' });
  await expect(assertMemberPageCurrent(observed, { preparing: true })).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
});

test('member reread authenticates the original continuation against its current private frontier', async () => {
  const tokens = testTokens();
  const binding = {
    route: 'GET /v1/collections/{collectionId}/members',
    viewer: randomUUID(),
    query: { collectionId: randomUUID(), query: 'private-filter-digest', limit: 1, sort: 'id' },
  };
  const members = [{ kind: 'dynamic', subjectId: randomUUID() }];
  const position = { epoch: 1, after: ['basis', 'capture', 'revision', 'owner-fence', members[0]!.subjectId] };
  const now = new Date();
  const read = (scope = binding, frontier = position, at = now) =>
    listMemberPage(members, tokens, scope, frontier, () => at);
  const observed = await read();
  const current = await read();
  expect(observed.next).toBeString();
  expect(current.next).toBeString();
  expect(current.next).not.toBe(observed.next);
  await assertMemberPageCurrent(observed, current);

  const stale = { code: 'stale_cursor' };
  const changed = await read(binding, { ...position, after: ['replacement-basis', ...position.after.slice(1)] });
  await expect(assertMemberPageCurrent(observed, changed)).rejects.toMatchObject(stale);
  const advanced = await read(binding, { ...position, after: [...position.after.slice(0, -1), randomUUID()] });
  await expect(assertMemberPageCurrent(observed, advanced)).rejects.toMatchObject(stale);
  const foreign = await read({ ...binding, viewer: randomUUID() });
  await expect(assertMemberPageCurrent(foreign, current)).rejects.toMatchObject(stale);
  const otherFilter = await read({ ...binding, query: { ...binding.query, query: 'different-digest' } });
  await expect(assertMemberPageCurrent(otherFilter, current)).rejects.toMatchObject(stale);
  await expect(assertMemberPageCurrent({ members, next: null }, current)).rejects.toMatchObject(stale);
  await expect(assertMemberPageCurrent(observed, { members, next: null })).rejects.toMatchObject(stale);
  await expect(assertMemberPageCurrent({ members, next: 'forged' }, current)).rejects.toMatchObject(stale);
  const expired = await read(binding, position, new Date(now.getTime() - 16 * 60_000));
  await expect(assertMemberPageCurrent(expired, current)).rejects.toMatchObject(stale);
});

test.serial(
  'Collection route withholds duplicate occurrence facts when one admitted row disappears during viewer overlay',
  async () => {
    const book = await fixture.create('schema:Book');
    await fixture.checked('PUT', `/v1/libraryEntries/${book}`, { state: 'completed' }, 'editor');
    const { collection } = await fixture.checked('POST', '/v1/collections', {
      title: 'Viewer currentness',
      visibility: 'private',
    });
    for (const subjectId of [book, book])
      await fixture.checked('POST', `/v1/collections/${collection.id}/members`, { subjectId });
    const path = `/v1/collections/${collection.id}/members?view=FULL`;
    const read = () => fixture.call('GET', path, undefined, 'editor');
    const initial = await read();
    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    const initialPage = initial.body as {
      members: Array<{ id: string; subjectId: string }>;
      viewerFacts?: { state: string; rows?: Array<{ rowKey: string }> };
    };
    expect(initialPage.members.map((member) => member.subjectId)).toEqual([book, book]);
    expect(initialPage.members[0]!.id).not.toBe(initialPage.members[1]!.id);
    if (initialPage.viewerFacts?.state === 'current')
      expect(initialPage.viewerFacts.rows?.map(({ rowKey }) => rowKey)).toEqual(
        initialPage.members.map(({ id }) => id),
      );

    await fixture.grant('reader', 'gate:collections');
    const denied = await fixture.call('GET', path, undefined, 'reader');
    expect(denied.status).toBe(404);
    expect(denied.body).not.toHaveProperty('members');
    expect(denied.body).not.toHaveProperty('viewerFacts');

    const removed = initialPage.members[1]!;
    const interleave = interleaveViewerEntries(() =>
      fixture.db.admin.query(
        'DELETE FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3',
        [routeOf(collection.id), collection.id, removed.id],
      ),
    );
    let response: Awaited<ReturnType<typeof read>>;
    try {
      response = await read();
    } finally {
      interleave.restore();
    }
    expect(await interleave.mutation()).toMatchObject({ rowCount: 1 });
    expect(response.status).toBe(409);
    const problem = response.body;
    expect(problem).toMatchObject({ code: 'stale_cursor' });
    expect(problem).not.toHaveProperty('members');
    expect(problem).not.toHaveProperty('viewerFacts');
  },
);

test('shelf currentness preserves the original cursor and rejects changed rows or unavailable state', () => {
  const observed = {
    entries: [{ subjectId: 'book', state: 'completed', revision: 1 }],
    next: 'original-expiring-cursor',
    scoreQuestion: { id: 'question' },
  };
  expect(() =>
    assertShelfPageCurrent(observed, {
      ...observed,
      entries: [...observed.entries],
      next: 'fresh-cursor-bytes',
    }),
  ).not.toThrow();
  expect(() =>
    assertShelfPageCurrent(observed, {
      ...observed,
      entries: [{ ...observed.entries[0]!, state: 'paused' }],
    }),
  ).toThrow();
  expect(() => assertShelfPageCurrent(observed, { entries: [], next: null })).toThrow();
});

test.serial('shelf route withholds a row whose native Entry changes during viewer overlay', async () => {
  await fixture.grant('reader', 'gate:personal_library');
  await fixture.grant('reader', 'gate:reading_progress');
  const book = await fixture.create('schema:Book');
  await fixture.checked('PUT', `/v1/libraryEntries/${book}`, { state: 'completed' }, 'reader');
  const path = '/v1/libraryEntries?view=FULL&orderBy=createdAt&direction=desc&limit=10';
  const read = () => fixture.call('GET', path, undefined, 'reader');
  const initial = await read();
  expect(initial.status, JSON.stringify(initial.body)).toBe(200);
  expect((initial.body as { libraryEntries: Array<{ subjectId: string }> }).libraryEntries).toMatchObject([
    { subjectId: book },
  ]);

  const interleave = interleaveViewerEntries(() =>
    fixture.db.admin.query(
      "UPDATE library.entry SET state='paused', revision=revision+1, updated_at=now() WHERE route=$1 AND account_id=$2 AND subject_id=$3",
      [routeOf(fixture.accounts.reader), fixture.accounts.reader, book],
    ),
  );
  let response: Awaited<ReturnType<typeof read>>;
  try {
    response = await read();
  } finally {
    interleave.restore();
  }
  expect(await interleave.mutation()).toMatchObject({ rowCount: 1 });
  expect(response.status).toBe(503);
  const problem = response.body;
  expect(problem).toMatchObject({ code: 'semantic_not_ready' });
  expect(problem).not.toHaveProperty('libraryEntries');
  expect(problem).not.toHaveProperty('viewerFacts');
});
