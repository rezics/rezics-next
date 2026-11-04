import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import type { EditableCollectionPage } from '../src/library/collection-load';
import { collectionPageAddress } from '../src/library/collection-presentation';
import { collectionComparisonReturnState } from '../src/library/collection-comparison/return';
import {
  collectionPageIsFiltered,
  collectionPositionScope,
  collectionReadingPageKey,
} from '../src/library/collection-public-reading/position';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
mock.module('../src/library/collection-edit', () => {
  const unusedWrite = () => Promise.resolve({ ok: false, reason: 'conflict' });
  return {
    deleteCollection: unusedWrite,
    moveCollectionMember: unusedWrite,
    removeCollectionMember: unusedWrite,
    setCollectionFollow: unusedWrite,
    updateCollection: unusedWrite,
    updateMemberNote: unusedWrite,
  };
});
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({}) }));
mock.module('../src/library/collection-queries', () => ({
  personalCollectionPageQuery: (id: string, cursor?: string, search?: Record<string, string | string[]>) => ({
    queryKey: ['collection-page', id, cursor ?? null, search ?? null],
    queryFn: async () => {
      throw new Error('The personal collection query is disabled during server rendering');
    },
  }),
}));

const { CollectionPage } = await import('../src/library/collection-page');

const collectionId = 'reading-shelf';
const stamp = '2026-10-29T12:00:00.000Z';
const page: EditableCollectionPage = {
  id: collectionId,
  title: 'A reading shelf',
  description: null,
  memberCount: 2,
  updatedAt: stamp,
  curator: { handle: 'ada', displayName: 'Ada Lovelace' },
  visibility: null,
  members: [
    {
      id: 'little-prince',
      note: 'A note for The Little Prince.',
      addedAt: stamp,
      subject: {
        id: 'subject-little-prince',
        type: 'schema:Book',
        types: ['schema:Book'],
        label: 'The Little Prince',
        cover: null,
        typeLabel: 'Book',
      },
    },
    {
      id: 'kokoro',
      note: 'A separate note for Kokoro.',
      addedAt: stamp,
      subject: {
        id: 'subject-kokoro',
        type: 'schema:Book',
        types: ['schema:Book'],
        label: 'Kokoro',
        cover: null,
        typeLabel: 'Book',
      },
    },
  ],
  next: null,
  revision: 1,
  firstPage: true,
  following: null,
};

async function render(
  layout?: 'list' | 'grid',
  search: { cursor?: string; filters?: Record<string, string | string[]> } = {},
  sourcePage: EditableCollectionPage = page,
) {
  const route = createRootRoute({
    component: () =>
      createElement(CollectionPage, {
        page: sourcePage,
        cursor: search.cursor,
        ...(layout ? { layout } : {}),
        ...(search.filters ? { search: search.filters } : {}),
      }),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({
      initialEntries: [
        collectionPageAddress('en', sourcePage.id, search.cursor, search.filters, layout ?? 'list'),
      ],
    }),
  });
  await router.load();
  return renderToString(
    createElement(QueryClientProvider, {
      client: new QueryClient(),
      children: createElement(RouterProvider, { router }),
    }),
  );
}

function rows(html: string) {
  return [...html.matchAll(/<li\b(?=[^>]*data-slot="list-row")[\s\S]*?<\/li>/g)].map((match) => match[0]);
}

