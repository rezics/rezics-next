import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ReactNode } from 'react';
import type { CurrentViewerProgressIndex } from '../src/library/progress-server';
import type {
  ProgressFailure,
  ProgressFinishInput,
  ProgressStartInput,
  ProgressRecorded,
  ProgressStarted,
} from '../src/library/progress-reads';
import type { ProgressChoices } from '../src/library/progress-profile';
import type { EntityPickerProps } from '@rezics/ui/entity-picker';

// UNRUN: composed cache/callback regressions for the controller; no native or browser proof.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://rezics.test/en/library/progress' });
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
  ShadowRoot: window.ShadowRoot,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(async () => {
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const { QueryClient, QueryClientProvider, useQuery } = await import('@tanstack/react-query');
const sessionQuery = { queryKey: ['session'] as const, enabled: false };
const exposureQuery = { queryKey: ['exposure', 'viewer'] as const, enabled: false };
const operations = ['list', 'read', 'create', 'complete', 'abandon'].map((name) => `progress_session.${name}`);
type Viewer = { state: 'signed-in' | 'signed-out' | 'unknown'; subject: string | null; csrfToken: string | null };
const viewer = (subject = 'A', csrfToken = `${subject}-credential`): Viewer => ({
  state: 'signed-in',
  subject,
  csrfToken,
});
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('../src/session/query', () => ({
  sessionQuery,
  exposureQuery,
  useSession: () => useQuery<Viewer>(sessionQuery).data ?? { state: 'unknown', subject: null, csrfToken: null },
}));
// The shared operation resolver owns admission semantics; isolate exact operation episodes here.
const operationIsAdmitted = (operation: string, admitted?: readonly string[]) => admitted?.includes(operation) ?? false;
function useOperation(operation: string) {
  const query = useQuery<string[]>(exposureQuery);
  return query.status === 'success' && operationIsAdmitted(operation, query.data);
}
mock.module('../src/kernel/exposure', () => ({
  operationIsAdmitted,
  useOperation,
  Exposure: ({ operation, children }: { operation: string; children: ReactNode }) =>
    useOperation(operation) ? children : null,
}));
mock.module('../src/threads/composer', () => ({
  csrfHeaders: () => {
    throw new Error('Use the actual cache credential');
  },
}));
type Kind = 'start' | 'complete' | 'abandon';
type Result = ProgressStarted | ProgressRecorded | ProgressFailure;
const writes: {
  kind: Kind;
  data: ProgressStartInput | ProgressFinishInput;
  headers: unknown;
  work: ReturnType<typeof deferred<Result>>;
}[] = [];
const reads: { data: unknown; work: ReturnType<typeof deferred<CurrentViewerProgressIndex>> }[] = [];
const choices: { work: ReturnType<typeof deferred<ProgressChoices>> }[] = [];
function command(kind: Kind, input: { data: ProgressStartInput | ProgressFinishInput; headers?: unknown }) {
  const work = deferred<Result>();
  writes.push({ kind, ...input, headers: input.headers, work });
  return work.promise;
}
mock.module('../src/library/progress-server', () => ({
  startProgressSession: (input: { data: ProgressStartInput; headers?: unknown }) => command('start', input),
  finishProgressSession: (input: { data: ProgressFinishInput; headers?: unknown }) => command(input.data.action, input),
  readCurrentViewerProgressIndex: (input: { data: unknown }) => {
    const work = deferred<CurrentViewerProgressIndex>();
    reads.push({ data: input.data, work });
    return work.promise;
  },
  readProgressChoices: () => {
    const work = deferred<ProgressChoices>();
    choices.push({ work });
    return work.promise;
  },
}));
const pickers: EntityPickerProps[] = [];
mock.module('@rezics/ui/entity-picker', () => ({
  EntityPicker: (props: EntityPickerProps) => {
    pickers.push(props);
    return <div data-picker={props.label}>{props.value?.map((item) => item.title).join(', ')}</div>;
  },
}));
const menus: { label: string; onSelect: () => void }[] = [];
mock.module('@rezics/ui/menu', () => ({
  Menu: ({ entries }: { entries: { label: string; onSelect?: () => void }[] }) => (
    <div>
      {entries
        .filter((entry) => entry.onSelect)
        .map((entry) => {
          menus.push({ label: entry.label, onSelect: entry.onSelect! });
          return (
            <button key={entry.label} onClick={entry.onSelect}>
              {entry.label}
            </button>
          );
        })}
    </div>
  ),
}));
const buttons: { children: ReactNode; onClick?: () => void; disabled?: boolean }[] = [];
mock.module('@rezics/ui/shadcn/button', () => ({
  Button: (props: { children: ReactNode; onClick?: () => void; disabled?: boolean; type?: 'button' | 'submit' }) => {
    buttons.push(props);
    return <button {...props} type={props.type ?? 'button'} />;
  },
}));
const modes: { onValueChange: (value: string) => void }[] = [];
mock.module('@rezics/ui/shadcn/radio-group', () => ({
  RadioGroup: (props: { children: ReactNode; onValueChange: (value: string) => void }) => {
    modes.push(props);
    return <div>{props.children}</div>;
  },
  RadioGroupItem: ({ value }: { value: string }) => <span>{value}</span>,
}));
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { CurrentViewerProgressIndexPage } = await import('../src/library/progress-page');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
const id = (n: number) => `019a1b2c-3d4e-7f00-8a00-${String(n).padStart(12, '0')}`;
const profile: ProgressChoices = [
  {
    mode: 'scalar_amount',
    units: [{ id: 'page', label: 'pages', min: '0', max: '100', step: '0.01', total: 'required' }],
  },
  { mode: 'cursor_position', units: [{ id: 'position', label: 'positions', step: 'any', total: 'optional' }] },
  { mode: 'completed_units', units: [{ id: 'track', label: 'tracks', step: '1', total: 'forbidden' }] },
];
const subject = (n: number, label = `Subject ${n}`) => ({
  id: id(n),
  type: 'schema:Book',
  types: ['schema:Book'],
  label,
  cover: null,
});
function envelope(owner = 'A', subjectId = id(1), cursor: string | null = null): CurrentViewerProgressIndex {
  return {
    viewer: owner,
    locale: 'en',
    requested: { subjectId, cursor },
    page: {
      signedIn: true,
      subjectId,
      selectedSubject: subject(1, `Private ${owner}`),
      progressChoices: profile,
      next: 'signed/opaque+==',
      idempotencyKey: crypto.randomUUID(),
      sessions: [
        {
          id: id(20),
          subjectId,
          versionSubjectId: null,
          subject: subject(1, `Private ${owner}`),
          versionSubject: null,
          mode: 'scalar_amount',
          unit: 'page',
          unitLabel: 'pages',
          amount: '3',
          total: '100',
          locator: null,
          position: null,
          completedUnitCount: 0,
          state: 'active',
          revision: 7,
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: null,
        },
      ],
    },
  };
}
const tick = (fn: () => unknown = () => {}) =>
  act(async () => {
    await fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
function formCallback(host: HTMLDivElement) {
  const props = Object.entries(host.querySelector('form')!).find(([key]) => key.startsWith('__reactProps$'))![1] as {
    onSubmit: (event: { preventDefault(): void }) => void;
  };
  return () => props.onSubmit({ preventDefault() {} });
}
async function mount() {
  writes.length = reads.length = choices.length = pickers.length = menus.length = buttons.length = modes.length = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, viewer());
  client.setQueryData(exposureQuery.queryKey, operations);
  let loader = envelope();
  let requested: { subjectId?: string; cursor?: string } = { subjectId: id(1) };
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/library/progress'] }),
  });
  await router.load();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const redirects: string[] = [];
  const redirect = spyOn(window.location, 'assign').mockImplementation((href) => {
    redirects.push(String(href));
  });
  function Probe({ run }: { run?: () => void }) {
    run?.();
    return null;
  }
  const tree = (beforeCommit?: () => void) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <CurrentViewerProgressIndexPage loader={loader} requested={requested} />
          <Probe run={beforeCommit} />
        </RouterContextProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const show = (beforeCommit?: () => void) => tick(() => root.render(tree(beforeCommit)));
  await show();
  const picker = (version = false) =>
    pickers.findLast((item) => item.label === (version ? m.library_progress_version() : m.library_progress_subject()))!;
  const select = (kind: Exclude<Kind, 'start'>) =>
    menus.findLast(
      (entry) => entry.label === (kind === 'complete' ? m.library_progress_complete() : m.library_progress_abandon()),
    )!.onSelect;
  const callback = (kind: Kind) =>
    kind === 'start'
      ? formCallback(host as unknown as HTMLDivElement)
      : buttons.findLast(
          (item) =>
            item.children ===
            (kind === 'complete' ? m.library_progress_confirm_complete() : m.library_progress_confirm_abandon()),
        )!.onClick!;
  const prepare = async (kind: Kind) => {
    if (kind !== 'start') await tick(select(kind));
    return callback(kind);
  };
  const indexQuery = () =>
    client
      .getQueryCache()
      .findAll({ queryKey: ['library', 'progress', 'current-viewer'] })
      .at(-1)!;
  return {
    client,
    host,
    show,
    redirects,
    picker,
    prepare,
    callback,
    select,
    indexQuery,
    start: async (kind: Kind) => {
      const submit = await prepare(kind);
      await tick(() => {
        submit();
        submit();
      });
      return writes.at(-1)!;
    },
    deliver: (value: CurrentViewerProgressIndex) => tick(() => client.setQueryData(indexQuery().queryKey, value)),
    address: async (value: typeof requested, beforeCommit?: () => void) => {
      requested = value;
      await show(beforeCommit);
    },
    loader: async (value: CurrentViewerProgressIndex) => {
      loader = value;
      await show();
    },
    close: async () => {
      await tick(() => root.unmount());
      host.remove();
      redirect.mockRestore();
      client.clear();
    },
  };
}

test('actual cache viewer, credential, error and admission ABA retire retained search, choice, start and finish before commit', async () => {
  for (const boundary of [
    'viewer',
    'credential',
    'signed-out',
    'unknown',
    'session-removed',
    'exposure-removed',
    'session-error',
    'exposure-error',
    'list',
    'create',
    'complete',
    'abandon',
  ] as const) {
    const h = await mount();
    try {
      const start = h.callback('start');
      const finish = await h.prepare(boundary === 'abandon' ? 'abandon' : 'complete');
      const picker = h.picker();
      const before = h.host.textContent;
      const read = h.indexQuery().options.queryFn as () => Promise<unknown>;
      const fetcher = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ subjects: [], types: {} }));
      try {
        await tick(async () => {
          if (boundary === 'viewer') h.client.setQueryData(sessionQuery.queryKey, viewer('B'));
          else if (boundary === 'credential') h.client.setQueryData(sessionQuery.queryKey, viewer('A', ''));
          else if (boundary === 'signed-out' || boundary === 'unknown')
            h.client.setQueryData(sessionQuery.queryKey, { state: boundary, subject: null, csrfToken: null });
          else if (boundary.endsWith('removed'))
            h.client.removeQueries({
              queryKey: boundary === 'session-removed' ? sessionQuery.queryKey : exposureQuery.queryKey,
            });
          else if (boundary.endsWith('error'))
            h.client
              .getQueryCache()
              .find({ queryKey: boundary === 'session-error' ? sessionQuery.queryKey : exposureQuery.queryKey })!
              .setState({ status: 'error', error: new Error('observed failure') });
          else
            h.client.setQueryData(
              exposureQuery.queryKey,
              operations.filter((op) => op !== `progress_session.${boundary}`),
            );
          h.client.setQueryData(sessionQuery.queryKey, viewer());
          h.client.setQueryData(exposureQuery.queryKey, operations);
          expect(h.host.textContent).toBe(before); // Notifications have not committed.
          if (boundary !== 'complete' && boundary !== 'abandon') {
            start();
            picker.onValueChange?.([]);
            if (boundary !== 'create') finish();
            await expect(picker.search('public', new AbortController().signal)).rejects.toThrow('retired');
            if (boundary !== 'create') await expect(read()).rejects.toThrow('retired');
          }
          if (boundary === 'complete' || boundary === 'abandon') finish();
        });
        expect(fetcher).not.toHaveBeenCalled();
        expect(writes).toHaveLength(0);
        expect(choices).toHaveLength(0);
      } finally {
        fetcher.mockRestore();
      }
      // A rendered address replacement must retire the old callback even before layout runs.
      const stale = h.host.querySelector('form') ? h.callback('start') : start;
      await h.address({ subjectId: id(2), cursor: 'other/address' }, () => stale());
      expect(writes).toHaveLength(0);
    } finally {
      await h.close();
    }
  }
});

