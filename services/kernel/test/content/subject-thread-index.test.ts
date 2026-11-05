import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSubjectThreadEffect } from '../../src/content/subject-thread-index.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());

const threadRoute = 0x1234;
const firstPostId = newId(threadRoute);
const authorId = newId(0x9abc);
const placeId = newId(0x4560);
const createdAt = '2026-10-27T00:00:00.000Z';
const createdType = 'com.rezics.content.thread.created.v1';
const postType = 'com.rezics.content.post.created.v1';
const revisionType = 'com.rezics.content.revision.created.v1';

function event(
  type: typeof createdType | typeof postType | typeof revisionType,
  sequence: number,
  input: {
    threadId: string;
    itemId: string;
    revisionId?: string;
    placeId?: string;
    subjectIds: readonly string[];
    previousSubjectIds?: readonly string[];
    activityAt: string;
  },
): CloudEvent {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: `urn:rezics:log:${partitionOf(threadRoute)}.1`,
    type,
    subject: input.threadId,
    time: input.activityAt,
    datacontenttype: 'application/json',
    sequence: String(sequence).padStart(19, '0'),
    data: {
      threadId: input.threadId,
      itemId: input.itemId,
      revisionId: input.revisionId ?? newId(threadRoute),
      actorId: authorId,
      placeId: input.placeId ?? placeId,
      kind: 'discussion',
      subjectIds: [...input.subjectIds],
      ...(input.previousSubjectIds === undefined ? {} : { previousSubjectIds: [...input.previousSubjectIds] }),
      activityAt: input.activityAt,
    },
  } as CloudEvent;
}

async function rowsFor(id: string) {
  return (
    await db.admin.query<{
      route: number;
      subject_id: string;
      thread_route: number;
      thread_id: string;
      place_id: string;
      kind: string;
      last_activity_at: string;
      source_epoch: number;
      source_position: string;
    }>(
      `SELECT route, subject_id::text, thread_route, thread_id::text, place_id::text, kind,
         to_char(last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_activity_at,
         source_epoch, source_position::text
       FROM content.subject_thread WHERE thread_id = $1 ORDER BY route, subject_id`,
      [id],
    )
  ).rows;
}

test('a thread is indexed under every subject of its first post current revision in each subject partition', async () => {
  const id = newId(threadRoute);
  const subjects = Array.from({ length: 128 }, (_, index) => newId(0x2340 + Math.floor(index / 16) * 0x10));
  const source = event(createdType, 1, {
    threadId: id,
    itemId: firstPostId,
    subjectIds: subjects,
    activityAt: createdAt,
  });

  await createSubjectThreadEffect(db.pool).run(source);

  const rows = await rowsFor(id);
  expect(rows).toHaveLength(128);
  expect(rows.map(({ subject_id }) => subject_id).sort()).toEqual([...subjects].sort());
  expect(rows.every(({ route, subject_id }) => route === routeOf(subject_id))).toBe(true);
  expect(
    rows.every(
      ({ thread_route, place_id, kind, last_activity_at, source_epoch, source_position }) =>
        thread_route === threadRoute &&
        place_id === placeId &&
        kind === 'discussion' &&
        last_activity_at === '2026-10-27T00:00:00.000000Z' &&
        source_epoch === 1 &&
        source_position === '1',
    ),
  ).toBe(true);
});

test('revising the first post moves its subjects and replay changes nothing', async () => {
  const id = newId(threadRoute);
  const oldSubjects = [newId(0x2370), newId(0x2380), newId(0x2390)];
  const newSubjects = [oldSubjects[1]!, newId(0x23a0), newId(0x23b0)];
  const effect = createSubjectThreadEffect(db.pool);
  const created = event(createdType, 1, {
    threadId: id,
    itemId: firstPostId,
    subjectIds: oldSubjects,
    activityAt: createdAt,
  });
  await effect.run(created);
  const revised = event(revisionType, 2, {
    threadId: id,
    itemId: firstPostId,
    subjectIds: newSubjects,
    previousSubjectIds: oldSubjects,
    activityAt: '2026-10-27T00:01:00.000Z',
  });
  await effect.run(revised);
  const beforeReplay = await rowsFor(id);
  const partitions = [...new Set([...newSubjects, ...oldSubjects].map((subject) => partitionOf(routeOf(subject)!)))];
  const positionsBefore = await db.admin.query(
    'SELECT partition_no, position FROM core.partition WHERE partition_no = ANY($1::integer[]) ORDER BY partition_no',
    [partitions],
  );

  await effect.run(revised);

  const afterReplay = await rowsFor(id);
  const positionsAfter = await db.admin.query(
    'SELECT partition_no, position FROM core.partition WHERE partition_no = ANY($1::integer[]) ORDER BY partition_no',
    [partitions],
  );
  expect(afterReplay).toEqual(beforeReplay);
  expect(positionsAfter.rows).toEqual(positionsBefore.rows);
  expect(afterReplay.map(({ subject_id }) => subject_id).sort()).toEqual([...newSubjects].sort());
  expect(afterReplay.every(({ source_position }) => source_position === '2')).toBe(true);
});

