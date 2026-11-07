import { LibraryApplicationBoundary } from '../src/session/library-application';
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ComponentProps, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type { LabelsCurrentRead } from '../src/library/labels-read-route';
import type { CopiesCurrentRead } from '../src/library/copies-actions';
import type { LibraryNavigationRead } from '../src/library/pins-read';
import type { PinMutation } from '../src/library/pins-actions';
import type { PersonalLibraryCurrentRead } from '../src/library/personal-library-server';
import type { LibraryMutationResult } from '../src/library/entries-read';
import type { CurrentViewerProgressIndex } from '../src/library/progress-server';

// UNRUN: composed actual scoped-observation regressions for the integration controller.
// Only private read/write transports and presenter observation are substituted; session,
// exposure enrollment, QueryClient notifications, native intent custody and guards are real.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library', width: 1280, height: 900 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  FormData: window.FormData,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRouter, createRootRoute, createMemoryHistory, RouterContextProvider } =
  await import('@tanstack/react-router');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
setLocale('en', { reload: false });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const groups = [
  'personal_library',
  'reading_progress',
  'collections',
  'library_label.list',
  'library_label.create',
  'library_label.rename',
  'library_label.delete',
  'library_label.assign',
  'library_entry.restore',
  'library_shelf.types',
  'follow.list',
  'follow.get',
  'follow.put',
  'follow.delete',
  'published_log.list',
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function settle(client: InstanceType<typeof QueryClient>, subject: string, admitted: readonly string[] = groups) {
  const enrolled = viewerExposureLifetime(client).getSnapshot();
  expect(enrolled.state).toBe('signed-in');
  if (enrolled.state !== 'signed-in') throw new Error('Viewer observation was not enrolled');
  const key = viewerExposureQuery(enrolled.observation).queryKey;
  client.setQueryData(key, { subject, admitted });
  return key;
}
function session(
  client: InstanceType<typeof QueryClient>,
  subject: string,
  csrfToken: string | null = `csrf-${subject}`,
) {
  client.setQueryData(['session'], { state: 'signed-in', subject, csrfToken });
}
function fixture(subject = 'A', admitted: readonly string[] = groups) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  session(client, subject);
  client.setQueryData(['exposure', 'anonymous'], []);
  const release = viewerExposureLifetime(client).subscribe(() => {});
  settle(client, subject, admitted);
  return { client, release };
}
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
function mounted(client: InstanceType<typeof QueryClient>, path = '/library') {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    router,
    show: async (node: ReactNode) => {
      await act(async () =>
        root.render(
          <StrictMode>
            <QueryClientProvider client={client}>
              <LibraryApplicationBoundary>
                <RouterContextProvider router={router}>{node}</RouterContextProvider>
              </LibraryApplicationBoundary>
            </QueryClientProvider>
          </StrictMode>,
        ),
      );
      await tick();
    },
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}
function handler<T>(node: Element, name: string): T {
  const props = Object.entries(node).find(([key]) => key.startsWith('__reactProps$'))![1];
  return (props as Record<string, T>)[name]!;
}
const labelResponse = (subject: string): LabelsCurrentRead => ({
  sessionSubject: subject,
  requested: { cursor: 'opaque+/==', query: 'Private', locale: 'en' },
  page: {
    signedIn: true,
    state: 'loaded',
    query: 'Private',
    operations: groups,
    csrfToken: `loader-${subject}`,
    createKey: id(80),
    undoKey: id(81),
    next: 'next+/==',
    labels: [{ id: `label-${subject}`, name: `Private ${subject}`, revision: 7, renameKey: id(82), deleteKey: id(83) }],
  },
});
const copyResponse = (subject: string): CopiesCurrentRead => ({
  sessionSubject: subject,
  requested: { subjectId: null, cursor: 'opaque+/==', locale: 'en' },
  page: { signedIn: true, subjectId: null, copies: [], next: null, addKey: id(84), csrfToken: `loader-${subject}` },
});

