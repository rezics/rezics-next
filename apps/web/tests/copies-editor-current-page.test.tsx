import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, useContext, useLayoutEffect, type ReactNode } from 'react';
import type { CopiesPageData, CopyItem, CopyRemoved } from '../src/library/copies-read';
import { m } from '../src/paraglide/messages.js';

// Mounted production forms and ResponsiveDialog; native admission and rendered acceptance remain separate.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/copies' });
const mediaQueries = new Set<ReturnType<typeof window.matchMedia>>();
const matchMedia = window.matchMedia.bind(window);
window.matchMedia = (query: string) => {
  const media = matchMedia(query);
  mediaQueries.add(media);
  return media;
};
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  scrollTo: window.scrollTo.bind(window),
  Element: window.Element,
  Node: window.Node,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

type Operation = 'create' | 'update' | 'delete' | 'undo' | 'subject' | 'detail';
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Call = ReturnType<typeof deferred> & { input: unknown };
const calls: Record<Operation, Call[]> = { create: [], update: [], delete: [], undo: [], subject: [], detail: [] };
const transport = (operation: Operation) => (input: unknown) => {
  const call = { ...deferred(), input };
  calls[operation].push(call);
  return call.promise;
};
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/library/copies-actions', () => ({
  createCopy: transport('create'),
  updateCopy: transport('update'),
  deleteCopy: transport('delete'),
  undoCopy: transport('undo'),
  readCopySubject: transport('subject'),
  readCopyDetail: transport('detail'),
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': 'current-session' }) }));
mock.module('../src/kernel/exposure', () => ({ Exposure: ({ children }: { children: ReactNode }) => children }));
const router = await import('@tanstack/react-router');
const actualRouter = { ...router };
mock.module('@tanstack/react-router', () => ({
  ...actualRouter,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
// Keep the public ResponsiveDialog and its stable portal real. The primitive boundary
// exposes native dismissal callbacks without claiming a browser interaction pass.
type Shell = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: ((open: boolean) => void) | undefined;
  finalFocus?: (() => HTMLElement | false) | undefined;
  children: ReactNode;
};
const shells: (Shell & { mobile: boolean })[] = [];
const focusTargets: (() => HTMLElement | false)[] = [];
const Dismiss = createContext<(open: boolean) => void>(() => {});
function ShellRoot(props: Shell & { mobile: boolean }) {
  shells.push(props);
  useLayoutEffect(() => {
    if (!props.open) {
      const target = props.finalFocus?.();
      if (target && target.isConnected) target.focus();
      props.onOpenChangeComplete?.(false);
    }
  }, [props.open]);
  return props.open ? (
    <Dismiss.Provider value={props.onOpenChange}>
      <div role="dialog" data-mobile={props.mobile}>
        {props.children}
      </div>
    </Dismiss.Provider>
  ) : null;
}
function Close({ children }: { children: ReactNode }) {
  const dismiss = useContext(Dismiss);
  return (
    <button type="button" onClick={() => dismiss(false)}>
      {children}
    </button>
  );
}
function Content({ children, finalFocus }: { children: ReactNode; finalFocus?: () => HTMLElement | false }) {
  if (finalFocus) focusTargets.push(finalFocus);
  useLayoutEffect(
    () => () => {
      const target = finalFocus?.();
      if (target && target.isConnected) target.focus();
    },
    [],
  );
  return <div>{children}</div>;
}
mock.module('@rezics/ui/shadcn/dialog', () => ({
  Dialog: (props: Shell) => <ShellRoot {...props} mobile={false} />,
  DialogContent: Content,
  DialogHeader: Part,
  DialogTitle: Part,
  DialogDescription: Part,
  DialogClose: Close,
}));
mock.module('@rezics/ui/bottom-sheet', () => ({
  BottomSheet: (props: Shell & { closeLabel: string }) => (
    <ShellRoot {...props} mobile>
      <Close>{props.closeLabel}</Close>
      {props.children}
    </ShellRoot>
  ),
}));
mock.module('@rezics/ui/menu', () => ({
  Menu: ({ entries }: { entries: { label: string; onSelect: () => void }[] }) => (
    <>
      {entries.map((entry) => (
        <button key={entry.label} onClick={entry.onSelect}>
          {entry.label}
        </button>
      ))}
    </>
  ),
}));
const { CopyEditionPicker: ActualEditionPicker } = await import('../src/library/copy-edition-picker');
mock.module('../src/library/copy-edition-picker', () => ({
  CopyEditionPicker: ({
    disabled,
    onChange,
  }: {
    disabled: boolean;
    onChange: (subject: { id: string; title: string; types: string[] } | null) => void;
  }) => (
    <select
      aria-label={m.library_copy_edition()}
      disabled={disabled}
      defaultValue=""
      onChange={(event) => {
        const id = event.currentTarget.value;
        onChange(id ? { id, title: id, types: [] } : null);
      }}
    >
      <option value="" />
      <option value="edition-a">A</option>
      <option value="edition-b">B</option>
    </select>
  ),
}));
const { createRoot } = await import('react-dom/client');
const { CopiesPage, CopyForm } = await import('../src/library/copies-page');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let contextRouter: ReturnType<typeof router.createRouter>;
beforeEach(() => {
  for (const requests of Object.values(calls)) requests.length = 0;
  shells.length = 0;
  focusTargets.length = 0;
  mediaQueries.clear();
  window.happyDOM.setWindowSize({ width: 1440, height: 900 });
  contextRouter = router.createRouter({ routeTree: router.createRootRoute(), history: router.createMemoryHistory() });
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  contextRouter.history.destroy();
});
afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
  mock.module('@tanstack/react-router', () => actualRouter);
  mock.module('../src/library/copy-edition-picker', () => ({ CopyEditionPicker: ActualEditionPicker }));
});

