import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('cloudflare:workers', () => ({ env: {} }));
import type { LabelsPage } from '../src/library/labels-read';
const { loadCurrentLabelShelfPage, loadLabelShelfPage } = await import('../src/library/label-shelf-read');
const { LabelShelfPage } = await import('../src/library/entries-page');
const { LabelsPageView } = await import('../src/library/labels-page');
const {
  admitLabelShelfWindow,
  emptyLabelShelfWindow,
  hasPreviousLabelShelfWindow,
  previousLabelShelfWindow,
  stageLabelShelfWindow,
} = await import('../src/library/label-shelf-window-navigation');
const { shelfDisplay, shelfHref, validateShelfSearch } = await import('../src/library/shelf-params');
const { subjectHref } = await import('../src/subject/subject-href');

const labelId = '0192f3a0-6c1e-7b2a-9d4e-000000000801';
const firstSubject = '0192f3a0-6c1e-7b2a-9d4e-000000000802';
const secondSubject = '0192f3a0-6c1e-7b2a-9d4e-000000000803';
const tombstoneSubject = '0192f3a0-6c1e-7b2a-9d4e-000000000804';
const sessionId = 'b'.repeat(43);

type Captured = { method: string; path: string; query: Record<string, string>; authorization: string | null };
const requests: Captured[] = [];
let pageSize = 10;
let assignmentOverride: { status: number; body: unknown; cursorOnly?: boolean } | null = null;

const fakeKernel = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.get('authorization'),
    });
    if (url.pathname === '/v1/platform/exposure')
      return Response.json({ admitted: ['personal_library', 'reading_progress', 'library_label.assignment_list'] });
    if (url.pathname === '/v1/libraryLabelAssignments') {
      const requestedLabelId = url.searchParams.get('labelId');
      if (requestedLabelId && requestedLabelId !== labelId)
        return Response.json({ code: 'not_found' }, { status: 404 });
      if (assignmentOverride && (!assignmentOverride.cursorOnly || url.searchParams.has('cursor')))
        return Response.json(assignmentOverride.body, { status: assignmentOverride.status });
      const assignments = Array.from({ length: pageSize }, (_, index) => {
        const id = `0192f3a0-6c1e-7b2a-9d4e-${String(900 + index).padStart(12, '0')}`;
        if (index === 2)
          return { id, labelId, subjectId: tombstoneSubject, revision: 4, subject: null, libraryEntry: null };
        const subjectId = index % 2 === 0 ? firstSubject : secondSubject;
        return {
          id,
          labelId,
          subjectId,
          revision: 4,
          subject: {
            id: subjectId,
            type: 'schema:Book',
            types: ['schema:Book'],
            label: { value: `Work ${index + 1}`, language: 'en' },
            cover: null,
          },
          libraryEntry:
            index === 0
              ? {
                  state: 'in_progress',
                  activeProgressSession: {
                    mode: 'scalar_amount',
                    amount: '42',
                    total: null,
                    unit: 'percent',
                    dimension: 'percent',
                    locator: null,
                    position: null,
                    completedUnitCount: 0,
                  },
                }
              : index === 1
                ? { state: 'completed', activeProgressSession: null }
                : null,
        };
      });
      return Response.json({
        assignments,
        label: { id: labelId, name: 'Reading list', revision: 1 },
        next: pageSize === 0 ? null : 'next-page',
      });
    }
    return Response.json({ code: 'not_found' }, { status: 404 });
  },
});

const client = () => createKernelClient(fakeKernel.url.origin);
const env = {
  AUTH_ISSUER: 'https://auth.example.test',
  API_RESOURCE: 'https://api.example.test',
  WEBSITE_SCOPES: 'library_entry:read',
  WEBSITE_CLIENT_ID: 'rezics-web-test',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({
        status: 'active',
        subject: '0192f3a0-6c1e-7b2a-9d4e-000000000111',
        accessToken: 'native-web-token',
        csrfToken: 'csrf',
      }),
    }),
  },
} as never;
const request = () =>
  new Request('https://rezics.example.test/en/library', { headers: { cookie: `__Host-rezics_session=${sessionId}` } });

