import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import * as start from '../.storybook/react-start';
import type { PersonalLibraryCurrentRead, PersonalContinueRead } from '../src/library/personal-library-server';
import type { LibraryMutationResult, PersonalLibraryEntry } from '../src/library/entries-read';

// UNRUN: composed regressions for controller integration. No native, browser or growth proof is claimed.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const viewer = (subject: string, csrfToken: string | null = `csrf-${subject}`) => ({
  state: 'signed-in',
  subject,
  csrfToken,
});
const groups = [
  'personal_library',
  'reading_progress',
  'library_entry.restore',
  'library_label.list',
  'library_label.assign',
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function response(subject: string): PersonalLibraryCurrentRead {
  const entry = (n: number): PersonalLibraryEntry => ({
    subjectId: id(n),
    state: n === 3 ? 'completed' : 'planned',
    revision: 7,
    incarnationId: id(90 + n),
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    changeKey: id(100 + n),
    removeKey: id(200 + n),
    stateOptions: ['planned', 'completed'].map((id) => ({ id, label: { text: id, lang: 'en' } })),
    subject: { id: id(n), type: 'Book', types: ['Book'], label: `Private ${subject} ${n}`, cover: null },
  });
  return {
    sessionSubject: subject,
    requested: { type: null, state: null, cursor: null, orderBy: 'lastActivity', direction: 'desc', locale: 'en' },
    page: { signedIn: true, entries: [entry(1), entry(2), entry(3)], next: null },
    continueEntries: { state: 'unavailable' },
    navigation: { pins: { state: 'closed' }, collections: [], collectionsState: 'loaded' },
  };
}
const saved = (n: number): LibraryMutationResult => ({
  ok: true,
  entry: { subjectId: id(n), state: 'completed', revision: 8, incarnationId: id(90 + n), updatedAt: '2026-02-01' },
});
function handler(node: Element, name: string): (event?: unknown) => void {
  const key = Object.keys(node).find((value) => value.startsWith('__reactProps$'))!;
  return (node as unknown as Record<string, Record<string, (event?: unknown) => void>>)[key]![name]!;
}
async function mount() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRootRoute, createMemoryHistory, createRouter, RouterContextProvider } =
    await import('@tanstack/react-router');
  const { PersonalLibraryCurrent } = await import('../src/library/personal-library-current');
  const server = await import('../src/library/personal-library-server');
  const actions = await import('../src/library/entries-actions');
  const labelActions = await import('../src/library/subject-slot-actions');
  const labelReader = await import('../src/library/labels-actions');
  const page = await import('../src/library/entries-page');
  const rows = await import('../src/library/shelf-rows');
  const labels = await import('../src/library/subject-labels.tsx');
  const toast = await import('@rezics/ui/undo-toast');
  const { m } = await import('../src/paraglide/messages.js');
  let controls!: ReturnType<typeof rows.useShelfRows>;
  let continueRead!: NonNullable<Parameters<typeof page.PersonalLibraryPage>[0]['continueRead']>;
  let more!: Parameters<typeof labels.SubjectLabelMore>[0];
  const useRows = rows.useShelfRows;
  const renderPage = page.PersonalLibraryPage;
  const renderMore = labels.SubjectLabelMore;
  const spies = [
    spyOn(rows, 'useShelfRows').mockImplementation((...args) => (controls = useRows(...args))),
    spyOn(page, 'PersonalLibraryPage').mockImplementation((props) => {
      continueRead = props.continueRead!;
      return createElement(renderPage, props);
    }),
    spyOn(labels, 'SubjectLabelMore').mockImplementation((props) => {
      more = props;
      return createElement(renderMore, props);
    }),
    spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}, { status: 503 })),
  ];
  const reads: ReturnType<typeof deferred<PersonalLibraryCurrentRead>>[] = [];
  const continues: ReturnType<typeof deferred<PersonalContinueRead>>[] = [];
  const writes: {
    input: Parameters<typeof actions.savePersonalLibraryEntry>[0];
    work: ReturnType<typeof deferred<LibraryMutationResult>>;
  }[] = [];
  const searches: {
    input: Parameters<typeof labelReader.readSubjectLabelPage>[0];
    work: ReturnType<typeof deferred<Awaited<ReturnType<typeof labelReader.readSubjectLabelPage>>>>;
  }[] = [];
  const undos: (() => void)[] = [];
  spies.push(
    spyOn(server, 'readPersonalLibraryCurrent').mockImplementation(() => {
      const work = deferred<PersonalLibraryCurrentRead>();
      reads.push(work);
      return work.promise;
    }),
    spyOn(server, 'readPersonalLibraryContinue').mockImplementation(() => {
      const work = deferred<PersonalContinueRead>();
      continues.push(work);
      return work.promise;
    }),
    spyOn(actions, 'savePersonalLibraryEntry').mockImplementation((input) => {
      const work = deferred<LibraryMutationResult>();
      writes.push({ input, work });
      return work.promise;
    }),
    spyOn(labelReader, 'readSubjectLabelPage').mockImplementation((input) => {
      const work = deferred<Awaited<ReturnType<typeof labelReader.readSubjectLabelPage>>>();
      searches.push({ input, work });
      return work.promise;
    }),
    spyOn(toast, 'undoToast').mockImplementation((_message, undo) => {
      undos.push(undo);
      return 'undo';
    }),
  );
  const remove = spyOn(actions, 'deletePersonalLibraryEntry').mockResolvedValue({
    ok: true,
    undo: { deletionId: id(80), revision: 8 },
  });
  const restore = spyOn(actions, 'restorePersonalLibraryEntryAction').mockResolvedValue({
    ok: false,
    reason: 'expired',
  });
  const assign = spyOn(labelActions, 'mutateSubjectLabelAction').mockResolvedValue({
    ok: false,
    reason: 'unavailable',
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], viewer('A'));
  client.setQueryData(['exposure', 'viewer'], groups);
  client.setQueryData(['exposure', 'anonymous'], []);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library'] }),
  });
  await router.load();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const run = async (action: () => unknown) => {
    await act(async () => {
      action();
      await new Promise((done) => setTimeout(done, 0));
    });
  };
  const render = (initial = response('A')) =>
    run(() =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            <PersonalLibraryCurrent initial={initial} search={{}} locale="en" display={{ layout: 'list', size: 'm' }} />
          </RouterContextProvider>
        </QueryClientProvider>,
      ),
    );
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)!;
  const settle = async <T,>(work: ReturnType<typeof deferred<T>>, value: T) => run(() => work.resolve(value));
  await render();
  return {
    host,
    client,
    router,
    m,
    reads,
    continues,
    writes,
    searches,
    undos,
    remove,
    restore,
    assign,
    render,
    run,
    settle,
    button,
    get controls() {
      return controls;
    },
    get more() {
      return more;
    },
    get continueRead() {
      return continueRead;
    },
    session: (subject: string, token?: string | null) => client.setQueryData(['session'], viewer(subject, token)),
    admission: (admitted = groups) => client.setQueryData(['exposure', 'viewer'], admitted),
    refresh: () =>
      run(() => {
        void client.refetchQueries({ queryKey: ['personal-library-current'], type: 'active' });
      }),
    debounce: () =>
      run(() => {}).then(() =>
        act(async () => {
          await new Promise((done) => setTimeout(done, 275));
        }),
      ),
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
      [...spies, remove, restore, assign].forEach((spy) => spy.mockRestore());
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.close();
    },
  };
}

