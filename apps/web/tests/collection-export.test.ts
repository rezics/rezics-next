import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CollectionExport, copyCollectionItemList, downloadCollectionItemList } from '../src/library/collection-export';
import { collectionPublicDocument, type CollectionPublicPage } from '../src/library/collection-public-document';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';

const context = { origin: 'https://rezics.com', locale: 'en' } as const;
const page: CollectionPublicPage = {
  id: 'public-list',
  revision: 1,
  provenance: { mode: 'anonymous', viewerId: null, request: JSON.stringify(['page', 'public-list', null, false, []]) },
  visibility: null,
  disclosedVisibility: 'public',
  memberState: 'ready',
  publicExport: true,
  firstPage: true,
  next: null,
  members: [
    {
      id: 'occurrence',
      note: 'Not in the export',
      addedAt: '',
      subject: { id: 'subject', label: 'Public book', type: 'schema:Book', types: ['schema:Book'], cover: null },
    },
  ],
};
const restore: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of restore.splice(0).reverse()) cleanup();
  mock.restore();
});

function replaceGlobal(key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  restore.push(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  });
}

test('download creates only a local JSON-LD Blob with a bounded filename and releases its URL', async () => {
  const anchor = { href: '', download: '', click: mock(() => {}), remove: mock(() => {}) };
  const appendChild = mock(() => {});
  replaceGlobal('document', { createElement: () => anchor, body: { appendChild } });
  let blob: Blob | undefined;
  const create = spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    blob = value as Blob;
    return 'blob:local-itemlist';
  });
  const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  let release: (() => void) | undefined;
  replaceGlobal('setTimeout', (callback: () => void, delay: number) => {
    expect(delay).toBe(1000);
    release = callback;
  });
  const fetch = spyOn(globalThis, 'fetch');
  expect(downloadCollectionItemList(page, context)).toBe(true);
  expect(create).toHaveBeenCalledTimes(1);
  expect(blob?.type).toBe('application/ld+json');
  expect(await blob?.text()).toBe(collectionPublicDocument(page, context)!.text);
  expect(anchor.href).toBe('blob:local-itemlist');
  expect(anchor.download).toBe('collection-public-list.jsonld');
  expect(appendChild).toHaveBeenCalledWith(anchor);
  expect(anchor.click).toHaveBeenCalledTimes(1);
  expect(anchor.remove).toHaveBeenCalledTimes(1);
  expect(revoke).not.toHaveBeenCalled();
  release!();
  expect(revoke).toHaveBeenCalledWith('blob:local-itemlist');
  expect(fetch).not.toHaveBeenCalled();
});

test('copy uses the same current document without fetching, and browser refusal remains a failure', async () => {
  const writeText = mock(async (_text: string) => {});
  replaceGlobal('navigator', { clipboard: { writeText } });
  const fetch = spyOn(globalThis, 'fetch');
  expect(await copyCollectionItemList(page, context)).toBe(true);
  expect(writeText).toHaveBeenLastCalledWith(collectionPublicDocument(page, context)!.text);
  const updated = { ...page, members: [] };
  expect(await copyCollectionItemList(updated, context)).toBe(true);
  expect(writeText).toHaveBeenLastCalledWith(collectionPublicDocument(updated, context)!.text);
  writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
  await expect(copyCollectionItemList(page, context)).rejects.toThrow('Clipboard denied');
  expect(fetch).not.toHaveBeenCalled();
});

test('unavailable and later payloads never touch browser download or clipboard APIs', async () => {
  replaceGlobal('document', undefined);
  replaceGlobal('navigator', undefined);
  for (const unavailable of [
    { ...page, visibility: 'private' as const },
    { ...page, visibility: 'public' as const },
    { ...page, disclosedVisibility: 'unlisted' as const },
    { ...page, memberState: 'preparing' as const },
    { ...page, publicExport: false },
    { ...page, next: 'more' },
    { ...page, filterActive: true },
    { ...page, cursor: 'later' },
  ]) {
    expect(downloadCollectionItemList(unavailable, context)).toBe(false);
    expect(await copyCollectionItemList(unavailable, context)).toBe(false);
  }
  expect(downloadCollectionItemList(page, context, true)).toBe(false);
  expect(await copyCollectionItemList(page, context, true)).toBe(false);
});

test('the shared action exposes localized names, descriptions, visibility and a live status in all eight locales', async () => {
  const previous = getLocale();
  try {
    expect(locales).toHaveLength(8);
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const messages = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
      const available = renderToStaticMarkup(
        createElement(CollectionExport, { page, context: { ...context, locale } }),
      );
      expect(available).toContain(messages.library_collection_export_download);
      expect(available).toContain(messages.library_collection_export_copy);
      expect(available).toContain(messages.library_collection_export_note);
      expect(available).toContain('aria-describedby=');
      expect(available).toContain('role="status"');
      expect(available).not.toMatch(/<button[^>]*\sdisabled/);
      const unavailable = renderToStaticMarkup(
        createElement(CollectionExport, { page: { ...page, publicExport: false }, context: { ...context, locale } }),
      );
      expect(unavailable).toBe('');
      expect(unavailable).not.toContain('application/ld+json');
      expect(unavailable).not.toContain('Not in the export');
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('Unavailable private unlisted dynamic partial filtered or unknown Collection views do not permanently display unusable export controls', () => {
  const views: CollectionPublicPage[] = [
    { ...page, memberState: 'unavailable' },
    { ...page, memberState: 'preparing' },
    { ...page, visibility: 'private' },
    { ...page, visibility: 'public' },
    { ...page, disclosedVisibility: 'unlisted' },
    { ...page, preparing: false },
    { ...page, publicExport: false },
    { ...page, next: 'more' },
    { ...page, firstPage: false },
    { ...page, cursor: 'later' },
    { ...page, filterActive: true },
    { ...page, filter: { and: [] } },
    { ...page, filterIgnored: ['ignored'] },
    { ...page, filterStatus: 'failed' },
    { ...page, memberState: undefined },
    { ...page, visibility: undefined },
    { ...page, disclosedVisibility: undefined },
    { ...page, publicExport: undefined },
    { ...page, firstPage: undefined },
    { ...page, next: undefined },
  ];
  for (const view of views) {
    expect(renderToStaticMarkup(createElement(CollectionExport, { page: view, context }))).toBe('');
  }
  expect(renderToStaticMarkup(createElement(CollectionExport, { page, context, laterPage: true }))).toBe('');
});
