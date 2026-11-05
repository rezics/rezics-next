import { afterAll, beforeEach, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { searchLoaderDeps } from '../src/search/search-params';
import { discoveryRequest } from '../src/search/search-request';
import { dirname } from 'node:path';
import { act } from 'react';
import { QuerySharePreview } from '../src/search/query-share-preview';
import type { QueryShare } from '../src/search/query-share';
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/search' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const host = document.createElement('main');
document.body.append(host);
const root = createRoot(host);
afterAll(async () => {
  await act(() => root.unmount());
  window.happyDOM.abort();
});
const share: QueryShare = {
  viewer: 'anonymous',
  action: 'allowed',
  reason: 'ready',
  document: { text: '"complete text"', filter: null, languages: ['ja', 'en'], sort: null },
  parameters: 'q=%22complete+text%22&language=ja&language=en',
  selections: [],
};
const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
const click = async (text: string) => {
  await act(async () => {
    button(text).focus();
    button(text).click();
  });
};

const client = new QueryClient();
const session = { state: 'signed-in', subject: 'reader', csrfToken: null };
const mount = (prepare: (signal: AbortSignal) => Promise<QueryShare>, key = 'visit', locale = 'en', changed = true) =>
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <QuerySharePreview key={key} locale={locale} changed={changed} prepare={prepare} />
      </QueryClientProvider>,
    ),
  );
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const clipboard = (writeText: (url: string) => Promise<void>) =>
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
const elsewhere = document.createElement('button');
document.body.append(elsewhere);
beforeEach(async () => {
  await act(() => root.render(null));
  client.setQueryData(['session'], session);
});

test('complete executed preview visit keeps draft edits separate, copies and reopens, then deliberately selects refused copy', async () => {
  let copied = '';
  let preparations = 0;
  const prepare = async () => {
    preparations++;
    return share;
  };
  clipboard(async (url) => {
    copied = url;
  });
  await mount(prepare);
  await click('Share executed query');
  expect(host.textContent).toContain('Unapplied edits are excluded');
  expect(host.textContent).toContain('"complete text"');
  expect(document.activeElement?.getAttribute('role')).toBe('region');
  await mount(prepare, 'visit', 'en', false);
  expect(preparations).toBe(1);
  expect(host.textContent).toContain('Recipients use their current permissions');
  await click('Copy link');
  expect(copied).toBe('https://site.test/en/search?' + share.parameters);
  expect(host.textContent).toContain('Link copied.');
  const url = new URL(copied);
  const request = discoveryRequest(
    searchLoaderDeps({ q: url.searchParams.get('q'), language: url.searchParams.getAll('language') }),
    ['fr'],
  );
  expect(request.text).toBe(share.document!.text);
  expect(request.languages).toEqual(['ja', 'en']);
  expect(request.cursor).toBeUndefined();
  clipboard(async () => {
    throw new Error('refused');
  });
  await click('Copy link');
  expect(host.textContent).toContain('Copy was refused');
  expect(document.activeElement).toBe(button('Copy link'));
  await click('Select link');
  const fallback = host.querySelector('textarea')!;
  expect(document.activeElement).toBe(fallback);
  expect(fallback.value).toBe(copied);
  expect(fallback.selectionEnd).toBe(copied.length);
  await act(() => fallback.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('[role=region]')).toBeNull();
  expect(document.activeElement).toBe(button('Share executed query'));
});

