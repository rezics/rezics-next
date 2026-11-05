import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { CreatorEditorPageData, CreatorOfferMutation, CreatorOfferResult } from '../src/checkout/creator-offers';
import { configuredPriceExample } from '../src/kernel/fake/creator-offers';

// UNRUN at this delivery boundary. Constructed loader/session data and deferred BFF results
// exercise the production component and hooks, not native authorization, storage or browser behavior.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

const id = (n: number) => `019a2100-0000-7000-8000-${String(n).padStart(12, '0')}`;
type Viewer = {
  state: 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
  csrfToken: string | null;
  subject?: string | null;
};
const seller: Viewer = { state: 'signed-in', subject: id(80), csrfToken: 'current-seller-csrf' };
const first = {
  selling: true,
  csrfToken: 'loader-csrf',
  createKey: id(2),
  editor: {
    kind: 'ready',
    edition: {
      editionId: id(1),
      editionRevision: id(3),
      state: 'published',
      targetSubjectId: id(4),
      creatorAccountId: seller.subject!,
      revisionId: id(5),
      sha256: 'a'.repeat(64),
      licence: 'CC-BY-4.0',
    },
    schema: configuredPriceExample,
  },
} satisfies CreatorEditorPageData;
const second = {
  ...first,
  createKey: id(12),
  editor: {
    ...first.editor,
    kind: 'ready',
    edition: {
      ...first.editor.edition,
      editionId: id(11),
      editionRevision: id(13),
      revisionId: id(15),
      sha256: 'b'.repeat(64),
      licence: 'CC0-1.0',
    },
    schema: configuredPriceExample,
  },
} satisfies CreatorEditorPageData;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const staleResults: (CreatorOfferResult | Error)[] = [
  { kind: 'saved', id: id(90) },
  { kind: 'rejected' },
  { kind: 'retry' },
  new Error('The dispatched creation outcome is unknown'),
];

async function withEditor(run: (page: Awaited<ReturnType<typeof mountEditor>>) => Promise<void>) {
  const page = await mountEditor();
  try {
    await run(page);
  } finally {
    await page.dispose();
  }
}