test('the label parameter is validated, and layout and size links keep the shelf identity', () => {
  expect(validateShelfSearch({ label: labelId, layout: 'list', cursor: 'cursor' })).toEqual({
    label: labelId,
    layout: 'list',
    cursor: 'cursor',
  });
  expect(validateShelfSearch({ label: 'not-an-id' }).label).toBeUndefined();
  expect(shelfDisplay(validateShelfSearch({ label: labelId }))).toEqual({
    layout: 'grid',
    size: 'm',
    layoutExplicit: false,
    sizeExplicit: false,
    columnsExplicit: false,
  });
  expect(shelfHref('en', { label: labelId, layout: 'list', size: 'l' })).toBe(
    `/en/library?label=${labelId}&layout=list&size=l`,
  );
});

test('the labels catalogue links each label to its shelf', () => {
  const page: LabelsPage = {
    signedIn: true,
    operations: ['library_label.list', 'library_label.create', 'library_label.rename', 'library_label.delete'],
    csrfToken: 'csrf',
    createKey: crypto.randomUUID(),
    undoKey: crypto.randomUUID(),
    labels: [
      {
        id: labelId,
        name: 'Reading list',
        revision: 1,
        renameKey: crypto.randomUUID(),
        deleteKey: crypto.randomUUID(),
      },
    ],
    next: null,
  };
  const html = renderToStaticMarkup(createElement(LabelsPageView, { page }));
  expect(html).toContain(`href="/en/library?label=${labelId}"`);
  expect(html).toContain('Reading list');
});

test('one FULL label-assignment read supplies the whole tile page, name and cursor', async () => {
  for (const count of [10, 100]) {
    requests.length = 0;
    pageSize = count;
    const page = await loadLabelShelfPage(client() as never, request(), env, {
      labelId,
      cursor: 'cursor-a',
      limit: count,
    });
    expect(page.label).toEqual({ id: labelId, name: 'Reading list', revision: 1 });
    expect(page.entries).toHaveLength(count);
    expect(page.entries[0]).toMatchObject({
      subject: { id: firstSubject, label: { value: 'Work 1', language: 'en' } },
      state: 'in_progress',
    });
    expect(page.entries[0]?.activeProgressSession).toMatchObject({ amount: '42', dimension: 'percent' });
    expect(page.entries[1]).toMatchObject({
      subject: { id: secondSubject, label: { value: 'Work 2', language: 'en' } },
      state: 'completed',
    });
    expect(page.entries[2]).toMatchObject({ subject: null });
    expect(page.entries[3]).not.toHaveProperty('state');
    expect(page.entries[3]).not.toHaveProperty('activeProgressSession');
    expect(page.next).toBe('next-page');
    expect(requests.filter((request) => request.path === '/v1/libraryLabelAssignments')).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/v1/libraryLabelAssignments',
        query: { labelId, view: 'FULL', limit: String(count), cursor: 'cursor-a' },
        authorization: 'Bearer native-web-token',
      }),
    ]);
    expect(requests).toHaveLength(2);
  }
});

