import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, Fragment, StrictMode, type ReactNode } from 'react';
import type {
  ProgressFailure,
  ProgressFinishInput,
  ProgressIndex,
  ProgressRecorded,
  ProgressStartInput,
  ProgressStarted,
} from '../src/library/progress-reads';
import type { ProgressChoices } from '../src/library/progress-profile';

// UNRUN: mounted UI regressions for controller execution; no native or browser evidence.
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
type Kind = 'start' | 'complete' | 'abandon';
type Result = ProgressStarted | ProgressRecorded | ProgressFailure;
const commands: {
  kind: Kind;
  data: ProgressStartInput | ProgressFinishInput;
  headers: unknown;
  work: ReturnType<typeof deferred<Result>>;
}[] = [];
const lookups: { data: string; work: ReturnType<typeof deferred<ProgressChoices>> }[] = [];
function command(kind: Kind, input: { data: ProgressStartInput | ProgressFinishInput; headers?: unknown }) {
  const work = deferred<Result>();
  commands.push({ kind, ...input, headers: input.headers, work });
  return work.promise;
}
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': 'csrf' }) }));
// Substitute admission and transports; exercise the shipped forms, picker, menu and router.
mock.module('../src/kernel/exposure', () => ({
  useOperation: () => true,
  Exposure: ({ children }: { children: ReactNode }) => <Fragment>{children}</Fragment>,
}));
mock.module('../src/library/progress-server', () => ({
  startProgressSession: (input: { data: ProgressStartInput }) => command('start', input),
  finishProgressSession: (input: { data: ProgressFinishInput }) => command(input.data.action, input),
  readProgressChoices: ({ data }: { data: string }) => {
    const work = deferred<ProgressChoices>();
    lookups.push({ data, work });
    return work.promise;
  },
}));
const { createRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { within, userEvent } = await import('storybook/test');
const { ProgressIndexPage } = await import('../src/library/progress-page');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
const id = (n: number) => `019a1b2c-3d4e-7f00-8a00-${String(n).padStart(12, '0')}`;
const choices: ProgressChoices = [
  {
    mode: 'scalar_amount',
    units: [
      { id: 'pages', label: 'pages', step: '1', total: 'optional' },
      { id: 'chapters', label: 'chapters', step: '1', total: 'required' },
    ],
  },
  { mode: 'cursor_position', units: [{ id: 'position', label: 'position', step: 'any', total: 'optional' }] },
  { mode: 'completed_units', units: [{ id: 'track', label: 'tracks', step: '1', total: 'forbidden' }] },
];
const subject = (n: number) => ({
  id: id(n),
  type: `type-${n}`,
  types: [`type-${n}`],
  label: `Subject ${n}`,
  cover: null,
});
function page(n = 1): ProgressIndex {
  return {
    signedIn: true,
    subjectId: id(n),
    selectedSubject: subject(n),
    progressChoices: choices,
    next: 'next:opaque/==',
    idempotencyKey: crypto.randomUUID(),
    sessions: [
      {
        id: id(20),
        subjectId: id(n),
        versionSubjectId: null,
        subject: subject(n),
        versionSubject: null,
        mode: 'scalar_amount',
        unit: 'pages',
        unitLabel: 'pages',
        total: '100',
        amount: String(n),
        locator: null,
        position: null,
        completedUnitCount: 0,
        state: 'active',
        revision: 7,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: null,
      },
    ],
  };
}
function success(p: ProgressIndex, kind: Kind): Result {
  if (kind === 'start') return { ok: true, id: id(90) };
  const { id: sessionId, revision, total, amount, locator, position, completedUnitCount } = p.sessions[0]!;
  return {
    ok: true,
    session: {
      id: sessionId,
      revision: revision + 1,
      total,
      amount,
      locator,
      position,
      completedUnitCount,
      state: kind === 'complete' ? 'completed' : 'abandoned',
      completedAt: '2026-01-02T00:00:00Z',
    },
  };
}
async function settle(action: () => void) {
  await act(async () => {
    action();
  });
}
async function mount(initial = page()) {
  commands.length = lookups.length = 0;
  const redirects: string[] = [];
  const redirect = spyOn(window.location, 'assign').mockImplementation((href) => {
    redirects.push(String(href));
  });
  const uuid = spyOn(crypto, 'randomUUID');
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const query = new URL(String(input), window.location.href).searchParams.get('q');
    const n = Number(query?.replace('Subject ', ''));
    return Response.json({
      subjects: [{ id: id(n), type: `type-${n}`, labels: { en: `Subject ${n}` }, summary: null, facts: [] }],
      types: {},
    });
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library/progress'] }),
  });
  await router.load();
  const tree = (p: ProgressIndex | null) => (
    <StrictMode>
      <RouterContextProvider router={router}>{p && <ProgressIndexPage page={p} />}</RouterContextProvider>
    </StrictMode>
  );
  const show = (p: ProgressIndex | null) => settle(() => root.render(tree(p)));
  const body = within(window.document.body as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document as unknown as Document });
  const form = () => host.querySelector('form')!;
  const key = () => form().querySelector<HTMLInputElement>('[name="idempotencyKey"]')!.value;
  const total = () => body.getByRole('textbox', { name: m.library_progress_total() }) as HTMLInputElement;
  const beforeUnload = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const click = async (name: string) =>
    act(async () => {
      await user.click(body.getByRole('button', { name, exact: true }));
    });
  const confirmLabel = (kind: Exclude<Kind, 'start'>) =>
    kind === 'complete' ? m.library_progress_confirm_complete() : m.library_progress_confirm_abandon();
  const submit = async (kind: Kind, count = 1) =>
    settle(() => {
      // Two events in one React batch catch duplicates before disabled state has rendered.
      for (let i = 0; i < count; i++) {
        if (kind === 'start') form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        else body.getByRole('button', { name: confirmLabel(kind), exact: true }).click();
      }
    });
  const start = async (kind: Kind) => {
    if (kind !== 'start') {
      await click(m.library_collection_actions());
      await act(async () => {
        await user.click(
          body.getByRole('menuitem', {
            name: kind === 'complete' ? m.library_progress_complete() : m.library_progress_abandon(),
            exact: true,
          }),
        );
      });
    }
    await submit(kind, 2);
    return commands.at(-1)!;
  };
  const pick = async (n: number, label = m.library_progress_subject()) => {
    const input = body.getByRole('combobox', { name: label, exact: true });
    await act(async () => {
      await user.clear(input);
      await user.type(input, `Subject ${n}`);
    });
    // Let the picker's ordinary debounce and transport settle inside React's act boundary.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await act(async () => {
      await user.click(body.getByRole('option', { name: `Subject ${n}`, exact: true }));
    });
  };
  await show(initial);
  return {
    host,
    body,
    user,
    show,
    key,
    total,
    beforeUnload,
    click,
    submit,
    start,
    pick,
    redirects,
    uuid,
    ssr: () => renderToString(tree(initial)),
    close: async () => {
      await settle(() => root.unmount());
      host.remove();
      redirect.mockRestore();
      uuid.mockRestore();
      fetcher.mockRestore();
    },
  };
}