test('Whole personal Shelf reads, sequential commands and Undo retire on actual cache/address ABA before commit; B owns its lease while A is unresolved', async () => {
  const ui = await mount();
  try {
    await ui.run(() => ui.controls.selectPage());
    const old = ui.controls;
    await ui.run(() => {
      void old.changeSelectedState('completed');
    });
    expect(ui.writes).toHaveLength(1);
    let staleContinue!: ReturnType<typeof ui.continueRead>;
    await ui.run(() => {
      staleContinue = ui.continueRead();
    });
    await ui.run(() => {
      ui.session('B');
      expect(old.isCurrent()).toBe(false); // Cache is replaced, React has not rendered.
      ui.session('A');
      expect(old.isCurrent()).toBe(false);
      old.selectPage();
      void old.changeState(id(2), 'completed');
      old.askRemove(id(2));
    });
    expect(ui.writes).toHaveLength(1);
    await ui.settle(ui.reads.at(-1)!, response('A'));
    await ui.run(() => {
      void ui.controls.changeState(id(2), 'completed');
    });
    expect(ui.controls.pending).toBe(true);
    await ui.settle(ui.reads[0]!, response('A')); // First A request cannot revive its retired seed.
    await ui.settle(ui.writes[0]!.work, saved(1));
    expect(ui.writes).toHaveLength(2); // Unsent selected targets were fenced.
    expect(ui.controls.pending).toBe(true);
    await ui.settle(ui.continues[0]!, {
      sessionSubject: 'A',
      requested: response('A').requested,
      result: { state: 'loaded', entries: [], next: null },
    });
    expect(await staleContinue).toEqual({ state: 'unavailable' });
    await ui.settle(ui.writes[1]!.work, saved(2));
    await ui.run(() => ui.controls.askRemove(id(1)));
    await ui.run(() => {
      void ui.controls.remove();
    });
    await ui.run(() => {
      void ui.controls.changeState(id(3), 'planned');
      ui.undos[0]!();
    });
    expect(ui.restore).not.toHaveBeenCalled(); // Queued behind the current command.
    const current = ui.controls;
    await ui.run(() => {
      ui.session('B');
      ui.undos[0]!();
    });
    await ui.settle(ui.reads.at(-1)!, response('B'));
    await ui.run(() => {
      void ui.controls.changeState(id(1), 'completed');
    });
    await ui.settle(ui.writes[2]!.work, saved(3));
    expect(ui.restore).not.toHaveBeenCalled();
    expect(ui.controls.pending).toBe(true);
    expect(ui.host.textContent).toContain('Private B');
    expect(ui.host.textContent).not.toContain('Private A');
    await ui.settle(ui.writes[3]!.work, saved(1));
    const readKey = ui.client
      .getQueryCache()
      .findAll({ queryKey: ['personal-library-current'], type: 'active' })[0]!.queryKey;
    const cached = ui.client.getQueryData<{ value: PersonalLibraryCurrentRead }>(readKey)!;
    const retiredRead = ui.controls;
    await ui.run(() => {
      ui.client.setQueryData(readKey, { ...cached, value: response('A') });
      expect(retiredRead.isCurrent()).toBe(false);
      ui.client.setQueryData(readKey, cached);
      expect(retiredRead.isCurrent()).toBe(false);
    });
    await ui.refresh();
    const staleRefresh = ui.reads.at(-1)!;
    await ui.run(() => {
      ui.router.emit({
        type: 'onBeforeNavigate',
        fromLocation: ui.router.state.location,
        toLocation: { ...ui.router.state.location, publicHref: '/en/library?cursor=other&direction=asc' },
        pathChanged: false,
        hrefChanged: true,
      });
      expect(ui.controls.isCurrent()).toBe(false);
      ui.router.emit({
        type: 'onBeforeNavigate',
        fromLocation: ui.router.state.location,
        toLocation: ui.router.state.location,
        pathChanged: false,
        hrefChanged: true,
      });
      expect(current.isCurrent()).toBe(false);
    });
    await ui.settle(staleRefresh, response('B'));
    expect(ui.host.textContent).not.toContain('Private B');
    await ui.settle(ui.reads.at(-1)!, { ...response('B'), sessionSubject: 'A' });
    expect(ui.host.textContent).not.toContain('Private A');
    expect(ui.host.textContent).not.toContain('Private B');
  } finally {
    await ui.close();
  }
});

