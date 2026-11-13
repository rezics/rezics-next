import { expect, test } from 'bun:test';
import { bookPublicationTarget, bookTocIndex, moveBookOccurrenceTo } from '../src/studio/book-toc';
import type { StudioResult } from '../src/studio/contract';
import { HostedBookAdapter } from '../src/studio/hosted-adapter';
import type { HostedBook, HostedBookNative, HostedPublish, HostedRevise } from '../src/studio/hosted-contract';

const catalogueId = '00000000-0000-8000-8000-000000000001';
const structureRevisionId = '00000000-0000-8000-8000-000000000002';
const publicationRevisionId = '00000000-0000-8000-8000-000000000003';
const partId = '00000000-0000-8000-8000-000000000011';
const firstChapterId = '00000000-0000-8000-8000-000000000012';
const secondChapterId = '00000000-0000-8000-8000-000000000013';
const firstPostId = '00000000-0000-8000-8000-000000000021';
const secondPostId = '00000000-0000-8000-8000-000000000022';
const threadId = '00000000-0000-8000-8000-000000000031';
const firstPostRevisionId = '00000000-0000-8000-8000-000000000041';
const secondPostRevisionId = '00000000-0000-8000-8000-000000000042';
const digest = 'a'.repeat(64);

const structure: HostedBook = {
  revision: { catalogueId, revisionId: structureRevisionId, kind: 'structure', sourceRevisionId: null },
  placements: [
    { occurrenceId: partId, parentId: null, position: 0, title: 'Volume One', kind: 'part' },
    {
      occurrenceId: firstChapterId,
      parentId: partId,
      position: 0,
      title: 'Opening',
      kind: 'chapter',
      target: { threadId, postId: firstPostId, revisionId: firstPostRevisionId, sha256: digest },
    },
    {
      occurrenceId: secondChapterId,
      parentId: partId,
      position: 1,
      title: 'Next',
      kind: 'chapter',
      target: { threadId, postId: secondPostId, revisionId: secondPostRevisionId, sha256: digest },
    },
  ],
};
const publication: HostedBook = {
  revision: {
    catalogueId,
    revisionId: publicationRevisionId,
    kind: 'publication',
    sourceRevisionId: structureRevisionId,
  },
  placements: [structure.placements[0]!, structure.placements[1]!],
};
const ok = <T>(value: T): StudioResult<T> => ({ ok: true, value });

test('hosted Book publication freezes only selected exact chapter occurrences and required ancestors', async () => {
  let sent: HostedPublish | null = null;
  const native: HostedBookNative = {
    listHistory: async () => ok({ catalogueId, items: [], nextCursor: null }),
    listOwn: async () =>
      ok({
        scope: { kind: 'same-home', route: 0, crossHome: 'unavailable' },
        viewer: { accountId: catalogueId, authnEpoch: 1 },
        items: [],
        nextCursor: null,
      }),
    readOwn: async () =>
      ok({
        scope: { kind: 'same-home', route: 0, crossHome: 'unavailable' },
        viewer: { accountId: catalogueId, authnEpoch: 1 },
        item: {
          catalogueId,
          threadId,
          createdAt: '2026-01-01T00:00:00.000Z',
          postRevisionId: firstPostRevisionId,
          postVisibility: 'draft',
          headRevisionId: structureRevisionId,
          publicationId: null,
        },
      }),
    read: async ({ kind }) => ok(kind === 'structure' ? structure : publication),
    create: async () => ok(structure),
    revise: async () => ok(structure),
    publish: async (_id, input) => {
      sent = input;
      return ok(publication);
    },
  };
  const adapter = new HostedBookAdapter(
    native,
    () => true,
    async () => ({
      ok: false,
      error: { kind: 'unavailable', message: 'No external target is expected.' },
    }),
  );
  const signal = new AbortController().signal;
  const loaded = await adapter.load(catalogueId, signal);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const target = bookPublicationTarget(loaded.value, new Set([firstChapterId]));
  expect(target).not.toBeNull();
  if (!target || target.kind !== 'book') return;
  expect(target.chapters).toEqual([
    {
      occurrenceId: firstChapterId,
      document: { postId: firstPostId, revisionId: firstPostRevisionId, sha256: digest },
    },
  ]);

  const result = await adapter.publish(
    { target, expectedPublicationId: null, idempotencyKey: '019a8c75-4e19-8d2f-8a36-94dd410dd880' },
    signal,
  );

  expect(result).toEqual(ok(publication));
  expect(sent).toEqual({
    expectedRevisionId: structureRevisionId,
    expectedPublicationId: null,
    occurrenceIds: [partId, firstChapterId],
  });
});

test('a distant subtree move writes one native draft revision with the same occurrences and exact Post targets', async () => {
  const destination = '00000000-0000-8000-8000-000000000014';
  const anchor = '00000000-0000-8000-8000-000000000015';
  const book: HostedBook = {
    ...structure,
    placements: [
      ...structure.placements,
      { occurrenceId: destination, parentId: null, position: 1, title: 'Volume Two', kind: 'part' },
      { ...structure.placements[1]!, occurrenceId: anchor, parentId: destination, position: 0 },
    ],
  };
  const revisions: HostedRevise[] = [];
  const unused = async () => ({ ok: false as const, error: { kind: 'unavailable' as const, message: 'Unused' } });
  const native: HostedBookNative = {
    listHistory: unused,
    listOwn: unused,
    readOwn: unused,
    create: unused,
    publish: unused,
    read: async () => ok(book),
    revise: async (_id, input) => {
      revisions.push(input);
      return ok({
        ...book,
        revision: { ...book.revision, revisionId: publicationRevisionId },
        placements: input.placements,
      });
    },
  };
  const adapter = new HostedBookAdapter(native, () => true, unused);
  const signal = new AbortController().signal;
  const loaded = await adapter.load(catalogueId, signal);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const change = moveBookOccurrenceTo(partId, destination, anchor, bookTocIndex(loaded.value))!;
  expect(change).not.toBeNull();
  const result = await adapter.change(
    {
      catalogueId,
      expectedRevision: structureRevisionId,
      change,
      idempotencyKey: '019a8c75-4e19-8d2f-8a36-94dd410dd880',
    },
    signal,
  );
  expect(result.ok).toBe(true);
  expect(revisions).toHaveLength(1);
  expect(revisions[0]!.expectedRevisionId).toBe(structureRevisionId);
  expect(revisions[0]!.placements.map((entry) => [entry.occurrenceId, entry.parentId, entry.position])).toEqual([
    [destination, null, 0],
    [partId, destination, 0],
    [firstChapterId, partId, 0],
    [secondChapterId, partId, 1],
    [anchor, destination, 1],
  ]);
  for (const chapter of structure.placements.slice(1))
    expect(revisions[0]!.placements.find((entry) => entry.occurrenceId === chapter.occurrenceId)).toEqual(chapter);
});