test('Old progress creation cannot redirect a replacement page and old row completion cannot replace fresh loader state', async () => {
  for (const kind of ['start', 'complete', 'abandon'] as const)
    for (const outcome of ['success', 'failure', 'reject']) {
      const original = page();
      const h = await mount(original);
      try {
        const old = await h.start(kind);
        expect(commands).toHaveLength(1);
        const replacement = page(9); // Same session ID AND revision preserves the existing row component.
        await h.show(replacement);
        expect(h.key()).toBe(replacement.idempotencyKey);
        expect(h.body.queryByRole('alert')).toBeNull();
        const current = await h.start(kind); // Old pending work cannot block the replacement page.
        expect(commands).toHaveLength(2);
        expect(current.data).toMatchObject(
          kind === 'start'
            ? { subjectId: replacement.subjectId, idempotencyKey: replacement.idempotencyKey }
            : { sessionId: replacement.sessions[0]!.id, revision: 7, action: kind },
        );
        const rotations = h.uuid.mock.calls.length;
        await settle(() =>
          outcome === 'reject'
            ? old.work.reject(new Error('old connection'))
            : old.work.resolve(outcome === 'success' ? success(original, kind) : { ok: false, reason: 'forbidden' }),
        );
        expect(h.redirects).toEqual([]);
        expect(h.uuid.mock.calls).toHaveLength(rotations);
        expect(h.key()).toBe(replacement.idempotencyKey);
        expect(h.host.textContent).toContain('9 / 100 pages');
        expect(h.host.textContent).toContain(m.library_progress_state_active());
        expect(h.body.queryByRole('alert')).toBeNull();
        expect(
          h.body
            .getByRole('button', {
              name:
                kind === 'start'
                  ? m.library_progress_start()
                  : kind === 'complete'
                    ? m.library_progress_confirm_complete()
                    : m.library_progress_confirm_abandon(),
            })
            .hasAttribute('disabled'),
        ).toBe(true);
        await h.submit(kind);
        expect(commands).toHaveLength(2); // Old finally cannot clear newer pending or close its confirmation.
        await settle(() => current.work.resolve({ ok: false, reason: 'conflict' }));
        await h.submit(kind);
        expect(commands[2]!.data).toEqual(current.data); // No stale revision/key or automatic replay.
      } finally {
        await h.close();
      }
    }
});

