import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import type { EditableCollectionPage } from '../src/library/collection-load';

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
) {
  const route = createRootRoute({
    component: () =>
      createElement(CollectionPage, {
        page,
        cursor: search.cursor,
        ...(layout ? { layout } : {}),
        ...(search.filters ? { search: search.filters } : {}),
      }),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: [`/en/collections/${collectionId}`] }),
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
  expect(layoutNav).toContain(`/en/collections/${collectionId}?layout=grid`);
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

test('curator, member count and updated time share one metadata line', async () => {
  const html = await render();
  const metadata = /<p\b(?=[^>]*data-slot="collection-metadata")[\s\S]*?<\/p>/.exec(html)?.[0] ?? '';

  expect(metadata).toContain('Ada Lovelace');
  expect(metadata).toContain('@ada');
  expect(metadata).toContain('2 members');
  expect(metadata).toContain(`dateTime="${stamp}"`);
  expect((metadata.match(/aria-hidden="true">·<\/span>/g) ?? []).length).toBe(2);
});
