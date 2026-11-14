import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { serializeDocument } from '@rezics/document';
import { hostedBookPageDisclosureFixture } from './support/hosted-book-page-disclosure-fixture.ts';
import readChain from '../../src/content/read-chain.sql';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);

let f: Awaited<ReturnType<typeof hostedBookPageDisclosureFixture>>;
let observer: ReturnType<typeof observeSql>;

beforeAll(async () => {
  f = await hostedBookPageDisclosureFixture();
  observer = observeSql(f.native.pool);
});

afterAll(async () => {
  await observer?.close();
  await f?.close();
});

function bodyProbes(start: number) {
  const probes = observer.records.slice(start).filter((row) => row.statement === readChain.sql);
  return probes.filter((row) => row.parameters[readChain.params.indexOf('include_body')] === true);
}

function childrenPath(revisionId: string, limit?: number, cursor?: string) {
  const query = new URLSearchParams({ kind: 'publication', revisionId });
  if (limit !== undefined) query.set('limit', String(limit));
  if (cursor !== undefined) query.set('cursor', cursor);
  return `${f.path}/children?${query}`;
}

function occurrencePath(occurrenceId: string, revisionId: string, metadata = false) {
  const suffix = metadata ? '/metadata' : '';
  return `${f.path}/occurrences/${occurrenceId}${suffix}?kind=publication&revisionId=${revisionId}`;
}

const get = (path: string) => f.native.call('GET', path, undefined, { anonymous: true });

