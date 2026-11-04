import { afterAll, beforeAll, expect, test } from 'bun:test';
import targets from '../../src/content/appeal-review-page-targets.sql';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createGrowthAppealBoundariesFixture } from './support/growth-appeal-boundaries-fixture.ts';

let fixture: Awaited<ReturnType<typeof createGrowthAppealBoundariesFixture>>;
beforeAll(async () => {
  fixture = await createGrowthAppealBoundariesFixture();
}, 300_000);
afterAll(async () => {
  await fixture?.close();
});

test('mounted inspection covers each final source independently of parent authorization and selection page', async () => {
  const { people } = fixture;
  const boardId = await fixture.createBoard('Appeal source observation parent');
  let sourceHome: string | undefined;
  for (let attempt = 0; attempt < 16 && sourceHome === undefined; attempt++) {
    const candidate = await fixture.createBoard(`Appeal source observation home ${attempt}`);
    if (fixture.routed(candidate) !== fixture.routed(boardId)) sourceHome = candidate;
  }
  expect(sourceHome).toBeDefined();
  await fixture.grant(boardId, people.reviewer.accountId, ['moderation:read_reports']);

  const records = [];
  for (let index = 0; index < 2; index++) {
    const target = await fixture.createThread(boardId, `Cross-partition appeal ${index}`, sourceHome!);
    expect(fixture.routed(target.threadId)).not.toBe(fixture.routed(boardId));
    records.push(await fixture.submitAppeal(boardId, target));
  }

  const pagePath = `/v1/boards/${boardId}/appeals?limit=1`;
  const bearer = people.reviewer.bearer;
  const page = await fixture.call('GET', pagePath, { bearer });
  expect(page.response.status).toBe(200);
  expect(page.body?.appeals).toHaveLength(1);
  const firstIds = page.body!.appeals.map((row: { id: string }) => row.id) as string[];
  const selected = records.find(({ record }) => !firstIds.includes(record.appealId));
  expect(selected).toBeDefined();
  const record = selected!.record;
  const path = `${pagePath}&inspect=${record.appealId}`;
  const denied = await fixture.call('GET', path, { bearer: people.author.bearer });
  expect(denied.response.status).toBe(404);
  expect(denied.body).toMatchObject({ code: 'not_found' });

  const initial = await fixture.call('GET', path, { bearer });
  expect(initial.response.status).toBe(200);
  expect(initial.body?.appeals).toEqual(page.body?.appeals);
  expect(initial.body?.next).toBe(page.body?.next);
  expect(initial.body?.selectedAppeal).toMatchObject({ id: record.appealId, resolution: null });
  expect(initial.body?.provenance.source.partition).toBe(partitionOf(routeOf(boardId)!));
  expect(initial.body?.selectedAppeal.source.partition).toBe(partitionOf(routeOf(record.threadId)!));
  expect(initial.body?.selectedAppeal.source.partition).not.toBe(initial.body?.provenance.source.partition);

  const covered = (body: any) => {
    for (const row of [...body.appeals, ...(body.selectedAppeal ? [body.selectedAppeal] : [])])
      expect(body.provenance.sourceObservations).toContainEqual({ appealId: row.id, source: row.source });
  };
  covered(initial.body);
  const initialSource = initial.body!.selectedAppeal.source;

  const barrier = fixture.observer.hold({ statement: targets.sql, occurrence: 2 }, 'before');
  const pending = fixture.call('GET', path, { bearer });
  try {
    await barrier.entered;
    await fixture.resolveAppeal(record);
  } finally {
    barrier.release();
  }
  const final = await pending;
  expect(final.response.status).toBe(200);
  expect(final.body?.appeals).toEqual(page.body?.appeals);
  expect(final.body?.next).toBe(page.body?.next);
  expect(final.body?.selectedAppeal).toMatchObject({
    id: record.appealId,
    resolution: { outcome: 'upheld', statement: 'Reviewed independently' },
  });
  expect(BigInt(final.body!.selectedAppeal.source.position)).toBeGreaterThan(BigInt(initialSource.position));
  covered(final.body);

  const unknown = await fixture.call('GET', `${pagePath}&inspect=${newId(routeOf(boardId)!)}`, { bearer });
  expect(unknown.response.status).toBe(404);
  expect(unknown.body).toMatchObject({ code: 'not_found' });
}, 300_000);