test('Healthy actual scoped admission enables Library workspace journeys while foreign legacy cache never authorizes reads or retained commands', async () => {
  const labels = await import('../src/library/labels-page');
  const copies = await import('../src/library/copies-page');
  const read = await import('../src/library/labels-read-route');
  const { LabelsCurrent } = await import('../src/library/labels-current');
  const { CopiesCurrent } = await import('../src/library/copies-current');
  let label!: ComponentProps<typeof labels.LabelsPageView>;
  let copy!: ComponentProps<typeof copies.CopiesPage>;
  const lists: ReturnType<typeof deferred<LabelsCurrentRead>>[] = [];
  const spies = [
    spyOn(labels, 'LabelsPageView').mockImplementation((props) => {
      label = props;
      return <p>{props.page.labels[0]?.name}</p>;
    }),
    spyOn(copies, 'CopiesPage').mockImplementation((props) => {
      copy = props;
      return <p>Copies</p>;
    }),
    spyOn(read, 'readLabelsCurrent').mockImplementation(() => {
      const work = deferred<LabelsCurrentRead>();
      lists.push(work);
      return work.promise;
    }),
  ];
  const { client, release } = fixture();
  settle(client, 'foreign');
  client.setQueryData(['exposure', 'viewer'], groups);
  const view = mounted(client);
  const show = () =>
    view.show(
      <>
        <LabelsCurrent initial={labelResponse('A')} search={{ cursor: 'opaque+/==', q: 'Private' }} locale="en" />
        <CopiesCurrent initial={copyResponse('A')} search={{ cursor: 'opaque+/==' }} locale="en" />
      </>,
    );
  try {
    await show();
    expect(label).toBeUndefined();
    expect(copy).toBeUndefined();
    expect(lists).toHaveLength(0);
    await act(async () => {
      client.removeQueries({ queryKey: ['exposure', 'viewer'], exact: true });
      settle(client, 'A');
    });
    await tick();
    release(); // The mounted owning observers, rather than fixture enrollment, now keep the lifetime alive.
    expect(client.getQueryData(['exposure', 'viewer'])).toBeUndefined();
    expect(label.originating!.isCurrent('library_label.rename')).toBe(true);
    expect(new Headers(copy.originating!.headers('copy.create')!).get('x-csrf-token')).toBe('csrf-A');
    const beforeRotation = label.originating!;
    await act(async () => {
      session(client, 'A', 'rotated-A');
      expect(beforeRotation.isCurrent('library_label.rename')).toBe(false);
      settle(client, 'A');
      expect(beforeRotation.isCurrent('library_label.rename')).toBe(false);
    });
    await tick();
    expect(label.originating!.isCurrent('library_label.rename')).toBe(true);
    expect(new Headers(copy.originating!.headers('copy.create')!).get('x-csrf-token')).toBe('rotated-A');
    expect(lists).toHaveLength(0);
    const beforeRead = label.originating!;
    const labelsKey = client.getQueryCache().findAll({ queryKey: ['labels-current'] })[0]!.queryKey;
    const previousRead = client.getQueryData(labelsKey);
    await act(async () => {
      const fresh = labelResponse('A');
      fresh.page.labels[0]!.revision++;
      client.setQueryData(labelsKey, fresh);
      expect(beforeRead.isCurrent('library_label.rename')).toBe(false);
      client.setQueryData(labelsKey, previousRead);
      expect(beforeRead.isCurrent('library_label.rename')).toBe(false);
    });
    await tick();
    expect(label.originating!.isCurrent('library_label.rename')).toBe(true);
    const beforeError = label.originating!;
    await act(async () => {
      const enrolled = viewerExposureLifetime(client).getSnapshot();
      if (enrolled.state !== 'signed-in') throw new Error('Expected enrolled viewer');
      client
        .getQueryCache()
        .find({ queryKey: viewerExposureQuery(enrolled.observation).queryKey, exact: true })!
        .setState({ status: 'error', error: new Error('Exposure unavailable') });
      expect(beforeError.isCurrent('library_label.rename')).toBe(false);
      settle(client, 'A');
      expect(beforeError.isCurrent('library_label.rename')).toBe(false);
    });
    await tick();
    const original = label.originating!;
    await act(async () => {
      client.setQueryData(['exposure', 'viewer'], groups);
      settle(client, 'foreign');
      expect(original.isCurrent('library_label.rename')).toBe(false);
      settle(client, 'A');
      expect(original.isCurrent('library_label.rename')).toBe(false);
    });
    await tick();
    const independent = label.originating!;
    expect(independent.isCurrent('library_label.rename')).toBe(true);
    await act(async () => {
      settle(
        client,
        'A',
        groups.filter((operation) => operation !== 'library_label.create'),
      );
      expect(independent.isCurrent('library_label.create')).toBe(false);
      expect(independent.isCurrent('library_label.rename')).toBe(true);
      settle(client, 'A');
      expect(independent.isCurrent('library_label.create')).toBe(false);
    });
    await tick();
    const old = label.originating!;
    await act(async () => {
      session(client, 'B');
      settle(client, 'B');
      session(client, 'A');
      settle(client, 'A');
      expect(old.isCurrent('library_label.rename')).toBe(false);
    });
    await tick();
    expect(lists).toHaveLength(1);
    await act(async () => lists[0]!.resolve(labelResponse('B')));
    await tick();
    expect(view.host.textContent).not.toContain('Private B');
    expect(old.headers('library_label.rename')).toBeNull();
  } finally {
    await view.close();
    release();
    spies.forEach((spy) => spy.mockRestore());
  }
});