const profile = { kinds: [{ id: 'physical', label: 'Physical', statuses: [{ id: 'owned', label: 'Owned' }] }] };
const item = (note = 'Original', id = crypto.randomUUID()): CopyItem => ({
  id,
  revision: 3,
  kind: 'physical',
  status: 'historic',
  kindLabel: 'Accepted kind',
  statusLabel: 'Accepted status',
  meaning: 'unknown',
  statusEditing: { state: 'unsupported' },
  location: 'Study',
  source: null,
  acquiredOn: null,
  disposedOn: null,
  note,
  subject: null,
  idempotencyKey: crypto.randomUUID(),
});
const pageOf = (...copies: CopyItem[]): CopiesPageData => ({
  signedIn: true,
  copies,
  subjectId: 'edition-a',
  next: null,
  addKey: crypto.randomUUID(),
  profile,
  sendKind: true,
});
const receipt = (): CopyRemoved => ({ ok: true, undo: { deletionId: crypto.randomUUID(), revision: 4 } });
const latest = (operation: Operation) => calls[operation].at(-1)!;
const render = (page: CopiesPageData) =>
  act(async () =>
    root.render(
      <router.RouterContextProvider router={contextRouter}>
        <CopiesPage page={page} />
      </router.RouterContextProvider>,
    ),
  );
const form = () => host.querySelector<HTMLFormElement>('[role="dialog"] form')!;
const button = (name: string, region: ParentNode = host) => {
  const control = [...region.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
  expect(control, `Missing ${name} in ${region.textContent}`).toBeDefined();
  return control!;
};
const click = (name: string, region: ParentNode = host) => act(async () => button(name, region).click());
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-slot="list-row"]')];
const row = (note: string) => rows().find((node) => node.textContent?.includes(note))!;
const settle = (call: Call, value: unknown) =>
  act(async () => {
    call.resolve(value);
  });
const reject = (call: Call) =>
  act(async () => {
    call.reject(new Error('uncertain transport outcome'));
  });
