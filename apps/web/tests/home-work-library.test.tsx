import { expect, test } from 'bun:test';
import { act } from 'react';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  admittedCatalogueWorkId,
  admittedFeedWorkId,
  homeWorkLibraryRow,
  reconcileHomeWorkLibraryAcknowledgement,
  sameHomeWorkLibraryScope,
  type HomeWorkLibraryProjection,
  type HomeWorkLibraryScope,
} from '../src/features/feed/home-work-library/contract';
import { HomeWorkLibraryAction, HomeWorkLibraryProvider } from '../src/features/feed/home-work-library/view';
import { homeFeedStoryPage } from '../src/kernel/fake/home-feed-stories';
import { setLocale } from '../src/paraglide/runtime.js';

const scope: HomeWorkLibraryScope = {
  reader: 'reader-1',
  credentialEpoch: 'credential-1',
  source: 'home:discovery',
  observation: 'page-1',
  locale: 'en',
  route: '/',
};

function projection(current: () => boolean = () => true): HomeWorkLibraryProjection {
  return {
    scope,
    page: {
      state: 'ready',
      rows: [
        {
          rowKey: 'occurrence-1',
          subjectId: 'work-1',
          entry: { state: 'present', value: { subjectId: 'work-1', state: 'reading', revision: 4 } },
          score: { state: 'present', value: { reader: scope.reader, kind: 'ready', units: 16 } },
          actions: { state: 'current', allowed: [] },
        },
      ],
    },
    lease: { subscribe: () => () => {}, snapshot: () => 0, isCurrent: current },
  };
}

test('Home admits only an exact disclosed work identity and joins by original occurrence and Subject', () => {
  const items = homeFeedStoryPage('en', true, 'mixed').feedItems;
  const work = items.find((item) => admittedFeedWorkId(item));
  expect(work && admittedFeedWorkId(work)).toBe(work?.destination.kind === 'subject' ? work.destination.id : undefined);
  expect(items.filter((item) => item.destination.kind !== 'subject').map(admittedFeedWorkId)).toEqual(
    items.filter((item) => item.destination.kind !== 'subject').map(() => undefined),
  );
  if (work) expect(admittedFeedWorkId({ ...work, summary: { ...work.summary, creativeWork: false } })).toBeUndefined();
  expect(admittedCatalogueWorkId({ id: 'w', summary: { id: 'other', creativeWork: true } })).toBeUndefined();

  const original = projection();
  const first = original.page.rows[0]!;
  const repeated = {
    ...original,
    page: {
      ...original.page,
      rows: [first, { ...first, rowKey: 'occurrence-2', actions: { state: 'unavailable' as const } }],
    },
  };
  expect(homeWorkLibraryRow(repeated, 'occurrence-1', 'work-1')?.actions).toEqual({ state: 'current', allowed: [] });
  expect(homeWorkLibraryRow(repeated, 'occurrence-2', 'work-1')?.actions.state).toBe('unavailable');
  expect(homeWorkLibraryRow(repeated, 'occurrence-1', 'redirected-work')).toBeUndefined();
  expect(homeWorkLibraryRow(repeated, undefined, 'work-1')).toBeUndefined();
  expect(homeWorkLibraryRow(repeated, 'occurrence-3', 'work-1')).toBeUndefined();
});

test('only current acknowledged facts reconcile repeated occurrences; uncertainty and retirement do not change them', () => {
  const initial = projection();
  const before = {
    ...initial,
    page: { ...initial.page, rows: [...initial.page.rows, { ...initial.page.rows[0]!, rowKey: 'occurrence-2' }] },
  };
  const unknown = reconcileHomeWorkLibraryAcknowledgement(before, {
    state: 'unknown',
    scope,
    commandId: 'original-command',
    rowKey: 'occurrence-1',
    subjectId: 'work-1',
    entry: { state: 'absent' },
  });
  expect(unknown).toBe(before);
  const after = reconcileHomeWorkLibraryAcknowledgement(before, {
    state: 'acknowledged',
    scope,
    commandId: 'original-command',
    rowKey: 'occurrence-1',
    subjectId: 'work-1',
    entry: { state: 'absent' },
  });
  expect(homeWorkLibraryRow(after, 'occurrence-1', 'work-1')?.entry).toEqual({ state: 'absent' });
  expect(homeWorkLibraryRow(after, 'occurrence-2', 'work-1')?.entry).toEqual({ state: 'absent' });
  expect(after.page.rows.map((row) => row.rowKey)).toEqual(['occurrence-1', 'occurrence-2']);
  expect(homeWorkLibraryRow(after, 'missing', 'work-1')).toBeUndefined();
  const withdrawn = { ...before, page: { ...before.page, rows: before.page.rows.slice(1) } };
  expect(
    reconcileHomeWorkLibraryAcknowledgement(withdrawn, {
      scope,
      rowKey: 'occurrence-1',
      subjectId: 'work-1',
      commandId: 'original-command',
      state: 'acknowledged',
      entry: { state: 'absent' },
    }),
  ).toBe(withdrawn);
  expect(
    reconcileHomeWorkLibraryAcknowledgement(before, {
      scope: { ...scope, reader: 'replacement' },
      rowKey: 'occurrence-1',
      subjectId: 'work-1',
      commandId: 'original-command',
      state: 'acknowledged',
      entry: { state: 'absent' },
    }),
  ).toBe(before);
  const retired = projection(() => false);
  expect(
    reconcileHomeWorkLibraryAcknowledgement(retired, {
      state: 'acknowledged',
      scope,
      commandId: 'original-command',
      rowKey: 'occurrence-1',
      subjectId: 'work-1',
      entry: { state: 'absent' },
    }),
  ).toBe(retired);
  expect(sameHomeWorkLibraryScope(scope, { ...scope, credentialEpoch: 'credential-2' })).toBe(false);
  expect(sameHomeWorkLibraryScope(scope, { ...scope, source: 'following' })).toBe(false);
  expect(sameHomeWorkLibraryScope(scope, { ...scope, observation: 'page-2' })).toBe(false);
  expect(sameHomeWorkLibraryScope(scope, { ...scope, locale: 'de' })).toBe(false);
  expect(sameHomeWorkLibraryScope(scope, { ...scope, route: '/other' })).toBe(false);
});