function navigationResponse(subject: string, limit: 8 | 100 = 100): LibraryNavigationRead {
  const origin = { sessionSubject: subject, credentialAgrees: true, requestedLimit: limit };
  return {
    origin,
    pins: {
      state: 'loaded',
      origin,
      pins: ['one', 'two'].map((collectionId) => ({ collectionId, target: null })),
      revision: 7,
      next: null,
      canUpdate: true,
      canRemove: true,
    },
    collections: [{ id: `collection-${subject}`, title: `Private ${subject}`, curator: null }],
    collectionsState: 'loaded',
  };
}
test('Actual navigation and pin controls retain exact uncertain intent through healthy rotation and keep B usable while A is unresolved', async () => {
  const reads = await import('../src/library/pins-read');
  const actions = await import('../src/library/pins-actions');
  const { useCurrentLibraryNavigation } = await import('../src/library/pins-current');
  const { usePinControlActions } = await import('../src/library/pin-control');
  const pendingReads: ReturnType<typeof deferred<LibraryNavigationRead>>[] = [];
  const writes: {
    input: Parameters<typeof actions.pinCollection>[0];
    work: ReturnType<typeof deferred<PinMutation>>;
  }[] = [];
  const read = spyOn(reads, 'readLibraryNavigationPage').mockImplementation(() => {
    const work = deferred<LibraryNavigationRead>();
    pendingReads.push(work);
    return work.promise;
  });
  const put = spyOn(actions, 'pinCollection').mockImplementation((input) => {
    const work = deferred<PinMutation>();
    writes.push({ input, work });
    return work.promise;
  });
  const remove = spyOn(actions, 'unpinCollection').mockImplementation((input) => {
    const work = deferred<PinMutation>();
    writes.push({ input, work });
    return work.promise;
  });
  const { client, release } = fixture();
  const view = mounted(client);
  const invalidate = spyOn(view.router, 'invalidate').mockResolvedValue(undefined);
  let nav!: ReturnType<typeof useCurrentLibraryNavigation>;
  let control!: ReturnType<typeof usePinControlActions>;
  let removal!: ReturnType<typeof usePinControlActions>;
  function Probe() {
    nav = useCurrentLibraryNavigation('en', 100, 'pins');
    control = usePinControlActions({ collectionId: 'one', pins: nav.data.pins, mode: 'list', origin: nav.pinsOrigin });
    removal = usePinControlActions({ collectionId: 'two', pins: nav.data.pins, mode: 'list', origin: nav.pinsOrigin });
    return <p>{nav.data.collections[0]?.title}</p>;
  }
  const select = (label: string, value = control) =>
    value.entries.find((entry) => 'label' in entry && entry.label === label) as { onSelect: () => void };
  try {
    await view.show(<Probe />);
    expect(pendingReads).toHaveLength(1);
    await act(async () => pendingReads[0]!.resolve(navigationResponse('A')));
    await tick();
    const oldPin = select(m.library_pin_move_down()).onSelect;
    await act(async () => oldPin());
    expect(writes).toHaveLength(1);
    const exact = structuredClone(writes[0]!.input.data);
    await act(async () => {
      session(client, 'A', 'rotated-A');
      settle(client, 'A');
    });
    await tick();
    expect(pendingReads).toHaveLength(1); // Rotation alone does not replay private reads or native commands.
    await act(async () => oldPin());
    expect(writes).toHaveLength(1);
    await act(async () => select(m.library_pin_move_down()).onSelect());
    expect(writes).toHaveLength(2);
    expect(writes[1]!.input.data).toEqual(exact);
    expect(new Headers(writes[1]!.input.headers).get('x-csrf-token')).toBe('csrf-A');
    await act(async () => writes[0]!.work.resolve({ ok: true, revision: 8 }));
    await tick();
    expect(control.pending).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
    const retainedA = select(m.library_pin_move_down()).onSelect;
    await act(async () => {
      session(client, 'B');
      settle(client, 'B');
    });
    await tick();
    expect(pendingReads).toHaveLength(2);
    await act(async () => pendingReads[1]!.resolve(navigationResponse('B')));
    await tick();
    expect(nav.pinsOrigin.isCurrent()).toBe(true);
    expect(view.host.textContent).toBe('Private B');
    await act(async () => retainedA());
    expect(writes).toHaveLength(2);
    await act(async () => select(m.library_pin_unpin(), removal).onSelect());
    expect(writes).toHaveLength(3);
    expect(new Headers(writes[2]!.input.headers).get('x-csrf-token')).toBe('csrf-B');
    await act(async () => writes[1]!.work.resolve({ ok: true, revision: 8 }));
    await tick();
    expect(removal.pending).toBe(true);
    expect(view.host.textContent).toBe('Private B');
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => writes[2]!.work.resolve({ ok: false, reason: 'unavailable' }));
    await tick();
    const acceptedB = nav.pinsOrigin;
    await act(async () => {
      client.setQueryData(['exposure', 'viewer'], groups);
      settle(client, 'foreign');
      expect(acceptedB.isCurrent()).toBe(false);
    });
    expect(nav.data.pins.state).toBe('closed');
  } finally {
    await view.close();
    release();
    [read, put, remove, invalidate].forEach((spy) => spy.mockRestore());
  }
});

