import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type {
  CollectionMetadataHistoryChange as Change,
  CollectionMetadataHistoryPage as Page,
  CollectionMetadataHistoryRead as Read,
  CollectionMetadataHistorySource as Source,
} from '../src/library/collection-metadata-history';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/collections/collection' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { CollectionMetadataHistory } = await import('../src/library/collection-metadata-history-view');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const locale = getLocale();
setLocale('en', { reload: false });
const host = document.createElement('main');
document.body.append(host);
let root = createRoot(host);
afterEach(async () => {
  await act(() => root.unmount());
  root = createRoot(host);
});
afterAll(async () => {
  await act(() => root.unmount());
  setLocale(locale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const basis = {
  collectionRevision: 9,
  curatorAccountId: 'curator',
  viewerAccountId: 'curator',
  authnEpoch: 2,
  minimumAuthnEpoch: '1',
};
const recordedAt = '2026-10-31T10:11:12.123456Z';
const page = (coverage: 'complete' | 'partial' | 'unknown' = 'partial'): Page => ({
  collectionId: 'collection',
  basis,
  coverage: { coverage, knownFromRevision: 2, prunedBeforeRevision: coverage === 'partial' ? 2 : null },
  items: [4, 3, 2].map((revision) => ({
    revision,
    recordedAt,
    changedFields: ['title', 'description', 'coverMediaId'],
  })),
  next: 'opaque+/=?%25',
  actions: { review: true, reapply: false },
});
const change = (revision: number, title: string): Read<Change> => ({
  state: 'available',
  value: {
    collectionId: 'collection',
    revision,
    recordedAt,
    basis,
    changedFields: ['title', 'description', 'coverMediaId'],
    before: {
      title: 'Original',
      description: null,
      visibility: 'private',
      presentationKind: null,
      cover: { state: 'none' },
    },
    after: {
      title,
      description: 'First paragraph.\n\nSecond paragraph.',
      visibility: 'public',
      presentationKind: 'schema:Book',
      cover: { state: 'unavailable' },
    },
    actions: { review: true, reapply: false },
  },
});
function receiver() {
  const pages: { input: Parameters<Source['readPage']>[0]; work: ReturnType<typeof deferred<Read<Page>>> }[] = [];
  const details: { revision: number; work: ReturnType<typeof deferred<Read<Change>>> }[] = [];
  const source: Source = {
    readPage: async (input) => {
      const work = deferred<Read<Page>>();
      pages.push({ input, work });
      return work.promise;
    },
    readChange: async ({ revision }) => {
      const work = deferred<Read<Change>>();
      details.push({ revision, work });
      return work.promise;
    },
  };
  return { source, pages, details };
}
const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
const click = (label: string) => act(() => button(label).click());
const select = (revision: number) =>
  act(() =>
    host
      .querySelector<HTMLInputElement>(
        `input[aria-label="${m.library_collection_metadata_history_select({ revision })}"]`,
      )!
      .click(),
  );
async function mount(source: Source, isCurrent = () => true) {
  await act(() =>
    root.render(<CollectionMetadataHistory collectionId="collection" isCurrent={isCurrent} source={source} />),
  );
}

test('two addressed revisions retain original values; old selections and same-basis comparisons cannot return', async () => {
  const { source, pages, details } = receiver();
  await mount(source);
  expect(pages[0]!.input).toEqual({ collectionId: 'collection', cursor: null, limit: 25 });
  await act(() => pages[0]!.work.resolve({ state: 'available', value: page() }));
  expect(host.textContent).toContain(m.library_collection_metadata_history_partial({ revision: 2 }));
  expect(host.querySelector('time')!.getAttribute('datetime')).toBe(recordedAt);
  await select(4);
  await select(3);
  await click(m.library_collection_metadata_history_compare());
  await select(3);
  await select(2);
  await click(m.library_collection_metadata_history_compare());
  expect(details.map((item) => item.revision)).toEqual([4, 3, 4, 2]);
  await act(() => {
    for (const item of details.slice(2)) item.work.resolve(change(item.revision, 'Current selection'));
  });
  await act(() => {
    for (const item of details.slice(0, 2)) item.work.resolve(change(item.revision, 'Obsolete private selection'));
  });
  expect(host.querySelector('table')!.textContent).toContain('Current selection');
  expect(host.textContent).not.toContain('Obsolete private selection');
  expect(host.textContent).toContain('First paragraph.\n\nSecond paragraph.');
  expect(host.textContent).toContain(m.library_collection_metadata_history_cover_unavailable());
  expect(host.querySelector('img')).toBeNull();
  await click(m.library_collection_metadata_history_compare());
  await click(m.library_collection_metadata_history_compare());
  await act(() => {
    for (const item of details.slice(6)) item.work.resolve(change(item.revision, 'Latest comparison'));
  });
  await act(() => {
    for (const item of details.slice(4, 6)) item.work.reject(new Error('retired request'));
  });
  expect(host.querySelector('table')!.textContent).toContain('Latest comparison');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test('opaque next-page recovery discards selections and ignores delayed page retries and comparisons', async () => {
  const { source, pages, details } = receiver();
  await mount(source);
  await act(() => pages[0]!.work.resolve({ state: 'available', value: page('unknown') }));
  expect(host.textContent).toContain(m.library_collection_metadata_history_unknown());
  await select(4);
  await select(3);
  await click(m.library_collection_metadata_history_compare());
  await click(m.library_collection_metadata_history_next_page());
  expect(pages[1]!.input.cursor).toBe('opaque+/=?%25');
  await act(() => pages[1]!.work.resolve({ state: 'unavailable' }));
  await click(m.library_collection_move_retry());
  expect(pages[2]!.input.cursor).toBe('opaque+/=?%25');
  await click(m.library_collection_metadata_history_first_page());
  expect(pages[3]!.input.cursor).toBeNull();
  await act(() =>
    pages[3]!.work.resolve({ state: 'available', value: { ...page('complete'), items: [], next: null } }),
  );
  await act(() => {
    pages[2]!.work.resolve({ state: 'available', value: page() });
    for (const item of details) item.work.resolve(change(item.revision, 'Retired page comparison'));
  });
  expect(host.textContent).toContain(m.library_collection_metadata_history_complete());
  expect(host.textContent).toContain(m.library_collection_metadata_history_empty());
  expect(host.querySelector('input')).toBeNull();
  expect(host.querySelector('table')).toBeNull();
});

test('a retired admission callback cannot revive results through a fresh callback or a public reader', async () => {
  const { source, pages, details } = receiver();
  let episode = 0;
  const guard = (captured: number) => () => episode === captured;
  await mount(source, guard(0));
  await act(() => pages[0]!.work.resolve({ state: 'available', value: page() }));
  await select(4);
  await select(3);
  await click(m.library_collection_metadata_history_compare());
  episode++;
  await mount(source, guard(1));
  expect(host.querySelector('input')).toBeNull();
  await act(() => {
    for (const item of details) item.work.resolve(change(item.revision, 'Retired private text'));
  });
  expect(host.textContent).not.toContain('Retired private text');
  await mount(source, () => false);
  await act(() => pages[1]!.work.resolve({ state: 'available', value: page() }));
  expect(host.textContent).toBe('');
  expect(host.querySelector('img')).toBeNull();
});

test('an unavailable supplier stays distinct from empty history and revision one is not addressed', async () => {
  const { readCollectionMetadataHistoryPage, readCollectionMetadataHistoryChange } =
    await import('../src/library/collection-commands');
  await expect(
    readCollectionMetadataHistoryPage({ data: { collectionId: 'collection', cursor: 'opaque+/=?%25', limit: 25 } }),
  ).resolves.toEqual({ state: 'unavailable' });
  await expect(
    readCollectionMetadataHistoryChange({ data: { collectionId: 'collection', revision: 2 } }),
  ).resolves.toEqual({ state: 'unavailable' });
  await expect(async () =>
    readCollectionMetadataHistoryChange({ data: { collectionId: 'collection', revision: 1 } }),
  ).rejects.toThrow('Invalid Collection metadata history revision');
});
