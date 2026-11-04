import { expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import { CollectionPrivacyEditor, CollectionPrivacyPager } from '../src/settings/collection-privacy-recovery';
import type { OwnedCollection, CollectionVisibilityWrite } from '../src/settings/preferences';
import type { CollectionPrivacyRead } from '../src/settings/collection-privacy-data';
import {
  ownerMayChangeReading,
  readingAdviceFor,
  readingMutation,
  sendReading,
} from '../src/settings/reading-preferences';
import type { PreferenceChange, PreferenceWriteResult, SettingsPage } from '../src/settings/preferences';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => {
    throw new Error('Unexpected session read');
  },
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { sessionQuery } = await import('../src/session/query');
const { SettingsSessionOwner } = await import('../src/settings/settings-session-owner');

const identity = { state: 'signed-in' as const, subject: 'alice', csrfToken: 'token' };

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
  write.resolve({
    ok: true,
    collection: { ...privateRow, visibility: 'public', revision: 5, allowedVisibilityActions: ['private', 'unlisted'] },
  });
  await Promise.all([loading, saving]);
  expect(pager.snapshot().collections).toEqual([]);
  expect(editor.snapshot().current).toBeNull();
});

test('owner advice and session lifetime are both required to write, and retirement drops private drafts', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, identity);
  const owner = new SettingsSessionOwner(client, identity.csrfToken, identity.subject);
  const release = owner.mount();
  const advice = readingAdviceFor({ spoilerLevel: 0, suitability: 'blur' });
  const denied = readingAdviceFor({ spoilerLevel: 0, suitability: 'blur' }, false);
  expect(owner.isCurrent() && ownerMayChangeReading(advice)).toBe(true);
  expect(owner.isCurrent() && ownerMayChangeReading(denied)).toBe(false);
  expect(owner.readCurrent() && !ownerMayChangeReading(denied)).toBe(true);
  owner.retire();
  expect(owner.isCurrent()).toBe(false);
  expect(owner.readCurrent()).toBe(false);
  expect(ownerMayChangeReading(advice)).toBe(true);
  release();
  client.clear();
});

test('a stale writable receipt cannot restore edit authority after the viewer retires', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, identity);
  const owner = new SettingsSessionOwner(client, identity.csrfToken, identity.subject);
  const release = owner.mount();
  let current = true;
  const input = readingMutation(
    {
      spoilerLevel: 0,
      suitability: 'blur',
      version: 0,
      advice: readingAdviceFor({ spoilerLevel: 0, suitability: 'blur' }),
    },
    { spoilerLevel: 1, suitability: 'blur' },
  )!;
  const io = {
    async save(_change: Readonly<PreferenceChange>): Promise<PreferenceWriteResult> {
      owner.retire();
      current = owner.isCurrent();
      return {
        ok: true,
        preferences: {
          spoilerLevel: 1,
          suitability: 'blur',
          version: 1,
          advice: readingAdviceFor({ spoilerLevel: 1, suitability: 'blur' }),
        },
      };
    },
    async read(): Promise<SettingsPage> {
      throw new Error('stale read');
    },
  };
  const result = await sendReading(io, input, false, () => 0);
  expect(result.kind).toBe('confirmed');
  expect(current).toBe(false);
  expect(owner.isCurrent()).toBe(false);
  expect(
    ownerMayChangeReading(result.kind === 'confirmed' ? result.preferences.advice : undefined) && owner.isCurrent(),
  ).toBe(false);
  release();
  client.clear();
});
