import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { routeOf } from '../../src/route/route.ts';
import { assertMemberPageCurrent } from '../../src/library/member-viewer-currentness.ts';
import { assertShelfPageCurrent } from '../../src/library/shelf-viewer-currentness.ts';
import { createListPresentationFixture } from '../semantic/support/list-presentation-fixture.ts';

let fixture: Awaited<ReturnType<typeof createListPresentationFixture>>;

beforeAll(async () => {
  fixture = await createListPresentationFixture({ poolMax: 1 });
  await fixture.checked('POST', '/v1/platform/exposure/collections:open', {}, 'operator');
}, 180_000);

afterAll(async () => {
  await fixture?.close();
}, 180_000);

function interleaveViewerEntries(mutate: () => Promise<unknown>) {
  const pool = fixture.pool;
  const descriptor = Object.getOwnPropertyDescriptor(pool, 'connect');
  const connect = pool.connect;
  let interleaved = false;
  Object.defineProperty(pool, 'connect', {
    configurable: true,
    value: async () => {
      const client = (await Reflect.apply(connect, pool, [])) as PoolClient;
      return new Proxy(client, {
        get(target, property) {
          if (property !== 'query') {
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async (...args: unknown[]) => {
            const first = args[0];
            const statement =
              typeof first === 'string'
                ? first
                : typeof first === 'object' && first !== null && 'text' in first
                  ? String(first.text)
                  : '';
            if (!interleaved && statement.includes('incarnation_id AS "incarnationId"')) {
              interleaved = true;
              await mutate();
            }
            return Reflect.apply(Reflect.get(target, 'query', target), target, args);
          };
        },
      });
    },
  });
  return {
    interleaved: () => interleaved,
    restore() {
      if (descriptor) Object.defineProperty(pool, 'connect', descriptor);
      else Reflect.deleteProperty(pool, 'connect');
    },
  };
}

test('member currentness preserves occurrence identity and refuses changed or unavailable pages', () => {
  const observed = {
    members: [
      { id: 'first', subjectId: 'same', note: 'first note', addedAt: '2026-01-01', orderKey: 'a' },
      { id: 'second', subjectId: 'same', note: 'second note', addedAt: '2026-01-02', orderKey: 'b' },
    ],
    next: 'opaque-first-cursor',
  };
  expect(() =>
    assertMemberPageCurrent(
      observed,
      {
        ...observed,
        members: observed.members.map((member) => ({ ...member, subject: { id: member.subjectId }, facts: {} })),
      },
      { listFactsAttached: true },
    ),
  ).not.toThrow();
  expect(() =>
    assertMemberPageCurrent(observed, {
      ...observed,
      members: [{ ...observed.members[0]!, note: 'changed' }, observed.members[1]!],
    }),
  ).toThrow();
  expect(() => assertMemberPageCurrent(observed, { preparing: true })).toThrow();
});

test.serial(
  'Collection route withholds duplicate occurrence facts when one admitted row disappears during viewer overlay',
  async () => {
    const book = await fixture.create('schema:Book');
    await fixture.checked('PUT', `/v1/libraryEntries/${book}`, { state: 'completed' }, 'editor');
    const { collection } = await fixture.checked('POST', '/v1/collections', {
      title: 'Viewer currentness',
      visibility: 'public',
    });
    for (const subjectId of [book, book])
      await fixture.checked('POST', `/v1/collections/${collection.id}/members`, { subjectId });
    const read = () => fixture.call('GET', `/v1/collections/${collection.id}/members?view=FULL`, undefined, 'editor');
    const initial = await read();
    expect(initial.status).toBe(200);
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
    expect(interleave.interleaved()).toBe(true);
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
  const book = await fixture.create('schema:Book');
  await fixture.checked('PUT', `/v1/libraryEntries/${book}`, { state: 'completed' }, 'editor');
  await fixture.db.admin.query(
    `INSERT INTO access.exposure_opening ("group",valid,transaction_id)
     VALUES ('personal_library',tstzrange('2020-01-01T00:00:00Z',NULL,'[)'),$1),
            ('reading_progress',tstzrange('2020-01-01T00:00:00Z',NULL,'[)'),$2)`,
    [randomUUID(), randomUUID()],
  );
  const path = '/v1/libraryEntries?view=FULL&orderBy=createdAt&direction=desc&limit=10';
  const read = () => fixture.call('GET', path, undefined, 'editor');
  const initial = await read();
  expect(initial.status).toBe(200);
  expect((initial.body as { libraryEntries: Array<{ subjectId: string }> }).libraryEntries).toMatchObject([
    { subjectId: book },
  ]);

  const interleave = interleaveViewerEntries(() =>
    fixture.db.admin.query(
      "UPDATE library.entry SET state='paused', revision=revision+1, updated_at=now() WHERE route=$1 AND account_id=$2 AND subject_id=$3",
      [routeOf(fixture.accounts.editor), fixture.accounts.editor, book],
    ),
  );
  let response: Awaited<ReturnType<typeof read>>;
  try {
    response = await read();
  } finally {
    interleave.restore();
  }
  expect(interleave.interleaved()).toBe(true);
  expect(response.status).toBe(503);
  const problem = response.body;
  expect(problem).toMatchObject({ code: 'semantic_not_ready' });
  expect(problem).not.toHaveProperty('libraryEntries');
  expect(problem).not.toHaveProperty('viewerFacts');
});
