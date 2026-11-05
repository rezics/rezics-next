import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState } from 'react';
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
const { CollectionMetadataEditor } = await import('../src/library/collection-editor');
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
function Editor({
  source,
  isCurrent,
  collectionId,
}: {
  source: Source;
  isCurrent: () => boolean;
  collectionId: string;
}) {
  const [title, setTitle] = useState('Unsaved title');
  const [description, setDescription] = useState('Unsaved description');
  return (
    <CollectionMetadataEditor
      title={title}
      description={description}
      disabled={false}
      onTitleChange={setTitle}
      onDescriptionChange={setDescription}
      onSubmit={(event) => event.preventDefault()}
    >
      <textarea aria-label="Member note" defaultValue="Unsaved member note" />
      <CollectionMetadataHistory collectionId={collectionId} isCurrent={isCurrent} source={source} />
    </CollectionMetadataEditor>
  );
}
async function mount(source: Source, isCurrent = () => true, collectionId = 'collection') {
  await act(() => root.render(<Editor collectionId={collectionId} isCurrent={isCurrent} source={source} />));
}
const settle = async (details: ReturnType<typeof receiver>['details'], title: string) =>
  act(() => {
    for (const item of [...details].reverse()) item.work.resolve(change(item.revision, title));
  });

test('deliberate comparison is idle until activation, excludes synchronous duplicates and retries its original ordered pair', async () => {
  const { source, pages, details } = receiver();
  await mount(source);
  expect(pages[0]!.input).toEqual({ collectionId: 'collection', cursor: null, limit: 25 });
  await act(() => pages[0]!.work.resolve({ state: 'available', value: page() }));
  const draft = host.querySelector<HTMLInputElement>('#collection-edit-title')!;
  expect(host.textContent).toContain(m.library_collection_metadata_history_partial({ revision: 2 }));
  expect(host.querySelector('time')!.getAttribute('datetime')).toBe(recordedAt);
  for (const revision of [null, 3, 4]) {
    if (revision) await select(revision);
    expect(host.textContent).not.toContain(m.library_collection_metadata_history_comparing());
    expect(button(m.library_collection_metadata_history_compare()).disabled).toBe(revision !== 4);
  }
  expect(host.textContent).toContain(m.library_collection_metadata_history_ready());
  await act(() => {
    button(m.library_collection_metadata_history_compare()).click();
    button(m.library_collection_metadata_history_compare()).click();
  });
  expect(details.map((item) => item.revision)).toEqual([3, 4]);
  expect(host.textContent).toContain(m.library_collection_metadata_history_comparing());
  await act(() => details[1]!.work.resolve({ state: 'unavailable' }));
  expect(button(m.library_collection_metadata_history_compare()).disabled).toBe(true);
  await act(() => details[0]!.work.reject(new Error('temporary read failure')));
  expect(host.textContent).toContain(m.library_collection_metadata_history_comparison_unavailable());
  await act(() => {
    button(m.library_collection_metadata_history_retry_comparison()).click();
    button(m.library_collection_metadata_history_retry_comparison()).click();
  });
  expect(details.map((item) => item.revision)).toEqual([3, 4, 3, 4]);
  await settle(details.slice(2), 'Original recorded title');
  expect(pages).toHaveLength(1);
  expect([...host.querySelectorAll('th[colspan]')].map((node) => node.textContent)).toEqual(
    [3, 4].map((revision) => m.library_collection_metadata_history_revision({ revision })),
  );
  expect(host.querySelector('table')!.textContent).toContain('Original recorded title');
  expect(host.textContent).toContain('First paragraph.\n\nSecond paragraph.');
  expect(host.textContent).toContain(m.library_collection_metadata_history_cover_unavailable());
  expect(host.querySelector('img')).toBeNull();
  for (const staleBasis of [
    { ...basis, collectionRevision: 10 },
    { ...basis, curatorAccountId: 'other' },
    { ...basis, viewerAccountId: 'other' },
    { ...basis, authnEpoch: 3 },
    { ...basis, minimumAuthnEpoch: '2' },
  ]) {
    const start = details.length;
    await click(m.library_collection_metadata_history_compare());
    await act(() => {
      for (const item of details.slice(start)) {
        const result = change(item.revision, 'Wrong basis private text');
        if (result.state === 'available') result.value.basis = staleBasis;
        item.work.resolve(result);
      }
    });
    expect(host.textContent).not.toContain('Wrong basis private text');
    expect(host.querySelector('table')).toBeNull();
    expect(
      [...host.querySelectorAll('button')].some(
        (node) => node.textContent === m.library_collection_metadata_history_retry_comparison(),
      ),
    ).toBe(false);
  }
  const pending = details.length;
  await click(m.library_collection_metadata_history_compare());
  await act(() => details[pending]!.work.reject(new Error('one failed, one still pending')));
  await select(4);
  await select(2);
  await click(m.library_collection_metadata_history_compare());
  expect(details).toHaveLength(pending + 2);
  await settle(details.slice(pending + 1), 'Obsolete private selection');
  expect(host.querySelector('table')).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await click(m.library_collection_metadata_history_compare());
  await settle(details.slice(pending + 2), 'Current selection');
  expect(details.slice(pending + 2).map((item) => item.revision)).toEqual([3, 2]);
  expect(host.querySelector('table')!.textContent).toContain('Current selection');
  expect(host.textContent).not.toContain('Obsolete private selection');
  const back = host.querySelector<HTMLAnchorElement>('a[href="#collection-edit-form"]')!;
  await act(() => back.click());
  expect(document.activeElement).toBe(draft);
  expect(host.querySelector('#collection-edit-title')).toBe(draft);
  expect(draft.value).toBe('Unsaved title');
  expect(host.querySelector<HTMLTextAreaElement>('#collection-edit-description')!.value).toBe('Unsaved description');
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Member note"]')!.value).toBe('Unsaved member note');
});

