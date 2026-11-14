import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { browserObservation, ReaderNavigationContext } from '../src/reader/lifetime';
import { viewerExposureQuery } from '../src/kernel/viewer-exposure';
import { ReadingInsightsView } from '../src/library/reading-insights/page';
import { useInsightsReading, type InsightsReader } from '../src/library/reading-insights/current';
import { readingInsightsExample } from '../src/library/reading-insights/story-values';
import { libraryNavigationEntries, libraryNavigationMenuEntries } from '../src/library/library-nav';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, overwriteGetLocale } from '../src/paraglide/runtime.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/insights?year=2026' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

function markup(value = readingInsightsExample()) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <ReadingInsightsView year={2026} state={{ kind: 'ready', value }} onRefresh={() => {}} onYear={() => {}} />,
  );
  return host;
}

test('the complete page preserves scopes, pins, remainder, decimal values and four assessment presences', () => {
  const page = markup();
  expect(page.querySelectorAll('h2')).toHaveLength(5);
  expect(page.textContent).toContain('9007199254740993.250000');
  expect(page.textContent).toContain(m.library_insights_all_time());
  expect(page.textContent).toContain(m.library_insights_within_profile());
  expect(page.textContent).toContain(m.library_insights_remaining_profiles({ count: '1' }));
  expect(page.textContent).toContain(m.library_insights_remaining_groups({ count: '1' }));
  expect(page.textContent).toContain(`sha256:${'a'.repeat(64)}`);
  expect(page.textContent).toContain(`sha256:${'b'.repeat(64)}`);
  for (const label of [
    m.library_insights_absent(),
    m.library_insights_explicit_null(),
    m.library_insights_value(),
    m.library_insights_historical_unknown(),
    m.library_insights_cursor_help(),
  ])
    expect(page.textContent).toContain(label);
  const assessments = page.querySelector('[aria-labelledby="insights-assessments"]')!;
  expect(assessments.querySelectorAll('tbody tr th')[0]?.textContent).toBe('0');
  expect(assessments.querySelectorAll('h3')).toHaveLength(2);
  expect(page.querySelector('a[href$="year=2026&month=unallocated"]')).not.toBeNull();
});

test('healthy zero, unknown installation coverage and independent panel failure remain different', () => {
  const zero = markup(readingInsightsExample(2026, true));
  expect(zero.textContent).toContain(m.library_insights_none());
  expect(zero.textContent).not.toContain(m.library_insights_not_installed());
  const base = readingInsightsExample();
  const page = markup({
    ...base,
    panels: {
      ...base.panels,
      reportedYear: { status: 'failed', reason: 'deadline_exceeded' },
      profiles: {
        status: 'received',
        value: {
          scope: 'selected_reported_year',
          year: 2026,
          state: 'unavailable',
          reason: 'not_installed',
          coverage: { initializedSessions: null, retainedSessions: null },
        },
      },
    },
  });
  expect(page.textContent).toContain(m.library_insights_failed());
  expect(page.textContent).toContain(m.library_insights_not_installed());
  expect(page.textContent).toContain(
    m.library_insights_coverage({ initialized: m.library_insights_unknown(), retained: m.library_insights_unknown() }),
  );
  expect(page.textContent).toContain('9007199254740993.250000');
  expect(page.querySelector('a[href$="year=2026&month=12"]')).not.toBeNull();
  expect(page.querySelector('a[href$="year=2026&month=unallocated"]')).not.toBeNull();
});

test('Insights is reachable from both navigation models in all eight locales', () => {
  const before = getLocale();
  try {
    for (const locale of locales) {
      overwriteGetLocale(() => locale);
      const pins = { state: 'loaded' as const, pins: [], next: null, revision: 1 };
      const desktop = libraryNavigationEntries('insights', pins, [], locale).tabs.find(
        (entry) => entry.id === 'insights',
      );
      expect(desktop).toMatchObject({
        current: true,
        href: `/${locale}/library/insights`,
        label: m.library_insights_title(),
      });
      expect(libraryNavigationMenuEntries('insights', pins, [], locale)).toContainEqual(
        expect.objectContaining({ type: 'link', href: desktop!.href, current: true }),
      );
      expect(markup().querySelector('h1')?.textContent).toBe(m.library_insights_title());
    }
  } finally {
    overwriteGetLocale(() => before);
  }
});

