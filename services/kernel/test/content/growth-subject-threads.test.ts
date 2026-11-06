import { afterAll, expect, test } from 'bun:test';
import { createAccess } from '../../src/access/index.ts';
import { listSubjectThreads } from '../../src/content/subject-threads.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());

test('subject thread page stays within its bound as the subject thread index grows', async () => {
  const subjectId = newId(0x4567);
  const subjectRoute = routeOf(subjectId)!;
  await db.admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id)
     VALUES ($1,$2,'schema:Book',$2) ON CONFLICT DO NOTHING`,
    [subjectRoute, subjectId],
  );
  const population: Population = {
    name: `growth-subject-thread-pages-${crypto.randomUUID()}`,
    hotPartition: subjectRoute >>> 4,
    hotShare: 1,
    rows: ({ ordinal }) => {
      const threadId = newId(0x1234);
      return {
        'content.subject_thread': [
          {
            route: subjectRoute,
            subject_id: subjectId,
            thread_route: routeOf(threadId),
            thread_id: threadId,
            place_id: GLOBAL_CONTEXT,
            kind: 'discussion',
            last_activity_at: '2026-10-27T00:00:00.000Z',
            source_epoch: 1,
            source_position: ordinal + 1,
          },
        ],
      };
    },
  };
  const access = createAccess({
    actions: new Map([
      ['subject:read', { anonymous: true }],
      ['thread:read', { anonymous: true }],
      ['post:read', { anonymous: true }],
      ['board:read', { anonymous: true }],
    ]),
  });
  const dependencies = {
    clock: () => new Date(),
    pool: db.pool,
    access,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) },
    routeKey: new Uint8Array(32).fill(41),
    cursorNow: () => Date.UTC(2026, 9, 27),
  };
  const context = { actor: { kind: 'anonymous' as const }, deadline: Date.now() + 30_000 };

  const report = await checkGrowth(db, {
    name: 'Subject thread page',
    scales: [256, 1024, 4096],
    repetitions: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (database, scale, previous) => seed(database, population, { from: previous, to: scale }),
    async operation() {
      const page = await listSubjectThreads(dependencies, subjectId, context, {
        place: GLOBAL_CONTEXT,
        kind: 'discussion',
        limit: 20,
      });
      expect(page.entries).toEqual([]);
      expect(page.nextCursor).toEqual(expect.any(String));
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
});
