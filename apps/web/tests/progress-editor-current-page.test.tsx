import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, Fragment, StrictMode, type ReactNode } from 'react';
import type {
  ProgressFailure,
  ProgressFinishInput,
  ProgressRecorded,
  ProgressRecordInput,
  ProgressSessionPage as Page,
} from '../src/library/progress-reads';

// UNRUN: focused mounted-page regressions for controller execution, not native/transport evidence.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://rezics.test/en/library/progress', width: 1280, height: 900 });
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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Mutation = ProgressRecorded | ProgressFailure;
const commands: {
  kind: string;
  data: ProgressRecordInput | ProgressFinishInput;
  work: ReturnType<typeof deferred<Mutation>>;
}[] = [];
const histories: { data: { id: string; changes?: string; units?: string }; work: ReturnType<typeof deferred<Page>> }[] =
  [];
function command(kind: string, { data }: { data: ProgressRecordInput | ProgressFinishInput }) {
  const work = deferred<Mutation>();
  commands.push({ kind, data, work });
  return work.promise;
}
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': 'csrf' }) }));
// Grant exposure only; mount the real editor, router, forms, menu and dialog.
mock.module('../src/kernel/exposure', () => ({
  Exposure: ({ children }: { children: ReactNode }) => <Fragment>{children}</Fragment>,
}));
mock.module('../src/library/progress-server', () => ({
  recordProgressSession: (input: { data: ProgressRecordInput }) => command('record', input),
  finishProgressSession: (input: { data: ProgressFinishInput }) => command('finish', input),
  readProgressSession: ({ data }: { data: (typeof histories)[number]['data'] }) => {
    const work = deferred<Page>();
    histories.push({ data, work });
    return work.promise;
  },
}));
const { createRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { within, userEvent } = await import('storybook/test');
const { ProgressSessionPage } = await import('../src/library/progress-session');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
type LoadedPage = Extract<Page, { signedIn: true }>;
type Kind = 'record' | 'add' | 'remove' | 'finish';
function page(id = 'original', kind: Kind = 'record'): LoadedPage {
  return {
    signedIn: true,
    idempotencyKey: crypto.randomUUID(),
    changesCursor: 'changes:opaque/==',
    unitsCursor: 'units:opaque/==',
    session: {
      id,
      subjectId: `subject-${id}`,
      versionSubjectId: null,
      subject: { id: `subject-${id}`, type: 'book', types: ['book'], label: `Subject ${id}`, cover: null },
      versionSubject: null,
      mode: kind === 'add' || kind === 'remove' ? 'completed_units' : 'scalar_amount',
      unit: 'accepted-unit',
      unitLabel: 'pages',
      meaning: 'known',
      recordingState: 'supported',
      inputRules: { min: '0', max: '100', step: '0.01', total: 'optional' },
      total: '100',
      amount: '2.5',
      locator: null,
      position: null,
      completedUnitCount: 0,
      state: 'active',
      revision: 7,
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: null,
      changes: [],
      changesNext: null,
      units: [],
      unitsNext: null,
    },
  };
}
function success(p: LoadedPage): ProgressRecorded {
  const { id, amount, locator, position, completedUnitCount, state, completedAt, total } = p.session;
  return {
    ok: true,
    session: {
      id,
      amount,
      locator,
      position,
      completedUnitCount,
      state,
      completedAt,
      total,
      revision: p.session.revision + 1,
    },
  };
}
async function settle(action: () => void) {
  await act(async () => {
    action();
  });
}
async function mount(initial: LoadedPage) {
  commands.length = histories.length = 0;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  const tree = (p: Page | null) => (
    <StrictMode>
      <RouterContextProvider router={router}>
        {p && <ProgressSessionPage page={p} logsCursor="logs:independent/==" />}
      </RouterContextProvider>
    </StrictMode>
  );
  const show = async (p: Page | null) => settle(() => root.render(tree(p)));
  const body = within(window.document.body as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document as unknown as Document });
  const click = async (label: string) =>
    act(async () => {
      await user.click(body.getByRole('button', { name: label, exact: true }));
    });
  const dialog = () => body.getByRole('dialog');
  const field = (label: string) => within(dialog()).getByLabelText(label) as HTMLInputElement;
  const fill = async (label: string, value: string) =>
    act(async () => {
      await user.clear(field(label));
      await user.type(field(label), value);
    });
  const key = () => dialog().querySelector<HTMLInputElement>('[name="idempotencyKey"]')!.value;
  const submit = async (kind: Kind) => {
    await click(
      kind === 'finish'
        ? m.library_progress_confirm_complete()
        : kind === 'record'
          ? m.library_progress_record()
          : kind === 'add'
            ? m.library_progress_add_units()
            : m.library_progress_remove_units(),
    );
    if (kind !== 'finish' && body.queryByRole('button', { name: m.library_progress_confirm_correction() }))
      await click(m.library_progress_confirm_correction());
  };
  const start = async (kind: Kind) => {
    if (kind === 'finish') {
      await click(m.library_collection_actions());
      await act(async () => {
        await user.click(body.getByRole('menuitem', { name: m.library_progress_complete(), exact: true }));
      });
    } else {
      await click(m.library_progress_update());
      await fill(
        kind === 'record'
          ? m.library_progress_amount()
          : kind === 'add'
            ? m.library_progress_add_units()
            : m.library_progress_remove_units(),
        kind === 'record' ? '4.75' : 'part:1\npart~9',
      );
    }
    await submit(kind);
    return commands.at(-1)!;
  };
  const intact = (p: LoadedPage, kind: Kind) => {
    expect(host.textContent).toContain(`Subject ${p.session.id}`);
    expect(body.queryByRole('alert')).toBeNull();
    if (kind === 'finish')
      expect(body.getByRole('button', { name: m.library_progress_confirm_complete() })).toBeDefined();
    else {
      expect(key()).toBe(p.idempotencyKey);
      expect(
        field(
          kind === 'record'
            ? m.library_progress_amount()
            : kind === 'add'
              ? m.library_progress_add_units()
              : m.library_progress_remove_units(),
        ).value,
      ).toBe(kind === 'record' ? '4.75' : 'part:1\npart~9');
    }
  };
  await show(initial);
  return {
    host,
    body,
    show,
    click,
    dialog,
    field,
    fill,
    key,
    submit,
    start,
    intact,
    ssr: () => renderToString(tree(initial)),
    close: async () => {
      await settle(() => root.unmount());
      host.remove();
    },
  };
}