test('page replacement and curator, viewer, session, locale or visit retirement discard private comparison and retry', async () => {
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
  await act(() => pages[3]!.work.resolve({ state: 'available', value: page('complete') }));
  await act(() => {
    pages[2]!.work.resolve({ state: 'available', value: page() });
    for (const item of details) item.work.resolve(change(item.revision, 'Retired page comparison'));
  });
  expect(host.textContent).toContain(m.library_collection_metadata_history_complete());
  expect(host.querySelector('table')).toBeNull();
  await click(m.library_collection_metadata_history_next_page());
  await act(() =>
    pages[4]!.work.resolve({ state: 'available', value: { ...page('complete'), items: [], next: null } }),
  );
  expect(host.textContent).toContain(m.library_collection_metadata_history_empty());
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect(host.querySelector('table')).toBeNull();

  for (const boundary of ['curator', 'viewer', 'session', 'authentication epoch', 'locale', 'source', 'collection']) {
    for (const phase of ['loading', 'unavailable', 'available']) {
      const next = receiver();
      let episode = 0;
      const guard = (captured: number) => () => episode === captured;
      await mount(next.source, guard(0));
      await act(() => next.pages[0]!.work.resolve({ state: 'available', value: page() }));
      await select(4);
      await select(3);
      await click(m.library_collection_metadata_history_compare());
      if (phase !== 'loading')
        await act(() => {
          for (const item of next.details)
            item.work.resolve(
              phase === 'available' ? change(item.revision, 'Retired private text') : { state: 'unavailable' },
            );
        });
      const capturedRetry =
        phase === 'unavailable' ? button(m.library_collection_metadata_history_retry_comparison()) : null;
      if (boundary === 'locale') setLocale('fr', { reload: false });
      else if (!['source', 'collection'].includes(boundary)) episode++;
      if (boundary === 'source') await mount(receiver().source, guard(0));
      else if (boundary === 'collection') await mount(next.source, guard(0), 'other');
      else {
        // The visible old action must recheck admission before React receives a replacement page.
        await act(() => capturedRetry?.click());
        if (!capturedRetry) await mount(next.source, guard(1));
        expect(next.details).toHaveLength(2);
      }
      setLocale('en', { reload: false });
      episode = 0;
      await mount(next.source, guard(0));
      if (phase === 'loading') await settle(next.details, 'Retired private text');
      expect(host.textContent).not.toContain('Retired private text');
      expect(host.querySelector('table')).toBeNull();
      expect(
        [...host.querySelectorAll('button')].some(
          (node) => node.textContent === m.library_collection_metadata_history_retry_comparison(),
        ),
      ).toBe(false);
      await mount(next.source, () => false);
      expect(host.querySelector('#collection-metadata-history')).toBeNull();
      expect(host.querySelector('img')).toBeNull();
    }
  }
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
  await expect(
    Promise.resolve().then(() =>
      readCollectionMetadataHistoryChange({ data: { collectionId: 'collection', revision: 1 } }),
    ),
  ).rejects.toThrow('Invalid Collection metadata history revision');
});
