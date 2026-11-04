import { expect, test } from 'bun:test';
import { CollectionPrivacyEditor, CollectionPrivacyPager } from '../src/settings/collection-privacy-recovery';
import type { OwnedCollection, CollectionVisibilityWrite } from '../src/settings/preferences';
import type { CollectionPrivacyRead } from '../src/settings/collection-privacy-data';

const privateRow: OwnedCollection = {
  id: 'private-collection',
  title: 'Private plans',
  kind: 'curated',
  membershipKind: 'curated',
  visibility: 'private',
  revision: 4,
  allowedVisibilityActions: ['unlisted', 'public'],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

test('retirement scrubs retained Collection rows, drafts and attempts and ignores late page and command results', async () => {
  const page = deferred<CollectionPrivacyRead<{ collections: OwnedCollection[]; next: string | null }>>();
  const write = deferred<CollectionVisibilityWrite>();
  const pager = new CollectionPrivacyPager(() => page.promise);
  const editor = new CollectionPrivacyEditor(privateRow, {
    read: async () => ({ ok: true, value: privateRow }),
    save: () => write.promise,
  });
  const loading = pager.load();
  const saving = editor.edit('public');
  expect(editor.snapshot().attempt).toMatchObject({ collectionId: privateRow.id, visibility: 'public' });

  pager.dispose();
  editor.dispose();
  expect(pager.snapshot()).toMatchObject({ collections: [], next: null, loaded: false, loading: false });
  expect(editor.snapshot()).toMatchObject({ current: null, attempt: null, desired: 'private' });

  page.resolve({ ok: true, value: { collections: [privateRow], next: 'retired-cursor' } });
  write.resolve({ ok: true, collection: { ...privateRow, visibility: 'public', revision: 5, allowedVisibilityActions: ['private', 'unlisted'] } });
  await Promise.all([loading, saving]);
  expect(pager.snapshot().collections).toEqual([]);
  expect(editor.snapshot().current).toBeNull();
});
