import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import readReceipt from '../../src/command/read-receipt.sql';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql, type SqlExecution } from './support/sql-observer.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
let observer: ReturnType<typeof observeSql>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
  observer = observeSql(f.native.pool);
});
afterAll(async () => {
  await observer?.close();
  await f?.close();
});
const sourceReads = (records: readonly SqlExecution[]) =>
  records.filter((row) =>
    /FROM content.hosted_structure_revision|FROM content.hosted_occurrence_state_version/.test(row.statement),
  );

test('native admission and receipt lookup precede release reads; exact publish replay returns its original result', async () => {
  const parent = f.newOccurrenceId(),
    child = f.newOccurrenceId();
  const placements = [
    { occurrenceId: parent, parentId: null, position: 0, title: 'Part', kind: 'part' },
    { occurrenceId: child, parentId: parent, position: 0, title: 'Section', kind: 'part' },
  ];
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: f.catalogueId,
    threadId: f.threadId,
    placements,
  });
  const path = `/v1/hostedCatalogues/${f.catalogueId}`;
  const body = { expectedRevisionId: created.revisionId, expectedPublicationId: null, occurrenceIds: [child] };
  for (const input of [
    body,
    { ...body, expectedRevisionId: f.newOccurrenceId() },
    { ...body, occurrenceIds: [f.newOccurrenceId()] },
  ]) {
    const start = observer.records.length;
    expect((await f.native.call('POST', `${path}:publish`, input, { other: true })).status).toBe(403);
    const records = observer.records.slice(start);
    expect(sourceReads(records)).toEqual([]);
    expect(records.some((row) => row.statement === readReceipt.sql)).toBe(false);
    expect(records.some((row) => row.statement.includes('INSERT INTO content.hosted_'))).toBe(false);
  }
  const rejected = observer.records.length;
  expect((await f.native.call('POST', `${path}:publish`, body)).status).toBe(400);
  expect(sourceReads(observer.records.slice(rejected)).length).toBeGreaterThan(0);
  expect(observer.records.slice(rejected).some((row) => row.statement === readReceipt.sql)).toBe(true);

  const exact = { ...body, occurrenceIds: [child, parent] };
  const key = crypto.randomUUID();
  const start = observer.records.length;
  const published = await f.native.call('POST', `${path}:publish`, exact, { key });
  expect(published.status, JSON.stringify(published.value)).toBe(200);
  const publicationReads = sourceReads(observer.records.slice(start));
  expect(publicationReads.length).toBeGreaterThan(0);
  expect(
    observer.records.slice(start).some((row) => /FROM content\.hosted_(placement|append\b)/.test(row.statement)),
  ).toBe(false);
  await f.native.command(`${path}:revise`, { expectedRevisionId: created.revisionId, placements: [] }, 200);
  const replayStart = observer.records.length;
  const replay = await f.native.call('POST', `${path}:publish`, exact, { key });
  expect(replay.status).toBe(200);
  expect(replay.value).toEqual(published.value);
  expect(sourceReads(observer.records.slice(replayStart))).toEqual([]);
  await f.native.command(`/v1/posts/${f.catalogueId}:erase`, { reason: 'Withdraw catalogue authority' }, 200);
  expect((await f.native.call('POST', `${path}:publish`, exact, { key })).status).toBe(404);
});
