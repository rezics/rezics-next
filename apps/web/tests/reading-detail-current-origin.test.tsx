import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ReactNode } from 'react';
import type { ProgressDetail, ProgressDetailAddress } from '../src/library/progress-detail-server';
import type { ProgressRecorded, ProgressFailure } from '../src/library/progress-reads';
import type { PublishedLogCurrentRead, PublishedLogWriteResult } from '../src/library/logs-read';

// UNRUN: composed regressions for integration. Native, browser and original acceptance remain deferred.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/progress/session', width: 1280, height: 900 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
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
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
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
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const address: ProgressDetailAddress = {
  id: id(20),
  changes: 'changes/opaque+==',
  units: 'units/opaque+==',
  logs: 'logs/opaque+==',
};
const stamp = '2026-04-02T15:04:05.000Z';
const viewer = (subject: string | null = 'A', csrfToken: string | null = `${subject}-csrf`) => ({
  state: subject ? ('signed-in' as const) : ('signed-out' as const),
  subject,
  csrfToken,
});
let current = viewer();
function detail(owner = 'A', at = address, revision = 7): Extract<ProgressDetail, { state: 'ready' }> {
  return {
    state: 'ready',
    viewer: owner,
    address: { ...at },
    progress: {
      signedIn: true,
      idempotencyKey: crypto.randomUUID(),
      changesCursor: at.changes,
      unitsCursor: at.units,
      session: {
        id: at.id,
        subjectId: id(1),
        versionSubjectId: null,
        subject: { id: id(1), type: 'book', types: ['book'], label: `Private ${owner}`, cover: null },
        versionSubject: null,
        mode: 'scalar_amount',
        unit: 'page',
        unitLabel: 'pages',
        meaning: 'known',
        recordingState: 'supported',
        inputRules: { min: '0', max: '100', step: '0.01', total: 'optional' },
        total: '100',
        amount: '2.5',
        locator: null,
        position: null,
        completedUnitCount: 2,
        state: 'active',
        revision,
        startedAt: stamp,
        completedAt: null,
        units: ['part/2', 'part/9'],
        unitsNext: 'next-units',
        changes: [],
        changesNext: 'next-changes',
      },
    },
    logs: { signedIn: true, logs: [], next: 'next-logs' },
  };
}
function log(owner = 'A', requestedId = 'original', revision = 7): PublishedLogCurrentRead {
  return {
    requestedId,
    isOwner: true,
    revision,
    owner: { sessionSubject: owner, accountId: owner, id: requestedId, revision },
    log: {
      id: requestedId,
      sessionState: 'completed',
      startedAt: stamp,
      completedAt: stamp,
      publishedAt: stamp,
      note: `Public snapshot ${requestedId}`,
      subject: null,
      account: { handle: 'public-name', displayName: 'Public reader' },
    },
  };
}
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request(window.location.href),
  setResponseHeader: () => {},
}));
mock.module('../src/session/request', () => ({
  prepareSession: async () => undefined,
  sessionSubject: () => current.subject,
  viewerCredential: () => (current.subject ? `Bearer ${current.subject}` : null),
}));
let pauseExposure = false;
const exposures: ReturnType<typeof deferred<{ data: { admitted: string[] } }>>[] = [];
mock.module('../src/kernel/client', () => ({
  kernelClient: () => ({
    platform: {
      exposure: {
        get: async () => {
          if (!pauseExposure) return { data: { admitted: ['reading_progress'] } };
          const work = deferred<{ data: { admitted: string[] } }>();
          exposures.push(work);
          return work.promise;
        },
      },
    },
  }),
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': current.csrfToken ?? '' }) }));
const reads: { data: ProgressDetailAddress; work: ReturnType<typeof deferred<ProgressDetail>> }[] = [];
const owners: { data: { id: string }; work: ReturnType<typeof deferred<PublishedLogCurrentRead>> }[] = [];
const writes: {
  kind: string;
  data: Record<string, unknown>;
  headers: unknown;
  work: ReturnType<typeof deferred<ProgressRecorded | ProgressFailure | PublishedLogWriteResult>>;
}[] = [];
function command(kind: string, input: { data: Record<string, unknown>; headers?: unknown }) {
  const work = deferred<ProgressRecorded | ProgressFailure | PublishedLogWriteResult>();
  writes.push({ kind, data: structuredClone(input.data), headers: input.headers, work });
  return work.promise;
}
mock.module('../src/library/progress-detail-server', () => ({
  readProgressDetail: ({ data }: { data: ProgressDetailAddress }) => {
    const work = deferred<ProgressDetail>();
    reads.push({ data, work });
    return work.promise;
  },
}));
mock.module('../src/library/progress-server', () => ({
  recordProgressSession: (input: Parameters<typeof command>[1]) => command('record', input),
  finishProgressSession: (input: Parameters<typeof command>[1]) => command(String(input.data.action), input),
  readProgressSession: () => {
    throw new Error('The complete detail must use its same-reader provenance');
  },
}));
mock.module('../src/library/logs-server', () => ({
  publishProgressLog: (input: Parameters<typeof command>[1]) => command('publish', input),
  removePublishedLog: (input: Parameters<typeof command>[1]) => command('remove', input),
  restorePublishedLog: (input: Parameters<typeof command>[1]) => command('restore', input),
  readPublishedLogCurrent: ({ data }: { data: { id: string } }) => {
    const work = deferred<PublishedLogCurrentRead>();
    owners.push({ data, work });
    return work.promise;
  },
}));
mock.module('@rezics/ui/shadcn/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => <section role="dialog">{children}</section>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
mock.module('@rezics/ui/menu', () => ({
  Menu: ({ entries }: { entries: { label?: string; onSelect?: () => void }[] }) => (
    <div>
      {entries
        .filter((entry) => entry.onSelect)
        .map((entry) => (
          <button key={entry.label} onClick={entry.onSelect}>
            {entry.label}
          </button>
        ))}
    </div>
  ),
}));
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const exposure = await import('../src/kernel/exposure');
const { CurrentProgressDetail } = await import('../src/library/progress-session');
const { CurrentPublishedLog } = await import('../src/library/log-current');
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { within, userEvent } = await import('storybook/test');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
const settle = (action: () => void) =>
  act(async () => {
    action();
  });
function retained(node: Element, name: string) {
  const key = Object.keys(node).find((key) => key.startsWith('__reactProps$'))!;
  return (node as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key]![name]!;
}
async function mount(kind: 'progress' | 'log' = 'progress', initial = detail()) {
  current = viewer();
  pauseExposure = false;
  reads.length = owners.length = writes.length = exposures.length = 0;
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['session'], current);
  // Deliberately poison legacy exposure: only the actual scoped response admits these controls.
  cache.setQueryData(['exposure', 'viewer'], []);
  cache.setQueryData(['exposure', 'anonymous'], ['reading_progress']);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let loaded = initial;
  let at = initial.address;
  let publicLog = log();
  let requestedId = publicLog.requestedId;
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={cache}>
        <RouterContextProvider router={router}>
          {kind === 'progress' ? (
            <CurrentProgressDetail loaded={loaded} address={at} />
          ) : (
            <CurrentPublishedLog loaded={publicLog} id={requestedId} />
          )}
        </RouterContextProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  await act(async () => {
    root.render(tree());
  });
  const body = within(document.body);
  const button = (name: string) => body.getByRole('button', { name, exact: true }) as HTMLButtonElement;
  const click = async (name: string) =>
    act(async () => {
      button(name).click();
    });
  const user = userEvent.setup({ document: window.document as unknown as Document });
  const fill = async (name: string, value: string) =>
    act(async () => {
      const field = body.getByLabelText(name, { exact: true });
      await user.clear(field);
      await user.type(field, value);
    });
  const session = (subject: string | null, csrfToken?: string | null) =>
    settle(() => {
      current = viewer(subject, csrfToken);
      cache.setQueryData(['session'], current);
    });
  const scoped = () => {
    const value = viewerExposureLifetime(cache).getSnapshot();
    expect(value.state).toBe('signed-in');
    if (value.state !== 'signed-in') throw new Error('Expected an actual session observation');
    return viewerExposureQuery(value.observation).queryKey;
  };
  const record = async (amount = '4.75') => {
    await click(m.library_progress_update());
    await fill(m.library_progress_amount(), amount);
    await click(m.library_progress_record());
  };
  const remove = async () => {
    await click(m.library_logs_delete());
    await click(m.library_logs_confirm_delete());
  };
  return {
    cache,
    host,
    body,
    button,
    click,
    fill,
    session,
    scoped,
    record,
    remove,
    show: async (next: typeof initial, nextAddress = next.address) =>
      act(async () => {
        loaded = next;
        at = nextAddress;
        root.render(tree());
      }),
    showLog: async (next: PublishedLogCurrentRead, requested = next.requestedId) =>
      act(async () => {
        publicLog = next;
        requestedId = requested;
        root.render(tree());
      }),
    close: async () => {
      await act(async () => root.unmount());
      cache.clear();
      host.remove();
    },
  };
}

describe('Complete progress detail and published log owner episodes preserves current authority and exact uncertain operations across observed replacement and ABA', () => {
  test('actual scoped authority fences retained callbacks before commit and keeps B usable before late A results', async () => {
    const h = await mount();
    try {
      expect(h.host.textContent).toContain('Private A');
      await h.record();
      const old = writes[0]!;
      const submit = retained(document.querySelector('[role="dialog"] form')!, 'onSubmit');
      await act(async () => {
        current = viewer('B');
        h.cache.setQueryData(['session'], current);
        submit({ preventDefault() {} });
      });
      expect(writes).toHaveLength(1);
      expect(h.host.textContent).not.toContain('Private A');
      expect(reads.at(-1)!.data).toEqual(address);
      await settle(() => reads.at(-1)!.work.resolve(detail('B', address, 20)));
      await h.record('9.25');
      expect(writes[1]!.data).toMatchObject({ sessionId: address.id, revision: 20, amount: '9.25' });
      expect(writes[1]!.headers).toEqual({ 'x-csrf-token': 'B-csrf' });
      await settle(() => old.work.resolve({ ok: true, session: { ...detail().progress.session, revision: 8 } }));
      expect((h.body.getByLabelText(m.library_progress_amount()) as HTMLInputElement).value).toBe('9.25');
      await h.click(m.library_progress_record());
      expect(writes).toHaveLength(2);
      const newerSubmit = retained(document.querySelector('[role="dialog"] form')!, 'onSubmit');
      await act(async () => {
        current = viewer('A');
        h.cache.setQueryData(['session'], current);
        current = viewer('B');
        h.cache.setQueryData(['session'], current);
        newerSubmit({ preventDefault() {} });
      });
      expect(writes).toHaveLength(2);
      expect(h.host.textContent).not.toContain('Private B');
      await settle(() => reads.at(-1)!.work.resolve(detail('B', address, 30)));
      await h.record('6.5');
      expect(writes[2]!.data.revision).toBe(30);
      await settle(() => writes[1]!.work.reject(new Error('late B failure/finally')));
      expect(h.body.queryByRole('alert')).toBeNull();
    } finally {
      await h.close();
    }
  });

  test('equivalent refresh and healthy credential rotation preserve the exact uncertain payload/key; wrong actual address never supplies a read', async () => {
    const initial = detail();
    const h = await mount('progress', initial);
    try {
      await h.record('0');
      const first = writes[0]!;
      await settle(() => first.work.reject(new Error('unknown native outcome')));
      await h.fill(m.library_progress_amount(), '8.5');
      await h.session('A', 'rotated-credential');
      await h.show(detail('A', address, 12));
      await h.click(m.library_progress_record());
      expect(writes[1]!.data).toEqual(first.data);
      expect(writes[1]!.headers).toEqual({ 'x-csrf-token': 'A-csrf' });
      expect(first.data).toMatchObject({ revision: 7, amount: '0', idempotencyKey: initial.progress.idempotencyKey });
      await settle(() =>
        writes[1]!.work.resolve({ ok: true, session: { ...initial.progress.session, revision: 8, amount: '0' } }),
      );
      expect(reads.at(-1)!.data).toEqual(address);
      await settle(() => reads.at(-1)!.work.resolve(detail('A', { ...address, units: 'other-units' }, 99)));
      expect(h.host.textContent).not.toContain('other-units');
      expect(h.body.queryByRole('dialog')).toBeNull();
    } finally {
      await h.close();
    }
  });

  test('scoped cache removal/error/wrong actual viewer cannot be repaired by a legacy global grant', async () => {
    for (const replace of ['remove', 'error', 'viewer'] as const) {
      const h = await mount();
      try {
        await h.record();
        const submit = retained(document.querySelector('[role="dialog"] form')!, 'onSubmit');
        await settle(() => writes[0]!.work.reject(new Error('unknown outcome')));
        await act(async () => {
          const key = h.scoped();
          if (replace === 'remove') {
            h.cache.removeQueries({ queryKey: key, exact: true });
            h.cache.setQueryData(key, { subject: 'A', admitted: ['reading_progress'] });
          } else if (replace === 'error') {
            h.cache
              .getQueryCache()
              .find({ queryKey: key, exact: true })!
              .setState({ status: 'error', error: new Error('failed exposure') });
          } else h.cache.setQueryData(key, { subject: 'B', admitted: ['reading_progress'] });
          h.cache.setQueryData(['exposure', 'viewer'], ['reading_progress']);
          submit({ preventDefault() {} });
        });
        expect(writes).toHaveLength(1);
        expect(h.host.textContent).not.toContain('Private A');
      } finally {
        await h.close();
      }
    }
  });

  test('owner remove and exact Undo have independent admission evidence, receipts, keys and original deadline', async () => {
    const resolver = spyOn(exposure, 'operationIsAdmitted').mockImplementation((operation, groups) =>
      operation === 'published_log.delete' || operation === 'published_log.create'
        ? (groups?.includes(operation) ?? false)
        : (groups?.includes('reading_progress') ?? false),
    );
    const h = await mount('log');
    try {
      await settle(() =>
        h.cache.setQueryData(h.scoped(), {
          subject: 'A',
          admitted: ['reading_progress', 'published_log.delete', 'published_log.create'],
        }),
      );
      if (owners.length) await settle(() => owners.at(-1)!.work.resolve(log()));
      await h.remove();
      const first = writes[0]!;
      await settle(() => first.work.reject(new Error('unknown remove outcome')));
      await settle(() =>
        h.cache.setQueryData(h.scoped(), { subject: 'A', admitted: ['reading_progress', 'published_log.delete'] }),
      );
      await h.click(m.library_logs_confirm_delete());
      expect(writes[1]!.data).toEqual(first.data);
      const deletionId = crypto.randomUUID();
      await settle(() => writes[1]!.work.resolve({ ok: true, id: 'original', undo: { deletionId, revision: 8 } }));
      expect(h.body.queryByRole('button', { name: m.editor_undo() })).toBeNull();
      await h.session(null);
      expect(h.host.textContent).toContain('Public snapshot original');
      expect(h.host.querySelector('button')).toBeNull();
    } finally {
      await h.close();
      resolver.mockRestore();
    }

    const restoring = await mount('log');
    try {
      await restoring.remove();
      const deletionId = crypto.randomUUID();
      await settle(() => writes[0]!.work.resolve({ ok: true, id: 'original', undo: { deletionId, revision: 8 } }));
      await restoring.click(m.editor_undo());
      const firstUndo = writes[1]!;
      await settle(() => firstUndo.work.reject(new Error('unknown restore outcome')));
      await restoring.session('A', 'rotated-owner-credential');
      await restoring.click(m.editor_undo());
      expect(writes[2]!.data).toEqual(firstUndo.data);
      expect(writes[2]!.headers).toEqual({ 'x-csrf-token': 'rotated-owner-credential' });
      await settle(() => writes[2]!.work.resolve({ ok: true, id: 'original', revision: 11 }));
      await restoring.remove();
      expect(writes[3]!.data.revision).toBe(11);
      await restoring.session('B');
      const wrong = log('B');
      wrong.owner!.accountId = 'A';
      await settle(() => owners.at(-1)!.work.resolve(wrong));
      expect(restoring.body.queryByRole('button', { name: m.library_logs_delete() })).toBeNull();
      expect(restoring.host.textContent).toContain('Public snapshot original');
    } finally {
      await restoring.close();
    }
  });

  test('publication uncertainty survives a failed completion during the next scoped observation, then explicitly retries the original note and key', async () => {
    const h = await mount();
    try {
      await h.fill(m.library_logs_publish_note(), '  captured note  ');
      await h.click(m.library_logs_publish());
      const first = writes[0]!;
      expect(first.data).toMatchObject({ sessionId: address.id, note: 'captured note' });
      pauseExposure = true;
      await h.session('A', 'rotated-publication-credential');
      await settle(() => first.work.reject(new Error('unknown publication outcome during exposure pause')));
      pauseExposure = false;
      await settle(() => exposures.at(-1)!.resolve({ data: { admitted: ['reading_progress'] } }));
      await h.fill(m.library_logs_publish_note(), 'later edited note');
      expect(h.button(m.library_logs_publish()).disabled).toBe(false);
      await h.click(m.library_logs_publish());
      expect(writes[1]!.data).toEqual(first.data);
      expect(writes[1]!.headers).toEqual({ 'x-csrf-token': 'A-csrf' });
    } finally {
      await h.close();
    }
  });
});

// UNRUN: continuation cases for settlement custody and recovered explicit publication.
test('publication records success during an unavailable observation without navigation or a second publication', async () => {
  const navigation: string[] = [];
  const assign = spyOn(window.location, 'assign').mockImplementation((url) => {
    navigation.push(String(url));
  });
  const h = await mount();
  try {
    await h.fill(m.library_logs_publish_note(), '  original public note  ');
    await h.click(m.library_logs_publish());
    const first = writes[0]!;
    pauseExposure = true;
    await h.session('A', 'success-during-rotation');
    await settle(() => first.work.resolve({ ok: true, id: 'known-publication' }));
    expect(navigation).toEqual([]);
    expect(writes).toHaveLength(1);
    pauseExposure = false;
    await settle(() => exposures.at(-1)!.resolve({ data: { admitted: ['reading_progress'] } }));
    expect(h.button(m.library_logs_publish()).disabled).toBe(false);
    expect((h.body.getByLabelText(m.library_logs_publish_note()) as HTMLTextAreaElement).value).toBe(
      '  original public note  ',
    );
    expect(navigation).toEqual([]);
    await h.click(m.library_logs_publish());
    expect(writes).toHaveLength(1);
    expect(navigation).toEqual(['/logs/known-publication']);
  } finally {
    await h.close();
    assign.mockRestore();
  }
});

test('publication A callbacks and completion cannot dispatch with B credentials or unlock B in flight', async () => {
  const navigation: string[] = [];
  const assign = spyOn(window.location, 'assign').mockImplementation((url) => {
    navigation.push(String(url));
  });
  const h = await mount();
  try {
    await h.fill(m.library_logs_publish_note(), 'A note');
    const oldSubmit = retained(h.host.querySelector('form')!, 'onSubmit');
    const oldChange = retained(h.body.getByLabelText(m.library_logs_publish_note()), 'onChange');
    await h.click(m.library_logs_publish());
    const old = writes[0]!;
    await act(async () => {
      current = viewer('B');
      h.cache.setQueryData(['session'], current);
      oldSubmit({ preventDefault() {} });
      oldChange({ target: { value: 'A callback into B' } });
    });
    expect(writes).toHaveLength(1);
    await settle(() => reads.at(-1)!.work.resolve(detail('B', address, 20)));
    expect((h.body.getByLabelText(m.library_logs_publish_note()) as HTMLTextAreaElement).value).toBe('');
    await h.fill(m.library_logs_publish_note(), 'B note');
    await h.click(m.library_logs_publish());
    const newer = writes[1]!;
    expect(newer.data).toMatchObject({ sessionId: address.id, note: 'B note' });
    expect(newer.headers).toEqual({ 'x-csrf-token': 'B-csrf' });
    await settle(() => old.work.resolve({ ok: true, id: 'A-publication' }));
    expect(navigation).toEqual([]);
    expect(h.button(m.library_logs_publish()).disabled).toBe(true);
    expect((h.body.getByLabelText(m.library_logs_publish_note()) as HTMLTextAreaElement).value).toBe('B note');
    await settle(() => oldSubmit({ preventDefault() {} }));
    await h.click(m.library_logs_publish());
    expect(writes).toHaveLength(2);
    await settle(() => newer.work.reject(new Error('B uncertain publication')));
    expect(h.button(m.library_logs_publish()).disabled).toBe(false);
    await h.click(m.library_logs_publish());
    expect(writes[2]!.data).toEqual(newer.data);
  } finally {
    await h.close();
    assign.mockRestore();
  }
});

test('equivalent scoped exposure replacement retires old publication callbacks while preserving the exact uncertain intent', async () => {
  const h = await mount();
  try {
    await h.fill(m.library_logs_publish_note(), '  captured across replacement  ');
    await h.click(m.library_logs_publish());
    const first = writes[0]!;
    const oldSubmit = retained(h.host.querySelector('form')!, 'onSubmit');
    await act(async () => {
      const key = h.scoped();
      h.cache.removeQueries({ queryKey: key, exact: true });
      h.cache.setQueryData(key, { subject: 'A', admitted: ['reading_progress'] });
      oldSubmit({ preventDefault() {} });
    });
    await settle(() => first.work.reject(new Error('uncertain completion after scoped replacement')));
    expect(writes).toHaveLength(1);
    expect(reads.at(-1)!.data).toEqual(address);
    await settle(() => reads.at(-1)!.work.resolve(detail('A', address, 18)));
    expect(writes).toHaveLength(1);
    expect(h.button(m.library_logs_publish()).disabled).toBe(false);
    expect((h.body.getByLabelText(m.library_logs_publish_note()) as HTMLTextAreaElement).value).toBe(
      '  captured across replacement  ',
    );
    await h.fill(m.library_logs_publish_note(), 'subsequently edited note');
    await settle(() => oldSubmit({ preventDefault() {} }));
    expect(writes).toHaveLength(1);
    await h.click(m.library_logs_publish());
    expect(writes[1]!.data).toEqual(first.data);
    expect(writes[1]!.data.note).toBe('captured across replacement');
  } finally {
    await h.close();
  }
});

test('sparse completed-unit recording retains the exact batch, revision and key across scoped observation churn', async () => {
  const initial = detail();
  Object.assign(initial.progress.session, {
    mode: 'completed_units',
    unit: 'track',
    unitLabel: 'tracks',
    total: null,
    amount: null,
    inputRules: { step: '1', total: 'forbidden' },
    units: ['part/2', 'part/9'],
  });
  const h = await mount('progress', initial);
  try {
    expect(h.host.textContent).toContain('part/2');
    expect(h.host.textContent).toContain('part/9');
    expect(h.host.textContent).not.toContain('part/3');
    await h.click(m.library_progress_update());
    await h.fill(m.library_progress_add_units(), 'part/10\npart/42');
    await h.click(m.library_progress_add_units());
    const first = writes[0]!;
    expect(first.data).toEqual({
      sessionId: address.id,
      revision: 7,
      idempotencyKey: initial.progress.idempotencyKey,
      add: ['part/10', 'part/42'],
    });
    pauseExposure = true;
    await h.session('A', 'units-rotated-credential');
    await settle(() => first.work.reject(new Error('uncertain sparse units')));
    pauseExposure = false;
    await settle(() => exposures.at(-1)!.resolve({ data: { admitted: ['reading_progress'] } }));
    await h.fill(m.library_progress_add_units(), 'part/99');
    await h.click(m.library_progress_add_units());
    expect(writes[1]!.data).toEqual(first.data);
    expect(writes[1]!.headers).toEqual({ 'x-csrf-token': 'A-csrf' });
  } finally {
    await h.close();
  }
});

test('publication uncertainty settles during healthy rotation and resumes explicitly with its original note and key', async () => {
  const h = await mount();
  try {
    await h.fill(m.library_logs_publish_note(), '  exact uncertain note  ');
    await h.click(m.library_logs_publish());
    const first = writes[0]!;
    pauseExposure = true;
    await h.session('A', 'publication-rotated-credential');
    await settle(() => first.work.reject(new Error('uncertain publication during rotation')));
    expect(writes).toHaveLength(1);
    pauseExposure = false;
    await settle(() => exposures.at(-1)!.resolve({ data: { admitted: ['reading_progress'] } }));
    expect(h.button(m.library_logs_publish()).disabled).toBe(false);
    expect(writes).toHaveLength(1);
    await h.fill(m.library_logs_publish_note(), 'a later draft');
    await h.click(m.library_logs_publish());
    expect(writes).toHaveLength(2);
    expect(writes[1]!.data).toEqual(first.data);
    expect(writes[1]!.data.note).toBe('exact uncertain note');
    expect(writes[1]!.headers).toEqual({ 'x-csrf-token': 'A-csrf' });
    await h.click(m.library_logs_publish());
    expect(writes).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test('losing restore admission preserves the known restored revision for the independent delete command', async () => {
  const resolver = spyOn(exposure, 'operationIsAdmitted').mockImplementation((operation, groups) =>
    operation === 'published_log.delete' || operation === 'published_log.create'
      ? (groups?.includes(operation) ?? false)
      : (groups?.includes('reading_progress') ?? false),
  );
  const h = await mount('log');
  try {
    await settle(() =>
      h.cache.setQueryData(h.scoped(), {
        subject: 'A',
        admitted: ['reading_progress', 'published_log.delete', 'published_log.create'],
      }),
    );
    if (owners.length) await settle(() => owners.at(-1)!.work.resolve(log()));
    await h.remove();
    const deletionId = crypto.randomUUID();
    await settle(() => writes[0]!.work.resolve({ ok: true, id: 'original', undo: { deletionId, revision: 8 } }));
    await h.click(m.editor_undo());
    expect(writes[1]!.data).toMatchObject({ id: 'original', deletionId, revision: 8 });
    await settle(() => writes[1]!.work.resolve({ ok: true, id: 'original', revision: 11 }));
    await settle(() =>
      h.cache.setQueryData(h.scoped(), { subject: 'A', admitted: ['reading_progress', 'published_log.delete'] }),
    );
    await h.remove();
    expect(writes[2]!.data).toMatchObject({ id: 'original', revision: 11 });
    expect(writes[2]!.data.idempotencyKey).not.toBe(writes[0]!.data.idempotencyKey);
  } finally {
    await h.close();
    resolver.mockRestore();
  }
});
