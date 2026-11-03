import { expect, test } from 'bun:test';
import type { CollectionWriteResult } from '../src/library/collection-edit';
import {
  captureCollectionCommand,
  captureCollectionDelete,
  captureCollectionUpdate,
} from '../src/library/collection-commands';
import {
  SavedQueryManagementController,
  type ManagedSavedQuery,
} from '../src/library/saved-query-management/controller';
import { savedQueryReturnTo } from '../src/library/saved-query-management/return-to';

function ownerPage(changes: Partial<ManagedSavedQuery> = {}): ManagedSavedQuery {
  return {
    id: 'saved-query-1',
    title: 'Current title',
    description: 'Current description',
    revision: 7,
    curatorAccountId: 'alice',
    visibility: 'private',
    viewerActions: {
      state: 'ready',
      actions: [
        { action: 'collection:update', operations: ['collection.update'] },
        { action: 'collection:delete', operations: ['collection.delete'] },
      ],
    },
    ...changes,
  };
}

function makeController({
  current = ownerPage(),
  update,
  remove,
  onMetadata = () => {},
  onDeleted = () => {},
}: {
  current?: ManagedSavedQuery;
  update?: typeof captureCollectionUpdate;
  remove?: typeof captureCollectionDelete;
  onMetadata?: (page: ManagedSavedQuery) => void;
  onDeleted?: () => void;
} = {}) {
  return new SavedQueryManagementController({
    collectionId: 'saved-query-1',
    viewerId: 'alice',
    readCurrent: async () => current,
    isCurrent: () => true,
    csrf: () => 'csrf-original',
    onMetadata,
    onDeleted,
    ...(update ? { update } : {}),
    ...(remove ? { remove } : {}),
  });
}

test('owner metadata edits use the current revision and unknown retry keeps the exact sender, credential, key, and operands', async () => {
  const requests: unknown[] = [];
  let attempt = 0;
  let observed: ManagedSavedQuery | undefined;
  const controller = makeController({
    onMetadata: (page) => {
      observed = page;
    },
    update: (data, csrf) =>
      captureCollectionCommand(data, csrf, async (request) => {
        requests.push(request);
        attempt += 1;
        return attempt === 1
          ? ({ ok: false, reason: 'unavailable' } satisfies CollectionWriteResult)
          : ({ ok: true, id: 'saved-query-1', revision: 8 } satisfies CollectionWriteResult);
      }),
  });
  await controller.open();
  controller.setTitle('New title');
  controller.setDescription('New description');
  await controller.save();

  const first = controller.getSnapshot().intent;
  expect(first?.operation).toBe('collection.update');
  expect(controller.getSnapshot().outcome).toBe('unknown');
  expect(requests).toHaveLength(1);
  if (first?.operation !== 'collection.update') throw new Error('Expected a retained metadata command');
  expect(first.command.request.data).toEqual({
    collectionId: 'saved-query-1',
    revision: 7,
    title: 'New title',
    description: 'New description',
    visibility: 'private',
    idempotencyKey: expect.any(String),
  });
  expect(first.command.request.data).not.toHaveProperty('rule');
  expect(first.command.request.headers).toEqual({ 'X-CSRF-Token': 'csrf-original' });

  await controller.retryOriginal();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(first.command.request);
  expect(controller.getSnapshot().snapshot?.revision).toBe(8);
  expect(controller.getSnapshot().snapshot?.title).toBe('New title');
  expect(observed?.description).toBe('New description');
});

test('delete requires review and retries the same revisioned request before returning success', async () => {
  const requests: unknown[] = [];
  let attempt = 0;
  let deleted = 0;
  const controller = makeController({
    onDeleted: () => {
      deleted += 1;
    },
    remove: (data, csrf) =>
      captureCollectionCommand(data, csrf, async (request) => {
        requests.push(request);
        attempt += 1;
        return attempt === 1
          ? ({ ok: false, reason: 'unavailable' } satisfies CollectionWriteResult)
          : ({ ok: true, id: 'saved-query-1' } satisfies CollectionWriteResult);
      }),
  });
  await controller.open();
  controller.requestDelete();
  expect(controller.getSnapshot().dialog).toBe('delete');
  expect(requests).toHaveLength(0);

  await controller.confirmDelete();
  const intent = controller.getSnapshot().intent;
  expect(intent?.operation).toBe('collection.delete');
  expect(controller.getSnapshot().outcome).toBe('unknown');
  expect(deleted).toBe(0);
  if (intent?.operation !== 'collection.delete') throw new Error('Expected a retained delete command');
  expect(intent.command.request.data).toEqual({
    collectionId: 'saved-query-1',
    revision: 7,
    idempotencyKey: expect.any(String),
  });

  await controller.retryOriginal();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(intent.command.request);
  expect(deleted).toBe(1);
});

test('a built-in or another owner cannot enter saved-query management', async () => {
  for (const current of [
    ownerPage({ builtinKind: 'everything' }),
    ownerPage({ curatorAccountId: 'bob' }),
  ]) {
    const controller = makeController({ current });
    await controller.open();
    expect(controller.getSnapshot().phase).toBe('denied');
    expect(controller.can('collection.update')).toBe(false);
    expect(controller.can('collection.delete')).toBe(false);
  }
});

test('delete return addresses stay on the same bounded locale page', () => {
  const search = new URLSearchParams({ cursor: 'next+/page==', layout: 'previews' });
  const directory = `/en/library/collections?${search}`;
  expect(savedQueryReturnTo(directory, 'en')).toBe(directory);
  expect(savedQueryReturnTo('https://outside.test/en/library/collections', 'en')).toBe('/en/library/collections');
  expect(savedQueryReturnTo('/fr/library/collections?layout=rows', 'en')).toBe('/en/library/collections');
  expect(savedQueryReturnTo('/en/library/collections?layout=rows&extra=1', 'en')).toBe('/en/library/collections');
});
