import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, startTransition, StrictMode, Suspense } from 'react';
import type { EntityPickerProps, EntityPickerSubject } from '@rezics/ui/entity-picker';
import * as start from '../.storybook/react-start';
import members from '../src/kernel/recorded/library-collection-members.json';
import type { CollectionWriteResult } from '../src/library/collection-edit';

// UNRUN: deferred component regressions for integration. Reuse installed DOM and recorded subjects.
// The picker fixture and controlled BFF results do not prove native authorization or browser behavior.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const subjects: EntityPickerSubject[] = members.members.map(({ subject }) => ({
  id: subject.id,
  title: subject.label.value,
  types: subject.types,
  typeLabel: 'Book',
  cover: null,
}));
function PickerFixture({ label, value, onValueChange, disabled }: EntityPickerProps) {
  return (
    <select
      aria-label={label}
      value={value?.[0]?.id ?? ''}
      disabled={disabled}
      onChange={(event) => onValueChange?.(subjects.filter((subject) => subject.id === event.target.value))}
    >
      <option value="" />
      {subjects.map((subject) => (
        <option key={subject.id} value={subject.id}>
          {subject.title}
        </option>
      ))}
    </select>
  );
}
mock.module('@rezics/ui/entity-picker', () => ({ EntityPicker: PickerFixture }));
afterAll(() => mock.restore());