const submit = (twice = false) =>
  act(async () => {
    const current = form();
    current.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    if (twice) current.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
async function edit(copy: CopyItem) {
  await click(m.library_copy_edit(), row(copy.note!));
  await settle(latest('detail'), { ok: true, copy });
}
async function start(operation: 'create' | 'update' | 'delete', copy: CopyItem) {
  if (operation === 'create') await click(m.library_copy_add());
  else await edit(copy);
  if (operation === 'delete') {
    await click(m.library_copy_delete(), form());
    await act(async () => {
      const confirm = button(m.library_copy_delete_confirm(), form());
      confirm.click();
      confirm.click();
    });
  } else await submit(true);
  expect(calls[operation]).toHaveLength(1);
  return latest(operation);
}
async function remove(copy: CopyItem, result = receipt()) {
  await edit(copy);
  await click(m.library_copy_delete(), form());
  await click(m.library_copy_delete_confirm(), form());
  await settle(latest('delete'), result);
  return result;
}
function field(label: string) {
  const fieldLabel = [...form().querySelectorAll('label')].find((node) => node.textContent === label)!;
  return window.document.getElementById(fieldLabel.htmlFor)! as HTMLInputElement;
}
async function text(label: string, value: string) {
  const input = field(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

describe('Late Copy editor and Undo responses cannot modify a replacement page or close a newer editor', () => {
  for (const boundary of ['replacement page'] as const) {
    for (const operation of ['create', 'update', 'delete'] as const) {
      for (const outcome of ['success', 'refusal', 'rejection'] as const) {
        test(`Late Copy ${operation} ${outcome} cannot affect a newer editor after ${boundary}`, async () => {
          const original = item();
          const page = pageOf(original);
          await render(page);
          const old = await start(operation, original);
          const replacement = item('Replacement', original.id);
          await render(pageOf(replacement));
          await click(m.library_copy_add());
          const current = form();
          const key = current.dataset.idempotencyKey;
          await submit();
          const pending = latest('create');
          if (outcome === 'rejection') await reject(old);
          else
            await settle(
              old,
              outcome === 'refusal'
                ? { ok: false, reason: 'conflict' }
                : operation === 'delete'
                  ? receipt()
                  : { ok: true, copy: { ...original, revision: 4, note: 'Late write' } },
            );
          expect(form()).toBe(current);
          expect(form().dataset.idempotencyKey).toBe(key);
          expect(button(m.library_copy_add_submit(), current).disabled).toBe(true);
          expect(current.querySelector('[role="alert"]')).toBeNull();
          expect(rows()).toHaveLength(1);
          expect(rows()[0]!.textContent).toContain('Replacement');
          expect(rows()[0]!.textContent).not.toContain('Late write');
          expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.editor_undo())).toBe(false);
          await settle(pending, { ok: false, reason: 'invalid' });
          expect(button(m.library_copy_add_submit(), current).disabled).toBe(false);
        });
      }
    }
  }

  test('Same-page create preserves rerender drafts and keys, suppresses duplicates and rotates only after success', async () => {
    const page = pageOf(item());
    await render(page);
    await click(m.library_copy_add());
    await click(m.library_copy_more(), form());
    await text(m.library_copy_note(), 'Another copy of the same edition');
    const current = form();
    await render(page);
    expect(form()).toBe(current);
    expect(field(m.library_copy_note()).value).toBe('Another copy of the same edition');
    await submit(true);
    expect(calls.create).toHaveLength(1);
    const payload = {
      data: {
        subjectId: 'edition-a',
        idempotencyKey: page.addKey,
        kind: 'physical',
        status: 'owned',
        location: null,
        source: null,
        acquiredOn: null,
        disposedOn: null,
        note: 'Another copy of the same edition',
      },
      headers: new Headers({ 'x-csrf-token': 'current-session' }),
    };
    expect(latest('create').input).toEqual(payload);
    await reject(latest('create'));
    expect(form()).toBe(current);
    await submit();
    expect(latest('create').input).toEqual(payload);
    await settle(latest('create'), { ok: true, copy: { ...item('Added'), status: 'owned', revision: 1 } });
    expect(form()).toBeNull();
    expect(rows()).toHaveLength(2);
    expect(row('Added')).toBeDefined();
    await click(m.library_copy_add());
    expect(form().dataset.idempotencyKey).not.toBe(page.addKey);
  });

  test('Same-page save, delete and Undo retain exact native identities, CAS, evidence and same-intent keys', async () => {
    const copy = item();
    const page = pageOf(copy);
    await render(page);
    await edit(copy);
    await click(m.library_copy_more(), form());
    await text(m.library_copy_note(), 'Saved');
    await submit(true);
    const payload = {
      data: {
        id: copy.id,
        revision: 3,
        idempotencyKey: copy.idempotencyKey,
        location: 'Study',
        source: null,
        acquiredOn: null,
        disposedOn: null,
        note: 'Saved',
      },
      headers: new Headers({ 'x-csrf-token': 'current-session' }),
    };
    expect(calls.update).toHaveLength(1);
    expect(latest('update').input).toEqual(payload); // An unchanged historical status is omitted.
    await settle(latest('update'), { ok: false, reason: 'conflict' });
    await render(page);
    await submit();
    expect(calls.update).toHaveLength(1);
    await click(m.library_copy_conflict_review_open(), form());
    await settle(latest('detail'), { ok: true, copy });
    await click(m.library_copy_conflict_review_accept(), form());
    await click(m.library_copy_draft_navigation_discard(), window.document);
    // Accepting the reviewed read resets values inside the same disclosed form.
    expect(field(m.library_copy_note()).value).toBe(copy.note!);
    await text(m.library_copy_note(), 'Saved');
    await submit();
    expect(latest('update').input).toMatchObject({ data: { ...payload.data, idempotencyKey: expect.any(String) } });
    expect((latest('update').input as typeof payload).data.idempotencyKey).not.toBe(copy.idempotencyKey);
    const saved = { ...copy, note: 'Saved', revision: 4, idempotencyKey: crypto.randomUUID() };
    await settle(latest('update'), { ok: true, copy: saved });
    expect(row('Saved').textContent).toContain('Accepted status');
    await click(m.library_copy_edit(), row('Saved'));
    expect(form().dataset.idempotencyKey).not.toBe(copy.idempotencyKey);
    await settle(latest('detail'), { ok: true, copy: saved });
    await click(m.library_copy_delete(), form());
    // Submit and delete share one synchronous mutation lock.
    await act(async () => {
      button(m.library_copy_delete_confirm(), form()).click();
      form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(calls.update).toHaveLength(2);
    expect(latest('delete').input).toEqual({
      data: { id: copy.id, revision: 4, idempotencyKey: saved.idempotencyKey },
      headers: new Headers({ 'x-csrf-token': 'current-session' }),
    });
    const deleted = receipt();
    await settle(latest('delete'), deleted);
    expect(rows()).toHaveLength(0);
    await click(m.editor_undo());
    const undo = latest('undo').input;
    expect(undo).toMatchObject({
      data: { id: copy.id, ...deleted.undo },
      headers: new Headers({ 'x-csrf-token': 'current-session' }),
    });
    await reject(latest('undo'));
    await click(m.editor_undo());
    expect(latest('undo').input).toEqual(undo);
    await settle(latest('undo'), { ok: true, copy: { ...saved, revision: 5 } });
    expect(rows()).toHaveLength(1);
    expect(row('Saved').textContent).toContain('Accepted status');
    expect(calls.create).toHaveLength(0);
  });

  for (const outcome of ['success', 'refusal', 'rejection'] as const) {
    test(`An old Undo ${outcome} cannot insert into a replacement page or clear/unlock its newer Undo`, async () => {
      const original = item();
      await render(pageOf(original));
      await remove(original);
      await click(m.editor_undo());
      const old = latest('undo');
      const replacement = item('Replacement');
      await render(pageOf(replacement));
      expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.editor_undo())).toBe(false);
      await remove(replacement);
      await click(m.editor_undo());
      const current = latest('undo');
      if (outcome === 'rejection') await reject(old);
      else
        await settle(
          old,
          outcome === 'refusal' ? { ok: false, reason: 'conflict' } : { ok: true, copy: { ...original, revision: 5 } },
        );
      expect(rows()).toHaveLength(0);
      expect(button(m.editor_undo()).disabled).toBe(true);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      await settle(current, { ok: true, copy: { ...replacement, revision: 5 } });
      expect(rows()).toHaveLength(1);
      expect(row('Replacement')).toBeDefined();
    });
  }

  test('An earlier same-page restore keeps a newer removal and its pending Undo intact', async () => {
    const first = item('First');
    const second = item('Second');
    await render(pageOf(first, second));
    await remove(first);
    await click(m.editor_undo());
    const old = latest('undo');
    await remove(second);
    await click(m.editor_undo());
    const current = latest('undo');
    await settle(old, { ok: true, copy: { ...first, revision: 5 } });
    expect(row('First')).toBeDefined();
    expect(row('Second')).toBeUndefined();
    expect(button(m.editor_undo()).disabled).toBe(true);
    await settle(current, { ok: true, copy: { ...second, revision: 5 } });
    expect(rows()).toHaveLength(2);
  });

  test('Only the latest live edition lookup binds a create; closed lookups cannot certify a newer editor', async () => {
    await render({ ...pageOf(), subjectId: null });
    await click(m.library_copy_add());
    const choose = (id: string) =>
      act(async () => {
        const picker = form().querySelector<HTMLSelectElement>(`select[aria-label="${m.library_copy_edition()}"]`)!;
        picker.value = id;
        picker.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
    const ready = (id: string) => ({
      state: 'ready',
      subject: { id, type: 'book', types: [], label: id, cover: null },
      profile,
    });
    await choose('edition-a');
    const first = latest('subject');
    await choose('edition-b');
    const second = latest('subject');
    await settle(first, ready('edition-a'));
    await submit();
    expect(calls.create).toHaveLength(0);
    await click(m.library_copy_cancel(), form());
    await click(m.library_copy_draft_navigation_discard(), window.document);
    await click(m.library_copy_add());
    await choose('edition-a');
    const current = latest('subject');
    await settle(second, ready('edition-b'));
    await submit();
    expect(calls.create).toHaveLength(0);
    await settle(current, ready('edition-a'));
    await submit(true);
    expect(calls.create).toHaveLength(1);
    expect(latest('create').input).toMatchObject({
      data: { subjectId: 'edition-a', kind: 'physical', status: 'owned' },
    });
  });

  test('Latest inspection wins, and late denial/failure cannot replace an add editor or strip replacement presentation', async () => {
    const first = item('First');
    const second = item('Second');
    await render(pageOf(first, second));
    await click(m.library_copy_edit(), row('First'));
    const old = latest('detail');
    await click(m.library_copy_edit(), row('Second'));
    await settle(latest('detail'), { ok: true, copy: second });
    await settle(old, { ok: false, reason: 'forbidden' });
    expect(row('First').textContent).toContain('Accepted status');
    expect(form().dataset.idempotencyKey).toBe(second.idempotencyKey);
    await click(m.library_copy_cancel(), form());
    await click(m.library_copy_edit(), row('First'));
    const closing = latest('detail');
    await click(m.library_copy_cancel(), form());
    await click(m.library_copy_add());
    const add = form();
    await reject(closing);
    expect(form()).toBe(add);
    expect(add.textContent).not.toContain(m.library_copy_detail_unavailable());
    await click(m.library_copy_cancel(), form());
    await click(m.library_copy_edit(), row('First'));
    const replacing = latest('detail');
    await render(pageOf({ ...first, note: 'Replacement' }));
    await click(m.library_copy_add());
    const replacementAdd = form();
    await settle(replacing, { ok: false, reason: 'forbidden' });
    expect(form()).toBe(replacementAdd);
    expect(row('Replacement').textContent).toContain('Accepted status');
  });

  for (const boundary of ['unmount'] as const) {
    for (const operation of ['create', 'update', 'delete'] as const) {
      test(`${operation} forms stop callbacks on ${boundary}, even before a parent unmounts a closed form`, async () => {
        const onCreated = mock(() => {});
        const onSaved = mock(() => {});
        const onRemoved = mock(() => {});
        const onKey = mock(() => {});
        const onClose = mock(() => {});
        const copy = item();
        await act(async () =>
          root.render(
            <CopyForm
              {...(operation === 'create' ? { profile } : { copy })}
              subjectId="edition-a"
              addKey={crypto.randomUUID()}
              onCreated={onCreated}
              onSaved={onSaved}
              onRemoved={onRemoved}
              onKey={onKey}
              onClose={onClose}
            />,
          ),
        );
        if (operation === 'delete') {
          await click(m.library_copy_delete(), form());
          await click(m.library_copy_delete_confirm(), form());
        } else await submit();
        await act(async () => shells.at(-1)!.onOpenChange(false));
        expect(window.document.body.textContent).toContain(m.library_copy_draft_navigation_pending());
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => root.render(null));
        await settle(latest(operation), operation === 'delete' ? receipt() : { ok: true, copy });
        for (const callback of [onCreated, onSaved, onRemoved, onKey]) expect(callback).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
      });
    }
  }
});

async function resize(width: number) {
  await act(async () => {
    window.happyDOM.setWindowSize({ width, height: 844 });
    for (const media of mediaQueries) media.dispatchEvent(new window.Event('change'));
  });
  await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
}

test('actual create and edit controls, validation and selection survive both presentations; replacement retires the form', async () => {
  const copy = item();
  const page = pageOf(copy);
  await render(page);
  for (const mode of ['create', 'edit'] as const) {
    if (mode === 'create') await click(m.library_copy_add());
    else await edit(copy);
    await click(m.library_copy_more(), form());
    await text(m.library_copy_location(), '📚'.repeat(201));
    const current = form();
    const input = field(m.library_copy_location());
    await click(m.library_copy_less(), current);
    await submit();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(window.document.activeElement).toBe(input);
    expect(input.closest('[hidden]')).toBeNull();
    await click(m.library_copy_less(), current);
    await act(async () => current.querySelector<HTMLAnchorElement>(`a[href="#${input.id}"]`)!.click());
    expect(window.document.activeElement).toBe(input);
    input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true, data: '📚' }));
    input.setSelectionRange(2, 6, 'backward');
    const key = current.dataset.idempotencyKey;
    for (const width of [390, 1440, 390]) {
      await resize(width);
      expect(shells.at(-1)!.mobile).toBe(width < 768);
      expect(form()).toBe(current);
      expect(field(m.library_copy_location())).toBe(input);
      expect(window.document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 6, 'backward']);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(current.dataset.idempotencyKey).toBe(key);
    }
    input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true, data: '📚' }));
    expect(calls[mode === 'create' ? 'create' : 'update']).toHaveLength(0);
    await render(pageOf(copy));
    expect(current.isConnected).toBe(false);
  }
});

