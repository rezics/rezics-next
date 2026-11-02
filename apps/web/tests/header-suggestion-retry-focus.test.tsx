import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import { MediaProblem } from '../src/media/kernel';
import type { RecentHistory } from '../src/search/recent-history';
import type { HeaderSuggestionLoader } from '../src/search/header-search/suggestions';
import type { SuggestionResult } from '../src/search/suggestions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, bad) => {
    resolve = ok;
    reject = bad;
  });
  return { promise, resolve, reject };
}

const page = (label?: string): SuggestionResult => ({
  as_of: '2026-11-03T00:00:00Z',
  subjects: label
    ? [
        {
          id: '01a17dfd-5dbf-738a-9405-9dfa9a8ec069',
          type: 'schema:Book',
          labels: { en: label },
          summary: null,
        },
      ]
    : [],
  types: { 'schema:Book': { en: 'Book' } },
});

const history: RecentHistory = {
  entries: [],
  persistence: 'memory',
  sync: 'local-only',
  remember() {},
  remove() {},
};

async function withSearch(
  presentation: 'responsive' | 'sheet',
  run: (api: {
    window: Window;
    host: HTMLElement;
    input: () => HTMLInputElement;
    retry: () => HTMLButtonElement | undefined;
    open: () => Promise<void>;
    fail: (error?: unknown) => Promise<void>;
    keyboardRetry: () => Promise<void>;
    settle: (value: SuggestionResult) => Promise<void>;
    calls: () => number;
    pause: () => Promise<void>;
  }) => Promise<void>,
  ownerKey?: { current: string; set?: (value: string) => void },
) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/search', width: 1280 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    MutationObserver: window.MutationObserver,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    FocusEvent: window.FocusEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: window.matchMedia.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { HeaderSearch } = await import('../src/search/header-search/header-search');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  await setLocale('en', { reload: false });
  const requests: ReturnType<typeof deferred<SuggestionResult>>[] = [];
  const load: HeaderSuggestionLoader = () => {
    const request = deferred<SuggestionResult>();
    requests.push(request);
    return request.promise;
  };
  const host = window.document.createElement('main');
  const elsewhere = window.document.createElement('button');
  elsewhere.textContent = 'Elsewhere';
  window.document.body.append(elsewhere, host);
  const root = createRoot(host as unknown as HTMLElement);
  const searchProps = {
    locale: 'en',
    initialQuery: 'Prince',
    presentation,
    history,
    loadSuggestions: load,
    onNavigate() {},
  };
  await act(async () =>
    root.render(
      ownerKey
        ? createElement(function Owner() {
            const [owner, setOwner] = useState(ownerKey.current);
            ownerKey.set = setOwner;
            return createElement(HeaderSearch, { ...searchProps, key: owner });
          })
        : createElement(HeaderSearch, searchProps),
    ),
  );
  const input = () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const retry = () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === m.search_facet_retry());
  const pause = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 230));
    });
  try {
    await run({
      window: window as unknown as Window,
      host: host as unknown as HTMLElement,
      input,
      retry,
      pause,
      calls: () => requests.length,
      open: async () => {
        if (presentation === 'sheet') {
          const trigger = host.querySelector<HTMLButtonElement>('.header-search-trigger')!;
          await act(async () => trigger.click());
        } else await act(async () => input().focus());
        await pause();
      },
      fail: async (error = new Error('unavailable')) => {
        const request = requests.at(-1)!;
        await act(async () => {
          request.reject(error);
          await request.promise.catch(() => {});
        });
      },
      keyboardRetry: async () => {
        const button = retry()!;
        await act(async () => {
          button.focus();
          button.click();
        });
      },
      settle: async (value) => {
        await pause();
        await act(async () => requests.at(-1)!.resolve(value));
      },
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    elsewhere.remove();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('keyboard suggestion Retry keeps the composer input as the entry to current options', async () => {
  for (const presentation of ['responsive', 'sheet'] as const)
    await withSearch(presentation, async ({ window, host, input, retry, open, fail, keyboardRetry, settle }) => {
      await open();
      await fail();
      expect(retry()).toBeTruthy();
      await keyboardRetry();
      expect(retry()).toBeUndefined();
      expect(window.document.activeElement).toBe(input());
      if (presentation === 'sheet')
        expect(host.querySelector('[data-header-search]')?.getAttribute('role')).toBe('dialog');
      await settle(page('Current'));
      expect(window.document.activeElement).toBe(input());
      await act(async () => {
        input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      expect(input().getAttribute('aria-activedescendant')).toBeTruthy();
    });

  await withSearch('responsive', async ({ window, input, open, fail, keyboardRetry, settle, retry }) => {
    await open();
    await fail();
    await keyboardRetry();
    await settle(page());
    expect(window.document.activeElement).toBe(input());
    expect(retry()).toBeUndefined();
  });

  await withSearch('responsive', async ({ window, input, open, fail, keyboardRetry, pause, retry }) => {
    await open();
    await fail();
    await keyboardRetry();
    expect(window.document.activeElement).toBe(input());
    await pause();
    await fail(new Error('still unavailable'));
    expect(retry()).toBeTruthy();
    expect(window.document.activeElement).toBe(input());
  });
});

test('Retry focus intent retires for moved readers, close, owner replacement and native wait', async () => {
  await withSearch('responsive', async ({ window, input, open, fail, keyboardRetry, settle }) => {
    const elsewhere = window.document.body.querySelector('button')!;
    await open();
    await fail();
    await keyboardRetry();
    await act(async () => elsewhere.focus());
    await settle(page('Late'));
    expect(window.document.activeElement).toBe(elsewhere);
  });

  await withSearch('sheet', async ({ window, host, open, fail, keyboardRetry, pause }) => {
    await open();
    await fail();
    await keyboardRetry();
    const form = host.querySelector('form')!;
    await act(async () => form.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await pause();
    expect(host.querySelector('[data-header-search]')?.getAttribute('data-expanded')).toBe('false');
    expect(window.document.activeElement).not.toBe(window.document.body);
  });

  const owner = { current: 'A', set: undefined as ((value: string) => void) | undefined };
  await withSearch(
    'responsive',
    async ({ window, open, fail, keyboardRetry }) => {
      const elsewhere = window.document.body.querySelector('button')!;
      await open();
      await fail();
      await keyboardRetry();
      await act(async () => {
        elsewhere.focus();
        owner.set!('B');
      });
      expect(window.document.activeElement).toBe(elsewhere);
    },
    owner,
  );

  await withSearch('responsive', async ({ retry, open, fail, calls, keyboardRetry }) => {
    await open();
    await fail(
      new MediaProblem(
        {
          type: 'https://rezics.com/problems/index_not_ready',
          title: 'Not ready',
          status: 503,
          code: 'index_not_ready',
        },
        { 'retry-after': '60' },
      ),
    );
    expect(retry()?.disabled).toBe(true);
    const count = calls();
    await keyboardRetry();
    expect(calls()).toBe(count);
    expect(retry()?.disabled).toBe(true);
  });
});
