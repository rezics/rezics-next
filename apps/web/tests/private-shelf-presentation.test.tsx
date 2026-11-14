import { afterAll, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import { createMemberShelfFixture } from '../src/kernel/fake/library-member-fixture';
import { shelfHref } from '../src/library/shelf-params';
import type { ShelfSummary } from '../src/library/shelf-summary-read';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';
import { shelfContextExamples } from '../src/library/shelf-work-context/examples';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module(Bun.resolveSync('../src/kernel/exposure', import.meta.dir), () => ({
  Exposure: ({ children }: { children: ReactNode }) => children,
  useOperation: () => false,
}));
afterAll(() => mock.restore());
const { ShelfSummaryNavigation } = await import('../src/library/shelf-summary-view');
const { LabelShelfPage } = await import('../src/library/entries-page');
const { LabelShelfEntries } = await import('../src/library/shelf-view');
const request = (search = '') => new Request(`https://kernel.test/v1/libraryEntries${search}`);

// Deferred source acceptance: the dev verifier owns execution and browser/native acceptance.
test('status filters retain explicit display and type choices, clear only the cursor, and never manufacture failed counts', () => {
  const before = getLocale();
  const fixture = createMemberShelfFixture();
  fixture.select('populated');
  const { status: _status, ...counts } = fixture.summary(request('?type=schema%3ABook'))!;
  const view = {
    type: 'schema:Book',
    state: 'planned',
    cursor: 'exact-private-cursor',
    layout: 'table' as const,
    columns: 'title,status',
    orderBy: 'createdAt' as const,
    direction: 'asc' as const,
  };
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      for (const page of [
        { state: 'loaded' as const, summary: counts as ShelfSummary },
        { state: 'unavailable' as const },
      ]) {
        const html = renderToStaticMarkup(
          <ShelfSummaryNavigation summary={{ page, retry: () => {} }} locale={locale} view={view} />,
        );
        expect(html).toContain(m.library_state_in_progress());
        expect(html).toContain('aria-current="page"');
        expect(html).toContain(
          shelfHref(locale, { ...view, state: 'completed', cursor: undefined }).replaceAll('&', '&amp;'),
        );
        expect(html).not.toContain('exact-private-cursor');
        if (page.state === 'unavailable') {
          expect(html).toContain(m.library_summary_unavailable());
          expect(html).toContain(m.library_summary_retry());
          expect(html).not.toContain(m.library_summary_count({ shown: '0', total: '0' }));
        }
      }
    }
  } finally {
    setLocale(before, { reload: false });
  }
});

test('an empty independent label visit keeps its selected label and returns to the explicit view without its cursor', async () => {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  const label = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000801', name: 'Reading list' };
  const html = renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <LabelShelfPage
        locale="en"
        display={{ layout: 'list', size: 'l', layoutExplicit: true, sizeExplicit: true }}
        currentCursor="label-private-cursor"
        page={{ state: 'loaded', label, entries: [], next: null, csrfToken: null, undoKey: 'unused' }}
      />
    </RouterContextProvider>,
  );
  expect(html).toContain('data-shelf-selected-label');
  expect(html).toContain(label.name);
  expect(html).toContain(m.library_label_shelf_empty());
  expect(html).toContain(m.library_shelf_label_scope());
  expect(html).toContain('href="/en/library?layout=list&amp;size=l"');
  expect(html).not.toContain('label-private-cursor');
});

test('the review fixture supplies the same bounded population to layouts, native filters and independent label membership', () => {
  const fixture = createMemberShelfFixture();
  fixture.select('populated');
  const rows = fixture.entries(request())!.libraryEntries as {
    subjectId: string;
    state: string;
    subject: { type: string };
  }[];
  expect(rows).toHaveLength(8);
  for (const layout of ['list', 'grid', 'table'])
    expect(fixture.entries(request(`?layout=${layout}`))!.libraryEntries).toEqual(rows);
  const filtered = fixture.entries(request('?type=schema%3ABook&state=planned'))!.libraryEntries;
  expect(filtered).toEqual(rows.filter((row) => row.subject.type === 'schema:Book' && row.state === 'planned'));
  const label = fixture.labelAssignments(request('?labelId=0192f3a0-6c1e-7b2a-9d4e-000000000801'))!;
  const assigned = label.assignments as { subjectId: string; libraryEntry: { state: string } }[];
  expect(assigned.map((row) => row.subjectId)).toEqual(rows.slice(0, 3).map((row) => row.subjectId));
  expect(new Set(assigned.map((row) => row.libraryEntry.state)).size).toBe(3);
  fixture.select('first-use');
  expect(fixture.entries(request())!.libraryEntries).toEqual([]);
  expect((fixture.summary(request())!.tabs as ShelfSummary['tabs']).all).toEqual({ shown: 0, total: 0 });
});

test('an exact progress amount without supplied unit meaning stays readable without a percentage bar', () => {
  const source = shelfContextExamples('en')[0]!;
  const label = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000801', name: 'Reading list' };
  const entry = { ...source, id: 'assignment', labelId: label.id };
  const html = renderToStaticMarkup(
    <LabelShelfEntries entries={[entry]} label={label} locale="en" layout="list" size="m" csrfToken={null} />,
  );
  expect(html).toContain('12 / 100');
  expect(html).toContain(m.library_progress_unit_unspecified());
  expect(html).not.toContain('role="progressbar"');
});

test('title preparation and unavailable reads remain source-local and preserve the requested selection', async () => {
  const fixture = createMemberShelfFixture();
  const original = request('?type=schema%3ABook&state=planned&orderBy=title&direction=asc');
  fixture.select('preparing');
  expect(fixture.entries(original)!.code).toBe('dependency_unavailable');
  const prepare = fixture.routes.find((route) => route.method === 'POST')!;
  await prepare.story!({
    request: new Request('https://kernel.test/v1/libraryShelfTitlePreparation', { method: 'POST' }),
    recordings: {},
    match: null,
  });
  expect(fixture.entries(original)!.libraryEntries as unknown[]).toHaveLength(1);
  fixture.select('unavailable');
  expect(fixture.entries(original)!.status).toBe(503);
  fixture.select('populated');
  expect(fixture.entries(original)!.libraryEntries as unknown[]).toHaveLength(1);
});