test('unavailable or malformed occurrences do not invalidate an unrelated admitted row; the raw page bound precedes deduplication', () => {
  const original = projection();
  const row = original.page.rows[0]!;
  const mixed = { ...original, page: { ...original.page, rows: [row, { ...row, rowKey: 'bad', subjectId: 'other' }] } };
  expect(homeWorkLibraryRow(mixed, 'bad', 'other')).toBeUndefined();
  expect(homeWorkLibraryRow(mixed, row.rowKey, row.subjectId)).toBe(row);
  expect(
    homeWorkLibraryRow({ ...original, page: { state: 'unavailable', rows: [] } }, row.rowKey, row.subjectId),
  ).toBeUndefined();
  expect(
    homeWorkLibraryRow(
      {
        ...original,
        page: {
          ...original.page,
          rows: Array.from({ length: 101 }, (_, index) => ({ ...row, rowKey: String(index) })),
        },
      },
      '0',
      row.subjectId,
    ),
  ).toBeUndefined();
});

test('the mounted action keeps its destination while stale or missing private rows become unavailable', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.example/en' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const current = projection();
  const client = new QueryClient();
  const reader = { state: 'signed-in', subject: scope.reader, csrfToken: 'credential' };
  client.setQueryData(['session'], reader);
  const destination = '/en/subjects/work-1/Example?slot=collections';
  const render = (expectedScope = scope, prepared = current) => (
    <QueryClientProvider client={client}>
      <HomeWorkLibraryProvider expectedScope={expectedScope} signedIn enabled projection={prepared}>
        <HomeWorkLibraryAction rowKey="occurrence-1" subjectId="work-1" href={destination} locale="en" />
        <HomeWorkLibraryAction subjectId="omitted-work" href={destination} locale="en" />
      </HomeWorkLibraryProvider>
    </QueryClientProvider>
  );
  try {
    setLocale('en', { reload: false });
    await act(async () => root.render(render()));
    expect(host.textContent).toContain('Library state');
    expect(host.querySelector('button')).toBeNull();
    expect(host.querySelector('[data-slot="home-work-library-actions-unavailable"]')).toBeNull();
    expect(host.textContent).toContain('8 / 10');
    expect(host.querySelector(`a[href="${destination}"]`)).not.toBeNull();
    expect(host.querySelector('[data-slot="home-work-library-entry-unavailable"]')).not.toBeNull();
    await act(async () => root.render(render({ ...scope, observation: 'withdrawn' })));
    await act(async () => root.render(render()));
    expect(host.querySelector('[data-slot="home-work-library-entry"]')).toBeNull();
    await act(async () => root.render(render(scope, { ...current })));
    expect(host.textContent).toContain('8 / 10');
    await act(async () => {
      client.setQueryData(['session'], { ...reader, subject: 'replacement' });
    });
    expect(host.querySelector('[data-slot="home-work-library-entry"]')).toBeNull();
    await act(async () => {
      client.setQueryData(['session'], reader);
    });
    expect(host.querySelector('[data-slot="home-work-library-entry"]')).toBeNull();
    await act(async () => root.render(render({ ...scope, observation: 'replacement' })));
    expect(host.querySelector('[data-slot="home-work-library-entry"]')).toBeNull();
    expect(host.textContent).not.toContain('8 / 10');
    expect(host.querySelectorAll('[data-slot="home-work-library-entry-unavailable"]')).toHaveLength(2);
    expect(host.querySelectorAll(`a[href="${destination}"]`)).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.abort();
  }
});