test('synchronous duplicate commands dispatch once; retry preserves context and close aborts preparation', async () => {
  const preparation = deferred<QueryShare>();
  let calls = 0;
  let signal!: AbortSignal;
  await mount((value) => {
    signal = value;
    calls++;
    return calls === 1 ? Promise.resolve(share) : preparation.promise;
  });
  await act(async () => {
    button('Share executed query').click();
    button('Share executed query').click();
  });
  expect(calls).toBe(1);
  const writing = deferred<void>();
  let writes = 0;
  clipboard(() => {
    writes++;
    return writing.promise;
  });
  await act(() => {
    button('Copy link').click();
    button('Copy link').click();
    button('Prepare again').click();
  });
  expect(writes).toBe(1);
  expect(calls).toBe(1);
  expect(host.textContent).toContain('Copying link');
  await act(() => writing.resolve());
  await act(() => {
    button('Prepare again').click();
    button('Prepare again').click();
  });
  expect(calls).toBe(2);
  expect(host.textContent).toContain('"complete text"');
  expect(button('Copy link').disabled).toBe(true);
  await click('Close preview');
  expect(signal.aborted).toBe(true);
  await click('Share executed query');
  await act(() => preparation.resolve(share));
  expect(calls).toBe(3);
  expect(host.textContent).toContain('"complete text"');
});

for (const replacement of ['reader', 'request', 'locale', 'unmount', 'close'] as const) {
  test(`${replacement} retirement rejects late preparation and clipboard work without focus recovery`, async () => {
    const replace = async (prepare: () => Promise<QueryShare>) => {
      if (replacement === 'reader') await act(() => client.setQueryData(['session'], { ...session }));
      else if (replacement === 'close') await click('Close preview');
      else if (replacement === 'unmount') await act(() => root.render(null));
      else
        await mount(
          prepare,
          replacement === 'request' ? 'replacement' : 'visit',
          replacement === 'locale' ? 'fr' : 'en',
        );
    };
    const preparation = deferred<QueryShare>();
    let signal!: AbortSignal;
    const prepare = (value: AbortSignal) => {
      signal = value;
      return preparation.promise;
    };
    await mount(prepare);
    await click('Share executed query');
    await replace(async () => share);
    expect(signal.aborted).toBe(true);
    elsewhere.focus();
    await act(() => preparation.resolve(share));
    expect(host.querySelector('[role=region]')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    // A new visit can issue one write; neither successful nor refused late completion revives it.
    for (const refused of [false, true]) {
      await act(() => root.render(null));
      await mount(async () => share);
      await click('Share executed query');
      const writing = deferred<void>();
      let writes = 0;
      clipboard(() => {
        writes++;
        return writing.promise;
      });
      await click('Copy link');
      await replace(async () => share);
      elsewhere.focus();
      await act(() => (refused ? writing.reject(new Error('refused')) : writing.resolve()));
      expect(writes).toBe(1);
      expect(host.querySelector('[role=region]')).toBeNull();
      expect(document.activeElement).toBe(elsewhere);
    }
  });
}

test('pending refusal and queued opening or closing never take unrelated focus', async () => {
  await mount(async () => share);
  await act(() => {
    button('Share executed query').focus();
    button('Share executed query').click();
    elsewhere.focus();
  });
  expect(document.activeElement).toBe(elsewhere);
  const writing = deferred<void>();
  clipboard(() => writing.promise);
  await click('Copy link');
  elsewhere.focus();
  await act(() => writing.reject(new Error('refused')));
  expect(host.querySelector('textarea')).not.toBeNull();
  expect(document.activeElement).toBe(elsewhere);
  await act(() => button('Close preview').click());
  expect(document.activeElement).toBe(elsewhere);
});

test('native private, unsupported, oversized and unavailable advice remains distinct and retryable', async () => {
  const explanations = {
    private_context: 'private conditions',
    unsupported: 'cannot be shared in a link',
    oversized: 'too large for a link',
    unavailable: 'Sharing is unavailable',
  };
  for (const [reason, explanation] of Object.entries(explanations)) {
    await mount(
      async () => ({
        ...share,
        reason: reason as QueryShare['reason'],
        action: reason === 'unavailable' ? 'unavailable' : 'disabled',
        parameters: null,
      }),
      reason,
    );
    await click('Share executed query');
    expect(host.textContent).toContain(explanation);
    expect(host.textContent).toContain('"complete text"');
    expect(host.querySelector('textarea')).toBeNull();
    expect(button('Copy link')).toBeUndefined();
    await click('Prepare again');
    expect(host.textContent).toContain(explanation);
  }
});
