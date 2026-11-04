import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { routeOf } from '../../src/route/route.ts';
import { assertShelfPageCurrent } from '../../src/library/shelf-viewer-currentness.ts';
import { createCollectionListFactsFixture } from './support/collection-list-facts-fixture.ts';

let fixture: Awaited<ReturnType<typeof createCollectionListFactsFixture>>;

beforeAll(async () => {
  fixture = await createCollectionListFactsFixture();
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

test('shelf route withholds a row whose native Entry changes during viewer overlay', async () => {
  const book = await fixture.create('schema:Book');
  await fixture.checked('PUT', `/v1/libraryEntries/${book}`, { state: 'completed' }, 'editor');
  const editor = await fixture.deps('editor');
  if (editor.actor.kind !== 'account') throw new Error('Editor fixture must authenticate');
  const token = await fixture.credential(editor.actor.scopes);
  const path = '/v1/libraryEntries?view=FULL&orderBy=createdAt&direction=desc&limit=10';
  const read = () =>
    fixture.kernel.handle(new Request(`http://kernel.test${path}`, { headers: { authorization: `Bearer ${token}` } }));
  const initial = await read();
  expect(initial.status).toBe(200);
  expect(((await initial.json()) as { libraryEntries: Array<{ subjectId: string }> }).libraryEntries).toMatchObject([
    { subjectId: book },
  ]);

  const interleave = interleaveViewerEntries(() =>
    fixture.db.admin.query(
      "UPDATE library.entry SET state='paused', revision=revision+1, updated_at=now() WHERE route=$1 AND account_id=$2 AND subject_id=$3",
      [routeOf(fixture.accounts.editor), fixture.accounts.editor, book],
    ),
  );
  let response: Response;
  try {
    response = await read();
  } finally {
    interleave.restore();
  }
  expect(interleave.interleaved()).toBe(true);
  expect(response!.status).toBe(503);
  const problem = await response!.json();
  expect(problem).toMatchObject({ code: 'semantic_not_ready' });
  expect(problem).not.toHaveProperty('libraryEntries');
  expect(problem).not.toHaveProperty('viewerFacts');
});