test('Late progress mutations and history responses cannot replace the newly loaded progress session or unlock its pending operation', async () => {
  const cases: [Kind, 'success' | 'reject' | ProgressFailure['reason']][] = [
    ['record', 'success'],
    ['record', 'forbidden'],
    ['record', 'reject'],
    ['add', 'success'],
    ['remove', 'unsupported_library_profile'],
    ['finish', 'success'],
    ['finish', 'closed'],
  ];
  for (const sameSession of [false, true])
    for (const [kind, outcome] of cases) {
      const original = page('original', kind);
      const h = await mount(original);
      try {
        const old = await h.start(kind);
        const replacement = page(sameSession ? 'original' : 'replacement', kind);
        replacement.session.revision = 23;
        await h.show(replacement);
        const current = await h.start(kind); // Usable while the old mutation is still unresolved.
        expect(current.data).toMatchObject({
          sessionId: replacement.session.id,
          revision: 23,
          idempotencyKey: replacement.idempotencyKey,
        });
        await settle(() =>
          outcome === 'reject'
            ? old.work.reject(new Error('old network failure'))
            : old.work.resolve(outcome === 'success' ? success(original) : { ok: false, reason: outcome }),
        );
        h.intact(replacement, kind);
        expect(histories).toHaveLength(0); // A retired success must not launch a history read.
        await h.submit(kind);
        expect(commands).toHaveLength(2); // Old finally must not unlock this pending command.
        await settle(() => current.work.resolve({ ok: false, reason: 'unavailable' }));
      } finally {
        await h.close();
      }
    }
}, 30_000);

