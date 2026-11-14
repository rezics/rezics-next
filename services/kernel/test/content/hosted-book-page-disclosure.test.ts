import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { serializeDocument } from '@rezics/document';
import { hostedBookPageDisclosureFixture } from './support/hosted-book-page-disclosure-fixture.ts';
import { discloseHostedPageTargets } from '../../src/content/hosted-chapters-reads.ts';
import type { AnchoredPosition } from '../../src/content/model.ts';
import type { HostedChapterTarget, OrderedHostedPlacement } from '../../src/content/hosted-chapters-model.ts';
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

function pageTarget(id: string): HostedChapterTarget {
  return {
    threadId: `thread-${id}`,
    postId: `post-${id}`,
    revisionId: `revision-${id}`,
    sha256: id.repeat(64),
  };
}

function pagePlacement(occurrenceId: string, target: HostedChapterTarget, position: number): OrderedHostedPlacement {
  return { occurrenceId, parentId: null, position, title: occurrenceId, kind: 'chapter', target, ordinal: position };
}

function pageAnchor(position: number): AnchoredPosition {
  const partition = {
    partitionNo: 1,
    node: 'local',
    writeState: 'active' as const,
    movedTo: null,
    epoch: 1,
    position: BigInt(position),
  };
  return { partition, epoch: partition.epoch, position: partition.position };
}

test('Book target disclosure is bounded, ordered, and keeps each scoped occurrence proof', async () => {
  type Phase = 'ordinary' | 'scoped' | 'final';
  const active: Record<Phase, number> = { ordinary: 0, scoped: 0, final: 0 };
  const maximum: Record<Phase, number> = { ordinary: 0, scoped: 0, final: 0 };
  const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  async function run<T>(phase: Phase, milliseconds: number, read: () => T): Promise<T> {
    active[phase] += 1;
    maximum[phase] = Math.max(maximum[phase], active[phase]);
    try {
      await wait(milliseconds);
      return read();
    } finally {
      active[phase] -= 1;
    }
  }

  const targets = ['a', 'b', 'c', 'd', 'e', 'f'].map(pageTarget);
  const placements = [
    ...Array.from({ length: 6 }, (_, index) => pagePlacement(`a${index + 1}`, targets[0]!, index)),
    ...targets.slice(1).map((target, index) => pagePlacement(target.threadId.slice(7), target, index + 6)),
  ];
  const ordinaryStarted: string[] = [];
  const ordinaryFinished: string[] = [];
  const scopedStarted: string[] = [];
  const finalFinished: string[] = [];
  let ordinaryFinishedWhenScopedStarted = -1;
  let scopedFinishedWhenFinalStarted = -1;
  let scopedFinished = 0;
  const ordinaryDelay: Record<string, number> = {
    'thread-a': 30,
    'thread-b': 26,
    'thread-c': 22,
    'thread-d': 2,
    'thread-e': 15,
    'thread-f': 12,
  };
  const finalDelay: Record<string, number> = {
    'thread-b': 30,
    'thread-c': 26,
    'thread-d': 2,
    'thread-e': 22,
    'thread-f': 18,
    'scope:a1': 14,
    'scope:a2': 10,
  };
  const guard = (key: string, result: Readonly<{ anchor: AnchoredPosition }> | null) => ({
    final: () => {
      if (finalFinished.length === 0) scopedFinishedWhenFinalStarted = scopedFinished;
      return run('final', finalDelay[key] ?? 5, () => {
        finalFinished.push(key);
        return result;
      });
    },
  });

  const disclosed = await discloseHostedPageTargets(
    placements,
    async (target) => {
      ordinaryStarted.push(target.threadId);
      return run('ordinary', ordinaryDelay[target.threadId]!, () => {
        ordinaryFinished.push(target.threadId);
        return target.threadId === 'thread-a'
          ? null
          : guard(target.threadId, target.threadId === 'thread-b' ? null : { anchor: pageAnchor(3) });
      });
    },
    async (placement) => {
      if (scopedStarted.length === 0) ordinaryFinishedWhenScopedStarted = ordinaryFinished.length;
      scopedStarted.push(placement.occurrenceId);
      return run('scoped', placement.occurrenceId === 'a1' ? 8 : 3, () => {
        scopedFinished += 1;
        return guard(
          `scope:${placement.occurrenceId}`,
          placement.occurrenceId === 'a2' ? null : { anchor: pageAnchor(Number(placement.occurrenceId.slice(1))) },
        );
      });
    },
  );

  expect(ordinaryStarted.filter((id) => id === 'thread-a')).toHaveLength(1);
  expect(ordinaryFinished[0]).toBe('thread-d');
  expect(ordinaryFinishedWhenScopedStarted).toBe(6);
  expect(scopedStarted).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  expect(scopedFinishedWhenFinalStarted).toBe(6);
  expect(finalFinished[0]).toBe('thread-d');
  expect(maximum).toEqual({ ordinary: 4, scoped: 4, final: 4 });
  expect([...disclosed.keys()]).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b', 'c', 'd', 'e', 'f']);
  expect(disclosed.get('a1')).toEqual(pageAnchor(1));
  expect(disclosed.get('a2')).toBeNull();
  expect(disclosed.get('b')).toBeNull();
  for (const id of ['a3', 'a4', 'a5', 'a6']) expect(disclosed.get(id)).toEqual(pageAnchor(Number(id.slice(1))));
  for (const id of ['c', 'd', 'e', 'f']) expect(disclosed.get(id)).toEqual(pageAnchor(3));
});

test('Book target dependency failure stops new work and propagates the original error', async () => {
  const failure = new Error('target metadata unavailable');
  const started: string[] = [];
  const placements = Array.from({ length: 8 }, (_, position) => {
    const id = position === 0 ? 'failure' : `target-${position}`;
    return pagePlacement(id, pageTarget(id), position);
  });
  let caught: unknown;
  try {
    await discloseHostedPageTargets(placements, async (target) => {
      started.push(target.threadId);
      if (target.threadId === 'thread-failure') throw failure;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return null;
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(failure);
  expect(started).toHaveLength(4);
});
