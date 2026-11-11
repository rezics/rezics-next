import { expect, test } from 'bun:test';
import { bookPublicationTarget } from '../src/studio/book-toc';
import type { StudioResult } from '../src/studio/contract';
import { HostedBookAdapter } from '../src/studio/hosted-adapter';
import type { HostedBook, HostedBookNative, HostedPublish } from '../src/studio/hosted-contract';

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

test('book publication sends only selected exact chapter occurrences and their required ancestor parts', async () => {
  let sent: HostedPublish | null = null;
  const native: HostedBookNative = {
    listOwn: async () => ok({ accountId: catalogueId, authnEpoch: 1, items: [], nextCursor: null }),
    readOwn: async () =>
      ok({
        catalogueId,
        threadId,
        createdAt: '2026-01-01T00:00:00.000Z',
        postRevisionId: firstPostRevisionId,
        postVisibility: 'draft',
        headRevisionId: structureRevisionId,
        publicationId: null,
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