test('history and post-history continuations retire on replacement, and unmount retires every mutation kind', async () => {
  for (const kind of ['record', 'add', 'finish'] as const) {
    const original = page('original', kind);
    const h = await mount(original);
    try {
      const old = await h.start(kind);
      await settle(() => old.work.resolve(success(original)));
      expect(histories).toHaveLength(1);
      const replacement = page('replacement', kind);
      await h.show(replacement);
      const current = await h.start(kind);
      await settle(() =>
        kind === 'record'
          ? histories[0]!.work.resolve(original)
          : kind === 'add'
            ? histories[0]!.work.reject(new Error('old history failure'))
            : histories[0]!.work.resolve({ signedIn: false, idempotencyKey: 'ignored' }),
      );
      h.intact(replacement, kind);
      await h.submit(kind);
      expect(commands).toHaveLength(2);
      await settle(() => current.work.resolve({ ok: false, reason: 'unavailable' }));
    } finally {
      await h.close();
    }

    for (const phase of ['mutation', 'history']) {
      const h = await mount(original);
      try {
        const old = await h.start(kind);
        if (phase === 'history') await settle(() => old.work.resolve(success(original)));
        await h.show(null); // Unmount SessionEditor without destroying the test root.
        if (phase === 'mutation') {
          await settle(() => old.work.resolve(success(original)));
          expect(histories).toHaveLength(0);
        } else await settle(() => histories[0]!.work.reject(new Error('unmounted history failure')));
        expect(h.host.textContent).toBe('');
        const replacement = page('remounted', kind);
        await h.show(replacement);
        const current = await h.start(kind);
        expect(current.data.idempotencyKey).toBe(replacement.idempotencyKey);
        await settle(() => current.work.resolve({ ok: false, reason: 'unavailable' }));
      } finally {
        await h.close();
      }
    }
  }
}, 30_000);

test('manual refresh is latest-request-wins for successes, refusals and thrown failures', async () => {
  for (const outcome of ['success', 'denied', 'error']) {
    const initial = page();
    initial.session.recordingState = 'unavailable';
    const h = await mount(initial);
    try {
      await h.click(m.library_progress_retry());
      await h.click(m.library_progress_retry());
      const latest = page('latest');
      await settle(() => histories[1]!.work.resolve(latest));
      await h.click(m.library_progress_update());
      await h.fill(m.library_progress_amount(), '4.75');
      await settle(() =>
        outcome === 'error'
          ? histories[0]!.work.reject(new Error('older refresh'))
          : histories[0]!.work.resolve(outcome === 'denied' ? { signedIn: false, idempotencyKey: 'ignored' } : initial),
      );
      expect(h.host.textContent).toContain('Subject latest');
      expect(h.field(m.library_progress_amount()).value).toBe('4.75');
      expect(h.body.queryByRole('alert')).toBeNull();
    } finally {
      await h.close();
    }
  }
});

test('same-page retries keep uncertain intent, successful saves refresh authoritative history and rotate only on success', async () => {
  const initial = page();
  const h = await mount(initial);
  try {
    expect(h.ssr()).toContain('Subject original');
    await h.click(m.library_progress_update());
    await h.fill(m.library_progress_amount(), '0');
    await h.submit('record');
    await h.submit('record');
    expect(commands).toHaveLength(1);
    const intent = { sessionId: initial.session.id, revision: 7, idempotencyKey: initial.idempotencyKey, amount: '0' };
    expect(commands[0]!.data).toEqual(intent);
    await settle(() => commands[0]!.work.reject(new Error('unknown commit outcome')));
    expect(h.field(m.library_progress_amount()).value).toBe('0');
    expect(h.key()).toBe(initial.idempotencyKey);
    expect(histories).toHaveLength(0);
    await h.submit('record');
    expect(commands[1]!.data).toEqual(intent);
    const recorded = success(initial);
    recorded.session.amount = '0';
    await settle(() => commands[1]!.work.resolve(recorded));
    expect(histories[0]!.data).toEqual({
      id: initial.session.id,
      changes: initial.changesCursor,
      units: initial.unitsCursor,
    });
    const rotated = h.key();
    expect(rotated).not.toBe(initial.idempotencyKey);
    await h.submit('record');
    expect(commands).toHaveLength(2); // Pending includes the authoritative refresh.
    const authoritative = {
      ...initial,
      session: { ...initial.session, ...recorded.session, units: ['authoritative-unit'] },
    };
    await settle(() => histories[0]!.work.resolve(authoritative));
    expect(h.body.queryByRole('dialog')).toBeNull();
    expect(h.host.textContent).toContain('authoritative-unit');
    await h.show(initial); // An ordinary rerender with the same loader object must not reset state.
    await h.click(m.library_progress_update());
    expect(h.key()).toBe(rotated);
    expect(h.field(m.library_progress_amount()).value).toBe('0');
    await h.fill(m.library_progress_amount(), '4.75');
    await h.submit('record');
    expect(commands[2]!.data).toEqual({ ...intent, revision: 8, idempotencyKey: rotated, amount: '4.75' });
    await settle(() => commands[2]!.work.resolve({ ok: false, reason: 'conflict' }));
    expect(h.key()).toBe(rotated);
    expect(h.field(m.library_progress_amount()).value).toBe('4.75');
  } finally {
    await h.close();
  }
});