test('published private selections appear in pages under their own consent and retain raw progress', async () => {
  const [first, duplicate, unavailable] = f.items;
  const pageStart = observer.records.length;
  const contents = await get(childrenPath(f.publicationId));
  expect(contents.status).toBe(200);
  expect(contents.value.items).toHaveLength(3);
  expect(contents.value.items[0]).toMatchObject({
    occurrenceId: first!.occurrenceId,
    title: first!.title,
    target: f.targetA,
    availability: 'available',
  });
  expect(contents.value.items[1]).toMatchObject({
    occurrenceId: duplicate!.occurrenceId,
    title: duplicate!.title,
    target: f.targetA,
    availability: 'available',
  });
  expect(contents.value.items[2]).toEqual({
    occurrenceId: unavailable!.occurrenceId,
    parentId: null,
    position: 2,
    kind: 'chapter',
    availability: 'unavailable',
  });

  const next = await get(
    `${f.path}/occurrences/${first!.occurrenceId}/navigation?kind=publication&revisionId=${f.publicationId}&direction=next`,
  );
  expect(next.value.items[0]).toMatchObject({
    occurrenceId: duplicate!.occurrenceId,
    title: duplicate!.title,
    target: f.targetA,
    availability: 'available',
  });
  expect(next.value.items[1]).toMatchObject({ occurrenceId: unavailable!.occurrenceId, availability: 'unavailable' });

  const previous = await get(
    `${f.path}/occurrences/${unavailable!.occurrenceId}/navigation?kind=publication&revisionId=${f.publicationId}&direction=previous`,
  );
  expect(previous.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    duplicate!.occurrenceId,
    first!.occurrenceId,
  ]);
  expect(previous.value.items[0]).toMatchObject({
    title: duplicate!.title,
    target: f.targetA,
    availability: 'available',
  });
  expect(previous.value.items[1]).toMatchObject({ title: first!.title, target: f.targetA, availability: 'available' });

  const metadata = await get(occurrencePath(first!.occurrenceId, f.publicationId, true));
  expect(metadata.value.occurrence).toMatchObject({
    occurrenceId: first!.occurrenceId,
    title: first!.title,
    target: f.targetA,
    availability: 'available',
  });
  expect(bodyProbes(pageStart)).toHaveLength(0);

  const openingStart = observer.records.length;
  const opening = await get(occurrencePath(first!.occurrenceId, f.publicationId));
  expect(opening.status).toBe(200);
  expect(opening.value.occurrence).toEqual(metadata.value.occurrence);
  expect(opening.value.document.canonicalBytes).toBe(
    Buffer.from(serializeDocument(f.sourceBody), 'utf8').toString('base64'),
  );
  expect(opening.value.document.sha256).toBe(f.targetA.sha256);
  expect(bodyProbes(openingStart)).toHaveLength(1);

  expect((await get(`/v1/posts/${f.targetA.postId}`)).status).toBe(404);
  const otherBook = await f.native.call(
    'GET',
    `/v1/hostedCatalogues/${f.other.catalogueId}/occurrences/${f.other.occurrenceId}?kind=publication&revisionId=${f.other.publicationId}`,
    undefined,
    { anonymous: true },
  );
  expect(otherBook.value.occurrence).toEqual({
    occurrenceId: f.other.occurrenceId,
    parentId: null,
    position: 0,
    kind: 'chapter',
    availability: 'unavailable',
  });

  const movedPublicationId = await f.moveDraftAndPublish();
  const historical = await get(childrenPath(f.publicationId));
  expect(historical.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    first!.occurrenceId,
    duplicate!.occurrenceId,
    unavailable!.occurrenceId,
  ]);
  expect(historical.value.items[0]).toMatchObject({ title: first!.title, target: f.targetA });
  expect(historical.value.items[1]).toMatchObject({ title: duplicate!.title, target: f.targetA });
  const moved = await get(childrenPath(movedPublicationId));
  expect(moved.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    unavailable!.occurrenceId,
    duplicate!.occurrenceId,
    first!.occurrenceId,
  ]);
  expect(moved.value.items[0]).toMatchObject({ title: 'Moved unconsented chapter' });
  expect(moved.value.items[2]).toMatchObject({ title: 'Moved private title', target: f.targetA });

  const progressStart = observer.records.length;
  const firstPage = await get(childrenPath(f.publicationId, 1));
  expect(firstPage.value.items[0]).toMatchObject({ occurrenceId: first!.occurrenceId, availability: 'available' });
  expect(firstPage.value.nextCursor).toEqual(expect.any(String));
  await f.revokeConsent(f.disclosureId);
  const revokedDuplicate = await get(childrenPath(f.publicationId, 1, firstPage.value.nextCursor));
  expect(revokedDuplicate.value.items[0]).toEqual({
    occurrenceId: duplicate!.occurrenceId,
    parentId: null,
    position: 1,
    kind: 'chapter',
    availability: 'unavailable',
  });
  expect(revokedDuplicate.value.nextCursor).toEqual(expect.any(String));
  const afterRevocation = await get(childrenPath(f.publicationId, 1, revokedDuplicate.value.nextCursor));
  expect(afterRevocation.value.items[0]).toMatchObject({ occurrenceId: unavailable!.occurrenceId, position: 2 });
  expect(afterRevocation.value.items[0]).not.toHaveProperty('title');
  expect(afterRevocation.value.nextCursor).toBeNull();

  await f.reissueConsent();
  await f.hardRestrict(f.targetA);
  const restrictedFirst = await get(childrenPath(f.publicationId, 1));
  expect(restrictedFirst.value.items[0]).toEqual({
    occurrenceId: first!.occurrenceId,
    parentId: null,
    position: 0,
    kind: 'chapter',
    availability: 'unavailable',
  });
  expect(restrictedFirst.value.nextCursor).toEqual(expect.any(String));
  const restrictedDuplicate = await get(childrenPath(f.publicationId, 1, restrictedFirst.value.nextCursor));
  expect(restrictedDuplicate.value.items[0]).toEqual({
    occurrenceId: duplicate!.occurrenceId,
    parentId: null,
    position: 1,
    kind: 'chapter',
    availability: 'unavailable',
  });
  expect(restrictedDuplicate.value.nextCursor).toEqual(expect.any(String));
  const afterRestriction = await get(childrenPath(f.publicationId, 1, restrictedDuplicate.value.nextCursor));
  expect(afterRestriction.value.items[0]).toMatchObject({ occurrenceId: unavailable!.occurrenceId, position: 2 });
  expect(afterRestriction.value.nextCursor).toBeNull();
  expect(bodyProbes(progressStart)).toHaveLength(0);
});