test('late A read, choice, native outcome and finally cannot mutate or unlock usable B', async () => {
  for (const kind of ['start', 'complete', 'abandon'] as const) {
    const h = await mount();
    try {
      const oldChoice = h.picker().onValueChange!;
      await tick(() => {
        void h.client.invalidateQueries({ queryKey: h.indexQuery().queryKey });
      });
      const oldRead = reads.at(-1)!;
      const old = await h.start(kind);
      await tick(() => h.client.setQueryData(sessionQuery.queryKey, viewer('B')));
      const bRead = reads.at(-1)!;
      await tick(() => bRead.work.resolve(envelope('B')));
      const current = await h.start(kind);
      expect(current.headers).toEqual({ 'x-csrf-token': 'B-credential' });
      await tick(() => {
        oldRead.work.resolve(envelope('A'));
        if (kind === 'start') old.work.resolve({ ok: true, id: id(99) });
        else if (kind === 'complete') old.work.resolve({ ok: false, reason: 'forbidden' });
        else old.work.reject(new Error('late A'));
        oldChoice([]);
      });
      expect(h.host.textContent).toContain('Private B');
      expect(h.host.textContent).not.toContain('Private A');
      expect(h.host.querySelector('[role="alert"]')).toBeNull();
      expect(h.redirects).toEqual([]);
      await tick(h.callback(kind));
      expect(writes).toHaveLength(2); // A's finally cannot release B.
      await tick(() => current.work.resolve({ ok: false, reason: 'unavailable' }));
      await tick(h.callback(kind));
      expect(writes[2]!.data).toEqual(current.data);
      // Retire an actual choice completion while the next viewer's choices remain pending.
      await tick(() => h.client.setQueryData(sessionQuery.queryKey, viewer('C')));
      await tick(() => reads.at(-1)!.work.resolve(envelope('C')));
      await tick(() =>
        h
          .picker()
          .onValueChange?.([
            { id: id(3), types: ['schema:Book'], title: 'C selected', typeLabel: 'Book', cover: null },
          ]),
      );
      const cChoice = choices.at(-1)!;
      await tick(() => h.client.setQueryData(sessionQuery.queryKey, viewer('D')));
      await tick(() => reads.at(-1)!.work.resolve(envelope('D')));
      await tick(() =>
        h
          .picker()
          .onValueChange?.([
            { id: id(4), types: ['schema:Book'], title: 'D selected', typeLabel: 'Book', cover: null },
          ]),
      );
      const dChoice = choices.at(-1)!;
      await tick(() => cChoice.work.resolve(profile));
      expect(h.host.querySelector('form')).toBeNull();
      expect(h.host.querySelector('[role="alert"]')).toBeNull();
      await tick(() => dChoice.work.resolve(profile));
      expect(h.host.querySelector('form')).not.toBeNull();
      const staleFinish = await h.prepare(kind === 'abandon' ? 'abandon' : 'complete');
      const stable = h.indexQuery().state.data as CurrentViewerProgressIndex;
      const changed = structuredClone(stable);
      changed.page.sessions[0]!.revision++;
      const count = writes.length;
      await tick(() => {
        h.client.setQueryData(h.indexQuery().queryKey, changed);
        h.client.setQueryData(h.indexQuery().queryKey, stable);
        staleFinish(); // A native row ABA must retire even before a row render.
      });
      expect(writes).toHaveLength(count);
      expect(h.host.querySelector('form')).not.toBeNull(); // Independent creation draft survives.
      const freshFinish = await h.start(kind === 'abandon' ? 'abandon' : 'complete');
      expect(freshFinish.data).toMatchObject({ sessionId: id(20), revision: 7 });
    } finally {
      await h.close();
    }
  }
});