test('presentation changes retain conflict review and pending/uncertain intent including original credentials', async () => {
  const copy = item();
  await render(pageOf(copy));
  await edit(copy);
  await submit();
  await resize(390);
  const current = form();
  await settle(latest('update'), { ok: false, reason: 'conflict' });
  await click(m.library_copy_conflict_review_open(), current);
  const reviewed = { ...copy, revision: 9, note: 'Explicitly reviewed' };
  await settle(latest('detail'), { ok: true, copy: reviewed });
  await resize(1440);
  expect(form()).toBe(current);
  expect(current.textContent).toContain('Explicitly reviewed');
  expect(current.dataset.idempotencyKey).toBe(copy.idempotencyKey);
  await click(m.library_copy_conflict_review_accept(), current);
  await submit();
  const original = latest('update').input;
  await resize(390);
  await reject(latest('update'));
  await click(m.library_copy_more(), current);
  await text(m.library_copy_source(), 'Later visible edit');
  await resize(1440);
  await submit();
  expect(latest('update').input).toEqual(original);
  expect((original as { data: { revision: number } }).data.revision).toBe(9);
  expect(current.textContent).toContain(m.library_copy_editor_pending());
});

test('shell dismissal uses the draft decision; completed close returns only to a current connected inventory launcher', async () => {
  const copy = item();
  await render(pageOf(copy));
  const launcher = button(m.library_copy_add());
  launcher.focus();
  await click(m.library_copy_add());
  await click(m.library_copy_more(), form());
  await text(m.library_copy_location(), 'Draft');
  const oldShell = shells.at(-1)!;
  const oldFocus = focusTargets.at(-1)!;
  await act(async () => oldShell.onOpenChange(false));
  expect(form()).not.toBeNull();
  await click(m.library_copy_draft_navigation_discard(), window.document);
  expect(form()).toBeNull();
  expect(window.document.activeElement).toBe(launcher);
  await click(m.library_copy_add());
  const newForm = form();
  await act(async () => {
    oldShell.onOpenChange(false);
    oldShell.onOpenChangeComplete?.(false);
  });
  expect(form()).toBe(newForm);
  await render(pageOf(copy));
  const replacementLauncher = button(m.library_copy_add());
  replacementLauncher.focus();
  expect(launcher.isConnected).toBe(false);
  expect(oldFocus()).toBe(false);
  expect(window.document.activeElement).toBe(replacementLauncher);
});