type Viewer = { state: 'signed-in' | 'signed-out' | 'unknown'; subject?: string | null; csrfToken: string | null };
const viewer = (subject = 'viewer-one', csrfToken = 'csrf-one'): Viewer => ({ state: 'signed-in', subject, csrfToken });
const collection = 'collection-one';
const success: CollectionWriteResult = { ok: true, id: 'new-occurrence' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function callbacks() {
  const reloads: ReturnType<typeof deferred<void>>[] = [];
  let closes = 0;
  return {
    reloads,
    get closes() {
      return closes;
    },
    onAdded: () => {
      const read = deferred<void>();
      reloads.push(read);
      return read.promise;
    },
    onClose: () => closes++,
  };
}

function reactProps<T>(element: Element): T {
  return Object.entries(element).find(([key]) => key.startsWith('__reactProps$'))![1] as T;
}
const suspended = new Promise<never>(() => {});
function CommitGate({ suspend }: { suspend: boolean }) {
  if (suspend) throw suspended;
  return null;
}

async function mountForm() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/collections/one' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const edits = await import('../src/library/collection-edit');
  const buttons = await import('@rezics/ui/shadcn/button');
  const RealButton = buttons.Button;
  let cancel = () => {};
  const buttonObserver = spyOn(buttons, 'Button').mockImplementation((props) => {
    if (props.type === 'button') cancel = () => props.onClick?.({} as never);
    return <RealButton {...props} />;
  });
  const { CollectionAddMembers } = await import('../src/library/collection-add-members');
  const { m } = await import('../src/paraglide/messages.js');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: {
    data: { collectionId: string; subjectId: string; note: string | null; idempotencyKey: string };
    csrf: string | null;
    work: ReturnType<typeof deferred<CollectionWriteResult>>;
  }[] = [];
  const transport = spyOn(edits, 'addCollectionMember').mockImplementation((input) => {
    const work = deferred<CollectionWriteResult>();
    calls.push({ data: structuredClone(input.data), csrf: new Headers(input.headers).get('X-CSRF-Token'), work });
    return work.promise;
  });
  const events = callbacks();
  const render = async ({
    collectionId = collection,
    session = viewer(),
    admitted = true,
    handlers = events,
    visible = true,
    suspend = false,
  }: {
    collectionId?: string;
    session?: Viewer;
    admitted?: boolean;
    handlers?: ReturnType<typeof callbacks>;
    visible?: boolean;
    suspend?: boolean;
  } = {}) => {
    await act(async () => {
      client.setQueryData(['session'], session);
      client.setQueryData(['exposure', 'viewer'], admitted ? ['collections'] : []);
      // Public admission must never authorize a signed-out add.
      client.setQueryData(['exposure', 'anonymous'], ['collections']);
      const tree = (
        <StrictMode>
          <QueryClientProvider client={client}>
            <Suspense fallback={null}>
              {visible ? <CollectionAddMembers collectionId={collectionId} {...handlers} /> : null}
              <CommitGate suspend={suspend} />
            </Suspense>
          </QueryClientProvider>
        </StrictMode>
      );
      if (suspend) startTransition(() => root.render(tree));
      else root.render(tree);
    });
  };
  const form = () => host.querySelector('form')!;
  const action = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const picker = () => host.querySelector<HTMLSelectElement>('select')!;
  const note = () => host.querySelector<HTMLTextAreaElement>('textarea')!;
  const choose = async (index = 0) => {
    await act(async () => {
      picker().value = subjects[index]!.id;
      picker().dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };
  const changeNote = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(note(), value);
      note().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const submit = async (twice = false) => {
    await act(async () => {
      const current = form();
      current.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      if (twice) current.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  const settle = async (index: number, result: CollectionWriteResult | Error) => {
    await act(async () => {
      if (result instanceof Error) calls[index]!.work.reject(result);
      else calls[index]!.work.resolve(result);
    });
  };
  const reload = async (handlers = events, error?: Error, index = 0) => {
    await act(async () => {
      if (error) handlers.reloads[index]!.reject(error);
      else handlers.reloads[index]!.resolve();
    });
  };
  return {
    host,
    session: (value: Viewer) => client.setQueryData(['session'], value),
    admission: (value: boolean) => client.setQueryData(['exposure', 'viewer'], value ? ['collections'] : []),
    removeSession: () => client.removeQueries({ queryKey: ['session'], exact: true }),
    removeAdmission: () => client.removeQueries({ queryKey: ['exposure', 'viewer'], exact: true }),
    retained() {
      const submit = reactProps<{ onSubmit: (event: { preventDefault(): void }) => void }>(form()).onSubmit;
      const select = reactProps<{ onChange: (event: { target: { value: string } }) => void }>(picker()).onChange;
      const edit = reactProps<{ onChange: (event: { target: { value: string } }) => void }>(note()).onChange;
      return {
        submit: () => submit({ preventDefault() {} }),
        select: (index = 1) => select({ target: { value: subjects[index]!.id } }),
        note: (value = 'Retired edit') => edit({ target: { value } }),
        cancel,
      };
    },
    m,
    calls,
    events,
    render,
    form,
    action,
    picker,
    note,
    choose,
    changeNote,
    submit,
    settle,
    reload,
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      transport.mockRestore();
      buttonObserver.mockRestore();
      host.remove();
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
async function withForm(run: (page: Awaited<ReturnType<typeof mountForm>>) => Promise<void>) {
  const page = await mountForm();
  try {
    await run(page);
  } finally {
    await page.dispose();
  }
}

test('Complete Collection Add Members dispatch retry accepted reload and cancellation remain in the actual originating viewer admission and collection lifetime with exact uncertain input and key', async () => {
  const losses = [
    (page: Page) => page.session(viewer('viewer-two', 'replacement-token')),
    (page: Page) => page.session({ ...viewer(), state: 'unknown' }),
    (page: Page) => page.session({ ...viewer(), state: 'signed-out' }),
    (page: Page) => page.session({ ...viewer(), subject: null }),
    (page: Page) => page.session(viewer('')),
    (page: Page) => page.session({ ...viewer(), csrfToken: null }),
    (page: Page) => page.session(viewer('viewer-one', '')),
    (page: Page) => page.admission(false),
    (page: Page) => page.removeSession(),
    (page: Page) => page.removeAdmission(),
  ];
  for (const lose of losses)
    await withForm(async (page) => {
      await page.render();
      await page.choose();
      await page.changeNote('Original draft');
      const old = page.retained();
      const node = page.form();
      await act(async () => {
        lose(page);
        expect(page.form()).toBe(node); // No replacement React commit has happened.
        old.select();
        old.note();
        old.submit();
        old.cancel();
        page.session(viewer());
        page.admission(true);
        old.select();
        old.note();
        old.submit();
        old.cancel(); // Observed ABA cannot revive even a never-dispatched draft.
        expect(page.calls).toHaveLength(0);
        expect(page.events.closes).toBe(0);
      });
      await page.render();
      expect(page.picker().value).toBe('');
      await page.choose(1);
      await page.submit(true);
      expect(page.calls).toHaveLength(1);
      expect(page.calls[0]!.data.subjectId).toBe(subjects[1]!.id);
      expect(page.calls[0]!.data.note).toBeNull();
      await page.settle(0, success);
      await page.reload();
      expect(page.events.closes).toBe(1);
    });
});

type Page = Awaited<ReturnType<typeof mountForm>>;

test('Address replacement retires callbacks during a suspended render; returning and unmounting cannot revive them', async () => {
  await withForm(async (page) => {
    await page.render();
    await page.choose();
    const old = page.retained();
    const node = page.form();
    await page.render({ collectionId: 'collection-two', suspend: true });
    expect(page.form()).toBe(node); // Address B was observed, but its tree cannot commit yet.
    await act(async () => {
      old.select();
      old.note();
      old.submit();
      old.cancel();
    });
    expect(page.calls).toHaveLength(0);
    expect(page.events.closes).toBe(0);
    await page.render();
    expect(page.picker().value).toBe('');
    await page.choose();
    const returning = page.retained();
    await page.render({ visible: false });
    await page.render();
    await act(async () => {
      old.submit();
      returning.select();
      returning.note();
      returning.submit();
      returning.cancel();
    });
    expect(page.calls).toHaveLength(0);
    expect(page.events.closes).toBe(0);
    await page.choose(1);
    await page.submit();
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]!.data.collectionId).toBe(collection);
  });
});

test('Retired add and reload continuations cannot paint, close or unlock B while B is working, including ABA', async () => {
  for (const phase of ['add', 'reload'] as const)
    for (const outcome of [success, { ok: false, reason: 'full' } as const, new Error('Late failure')])
      await withForm(async (page) => {
        await page.render();
        await page.choose();
        const old = page.retained();
        await page.submit();
        if (phase === 'reload') await page.settle(0, success);
        await act(async () => {
          page.session(viewer('viewer-two', 'csrf-two'));
          page.session(viewer());
          page.admission(false);
          page.admission(true);
          old.cancel();
        });
        const next = callbacks();
        await page.render({ session: viewer('viewer-two', 'csrf-two'), handlers: next });
        await page.choose(1);
        await page.changeNote('B stays busy');
        await page.submit();
        if (phase === 'add') await page.settle(0, outcome);
        else await page.reload(page.events, outcome instanceof Error ? outcome : undefined);
        await act(async () => {
          old.select();
          old.note();
          old.submit();
          old.cancel();
        });
        expect(page.events.closes + next.closes).toBe(0);
        expect(next.reloads).toHaveLength(0);
        expect(page.host.querySelector('[role="alert"]')).toBeNull();
        expect(page.note().value).toBe('B stays busy');
        expect(page.action().getAttribute('aria-busy')).toBe('true');
        await page.submit(true);
        expect(page.calls).toHaveLength(2);
        expect(page.calls[1]!.csrf).toBe('csrf-two');
        await page.settle(1, success);
        await page.reload(next);
        expect(next.closes).toBe(1);
      });
});

test('Unavailable and thrown adds freeze exact occurrence input and key through attempted edits and same-viewer token rotation', async () => {
  for (const outcome of [{ ok: false, reason: 'unavailable' } as const, new Error('Response lost')])
    await withForm(async (page) => {
      await page.render();
      await page.choose();
      await page.changeNote('  Exact original note\n');
      const old = page.retained();
      await page.submit(true);
      const captured = page.calls[0]!.data;
      await act(async () => old.cancel());
      expect(page.events.closes).toBe(0);
      await page.settle(0, outcome);
      expect(page.picker().disabled).toBe(true);
      expect(page.note().disabled).toBe(true);
      await act(async () => {
        old.select();
        old.note('A different command');
        page.session(viewer('viewer-one', 'rotated-before-commit'));
        old.submit();
        old.submit();
      });
      expect(page.calls).toHaveLength(2);
      expect(page.calls[1]!.data).toEqual(captured);
      expect(page.calls[1]!.csrf).toBe('rotated-before-commit');
      expect(page.note().value).toBe(captured.note);
      await page.settle(1, { ok: false, reason: 'unavailable' });
      expect(page.calls).toHaveLength(2); // Recovery is explicit, never automatic.
      await act(async () => old.cancel());
      expect(page.events.closes).toBe(1); // Cancel retires UI, without claiming to undo native effects.
      await act(async () => {
        old.select();
        old.note();
        old.submit();
        old.cancel();
      });
      expect(page.calls).toHaveLength(2);
      expect(page.events.closes).toBe(1);
    });
});

test('Accepted recovery reloads only; a healthy repeated subject and deliberate terminal-refusal correction get fresh keys', async () => {
  await withForm(async (page) => {
    await page.render();
    await page.choose();
    await page.changeNote('Accepted occurrence');
    await page.submit();
    const first = page.calls[0]!.data;
    await page.settle(0, success);
    await page.reload(page.events, new Error('Reload unavailable'));
    expect(page.action().textContent).toBe(page.m.library_collection_reload());
    const accepted = page.retained();
    await act(async () => {
      accepted.select();
      accepted.note();
      page.session(viewer('viewer-one', 'rotated-token'));
      accepted.submit();
      accepted.submit();
    });
    expect(page.calls).toHaveLength(1);
    expect(page.events.reloads).toHaveLength(2);
    await page.reload(page.events, undefined, 1);
    expect(page.events.closes).toBe(1);
    await page.render({ visible: false });
    await page.render();
    await page.choose();
    await page.submit();
    expect(page.calls[1]!.data.subjectId).toBe(first.subjectId);
    expect(page.calls[1]!.data.note).toBeNull();
    expect(page.calls[1]!.data.idempotencyKey).not.toBe(first.idempotencyKey);
    await page.settle(1, success);
    await page.reload(page.events, undefined, 2);
    expect(page.events.closes).toBe(2);
    await page.render({ visible: false });
    await page.render();
    await page.choose();
    await page.submit();
    await page.settle(2, { ok: false, reason: 'full' });
    expect(page.host.querySelector('[role="alert"]')!.textContent).toBe(page.m.library_collection_full());
    await page.choose(1);
    await page.changeNote('Deliberate correction');
    await page.submit();
    expect(page.calls[3]!.data.subjectId).toBe(subjects[1]!.id);
    expect(page.calls[3]!.data.note).toBe('Deliberate correction');
    expect(page.calls[3]!.data.idempotencyKey).not.toBe(page.calls[2]!.data.idempotencyKey);
    await page.settle(3, { ok: false, reason: 'conflict' });
    expect(page.host.querySelector('[role="alert"]')!.textContent).toBe(page.m.library_collection_conflict());
    await page.changeNote('Correct again');
    await page.submit();
    expect(page.calls[4]!.data.idempotencyKey).not.toBe(page.calls[3]!.data.idempotencyKey);
    await page.settle(4, success);
    await page.reload(page.events, undefined, 3);
    expect(page.events.closes).toBe(3);
  });
});
