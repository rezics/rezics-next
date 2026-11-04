import { afterAll, beforeAll, expect, test } from 'bun:test';
import { routeOf } from '../../src/route/route.ts';
import { assertMemberPageCurrent } from '../../src/library/member-viewer-currentness.ts';
import { createCollectionListFactsFixture } from './support/collection-list-facts-fixture.ts';

let fixture: Awaited<ReturnType<typeof createCollectionListFactsFixture>>;

beforeAll(async () => {
  fixture = await createCollectionListFactsFixture();
}, 180_000);

afterAll(async () => {
  await fixture?.close();
}, 180_000);

function interleaveViewerEntries(mutate: () => Promise<unknown>) {
  const pool = fixture.database.pool;
  const descriptor = Object.getOwnPropertyDescriptor(pool, 'connect');
  const connect = pool.connect;
  let interleaved = false;
  Object.defineProperty(pool, 'connect', {
    configurable: true,
    value: async () => {
      const client = await Reflect.apply(connect, pool, []);
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
    assertMemberPageCurrent(observed, {
      ...observed,
      members: observed.members.map((member) => ({ ...member, subject: { id: member.subjectId }, facts: {} })),
    }, { listFactsAttached: true }),
  ).not.toThrow();
  expect(() =>
    assertMemberPageCurrent(observed, {
      ...observed,
      members: [{ ...observed.members[0]!, note: 'changed' }, observed.members[1]!],
    }),
  ).toThrow();
  expect(() => assertMemberPageCurrent(observed, { preparing: true })).toThrow();
});

test('Collection route withholds duplicate occurrence facts when one admitted row disappears during viewer overlay', async () => {
  const book = await fixture.create('schema:Book');
  await fixture.checked('PUT', `/v1/libraryEntries/${book}`, { state: 'completed' }, 'editor');
  const collection = await fixture.collection([book, book]);
  const initial = await fixture.get(collection.id);
  const initialPage = (await initial.json()) as {
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
    fixture.database.admin.query(
      'DELETE FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3',
      [routeOf(collection.id), collection.id, removed.id],
    ),
  );
  let response: Response;
  try {
    response = await fixture.get(collection.id);
  } finally {
    interleave.restore();
  }
  expect(interleave.interleaved()).toBe(true);
  expect(response!.status).toBe(409);
  const problem = await response!.json();
  expect(problem).toMatchObject({ code: 'stale_cursor' });
  expect(problem).not.toHaveProperty('members');
  expect(problem).not.toHaveProperty('viewerFacts');
});