test('wrong viewer, request, locale and empty-page provenance retire callbacks without replay; genuine empty success remains usable', async () => {
  for (const wrong of [
    (value: CurrentViewerProgressIndex) => ({ ...value, viewer: 'B' }),
    (value: CurrentViewerProgressIndex) => ({ ...value, requested: { ...value.requested, subjectId: id(9) } }),
    (value: CurrentViewerProgressIndex) => ({ ...value, requested: { ...value.requested, cursor: 'wrong' } }),
    (value: CurrentViewerProgressIndex) => ({ ...value, locale: 'de' }),
    (value: CurrentViewerProgressIndex) => ({ ...value, page: { ...value.page, subjectId: id(9) } }),
    (value: CurrentViewerProgressIndex) => ({ ...value, viewer: null, page: { ...value.page, sessions: [] } }),
  ]) {
    const h = await mount();
    try {
      const stale = h.callback('start');
      const valid = envelope();
      await tick(() => {
        h.client.setQueryData(h.indexQuery().queryKey, wrong(valid));
        stale();
      });
      expect(writes).toHaveLength(0);
      expect(h.host.querySelector('form, a')).toBeNull();
      expect(reads).toHaveLength(0);
      await h.deliver({ ...valid, page: { ...valid.page, sessions: [] } });
      expect(h.host.textContent).not.toContain('3 / 100');
      const current = await h.start('start');
      expect(current.data).toMatchObject({ subjectId: id(1) });
      await tick(() => stale());
      expect(writes).toHaveLength(1);
    } finally {
      await h.close();
    }
  }
});

