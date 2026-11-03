import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import { diarySearch, diaryReturnContext, historyReturn } from '../src/library/private-diary/address';
import {
  readDiaryPage,
  readReportedYearSummary,
  type DiaryPage,
  type ReportedYearSummary,
} from '../src/library/private-diary/native';
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
      currentness: summary.currentness,
      next: null,
      continuation: 'retain-on-empty',
      expiresAt: null,
    },
  },
};
async function mount(initialAddress = { year: 2020 } as ReturnType<typeof diarySearch>) {
  setLocale('en', { reload: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const base = createRootRoute();
  const route = createRoute({ getParentRoute: () => base, path: '/library/history', validateSearch: diarySearch });
  const router = createRouter({
    routeTree: base.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [diaryReturnContext(initialAddress)] }),
  });
  await router.load();
  const show = (value: PrivateDiaryLoad = loaded, owner = 'owner') =>
    act(async () =>
      root.render(
        <RouterContextProvider router={router}>
          <PrivateDiaryPage
            loaded={value}
            address={diarySearch(router.state.location.search)}
            session={{ state: 'signed-in', subject: owner, csrfToken: 'csrf' }}
          />
        </RouterContextProvider>,
      ),
    );
  return {
    host,
    root,
    navigate: (address: ReturnType<typeof diarySearch>) =>
      act(async () => {
        await router.navigate({ to: '/library/history', search: address });
      }),
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

test('mounted year counts keep year-only separate, open exact buckets and remove stale owner/year values', async () => {
  const h = await mount();
  try {
    await h.show();
    expect(h.host.textContent).toContain('9,007,199,254,740,993');
    const buckets = h.host.querySelectorAll<HTMLAnchorElement>('li a');
    expect(buckets).toHaveLength(13);
    expect(new URL(buckets[1]!.href).searchParams.get('month')).toBe('2');
    expect(new URL(buckets[12]!.href).searchParams.get('month')).toBe('unallocated');
    expect(buckets[12]!.textContent).toBe(m.library_diary_year_unallocated());
    expect(h.host.textContent).not.toContain(m.library_diary_bucket_unavailable());
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
  const address = {
    year: 1,
    month: 'unallocated' as const,
    focus: 'exact-session',
    cursor: 'original/+?q=原文#一% &==',
    snapshot: 'native/+?revision=原文#一% &==',
    returnTo: '/library?context=exact#item',
  };
  expect(historyReturn(diaryReturnContext(address))).toEqual(address);
  expect(historyReturn('//outside.test/library/history')).toBeUndefined();
  expect(historyReturn('/library/history-extra?year=2020')).toBeUndefined();
  expect(diarySearch({ year: '0001' }).year).toBe(1);
  expect(diarySearch({ year: '0' }).year).toBeUndefined();
  expect(diarySearch({ year: 10000 }).year).toBeUndefined();
  expect(diarySearch({ snapshot: 'native' }).snapshot).toBeUndefined();
});

test('native filtered first/middle/final/sparse pages repeat exact filters and stay bounded', async () => {
  const requests: URL[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      requests.push(url);
      const cursor = url.searchParams.get('cursor');
      return Response.json({
        ...(loaded.diary.kind === 'ready' ? loaded.diary.page : {}),
        occurrences: [],
        next: cursor === 'middle' ? 'final' : cursor === 'final' ? null : 'middle',
      });
    },
  });
  for (const month of [2, 'unallocated'] as const) {
    for (const cursor of [undefined, 'middle', 'final']) {
      expect((await readDiaryPage(client, 'Bearer current', cursor, { year: 2020, month })).kind).toBe('ready');
      expect(requests.at(-1)!.searchParams.get('month')).toBe(String(month));
      expect(requests.at(-1)!.searchParams.get('year')).toBe('2020');
      expect(requests.at(-1)!.searchParams.get('limit')).toBe('25');
      expect(requests.at(-1)!.searchParams.get('cursor')).toBe(cursor ?? null);
    }
  }
  expect(requests).toHaveLength(6);
  expect(diarySearch({ month: 2 }).month).toBeUndefined();
  expect(diarySearch({ year: 2020, month: 13 }).month).toBeUndefined();
  expect(diarySearch({ year: 2020, month: true }).month).toBeUndefined();
});

test('bucket return restores exact frontier/focus and rejects old bucket or changed native summary', async () => {
  const id = '00000000-0000-4000-8000-000000000002';
  const row: DiaryPage['occurrences'][number] = {
    id,
    subjectId: 'same-subject',
    versionSubjectId: null,
    state: 'completed',
    revision: 7,
    recordedStartedAt: '2021-01-01T00:00:00Z',
    recordedCompletedAt: '2021-01-02T00:00:00Z',
    reportedDates: { availability: 'available', revision: 3, startDate: null, finishDate: { year: 2020, month: 2 } },
    assessment: { meaningRevision: 1, units: 0 },
    subject: null,
    versionSubject: null,
  };
  for (const cursor of [undefined, 'middle/+==']) {
    const address = { year: 2020, month: 2, ...(cursor ? { cursor } : {}), focus: id };
    const value: PrivateDiaryLoad = {
      ...loaded,
      address,
      diary: {
        kind: 'ready',
        page: {
          occurrences: [row],
          next: 'final',
          continuation: 'same-slot',
          expiresAt: null,
          order: 'recorded_started_desc_id_desc',
          currentness: summary.currentness,
        },
      },
    };
    const h = await mount(address);
    try {
      await h.show(value);
      const open = h.host.querySelector<HTMLAnchorElement>('[id="diary-occurrence-' + id + '"]')!;
      expect(document.activeElement).toBe(open);
      expect(new URL(open.href).pathname).toBe('/library/progress/' + id);
      const returned = historyReturn(new URL(open.href).searchParams.get('history'))!;
      expect(returned).toMatchObject({ ...address, snapshot: summary.currentness.revision });
      const next = [...h.host.querySelectorAll('a')].find((a) => a.textContent === m.library_diary_next())!;
      expect(new URL(next.href).searchParams.get('month')).toBe('2');
      await h.navigate(returned);
      await h.show({ ...value, address: returned });
      expect(h.host.querySelector('ol')).not.toBeNull();
      await h.show({
        ...value,
        address: returned,
        reportedYear: {
          kind: 'ready',
          value: { ...summary, currentness: { state: 'snapshot', revision: 'corrected' } },
        },
      });
      expect(h.host.textContent).toContain(m.library_diary_stale());
      expect(h.host.querySelector('ol')).toBeNull();
      await h.show({
        ...value,
        address: returned,
        diary:
          value.diary.kind === 'ready'
            ? {
                kind: 'ready',
                page: { ...value.diary.page, currentness: { state: 'snapshot', revision: 'corrected' } },
              }
            : value.diary,
        reportedYear: {
          kind: 'ready',
          value: { ...summary, currentness: { state: 'snapshot', revision: 'corrected' } },
        },
      });
      expect(h.host.textContent).toContain(m.library_diary_stale());
      expect(h.host.querySelector('[id="diary-occurrence-' + id + '"]')).toBeNull();
      const restart = [...h.host.querySelectorAll('a')].find((a) => a.textContent === m.library_diary_restart())!;
      expect(new URL(restart.href).searchParams.get('month')).toBe('2');
      expect(new URL(restart.href).searchParams.has('cursor')).toBe(false);
      expect(new URL(restart.href).searchParams.has('snapshot')).toBe(false);
      await h.navigate({ year: 2020, month: 'unallocated' });
      await h.show(value);
      expect(h.host.querySelector('ol')).toBeNull();
    } finally {
      await h.close();
    }
  }
});
