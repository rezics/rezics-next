import { expect, mock, test } from 'bun:test';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('Library Settings contract keeps visibility, owner window and type frontier vocabulary', async () => {
  const {
    COLLECTION_OWNER_WINDOW_LIMIT,
    SHELF_TYPE_PREDECESSOR_LIMIT,
    collectionVisibilities,
    createShelfTypeWindowNavigation,
    dynamicCollectionTitle,
  } = await import('../src/library/settings-adapter');
  expect(collectionVisibilities).toEqual(['private', 'unlisted', 'public']);
  expect(COLLECTION_OWNER_WINDOW_LIMIT).toBe(20);
  expect(SHELF_TYPE_PREDECESSOR_LIMIT).toBe(8);
  expect(dynamicCollectionTitle({ builtinKind: 'everything', title: null }, 'en')).toBeTruthy();
  const frontier = createShelfTypeWindowNavigation();
  expect(frontier.stage('next', 'cursor-a')).toEqual({ cursor: 'cursor-a', movement: 'next' });
  frontier.settle(false);
  expect(frontier.stage('retry')).toEqual({ cursor: 'cursor-a', movement: 'next' });
  frontier.settle(true);
  expect(frontier.hasFirst).toBe(true);
});

test('Settings Library port carries failed-cursor retry, independent command/read shapes and draft recovery types', async () => {
  const { settingsLibraryPort, settingsLibraryTransport, createSettingsShelfTypeFrontier } =
    await import('../src/settings/adapters/library.ts');
  const attempt = {
    collectionId: 'collection-1',
    revision: 7,
    visibility: 'public' as const,
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
  };
  const port = settingsLibraryPort({
    save: async (input) => {
      expect(input).toEqual(attempt);
      return { ok: false, reason: 'unavailable', failure: { status: null, code: 'local_timeout' } };
    },
    read: async (id) => {
      expect(id).toBe(attempt.collectionId);
      return { ok: false, reason: 'unavailable', failure: { status: null } };
    },
    ownerWindow: async (cursor) => {
      expect(cursor).toBe('failed-cursor');
      return { ok: false, reason: 'unavailable' };
    },
  });
  expect(port.shelf.typeWindowLimit).toBe(20);
  expect(port.shelf.columnIds).toContain('title');
  expect(await port.privacy.save(attempt)).toEqual({
    ok: false,
    reason: 'unavailable',
    failure: { status: null, code: 'local_timeout' },
  });
  expect(await port.privacy.read(attempt.collectionId)).toEqual({
    ok: false,
    reason: 'unavailable',
    failure: { status: null },
  });
  expect(await port.privacy.ownerWindow('failed-cursor')).toEqual({ ok: false, reason: 'unavailable' });
  const transport = settingsLibraryTransport();
  expect(transport.createTypeFrontier().stage('first')).toEqual({ cursor: undefined, movement: 'first' });
  expect(createSettingsShelfTypeFrontier().hasPrevious).toBe(false);
});
