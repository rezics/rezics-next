import { expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BookOrganizer } from '../src/studio/book-organizer';
import type { BookOrganizerPort, BookPlacement, BookStructure, StudioPort } from '../src/studio/contract';
import { StudioController } from '../src/studio/controller';

const exact = { postId: 'post', revisionId: 'pinned', sha256: 'a'.repeat(64) };
const part = (occurrenceId: string, parentOccurrenceId: string | null = null): BookPlacement => ({
  occurrenceId,
  parentOccurrenceId,
  title: occurrenceId,
  target: { kind: 'part' },
});
const chapter = (occurrenceId: string, parentOccurrenceId: string | null): BookPlacement => ({
  occurrenceId,
  parentOccurrenceId,
  title: occurrenceId,
  target: { kind: 'chapter', document: exact },
});
const book: BookStructure = {
  catalogueId: 'book',
  revision: 'saved-outline',
  canOrganize: true,
  limits: { maxDepth: 4, maxPlacements: 20 },
  placements: [
    part('part'),
    chapter('outside', null),
    part('nested', 'part'),
    chapter('deep', 'nested'),
    chapter('leaf', 'part'),
    part('empty'),
  ],
};
const unused = async (): Promise<never> => {
  throw new Error('Selection must not write or load documents.');
};
function fixture(structure = book, canPublish = true) {
  const port: StudioPort = {
    isCurrent: () => true,
    documents: unused,
    open: unused,
    createDraft: unused,
    saveDraft: unused,
    versions: unused,
    revision: unused,
    publish: unused,
    publications: unused,
    reviewPublication: async ({ target }) => ({
      ok: true,
      value: {
        reviewId: 'exact-review',
        authority: 'hosted',
        target,
        expectedPublicationRevision: 'current-release',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        notices: [],
        bookOutline: { ...book, placements: book.placements.filter((row) => row.occurrenceId !== 'empty') },
        entries: target.kind === 'book' ? target.chapters.map((row) => ({ ...row, title: row.occurrenceId })) : [],
      },
    }),
  };
  const bookPort: BookOrganizerPort = { change: unused };
  const controller = new StudioController(
    {
      visitKey: 'selection',
      projectId: 'book',
      title: 'Book',
      profile: { kind: 'book', structure },
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      currentBookPublication: {
        publicationId: 'current-release',
        revision: 'release-revision',
        state: 'published',
        publishedAt: null,
        entries: [],
      },
      canCreateDraft: true,
      canPublish,
    },
    port,
    bookPort,
  );
  const disconnect = controller.connect();
  return { controller, port, bookPort, disconnect };
}

test('part and Book selection is atomic, preserves exact preorder and retires review only on a real change', async () => {
  const f = fixture();
  const initial = f.controller.snapshot();
  f.controller.toggleOccurrence('outside', true);
  const listener = spyOn({ notify() {} }, 'notify');
  const unsubscribe = f.controller.subscribe(listener);
  f.controller.selectBookChapters('part', true);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(f.controller.snapshot().selectedOccurrences).toEqual(new Set(['outside', 'deep', 'leaf']));
  expect(f.controller.publicationTarget()).toEqual({
    kind: 'book',
    catalogueId: 'book',
    structureRevision: 'saved-outline',
    chapters: ['deep', 'leaf', 'outside'].map((occurrenceId) => ({ occurrenceId, document: exact })),
  });
  await f.controller.reviewPublication();
  expect(f.controller.snapshot().review?.reviewId).toBe('exact-review');
  const reviewed = f.controller.snapshot();
  listener.mockClear();
  f.controller.selectBookChapters(null, true);
  f.controller.selectBookChapters('missing', true);
  f.controller.selectBookChapters('empty', true);
  f.controller.toggleOccurrence('part', true);
  expect(f.controller.snapshot()).toBe(reviewed);
  expect(listener).not.toHaveBeenCalled();
  f.controller.selectBookChapters('nested', false);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(f.controller.snapshot().review).toBeNull();
  expect(f.controller.snapshot().selectedOccurrences).toEqual(new Set(['outside', 'leaf']));
  f.controller.selectBookChapters(null, false);
  expect(f.controller.publicationTarget()).toBeNull();
  await f.controller.reviewPublication();
  expect(f.controller.snapshot().review).toBeNull();
  expect(f.controller.snapshot().structure).toBe(initial.structure);
  expect(f.controller.snapshot().currentBookPublication).toBe(initial.currentBookPublication);
  unsubscribe();
  f.disconnect();
});

test('selection uses the latest admitted outline and keeps denied, pending, retired and invalid visits unchanged', async () => {
  const f = fixture();
  const next = {
    ...book,
    revision: 'next',
    placements: book.placements.filter((row) => !['nested', 'deep'].includes(row.occurrenceId)),
  };
  spyOn(f.bookPort, 'change').mockResolvedValue({ ok: true, value: next });
  expect(await f.controller.organize({ kind: 'remove', occurrenceId: 'nested' })).toBe(true);
  f.controller.selectBookChapters('nested', true);
  f.controller.selectBookChapters('part', true);
  expect(f.controller.snapshot().selectedOccurrences).toEqual(new Set(['leaf']));
  f.disconnect();
  const retired = f.controller.snapshot();
  f.controller.selectBookChapters(null, true);
  expect(f.controller.snapshot()).toBe(retired);
  const denied = fixture(book, false);
  denied.controller.selectBookChapters(null, true);
  denied.controller.toggleOccurrence('leaf', true);
  expect(denied.controller.snapshot().selectedOccurrences.size).toBe(0);
  denied.disconnect();
  const pending = fixture();
  spyOn(pending.controller, 'hasUnresolvedCommand').mockReturnValue(true);
  pending.controller.selectBookChapters(null, true);
  expect(pending.controller.snapshot().selectedOccurrences.size).toBe(0);
  pending.disconnect();
  const invalid = fixture({ ...book, placements: [...book.placements, chapter('unseen', 'missing-parent')] });
  expect(() => invalid.controller.selectBookChapters(null, true)).toThrow('missing occurrence');
  expect(() => invalid.controller.publicationTarget()).toThrow('missing occurrence');
  expect(invalid.controller.snapshot().selectedOccurrences.size).toBe(0);
  invalid.disconnect();
});

test('shared release checkboxes show empty, mixed and checked chapter counts, including disabled empty parts', () => {
  const f = fixture();
  const markup = () =>
    renderToStaticMarkup(
      createElement(BookOrganizer, {
        controller: f.controller,
        state: f.controller.snapshot(),
        onOpen: () => {},
        onOrganize: () => {},
      }),
    );
  expect(markup()).toContain('0 of 3 chapters selected');
  f.controller.toggleOccurrence('deep', true);
  expect(markup()).toContain('1 of 2 chapters selected');
  expect(markup().match(/aria-checked="mixed"/g)).toHaveLength(2);
  expect(markup()).toMatch(/<[^>]*aria-checked="false"[^>]*disabled=""/);
  f.controller.selectBookChapters(null, true);
  expect(markup()).toContain('3 of 3 chapters selected');
  expect(markup()).not.toContain('aria-checked="mixed"');
  f.disconnect();
  const empty = fixture({ ...book, placements: [] });
  empty.controller.selectBookChapters(null, true);
  expect(empty.controller.publicationTarget()).toBeNull();
  empty.disconnect();
});
