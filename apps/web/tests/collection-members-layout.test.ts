import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { dirname } from 'node:path';
import { m } from '../src/paraglide/messages.js';
import type { EditableCollectionPage } from '../src/library/collection-load';
import { collectionPageAddress } from '../src/library/collection-presentation';
import { collectionComparisonReturnState } from '../src/library/collection-comparison/return';
import { collectionMemberReturnAddress } from '../src/subject/collection-return';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import {
  collectionPageIsFiltered,
  collectionPositionScope,
  collectionPositionScopeFromAddress,
  collectionReadingPageKey,
} from '../src/library/collection-public-reading/position';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({}) }));
mock.module('../src/library/collection-queries', () => ({
  personalCollectionPageQuery: (id: string, cursor?: string, search?: Record<string, string | string[]>) => ({
    queryKey: ['collection-page', id, cursor ?? null, search ?? null],
    queryFn: async () => {
      throw new Error('The personal collection query is disabled during server rendering');
    },
  }),
}));

const { LibraryApplicationBoundary } = await import('../src/session/library-application');
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
      initialEntries: [collectionPageAddress('en', sourcePage.id, search.cursor, search.filters, layout ?? 'list')],
    }),
  });
  await router.load();
  return renderToString(
    createElement(QueryClientProvider, {
      client: new QueryClient(),
      children: createElement(LibraryApplicationBoundary, null, createElement(RouterProvider, { router })),
    }),
  );
}

function rows(html: string) {
  return [...html.matchAll(/<li\b(?=[^>]*data-slot="list-row")[\s\S]*?<\/li>/g)].map((match) => match[0]);
}

