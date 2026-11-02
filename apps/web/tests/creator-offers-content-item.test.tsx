import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import type { CreatorOfferMutation, CreatorOfferResult, CreatorOffersPageData } from '../src/checkout/creator-offers';

// UNRUN: composed shared-UI assertions; acceptance, native and browser proof remain deferred.
test('Creator Offer shared items preserve admitted destinations independent controls and exact uncertain operations', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/creator/offers' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const calls: { data: CreatorOfferMutation; headers: { 'X-CSRF-Token': string } }[] = [];
  let result: CreatorOfferResult = { kind: 'retry' };
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
  mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
  mock.module('../src/checkout/creator-offers', () => ({
    manageCreatorOffer: async (input: (typeof calls)[number]) => {
      calls.push(input);
      return result;
    },
  }));
  const { createRoot } = await import('react-dom/client');
  const { CreatorOffersPage } = await import('../src/checkout/creator-offers-page');
  const { creatorOfferFixture, delistedCreatorOfferFixture, configuredPriceExample } =
    await import('../src/kernel/fake/creator-offers');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document });
  const first = { ...creatorOfferFixture, title: 'Captured title / '.repeat(12) + '無空白の長い題名'.repeat(16) };
  const second = {
    ...creatorOfferFixture,
    id: '019a2100-0000-7000-8000-220000000099',
    title: 'Another captured offer',
  };
  const historical = { ...delistedCreatorOfferFixture };
  delete historical.moneyUnit;
  const data: CreatorOffersPageData = {
    page: { kind: 'ready', offers: [first, second, historical], next: null },
    schema: configuredPriceExample,
    csrfToken: 'current-csrf',
    selling: true,
    keys: Object.fromEntries(
      [first, second].map((offer) => [offer.id, { reprice: crypto.randomUUID(), delist: crypto.randomUUID() }]),
    ),
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const show = (value = data, offerPageAvailable = true) =>
    act(async () =>
      root.render(<CreatorOffersPage locale="en" data={value} offerPageAvailable={offerPageAvailable} />),
    );
  const rows = () => [...host.querySelectorAll<HTMLLIElement>('ul > li')];
  const button = (row: HTMLElement, name: string) => {
    const node = [...row.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
    expect(node).toBeDefined();
    return node!;
  };
  const navigations: string[] = [];
  host.addEventListener('click', (event) => {
    const anchor = (event.target as Element).closest('a');
    if (anchor) {
      event.preventDefault();
      navigations.push(anchor.getAttribute('href')!);
    }
  });
  try {
    await show();
    const originalRows = rows();
    expect(originalRows).toHaveLength(3);
    for (const [index, offer] of [first, second, historical].entries()) {
      const row = originalRows[index]!;
      const heading = row.querySelector('h2')!;
      expect(row.getAttribute('data-slot')).toBe('list-row');
      expect(row.getAttribute('data-offer-state')).toBe(offer.state);
      expect(heading.getAttribute('data-content-item-slot')).toBe('title');
      expect(heading.textContent).toBe(offer.title);
      expect(heading.hasAttribute('aria-hidden')).toBe(false);
      expect(row.querySelector('li, img, a a, a button, a input, a summary, a form')).toBeNull();
      const links = [...row.querySelectorAll('a')];
      expect(links).toHaveLength(offer.state === 'active' ? 1 : 0);
      if (offer.state === 'active') {
        expect(links[0]!.getAttribute('href')).toBe(`/en/offers/${offer.id}`);
        expect(links[0]!.getAttribute('aria-labelledby')).toBe(heading.id);
      }
      expect(row.querySelector('[data-content-item-slot="state"]')?.textContent).toBe(
        offer.state === 'active' ? m.creator_offers_active() : m.creator_offers_delisted(),
      );
      const facts = [...row.querySelectorAll('[data-content-item-slot="metadata"] p')].map((node) => node.textContent);
      expect(facts).toEqual(
        index === 2
          ? [`${m.creator_offers_amount_unavailable()} JPY`, m.commerce_tax_unknown(), m.creator_offers_unknown()]
          : ['$12.00 USD', m.commerce_before_tax(), m.creator_offers_captured()],
      );
    }
    expect(originalRows[2]!.querySelector('form')).toBeNull();
    await show(data, false);
    expect(host.querySelectorAll('ul a')).toHaveLength(0);
    expect(rows()[0]!.querySelector('h2')?.textContent).toBe(first.title);
    await show();
    const row = originalRows[0]!;
    const summary = row.querySelector<HTMLElement>('summary')!;
    const price = row.querySelector<HTMLInputElement>('input[name="price"]')!;
    expect(summary.closest('[data-content-item-slot="actions"][data-slot="list-row-control"]')).not.toBeNull();
    expect(price.closest('[data-content-item-slot="trailing"][data-slot="list-row-control"]')).not.toBeNull();
    expect(summary.classList.contains('min-h-11')).toBe(true);
    expect(price.classList.contains('min-h-11')).toBe(true);
    row.querySelector('a')!.focus();
    await act(async () => user.tab());
    expect(document.activeElement).toBe(summary);
    await act(async () => user.click(summary));
    expect(row.querySelector('details')?.open).toBe(true);
    expect(row.querySelector('details > p')?.textContent).toBe(first.title);
    await act(async () => user.tab());
    expect(document.activeElement).toBe(price);
    await act(async () => user.type(price, '13.25'));
    await act(async () => user.click(button(row, m.creator_reprice())));
    expect(calls).toEqual([
      {
        data: {
          operation: 'reprice',
          expectedRevision: first.revision,
          offerId: first.id,
          unitAmountMinor: 1325,
          idempotencyKey: data.keys[first.id]!.reprice,
        },
        headers: { 'X-CSRF-Token': data.csrfToken },
      },
    ]);
    const captured = structuredClone(calls[0]);
    expect(price.disabled).toBe(true);
    expect(row.querySelector('[role="alert"]')?.textContent).toBe(m.creator_uncertain());
    await show({
      ...data,
      page: { kind: 'ready', offers: [historical, second, { ...first, unitAmountMinor: 9900 }], next: null },
      keys: { ...data.keys, [first.id]: { reprice: crypto.randomUUID(), delist: crypto.randomUUID() } },
    });
    expect(rows()[2]).toBe(row);
    expect(row.querySelector('details')?.open).toBe(true);
    expect(price.value).toBe('13.25');
    result = { kind: 'saved', id: first.id };
    await act(async () => user.click(button(row, m.creator_retry())));
    expect(calls[1]).toEqual(captured);
    expect(calls[1]!.data).toBe(calls[0]!.data);
    expect(row.querySelector('[role="status"]')?.textContent).toBe(m.creator_saved());

    const delistRow = originalRows[1]!;
    result = { kind: 'rejected' };
    await act(async () => user.click(button(delistRow, m.creator_delist())));
    expect(calls[2]).toEqual({
      data: {
        operation: 'delist',
        expectedRevision: second.revision,
        offerId: second.id,
        idempotencyKey: data.keys[second.id]!.delist,
      },
      headers: { 'X-CSRF-Token': data.csrfToken },
    });
    result = { kind: 'retry' };
    await act(async () => user.click(button(delistRow, m.creator_delist())));
    expect(calls[3]!.data).toEqual({
      operation: 'delist',
      expectedRevision: second.revision,
      offerId: second.id,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(calls[3]!.data.idempotencyKey).not.toBe(calls[2]!.data.idempotencyKey);
    result = { kind: 'saved', id: second.id };
    await act(async () => user.click(button(delistRow, m.creator_retry())));
    expect(calls[4]).toEqual(calls[3]);
    expect(calls[4]!.data).toBe(calls[3]!.data);
    expect(navigations).toEqual([]);
    expect(window.location.href).toBe('https://site.test/en/creator/offers');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    overwriteGetLocale(previousLocale);
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