test('correction review keeps a closed draft and recovers a conflict only after explicitly loading latest progress', async () => {
  const initial = page();
  const h = await mount(initial);
  try {
    await h.click(m.library_progress_update());
    await h.fill(m.library_progress_amount(), '0');
    await h.click(m.library_progress_record());
    expect(commands).toHaveLength(0);
    await h.click(m.library_progress_cancel());
    expect(h.field(m.library_progress_amount()).value).toBe('0');
    // Closing the dialog and reopening must preserve the deliberate zero.
    await act(async () => {
      h.dialog().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(h.body.queryByRole('dialog')).toBeNull();
    await h.click(m.library_progress_update());
    expect(h.field(m.library_progress_amount()).value).toBe('0');
    await h.submit('record');
    const original = commands[0]!.data;
    await settle(() => commands[0]!.work.resolve({ ok: false, reason: 'conflict' }));
    await h.click(m.library_progress_confirm_correction());
    expect(commands[1]!.data).toEqual(original);
    await settle(() => commands[1]!.work.resolve({ ok: false, reason: 'conflict' }));
    await h.click(m.library_progress_review_latest());
    await settle(() =>
      histories[0]!.work.resolve({ ...initial, session: { ...initial.session, amount: '25', revision: 10 } }),
    );
    expect(h.field(m.library_progress_amount()).value).toBe('0');
    await h.submit('record');
    expect(commands[2]!.data).toMatchObject({ amount: '0', revision: 10 });
    expect(commands[2]!.data.idempotencyKey).not.toBe(original.idempotencyKey);
  } finally {
    await h.close();
  }
});

test('clear confirms an unsupported finished session, retries its exact operands and refreshes saved facts', async () => {
  const initial = page();
  Object.assign(initial.session, {
    state: 'completed',
    completedAt: '2026-01-02T00:00:00Z',
    recordingState: 'unsupported',
  });
  const h = await mount(initial);
  try {
    await h.click(m.library_progress_clear());
    expect(commands).toHaveLength(0);
    expect(h.dialog().textContent).toContain(m.library_progress_clear_scope());
    await h.click(m.library_progress_confirm_clear());
    const original = commands[0]!.data;
    expect(original).toEqual({
      sessionId: initial.session.id,
      revision: 7,
      idempotencyKey: initial.idempotencyKey,
      clear: true,
    });
    await settle(() => commands[0]!.work.reject(new Error('response lost')));
    await h.click(m.library_progress_confirm_clear());
    expect(commands[1]!.data).toEqual(original);
    const cleared = success(initial);
    cleared.session.amount = null;
    await settle(() => commands[1]!.work.resolve(cleared));
    await settle(() => histories[0]!.work.resolve({ ...initial, session: { ...initial.session, ...cleared.session } }));
    expect(h.body.queryByRole('dialog')).toBeNull();
    expect(h.host.textContent).toContain(m.library_progress_state_completed());
    expect(histories[0]!.data.changes).toBe(initial.changesCursor);
  } finally {
    await h.close();
  }
});
