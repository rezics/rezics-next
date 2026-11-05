import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, createElement } from 'react';
import type { ShelfOrigin } from '../src/library/personal-shelf-origin';

test('assign and unassign label search keeps raw drafts, validates normalized prefixes and retires stale choices', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  let viewer = 'owner';
  let exposed = true;
  let originActive = true;
  let selected = ['subject-a'];
  let defer = false;
  const reads: { query: string; cursor?: string }[] = [];
  const pending: { query: string; viewer: string; resolve: (page: unknown) => void }[] = [];
  const assignments: unknown[] = [];
  const context = createContext<ShelfOrigin | null>(null);
  const origin: ShelfOrigin = {
    current: () => originActive,
    viewer: () => viewer,
    capture: () => () => originActive,
    version: () => '0',
    watch: () => () => {},
    headers: () => new Headers(),
  };
  const page = (query: string, requestViewer: string) => ({
    state: 'loaded',
    labels: [{ id: `label-${query}`, name: query || 'Empty prefix', revision: 1 }],
    next: 'cursor',
    provenance: { viewer: requestViewer, query, cursor: undefined },
  });

  mock.module('../src/kernel/exposure', () => ({ useOperation: () => exposed }));
  mock.module('../src/session/query', () => ({ useSession: () => ({ state: 'signed-in', subject: viewer }) }));
  mock.module('../src/library/personal-shelf-origin', () => ({ PersonalShelfOrigin: context }));
  mock.module('../src/library/labels-actions', () => ({
    readSubjectLabelPage: ({ data }: { data: { query: string; cursor?: string } }) => {
      reads.push(data);
      if (defer) return new Promise((resolve) => pending.push({ query: data.query, viewer, resolve }));
      return Promise.resolve(page(data.query, viewer));
    },
  }));
  mock.module('../src/library/subject-labels.tsx', () => ({
    labelReadMessage: () => false,
    SubjectLabelMore: () => null,
    SubjectLabelReadNotice: () => null,
  }));

  const { ShelfLabelAction } = await import('../src/library/shelf-labels');
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const controls = {
    get selected() {
      return selected;
    },
    get labelWriteAdmitted() {
      return exposed;
    },
    get labelRemoveAdmitted() {
      return exposed;
    },
    pending: false,
    labelSelectionBlocked: false,
    labelVersion: 0,
    labelSelectionIdentity: 'selection',
    labelEpoch: 0,
    captureLabel: () => () => originActive,
    assignSelectedLabel: (label: unknown) => assignments.push(label),
  };
  let root: ReturnType<typeof createRoot>;
  let kind: 'assign' | 'unassign' = 'assign';
  const render = () =>
    root.render(
      createElement(
        context.Provider,
        { value: origin },
        createElement(ShelfLabelAction, { controls: controls as never, kind }),
      ),
    );
  const settle = async () => act(async () => new Promise((resolve) => setTimeout(resolve, 280)));
  const edit = async (value: string) => {
    const input = host.querySelector('input')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    await act(async () => input.dispatchEvent(new window.Event('input', { bubbles: true })));
    return host.querySelector('input')!;
  };
  const open = async () => {
    await act(async () =>
      host.querySelector('button')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    );
  };
  const correction = (input: HTMLInputElement) => {
    const id = input.getAttribute('aria-describedby');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(id).toBeTruthy();
    expect(window.document.getElementById(id!)?.getAttribute('role')).toBe('alert');
  };

  try {
    for (kind of ['assign', 'unassign'] as const) {
      root = createRoot(host as unknown as HTMLElement);
      await act(async () => render());
      await open();

      const raw = '  e\u0301\u00a0  x  ';
      const input = await edit(raw);
      expect(input.value).toBe(raw);
      await settle();
      expect(reads.at(-1)).toEqual({ query: 'é x' });
      expect(input.value).toBe(raw);

      await act(async () =>
        host.querySelector('[role="checkbox"]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
      );
      const beforeInvalid = reads.length;
      for (const invalid of ['😀'.repeat(101), 'has\u0001control', 'lone\ud800surrogate']) {
        const draft = await edit(invalid);
        expect(draft.value).toBe(invalid);
        correction(draft);
        expect(host.querySelector('[role="checkbox"]')).toBeNull();
        expect((Array.from(host.querySelectorAll('button')).at(-1) as HTMLButtonElement).disabled).toBe(true);
      }
      await settle();
      expect(reads).toHaveLength(beforeInvalid);
      expect(reads.some(({ cursor }) => cursor !== undefined)).toBe(false);

      const nonBmp = '😀'.repeat(100);
      expect((await edit(nonBmp)).value).toBe(nonBmp);
      await settle();
      expect(reads.at(-1)).toEqual({ query: nonBmp });
      expect((await edit('')).value).toBe('');
      await settle();
      expect(reads.at(-1)).toEqual({ query: '' });
      await act(async () => root.unmount());
    }

    kind = 'assign';
    defer = true;
    root = createRoot(host as unknown as HTMLElement);
    await act(async () => render());
    await open();
    await edit('earlier');
    await settle();
    await edit('current');
    await settle();
    expect(pending.map(({ query }) => query)).toEqual(['earlier', 'current']);
    await act(async () => pending[0]!.resolve(page('earlier', 'owner')));
    expect(host.textContent).not.toContain('earlier');
    await act(async () => pending[1]!.resolve(page('current', 'owner')));
    expect(host.textContent).toContain('current');

    await act(async () => {
      selected = ['subject-b'];
      render();
    });
    expect(host.querySelector('[role="checkbox"]')).toBeNull();
    expect(assignments).toHaveLength(0);

    await edit('retire-viewer');
    await settle();
    viewer = 'other';
    await act(async () => render());
    await act(async () => pending.at(-1)!.resolve(page('retire-viewer', 'owner')));
    expect(host.textContent).not.toContain('retire-viewer');

    await edit('retire-exposure');
    viewer = 'other';
    exposed = true;
    await act(async () => render());
    await settle();
    exposed = false;
    await act(async () => render());
    await act(async () => pending.at(-1)!.resolve(page('retire-exposure', 'other')));
    expect(host.textContent).toBe('');
    expect(assignments).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    mock.restore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
