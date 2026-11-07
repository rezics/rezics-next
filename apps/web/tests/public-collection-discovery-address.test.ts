import { expect, test } from 'bun:test';
import {
  continuePublicCollectionDirectory,
  parsePublicCollectionDirectoryAddress,
  publicCollectionDirectoryHref,
  selectPublicCollectionDirectory,
} from '../src/search/contracts/collection-directory';

const selection = {
  presentationKind: 'mixed',
  curator: '00000001-0000-7000-8000-000000000001',
  subject: '00000002-0000-7000-8000-000000000002',
  order: 'popular' as const,
};

test('combined selection survives native paging, URL round trip and restart', () => {
  const address = continuePublicCollectionDirectory(selection, 'opaque+/=');
  const href = publicCollectionDirectoryHref('en', address);
  const search = Object.fromEntries(new URL(href, 'https://example.test').searchParams);
  expect(parsePublicCollectionDirectoryAddress(search)).toEqual({ state: 'ready', address });
  expect(continuePublicCollectionDirectory(address)).toEqual(selection);
  expect(selectPublicCollectionDirectory({ ...address, order: 'recent' })).toEqual({ ...selection, order: 'recent' });
  expect(publicCollectionDirectoryHref('ja')).toBe('/ja/collections');
});

test('unset kind stays distinct from explicit mixed and explicit presentation type', () => {
  expect(parsePublicCollectionDirectoryAddress({ presentationKind: '' })).toEqual({ state: 'ready', address: {} });
  for (const presentationKind of ['mixed', 'creative/book']) {
    expect(parsePublicCollectionDirectoryAddress({ presentationKind })).toEqual({
      state: 'ready',
      address: { presentationKind },
    });
  }
});

test('external addresses reject mutable curator names, nonidentities, unknown orders and broken cursors', () => {
  for (const [field, value] of [
    ['curator', '@mutable-name'],
    ['curator', '00000001-0000-4000-8000-000000000001'],
    ['subject', 'some title'],
    ['order', 'rating'],
    ['cursor', ''],
    ['cursor', 'x'.repeat(4865)],
    ['curator', [selection.curator]],
    ['presentationKind', 'x'.repeat(257)],
  ] as const) {
    expect(parsePublicCollectionDirectoryAddress({ [field]: value })).toEqual({ state: 'invalid', field });
  }
  expect(parsePublicCollectionDirectoryAddress({ cursor: 'x'.repeat(4864) }).state).toBe('ready');
});