function shelfResponse(subject: string): PersonalLibraryCurrentRead {
  return {
    sessionSubject: subject,
    requested: { type: null, state: null, cursor: null, orderBy: 'lastActivity', direction: 'desc', locale: 'en' },
    page: {
      signedIn: true,
      next: null,
      entries: [
        {
          subjectId: id(1),
          state: 'planned',
          revision: 7,
          incarnationId: id(90),
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          changeKey: id(91),
          removeKey: id(92),
          stateOptions: ['planned', 'completed'].map((id) => ({ id, label: { text: id, lang: 'en' } })),
          subject: { id: id(1), type: 'Book', types: ['Book'], label: `Private ${subject}`, cover: null },
        },
      ],
    },
    continueEntries: { state: 'unavailable' },
    navigation: { pins: { state: 'closed' }, collections: [] },
  };
}
test('The actual personal Shelf keeps uncertain entry intent while its scoped chooser and independent history operands retire before commit', async () => {
  const rows = await import('../src/library/shelf-rows');
  const actions = await import('../src/library/entries-actions');
  const labels = await import('../src/library/labels-actions');
  const { PersonalLibraryCurrent } = await import('../src/library/personal-library-current');
  const { useShelfTypesLifetime } = await import('../src/library/shelf-types-current');
  const { useHistoryCurrentOrigin } = await import('../src/library/history-current-origin');
  const historyOperations = ['follow.list', 'published_log.list'] as const;
  let controls!: ReturnType<typeof rows.useShelfRows>;
  let types!: ReturnType<typeof useShelfTypesLifetime>;
  let history!: ReturnType<typeof useHistoryCurrentOrigin>;
  const native: {
    input: Parameters<typeof actions.savePersonalLibraryEntry>[0];
    work: ReturnType<typeof deferred<LibraryMutationResult>>;
  }[] = [];
  const originalRows = rows.useShelfRows;
  const spies = [
    spyOn(rows, 'useShelfRows').mockImplementation((...args) => (controls = originalRows(...args))),
    spyOn(actions, 'savePersonalLibraryEntry').mockImplementation((input) => {
      const work = deferred<LibraryMutationResult>();
      native.push({ input, work });
      return work.promise;
    }),
    spyOn(labels, 'readSubjectLabelPage').mockResolvedValue({
      state: 'loaded',
      labels: [{ id: id(95), name: 'Accepted scoped label' }],
      next: null,
      provenance: { viewer: 'A', csrfToken: 'csrf-A', query: '' },
    }),
  ];
  const { client, release } = fixture();
  const view = mounted(client);
  const initial = shelfResponse('A');
  function Siblings() {
    types = useShelfTypesLifetime('en', {});
    history = useHistoryCurrentOrigin('opaque+/==:en', historyOperations, 'A');
    return <PersonalLibraryCurrent initial={initial} search={{}} display={{ layout: 'list', size: 'm' }} locale="en" />;
  }
  try {
    await view.show(<Siblings />);
    expect(controls.writeAdmitted).toBe(true);
    expect(types.isCurrent()).toBe(true);
    expect(history.current(0)).toBe(true);
    await act(async () => controls.select(id(1), true));
    const chooser = [...view.host.querySelectorAll('button')].find(
      (node) => node.textContent === m.library_selected_labels_open(),
    )!;
    await act(async () => chooser.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 270));
    });
    expect(document.body.textContent).toContain('Accepted scoped label');
    const oldCancel = handler<() => void>(
      [...document.querySelectorAll('button')].find((node) => node.textContent === m.library_collection_cancel())!,
      'onClick',
    );
    await act(async () => {
      void controls.changeState(id(1), 'completed');
    });
    expect(native).toHaveLength(1);
    await act(async () => native[0]!.work.resolve({ ok: false, reason: 'unavailable' }));
    await tick();
    const exact = structuredClone(native[0]!.input.data);
    const oldType = types.isCurrent;
    const oldHistory = history.current;
    const oldRetry = controls.retryState;
    await act(async () => {
      session(client, 'A', 'new-A');
      settle(client, 'A');
    });
    await tick();
    expect(oldType()).toBe(false);
    expect(oldHistory(0)).toBe(false);
    expect(types.isCurrent()).toBe(true);
    await act(async () => {
      void oldRetry(id(1));
    });
    expect(native).toHaveLength(1);
    await act(async () => oldCancel());
    expect(document.body.textContent).toContain('Accepted scoped label');
    expect(labels.readSubjectLabelPage).toHaveBeenCalledTimes(1);
    await act(async () => {
      void controls.retryState(id(1));
    });
    expect(native).toHaveLength(2);
    expect(native[1]!.input.data).toEqual(exact);
    await act(async () => native[1]!.work.resolve({ ok: false, reason: 'unavailable' }));
    await tick();
    const retained = history.current;
    await act(async () => {
      settle(
        client,
        'A',
        groups.filter((operation) => operation !== 'personal_library'),
      );
      expect(retained(0)).toBe(false);
      expect(retained(1)).toBe(true);
      settle(client, 'A');
      expect(retained(0)).toBe(false);
    });
    await tick();
    expect(controls.rows[0]!.unknownIntent).toEqual(exact);
    const before = native.length;
    const stale = controls.retryState;
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-out', csrfToken: null, subject: null });
      session(client, 'A');
      settle(client, 'A');
      void stale(id(1));
    });
    expect(native).toHaveLength(before);
  } finally {
    await view.close();
    release();
    spies.forEach((spy) => spy.mockRestore());
  }
});