test('Unmount retires creation, row completion and subject lookups before late continuations', async () => {
  for (const kind of ['start', 'complete', 'abandon'] as const)
    for (const outcome of ['success', 'failure', 'reject']) {
      const original = page();
      const h = await mount(original);
      try {
        const old = await h.start(kind);
        await h.show(null);
        const rotations = h.uuid.mock.calls.length;
        await settle(() =>
          outcome === 'reject'
            ? old.work.reject(new Error('unmounted'))
            : old.work.resolve(outcome === 'success' ? success(original, kind) : { ok: false, reason: 'closed' }),
        );
        expect(h.redirects).toEqual([]);
        expect(h.uuid.mock.calls).toHaveLength(rotations);
        expect(h.host.textContent).toBe('');
        await h.show(page(2));
        await h.pick(3);
        const lookup = lookups.at(-1)!;
        await h.show(null);
        await settle(() =>
          outcome === 'reject'
            ? lookup.work.reject(new Error('unmounted lookup'))
            : lookup.work.resolve(outcome === 'success' ? choices : undefined),
        );
        const replacement = page(4);
        await h.show(replacement);
        const current = await h.start('start');
        expect(current.data).toMatchObject({
          subjectId: replacement.subjectId,
          idempotencyKey: replacement.idempotencyKey,
        });
      } finally {
        await h.close();
      }
    }
}, 30_000);

test('Subject choices keep the latest selection and isolate replacement-page success, error and finally', async () => {
  for (const boundary of ['selection', 'replacement'])
    for (const outcome of ['success', 'failure', 'reject'])
      for (const oldFirst of [true, false]) {
        const h = await mount();
        try {
          await h.pick(2);
          const old = lookups.at(-1)!;
          if (boundary === 'replacement') await h.show(page(3));
          await h.pick(4);
          const current = lookups.at(-1)!;
          expect(lookups.map((lookup) => lookup.data)).toEqual(['type-2', 'type-4']);
          const resolveOld = () =>
            settle(() =>
              outcome === 'reject'
                ? old.work.reject(new Error('old choices'))
                : old.work.resolve(outcome === 'success' ? choices : undefined),
            );
          if (oldFirst) {
            await resolveOld();
            expect(h.host.querySelector('form')).toBeNull(); // Old finally must not end the new lookup.
            expect(h.body.queryByRole('alert')).toBeNull();
          }
          await settle(() => current.work.resolve([choices![1]!]));
          if (!oldFirst) await resolveOld();
          expect(h.body.queryByRole('alert')).toBeNull();
          expect((h.body.getByRole('combobox', { name: m.library_progress_unit() }) as HTMLSelectElement).value).toBe(
            'position',
          );
          const command = await h.start('start');
          expect(command.data).toMatchObject({ subjectId: id(4), mode: 'cursor_position', unit: 'position' });
        } finally {
          await h.close();
        }
      }
}, 30_000);