test('rejected native Label cursors offer a deliberate same-Label first page without changing other outcomes', async () => {
  try {
    for (const [status, code] of [
      [400, 'invalid_cursor'],
      [409, 'stale_cursor'],
    ] as const) {
      requests.length = 0;
      assignmentOverride = { status, body: { code }, cursorOnly: true };
      const input = { labelId, cursor: 'opaque-page-token', limit: 100 } as const;
      const page = await loadLabelShelfPage(client() as never, request(), env, input);
      expect(page).toEqual({ state: 'cursor-rejected', labelId });
      const currentPage = await loadCurrentLabelShelfPage(client() as never, request(), env, input);
      expect(currentPage).toMatchObject({
        state: 'cursor-rejected',
        labelId,
        provenance: {
          subject: '0192f3a0-6c1e-7b2a-9d4e-000000000111',
          locale: 'en',
          source: { labelId, cursor: 'opaque-page-token' },
        },
      });
      expect(currentPage).not.toHaveProperty('entries');
      const html = renderToStaticMarkup(
        createElement(LabelShelfPage, {
          page,
          locale: 'ja',
          currentCursor: 'opaque-page-token',
          retryHref: `/ja/library?label=${labelId}&cursor=opaque-page-token&layout=table&size=l&columns=title`,
          display: {
            layout: 'table',
            size: 'l',
            columns: 'title',
            layoutExplicit: true,
            sizeExplicit: true,
            columnsExplicit: true,
          },
        }),
      );
      expect(html).toContain('This Label continuation could not be loaded.');
      expect(html).toContain(`/ja/library?label=${labelId}&amp;layout=table&amp;size=l&amp;columns=title`);
      expect(html).toContain('Retry this page');
      expect(html).toContain(
        `href="/ja/library?label=${labelId}&amp;cursor=opaque-page-token&amp;layout=table&amp;size=l&amp;columns=title"`,
      );
      expect(html).not.toContain('Reading list');
      expect(html).not.toContain('<form');
      expect(requests.filter((entry) => entry.path === '/v1/libraryLabelAssignments')).toHaveLength(2);
    }
    for (const [status, code, cursorOnly, cursor, state] of [
      [409, 'invalid_cursor', true, true, 'unavailable'],
      [400, 'stale_cursor', true, true, 'unavailable'],
      [400, 'invalid_cursor', false, false, 'unavailable'],
      [403, 'permission_denied', false, true, 'denied'],
      [403, 'platform_closed', false, true, 'closed'],
      [500, 'failed', false, true, 'unavailable'],
    ] as const) {
      assignmentOverride = { status, body: { code }, cursorOnly };
      expect(
        (
          await loadLabelShelfPage(client() as never, request(), env, {
            labelId,
            ...(cursor ? { cursor: 'bad' } : {}),
            limit: 100,
          })
        ).state,
      ).toBe(state);
    }
  } finally {
    assignmentOverride = null;
  }
});

test('Label window navigation admits three windows, keeps terminal recovery and retries the exact failed target', async () => {
  let windows = emptyLabelShelfWindow();
  windows = admitLabelShelfWindow(windows, null);
  windows = stageLabelShelfWindow(windows, 'next', 'window-two');
  windows = admitLabelShelfWindow(windows, 'window-two');
  windows = stageLabelShelfWindow(windows, 'next', 'window-three');
  windows = admitLabelShelfWindow(windows, 'window-three');
  expect(windows).toEqual({ predecessors: [null, 'window-two'], current: 'window-three', pending: null });
  expect(previousLabelShelfWindow(windows)).toBe('window-two');

  const beforeFailedTarget = windows;
  windows = stageLabelShelfWindow(windows, 'next', 'opaque-failed-target');
  const retry = stageLabelShelfWindow(windows, 'retry', 'opaque-failed-target');
  expect(retry).toBe(windows);
  expect(retry.predecessors).toEqual(beforeFailedTarget.predecessors);
  expect(retry.current).toBe(beforeFailedTarget.current);
  expect(retry.pending).toEqual({ move: 'next', target: 'opaque-failed-target' });

  windows = stageLabelShelfWindow(windows, 'previous', 'window-three');
  expect(hasPreviousLabelShelfWindow(windows)).toBe(true);
  windows = admitLabelShelfWindow(windows, 'window-three');
  windows = stageLabelShelfWindow(windows, 'previous', 'window-two');
  windows = admitLabelShelfWindow(windows, 'window-two');
  windows = stageLabelShelfWindow(windows, 'first', null);
  windows = admitLabelShelfWindow(windows, null);
  expect(windows).toEqual(emptyLabelShelfWindow());

  let capped = emptyLabelShelfWindow();
  capped = admitLabelShelfWindow(capped, null);
  for (let index = 1; index <= 10; index++) {
    const target = `window-${index}`;
    capped = stageLabelShelfWindow(capped, 'next', target);
    capped = admitLabelShelfWindow(capped, target);
  }
  expect(capped.predecessors).toHaveLength(8);
  expect(admitLabelShelfWindow(emptyLabelShelfWindow(), 'direct-later-window').predecessors).toEqual([]);

  pageSize = 0;
  try {
    const page = await loadLabelShelfPage(client() as never, request(), env, { labelId, limit: 100 });
    if (page.state !== 'loaded') throw new Error('Missing typed terminal Label page');
    const html = renderToStaticMarkup(
      createElement(LabelShelfPage, {
        page,
        locale: 'en',
        display: { layout: 'grid', size: 'm' },
        currentCursor: 'window-three',
        windowLinks: {
          previous: { href: `/en/library?label=${labelId}&cursor=window-two` },
          first: { href: `/en/library?label=${labelId}` },
        },
      }),
    );
    expect(html).toContain('No works have this label yet.');
    expect(html).toContain('Previous page');
    expect(html).toContain('First page');
    expect(html).not.toContain('More</a>');
    expect(html).toContain(`href="/en/library?label=${labelId}&amp;cursor=window-two"`);
    expect(html).toContain(`href="/en/library?label=${labelId}"`);
  } finally {
    pageSize = 10;
  }
});