test('Actual Progress start preserves sparse choice input and key on healthy observation churn; wrong reader address closes retained actions', async () => {
  const server = await import('../src/library/progress-server');
  const pages = await import('../src/library/progress-page');
  const subject = { id: id(1), type: 'Book', label: 'Private progress A', cover: null };
  const loader: CurrentViewerProgressIndex = {
    viewer: 'A',
    locale: 'en',
    requested: { subjectId: id(1), cursor: 'opaque+/==' },
    page: {
      signedIn: true,
      subjectId: id(1),
      sessions: [],
      next: 'next+/==',
      idempotencyKey: id(99),
      selectedSubject: subject,
      progressChoices: [
        { mode: 'completed_units', units: [{ id: 'sparse.unit', label: 'parts', step: '1', total: 'forbidden' }] },
      ],
    },
  };
  const commands: {
    input: Parameters<typeof server.startProgressSession>[0];
    work: ReturnType<typeof deferred<Awaited<ReturnType<typeof server.startProgressSession>>>>;
  }[] = [];
  const write = spyOn(server, 'startProgressSession').mockImplementation((input) => {
    const work = deferred<Awaited<ReturnType<typeof server.startProgressSession>>>();
    commands.push({ input, work });
    return work.promise;
  });
  const { client, release } = fixture();
  const view = mounted(client, `/library/progress?subjectId=${id(1)}&cursor=opaque%2B%2F%3D%3D`);
  const submit = () =>
    handler<(event: { preventDefault: () => void }) => Promise<void>>(view.host.querySelector('form')!, 'onSubmit');
  try {
    await view.show(
      <pages.CurrentViewerProgressIndexPage loader={loader} requested={{ subjectId: id(1), cursor: 'opaque+/==' }} />,
    );
    expect(client.getQueryData(['exposure', 'viewer'])).toBeUndefined();
    expect(view.host.querySelector('form')).not.toBeNull();
    const first = submit();
    await act(async () => {
      void first({ preventDefault() {} });
    });
    expect(commands).toHaveLength(1);
    await act(async () => commands[0]!.work.resolve({ ok: false, reason: 'unavailable' }));
    await tick();
    await act(async () => {
      session(client, 'A', 'rotated');
      settle(client, 'A');
    });
    await tick();
    await act(async () => {
      void first({ preventDefault() {} });
    });
    expect(commands).toHaveLength(1);
    await act(async () => {
      void submit()({ preventDefault() {} });
    });
    expect(commands).toHaveLength(2);
    expect(commands[1]!.input.data).toEqual(commands[0]!.input.data);
    expect(commands[1]!.input.data).toMatchObject({ subjectId: id(1), mode: 'completed_units', unit: 'sparse.unit' });
    expect(new Headers(commands[1]!.input.headers).get('x-csrf-token')).toBe('rotated');
    const retained = submit();
    const key = client
      .getQueryCache()
      .getAll()
      .find((query) => query.queryKey[0] === 'library' && query.queryKey[2] === 'current-viewer')!.queryKey;
    await act(async () => {
      client.setQueryData(key, { ...loader, requested: { ...loader.requested, cursor: 'foreign-address' } });
      void retained({ preventDefault() {} });
      client.setQueryData(key, loader);
      void retained({ preventDefault() {} });
    });
    expect(commands).toHaveLength(2);
    await act(async () => commands[1]!.work.resolve({ ok: false, reason: 'unavailable' }));
    await tick();
    expect(view.host.textContent).toContain('Private progress A');
  } finally {
    await view.close();
    release();
    write.mockRestore();
  }
});

