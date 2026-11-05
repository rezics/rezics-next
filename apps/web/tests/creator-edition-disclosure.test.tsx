import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import type {
  CreatorEditorPageData,
  CreatorOfferGuard,
  CreatorOfferMutation,
  CreatorOfferResult,
} from '../src/checkout/creator-offers';
import { configuredPriceExample } from '../src/kernel/fake/creator-offers';

// Authored UNRUN. Supplied metadata and deferred BFF responses exercise the production form.
// Native authorization, browser keyboard/layout proof and integration remain controller obligations.
// Existing current-viewer/address/admission and refresh-recovery suites remain unchanged.
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
afterAll(() => mock.restore());

const offers = await import('../src/checkout/creator-offers');
const { CreatorOfferEditor } = await import('../src/checkout/creator-offer-editor');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const id = (n: number) => `019a2100-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ready = {
  selling: true,
  csrfToken: 'loader-token-is-not-the-current-token',
  createKey: id(6),
  editor: {
    kind: 'ready',
    edition: {
      editionId: id(1),
      editionRevision: id(2),
      state: 'published',
      targetSubjectId: id(3),
      creatorAccountId: id(4),
      revisionId: id(5),
      sha256: 'abcdef0123456789'.repeat(4),
      licence: 'CC-BY-4.0',
    },
    schema: configuredPriceExample,
  },
} satisfies CreatorEditorPageData;
const admitted: CreatorOfferGuard = { isCurrent: () => true, csrfToken: () => 'current-seller-token' };

async function staticSurface() {
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const window = new Window({ url: 'https://site.test/en/creator/offers/new' });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  return {
    host,
    show(data: CreatorEditorPageData = ready) {
      host.innerHTML = renderToStaticMarkup(<CreatorOfferEditor data={data} locale="en" guard={admitted} />);
      const ordinary = host.cloneNode(true);
      ordinary.querySelectorAll('details').forEach((details) => details.remove());
      return ordinary;
    },
    async close() {
      overwriteGetLocale(previousLocale);
      await window.happyDOM.close();
    },
  };
}

describe('Offer creation edition meaning precedes optional exact technical provenance', () => {
  test('fixed-version scope, literal licence and current rights lead; primary fields and action precede closed details', async () => {
    const page = await staticSurface();
    const before = JSON.stringify(ready);
    try {
      const ordinary = page.show();
      expect(ordinary.querySelector('h1')?.textContent).toBe(m.creator_new_offer());
      expect(ordinary.querySelector('h2')?.textContent).toBe(m.creator_edition());
      for (const fact of [m.creator_fixed_version(), m.creator_licence(), 'CC-BY-4.0', m.creator_current_rights()])
        expect(ordinary.textContent).toContain(fact);
      for (const value of [
        ready.editor.edition.editionId,
        ready.editor.edition.revisionId,
        ready.editor.edition.sha256,
      ])
        expect(ordinary.textContent).not.toContain(value);
      const details = page.host.querySelector('details')!;
      expect(details.hasAttribute('open')).toBe(false);
      expect(details.firstElementChild?.tagName).toBe('SUMMARY');
      expect(details.querySelector('summary')?.textContent).toBe(m.creator_edition_details_summary());
      // Native summary retains its keyboard semantics and marker without a custom role or tab override.
      expect(details.querySelector('summary')?.hasAttribute('role')).toBe(false);
      expect(details.querySelector('summary')?.hasAttribute('tabindex')).toBe(false);
      expect([...details.querySelectorAll('dt')].map((node) => node.textContent)).toEqual([
        m.creator_edition_details_edition_id(),
        m.creator_edition_details_revision_id(),
        m.creator_edition_details_digest(),
      ]);
      expect([...details.querySelectorAll('dd')].map((node) => node.textContent)).toEqual([
        ready.editor.edition.editionId,
        ready.editor.edition.revisionId,
        ready.editor.edition.sha256,
      ]);
      expect(details.textContent).not.toContain(m.creator_fixed_version());
      expect(details.textContent).not.toContain(m.creator_current_rights());
      expect(details.textContent).not.toContain(ready.editor.edition.licence);
      expect(page.host.querySelector('section')!.compareDocumentPosition(page.host.querySelector('form')!) & 4).toBe(4);
      expect(page.host.querySelector('form')!.compareDocumentPosition(details) & 4).toBe(4);
      expect(details.querySelector('input, select, button, form')).toBeNull();
      expect(
        [...page.host.querySelectorAll('input, select, button, summary')].map(
          (node) => node.getAttribute('name') ?? node.tagName,
        ),
      ).toEqual(['title', 'currency', 'price', 'taxCode', 'BUTTON', 'SUMMARY']);
      // This admitted metadata has no human title; the form must ask for one rather than invent it.
      expect(page.host.querySelector('input[name="title"]')?.getAttribute('value')).toBe('');
      for (const [name, label] of [
        ['title', m.creator_title()],
        ['taxCode', m.creator_tax_code()],
      ]) {
        const input = page.host.querySelector(`input[name="${name}"]`)!;
        expect(page.host.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(label);
      }
      expect(JSON.stringify(ready)).toBe(before);
    } finally {
      await page.close();
    }
  });

  test('unbroken digest and long declared licence stay literal, selectable and contained without clamping', async () => {
    const page = await staticSurface();
    const licence = 'https://creativecommons.org/licenses/by/4.0/legalcode.en';
    try {
      page.show({ ...ready, editor: { ...ready.editor, edition: { ...ready.editor.edition, licence } } });
      const section = page.host.querySelector('section')!;
      expect(section.querySelector('dd')?.textContent).toBe(licence);
      expect(section.querySelector('dd')?.className).toContain('[overflow-wrap:anywhere]');
      const details = page.host.querySelector('details')!;
      expect(details.className).toContain('min-w-0');
      for (const value of details.querySelectorAll('dd')) {
        expect(value.className).toContain('break-all');
        expect(value.className).toContain('select-text');
        expect(value.className).not.toContain('truncate');
        expect(value.className).not.toContain('line-clamp');
      }
      expect(details.querySelectorAll('dd')[2]?.textContent).toBe(ready.editor.edition.sha256);
    } finally {
      await page.close();
    }
  });

  test('missing metadata, choose-edition and denied or closed reads do not manufacture edition terms or a create action', async () => {
    const page = await staticSurface();
    try {
      for (const [kind, notice] of [
        ['unavailable', m.creator_unavailable()],
        ['choose-edition', m.creator_choose_edition()],
        ['denied', m.creator_denied()],
        ['closed', m.creator_closed()],
        ['rejected', m.creator_rejected()],
      ] as const) {
        const ordinary = page.show({ ...ready, editor: { kind } });
        expect(ordinary.querySelector('[role="status"]')?.textContent).toContain(notice);
        expect(page.host.querySelector('form, details, input, button[type="submit"]')).toBeNull();
        for (const invented of [ready.editor.edition.licence, ready.editor.edition.sha256, m.creator_fixed_version()])
          expect(page.host.textContent).not.toContain(invented);
        expect(ordinary.querySelector('a[href="/en/editions/new"]')?.textContent).toBe(m.creator_publish_edition());
      }
    } finally {
      await page.close();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function withEditor(run: (page: Awaited<ReturnType<typeof mountEditor>>) => Promise<void>) {
  const page = await mountEditor();
  try {
    await run(page);
  } finally {
    await page.close();
  }
}

async function mountEditor() {
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
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let current = true;
  let token = 'current-seller-token';
  const guard: CreatorOfferGuard = { isCurrent: () => current, csrfToken: () => (current ? token : null) };
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
  const render = async (data: CreatorEditorPageData = ready, locale = 'en') => {
    await act(async () => {
      root.render(<CreatorOfferEditor data={data} locale={locale} guard={guard} />);
    });
  };
  const field = (name: string) => host.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!;
  const action = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const change = async (name: string, value: string) => {
    await act(async () => {
      const node = field(name);
      const prototype =
        node.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
      node.dispatchEvent(new window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    });
  };
  return {
    host,
    calls,
    render,
    field,
    action,
    rotateToken(value: string) {
      token = value;
    },
    retire() {
      current = false;
    },
    async fill() {
      await change('title', '  Exact original offer title  ');
      await change('currency', 'usd');
      await change('price', '12.99');
      await change('taxCode', '  txcd_10000000  ');
      expect(action().disabled).toBe(false);
    },
    async submit() {
      await act(async () => {
        const form = host.querySelector('form')!;
        for (let attempt = 0; attempt < 2; attempt++)
          form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
    },
    async settle(index: number, result: CreatorOfferResult | Error) {
      await act(async () => {
        if (result instanceof Error) calls[index]!.work.reject(result);
        else calls[index]!.work.resolve(result);
      });
    },
    async close() {
      await act(async () => root.unmount());
      transport.mockRestore();
      overwriteGetLocale(previousLocale);
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('disclosure and failed reads retain full draft, captured edition/rules and exact create operands through uncertain retry', async () => {
  for (const uncertain of [{ kind: 'retry' } as const, new Error('Original outcome unknown')])
    await withEditor(async (page) => {
      await page.render();
      await page.fill();
      const form = page.host.querySelector('form');
      const details = page.host.querySelector('details')!;
      // Browser keyboard activation is authored in the dedicated story; this tests native open-state independence.
      details.setAttribute('open', '');
      await page.render({ ...ready, createKey: id(60), editor: { kind: 'unavailable' } });
      expect(page.host.querySelector('form')).toBe(form);
      expect(page.field('title').value).toBe('  Exact original offer title  ');
      expect(page.field('currency').value).toBe('usd');
      expect(page.field('price').value).toBe('12.99');
      expect(page.field('taxCode').value).toBe('  txcd_10000000  ');
      expect(page.host.querySelector('details')).toBe(details);
      expect(details.hasAttribute('open')).toBe(true);
      expect(details.querySelectorAll('dd')[1]?.textContent).toBe(ready.editor.edition.revisionId);
      await page.submit();
      expect(page.calls).toHaveLength(1);
      const original = structuredClone(page.calls[0]!.data);
      expect(original).toEqual({
        operation: 'create',
        idempotencyKey: ready.createKey,
        contentEditionId: ready.editor.edition.editionId,
        title: '  Exact original offer title  ',
        currency: 'usd',
        unitAmountMinor: 1299,
        taxCode: '  txcd_10000000  ',
      });
      expect(page.calls[0]!.csrf).toBe('current-seller-token');
      const refreshed: CreatorEditorPageData = {
        ...ready,
        createKey: id(61),
        editor: {
          ...ready.editor,
          schema: {
            ...configuredPriceExample,
            configuredSaleCurrencies: configuredPriceExample.configuredSaleCurrencies.filter(
              (row) => row.currency === 'eur',
            ),
          },
        },
      };
      await page.render(refreshed, 'fr');
      await page.settle(0, uncertain);
      expect(page.action().textContent).toBe(m.creator_retry());
      expect(page.host.querySelector('[role="alert"]')?.textContent).toBe(m.creator_uncertain());
      for (const name of ['title', 'currency', 'price', 'taxCode']) expect(page.field(name).disabled).toBe(true);
      expect(page.field('currency').value).toBe('usd');
      expect(page.host.textContent).not.toContain(m.creator_invalid_price());
      expect([...details.querySelectorAll('dd')].map((node) => node.textContent)).toEqual([
        ready.editor.edition.editionId,
        ready.editor.edition.revisionId,
        ready.editor.edition.sha256,
      ]);
      details.removeAttribute('open');
      page.rotateToken('rotated-current-seller-token');
      await page.submit();
      expect(page.calls.map(({ data }) => data)).toEqual([original, original]);
      expect(page.calls.map(({ csrf }) => csrf)).toEqual(['current-seller-token', 'rotated-current-seller-token']);
      await page.settle(1, { kind: 'saved', id: id(90) });
      expect(page.host.querySelector('a[href="/fr/offers/' + id(90) + '"]')?.textContent).toBe(m.creator_view_offer());
      expect(page.host.querySelector('[role="status"]')?.textContent).toBe(m.creator_saved());
      expect(page.field('title').disabled).toBe(true);
      await page.submit();
      expect(page.calls).toHaveLength(2);
    });
});

test('retired authority blocks dispatch and rejects late saved, rejected, retry and thrown results with details open', async () => {
  await withEditor(async (page) => {
    await page.render();
    await page.fill();
    page.retire();
    await page.render();
    expect(page.action().disabled).toBe(true);
    await page.submit();
    expect(page.calls).toHaveLength(0);
  });
  for (const result of [
    { kind: 'saved', id: id(90) },
    { kind: 'rejected' },
    { kind: 'retry' },
    new Error('Late failure'),
  ] satisfies (CreatorOfferResult | Error)[])
    await withEditor(async (page) => {
      await page.render();
      await page.fill();
      page.host.querySelector('details')!.setAttribute('open', '');
      await page.submit();
      page.retire();
      await page.render();
      await page.settle(0, result);
      expect(page.host.querySelector('a[href*="/offers/' + id(90) + '"]')).toBeNull();
      expect(page.host.querySelector('[role="alert"], [role="status"]')).toBeNull();
      expect(page.action().disabled).toBe(true);
      await page.submit();
      expect(page.calls).toHaveLength(1);
    });
});
