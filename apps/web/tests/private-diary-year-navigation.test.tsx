import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import { diarySearch, diaryReturnContext, historyReturn } from '../src/library/private-diary/address';
import { readReportedYearSummary, type ReportedYearSummary } from '../src/library/private-diary/native';
import type { PrivateDiaryLoad } from '../src/library/private-diary/server';

mock.module('../src/kernel/exposure', () => ({ useOperation: () => true }));
mock.module('../src/library/private-diary/server', () => ({ cancelPrivateDiary: mock(async () => 'cancelled') }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/library/history?year=2020', width: 390 });
const names = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Document',
  'Event',
  'MouseEvent',
  'MutationObserver',
  'IS_REACT_ACT_ENVIRONMENT',
];
const previous = names.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
for (const key of names)
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(window, key),
  });
afterAll(async () => {
  mock.restore();
  names.forEach((key, i) =>
    previous[i] ? Object.defineProperty(globalThis, key, previous[i]!) : Reflect.deleteProperty(globalThis, key),
  );
  await window.happyDOM.close();
});
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { PrivateDiaryPage } = await import('../src/library/private-diary/page');
const { ReportedYearPanel } = await import('../src/library/private-diary/year-summary');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const counts = (n = '0') => ({
  completedOccurrences: n,
  distinctCompletedSubjects: n,
  repeatOccurrences: '0',
  completedOccurrencesWithUnknownProfile: '0',
  finishPrecision: { year: n, month: '0', day: '0' },
});
const summary: ReportedYearSummary = {
  ...counts('9007199254740993'),
  scope: 'retained_native_sessions',
  year: 2020,
  calendar: 'gregorian',
  dateSource: 'explicitly_reported_journal_finish',
  months: Array.from({ length: 12 }, (_, i) => ({ ...counts(), month: i + 1 })),
  monthUnallocated: counts('9007199254740993'),
  coverage: {
    nativeSessions: 'complete',
    initializedSessions: '9007199254740993',
    retainedSessions: '9007199254740993',
    completedOccurrencesWithMissingFinish: '2',
    completedOccurrencesWithUnsupportedFinish: '0',
    otherHistory: 'unavailable',
    unitMeaning: 'not_evaluated',
  },
  currentness: { state: 'snapshot', revision: 'opaque' },
};
const loaded: PrivateDiaryLoad = {
  kind: 'ready',
  address: { year: 2020 },
  viewer: 'owner',
  csrfToken: 'csrf',
  reportedYear: { kind: 'ready', value: summary },
  summary: { kind: 'not-selected' },
  diary: {
    kind: 'ready',
    page: {
      occurrences: [],
      order: 'recorded_started_desc_id_desc',
      next: null,
      continuation: 'retain-on-empty',
      expiresAt: null,
    },
  },
};
async function mount() {
  setLocale('en', { reload: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const base = createRootRoute();
  const route = createRoute({ getParentRoute: () => base, path: '/library/history', validateSearch: diarySearch });
  const router = createRouter({
    routeTree: base.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/library/history?year=2020'] }),
  });
  await router.load();
  const show = (value: PrivateDiaryLoad = loaded, owner = 'owner') =>
    act(async () =>
      root.render(
        <RouterContextProvider router={router}>
          <PrivateDiaryPage
            loaded={value}
            address={{ year: 2020 }}
            session={{ state: 'signed-in', subject: owner, csrfToken: 'csrf' }}
          />
        </RouterContextProvider>,
      ),
    );
  return {
    host,
    root,
    show,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('native year read uses one addressed summary, retains exact strings and rejects a mismatched year', async () => {
  const requests: Request[] = [];
  let body = summary;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(body);
    },
  });
  expect(await readReportedYearSummary(client, 'Bearer current', 2020)).toEqual({ kind: 'ready', value: summary });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe('https://kernel.test/v1/libraryReportedYearSummary?year=2020');
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer current');
  body = { ...summary, year: 2021 };
  expect(await readReportedYearSummary(client, 'Bearer current', 2020)).toEqual({ kind: 'unavailable' });
});

test('mounted year counts keep year-only separate, disable unsupported buckets and remove stale owner/year values', async () => {
  const h = await mount();
  try {
    await h.show();
    expect(h.host.textContent).toContain('9,007,199,254,740,993');
    const buckets = h.host.querySelectorAll('li button');
    expect(buckets).toHaveLength(13);
    expect([...buckets].every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(buckets[12]!.textContent).toBe(m.library_diary_year_unallocated());
    expect(h.host.textContent).toContain(m.library_diary_bucket_unavailable());
    await h.show({ ...loaded, reportedYear: { kind: 'unavailable' } });
    expect(h.host.textContent).not.toContain('9,007,199,254,740,993');
    expect(h.host.textContent).toContain(m.library_diary_year_unavailable());
    await h.show({ ...loaded, address: { year: 2021 } });
    expect(h.host.querySelector('dl')).toBeNull();
    await h.show(loaded, 'replacement');
    expect(h.host.querySelector('dl')).toBeNull();
    await act(async () =>
      h.root.render(<ReportedYearPanel year={2021} result={{ kind: 'ready', value: summary }} retry={() => {}} />),
    );
    expect(h.host.querySelector('dl')).toBeNull();
    expect(h.host.textContent).toContain(m.library_diary_year_unavailable());
  } finally {
    await h.close();
  }
});

test('return context preserves exact opaque page/year/caller and refuses external destinations', () => {
  const address = { year: 1, cursor: 'original/+?q=原文#一% &==', returnTo: '/library?context=exact#item' };
  expect(historyReturn(diaryReturnContext(address))).toEqual(address);
  expect(historyReturn('//outside.test/library/history')).toBeUndefined();
  expect(historyReturn('/library/history-extra?year=2020')).toBeUndefined();
  expect(diarySearch({ year: '0001' }).year).toBe(1);
  expect(diarySearch({ year: '0' }).year).toBeUndefined();
  expect(diarySearch({ year: 10000 }).year).toBeUndefined();
});