test('Copies and Labels keep authorized tokenless reads, exact addresses and order while retiring stale callbacks', async () => {
  const labels = await import('../src/library/labels-page');
  const copies = await import('../src/library/copies-page');
  const reads = await import('../src/library/copies-actions');
  const labelReads = await import('../src/library/labels-read-route');
  const { CopiesCurrent } = await import('../src/library/copies-current');
  const { LabelsCurrent } = await import('../src/library/labels-current');
  let label!: ComponentProps<typeof labels.LabelsPageView>;
  let copy!: ComponentProps<typeof copies.CopiesPage>;
  const initial = labelResponse('A');
  initial.page.labels.push({ ...initial.page.labels[0]!, id: 'second', name: 'Second' });
  const spies = [
    spyOn(labels, 'LabelsPageView').mockImplementation((props) => {
      label = props;
      return <p>Labels</p>;
    }),
    spyOn(copies, 'CopiesPage').mockImplementation((props) => {
      copy = props;
      return <p>Copies</p>;
    }),
    spyOn(labelReads, 'readLabelsCurrent').mockResolvedValue(initial),
    spyOn(reads, 'readCopiesCurrent').mockResolvedValue(copyResponse('A')),
    spyOn(reads, 'readCopyDetailCurrent').mockResolvedValue({
      sessionSubject: 'A',
      requested: copyResponse('A').requested,
      id: id(1),
      result: { ok: false, reason: 'forbidden' },
    }),
  ];
  const { client, release } = fixture();
  session(client, 'A', null);
  settle(client, 'A');
  const view = mounted(client);
  try {
    await view.show(
      <>
        <LabelsCurrent initial={initial} search={{ cursor: 'opaque+/==', q: 'Private' }} locale="en" />
        <CopiesCurrent initial={copyResponse('A')} search={{ cursor: 'opaque+/==' }} locale="en" />
      </>,
    );
    expect(label.page.labels.map(({ id }) => id)).toEqual(['label-A', 'second']);
    expect(copy.page.requestedCursor).toBe('opaque+/==');
    expect(label.originating!.isCurrent('library_label.list')).toBe(true);
    expect(copy.originating!.isCurrent('copy.get')).toBe(true);
    expect(copy.originating!.headers('copy.create')).toBeNull();
    expect(label.originating!.isCurrent('library_label.rename')).toBe(false);
    expect(await copy.originating!.readDetail(id(1))).toEqual({ ok: false, reason: 'forbidden' });
    expect(await label.refresh!()).toBe(initial.page);
    expect(labelReads.readLabelsCurrent).toHaveBeenCalledWith({ data: { cursor: 'opaque+/==', query: 'Private' } });
    await act(async () =>
      client
        .getQueryCache()
        .find({ queryKey: ['copies-current'], type: 'active' })!
        .setState({ status: 'error', error: new Error('Read unavailable') }),
    );
    await tick();
    await act(async () => view.host.querySelector<HTMLButtonElement>('button')!.click());
    await tick();
    expect(reads.readCopiesCurrent).toHaveBeenCalledWith({ data: { subjectId: undefined, cursor: 'opaque+/==' } });
    expect(copy.originating!.isCurrent()).toBe(true);
    const before = copy.originating!;
    await act(async () => {
      session(client, 'A', 'arrived');
      settle(client, 'A');
    });
    await tick();
    expect(before.isCurrent('copy.get')).toBe(false);
    expect(copy.originating!.headers('copy.create')).toEqual({ 'x-csrf-token': 'arrived' });
    const revoked = label.originating!;
    await act(async () => {
      settle(client, 'A', []);
      settle(client, 'A');
    });
    expect(revoked.isCurrent()).toBe(false);
    await tick();
    const old = copy.originating!;
    await act(async () => {
      session(client, 'B', null);
      session(client, 'A', null);
      settle(client, 'A');
    });
    expect(old.isCurrent()).toBe(false);
    expect(await old.readDetail(id(1))).toEqual({ ok: false, reason: 'unavailable' });
  } finally {
    await view.close();
    release();
    spies.forEach((spy) => spy.mockRestore());
  }
});

