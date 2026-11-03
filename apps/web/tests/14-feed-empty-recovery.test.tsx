import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyState } from '@rezics/ui/empty-state';
import { FeedResults, type FeedResultsResult, type FeedResultsSourceState } from '../src/features/feed/feed-results';
import { homeFeedRecoveryMessages } from '../src/features/feed/feed-empty-state';
import { HomeFeed } from '../src/features/pages/home-feed';
import { homeFeedStoryPage } from '../src/kernel/fake/home-feed-stories';
import { m } from '../src/paraglide/messages.js';
import { locales } from '../src/paraglide/runtime.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
type Row = { id: number; title: string };
const messages = homeFeedRecoveryMessages('en', 'discovery');
const ready = (count = 0, hasNext = false): FeedResultsResult<Row> => ({
  state: 'ready',
  items: Array.from({ length: count }, (_, id) => ({ id, title: `Prepared row ${id}` })),
  hasNext,
  availability: { state: 'complete' },
});
function Results({
  result,
  busy = false,
  retry = () => {},
  restart = () => {},
  next = () => {},
  suppress = false,
}: {
  result: FeedResultsResult<Row>;
  busy?: boolean;
  retry?: () => void;
  restart?: () => void;
  next?: () => void;
  suppress?: boolean;
}) {
  return (
    <FeedResults
      regionLabel="Prepared results"
      itemHeadingLevel={3}
      emptyHeadingLevel={3}
      listAs="ol"
      result={result}
      messages={messages}
      busy={busy}
      suppressResultMessage={suppress}
      getItemKey={(row) => row.id}
      itemPresentation={(row) => ({ title: row.title, actions: <button>Row action {row.id}</button> })}
      onRetry={retry}
      onRestart={restart}
      nextControl={<button onClick={next}>Next prepared page</button>}
      emptyActions={<a href="/en/search">Search prepared results</a>}
    />
  );
}
function documentFor(element: React.ReactNode) {
  const browser = new Window();
  browser.document.body.innerHTML = renderToStaticMarkup(element);
  return browser;
}

test('semantic frame keeps live explanation separate from decorative icon and recovery controls', () => {
  const browser = documentFor(
    <EmptyState
      title="Explained state"
      description="Prepared explanation"
      icon={<svg />}
      headingLevel={3}
      role="status"
      actions={<button>Recover</button>}
    />,
  );
  const document = browser.document;
  expect(document.querySelector('h3')?.textContent).toBe('Explained state');
  expect(document.querySelector('[role=status]')?.textContent).toBe('Explained statePrepared explanation');
  expect(document.querySelector('[role=status] button, [role=status] svg')).toBeNull();
  expect(document.querySelector('svg')?.closest('[aria-hidden=true]')).not.toBeNull();
  browser.happyDOM.abort();
  const quiet = documentFor(<EmptyState title="Ordinary list" />);
  expect(quiet.document.querySelector('[role=alert], [role=status]')).toBeNull();
  quiet.happyDOM.abort();
});