async function mountEditor() {
  // Reuse the installed transitive DOM facility; do not add a test dependency.
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/creator/offers/new' });
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
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const offers = await import('../src/checkout/creator-offers');
  const { CreatorOfferEditor } = await import('../src/checkout/creator-offer-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: {
    data: CreatorOfferMutation;
    csrf: string | null;
    work: ReturnType<typeof deferred<CreatorOfferResult>>;
  }[] = [];
  const transport = spyOn(offers, 'manageCreatorOffer').mockImplementation((input) => {
    const work = deferred<CreatorOfferResult>();
    calls.push({ data: structuredClone(input.data), csrf: new Headers(input.headers).get('X-CSRF-Token'), work });
    return work.promise;
  });
  let mounted = true;
  const render = async (data: CreatorEditorPageData = first, viewer = seller, admitted = true, locale = 'en') => {
    await act(async () => {
      client.setQueryData(['session'], viewer);
      client.setQueryData(['exposure', 'viewer'], admitted ? ['selling'] : []);
      client.setQueryData(['exposure', 'anonymous'], []);
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <CreatorOfferEditor data={data} locale={locale} />
          </QueryClientProvider>
        </StrictMode>,
      );
    });
  };
  const field = (name: string) => host.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!;
  const form = () => host.querySelector('form')!;
  const action = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const saved = () => host.querySelector<HTMLAnchorElement>('a[href*="/offers/019"]');
  const change = async (name: string, value: string) => {
    await act(async () => {
      const node = field(name);
      const prototype =
        node.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
      node.dispatchEvent(new window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    });
  };
  const fill = async (title = 'Original title', price = '12.99', currency = 'usd', taxCode = 'txcd_10000000') => {
    await change('title', title);
    await change('currency', currency);
    await change('price', price);
    await change('taxCode', taxCode);
    expect(action().disabled).toBe(false);
  };
  const submit = async (twice = false) => {
    await act(async () => {
      // Dispatch directly to exercise the synchronous guard even before disabled state commits.
      const current = form();
      current.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      if (twice) current.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  const settle = async (index: number, result: CreatorOfferResult | Error) => {
    await act(async () => {
      if (result instanceof Error) calls[index]!.work.reject(result);
      else calls[index]!.work.resolve(result);
    });
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    mounted = false;
  };
  return {
    host,
    m,
    calls,
    render,
    field,
    form,
    action,
    saved,
    fill,
    change,
    submit,
    settle,
    unmount,
    async ssr() {
      const { renderToString } = await import('react-dom/server');
      return renderToString(
        <QueryClientProvider client={client}>
          <CreatorOfferEditor data={first} locale="en" />
        </QueryClientProvider>,
      );
    },
    async dispose() {
      if (mounted) await unmount();
      client.clear();
      transport.mockRestore();
      setLocale(previousLocale, { reload: false });
      host.remove();
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('Creator edition replacement cannot reuse another edition pending creation or display its completion', async () => {
  for (const result of staleResults)
    await withEditor(async (page) => {
      await page.render();
      await page.fill();
      const currency = page.field('currency');
      expect(currency.getAttribute('data-slot')).toBe('native-select');
      expect(currency.required).toBe(true);
      expect([...currency.querySelectorAll('option')].map((option) => option.getAttribute('value'))).toEqual([
        '',
        'usd',
        'eur',
      ]);
      await page.change('currency', 'eur');
      expect(page.field('price').value).toBe('');
      expect(page.field('currency').value).toBe('eur');
      await page.change('price', '12.99');
      await page.submit(true);
      expect(page.calls).toHaveLength(1);
      expect(page.calls[0]!.data.currency).toBe('eur');
      expect(page.field('currency').disabled).toBe(true);
      const original = page.calls[0]!.data;
      await page.render(second);
      if (second.editor.kind !== 'ready') throw new Error('Ready fixture');
      for (const value of [
        second.editor.edition.editionId,
        second.editor.edition.revisionId,
        second.editor.edition.sha256,
        second.editor.edition.licence,
      ])
        expect(page.host.textContent).toContain(value);
      expect(page.host.textContent).not.toContain(id(5));
      expect(page.field('title').value).toBe('');
      expect(page.field('currency').value).toBe('');
      expect(page.field('currency').disabled).toBe(false);
      expect(page.field('price').value).toBe('');
      expect(page.field('taxCode').value).toBe('');
      expect(page.saved()).toBeNull();
      await page.fill('Replacement title', '24.50', 'eur', 'replacement-tax');
      await page.submit(true);
      expect(page.calls).toHaveLength(2);
      expect(page.calls[1]!.data).toEqual({
        operation: 'create',
        contentEditionId: id(11),
        title: 'Replacement title',
        currency: 'eur',
        unitAmountMinor: 2450,
        taxCode: 'replacement-tax',
        idempotencyKey: expect.any(String),
      });
      expect(page.calls[1]!.data.idempotencyKey).not.toBe(original.idempotencyKey);
      await page.settle(0, result);
      expect(page.saved()).toBeNull();
      expect(page.host.querySelector('[role="alert"]')).toBeNull();
      expect(page.action().textContent).toBe(page.m.creator_saving());
      expect(page.field('title').disabled).toBe(true);
      await page.submit(true);
      expect(page.calls).toHaveLength(2); // Old finally must not unlock the replacement request.
      await page.settle(1, { kind: 'saved', id: id(91) });
      expect(page.saved()!.getAttribute('href')).toBe(`/en/offers/${id(91)}`);
      expect(page.host.textContent).not.toContain(id(90));
    });
});

test('observed viewer or admission loss retires creation even when the original authority returns', async () => {
  const changes: [Viewer, boolean, CreatorEditorPageData][] = [
    [{ ...seller, subject: id(81) }, true, first],
    [{ state: 'signed-out', csrfToken: null, subject: null }, true, first],
    [{ state: 'unknown', csrfToken: null }, true, first],
    [{ state: 'unavailable', csrfToken: null }, true, first],
    [{ ...seller, subject: null }, true, first],
    [{ ...seller, csrfToken: null }, true, first],
    [seller, false, first],
    [seller, true, { ...first, selling: false }],
    [seller, true, { ...first, csrfToken: '' }],
    [seller, true, { ...first, editor: { kind: 'denied' } }],
  ];
  for (const [viewer, admitted, data] of changes)
    await withEditor(async (page) => {
      await page.render();
      await page.fill();
      await page.submit();
      const oldKey = page.calls[0]!.data.idempotencyKey;
      await page.render(data, viewer, admitted);
      if (page.form()) {
        expect(page.field('title').value).toBe('');
        if (viewer.subject !== id(81)) {
          expect(page.action().disabled).toBe(true);
          await page.submit(true);
          expect(page.calls).toHaveLength(1);
        }
      }
      await page.render();
      expect(page.field('title').value).toBe('');
      await page.fill('Fresh lifetime');
      await page.submit();
      expect(page.calls).toHaveLength(2);
      expect(page.calls[1]!.data.idempotencyKey).not.toBe(oldKey);
      await page.settle(0, { kind: 'saved', id: id(90) });
      expect(page.saved()).toBeNull();
      expect(page.action().disabled).toBe(true);
      await page.submit();
      expect(page.calls).toHaveLength(2);
      await page.settle(1, { kind: 'saved', id: id(91) });
      expect(page.saved()!.getAttribute('href')).toContain(id(91));
    });
});

test('unmount retires saved, rejected, retry and thrown completions without replay', async () => {
  for (const result of staleResults)
    await withEditor(async (page) => {
      await page.render();
      await page.fill();
      await page.submit();
      await page.unmount();
      await page.settle(0, result);
      expect(page.host.textContent).toBe('');
      expect(page.calls).toHaveLength(1);
    });
});

test('same-edition refresh, schema, locale and nonempty CSRF rotation preserve exact uncertain intent until deliberate retry', async () => {
  for (const result of [{ kind: 'retry' } as const, new Error('Unknown outcome')])
    await withEditor(async (page) => {
      await page.render();
      await page.fill('  Captured title  ', '12.99', 'usd', '  captured-tax  ');
      const form = page.form();
      await page.submit(true);
      const original = structuredClone(page.calls[0]!.data);
      expect(original).toEqual({
        operation: 'create',
        contentEditionId: id(1),
        title: '  Captured title  ',
        currency: 'usd',
        unitAmountMinor: 1299,
        taxCode: '  captured-tax  ',
        idempotencyKey: expect.any(String),
      });
      const refreshed: CreatorEditorPageData = {
        ...first,
        createKey: id(99),
        csrfToken: 'rotated-loader-csrf',
        editor: {
          ...first.editor,
          edition: { ...first.editor.edition },
          schema: {
            ...configuredPriceExample,
            configuredSaleCurrencies: configuredPriceExample.configuredSaleCurrencies.filter(
              (row) => row.currency === 'eur',
            ),
          },
        },
      };
      await page.render(refreshed, { ...seller, csrfToken: 'rotated-session-csrf' }, true, 'fr');
      expect(page.form()).toBe(form);
      expect(page.field('currency').value).toBe('usd');
      expect(page.field('price').value).toBe('12.99');
      expect(page.host.textContent).not.toContain(page.m.creator_invalid_price());
      expect(page.calls).toHaveLength(1);
      await page.settle(0, result);
      expect(page.action().textContent).toBe(page.m.creator_retry());
      expect(page.field('title').disabled).toBe(true);
      await page.render({ ...refreshed }, { ...seller, csrfToken: 'latest-session-csrf' }, true, 'de');
      expect(page.form()).toBe(form);
      expect(page.calls).toHaveLength(1);
      await page.submit(true);
      expect(page.calls.map(({ data }) => data)).toEqual([original, original]);
      expect(page.calls.map(({ csrf }) => csrf)).toEqual([seller.csrfToken, 'latest-session-csrf']);
      await page.settle(1, { kind: 'saved', id: id(91) });
      expect(page.saved()!.getAttribute('href')).toBe(`/de/offers/${id(91)}`);
    });
});

test('terminal rejection permits a deliberate fresh intent; a healthy saved result and lock survive ordinary refresh', async () => {
  await withEditor(async (page) => {
    await page.render();
    await page.fill();
    await page.submit();
    await page.settle(0, { kind: 'rejected' });
    expect(page.field('title').disabled).toBe(false);
    expect(page.calls).toHaveLength(1);
    await page.fill('Revised title', '15.50', 'eur', 'revised-tax');
    await page.submit(true);
    expect(page.calls).toHaveLength(2);
    expect(page.calls[1]!.data).toEqual({
      operation: 'create',
      contentEditionId: id(1),
      title: 'Revised title',
      currency: 'eur',
      unitAmountMinor: 1550,
      taxCode: 'revised-tax',
      idempotencyKey: expect.any(String),
    });
    expect(page.calls[1]!.data.idempotencyKey).not.toBe(page.calls[0]!.data.idempotencyKey);
    await page.settle(1, { kind: 'saved', id: id(91) });
    const form = page.form();
    await page.render({ ...first, createKey: id(99) }, { ...seller, csrfToken: 'rotated' }, true, 'fr');
    expect(page.form()).toBe(form);
    expect(page.saved()!.getAttribute('href')).toBe(`/fr/offers/${id(91)}`);
    expect(page.field('title').value).toBe('Revised title');
    expect(page.field('title').disabled).toBe(true);
    await page.submit(true);
    expect(page.calls).toHaveLength(2);
    await page.render(first, { ...seller, subject: id(81) });
    expect(page.saved()).toBeNull();
    expect(page.field('title').value).toBe('');
    await page.render(second);
    expect(page.saved()).toBeNull();
    expect(page.field('title').value).toBe('');
  });
});

test('initial unknown hydration retains ready loader SSR and immutable metadata without client dispatch', async () => {
  await withEditor(async (page) => {
    await page.render(first, { state: 'unknown', csrfToken: null }, false);
    const markup = await page.ssr();
    for (const value of [id(1), id(5), 'a'.repeat(64), 'CC-BY-4.0']) {
      expect(markup).toContain(value);
      expect(page.host.textContent).toContain(value);
    }
    expect(markup).toContain('name="title"');
    expect(page.action().disabled).toBe(true);
    await page.submit(true);
    expect(page.calls).toHaveLength(0);
    await page.render();
    await page.fill();
    await page.submit();
    await page.settle(0, { kind: 'saved', id: id(91) });
    expect(page.saved()!.getAttribute('href')).toBe(`/en/offers/${id(91)}`);
  });
});
