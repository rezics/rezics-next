import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useCallback } from 'react';
import * as start from '../.storybook/react-start';
import type { BrowserSession } from '../src/session/browser-state';
import type { HeaderSuggestionLoader } from '../src/search/header-search/suggestions';
import type { SuggestionResult } from '../src/search/suggestions';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const viewer = (subject = 'reader', csrfToken: string | null = 'csrf'): BrowserSession => ({
  state: 'signed-in',
  subject,
  csrfToken,
});
const result = (label: string): SuggestionResult => ({
  as_of: '2026-11-03T00:00:00Z',
  subjects: [
    {
      id: '01a17dfd-5dbf-738a-9405-9dfa9a8ec069',
      type: 'schema:Book',
      labels: { en: label },
      summary: null,
    },
  ],
});

for (const transition of [
  { state: 'unknown', csrfToken: null },
  { state: 'unavailable', csrfToken: null },
  { state: 'signed-out', csrfToken: null },
  viewer('other'),
  viewer('reader', 'refreshed'),
] satisfies BrowserSession[])
  test(`header suggestions retire for ${JSON.stringify(transition)}`, async () => {
    const window = new Window({ url: 'https://site.test/en/search', width: 1280 });
    const globals = {
      window,
      document: window.document,
      navigator: window.navigator,
      HTMLElement: window.HTMLElement,
      HTMLInputElement: window.HTMLInputElement,
      Node: window.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { configurable: true, value });
    const { createRoot } = await import('react-dom/client');
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { sessionQuery, useSession } = await import('../src/session/query');
    const { currentHeaderSearchSession, observeHeaderSearchSession } =
      await import('../src/search/header-search/session-key');
    const { HeaderSearch } = await import('../src/search/header-search/header-search');
    const client = new QueryClient();
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host as unknown as HTMLElement);
    const requests: { signal: AbortSignal; resolve: (value: SuggestionResult) => void }[] = [];
    const load: HeaderSuggestionLoader = (_query, _locale, signal) =>
      new Promise((resolve) => requests.push({ signal, resolve }));
    const visits: string[] = [];
    function Owner() {
      const session = useSession();
      const readSession = useCallback(() => currentHeaderSearchSession(client), []);
      const observeSession = useCallback((retire: () => void) => observeHeaderSearchSession(client, retire), []);
      return (
        <HeaderSearch
          locale="en"
          initialQuery="Prince"
          session={session}
          readSession={readSession}
          observeSession={observeSession}
          history={{ entries: [], persistence: 'memory', sync: 'local-only', remember() {}, remove() {}, retry() {} }}
          loadSuggestions={load}
          onNavigate={(href) => visits.push(href)}
        />
      );
    }
    const pause = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 230));
      });
    const options = () => host.querySelectorAll('[role="option"]');
    const key = (value: string) =>
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true }));
    let input: HTMLInputElement;
    try {
      client.setQueryData(sessionQuery.queryKey, viewer());
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <Owner />
          </QueryClientProvider>,
        ),
      );
      input = host.querySelector('input[role="combobox"]') as unknown as HTMLInputElement;
      await act(async () => input.focus());
      await pause();
      await act(async () => requests[0]!.resolve(result('Old suggestion')));
      await act(async () => key('ArrowDown'));
      expect(input.getAttribute('aria-activedescendant')).toBeTruthy();
      if (transition.state === 'unknown') {
        await act(async () => {
          client.setQueryData(sessionQuery.queryKey, viewer('briefly-other'));
          client.setQueryData(sessionQuery.queryKey, viewer());
          key('Enter');
        });
        expect(options().length).toBe(0);
        expect(visits).toEqual([]);
        await pause();
        await act(async () => requests.at(-1)!.resolve(result('Old suggestion')));
        await act(async () => key('ArrowDown'));
      }
      const initialCount = requests.length;
      const oldLink = options()[0]!.querySelector('a')!;
      // Dispatch before React flushes the session notification, as well as checking the committed view.
      await act(async () => {
        client.setQueryData(sessionQuery.queryKey, transition);
        oldLink.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        for (const [type, extra] of [
          ['click', { ctrlKey: true }],
          ['auxclick', { button: 1 }],
        ] as const)
          expect(
            oldLink.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...extra })),
          ).toBe(false);
        key('Enter');
      });
      expect(visits).toEqual([]);
      expect(options().length).toBe(0);
      expect(input.hasAttribute('aria-activedescendant')).toBe(false);
      expect(input.value).toBe('Prince');
      expect(window.document.activeElement).toBe(input as unknown as Element);
      expect(requests[0]!.signal.aborted).toBe(true);
      if (transition.state === 'unknown' || transition.state === 'unavailable') {
        await pause();
        expect(requests.length).toBe(initialCount);
        await act(async () => {
          client.setQueryData(sessionQuery.queryKey, viewer('settled'));
        });
      }
      await pause();
      const pending = requests.at(-1)!;
      await act(async () => {
        client.setQueryData(sessionQuery.queryKey, viewer('current', null));
        pending.resolve(result('Late old response'));
      });
      expect(pending.signal.aborted).toBe(true);
      expect(options().length).toBe(0);
      await pause();
      const current = requests.at(-1)!;
      await act(async () => current.resolve(result('Current suggestion')));
      expect(options()[0]!.textContent).toContain('Current suggestion');
      const count = requests.length;
      await act(async () => {
        client.setQueryData(sessionQuery.queryKey, viewer('current', null));
      });
      expect(requests.length).toBe(count);
      expect(current.signal.aborted).toBe(false);
      const currentHref = options()[0]!.querySelector('a')!.getAttribute('href');
      await act(async () => {
        key('ArrowDown');
      });
      await act(async () => {
        key('Enter');
      });
      expect(visits).toEqual([currentHref]);
    } finally {
      await act(async () => root.unmount());
      client.clear();
      await window.happyDOM.abort();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