test('0/10/20 supplied rows across complete, partial, unavailable and sparse pages add no reads for all fixed source combinations', () => {
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (() => {
    reads++;
    throw new Error('Unexpected recovery read');
  }) as typeof fetch;
  const states: FeedResultsSourceState[] = ['ready', 'preparing', 'unavailable', 'not_requested'];
  try {
    for (const discovery of states)
      for (const following of states)
        for (const continuation of states) {
          for (const count of [0, 10, 20])
            for (const hasNext of [false, true]) {
              for (const availability of ['complete', 'partial', 'unavailable'] as const) {
                const result = ready(count, hasNext);
                if (result.state !== 'ready') throw new Error('Prepared result must be ready');
                result.availability = {
                  state: availability,
                  sources: { discovery, following, continue: continuation },
                };
                const html = renderToStaticMarkup(<Results result={result} />);
                const partial =
                  availability !== 'complete' ||
                  [discovery, following, continuation].some(
                    (state) => state === 'preparing' || state === 'unavailable',
                  );
                expect((html.match(/data-content-item-slot="title"/g) ?? []).length).toBe(count);
                if (count) {
                  expect(html).not.toContain('data-feed-empty-state=');
                  expect(html).toContain('Row action 0');
                } else {
                  expect(html).toContain(
                    `data-feed-empty-state="${partial ? (availability === 'unavailable' ? 'unavailable' : 'partial') : hasNext ? 'sparse' : 'empty'}"`,
                  );
                  expect(html).toContain('Search prepared results');
                }
                if (partial) expect(html).not.toContain('Your next discovery starts here');
              }
            }
        }
    expect(reads).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Home explains complete discovery, Following, filtered and end states in all locales with admitted destinations', () => {
  for (const locale of locales)
    for (const context of ['discovery', 'following', 'filtered', 'continuation'] as const) {
      const options = { locale };
      const page = { ...homeFeedStoryPage(locale, true, 'empty'), feedItems: [], next: null };
      const browser = documentFor(
        <HomeFeed
          result={{ state: 'ready', page }}
          locale={locale}
          signedIn
          stream={context === 'following' ? 'following' : 'home'}
          onSelect={() => {}}
          onRestart={() => {}}
          input={{
            stream: 'home',
            ...(context === 'filtered' ? { kind: 'prepared-kind' } : {}),
            ...(context === 'continuation' ? { cursor: 'prepared-cursor' } : {}),
          }}
        />,
      );
      const document = browser.document;
      const frame = document.querySelector(`[data-feed-empty-context="${context}"]`);
      expect(frame).not.toBeNull();
      expect(frame?.querySelector('h2')?.textContent).toBe(
        homeFeedRecoveryMessages(locale, context).explanations?.empty?.title as string,
      );
      expect(frame?.querySelector(`a[href="/${locale}/search"]`)).not.toBeNull();
      expect(frame?.querySelector('[role=alert]')).toBeNull();
      expect(frame?.textContent).toContain(
        context === 'continuation'
          ? m.home_feed_restart({}, options)
          : context === 'following'
            ? m.home_feed_discovery({}, options)
            : m.search_heading({}, options),
      );
      browser.happyDOM.abort();
    }
  for (const locale of locales)
    for (const state of [
      'loading',
      'auth',
      'closed',
      'denied',
      'cursor',
      'deadline',
      'request',
      'unavailable',
    ] as const) {
      const browser = documentFor(
        <HomeFeed
          result={{ state, code: 'private-predicate-must-stay-hidden' }}
          locale={locale}
          onRetry={() => {}}
          onRestart={() => {}}
        />,
      );
      const document = browser.document;
      const frame = document.querySelector(`[data-feed-empty-state="${state}"]`)!;
      const copy = homeFeedRecoveryMessages(locale, 'discovery').explanations![state]!;
      expect(frame.querySelector('h2')?.textContent).toBe(copy.title as string);
      expect(frame.textContent).toContain(copy.description as string);
      expect(frame.textContent).not.toContain('private-predicate');
      if (state === 'auth')
        expect(frame.querySelector('a')?.getAttribute('href')).toBe(
          `/${locale}/auth/sign-in?return_to=${encodeURIComponent(`/${locale}/`)}`,
        );
      if (state === 'closed' || state === 'denied' || state === 'loading')
        expect(frame.querySelector('button, a')).toBeNull();
      browser.happyDOM.abort();
    }
  for (const locale of locales)
    for (const state of ['sparse', 'partial'] as const) {
      const page = {
        ...homeFeedStoryPage(locale, true, 'empty'),
        feedItems: [],
        next: state === 'sparse' ? 'prepared-next' : null,
      };
      if (state === 'partial') page.sources.discovery = 'unavailable';
      const browser = documentFor(
        <HomeFeed result={{ state: 'ready', page }} locale={locale} onRetry={() => {}} onNext={() => {}} />,
      );
      const frame = browser.document.querySelector(`[data-feed-empty-state="${state}"]`)!;
      const copy = homeFeedRecoveryMessages(locale, 'discovery').explanations![state]!;
      expect(frame.querySelector('h2')?.textContent).toBe(copy.title as string);
      expect(frame.textContent).toContain(copy.description as string);
      browser.happyDOM.abort();
    }
});

async function surface() {
  const browser = new Window({ url: 'https://rezics.example/en/' });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    Element: browser.Element,
    Node: browser.Node,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    DocumentFragment: browser.DocumentFragment,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const { createRoot } = await import('react-dom/client');
  const host = browser.document.createElement('div');
  browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  return {
    host,
    root,
    browser,
    async close() {
      await act(async () => root.unmount());
      await browser.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('partial refresh keeps rows, caller actions and focus; each explicit retry/next/restart calls its original owner once', async () => {
  const view = await surface();
  let retries = 0,
    next = 0,
    restarts = 0;
  const callbacks = {
    retry: () => {
      retries++;
    },
    next: () => {
      next++;
    },
    restart: () => {
      restarts++;
    },
  };
  const partial = ready(10, true);
  if (partial.state !== 'ready') throw new Error('Expected prepared ready');
  partial.availability = { state: 'partial', sources: { discovery: 'ready', following: 'unavailable' } };
  try {
    await act(async () => view.root.render(<Results result={partial} {...callbacks} />));
    const rowAction = view.host.querySelector<HTMLButtonElement>('li button')!;
    rowAction.focus();
    await act(async () => view.root.render(<Results result={partial} busy {...callbacks} />));
    expect(view.browser.document.activeElement).toBe(rowAction);
    expect(view.host.querySelector('li button')).toBe(rowAction);
    expect(view.host.querySelectorAll('[role=status]')).toHaveLength(1);
    expect(view.host.querySelector('[role=status]')?.textContent).toBe(messages.partial as string);
    expect(view.host.querySelector('[data-slot=empty-state]')).toBeNull();
    expect(retries + next + restarts).toBe(0);
    await act(async () => view.root.render(<Results result={{ ...partial, items: [] }} {...callbacks} />));
    expect(view.host.querySelector('a[href="/en/search"]')).not.toBeNull();
    const button = (text: string) =>
      [...view.host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!;
    await act(async () => button(messages.retry as string).click());
    await act(async () => button('Next prepared page').click());
    expect([retries, next, restarts]).toEqual([1, 1, 0]);
    await act(async () => view.root.render(<Results result={{ state: 'cursor' }} {...callbacks} />));
    await act(async () => button(messages.restart as string).click());
    expect([retries, next, restarts]).toEqual([1, 1, 1]);
    await act(async () => view.root.render(<Results result={ready()} busy {...callbacks} />));
    expect(view.host.querySelector('[data-feed-empty-state=loading]')).not.toBeNull();
    expect(view.host.textContent).not.toContain('Your next discovery starts here');
    await act(async () => view.root.render(<Results result={{ state: 'denied' }} suppress {...callbacks} />));
    expect(view.host.querySelector('[data-slot=empty-state]')).toBeNull();
  } finally {
    await view.close();
  }
});

test('filtered Home recovery opens the existing controls and focuses only on explicit recovery', async () => {
  const view = await surface();
  const page = { ...homeFeedStoryPage('en', true, 'empty'), feedItems: [], next: null };
  try {
    await act(async () =>
      view.root.render(
        <HomeFeed
          result={{ state: 'ready', page }}
          locale="en"
          input={{ stream: 'home', kind: 'prepared-kind' }}
          kindControl={<button>Existing kind control</button>}
        />,
      ),
    );
    const recovery = view.host.querySelector<HTMLButtonElement>('[data-feed-slot=empty-actions] button')!;
    recovery.focus();
    await act(async () => recovery.click());
    expect(view.browser.document.activeElement?.textContent).toBe('Existing kind control');
    expect(view.host.querySelector('[hidden]')).toBeNull();
  } finally {
    await view.close();
  }
});
