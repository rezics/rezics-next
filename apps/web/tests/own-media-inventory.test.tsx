import { expect, test } from 'bun:test';
import type { OwnMediaInventoryPage } from '../src/media/own-inventory/wire';
import { advisedMediaDestinations, eraseIntentFor, indexOwnMediaPage } from '../src/media/own-inventory/inventory';

const id = '01a1a3b1-b7d4-7738-9f8b-2200fe3e8395';
const viewer = '01a1a3b1-b7d4-7736-9cd2-2200583c3cf5';

function entry(overrides: Partial<OwnMediaInventoryPage['entries'][number]> = {}): OwnMediaInventoryPage['entries'][number] {
  return {
    id,
    purpose: 'post-image',
    state: 'available',
    declaredMediaType: 'image/png',
    actualMediaType: null,
    declaredByteCount: 24,
    actualByteCount: 24,
    createdAt: '2026-10-01T00:00:00.000Z',
    claimedAt: '2026-10-01T00:01:00.000Z',
    collectionPending: false,
    takenDown: false,
    container: { id: viewer, kind: 'thread' },
    actions: {
      read: { operationId: 'media.authorize_download', variants: ['original', 'webp-320'], recheckAtUse: true },
      remove: { operationId: 'media.erase' },
      resume: null,
      retry: null,
    },
    ...overrides,
  };
}

function page(entries: OwnMediaInventoryPage['entries'], nextCursor: string | null = null): OwnMediaInventoryPage {
  return { availability: 'available', entries, nextCursor };
}

test('inventory pages keep sparse continuation distinct from terminal empty and reject repeated identities', () => {
  expect(indexOwnMediaPage(page([], 'opaque-cursor'))).toMatchObject({ entries: [], nextCursor: 'opaque-cursor' });
  expect(indexOwnMediaPage(page([], null)).nextCursor).toBeNull();
  expect(() => indexOwnMediaPage(page([entry(), entry()]))).toThrow();
});

test('download links come only from current native advice and erase intent binds the selected owner row', () => {
  const available = entry();
  expect(advisedMediaDestinations(available)).toEqual([
    { variant: 'original', href: `/media/${id}/original` },
    { variant: 'webp-320', href: `/media/${id}/webp-320` },
  ]);
  expect(advisedMediaDestinations(entry({ state: 'uploaded', actions: { ...available.actions, read: null } }))).toEqual(
    [],
  );
  expect(
    advisedMediaDestinations(
      entry({ collectionPending: true, actions: { ...available.actions, read: available.actions.read } }),
    ),
  ).toEqual([]);

  expect(eraseIntentFor(available, viewer, 'media.own/v1', 'erase-key')).toEqual({
    action: 'media.erase',
    mediaId: id,
    viewer,
    source: 'media.own/v1',
    idempotencyKey: 'erase-key',
  });
  expect(
    eraseIntentFor(
      entry({ state: 'erased', actions: { ...available.actions, remove: null } }),
      viewer,
      'media.own/v1',
      'erase-key',
    ),
  ).toBeNull();
});