test('Current-page creation preserves native subject/version, modes, totals, retry keys and redirect', async () => {
  for (const mode of ['scalar_amount', 'cursor_position', 'completed_units'] as const) {
    const initial = page();
    const h = await mount(initial);
    try {
      expect(h.ssr()).toContain('Subject 1'); // Valid loader HTML survives an initially unknown client session.
      const more = h.body.getByRole('link', { name: m.library_progress_more(), exact: true });
      expect(more.getAttribute('href')).toContain(encodeURIComponent(initial.next!));
      await h.pick(5, m.library_progress_version());
      expect(lookups).toHaveLength(0); // A version does not change the subject's accepting profile.
      const modeLabel =
        mode === 'scalar_amount'
          ? m.library_progress_mode_amount()
          : mode === 'cursor_position'
            ? m.library_progress_mode_cursor()
            : m.library_progress_mode_units();
      await act(async () => {
        await h.user.click(h.body.getByRole('radio', { name: modeLabel, exact: true }));
      });
      if (mode === 'scalar_amount')
        await act(async () => {
          await h.user.selectOptions(h.body.getByRole('combobox', { name: m.library_progress_unit() }), 'chapters');
        });
      if (mode === 'scalar_amount')
        await act(async () => {
          await h.user.type(h.total(), '0');
        });
      else expect(h.body.queryByRole('textbox', { name: m.library_progress_total() })).toBeNull();
      await h.show(initial); // Ordinary rerenders retain drafts, chosen version and key.
      const old = await h.start('start');
      expect(commands).toHaveLength(1);
      const intent = {
        subjectId: initial.subjectId,
        versionSubjectId: id(5),
        mode,
        unit: mode === 'scalar_amount' ? 'chapters' : mode === 'cursor_position' ? 'position' : 'track',
        idempotencyKey: initial.idempotencyKey,
        ...(mode === 'scalar_amount' ? { total: '0' } : {}),
      };
      expect(old.data).toEqual(intent);
      expect(old.headers).toEqual({ 'x-csrf-token': 'csrf' });
      await settle(() => old.work.reject(new Error('unknown commit')));
      expect(h.key()).toBe(initial.idempotencyKey);
      expect(commands).toHaveLength(1);
      expect(h.body.getByRole('alert').textContent).toBe(m.library_progress_unavailable());
      await h.submit('start');
      expect(commands[1]!.data).toEqual(intent);
      await settle(() => commands[1]!.work.resolve({ ok: false, reason: 'unsupported_library_profile' }));
      expect(h.key()).toBe(initial.idempotencyKey);
      expect(h.body.getByRole('alert').textContent).toBe(m.library_progress_unsupported());
      await h.submit('start');
      expect(commands[2]!.data).toEqual(intent);
      await settle(() => commands[2]!.work.resolve(success(initial, 'start')));
      expect(h.key()).not.toBe(initial.idempotencyKey);
      expect(h.redirects).toHaveLength(1);
      expect(h.redirects[0]).toContain(`/library/progress/${id(90)}`);
      expect(h.beforeUnload()).toBe(false);
    } finally {
      await h.close();
    }
  }
});

test('Progress setup protects changed values, keeps them on Stay and discards them without starting a session', async () => {
  const h = await mount(page());
  try {
    expect(h.beforeUnload()).toBe(false); // Loaded subject and default mode/unit are the baseline.
    await act(async () => h.user.type(h.total(), '1.2'));
    expect(h.beforeUnload()).toBe(true); // Invalid step text is still an edit worth keeping.
    await act(async () => h.user.clear(h.total()));
    expect(h.beforeUnload()).toBe(false); // Reverting to the exact baseline leaves normally.

    await h.pick(5, m.library_progress_version());
    await act(async () => h.user.type(h.total(), '1.2'));
    await act(async () => h.user.click(h.body.getByRole('link', { name: m.library_progress_more(), exact: true })));
    expect(h.body.getByRole('alertdialog').textContent).toContain(m.library_progress_start_draft_navigation_title());
    await h.click(m.thread_authoring_stay());
    expect(h.total().value).toBe('1.2');
    expect(h.host.textContent).toContain('Subject 5');
    expect(h.beforeUnload()).toBe(true);

    await act(async () => h.user.click(h.body.getByRole('link', { name: m.library_progress_more(), exact: true })));
    await h.click(m.library_progress_start_draft_navigation_discard());
    expect(h.body.queryByRole('alertdialog')).toBeNull();
    expect(commands).toHaveLength(0); // Leaving a draft never creates, completes or abandons a session.
    expect(h.beforeUnload()).toBe(false);
  } finally {
    await h.close();
  }
});