test('each action can retire independently while the index and separately admitted actions remain usable', async () => {
  for (const lost of ['create', 'complete', 'abandon'] as const) {
    const h = await mount();
    try {
      const retired = lost === 'create' ? h.callback('start') : await h.prepare(lost);
      await tick(() => {
        h.client.setQueryData(
          exposureQuery.queryKey,
          operations.filter((op) => op !== `progress_session.${lost}`),
        );
        retired();
      });
      expect(writes).toHaveLength(0);
      expect(reads).toHaveLength(0);
      expect(h.host.textContent).toContain('Private A');
      const independent = await h.start(lost === 'complete' ? 'abandon' : 'complete');
      expect(independent.kind).toBe(lost === 'complete' ? 'abandon' : 'complete');
      await tick(() => independent.work.resolve({ ok: false, reason: 'unavailable' }));
      await tick(() => h.client.setQueryData(exposureQuery.queryKey, operations));
      await tick(() => retired());
      expect(writes).toHaveLength(1);
    } finally {
      await h.close();
    }
  }
});

test('healthy same-viewer rotation and equivalent refresh retain exact uncertain mode, edition, total, CAS and key', async () => {
  for (const kind of ['start', 'complete', 'abandon'] as const)
    for (const mode of kind === 'start'
      ? (['scalar_amount', 'cursor_position', 'completed_units'] as const)
      : (['scalar_amount'] as const)) {
      const h = await mount();
      try {
        if (kind === 'start') {
          await tick(() =>
            h
              .picker(true)
              .onValueChange?.([
                { id: id(5), types: ['schema:Book'], title: 'Selected edition', typeLabel: 'Book', cover: null },
              ]),
          );
          await tick(() => modes.at(-1)!.onValueChange(mode));
          if (mode !== 'completed_units')
            await tick(() => {
              const input = h.host.querySelector('[name="total"]')!;
              const props = Object.entries(input).find(([key]) => key.startsWith('__reactProps$'))![1] as {
                onChange: (event: { target: { value: string } }) => void;
              };
              props.onChange({ target: { value: '0' } });
            });
        }
        const first = await h.start(kind);
        const exact = structuredClone(first.data);
        await tick(() => h.client.setQueryData(sessionQuery.queryKey, viewer('A', 'rotated')));
        const refreshed = envelope();
        await h.deliver(refreshed);
        await h.loader(structuredClone(refreshed));
        expect(writes).toHaveLength(1);
        await tick(() => first.work.reject(new Error('unknown commit')));
        await tick(() => h.client.setQueryData(sessionQuery.queryKey, viewer('A', 'current')));
        await tick(h.callback(kind));
        const retry = writes[1]!;
        const retainedSubmit = h.callback(kind);
        expect(retry.data).toEqual(exact);
        expect(retry.headers).toBe(first.headers);
        if (kind === 'start') {
          expect(exact).toEqual({
            subjectId: id(1),
            versionSubjectId: id(5),
            mode,
            unit: mode === 'scalar_amount' ? 'page' : mode === 'cursor_position' ? 'position' : 'track',
            idempotencyKey: exact.idempotencyKey,
            ...(mode === 'completed_units' ? {} : { total: '0' }),
          });
          await tick(async () => {
            retry.work.resolve({ ok: true, id: id(90) });
            await Promise.resolve();
            retainedSubmit();
            expect(writes).toHaveLength(2);
          });
          expect(h.redirects).toHaveLength(1);
          expect(h.redirects[0]).toContain(`/library/progress/${id(90)}`);
        } else {
          expect(exact).toEqual({ sessionId: id(20), revision: 7, action: kind, idempotencyKey: exact.idempotencyKey });
          await tick(async () => {
            retry.work.resolve({
              ok: true,
              session: {
                ...refreshed.page.sessions[0]!,
                revision: 8,
                state: kind === 'complete' ? 'completed' : 'abandoned',
              },
            });
            await Promise.resolve();
            retainedSubmit();
            expect(writes).toHaveLength(2);
          });
          expect(h.host.textContent).toContain(
            kind === 'complete' ? m.library_progress_state_completed() : m.library_progress_state_abandoned(),
          );
          expect(h.host.querySelector('[role="alert"]')).toBeNull();
          await tick(h.callback(kind));
          expect(writes).toHaveLength(2); // Retained successful confirmation cannot redispatch.
        }
      } finally {
        await h.close();
      }
    }
});

test('public suggestion requests fence both response and decode continuations on actual cache retirement', async () => {
  for (const phase of ['response', 'decode'] as const) {
    const h = await mount();
    const response = deferred<Response>();
    const decoded = deferred<{ subjects: []; types: {} }>();
    const json = mock(() => decoded.promise);
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation(() => response.promise);
    try {
      const search = h.picker().search('public subject', new AbortController().signal);
      const outcome = search.then(
        () => 'accepted',
        () => 'retired',
      );
      if (phase === 'decode') await tick(() => response.resolve(Object.assign(new Response(), { json })));
      await tick(() => {
        h.client.setQueryData(sessionQuery.queryKey, viewer('B'));
        h.client.setQueryData(sessionQuery.queryKey, viewer());
      });
      if (phase === 'response') await tick(() => response.resolve(Object.assign(new Response(), { json })));
      else await tick(() => decoded.resolve({ subjects: [], types: {} }));
      expect(await outcome).toBe('retired');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(json).toHaveBeenCalledTimes(phase === 'decode' ? 1 : 0);
      expect(String(fetcher.mock.calls[0]![0])).toBe('/api/search/suggestions?q=public%20subject&locale=en');
    } finally {
      fetcher.mockRestore();
      await h.close();
    }
  }
});