test('a reply updates last activity in the first post subjects indexes', async () => {
  const id = newId(threadRoute);
  const subjects = [newId(0x23c0), newId(0x23d0)];
  const effect = createSubjectThreadEffect(db.pool);
  await effect.run(
    event(createdType, 1, { threadId: id, itemId: newId(threadRoute), subjectIds: subjects, activityAt: createdAt }),
  );

  await effect.run(
    event(postType, 2, {
      threadId: id,
      itemId: newId(threadRoute),
      subjectIds: subjects,
      activityAt: '2026-10-27T00:10:00.000Z',
    }),
  );

  expect(
    (await rowsFor(id)).map(({ last_activity_at, source_position }) => [last_activity_at, source_position]),
  ).toEqual([...subjects].sort().map(() => ['2026-10-27T00:10:00.000000Z', '2']));
});

test('indexing one thread has constant rows and statements and logarithmic blocks as other threads grow', async () => {
  const subjects = [newId(0x23e0), newId(0x23e1)];
  const targetThread = newId(threadRoute);
  const effect = createSubjectThreadEffect(db.pool);
  const subjectPartition = partitionOf(routeOf(subjects[0]!)!);
  const population: Population = {
    name: `growth-subject-thread-index-${randomUUID()}`,
    hotPartition: subjectPartition,
    hotShare: 1,
    rows: ({ route, ordinal }) => {
      const otherThreadId = newId(route);
      const otherThreadRoute = routeOf(otherThreadId)!;
      const common = {
        thread_route: otherThreadRoute,
        thread_id: otherThreadId,
        place_id: GLOBAL_CONTEXT,
        kind: 'discussion',
        last_activity_at: createdAt,
        source_epoch: 1,
        source_position: String(ordinal + 1),
      };
      return {
        'content.subject_thread': subjects.map((subjectId) => ({
          route: routeOf(subjectId)!,
          subject_id: subjectId,
          ...common,
        })),
      };
    },
  };
  await seed(db, population, { from: 0, to: 4096 });
  await seed(
    db,
    {
      name: `${population.name}-receipts`,
      hotPartition: subjectPartition,
      hotShare: 1,
      rows: ({ ordinal, partition, route }) => ({
        'core.receipt': [
          {
            partition_no: partition,
            principal_kind: 'account',
            principal_id: '00000000-0000-4000-8000-000000000001',
            command_kind: 'content.subject-thread.project',
            idempotency_key: `subject-thread-growth-${ordinal}`,
            request_digest: new Uint8Array(32),
            epoch: 1,
            position: ordinal + 1,
            transaction_id: newId(route),
            response: {},
          },
        ],
      }),
    },
    { from: 0, to: 4096 },
  );
  const scales: [number, number, number] = [8, 64, 512];
  let sequence = 1;
  const report = await checkGrowth(db, {
    name: 'subject thread index event',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (database, scale, previous) => seed(database, population, { from: previous, to: scale }),
    async operation(_database, repetition) {
      await effect.run(
        event(createdType, sequence++, {
          threadId: targetThread,
          itemId: newId(threadRoute),
          subjectIds: subjects,
          activityAt: createdAt,
        }),
      );
      return repetition;
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual(scales);
  for (const sample of report.samples) expect(sample.cost.rows).toBeLessThanOrEqual(128);
});

test('an unscoped board uses the global context as its place', async () => {
  const id = newId(threadRoute);
  const subjectId = newId(0x23f8);
  await createSubjectThreadEffect(db.pool).run(
    event(createdType, 1, {
      threadId: id,
      itemId: newId(threadRoute),
      placeId: GLOBAL_CONTEXT,
      subjectIds: [subjectId],
      activityAt: createdAt,
    }),
  );

  expect(await rowsFor(id)).toMatchObject([{ place_id: GLOBAL_CONTEXT, subject_id: subjectId }]);
});
