import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('../src/kernel/exposure', () => ({ useOperation: () => true }));
mock.module('../src/kernel/query', () => ({ personalRead: { enabled: true } }));
mock.module('../src/session/query', () => ({ useSession: () => ({ state: 'signed-in', csrfToken: 'test-token' }) }));
mock.module('../src/settings/actions', () => ({
  readOwnedCollection: async () => ({ id: 'collection-1', title: 'Reading list', visibility: 'private', revision: 7 }),
  readOwnedCollectionsPage: async () => ({ collections: [], next: null }),
  saveCollectionVisibility: async () => ({ ok: true }),
}));
mock.module('../src/library/labels-actions', () => ({ manageLabel: async () => ({ ok: true }) }));
mock.module('../src/library/labels-read-route', () => ({ readLabelsPage: async () => ({}) }));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'X-CSRF-Token': 'test-token' }) }));

const { CollectionRow } = await import('../src/settings/collection-privacy');
type OwnedCollection = import('../src/settings/preferences').OwnedCollection;
const { LabelsPageView } = await import('../src/library/labels-page');
type LabelsPage = import('../src/library/labels-read').LabelsPage;

test('a collection row keeps its navigation target while the visibility control stays independent', () => {
  const collection: OwnedCollection = {
    id: 'collection-1',
    title: 'Reading list',
    visibility: 'private',
    revision: 7,
  };
  const html = renderToStaticMarkup(createElement(CollectionRow, { collection }));
  const row = html.match(/<li\b[^>]*data-slot="list-row"[^>]*>[\s\S]*?<\/li>/)?.[0];
  const control = row?.match(/<div[^>]*data-slot="list-row-control"[^>]*>[\s\S]*?<\/div>/)?.[0];

  expect(row).toContain('href="/en/collections/collection-1"');
  expect(row).toContain('data-slot="list-row-link"');
  expect(row).toContain('sr-only">Reading list</span>');
  expect(row).toContain('data-slot="list-row-control"');
  expect(control).toContain('<select');
  expect(control).not.toContain('disabled');
  expect(control).toContain('relative z-10');
});

test('a label row keeps its shelf destination and independent rename and delete forms', () => {
  const page: LabelsPage = {
    signedIn: true,
    operations: ['library_label.list', 'library_label.create', 'library_label.rename', 'library_label.delete'],
    csrfToken: 'test-token',
    createKey: 'create-key',
    undoKey: 'undo-key',
    labels: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Travel',
        revision: 2,
        renameKey: 'rename-key',
        deleteKey: 'delete-key',
      },
    ],
    next: null,
  };
  const html = renderToStaticMarkup(createElement(LabelsPageView, { page }));
  const row = html.match(/<li\b[^>]*data-slot="list-row"[^>]*>[\s\S]*?<\/li>/)?.[0];

  expect(row).toContain('data-library-label-link');
  expect(row).toContain('href="/en/library?label=00000000-0000-4000-8000-000000000001"');
  expect(row).toContain('sr-only">Travel</span>');
  expect(row?.match(/data-slot="list-row-control"/g)).toHaveLength(2);
  expect(row?.match(/<form\b/g)).toHaveLength(2);
  expect(row).toContain('relative z-10');
});
