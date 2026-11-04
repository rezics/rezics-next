import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OwnedCollection } from '../src/settings/preferences';

mock.module('../src/kernel/exposure', () => ({ useOperation: () => true }));
mock.module('../src/session/query', () => ({ useSession: () => ({ state: 'signed-in', csrfToken: 'test-token' }) }));
mock.module('../src/settings/actions', () => ({
  readOwnedCollection: async () => ({ ok: false, reason: 'unavailable' }),
  readOwnedCollectionsPage: async () => ({ ok: false, reason: 'unavailable' }),
  saveCollectionVisibility: async () => ({ ok: false, reason: 'unavailable' }),
}));

const { CollectionRow } = await import('../src/settings/collection-privacy');

const privateCurated: OwnedCollection = {
  id: 'private-curated',
  title: 'Private reading',
  kind: 'curated',
  membershipKind: 'curated',
  visibility: 'private',
  revision: 7,
  allowedVisibilityActions: ['unlisted'],
};
const builtin: OwnedCollection = {
  id: 'builtin-everything',
  title: 'Everything',
  kind: 'builtin',
  membershipKind: 'dynamic',
  builtinKind: 'everything',
  builtin: { kind: 'everything' },
  visibility: 'private',
  revision: null,
  allowedVisibilityActions: [],
};
const io = { save: async () => ({ ok: false as const, reason: 'unavailable' as const }), read: async () => ({ ok: false as const, reason: 'unavailable' as const }) };

function markup(collection: OwnedCollection) {
  return renderToStaticMarkup(createElement(CollectionRow, { collection, io }));
}

test('visibility options follow native advice and logical built-ins remain read-only', () => {
  const curated = markup(privateCurated);
  expect(curated).toContain('<option value="private" selected="">');
  expect(curated).toContain('<option value="unlisted">');
  expect(curated).not.toContain('<option value="public">');

  const logical = markup(builtin);
  expect(logical).toContain('disabled=""');
  expect(logical).toContain('<option value="private" selected="">');
  expect(logical).not.toContain('<option value="unlisted">');
  expect(logical).not.toContain('<option value="public">');
});