test('reader replacement retires callbacks in-stack, ignores late replies and requires an explicit refresh', async () => {
  const client = new QueryClient();
  const observation = browserObservation(client);
  const stop = observation.subscribe(() => {});
  const session = { state: 'signed-in', subject: 'owner', csrfToken: 'credential-a' };
  const admit = () => {
    const snapshot = observation.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('Expected signed-in fixture');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject: 'owner',
      admitted: ['reading_progress'],
      state: 'ready',
    });
  };
  client.setQueryData(['session'], session);
  admit();
  const replies: ((value: Awaited<ReturnType<InsightsReader>>) => void)[] = [];
  const reader: InsightsReader = () => new Promise((resolve) => replies.push(resolve));
  let reading!: ReturnType<typeof useInsightsReading>;
  let address = '/en/library/insights?year=2026';
  const listeners = new Set<() => void>();
  const navigation = {
    address: () => address,
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
  };
  function Control({ source = reader }: { source?: InsightsReader }) {
    reading = useInsightsReading(2026, source);
    return (
      <ReadingInsightsView
        year={2026}
        state={reading.result}
        current={reading.current}
        onRefresh={reading.refresh}
        canRefresh={reading.canRefresh}
        onYear={() => {}}
      />
    );
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (source = reader) =>
    root.render(
      <QueryClientProvider client={client}>
        <ReaderNavigationContext.Provider value={navigation}>
          <Control source={source} />
        </ReaderNavigationContext.Provider>
      </QueryClientProvider>,
    );
  try {
    await act(async () => render());
    expect(replies).toHaveLength(1);
    const first = reading.current;
    await act(async () => {
      client.setQueryData(['session'], { ...session, csrfToken: 'credential-b' });
      expect(first()).toBe(false);
      client.setQueryData(['session'], session);
      admit();
      expect(first()).toBe(false);
      replies[0]!({ kind: 'received', viewer: 'owner', read: { kind: 'ready', value: readingInsightsExample() } });
    });
    expect(reading.result.kind).toBe('changed');
    expect(host.textContent).not.toContain('9007199254740993.250000');
    expect(replies).toHaveLength(1);
    await act(async () => reading.refresh());
    expect(replies).toHaveLength(2);
    await act(async () =>
      replies[1]!({ kind: 'received', viewer: 'owner', read: { kind: 'ready', value: readingInsightsExample() } }),
    );
    expect(host.textContent).toContain('9007199254740993.250000');
    const beforeExposure = reading.current;
    await act(async () => {
      admit();
      expect(beforeExposure()).toBe(false);
    });
    expect(reading.result.kind).toBe('changed');
    await act(async () => reading.refresh());
    await act(async () =>
      replies[2]!({ kind: 'received', viewer: 'owner', read: { kind: 'ready', value: readingInsightsExample() } }),
    );
    const retained = reading.current;
    await act(async () => render(async () => ({ kind: 'unavailable' })));
    expect(retained()).toBe(false);
    await act(async () => render());
    expect(reading.result.kind).toBe('changed');
    expect(replies).toHaveLength(3);
    await act(async () => {
      address = '/en/library/history?year=2026';
      listeners.forEach((notify) => notify());
      expect(reading.current()).toBe(false);
      address = '/en/library/insights?year=2026';
      listeners.forEach((notify) => notify());
    });
    expect(reading.current()).toBe(false);
    expect(
      client
        .getQueryCache()
        .getAll()
        .some((query) => JSON.stringify(query.state.data ?? null).includes('9007199254740993.250000')),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    stop();
    client.clear();
  }
});
