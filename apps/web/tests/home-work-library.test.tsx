import { expect, test } from 'bun:test';
import { act } from 'react';
import { dirname } from 'node:path';
import {
  admittedCatalogueWorkId,
  admittedFeedWorkId,
  homeWorkLibraryRow,
  planHomeWorkLibraryPages,
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
    pages: [
      {
        state: 'ready',
        rows: [
          {
            subjectId: 'work-1',
            entry: { state: 'present', value: { subjectId: 'work-1', state: 'reading', revision: 4 } },
            score: { state: 'present', value: { reader: scope.reader, kind: 'ready', units: 80 } },
            entryControl: () => <button type="button">Reading</button>,
            scoreControl: () => <button type="button">8 / 10</button>,
          },
        ],
      },
    ],
    lease: { subscribe: () => () => {}, snapshot: () => 0, isCurrent: current },
  };
}

test('Home admits only an exact disclosed work identity and batches distinct references within the native bound', () => {
  const items = homeFeedStoryPage('en', true, 'mixed').feedItems;
  const work = items.find((item) => admittedFeedWorkId(item));
  expect(work && admittedFeedWorkId(work)).toBe(work?.destination.kind === 'subject' ? work.destination.id : undefined);
  expect(items.filter((item) => item.destination.kind !== 'subject').map(admittedFeedWorkId)).toEqual(
    items.filter((item) => item.destination.kind !== 'subject').map(() => undefined),
  );
  if (work) expect(admittedFeedWorkId({ ...work, summary: { ...work.summary, creativeWork: false } })).toBeUndefined();
  expect(admittedCatalogueWorkId({ id: 'w', summary: { id: 'other', creativeWork: true } })).toBeUndefined();

  const ids = Array.from({ length: 304 }, (_, index) => `work-${index}`);
  const plan = planHomeWorkLibraryPages([...ids, ids[0]!, ids[1]!]);
  expect(plan.pages.map((page) => page.length)).toEqual([100, 100, 100]);
  expect(plan.pages.flat()).toHaveLength(300);
  expect(new Set(plan.pages.flat()).size).toBe(300);
  expect(plan.hasMore).toBe(true);
});

test('only current acknowledged facts reconcile one shared work row; uncertainty and retirement do not change it', () => {
  const before = projection();
  const unknown = reconcileHomeWorkLibraryAcknowledgement(before, {
    state: 'unknown',
    commandId: 'original-command',
    subjectId: 'work-1',
    entry: { state: 'absent' },
  });
  expect(unknown).toBe(before);
  const after = reconcileHomeWorkLibraryAcknowledgement(before, {
    state: 'acknowledged',
    commandId: 'original-command',
    subjectId: 'work-1',
    entry: { state: 'absent' },
  });
  expect(homeWorkLibraryRow(after, 'work-1')?.entry).toEqual({ state: 'absent' });
  expect(homeWorkLibraryRow(after, 'missing')).toBeUndefined();
  const retired = projection(() => false);
  expect(
    reconcileHomeWorkLibraryAcknowledgement(retired, {
      state: 'acknowledged',
      commandId: 'original-command',
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
  const destination = '/en/subjects/work-1/Example?slot=collections';
  const render = (expectedScope = scope) => (
    <HomeWorkLibraryProvider expectedScope={expectedScope} signedIn enabled projection={current}>
      <HomeWorkLibraryAction subjectId="work-1" href={destination} locale="en" />
      <HomeWorkLibraryAction subjectId="omitted-work" href={destination} locale="en" />
    </HomeWorkLibraryProvider>
  );
  try {
    setLocale('en', { reload: false });
    await act(async () => root.render(render()));
    expect(host.textContent).toContain('Reading');
    expect(host.textContent).toContain('8 / 10');
    expect(host.querySelector(`a[href="${destination}"]`)).not.toBeNull();
    expect(host.querySelector('[data-slot="home-work-library-entry-unavailable"]')).not.toBeNull();
    await act(async () => root.render(render({ ...scope, observation: 'replacement' })));
    expect(host.textContent).not.toContain('Reading');
    expect(host.textContent).not.toContain('8 / 10');
    expect(host.querySelectorAll('[data-slot="home-work-library-entry-unavailable"]')).toHaveLength(2);
    expect(host.querySelectorAll(`a[href="${destination}"]`)).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.abort();
  }
});
