import { LibraryApplicationBoundary } from '../src/session/library-application';
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ComponentProps, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type { CopiesCurrentRead, CopyDetailCurrentRead, CopySubjectCurrentRead } from '../src/library/copies-actions';
import type { LabelsCurrentRead } from '../src/library/labels-read-route';
import type { CopyWriteResult } from '../src/library/copies-read';
import type { LabelResult } from '../src/library/labels-read';

// UNRUN. Composed default workflows with actual QueryClient notifications and retained
// presenter/DOM callbacks. Native, browser, visual and broader acceptance proof is deferred.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/copies' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  FormData: window.FormData,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
mock.module('@rezics/ui/shadcn/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogContent: Part,
  DialogTitle: Part,
  DialogDescription: Part,
  DialogHeader: Part,
}));
mock.module('@rezics/ui/bottom-sheet', () => ({ BottomSheet: Part }));
mock.module('@rezics/ui/menu', () => ({
  Menu: ({ entries }: { entries: { label: string; onSelect?: () => void }[] }) => (
    <>
      {entries.map((entry) => (
        <button key={entry.label} onClick={entry.onSelect}>
          {entry.label}
        </button>
      ))}
    </>
  ),
}));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRouter, createRootRoute, createMemoryHistory, RouterContextProvider } =
  await import('@tanstack/react-router');
const copies = await import('../src/library/copies-actions');
const labels = await import('../src/library/labels-read-route');
const labelActions = await import('../src/library/labels-actions');
const copiesPresenter = await import('../src/library/copies-page');
const labelsPresenter = await import('../src/library/labels-page');
const notices = await import('../src/library/copies-undo');
const notifications = await import('@rezics/ui/shadcn/toast');
const { CopiesCurrent } = await import('../src/library/copies-current');
const { LabelsCurrent } = await import('../src/library/labels-current');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
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
const viewer = (subject: string, csrfToken = `actual-${subject}`) => ({ state: 'signed-in', subject, csrfToken });
const admissions = ['library_label.list', 'library_label.create', 'library_label.rename', 'library_label.delete'];
const copyResponse = (subject: string, cursor: string | null = 'signed+/cursor=='): CopiesCurrentRead => ({
  sessionSubject: subject,
  requested: { subjectId: id(10), cursor, locale: 'en' },
  page: {
    signedIn: true,
    subjectId: id(10),
    next: `next-${subject}`,
    addKey: id(80),
    csrfToken: `loader-${subject}`,
    profile: { kinds: [{ id: 'print', label: 'Print', statuses: [{ id: 'shelf', label: 'Shelf' }] }] },
    copies: [
      {
        id: id(1),
        revision: 7,
        status: 'shelf',
        kind: 'print',
        location: null,
        source: null,
        acquiredOn: null,
        disposedOn: null,
        note: `Private ${subject}`,
        idempotencyKey: id(81),
        statusEditing: { state: 'unavailable' },
        subject: { id: id(10), type: 'Book', types: ['Book'], label: `Edition ${subject}`, cover: null },
      },
    ],
  },
});
const labelResponse = (subject: string, revision = 7): LabelsCurrentRead => ({
  sessionSubject: subject,
  requested: { cursor: 'signed+/cursor==', query: 'Private', locale: 'en' },
  page: {
    signedIn: true,
    state: 'loaded',
    query: 'Private',
    operations: admissions,
    csrfToken: `loader-${subject}`,
    createKey: id(90),
    undoKey: id(91),
    next: `next-${subject}`,
    labels: [{ id: `label-${subject}`, name: `Private ${subject}`, revision, renameKey: id(92), deleteKey: id(93) }],
  },
});
function props<T>(node: Element): T {
  return Object.entries(node).find(([key]) => key.startsWith('__reactProps$'))![1] as T;
}
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
function click(host: ParentNode, text: string) {
  const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text);
  expect(node).toBeDefined();
  return act(async () => node!.click());
}

