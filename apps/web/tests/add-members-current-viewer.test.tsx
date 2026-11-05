import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
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
const staleResults: (CollectionWriteResult | Error)[] = [
  success,
  { ok: false, reason: 'full' },
  { ok: false, reason: 'conflict' },
  new Error('The dispatched write outcome is unknown'),
];
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
  }: {
    collectionId?: string;
    session?: Viewer;
    admitted?: boolean;
    handlers?: ReturnType<typeof callbacks>;
    visible?: boolean;
  } = {}) => {
    await act(async () => {
      client.setQueryData(['session'], session);
      client.setQueryData(['exposure', 'viewer'], admitted ? ['collections'] : []);
      // Public admission must never authorize a signed-out add.
      client.setQueryData(['exposure', 'anonymous'], ['collections']);
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            {visible ? <CollectionAddMembers collectionId={collectionId} {...handlers} /> : null}
          </QueryClientProvider>
        </StrictMode>,
      );
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

test('Collection member additions retain their originating viewer and Collection lifetime', async () => {
  for (const boundary of ['viewer', 'collection'] as const)
    for (const result of staleResults)
      await withForm(async (page) => {
        await page.render();
        await page.choose();
        await page.changeNote('Originating note');
        await page.submit(true);
        expect(page.calls).toHaveLength(1);
        const next = callbacks();
        const replacement = {
          collectionId: boundary === 'collection' ? 'collection-two' : collection,
          session: viewer(boundary === 'viewer' ? 'viewer-two' : 'viewer-one'),
          handlers: next,
        };
        await page.render(replacement);
        expect(page.picker().value).toBe('');
        expect(page.note()).toBeNull();
        await page.choose(1);
        await page.changeNote('Replacement note');
        await page.submit();
        expect(page.calls).toHaveLength(2);
        expect(page.calls[1]!.data.collectionId).toBe(replacement.collectionId);
        expect(page.calls[1]!.data.idempotencyKey).not.toBe(page.calls[0]!.data.idempotencyKey);
        await page.settle(0, result);
        expect(page.events.reloads).toHaveLength(0);
        expect(next.reloads).toHaveLength(0);
        expect(page.events.closes + next.closes).toBe(0);
        expect(page.host.querySelector('[role="alert"]')).toBeNull();
        expect(page.note().value).toBe('Replacement note');
        expect(page.action().getAttribute('aria-busy')).toBe('true');
        await page.submit(true);
        expect(page.calls).toHaveLength(2); // The old finally cannot release the current synchronous lock.
        await page.settle(1, success);
        expect(next.reloads).toHaveLength(1);
        await page.reload(next);
        expect(next.closes).toBe(1);
      });
});

test('Authority loss and unmount retire pending work even when the same viewer returns', async () => {
  const losses = [
    { session: { state: 'unknown', subject: 'viewer-one', csrfToken: 'present' } satisfies Viewer },
    { session: { state: 'signed-out', subject: 'viewer-one', csrfToken: 'present' } satisfies Viewer },
    { session: { state: 'signed-in', csrfToken: 'present' } satisfies Viewer },
    { session: { state: 'signed-in', subject: '', csrfToken: 'present' } satisfies Viewer },
    { session: { ...viewer(), csrfToken: null } },
    { session: { ...viewer(), csrfToken: '' } },
    { admitted: false },
    { visible: false },
  ];
  for (const loss of losses)
    for (const result of [success, new Error('Late failure')])
      await withForm(async (page) => {
        await page.render();
        await page.choose();
        await page.submit();
        await page.render(loss);
        expect(page.form()).toBeNull();
        await page.render();
        expect(page.picker().value).toBe('');
        await page.choose();
        await page.submit();
        expect(page.calls).toHaveLength(2);
        expect(page.calls[1]!.data.idempotencyKey).not.toBe(page.calls[0]!.data.idempotencyKey);
        await page.settle(0, result);
        expect(page.events.reloads).toHaveLength(0);
        expect(page.events.closes).toBe(0);
        expect(page.host.querySelector('[role="alert"]')).toBeNull();
        expect(page.action().getAttribute('aria-busy')).toBe('true');
        await page.submit(true);
        expect(page.calls).toHaveLength(2);
        await page.settle(1, success);
        await page.reload();
        expect(page.events.closes).toBe(1);
      });
});

test('A reload already in flight cannot close, paint or unlock a replacement after it settles', async () => {
  for (const error of [undefined, new Error('Late reload failure')])
    await withForm(async (page) => {
      await page.render();
      await page.choose();
      await page.submit();
      await page.settle(0, success);
      expect(page.events.reloads).toHaveLength(1);
      const next = callbacks();
      await page.render({ session: viewer('viewer-two'), handlers: next });
      await page.choose();
      await page.submit();
      await page.reload(page.events, error);
      expect(page.events.closes + next.closes).toBe(0);
      expect(page.host.querySelector('[role="alert"]')).toBeNull();
      expect(page.action().getAttribute('aria-busy')).toBe('true');
      await page.submit(true);
      expect(page.calls).toHaveLength(2);
      await page.settle(1, success);
      await page.reload(next);
      expect(next.closes).toBe(1);
    });
});

test('An accepted add retries only its reload, preserving note and admission across ordinary refresh', async () => {
  await withForm(async (page) => {
    await page.render();
    await page.choose();
    await page.changeNote('Keep this exact note');
    await page.submit(true);
    await page.settle(0, success);
    await page.reload(page.events, new Error('Read unavailable'));
    expect(page.events.closes).toBe(0);
    expect(page.action().textContent).toBe(page.m.library_collection_reload());
    expect(page.host.querySelector('[role="alert"]')!.textContent).toBe(page.m.error_message());
    await page.render({ session: viewer('viewer-one', 'rotated-csrf') });
    expect(page.picker().disabled).toBe(true);
    expect(page.note().value).toBe('Keep this exact note');
    await page.submit(true);
    expect(page.calls).toHaveLength(1);
    expect(page.events.reloads).toHaveLength(2);
    await page.reload(page.events, undefined, 1);
    expect(page.events.closes).toBe(1);
    // Closing and deliberately adding the same existing subject creates a separate occurrence.
    await page.render({ visible: false });
    await page.render();
    await page.choose();
    await page.submit();
    expect(page.calls[1]!.data.subjectId).toBe(page.calls[0]!.data.subjectId);
    expect(page.calls[1]!.data.note).toBeNull();
    expect(page.calls[1]!.data.idempotencyKey).not.toBe(page.calls[0]!.data.idempotencyKey);
  });
});

test('Uncertain retries retain exact intent and key; explicit edits capture a new intent', async () => {
  await withForm(async (page) => {
    await page.render();
    await page.choose();
    await page.changeNote('  Exact note\n');
    await page.submit(true);
    const captured = page.calls[0]!.data;
    await page.render({ session: viewer('viewer-one', 'rotated-csrf') });
    expect(page.note().value).toBe('  Exact note\n');
    expect(page.action().getAttribute('aria-busy')).toBe('true');
    await page.settle(0, new Error('Response lost'));
    await page.render({ session: viewer('viewer-one', 'next-csrf') });
    await page.submit(true);
    expect(page.calls).toHaveLength(2);
    expect(page.calls[1]!.data).toEqual(captured);
    expect(page.calls[1]!.csrf).toBe('next-csrf');
    await page.settle(1, { ok: false, reason: 'unavailable' });
    await page.submit();
    expect(page.calls[2]!.data).toEqual(captured);
    await page.settle(2, { ok: false, reason: 'conflict' });
    expect(page.host.querySelector('[role="alert"]')!.textContent).toBe(page.m.library_collection_conflict());
    await page.changeNote('Deliberate edit');
    await page.submit();
    expect(page.calls[3]!.data).toMatchObject({
      ...captured,
      note: 'Deliberate edit',
      idempotencyKey: expect.any(String),
    });
    expect(page.calls[3]!.data.idempotencyKey).not.toBe(captured.idempotencyKey);
    await page.settle(3, { ok: false, reason: 'full' });
    expect(page.host.querySelector('[role="alert"]')!.textContent).toBe(page.m.library_collection_full());
    await page.choose(1);
    await page.submit();
    expect(page.calls[4]!.data.subjectId).toBe(subjects[1]!.id);
    expect(page.calls[4]!.data.note).toBe('Deliberate edit');
    expect(page.calls[4]!.data.idempotencyKey).not.toBe(page.calls[3]!.data.idempotencyKey);
    await page.settle(4, success);
    await page.reload();
    expect(page.events.closes).toBe(1);
  });
});