test('collection members default to compact linked rows with a note indicator and detail opener', async () => {
  const html = await render(undefined, {
    cursor: 'next-page',
    filters: { 'f.schema:genre': ['novel', 'essay'] },
  });
  const memberRows = rows(html);

  expect(memberRows).toHaveLength(2);
  expect(memberRows[0]).toContain('href="/en/subjects/subject-little-prince/the-little-prince"');
  expect(memberRows[0]).toContain('The Little Prince');
  expect(memberRows[0]).toContain('Book');
  expect(memberRows[0]).not.toContain('A note for The Little Prince.');
  expect(memberRows[0]).toContain('data-collection-detail-opener');
  expect(memberRows[1]).toContain('href="/en/subjects/subject-kokoro/kokoro"');
  expect(memberRows[1]).toContain('Kokoro');
  expect(memberRows[1]).not.toContain('A separate note for Kokoro.');
  expect(memberRows[1]).toContain('data-collection-note-available');
  expect([...html.matchAll(/<section\b(?=[^>]*aria-label="Members")/g)]).toHaveLength(1);

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

test('grid layout keeps full details outside cover action rows and exposes the list link', async () => {
  const html = await render('grid');
  expect([...html.matchAll(/data-slot="cover-card"/g)]).toHaveLength(2);
  expect([...html.matchAll(/data-collection-detail-opener/g)]).toHaveLength(2);
  expect(html).not.toContain('data-slot="collection-member-note"');
  expect(html).not.toContain('data-slot="cover-card-actions-row"');

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
      {
        id: firstOccurrenceId,
        note: 'Curator note for the first occurrence.',
        addedAt: stamp,
        subject: repeatedSubject,
      },
      {
        id: secondOccurrenceId,
        note: 'Curator note for the second occurrence.',
        addedAt: stamp,
        subject: repeatedSubject,
      },
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
    expect(html).not.toContain('A note for an unavailable occurrence.');
    expect(html).not.toMatch(/global rank/i);

    const subjectLinks = [...html.matchAll(/href="([^"]*\/subjects\/[^\"]+)"/g)].map(
      (match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://rezics.test'),
    );
    const repeatedLinks = subjectLinks.filter((link) => link.pathname.includes(repeatedSubject.id));
    expect(repeatedLinks).toHaveLength(2);
    expect(repeatedLinks.map((link) => link.searchParams.get('via'))).toEqual([
      `${collectionPageAddress('en', exactCollectionId, search.cursor, search.filters, layout)}#collection-member-${firstOccurrenceId}`,
      `${collectionPageAddress('en', exactCollectionId, search.cursor, search.filters, layout)}#collection-member-${secondOccurrenceId}`,
    ]);
    expect(html).not.toContain('Curator note for the first occurrence.');
    expect(html).not.toContain('Curator note for the second occurrence.');
    expect(subjectLinks).toHaveLength(4);
  }
  expect(
    collectionComparisonReturnState(
      `#collection-member-${secondOccurrenceId}`,
      exactPage.members.slice(0, 1),
      true,
      true,
    ),
  ).toBe('missing');
  expect(
    collectionComparisonReturnState(`#collection-member-${secondOccurrenceId}`, exactPage.members, true, true),
  ).toBe('present');
  expect(
    collectionComparisonReturnState(`#collection-member-${secondOccurrenceId}`, exactPage.members, false, true),
  ).toBe('waiting');
  expect(collectionPositionScope({ firstPage: true }, false)).toBe('first');
  expect(collectionPositionScope({ firstPage: false }, false)).toBe('continued');
  expect(collectionPositionScope({ firstPage: true }, true)).toBe('filtered-first');
  expect(collectionPositionScope({ firstPage: false }, true)).toBe('filtered-continued');
  expect(collectionPositionScopeFromAddress('/en/collections/reading-shelf?layout=grid')).toBe('first');
  expect(collectionPositionScopeFromAddress('/en/collections/reading-shelf?f.schema%3Agenre=novel&cursor=next')).toBe(
    'filtered-continued',
  );
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

test('collection header presents the linked curator identity and readable count and update metadata', async () => {
  const html = await render();
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window();
  try {
    window.document.body.innerHTML = html;
    const owner = window.document.querySelector('[data-collection-owner]');
    expect(owner?.textContent).toContain('Ada Lovelace');
    expect(owner?.textContent).toContain('@ada');
    expect(owner?.querySelector('a')?.getAttribute('href')).toBe('/en/@ada');

    const visibleMetadata = window.document.body.textContent ?? '';
    expect(visibleMetadata).toContain(m.library_member_count({ count: 2 }));
    expect(visibleMetadata).toContain(m.library_collection_updated());
    const update = [...window.document.querySelectorAll('span')].find(
      (element) => element.textContent?.includes(m.library_collection_updated()) && element.querySelector('time'),
    );
    expect(update?.querySelector('time')?.getAttribute('datetime')).toBe(stamp);
  } finally {
    await window.happyDOM.close();
  }
});

test('comparison return admits one normalized same-locale Library directory intent', () => {
  const collection = '8bb45f1b-9a84-47b0-805a-7f60bbbd0891';
  const occurrence = 'f2cb92b9-951d-4ea0-9492-6cb86a55cb31';
  const source = `/en/collections/${collection}?returnTo=%2Fen%2Flibrary`;
  const returnAddress = collectionMemberReturnAddress(source, occurrence);
  expect(returnAddress).toBe(
    `/en/collections/${collection}?returnTo=%2Fen%2Flibrary%2Fcollections#collection-member-${occurrence}`,
  );
  expect(subjectVisitReturn(`${source}#collection-member-${occurrence}`, 'en')).toBe(returnAddress);
  const directory = `/en/library/collections?cursor=${encodeURIComponent('directory+/=')}&layout=previews`;
  const withDirectory = collectionMemberReturnAddress(
    `/en/collections/${collection}?returnTo=${encodeURIComponent(directory)}`,
    occurrence,
  );
  expect(new URL(withDirectory!, 'https://rezics.test').searchParams.get('returnTo')).toBe(directory);
  expect(
    collectionMemberReturnAddress(
      `/en/collections/${collection}?returnTo=${encodeURIComponent('https://outside.test/en/library/collections?next=/')}`,
      occurrence,
    ),
  ).toBe(`/en/collections/${collection}?returnTo=%2Fen%2Flibrary%2Fcollections#collection-member-${occurrence}`);
  expect(
    collectionMemberReturnAddress(
      `/en/collections/${collection}?returnTo=${encodeURIComponent('/en/library/collections?cursor=page&next=/outside')}`,
      occurrence,
    ),
  ).toBe(`/en/collections/${collection}?returnTo=%2Fen%2Flibrary%2Fcollections#collection-member-${occurrence}`);
  expect(collectionMemberReturnAddress(`${source}&returnTo=%2Fen%2Flibrary%2Fcollections`, occurrence)).toBeUndefined();
});