test('the label shelf page renders the main shelf tiles, state and active progress, and a content-free tombstone', async () => {
  requests.length = 0;
  pageSize = 3;
  const page = await loadLabelShelfPage(client() as never, request(), env, { labelId, limit: 10 });
  const html = renderToStaticMarkup(
    createElement(LabelShelfPage, { page, locale: 'en', display: { layout: 'grid', size: 'm' } }),
  );
  expect(html).toContain('Reading list');
  expect(html).toContain('Work 1');
  expect(html).toContain('Other');
  expect(html).toContain('42%');
  expect(html).toContain('Work 2');
  expect(html).toContain('data-slot="cover"');
  expect(html).toContain(`/en/library?label=${labelId}&amp;layout=list`);
  expect(html).toContain(`/en/library?label=${labelId}&amp;layout=table`);
  expect(html).toContain(`/en/library?label=${labelId}&amp;size=s`);
  expect(html).toContain(`/en/library?label=${labelId}&amp;size=l`);
  expect(html).toContain(`/en/library?label=${labelId}&amp;cursor=next-page`);
  expect(html).toContain('data-slot="tombstone"');
  expect(html).not.toContain('Work 3');
  expect(html).toContain(`href="${subjectHref({ id: firstSubject, label: 'Work 1' }, 'en').href}"`);
});

test('an unknown or another owner’s label is not found', async () => {
  requests.length = 0;
  const error = await loadLabelShelfPage(client() as never, request(), env, {
    labelId: '0192f3a0-6c1e-7b2a-9d4e-000000000899',
    limit: 100,
  }).catch((value: unknown) => value);
  expect(error).toMatchObject({ isNotFound: true });
  expect(requests.filter((request) => request.path === '/v1/libraryLabelAssignments')).toHaveLength(1);
});

test('an empty label still has its name, layout controls and an empty state', async () => {
  requests.length = 0;
  pageSize = 0;
  try {
    const page = await loadLabelShelfPage(client() as never, request(), env, { labelId, limit: 100 });
    const html = renderToStaticMarkup(
      createElement(LabelShelfPage, { page, locale: 'en', display: { layout: 'grid', size: 'm' } }),
    );
    expect(html).toContain('Reading list');
    expect(html).toContain('No works have this label yet.');
    expect(html).toContain('aria-label="Layout"');
    expect(html).toContain('aria-label="Size"');
  } finally {
    pageSize = 10;
  }
});