test('Current row complete and abandon keep native CAS and uncertain keys, then update only on success', async () => {
  for (const kind of ['complete', 'abandon'] as const) {
    const initial = page();
    const h = await mount(initial);
    try {
      const old = await h.start(kind);
      expect(commands).toHaveLength(1);
      expect(old.data).toEqual({
        sessionId: initial.sessions[0]!.id,
        revision: 7,
        idempotencyKey: old.data.idempotencyKey,
        action: kind,
      });
      expect(old.headers).toEqual({ 'x-csrf-token': 'csrf' });
      await settle(() => old.work.resolve({ ok: false, reason: 'conflict' }));
      expect(h.body.getByRole('alert').textContent).toBe(m.library_progress_conflict());
      await h.show(initial);
      await h.submit(kind);
      expect(commands[1]!.data).toEqual(old.data);
      await settle(() => commands[1]!.work.reject(new Error('unknown commit')));
      await h.submit(kind);
      expect(commands[2]!.data).toEqual(old.data);
      const rotations = h.uuid.mock.calls.length;
      await settle(() => commands[2]!.work.resolve(success(initial, kind)));
      expect(h.uuid.mock.calls).toHaveLength(rotations + 1);
      expect(h.body.queryByRole('alert')).toBeNull();
      expect(h.host.textContent).toContain(
        kind === 'complete' ? m.library_progress_state_completed() : m.library_progress_state_abandoned(),
      );
      expect(
        h.body.queryByRole('button', {
          name: kind === 'complete' ? m.library_progress_confirm_complete() : m.library_progress_confirm_abandon(),
        }),
      ).toBeNull();
    } finally {
      await h.close();
    }
  }
});

test('start validates required fixed decimals before capture, omits empty optional totals and retries original operands', async () => {
  for (const policy of ['required', 'optional', 'forbidden'] as const) {
    const initial = page();
    initial.progressChoices = [
      {
        mode: 'scalar_amount',
        units: [
          {
            id: 'pages',
            label: 'pages',
            total: policy,
            min: '0.25',
            max: '999999999999.123456',
            step: '0.000001',
          },
        ],
      },
    ];
    const h = await mount(initial);
    const fill = async (value: string) =>
      act(async () => {
        await h.user.clear(h.total());
        if (value) await h.user.type(h.total(), value);
      });
    try {
      if (policy !== 'forbidden') {
        for (const invalid of [...(policy === 'required' ? [''] : []), '1e3', '0.249999', '999999999999.123457']) {
          await fill(invalid);
          await h.submit('start');
          expect(commands).toHaveLength(0);
          expect(h.total().value).toBe(invalid);
          expect(h.total().getAttribute('aria-invalid')).toBe('true');
          expect(
            window.document.getElementById(h.total().getAttribute('aria-describedby')!)?.getAttribute('role'),
          ).toBe('alert');
        }
        await fill(policy === 'required' ? '999999999999.123456' : '');
      }
      await h.submit('start');
      const original = commands[0]!;
      if (policy === 'required') expect(original.data).toHaveProperty('total', '999999999999.123456');
      else expect(original.data).not.toHaveProperty('total');
      await settle(() => original.work.resolve({ ok: false, reason: 'unavailable' }));
      if (policy !== 'forbidden') await fill('1e3');
      await h.submit('start');
      expect(commands[1]!.data).toEqual(original.data);
      expect(commands[1]!.headers).toEqual(original.headers);
      await settle(() => commands[1]!.work.resolve({ ok: false, reason: 'unavailable' }));
    } finally {
      await h.close();
    }
  }
});