test('A signed-in Shelf keeps authorized reads and label search available without a CSRF token, while writes stay unsent', async () => {
  const ui = await mount();
  try {
    await ui.run(() => ui.session('A', null));
    await ui.refresh();
    const page = response('A');
    await ui.settle(ui.reads.at(-1)!, page);
    expect(ui.host.textContent).toContain('Private A 1');

    let recovered!: ReturnType<typeof ui.continueRead>;
    await ui.run(() => {
      recovered = ui.continueRead();
    });
    await ui.settle(ui.continues.at(-1)!, {
      sessionSubject: 'A',
      requested: page.requested,
      result: {
        state: 'loaded',
        entries: [{ subjectId: id(4), label: 'Continue A', summary: null, progress: null }],
        next: null,
      },
    } as never);
    expect(await recovered).toMatchObject({ state: 'loaded', entries: [{ label: 'Continue A' }] });

    await ui.run(() => {
      ui.controls.select(id(1), true);
      void ui.controls.changeState(id(1), 'completed');
    });
    expect(ui.writes).toHaveLength(0);
    await ui.run(() => ui.button(ui.m.library_selected_labels_open()).click());
    await ui.debounce();
    await ui.settle(ui.searches.at(-1)!.work, {
      state: 'loaded',
      labels: [{ id: 'label-read', name: 'Read without mutation token', revision: 1 }],
      next: null,
      provenance: { viewer: 'A', csrfToken: null, query: '', cursor: undefined },
    } as never);
    expect(ui.host.textContent).toContain('Read without mutation token');
  } finally {
    await ui.close();
  }
});

