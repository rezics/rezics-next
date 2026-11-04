import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import { diarySearch, diaryReturnContext, historyReturn } from '../src/library/private-diary/address';
import {
  readDiaryPage,
  readReportedYearSummary,
  type ConsumptionSummary,
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
const bucket = (
  completedOccurrences: string,
  distinctCompletedSubjects: string,
  repeatOccurrences: string,
  finishPrecision: { year: string; month: string; day: string },
) => ({
  completedOccurrences,
  distinctCompletedSubjects,
  repeatOccurrences,
  completedOccurrencesWithUnknownProfile: '0',
  finishPrecision,
});
const periodSummary: ReportedYearSummary = {
  ...summary,
  ...bucket('7', '2', '5', { year: '2', month: '3', day: '2' }),
  months: Array.from({ length: 12 }, (_, i) => ({
    ...bucket('0', '0', '0', { year: '0', month: '0', day: '0' }),
    month: i + 1,
  })).map((value) =>
    value.month === 2 ? { ...bucket('5', '2', '3', { year: '1', month: '2', day: '2' }), month: 2 } : value,
  ),
  monthUnallocated: bucket('2', '1', '1', { year: '2', month: '0', day: '0' }),
  currentness: { state: 'snapshot', revision: 'period-revision' },
};
const allTimeSummary: ConsumptionSummary = {
  scope: 'retained_native_sessions',
  completedOccurrences: '9007199254740993',
  distinctCompletedSubjects: '2',
  repeatOccurrences: '9007199254740991',
  completedOccurrencesWithUnknownProfile: '1',
  coverage: { nativeSessions: 'complete', otherHistory: 'unavailable', unitMeaning: 'not_evaluated' },
  currentness: { state: 'snapshot', revision: 'all-time-revision' },
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

test('active period reads native all-time, year, month and unallocated counts without deriving page totals', async () => {
  const emptyPage = (revision: string) => ({
    kind: 'ready' as const,
    page: {
      occurrences: [],
      order: 'recorded_started_desc_id_desc' as const,
      currentness: { state: 'snapshot' as const, revision },
      next: null,
      continuation: 'same-slot',
      expiresAt: null,
    },
  });
  const h = await mount({});
  try {
    const allTimeLoad: PrivateDiaryLoad = {
      ...loaded,
      address: {},
      reportedYear: null,
      summary: { kind: 'ready', value: allTimeSummary },
      diary: emptyPage(allTimeSummary.currentness.revision),
    };
    await h.show(allTimeLoad);
    expect(h.host.querySelector('#library-diary-active-period')?.textContent).toBe(m.library_diary_period_all_time());
    expect(h.host.textContent).toContain('9,007,199,254,740,993');
    expect(h.host.textContent).toContain(m.library_diary_period_precision_unavailable());
    expect(h.host.textContent).toContain(m.library_diary_page_empty());

    await h.navigate({ year: 2020 });
    const yearLoad: PrivateDiaryLoad = {
      ...loaded,
      address: { year: 2020 },
      reportedYear: { kind: 'ready', value: periodSummary },
      summary: { kind: 'not-selected' },
      diary: emptyPage(periodSummary.currentness.revision),
    };
    await h.show(yearLoad);
    expect(h.host.querySelector('#library-diary-active-period')?.textContent).toBe(
      m.library_diary_period_year({ year: 2020 }),
    );
    expect(h.host.textContent).toContain(m.library_diary_year_precision_counts({ year: '2', month: '3', day: '2' }));
    expect(h.host.textContent).toContain(m.library_diary_period_owner_scope());
    expect(h.host.textContent).toContain(m.library_diary_period_coverage_scope());
    expect(h.host.textContent).toContain(
      m.library_diary_year_coverage({
        initialized: '9,007,199,254,740,993',
        retained: '9,007,199,254,740,993',
        missing: '2',
        unsupported: '0',
      }),
    );

    await h.navigate({ year: 2020, month: 1 });
    await h.show({ ...yearLoad, address: { year: 2020, month: 1 } });
    const januaryPeriod = h.host.querySelector('#library-diary-active-period')?.closest('section')!;
    expect([...januaryPeriod.querySelectorAll('dd')].slice(0, 3).map((value) => value.textContent)).toEqual([
      '0',
      '0',
      '0',
    ]);
    expect(h.host.textContent).toContain(m.library_diary_page_empty());

    await h.navigate({ year: 2020, month: 2 });
    await h.show({ ...yearLoad, address: { year: 2020, month: 2 } });
    expect(h.host.querySelector('#library-diary-active-period')?.textContent).toBe(
      m.library_diary_period_month({ month: 'February', year: 2020 }),
    );
    expect(h.host.textContent).toContain(m.library_diary_year_precision_counts({ year: '1', month: '2', day: '2' }));

    await h.navigate({ year: 2020, month: 'unallocated' });
    await h.show({ ...yearLoad, address: { year: 2020, month: 'unallocated' } });
    expect(h.host.querySelector('#library-diary-active-period')?.textContent).toBe(
      m.library_diary_period_unallocated({ year: 2020 }),
    );
    expect(h.host.textContent).toContain(m.library_diary_year_precision_counts({ year: '2', month: '0', day: '0' }));

    await h.navigate({});
    await h.show({ ...allTimeLoad, summary: { kind: 'unavailable' } });
    expect(h.host.textContent).toContain(m.library_diary_statistics_unavailable());
    expect(h.host.textContent).toContain(m.library_diary_page_empty());
    expect(h.host.textContent).not.toContain('9,007,199,254,740,993');
  } finally {
    await h.close();
  }
});

test('received occurrences keep repeated identity, supplied labels, date precision and optional assessment meaning', async () => {
  const firstId = '00000000-0000-4000-8000-000000000011';
  const secondId = '00000000-0000-4000-8000-000000000012';
  const thirdId = '00000000-0000-4000-8000-000000000013';
  const common = {
    subjectId: 'same-subject',
    subject: { id: 'same-subject', label: 'Repeated title', language: 'en' },
    recordedStartedAt: '2025-03-04T05:06:07.123456Z',
    recordedCompletedAt: '2025-03-05T06:07:08.654321Z',
    reportedDates: {
      availability: 'available' as const,
      revision: 4,
      startDate: { year: 1 },
      finishDate: { year: 2020, month: 2 },
    },
  };
  const rows: DiaryPage['occurrences'] = [
    {
      ...common,
      id: firstId,
      versionSubjectId: 'version-one',
      versionSubject: { id: 'version-one', label: 'Supplied version', language: 'ja' },
      state: 'completed',
      revision: 7,
      assessment: { meaningRevision: 1, units: 0 },
    },
    {
      ...common,
      id: secondId,
      versionSubjectId: null,
      versionSubject: null,
      state: 'active',
      revision: 8,
      reportedDates: { availability: 'available', revision: 5, startDate: null, finishDate: null },
      recordedCompletedAt: null,
      assessment: { meaningRevision: 1, units: null },
    },
    {
      ...common,
      id: thirdId,
      versionSubjectId: 'version-three',
      versionSubject: null,
      subject: null,
      state: 'abandoned',
      revision: 9,
      reportedDates: { availability: 'unavailable' },
    },
  ];
  const address = { cursor: 'native-cursor/+?=exact' };
  const value: PrivateDiaryLoad = {
    ...loaded,
    address,
    reportedYear: null,
    summary: { kind: 'ready', value: allTimeSummary },
    diary: {
      kind: 'ready',
      page: {
        occurrences: rows,
        order: 'recorded_started_desc_id_desc',
        currentness: { state: 'snapshot', revision: 'received-page-revision' },
        next: null,
        continuation: 'same-slot',
        expiresAt: null,
      },
    },
  };
  const previousFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    requestCount += 1;
    return previousFetch(...args);
  }) as typeof fetch;
  const h = await mount(address);
  try {
    await h.show(value);
    const items = [...h.host.querySelectorAll('li')].filter((item) => item.querySelector('details'));
    expect(items).toHaveLength(3);
    expect(h.host.textContent).toContain('Repeated title');
    expect(h.host.textContent).toContain('Supplied version');
    expect(h.host.textContent).toContain('0001');
    expect(h.host.textContent).toContain('2020-02');
    expect(h.host.textContent).toContain(m.library_diary_reported_not_reported());
    expect(h.host.textContent).toContain(m.library_diary_reported_unavailable());
    expect(h.host.textContent).toContain(m.library_diary_assessment_value({ value: '0' }));
    expect(h.host.textContent).toContain(m.library_diary_assessment_cleared());
    expect(h.host.textContent).toContain(m.library_occurrence_assessment_unavailable());
    expect(h.host.textContent).toContain(m.library_diary_version_not_attached());
    expect(h.host.textContent).toContain(m.library_diary_version_unavailable());
    expect(h.host.textContent).toContain('received-page-revision');
    expect(h.host.textContent).toContain(m.library_diary_occurrence_revision());
    expect(h.host.textContent).toContain('2025-03-04T05:06:07.123456Z');

    for (const [index, id] of [firstId, secondId, thirdId].entries()) {
      const item = items[index]!;
      const details = item.querySelector('details')!;
      details.open = true;
      expect(details.open).toBe(true);
      details.open = false;
      expect(details.open).toBe(false);
      const editor = item.querySelector<HTMLAnchorElement>('[id="diary-occurrence-' + id + '"]')!;
      expect(new URL(editor.href).pathname).toBe('/library/progress/' + id);
      expect(historyReturn(new URL(editor.href).searchParams.get('history'))).toMatchObject({ cursor: address.cursor });
    }
    expect(window.location.pathname).toBe('/library/history');
    expect(requestCount).toBe(0);
  } finally {
    globalThis.fetch = previousFetch;
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

      h.host.querySelector('details')!.open = true;
      await h.navigate({ year: 2020, month: 'unallocated' });
      await h.show({ ...value, address: { year: 2020, month: 'unallocated' } });
      expect(h.host.querySelector('details')).toBeNull();
      await h.navigate(returned);
      await h.show({ ...value, address: returned });
      expect(h.host.querySelector('details')?.open).toBe(false);

      h.host.querySelector('details')!.open = true;
      const receivedPage = value.diary.kind === 'ready' ? value.diary.page : undefined;
      await h.show({
        ...value,
        address: returned,
        diary: receivedPage ? { kind: 'ready', page: { ...receivedPage } } : value.diary,
      });
      expect(h.host.querySelector('details')?.open).toBe(false);
      h.host.querySelector('details')!.open = true;
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
      const originalAssign = window.location.assign;
      window.location.assign = (() => {}) as typeof window.location.assign;
      try {
        await h.show({ ...value, address: returned, diary: { kind: 'retired' } });
        expect(h.host.querySelector('details')).toBeNull();
      } finally {
        window.location.assign = originalAssign;
      }
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
