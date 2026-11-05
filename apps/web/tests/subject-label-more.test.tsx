import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import type { readSubjectLabelPage } from '../src/library/labels-actions';
import type { SubjectLabelMore } from '../src/library/subject-labels.tsx';

type Page = Awaited<ReturnType<typeof readSubjectLabelPage>>;
type Props = ComponentProps<typeof SubjectLabelMore>;
type Request = { query: string; cursor?: string };
const page = (request: Request, id = 'native-row'): Page => ({
  state: 'loaded',
  labels: [{ id, name: id, revision: 1 }],
  next: 'next',
  provenance: { viewer: 'owner', csrfToken: null, ...request },
});

async function mountMore() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const reads: { data: Request; result: ReturnType<typeof Promise.withResolvers<Page>> }[] = [];
  const callbacks = { reenter: () => {} };
  mock.module('../src/library/labels-actions', () => ({
    readSubjectLabelPage: ({ data }: { data: Request }) => {
      const result = Promise.withResolvers<Page>();
      reads.push({ data, result });
      const reenter = callbacks.reenter;
      callbacks.reenter = () => {};
      reenter();
      return result.promise;
    },
  }));
  const { SubjectLabelMore } = await import('../src/library/subject-labels.tsx');
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const pages = mock<Props['onPage']>(() => {});
  return {
    reads,
    callbacks,
    pages,
    host,
    button: () => host.querySelector('button')!,
    click: () => host.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    render: (props: Partial<Props> = {}) =>
      act(async () => {
        root.render(<SubjectLabelMore query="prefix" next="opaque/+?=" onPage={pages} {...props} />);
      }),
    settle: (index: number, value: Page | Error = page(reads[index]!.data)) =>
      act(async () => {
        if (value instanceof Error) reads[index]!.result.reject(value);
        else reads[index]!.result.resolve(value);
      }),
    unmount: () => act(async () => root.render(null)),
    close: async () => {
      await act(async () => root.unmount());
      mock.restore();
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('admission and retry: same-turn reentry reads once; failure retries exactly and stale_cursor restarts explicitly', async () => {
  const ui = await mountMore();
  try {
    const query = '  e\u0301  ';
    await ui.render({ query });
    ui.callbacks.reenter = ui.click;
    await act(async () => {
      ui.click();
      ui.click();
    });
    expect(ui.reads).toHaveLength(1);
    expect(ui.reads[0]!.data).toEqual({ query, cursor: 'opaque/+?=' });
    expect(ui.button().disabled).toBe(true);
    await ui.settle(0, new Error('transport failed'));
    expect(ui.button().disabled).toBe(false);
    expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => {
      ui.click();
    });
    expect(ui.reads[1]!.data).toEqual(ui.reads[0]!.data);
    await ui.settle(1, { state: 'unavailable', labels: [], reason: 'stale_cursor' });
    expect(ui.reads).toHaveLength(2);
    await act(async () => {
      ui.click();
    });
    expect(ui.reads[2]!.data).toEqual({ query });
    const native = page(ui.reads[2]!.data);
    await ui.settle(2, native);
    expect(ui.pages.mock.calls).toEqual([[native]]);
    expect(ui.button().disabled).toBe(false);
    await ui.render({ next: null });
    expect(ui.host.querySelector('button')).toBeNull();
  } finally {
    await ui.close();
  }
});

test('lifetime: replacement, unmount and owner refusal discard late results without releasing a newer read', async () => {
  const ui = await mountMore();
  try {
    for (const replacement of [{ query: 'other' }, { next: 'other-cursor' }]) {
      for (const fails of [false, true]) {
        await ui.render();
        await act(async () => {
          ui.click();
        });
        const old = ui.reads.length - 1;
        await ui.render(replacement);
        await act(async () => {
          ui.click();
        });
        const newer = ui.reads.length - 1;
        expect(newer).toBe(old + 1);
        await ui.settle(old, fails ? new Error('late failure') : page(ui.reads[old]!.data, 'late'));
        expect(ui.button().disabled).toBe(true);
        expect(ui.host.querySelector('[role="alert"]')).toBeNull();
        expect(ui.pages).not.toHaveBeenCalled();
        await ui.settle(newer);
        expect(ui.pages.mock.calls).toEqual([[page(ui.reads[newer]!.data)]]);
        ui.pages.mockClear();
      }
    }
    for (const fails of [false, true]) {
      await ui.render();
      await act(async () => {
        ui.click();
      });
      const old = ui.reads.length - 1;
      await ui.unmount();
      await ui.render();
      await act(async () => {
        ui.click();
      });
      await ui.settle(old, fails ? new Error('unmounted failure') : page(ui.reads[old]!.data));
      expect(ui.button().disabled).toBe(true);
      expect(ui.pages).not.toHaveBeenCalled();
      await ui.settle(old + 1);
      ui.pages.mockClear();
      await ui.unmount();
    }
    let current = true;
    await ui.render({ isCurrent: () => current });
    await act(async () => {
      ui.click();
    });
    current = false;
    await ui.settle(ui.reads.length - 1);
    expect(ui.pages).not.toHaveBeenCalled();
    expect(ui.host.querySelector('[role="alert"]')).toBeNull();
    await ui.render({
      next: 'fresh',
      acceptPage: (result, request) =>
        result.provenance?.viewer === 'owner' &&
        result.provenance.query === request.query &&
        result.provenance.cursor === request.cursor,
    });
    await act(async () => {
      ui.click();
    });
    await ui.settle(ui.reads.length - 1, {
      ...page(ui.reads.at(-1)!.data),
      provenance: { viewer: 'other', csrfToken: null, query: 'prefix', cursor: 'fresh' },
    });
    expect(ui.pages).not.toHaveBeenCalled();
    expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(ui.button().disabled).toBe(false);
  } finally {
    await ui.close();
  }
});
