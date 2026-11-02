import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import type { CollectionPublicContext, CollectionPublicPage } from '../src/library/collection-public-document';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('a replacement public Collection export stays usable while retired clipboard writes settle', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.com/en/collections/public-list' });
  const writes: { text: string; work: ReturnType<typeof deferred> }[] = [];
  const writeText = mock((text: string) => {
    const work = deferred();
    writes.push({ text, work });
    return work.promise;
  });
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CollectionExport } = await import('../src/library/collection-export');
  const { collectionPublicDocument } = await import('../src/library/collection-public-document');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const pageA: CollectionPublicPage = {
    id: 'public-list',
    revision: 1,
    provenance: {
      mode: 'anonymous',
      viewerId: null,
      request: JSON.stringify(['page', 'public-list', null, false, []]),
    },
    visibility: null,
    disclosedVisibility: 'public',
    memberState: 'ready',
    publicExport: true,
    firstPage: true,
    next: null,
    members: [
      {
        id: 'occurrence-a',
        note: 'Not exported',
        addedAt: '',
        subject: { id: 'subject-a', label: 'Book A', type: 'schema:Book', types: ['schema:Book'], cover: null },
      },
    ],
  };
  const pageB: CollectionPublicPage = {
    ...pageA,
    members: pageA.members.map((member) => ({
      ...member,
      subject: { ...member.subject!, id: 'subject-b', label: 'Book B' },
    })),
  };
  let page = pageA;
  let context: CollectionPublicContext = { origin: 'https://rezics.com', locale: 'en' };
  let laterPage = false;
  let preparation: ReturnType<typeof deferred> | null = null;
  let nativeUnavailable = false;
  const preparedFile = () => {
    const file = collectionPublicDocument(page, context)!;
    return { ...file, filename: `prepared-${file.filename}`, text: `${file.text}\n` };
  };
  const request = mock(async () => {
    const file = preparedFile();
    if (preparation) await preparation.promise;
    return nativeUnavailable ? { state: 'unavailable' as const } : { state: 'complete' as const, file };
  });
  const render = async (visible = true) => {
    await act(async () => {
      root.render(
        <StrictMode>
          {visible ? <CollectionExport page={page} context={context} laterPage={laterPage} request={request} /> : null}
        </StrictMode>,
      );
    });
  };
  const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((control) => control.textContent === name)!;
  const copy = () => button(m.library_collection_export_copy());
  const download = () => button(m.library_collection_export_download());
  const status = () => host.querySelector('[role="status"]')!.textContent;
  const expectReady = (message = '') => {
    expect(copy().disabled).toBe(false);
    expect(download().disabled).toBe(false);
    expect(status()).toBe(message);
  };
  const expectPending = () => {
    expect(copy().disabled).toBe(true);
    expect(download().disabled).toBe(true);
    expect(status()).toBe('');
  };
  const copyCurrent = async () => {
    const count = writes.length;
    const expected = preparedFile().text;
    await act(async () => {
      copy().click();
      copy().click();
      download().click();
    });
    expect(writes).toHaveLength(count + 1);
    expect(writes[count]!.text).toBe(expected);
    expectPending();
    return writes[count]!.work;
  };
  const blobs: Blob[] = [];
  const filenames: string[] = [];
  const createUrl = spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return `blob:collection-export-${blobs.length}`;
  });
  const revokeUrl = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const anchorClick = spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    filenames.push(this.download);
  });
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Export must stay local'));
  const downloadCurrent = async () => {
    const count = blobs.length;
    const expected = preparedFile();
    await act(async () => download().click());
    expect(blobs).toHaveLength(count + 1);
    expect(await blobs[count]!.text()).toBe(expected.text);
    expect(blobs[count]!.type).toBe(expected.mediaType);
    expect(filenames[count]).toBe(expected.filename);
    expectReady(m.library_collection_export_downloaded());
  };

  try {
    await render();
    preparation = deferred();
    await act(async () => download().click());
    expectPending();
    const cancel = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.library_collection_cancel(),
    )!;
    await act(async () => cancel.click());
    expectReady();
    await act(async () => preparation!.resolve());
    expect(blobs).toHaveLength(0);
    preparation = null;
    const a = await copyCurrent();
    expect(blobs).toHaveLength(0);
    context = { ...context };
    await render();
    expectPending();
    await act(async () => copy().click());
    expect(writes).toHaveLength(1);

    page = pageB;
    await render();
    expectReady();
    await downloadCurrent();
    const b = await copyCurrent();
    await act(async () => a.reject(new Error('Old clipboard denied')));
    expectPending();
    await act(async () => copy().click());
    expect(writes).toHaveLength(2);
    await act(async () => b.resolve());
    expectReady(m.library_collection_export_copied());

    const oldOrigin = await copyCurrent();
    context = { ...context, origin: 'https://library.example' };
    await render();
    expectReady();
    await downloadCurrent();
    await act(async () => oldOrigin.resolve());
    expectReady(m.library_collection_export_downloaded());

    const oldLocale = await copyCurrent();
    context = { ...context, locale: 'ja' };
    await render();
    expectReady();
    const localized = await copyCurrent();
    await act(async () => oldLocale.resolve());
    expectPending();
    await act(async () => localized.reject(new Error('Current clipboard denied')));
    expectReady(m.library_collection_export_delivery_failed());

    laterPage = true;
    await render();
    expect(host.innerHTML).toBe('');
    laterPage = false;
    await render();
    expectReady();

    const unavailable = await copyCurrent();
    // Retire availability without replacing the observed page object.
    pageB.publicExport = false;
    await render();
    expect(host.innerHTML).toBe('');
    pageB.publicExport = true;
    await render();
    expectReady();
    await act(async () => unavailable.reject(new Error('Retired clipboard denied')));
    expectReady();
    await downloadCurrent();

    const unmounted = await copyCurrent();
    await render(false);
    expect(host.innerHTML).toBe('');
    await render();
    expectReady();
    const remounted = await copyCurrent();
    await act(async () => unmounted.resolve());
    expectPending();
    await act(async () => remounted.resolve());
    expectReady(m.library_collection_export_copied());
    const cancelDelivery = async () => {
      await act(async () => button(m.library_collection_cancel()).click());
      expectReady();
      expect(button(m.library_collection_cancel())).toBeUndefined();
    };
    await cancelDelivery();
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined });
    const requests = request.mock.calls.length;
    await act(async () => copy().click());
    expectReady(m.library_collection_export_delivery_failed());
    expect(request).toHaveBeenCalledTimes(requests + 1);
    await downloadCurrent();
    expect(request).toHaveBeenCalledTimes(requests + 1);
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    const retry = await copyCurrent();
    expect(request).toHaveBeenCalledTimes(requests + 1);
    await act(async () => retry.reject(new Error('Clipboard denied again')));
    expectReady(m.library_collection_export_delivery_failed());
    const successfulRetry = await copyCurrent();
    await act(async () => successfulRetry.resolve());
    expectReady(m.library_collection_export_copied());
    expect(request).toHaveBeenCalledTimes(requests + 1);

    const cancelledWrite = await copyCurrent();
    await cancelDelivery();
    await act(async () => cancelledWrite.resolve());
    expectReady();
    await downloadCurrent();
    expect(request).toHaveBeenCalledTimes(requests + 2);
    page = { ...page, provenance: { mode: 'session', viewerId: 'new-reader', request: 'new-authority' } };
    await render();
    expectReady();
    await downloadCurrent();
    expect(request).toHaveBeenCalledTimes(requests + 3);
    await cancelDelivery();
    nativeUnavailable = true;
    await act(async () => copy().click());
    expectReady(m.library_collection_export_unavailable());
    await act(async () => download().click());
    expectReady(m.library_collection_export_unavailable());
    expect(request).toHaveBeenCalledTimes(requests + 5);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    setLocale(previousLocale, { reload: false });
    createUrl.mockRestore();
    revokeUrl.mockRestore();
    anchorClick.mockRestore();
    fetch.mockRestore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