test('Per-operation retirement keeps healthy reads, exact uncertain keys and partial outcomes across nonempty token rotation and healthy refresh', async () => {
  const ui = await mount();
  try {
    await ui.settle(ui.reads[0]!, response('A'));
    await ui.run(() => ui.controls.selectPage());
    await ui.run(() => {
      void ui.controls.changeSelectedState('completed');
    });
    await ui.settle(ui.writes[0]!.work, saved(1));
    await ui.settle(ui.writes[1]!.work, { ok: false, reason: 'unavailable' });
    expect(ui.controls.outcomes.map((outcome) => outcome.status)).toEqual(['changed', 'unknown', 'unchanged']);
    const exact = ui.writes[1]!.input.data;
    await ui.run(() => ui.session('A', 'rotated'));
    await ui.refresh();
    const fresh = response('A');
    fresh.continueEntries = {
      state: 'loaded',
      entries: [{ subjectId: id(5), label: 'Healthy Continue', summary: null, progress: null }],
      next: null,
    };
    if (fresh.page.signedIn) fresh.page.entries[1]!.revision = 99;
    await ui.settle(ui.reads.at(-1)!, fresh);
    expect(ui.controls.rows.find((row) => row.entry.subjectId === id(2))!.unknownIntent).toEqual(exact);
    await ui.run(() => {
      void ui.controls.retryState(id(2));
    });
    expect(ui.writes[2]!.input.data).toEqual(exact);
    expect(new Headers(ui.writes[2]!.input.headers).get('X-CSRF-Token')).toBe('csrf-A');
    const before = ui.reads.length;
    const label = ui.controls.captureLabel();
    await ui.run(() => {
      ui.admission(groups.filter((group) => group !== 'library_label.assign'));
      expect(label()).toBe(false);
      ui.admission();
    });
    expect(label()).toBe(false);
    expect(ui.reads).toHaveLength(before);
    expect(ui.host.textContent).toContain('Private A');
    expect(ui.host.textContent).toContain('Healthy Continue');
    expect(ui.controls.pending).toBe(true); // Label retirement does not release an independent state command.
    await ui.settle(ui.writes[2]!.work, saved(2));
    await ui.run(() => ui.controls.selectPage());
    await ui.run(() => {
      void ui.controls.assignSelectedLabel({ id: id(9), name: 'Native name', revision: 7 });
    });
    const labelInput = ui.assign.mock.calls[0]![0].data;
    await ui.run(() => ui.session('A', 'rotated-again'));
    await ui.refresh();
    await ui.settle(ui.reads.at(-1)!, response('A'));
    ui.assign.mockResolvedValueOnce({ ok: true, assignment: { id: id(91), revision: 1 } });
    await ui.run(() => {
      void ui.controls.retryLabel(id(1));
    });
    expect(ui.assign.mock.calls.at(-1)![0].data).toEqual(labelInput);
    expect(ui.controls.rows[0]!.unknownLabelIntent).toBeUndefined();
    expect(ui.controls.labelOutcomes.map((outcome) => outcome.status)).toEqual([
      'assigned',
      'not-attempted',
      'not-attempted',
    ]);
    await ui.run(() => ui.controls.askRemove(id(2)));
    ui.remove.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    await ui.run(() => {
      void ui.controls.remove();
    });
    const removal = ui.remove.mock.calls.at(-1)![0].data;
    await ui.refresh();
    await ui.settle(ui.reads.at(-1)!, response('A'));
    await ui.run(() => ui.controls.askRemove(id(2)));
    await ui.run(() => {
      void ui.controls.remove();
    });
    expect(ui.remove.mock.calls.at(-1)![0].data).toEqual(removal);
    const old = ui.controls;
    await ui.run(() => {
      ui.admission([]);
      expect(old.isCurrent()).toBe(false);
      ui.admission();
    });
    expect(old.isCurrent()).toBe(false);
    await ui.settle(ui.reads.at(-1)!, response('A'));
    expect(ui.controls.selected).toEqual([]);
    expect(ui.controls.isCurrent()).toBe(true);
    const recoveredWrites = ui.writes.length;
    await ui.run(() => {
      void ui.controls.changeState(id(1), 'completed');
    });
    expect(ui.writes).toHaveLength(recoveredWrites + 1);
    await ui.settle(ui.writes.at(-1)!.work, saved(1));
  } finally {
    await ui.close();
  }
});