test('collection members default to linked rows with each note and kind inside its own row', async () => {
  const html = await render(undefined, {
    cursor: 'next-page',
    filters: { 'f.schema:genre': ['novel', 'essay'] },
  });
  const memberRows = rows(html);

  expect(memberRows).toHaveLength(2);
  expect(memberRows[0]).toContain('href="/en/subjects/subject-little-prince/the-little-prince"');
  expect(memberRows[0]).toContain('The Little Prince');
  expect(memberRows[0]).toContain('Book');
  expect(memberRows[0]).toContain('A note for The Little Prince.');
  expect(memberRows[1]).toContain('href="/en/subjects/subject-kokoro/kokoro"');
  expect(memberRows[1]).toContain('Kokoro');
  expect(memberRows[1]).toContain('A separate note for Kokoro.');

  const layoutNav = /<nav\b(?=[^>]*data-slot="collection-layout")[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
  expect(layoutNav).toContain('aria-current="page"');
  expect(layoutNav).toContain('layout=grid');
  expect(html).not.toContain('data-slot="cover-grid"');

  const links = [...layoutNav.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll('&amp;', '&'));
  const grid = new URL(
    links.find((href) => href.includes('layout=grid'))!,
    'https://rezics.test',
  );
  expect(grid.searchParams.get('cursor')).toBe('next-page');
  expect(grid.searchParams.getAll('f.schema:genre')).toEqual(['novel', 'essay']);
});

test('grid layout keeps each note under its own card and exposes the list link', async () => {
  const html = await render('grid');
  const cards = [...html.matchAll(/data-slot="cover-card"/g)];
  const notes = [...html.matchAll(/data-slot="collection-member-note"/g)];

  expect(cards).toHaveLength(2);
  expect(notes).toHaveLength(2);
  expect(cards[0]!.index!).toBeLessThan(notes[0]!.index!);
  expect(notes[0]!.index!).toBeLessThan(cards[1]!.index!);
  expect(cards[1]!.index!).toBeLessThan(notes[1]!.index!);
  expect(html).toContain('line-clamp-4');

  const layoutNav = /<nav\b(?=[^>]*data-slot="collection-layout")[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
  expect(layoutNav).toContain('aria-current="page"');
  expect(layoutNav).toContain(`/en/collections/${collectionId}`);
  const links = [...layoutNav.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll('&amp;', '&'));
  const list = new URL(
    links.find((href) => !new URL(href, 'https://rezics.test').searchParams.has('layout'))!,
    'https://rezics.test',
  );
  expect(list.pathname).toBe(`/en/collections/${collectionId}`);
  expect(list.searchParams.has('layout')).toBe(false);
});

test('mixed reading keeps occurrence positions and notes independent and returns to the captured layout', async () => {
  const exactCollectionId = '8bb45f1b-9a84-47b0-805a-7f60bbbd0891';
  const firstOccurrenceId = 'f2cb92b9-951d-4ea0-9492-6cb86a55cb31';
  const secondOccurrenceId = '93e72e42-4304-4f08-95da-f51cc4d45e0a';
  const thirdOccurrenceId = '0caf16a9-df2f-4eb5-8a7d-b3d81b25c039';
  const fourthOccurrenceId = '540bdd34-3caf-4d78-a137-6e473d6c256f';
  const unavailableOccurrenceId = 'ed5a9655-85f1-4b4e-98d7-24199116ab7f';
  const repeatedSubject = {
    id: 'bec68753-5b2e-4435-b057-84cb4f065716',
    type: 'schema:Book',
    types: ['schema:Book'],
    label: 'Same work',
    cover: null,
    typeLabel: 'Book',
  };
  const exactPage: EditableCollectionPage = {
    ...page,
    id: exactCollectionId,
    presentationKind: null,
    presentationKindSource: 'mixed',
    firstPage: false,
    filterActive: true,
    memberCount: 5,
    members: [
      { id: firstOccurrenceId, note: 'Curator note for the first occurrence.', addedAt: stamp, subject: repeatedSubject },
      { id: secondOccurrenceId, note: 'Curator note for the second occurrence.', addedAt: stamp, subject: repeatedSubject },
      {
        id: thirdOccurrenceId,
        note: null,
        addedAt: stamp,
        subject: {
          id: '3bb862be-7066-47c3-8aae-4a7cb842c6bf',
          type: 'schema:Movie',
          types: ['schema:Movie'],
          label: null,
          cover: null,
          typeLabel: 'Film',
        },
      },
      {
        id: fourthOccurrenceId,
        note: null,
        addedAt: stamp,
        subject: {
          id: 'ad0d4794-cafa-46e9-b196-99c897c515bd',
          type: 'schema:Thing',
          types: ['schema:Thing'],
          label: 'Unclassified work',
          cover: null,
          typeLabel: null,
        },
      },
      { id: unavailableOccurrenceId, note: 'A note for an unavailable occurrence.', addedAt: stamp, subject: null },
    ],
  };
  const search = { cursor: 'cursor-exact-page', filters: { 'f.schema:genre': ['novel'] } };
  for (const layout of ['list', 'grid'] as const) {
    const html = await render(layout, search, exactPage);
    expect(html).toContain('Filtered continued page · positions are local to this page.');
    expect(html).toContain('data-collection-presentation="ordered"');
    expect(html).toContain(`data-collection-layout="${layout}"`);
    expect(html).toContain('Mixed');
    expect(html).toContain('Book');
    expect(html).toContain('Film');
    expect(html).toContain('Type unavailable in this reading.');
    expect(html).toContain('Position 5 on this page');
    expect(html).toContain(`id="collection-member-${unavailableOccurrenceId}"`);
    expect(html).toContain('A note for an unavailable occurrence.');
    expect(html).not.toMatch(/global rank/i);

    const subjectLinks = [...html.matchAll(/href="([^"]*\/subjects\/[^\"]+)"/g)].map((match) =>
      new URL(match[1]!.replaceAll('&amp;', '&'), 'https://rezics.test'),
    );
    const repeatedLinks = subjectLinks.filter((link) => link.pathname.includes(repeatedSubject.id));
    expect(repeatedLinks).toHaveLength(2);
    expect(repeatedLinks.map((link) => link.searchParams.get('via'))).toEqual([
      `${collectionPageAddress('en', exactCollectionId, search.cursor, search.filters, layout)}#collection-member-${firstOccurrenceId}`,
      `${collectionPageAddress('en', exactCollectionId, search.cursor, search.filters, layout)}#collection-member-${secondOccurrenceId}`,
    ]);
    expect(html).toContain('Curator note for the first occurrence.');
    expect(html).toContain('Curator note for the second occurrence.');
    expect(subjectLinks).toHaveLength(4);
  }
  expect(collectionComparisonReturnState(`#collection-member-${secondOccurrenceId}`, exactPage.members.slice(0, 1), true, true)).toBe(
    'missing',
  );
  expect(collectionComparisonReturnState(`#collection-member-${secondOccurrenceId}`, exactPage.members, true, true)).toBe(
    'present',
  );
  expect(collectionComparisonReturnState(`#collection-member-${secondOccurrenceId}`, exactPage.members, false, true)).toBe(
    'waiting',
  );
  expect(collectionPositionScope({ firstPage: true }, false)).toBe('first');
  expect(collectionPositionScope({ firstPage: false }, false)).toBe('continued');
  expect(collectionPositionScope({ firstPage: true }, true)).toBe('filtered-first');
  expect(collectionPositionScope({ firstPage: false }, true)).toBe('filtered-continued');
  expect(collectionPageIsFiltered(exactPage, search.filters)).toBe(true);
  const listKey = collectionReadingPageKey(
    collectionPageAddress('en', exactCollectionId, search.cursor, search.filters, 'list'),
    collectionPageAddress('en', exactCollectionId, search.cursor, search.filters, 'list'),
    exactPage.revision,
    exactPage.members,
  );
  const gridKey = collectionReadingPageKey(
    collectionPageAddress('en', exactCollectionId, search.cursor, search.filters, 'grid'),
    collectionPageAddress('en', exactCollectionId, search.cursor, search.filters, 'list'),
    exactPage.revision,
    exactPage.members,
  );
  const laterKey = collectionReadingPageKey(
    collectionPageAddress('en', exactCollectionId, 'another-cursor', search.filters, 'grid'),
    collectionPageAddress('en', exactCollectionId, 'another-cursor', search.filters, 'list'),
    exactPage.revision,
    exactPage.members,
  );
  expect(gridKey).toBe(listKey);
  expect(laterKey).not.toBe(listKey);
});

test('curator, member count and updated time share one metadata line', async () => {
  const html = await render();
  const metadata = /<p\b(?=[^>]*data-slot="collection-metadata")[\s\S]*?<\/p>/.exec(html)?.[0] ?? '';

  expect(metadata).toContain('Ada Lovelace');
  expect(metadata).toContain('@ada');
  expect(metadata).toContain('2 members');
  expect(metadata).toContain(`dateTime="${stamp}"`);
  expect((metadata.match(/aria-hidden="true">·<\/span>/g) ?? []).length).toBe(2);
});