// One real client hosts catalogue work, History reading and Ratings without feature-owned session observers.
test('catalogue, History and My ratings share retirement while read admission survives missing CSRF', async () => {
  mock.module('../src/ratings/own-votes/actions', () => ({
    readOwnVotesForViewer: async () => {
      throw new Error('Unexpected Ratings read');
    },
  }));
  const { candidateSession, useCandidateWork } = await import('../src/subject/candidate-lifetime');
  const { catalogueEditor, useEditorLifetime } = await import('../src/features/catalogue/editor-lifetime');
  const { MyLogsCurrentViewer } = await import('../src/library/my-logs-page');
  const { useOwnVotesCurrentOrigin } = await import('../src/ratings/own-votes/current-origin');
  const { useHistoryCurrentOrigin } = await import('../src/library/history-current-origin');
  const { OWN_VOTES_SOURCE } = await import('../src/ratings/own-votes/inventory');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const cacheSubscription = spyOn(client.getQueryCache(), 'subscribe');
  session(client, 'A', null);
  const release = viewerExposureLifetime(client).subscribe(() => {});
  settle(client, 'A');
  const work: Array<() => boolean> = [];
  const commands: Array<() => Promise<string>> = [];
  const reads: Array<() => boolean> = [];
  const ratings: Array<() => boolean> = [];
  const credentials: Array<string | null> = [];
  const pending = deferred<string>();
  const Editor = catalogueEditor(function Editor({ transport }: { transport: () => Promise<string> }) {
    const lifetime = useEditorLifetime();
    work.push(lifetime.active);
    commands.push(transport);
    return null;
  });
  const Catalogue = candidateSession(function Catalogue() {
    const lifetime = useCandidateWork('subject-A');
    work.push(lifetime.live);
    return <Editor transport={() => pending.promise} />;
  });
  const operations = ['copy.list'] as const;
  function HistoryLease() {
    const origin = useHistoryCurrentOrigin('copy-address', operations, 'A');
    reads.push(origin.readLease(0).current);
    credentials.push(origin.credential(0));
    return null;
  }
  function Ratings() {
    const origin = useOwnVotesCurrentOrigin(
      {
        state: 'ready',
        subject: 'A',
        cursor: null,
        locale: 'en',
        source: OWN_VOTES_SOURCE,
        page: { viewer: { accountId: 'A' }, votes: [], next: null },
      },
      null,
    );
    ratings.push(origin.isCurrent);
    return null;
  }
  const ratingsRouter = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/library/ratings'] }),
  });
  const page = mounted(client, '/library/logs');
  try {
    await page.show(
      <>
        <Catalogue />
        <HistoryLease />
        <MyLogsCurrentViewer
          initial={{
            sessionSubject: 'A',
            cursor: null,
            locale: 'en',
            page: { state: 'loaded', logs: [], next: null, restarted: false },
          }}
        />
        <RouterContextProvider router={ratingsRouter}>
          <Ratings />
        </RouterContextProvider>
      </>,
    );
    expect(cacheSubscription.mock.calls.length).toBe(1);
    expect(reads.at(-1)!()).toBe(true);
    expect(credentials.at(-1)).toBeNull();
    expect(ratings.at(-1)!()).toBe(true);
    const oldWork = work.at(-1)!;
    const oldRead = reads.at(-1)!;
    const oldRating = ratings.at(-1)!;
    const completion = commands.at(-1)!();
    await act(async () => {
      session(client, 'B');
      session(client, 'A');
    });
    pending.resolve('late');
    await expect(completion).rejects.toThrow('Retired catalogue editor');
    expect(oldWork()).toBe(false);
    expect(oldRead()).toBe(false);
    expect(oldRating()).toBe(false);
    await act(async () => {
      settle(client, 'A');
    });
    const same = client.getQueryData(['session']);
    const time = client.getQueryState(['session'])!.dataUpdatedAt;
    const enrolled = viewerExposureLifetime(client).getSnapshot();
    await act(async () => {
      client.setQueryData(['session'], same, { updatedAt: time });
    });
    expect(viewerExposureLifetime(client).getSnapshot()).not.toBe(enrolled);
    const beforeRemoval = viewerExposureLifetime(client).getSnapshot();
    await act(async () => {
      client.removeQueries({ queryKey: ['session'], exact: true });
      session(client, 'A');
    });
    expect(viewerExposureLifetime(client).getSnapshot()).not.toBe(beforeRemoval);
    expect(oldWork()).toBe(false);
  } finally {
    await page.close();
    release();
    cacheSubscription.mockRestore();
  }
});