describe('Comparison handoff remains independent of native editor and Undo intents', () => {
  test('local controls do no I/O, exact Edit reads once, and comparison retains uncertain writes and Undo', async () => {
    const first = item('Compare first');
    const second = item('Compare second');
    await render(pageOf(first, second));
    await click(m.library_copy_compare_select(), row(first.note!));
    await click(m.library_copy_compare_select(), row(second.note!));
    await click(m.library_copy_compare_open());
    expect(Object.values(calls).flat()).toHaveLength(0);
    const card = () => host.querySelector<HTMLElement>(`article[data-copy-comparison-id="${first.id}"]`)!;
    await click(m.library_copy_compare_edit(), card());
    expect(calls.detail).toHaveLength(1);
    expect(latest('detail').input).toMatchObject({ data: { id: first.id } });
    await settle(latest('detail'), { ok: true, copy: first });
    await click(m.library_copy_more(), form());
    await text(m.library_copy_note(), 'Keep this exact draft');
    const editor = form();
    const key = editor.dataset.idempotencyKey;
    await submit();
    const submitted = latest('update');
    await reject(submitted);
    await click(m.library_copy_compare_reset());
    await click(m.library_copy_compare_close());
    await click(m.library_copy_compare_select(), row(second.note!));
    await click(m.library_copy_compare_open());
    expect(form()).toBe(editor);
    expect(editor.dataset.idempotencyKey).toBe(key);
    expect(field(m.library_copy_note()).value).toBe('Keep this exact draft');
    expect(host.textContent).toContain(m.library_copy_compare_editor_open());
    expect(button(m.library_copy_compare_edit(), host.querySelector('article')!).disabled).toBe(true);
    await click(m.library_copy_compare_return_editor());
    expect(calls.detail).toHaveLength(1);
    expect(calls.update).toHaveLength(1);
    expect(calls.undo).toHaveLength(0);
    await submit();
    expect(latest('update').input).toEqual(submitted.input);
    await settle(latest('update'), { ok: true, copy: { ...first, note: 'Keep this exact draft', revision: 4 } });
    await remove(second);
    const undo = button(m.editor_undo());
    await click(m.library_copy_compare_reset());
    await click(m.library_copy_compare_close());
    await click(m.library_copy_compare_open());
    expect(button(m.editor_undo())).toBe(undo);
    expect(calls.undo).toHaveLength(0);
    await click(m.editor_undo());
    const restore = latest('undo');
    await reject(restore);
    await click(m.library_copy_compare_reset());
    await click(m.library_copy_compare_close());
    await click(m.editor_undo());
    expect(latest('undo').input).toEqual(restore.input);
    await settle(latest('undo'), { ok: true, copy: { ...second, revision: 5 } });
    expect(host.querySelectorAll('article')).toHaveLength(0);
  });
});

for (const operation of ['create', 'delete'] as const) {
  test(`comparison preserves the exact original uncertain ${operation} intent`, async () => {
    const copy = item('Uncertain intent');
    await render(pageOf(copy));
    const captured = await start(operation, copy);
    await reject(captured);
    const editor = form();
    await click(m.library_copy_compare_select(), row(copy.note!));
    await click(m.library_copy_compare_open());
    await click(m.library_copy_compare_reset());
    await click(m.library_copy_compare_close());
    expect(form()).toBe(editor);
    expect(calls.detail).toHaveLength(operation === 'create' ? 0 : 1);
    expect(calls[operation]).toHaveLength(1);
    expect(calls.undo).toHaveLength(0);
    if (operation === 'create') await submit();
    else {
      await click(m.library_copy_delete(), form());
      await click(m.library_copy_delete_confirm(), form());
    }
    expect(latest(operation).input).toEqual(captured.input);
    await settle(latest(operation), { ok: false, reason: 'invalid' });
  });
}
