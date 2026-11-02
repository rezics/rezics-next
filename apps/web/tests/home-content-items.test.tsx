import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, useSyncExternalStore } from 'react';
import { HomeFeed } from '../src/features/pages/home-feed';
import { HomeFeedKindControl } from '../src/features/pages/home-feed-kind-control';
import { createHomeKindChoices, homeKindChoice } from '../src/features/pages/home-feed-kinds';
import { homeFeedDestination, homeFeedResume, homeFeedTitle } from '../src/features/pages/home-feed-destination';
import { continueProgress } from '../src/library/continue-source';
import { progressView } from '../src/library/progress-label';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import type { HomeFeedResult } from '../src/features/pages/home-feed-read';
import { homeFeedStoryPage, homeKindStoryPage } from '../src/kernel/fake/home-feed-stories';

test('Home composes ordered ContentItems and keeps bounded filters accessible in one compact disclosure', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.example/en' });
  window.document.documentElement.lang = 'en';
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    NodeFilter: window.NodeFilter,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const choices = createHomeKindChoices(async (cursor) => ({
    status: 'ready',
    kinds: homeKindStoryPage(cursor),
  }));
  const mixed: HomeFeedResult = { state: 'ready', page: homeFeedStoryPage('en', true, 'mixed') };

  function ComposedHome({
    result,
    stream = 'home',
    onSelect,
  }: {
    result: HomeFeedResult;
    stream?: 'home' | 'following';
    onSelect?: (stream: 'home' | 'following') => void;
  }) {
    const snapshot = useSyncExternalStore(choices.subscribe, choices.snapshot, choices.snapshot);
    const activeFilters = snapshot.selected
      ? [`${m.home_kind_label()}: ${snapshot.selected.text || m.home_kind_unnamed()}`]
      : [];
    return (
      <HomeFeed
        result={result}
        locale="en"
        signedIn
        stream={stream}
        onSelect={onSelect}
        activeFilters={activeFilters}
        kindControl={
          <HomeFeedKindControl
            choices={choices}
            snapshot={snapshot}
            locale="en"
            onSelect={(choice) => choices.select(choice)}
          />
        }
        onRetry={() => {}}
      />
    );
  }

  try {
    setLocale('en', { reload: false });
    await act(async () => root.render(<ComposedHome result={mixed} />));

    const page = mixed.state === 'ready' ? mixed.page : undefined;
    expect(page).toBeDefined();
    const rows = [...host.querySelectorAll<HTMLLIElement>('ol > li[data-feed-id]')];
    const resultsRegion = host.querySelector('section[aria-label]');
    expect(host.querySelectorAll('main')).toHaveLength(1);
    expect(resultsRegion?.getAttribute('aria-label')).toBe(m.nav_home());
    expect(resultsRegion?.querySelector('main')).toBeNull();
    expect(resultsRegion?.querySelector('ol')?.getAttribute('aria-label')).toBe(m.nav_home());
    expect(rows.map((row) => row.getAttribute('data-feed-id'))).toEqual(page!.feedItems.map((item) => item.id));
    expect(rows.length).toBeLessThanOrEqual(20);
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    for (const [index, item] of page!.feedItems.entries()) {
      const row = rows[index]!;
      expect(row.querySelectorAll('h2')).toHaveLength(1);
      expect(row.querySelector('h2')?.textContent).toBe(homeFeedTitle(item, 'en'));
      expect(row.querySelector('article')).toBeNull();
      expect(row.querySelector('a a, a button, button a')).toBeNull();
      const destination = homeFeedDestination(item, 'en');
      expect([...row.querySelectorAll('a')].filter((link) => link.getAttribute('href') === destination)).toHaveLength(
        1,
      );
      const resume = homeFeedResume(item, 'en');
      if (resume) {
        expect([...row.querySelectorAll('a')].filter((link) => link.getAttribute('href') === resume)).toHaveLength(1);
      }
    }
    const continued = page!.feedItems.find((item) => item.source === 'continue')!;
    const continuedRow = rows.find((row) => row.getAttribute('data-feed-id') === continued.id)!;
    expect(continuedRow.querySelector('[data-content-item-slot="state"]')?.textContent).toBe(
      progressView(continueProgress(continued.continue.activeProgressSession), 'en')?.text,
    );
    expect(continuedRow.querySelector('[data-content-item-slot="actions"] a')?.getAttribute('href')).toBe(
      homeFeedResume(continued, 'en'),
    );
    const subject = page!.feedItems.find((item) => 'label' in item.summary)!;
    const subjectRow = rows.find((row) => row.getAttribute('data-feed-id') === subject.id)!;
    expect(subjectRow.querySelector('[data-content-item-slot="visual"]')).not.toBeNull();
    expect(subjectRow.querySelector('img')).toBeNull();
    const thread = page!.feedItems.find((item) => 'title' in item.summary)!;
    expect(
      homeFeedDestination(
        { ...thread, destination: { kind: 'post', threadId: 'thread/id', title: null, postId: 'post/id' } },
        'ja',
      ),
    ).toBe('/ja/threads/thread%2Fid/thread?post=post%2Fid#post-post%2Fid');
    const threadRow = rows.find((row) => row.getAttribute('data-feed-id') === thread.id)!;
    expect(threadRow.querySelector('[data-content-item-slot="visual"]')).toBeNull();
    expect(host.textContent).not.toContain('2,000 references');
    expect(host.textContent).not.toContain('Ready');
    expect(host.querySelectorAll('li[data-feed-source-state]')).toHaveLength(0);

    const originalRows = [...rows];
    const sameOccurrences: HomeFeedResult = {
      state: 'ready',
      page: { ...page!, feedItems: page!.feedItems.map((item) => ({ ...item })) },
    };
    await act(async () => root.render(<ComposedHome result={sameOccurrences} />));
    expect([...host.querySelectorAll<HTMLLIElement>('ol > li[data-feed-id]')]).toEqual(originalRows);

    const filterButton = host.querySelector<HTMLButtonElement>('button[aria-controls]')!;
    const disclosure = window.document.getElementById(filterButton.getAttribute('aria-controls')!)!;
    expect(filterButton.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure.hidden).toBe(true);
    filterButton.focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(filterButton.getAttribute('aria-expanded')).toBe('true');
    expect(disclosure.hidden).toBe(false);

    const select = disclosure.querySelector<HTMLSelectElement>('select')!;
    const kind = homeKindChoice(homeKindStoryPage().values[0]!, 'en');
    const loadChoices = [...disclosure.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === m.home_kinds_load(),
    )!;
    expect(select.labels[0]?.htmlFor).toBe(select.id);
    await act(async () => user.click(loadChoices));
    expect([...select.options].map((option) => option.value)).toEqual(['', kind.id]);
    await act(async () => user.selectOptions(select, kind.id));
    expect(choices.snapshot().selected?.id).toBe(kind.id);
    const selectedFilters = [...host.querySelectorAll<HTMLUListElement>('ul')].find(
      (list) => list.getAttribute('aria-label') === m.refinement_selected(),
    )!;
    expect(selectedFilters.textContent).toContain(`${m.home_kind_label()}: ${kind.text}`);
    await act(async () => user.click(filterButton));
    expect(filterButton.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure.hidden).toBe(true);
    expect(selectedFilters.hidden).toBe(false);
    filterButton.focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(filterButton.getAttribute('aria-expanded')).toBe('true');
    expect(select.value).toBe(kind.id);

    const partial: HomeFeedResult = { state: 'ready', page: homeFeedStoryPage('en', true, 'partial') };
    await act(async () => root.render(<ComposedHome result={partial} />));
    expect(host.querySelector('[data-feed-source-state]')?.getAttribute('data-feed-source-state')).toContain(
      'following:unavailable',
    );
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.home_presentation_partial());
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === m.library_follow_retry())).toBe(
      true,
    );

    const preparing: HomeFeedResult = { state: 'ready', page: homeFeedStoryPage('en', true, 'preparing') };
    await act(async () => root.render(<ComposedHome result={preparing} />));
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.home_presentation_partial());
    expect(host.textContent).not.toContain(m.home_feed_empty());
    expect(host.querySelector('[data-feed-source-state]')?.getAttribute('data-feed-source-state')).toContain(
      'following:preparing',
    );

    const empty: HomeFeedResult = { state: 'ready', page: homeFeedStoryPage('en', true, 'empty') };
    await act(async () => root.render(<ComposedHome result={empty} />));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.home_feed_empty());
    expect(host.querySelector(`a[href="/en/search"]`)?.textContent).toBe(m.search_heading());
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === m.home_feed_discovery())).toBe(
      false,
    );

    const followingSparse: HomeFeedResult = {
      state: 'ready',
      page: {
        ...homeFeedStoryPage('en', true, 'following'),
        feedItems: [],
        next: 'opaque-following-cursor',
      },
    };
    let selectedStream: 'home' | 'following' | undefined;
    await act(async () =>
      root.render(
        <ComposedHome result={followingSparse} stream="following" onSelect={(stream) => (selectedStream = stream)} />,
      ),
    );
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.home_feed_sparse());
    expect(host.querySelector(`a[href="/en/search"]`)?.textContent).toBe(m.search_heading());
    const discovery = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === m.home_feed_discovery(),
    );
    expect(discovery).not.toBeUndefined();
    await act(async () => discovery!.click());
    expect(selectedStream).toBe('home');

    let nextCalls = 0;
    const onNext = () => {
      nextCalls++;
    };
    await act(async () => root.render(<HomeFeed result={followingSparse} locale="en" onNext={onNext} />));
    const next = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === m.library_next_page(),
    )!;
    await act(async () => {
      next.click();
      next.click();
    });
    expect(nextCalls).toBe(1);
    await act(async () => root.render(<HomeFeed result={followingSparse} locale="en" busy onNext={onNext} />));
    expect(next.disabled).toBe(true);
    expect(next.textContent).toBe(m.home_feed_loading());
    await act(async () => root.render(<HomeFeed result={empty} locale="en" onNext={onNext} />));
    expect(window.document.activeElement).toBe(host.querySelector('[data-feed-result-state]'));
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === m.library_next_page())).toBe(
      false,
    );

    // Changing selection during Next retires that navigation's focus intent.
    await act(async () =>
      root.render(<HomeFeed result={followingSparse} locale="en" input={{ stream: 'home' }} onNext={onNext} />),
    );
    const pendingNext = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === m.library_next_page(),
    )!;
    await act(async () => pendingNext.click());
    await act(async () =>
      root.render(
        <HomeFeed
          result={followingSparse}
          locale="en"
          busy
          input={{ stream: 'home', cursor: 'opaque-following-cursor' }}
          onNext={onNext}
        />,
      ),
    );
    const filters = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === m.search_filters(),
    )!;
    filters.focus();
    await act(async () =>
      root.render(
        <HomeFeed result={empty} locale="en" busy input={{ stream: 'home', kind: 'schema:Book' }} onNext={onNext} />,
      ),
    );
    await act(async () =>
      root.render(
        <HomeFeed result={empty} locale="en" input={{ stream: 'home', kind: 'schema:Book' }} onNext={onNext} />,
      ),
    );
    expect(window.document.activeElement).toBe(filters);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