test('Copies retains no A read/editor/Undo authority across pre-commit cache ABA and keeps bounded B recovery and exact uncertain edits', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], viewer('A'));
  client.setQueryData(['exposure', 'viewer'], ['personal_library']);
  const lists: ReturnType<typeof deferred<CopiesCurrentRead>>[] = [];
  const details: ReturnType<typeof deferred<CopyDetailCurrentRead>>[] = [];
  const subjects: ReturnType<typeof deferred<CopySubjectCurrentRead>>[] = [];
  const writes: {
    input: Parameters<typeof copies.updateCopy>[0];
    work: ReturnType<typeof deferred<CopyWriteResult>>;
  }[] = [];
  let page!: ComponentProps<typeof copiesPresenter.CopiesPage>;
  let undo!: ComponentProps<typeof notices.UndoNotice>['restore'];
  const OriginalPage = copiesPresenter.CopiesPage;
  const OriginalNotice = notices.UndoNotice;
  const spies = [
    spyOn(copiesPresenter, 'CopiesPage').mockImplementation((input) => {
      page = input;
      return <OriginalPage {...input} />;
    }),
    spyOn(notices, 'UndoNotice').mockImplementation((input) => {
      undo = input.restore;
      return <OriginalNotice {...input} />;
    }),
    spyOn(copies, 'readCopiesCurrent').mockImplementation(() => {
      const work = deferred<CopiesCurrentRead>();
      lists.push(work);
      return work.promise;
    }),
    spyOn(copies, 'readCopyDetailCurrent').mockImplementation(() => {
      const work = deferred<CopyDetailCurrentRead>();
      details.push(work);
      return work.promise;
    }),
    spyOn(copies, 'readCopySubjectCurrent').mockImplementation(() => {
      const work = deferred<CopySubjectCurrentRead>();
      subjects.push(work);
      return work.promise;
    }),
    spyOn(copies, 'updateCopy').mockImplementation((input) => {
      const work = deferred<CopyWriteResult>();
      writes.push({ input, work });
      return work.promise;
    }),
    spyOn(copies, 'deleteCopy').mockResolvedValue({ ok: true, undo: { deletionId: id(100), revision: 8 } }),
    spyOn(copies, 'undoCopy').mockResolvedValue({ ok: false, reason: 'unavailable' }),
  ];
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library/copies'] }),
  });
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <LibraryApplicationBoundary>
          <RouterContextProvider router={router}>
            <CopiesCurrent initial={initial} search={{ subjectId: id(10), cursor: 'signed+/cursor==' }} locale="en" />
          </RouterContextProvider>
        </LibraryApplicationBoundary>
      </QueryClientProvider>
    </StrictMode>
  );
  let initial = copyResponse('A');
  try {
    await act(async () => root.render(tree()));
    await tick();
    expect(lists).toHaveLength(0); // One loader hydration, no duplicate first-page read.
    const a = page.originating!;
    const firstRead = client.getQueryCache().find({ queryKey: ['copies-current'], type: 'active' })!.options
      .queryFn as () => Promise<unknown>;
    const lateDetail = a.readDetail(id(1));
    const lateSubject = a.readSubject(id(10));
    await click(host, m.library_copy_edit());
    await act(async () =>
      details.at(-1)!.resolve({
        sessionSubject: 'A',
        requested: initial.requested,
        id: id(1),
        result: { ok: true, copy: initial.page.copies[0]! },
      }),
    );
    await click(host, m.library_copy_delete());
    await click(host, m.library_copy_delete_confirm());
    const oldUndo = undo;
    const next = props<{ onClick: (event: { preventDefault(): void }) => void }>(
      host.querySelector('a[href*="next-A"]')!,
    ).onClick;
    await act(async () => {
      client.setQueryData(['session'], viewer('B'));
      client.setQueryData(['session'], viewer('A')); // Same final value; no React commit between observations.
      expect(a.isCurrent()).toBe(false);
      expect(a.headers()).toBeNull();
      await expect(firstRead()).rejects.toThrow('Obsolete Copies read');
      expect(await a.readDetail(id(1))).toEqual({ ok: false, reason: 'unavailable' });
      expect(await a.readSubject(id(10))).toEqual({ state: 'unavailable' });
      expect(await oldUndo(id(101))).toBe(false);
      const event = new window.MouseEvent('click', { cancelable: true, button: 0 });
      next(event as never);
      expect(event.defaultPrevented).toBe(true);
    });
    expect(details).toHaveLength(2);
    expect(subjects).toHaveLength(1);
    expect(copies.undoCopy).not.toHaveBeenCalled();
    await act(async () => {
      details[0]!.resolve({
        sessionSubject: 'A',
        requested: initial.requested,
        id: id(1),
        result: { ok: true, copy: initial.page.copies[0]! },
      });
      subjects[0]!.resolve({
        sessionSubject: 'A',
        requested: initial.requested,
        id: id(10),
        result: { state: 'unsupported' },
      });
    });
    expect(await lateDetail).toEqual({ ok: false, reason: 'unavailable' });
    expect(await lateSubject).toEqual({ state: 'unavailable' });
    await act(async () => client.setQueryData(['session'], viewer('B')));
    await tick();
    await act(async () => lists.at(-1)!.resolve(copyResponse('B')));
    await tick();
    expect(host.textContent).toContain('Private B');
    expect(host.textContent).not.toContain('Private A');
    await click(host, m.library_copy_edit());
    await act(async () =>
      details.at(-1)!.resolve({
        sessionSubject: 'B',
        requested: initial.requested,
        id: id(1),
        result: { ok: true, copy: copyResponse('B').page.copies[0]! },
      }),
    );
    const form = host.querySelector<HTMLFormElement>('[role="dialog"] form')!;
    const submit = props<{ onSubmit: (event: { preventDefault(): void }) => Promise<void> }>(form).onSubmit;
    let first!: Promise<void>;
    await act(async () => {
      first = submit({ preventDefault() {} });
    });
    await act(async () => writes[0]!.work.reject(new Error('Uncertain B')));
    await first;
    const original = structuredClone(writes[0]!.input.data);
    await click(host, m.library_copy_more());
    const fieldLabel = [...form.querySelectorAll('label')].find(
      (label) => label.textContent === m.library_copy_note(),
    )!;
    const input = document.getElementById(fieldLabel.htmlFor)!;
    await act(async () =>
      props<{ onChange: (event: { currentTarget: { value: string } }) => void }>(input).onChange({
        currentTarget: { value: 'Edited after uncertainty' },
      }),
    );
    await act(async () => {
      client.setQueryData(['session'], viewer('B', 'rotated-B'));
      initial = copyResponse('B');
      root.render(tree());
    });
    let retry!: Promise<void>;
    await act(async () => {
      retry = props<{ onSubmit: typeof submit }>(host.querySelector('[role="dialog"] form')!).onSubmit({
        preventDefault() {},
      });
    });
    expect(writes[1]!.input.data).toEqual(original);
    expect(new Headers(writes[1]!.input.headers).get('x-csrf-token')).toBe('actual-B');
    await act(async () => writes[1]!.work.resolve({ ok: false, reason: 'conflict' }));
    await retry;
    const retained = page.originating!;
    await act(async () => {
      const query = client.getQueryCache().find({ queryKey: ['copies-current'], type: 'active' })!;
      const retainedData = query.state.data;
      query.setState({ status: 'pending', data: undefined });
      expect(retained.isCurrent()).toBe(false);
      query.setState({ status: 'error', error: new Error('Retained data error') });
      expect(retained.headers()).toBeNull();
      query.setState({ status: 'success', error: null, data: retainedData });
      expect(retained.isCurrent()).toBe(false);
    });
    expect(host.textContent).not.toContain('Private B');
    const retryRead = props<{ onClick: () => void }>(
      [...host.querySelectorAll('button')].find((button) => button.textContent === m.subject_view_retry())!,
    ).onClick;
    await act(async () => retryRead());
    await act(async () => lists.at(-1)!.resolve(copyResponse('B')));
    await tick();
    expect(host.textContent).toContain('Private B');
    await act(async () => {
      client.setQueryData(['session'], viewer('C'));
      const count = lists.length;
      retryRead();
      expect(lists).toHaveLength(count);
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    spies.forEach((spy) => spy.mockRestore());
  }
});

