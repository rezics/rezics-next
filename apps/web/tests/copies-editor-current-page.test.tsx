import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { CopiesPageData, CopyItem, CopyRemoved } from '../src/library/copies-read';
import { m } from '../src/paraglide/messages.js';

// Mounted outcome regressions, deliberately left UNRUN at the source-only delivery boundary.
// Reuse Puck's installed DOM; presentation/admission and native services have their own acceptance.
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
mock.module('@tanstack/react-router', () => ({
  ...router,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
mock.module('@rezics/ui/shadcn/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogContent: Part,
  DialogHeader: Part,
  DialogTitle: Part,
}));
mock.module('@rezics/ui/bottom-sheet', () => ({
  BottomSheet: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
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
beforeEach(() => {
  for (const requests of Object.values(calls)) requests.length = 0;
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
});
afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
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
const render = (page: CopiesPageData) => act(async () => root.render(<CopiesPage page={page} />));
const form = () => host.querySelector<HTMLFormElement>('[role="dialog"] form')!;
const button = (name: string, region: ParentNode = host) => {
  const control = [...region.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
  expect(control).toBeDefined();
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
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

describe('Late Copy editor and Undo responses cannot modify a replacement page or close a newer editor', () => {
  for (const boundary of ['close/reopen', 'replacement page'] as const) {
    for (const operation of ['create', 'update', 'delete'] as const) {
      for (const outcome of ['success', 'refusal', 'rejection'] as const) {
        test(`Late Copy ${operation} ${outcome} cannot affect a newer editor after ${boundary}`, async () => {
          const original = item();
          const page = pageOf(original);
          await render(page);
          const old = await start(operation, original);
          const replacement = item('Replacement', original.id);
          if (boundary === 'close/reopen') await click(m.library_copy_cancel(), form());
          else await render(pageOf(replacement));
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
          expect(rows()[0]!.textContent).toContain(boundary === 'close/reopen' ? 'Original' : 'Replacement');
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
      headers: { 'x-csrf-token': 'current-session' },
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
      headers: { 'x-csrf-token': 'current-session' },
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
    await click(m.library_copy_more(), form());
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
      headers: { 'x-csrf-token': 'current-session' },
    });
    const deleted = receipt();
    await settle(latest('delete'), deleted);
    expect(rows()).toHaveLength(0);
    await click(m.editor_undo());
    const undo = latest('undo').input;
    expect(undo).toMatchObject({
      data: { id: copy.id, ...deleted.undo },
      headers: { 'x-csrf-token': 'current-session' },
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

  for (const boundary of ['close', 'unmount'] as const) {
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
        if (boundary === 'close') await click(m.library_copy_cancel(), form());
        else await act(async () => root.render(null));
        await settle(latest(operation), operation === 'delete' ? receipt() : { ok: true, copy });
        for (const callback of [onCreated, onSaved, onRemoved, onKey]) expect(callback).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(boundary === 'close' ? 1 : 0);
      });
    }
  }
});