test('Signed label first/debounced/next/retry pages require actual viewer and exact query/cursor, including empty pages; retained apply/more callbacks retire', async () => {
  const ui = await mount();
  try {
    await ui.settle(ui.reads[0]!, response('A'));
    await ui.run(() => ui.controls.selectPage());
    const open = () => ui.run(() => ui.button(ui.m.library_selected_labels_open()).click());
    const signed = (query = '', cursor?: string) => ({
      viewer: 'A',
      csrfToken: 'csrf-A',
      query,
      ...(cursor ? { cursor } : {}),
    });
    for (const provenance of [undefined, { ...signed(), viewer: 'B' }, signed('wrong'), signed('', 'wrong')]) {
      await open();
      await ui.debounce();
      await ui.settle(ui.searches.at(-1)!.work, {
        state: 'loaded',
        labels: provenance ? [{ id: id(9), name: 'Wrong private name', revision: 1 }] : [],
        next: null,
        ...(provenance ? { provenance } : {}),
      });
      expect(document.body.textContent).toContain(ui.m.library_subject_label_unavailable());
      expect(document.body.textContent).not.toContain('Wrong private name');
      await ui.run(() => ui.button(ui.m.library_collection_cancel()).click());
    }
    await open();
    await ui.debounce();
    const labels = [{ id: id(9), name: 'Native private name', revision: 7 }];
    await ui.settle(ui.searches.at(-1)!.work, { state: 'loaded', labels, next: 'signed-next', provenance: signed() });
    await ui.run(() =>
      document.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="Native private name"]')!.click(),
    );
    const apply = handler(ui.button(ui.m.library_selected_labels_apply()), 'onClick');
    const more = ui.more;
    await ui.run(() => ui.button(ui.m.library_label_more()).click());
    await ui.settle(ui.searches.at(-1)!.work, { state: 'loaded', labels: [], provenance: signed('', 'wrong') });
    expect(document.body.textContent).not.toContain('Native private name');
    await ui.run(() => {
      apply();
      more.onPage({ state: 'loaded', labels });
    });
    expect(ui.assign).not.toHaveBeenCalled();
    await ui.run(() => ui.button(ui.m.library_collection_cancel()).click());
    await open();
    await ui.debounce();
    await ui.settle(ui.searches.at(-1)!.work, { state: 'loaded', labels, next: 'signed-next', provenance: signed() });
    await ui.run(() => ui.button(ui.m.library_label_more()).click());
    expect(ui.searches.at(-1)!.input.data).toEqual({ query: '', cursor: 'signed-next' });
    await ui.settle(ui.searches.at(-1)!.work, {
      state: 'unavailable',
      labels: [],
      reason: 'stale_cursor',
      provenance: signed('', 'signed-next'),
    });
    await ui.run(() => ui.button(ui.m.library_labels_filter()).click());
    expect(ui.searches.at(-1)!.input.data).toEqual({ query: '' });
    await ui.run(() => ui.session('A', 'rotated'));
    await ui.settle(ui.searches.at(-1)!.work, { state: 'loaded', labels, next: null, provenance: signed() });
    expect(document.body.textContent).toContain('Native private name');
    await ui.run(() => {
      apply();
      more.onPage({ state: 'loaded', labels });
    });
    expect(ui.assign).not.toHaveBeenCalled(); // Replacement page retired the old choice and callback.
    const input = document.querySelector<HTMLInputElement>('input[autoComplete="off"]')!;
    const query = handler(input, 'onChange');
    await ui.run(() => query({ currentTarget: { value: 'old' } }));
    await ui.debounce();
    const oldResult = ui.searches.at(-1)!;
    await ui.run(() =>
      handler(document.querySelector('input[autoComplete="off"]')!, 'onChange')({ currentTarget: { value: 'new' } }),
    );
    await ui.settle(oldResult.work, {
      state: 'loaded',
      labels: [{ ...labels[0]!, name: 'Obsolete old query' }],
      provenance: signed('old'),
    });
    expect(document.body.textContent).not.toContain('Obsolete old query');
    await ui.debounce();
    await ui.settle(ui.searches.at(-1)!.work, { state: 'loaded', labels: [], next: null, provenance: signed('new') });
    expect(document.body.textContent).toContain(ui.m.library_selected_labels_no_matches());
    const count = ui.searches.length;
    await ui.run(() => {
      ui.admission(groups.filter((group) => group !== 'library_label.list'));
      apply();
      more.isCurrent!();
      ui.admission();
    });
    expect(more.isCurrent!()).toBe(false);
    expect(ui.assign).not.toHaveBeenCalled();
    expect(ui.host.textContent).toContain('Private A');
    expect(ui.reads).toHaveLength(1);
    expect(ui.searches).toHaveLength(count); // Debounce cannot dispatch from an obsolete scope.
  } finally {
    await ui.close();
  }
});