test('Labels consumes exact operation admission and actual rotated credentials; stale refresh/write/finally and owned Undo cannot affect usable replacements', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], viewer('A'));
  client.setQueryData(['exposure', 'viewer'], admissions); // An independent list needs no unrelated write/group.
  const reads: ReturnType<typeof deferred<LabelsCurrentRead>>[] = [];
  const writes: {
    input: Parameters<typeof labelActions.manageLabel>[0];
    work: ReturnType<typeof deferred<LabelResult>>;
  }[] = [];
  let page!: ComponentProps<typeof labelsPresenter.LabelsPageView>;
  const toasts: Parameters<typeof notifications.toast.add>[0][] = [];
  const OriginalPage = labelsPresenter.LabelsPageView;
  const spies = [
    spyOn(labelsPresenter, 'LabelsPageView').mockImplementation((input) => {
      page = input;
      return <OriginalPage {...input} />;
    }),
    spyOn(labels, 'readLabelsCurrent').mockImplementation(() => {
      const work = deferred<LabelsCurrentRead>();
      reads.push(work);
      return work.promise;
    }),
    spyOn(labelActions, 'manageLabel').mockImplementation((input) => {
      const work = deferred<LabelResult>();
      writes.push({ input, work });
      return work.promise;
    }),
    spyOn(notifications.toast, 'add').mockImplementation((input) => {
      toasts.push(input);
      return 'undo-toast';
    }),
    spyOn(notifications.toast, 'update').mockImplementation(() => {}),
  ];
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let initial = labelResponse('A');
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <LibraryApplicationBoundary>
          <LabelsCurrent initial={initial} search={{ q: 'Private', cursor: 'signed+/cursor==' }} locale="en" />
        </LibraryApplicationBoundary>
      </QueryClientProvider>
    </StrictMode>
  );
  const renameForm = () => host.querySelector<HTMLFormElement>('[role="dialog"] form')!;
  const submit = (form: HTMLFormElement) =>
    props<{ onSubmit: (event: { preventDefault(): void; currentTarget: HTMLFormElement }) => void }>(form).onSubmit({
      preventDefault() {},
      currentTarget: form,
    });
  try {
    await act(async () => root.render(tree()));
    await tick();
    expect(reads).toHaveLength(0);
    expect(host.textContent).toContain('Private A');
    await click(host, m.library_label_rename());
    const aSubmit = () => submit(renameForm());
    const aGuard = page.originating!;
    const firstRead = client.getQueryCache().find({ queryKey: ['labels-current'], type: 'active' })!.options
      .queryFn as () => Promise<unknown>;
    const aRefresh = page.refresh!;
    const next = props<{ onClick: (event: { preventDefault(): void }) => void }>(
      host.querySelector('a[href*="next-A"]')!,
    ).onClick;
    await act(async () => aSubmit());
    const intent = structuredClone(writes[0]!.input.data);
    await act(async () => writes[0]!.work.resolve({ ok: false, reason: 'unavailable' }));
    await act(async () => reads[0]!.resolve(labelResponse('A', 12)));
    await tick();
    await act(async () => client.setQueryData(['session'], viewer('A', 'rotated-A')));
    await act(async () => submit(renameForm()));
    expect(writes[1]!.input.data).toEqual(intent); // Original revision, exact payload and key survive refresh.
    expect(new Headers(writes[1]!.input.headers).get('x-csrf-token')).toBe('actual-A');
    const retainedSubmit = props<{
      onSubmit: (event: { preventDefault(): void; currentTarget: HTMLFormElement }) => void;
    }>(renameForm()).onSubmit;
    const retainedForm = renameForm();
    await act(async () => {
      client.setQueryData(['session'], viewer('B'));
      expect(aGuard.headers('library_label.rename')).toBeNull();
      client.setQueryData(['session'], viewer('A'));
      expect(aGuard.isCurrent()).toBe(false);
      expect(await aRefresh()).toBeNull();
      await expect(firstRead()).rejects.toThrow('Obsolete Labels read');
      retainedSubmit({ preventDefault() {}, currentTarget: retainedForm });
      const event = new window.MouseEvent('click', { cancelable: true, button: 0 });
      next(event as never);
      expect(event.defaultPrevented).toBe(true);
      client.setQueryData(['session'], viewer('B'));
    });
    expect(writes).toHaveLength(2);
    await tick();
    await act(async () => reads.at(-1)!.resolve(labelResponse('B')));
    await tick();
    await click(host, m.library_label_rename());
    await act(async () => submit(renameForm()));
    expect(host.querySelector('article')!.getAttribute('aria-busy')).toBe('true');
    await act(async () => writes[1]!.work.reject(new Error('Late A failure')));
    expect(host.querySelector('article')!.getAttribute('aria-busy')).toBe('true');
    expect(host.textContent).not.toContain('Private A');
    await act(async () => writes[2]!.work.resolve({ ok: false, reason: 'conflict' }));
    await act(async () => reads.at(-1)!.resolve(labelResponse('B')));
    await tick();
    await click(host, m.action_cancel());
    const b = page.originating!;
    await act(async () => {
      client.setQueryData(['exposure', 'viewer'], ['library_label.list', 'library_label.delete']);
      expect(b.isCurrent('library_label.list')).toBe(true);
      expect(b.headers('library_label.rename')).toBeNull();
      client.setQueryData(['exposure', 'viewer'], admissions);
      expect(b.headers('library_label.rename')).toBeNull();
    });
    await tick();
    expect(host.textContent).toContain('Private B');
    const before = reads.length;
    expect(before).toBe(3); // No automatic read on a write-only admission change.
    await click(host, m.library_label_delete());
    await act(async () => submit(renameForm()));
    await act(async () => writes[3]!.work.resolve({ ok: true, revision: 18 }));
    const empty = labelResponse('B');
    empty.page.labels = [];
    await act(async () => reads.at(-1)!.resolve(empty));
    await tick();
    const undo = toasts.at(-1)!.actionProps!.onClick!;
    await act(async () => {
      client.setQueryData(['session'], viewer('B', 'rotated-B'));
      undo({} as never);
    });
    expect(writes[4]!.input.data).toMatchObject({ operation: 'restore', id: 'label-B', revision: 18 });
    expect(new Headers(writes[4]!.input.headers).get('x-csrf-token')).toBe('rotated-B');
    await act(async () => writes[4]!.work.resolve({ ok: true }));
    await act(async () => reads.at(-1)!.reject(new Error('Accepted restore reload failed')));
    await tick();
    expect(host.textContent).toContain(m.library_labels_unavailable());
    const retryLink = host.querySelector<HTMLAnchorElement>('a')!;
    expect(retryLink.href).toContain('cursor=signed%2B%2Fcursor%3D%3D');
    expect(writes).toHaveLength(5); // Recovery is the reload URL; an accepted restore is never repeated.
    const staleRefresh = page.refresh!;
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-in', subject: 'B', csrfToken: '' });
      undo({} as never);
      expect(await staleRefresh()).toBeNull();
      client.setQueryData(['session'], viewer('B'));
      undo({} as never);
    });
    expect(writes).toHaveLength(5);
    expect(reads).toHaveLength(6);
    await tick();
    const recovered = labelResponse('B');
    recovered.page.labels = [];
    await act(async () => reads.at(-1)!.resolve(recovered));
    await tick();
    expect(host.textContent).toContain(m.library_subject_label_no_results());
    expect(host.querySelector('a[href*="next-B"]')).not.toBeNull(); // Genuine empty accepted provenance keeps paging.
    const healthy = page.originating!;
    await act(async () => {
      client
        .getQueryCache()
        .find({ queryKey: ['exposure', 'viewer'] })!
        .setState({ status: 'error', error: new Error('Exposure unavailable with retained data') });
      expect(healthy.headers('library_label.create')).toBeNull();
      client.setQueryData(['exposure', 'viewer'], admissions);
      expect(healthy.isCurrent()).toBe(false);
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    spies.forEach((spy) => spy.mockRestore());
  }
});
