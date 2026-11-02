import { afterAll, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import type {
  CreatorOfferGuard,
  CreatorOfferMutation,
  CreatorOfferResult,
  CreatorOffersPageData,
} from '../src/checkout/creator-offers';

// Authored UNRUN. These presentation/recovery cases do not establish native or browser acceptance.
type Write = { data: CreatorOfferMutation; headers: { 'X-CSRF-Token': string } };
function deferred() {
  let resolve!: (value: CreatorOfferResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<CreatorOfferResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let writes: (Write & { work: ReturnType<typeof deferred> })[] = [];
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('../src/checkout/creator-offers', () => ({
  manageCreatorOffer: (input: Write) => {
    const work = deferred();
    writes.push({ ...input, work });
    return work.promise;
  },
}));
afterAll(() => mock.restore());
const { CreatorOffersPage } = await import('../src/checkout/creator-offers-page');
const { configuredPriceExample, creatorOfferFixture, delistedCreatorOfferFixture } =
  await import('../src/kernel/fake/creator-offers');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const id = (n: number) => `019a2100-0000-7000-8000-${String(n).padStart(12, '0')}`;

async function surface() {
  writes = [];
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
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const { createRoot } = await import('react-dom/client');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let current = true;
  const guard: CreatorOfferGuard = { isCurrent: () => current, csrfToken: () => (current ? 'origin-csrf' : null) };
  const first = { ...creatorOfferFixture, title: 'Full captured title / '.repeat(15) + '無空白の長い題名'.repeat(20) };
  const second = { ...creatorOfferFixture, id: id(91), title: 'Another active offer' };
  const data: CreatorOffersPageData = {
    page: { kind: 'ready', offers: [first, delistedCreatorOfferFixture, second], next: null },
    schema: configuredPriceExample,
    selling: true,
    csrfToken: 'loader-token-is-not-authority',
    keys: { [first.id]: { reprice: id(1), delist: id(2) }, [second.id]: { reprice: id(3), delist: id(4) } },
  };
  const show = (next = data, available = true) =>
    act(async () =>
      root.render(<CreatorOffersPage data={next} locale="en" guard={guard} offerPageAvailable={available} />),
    );
  const rows = () => [...host.querySelectorAll<HTMLLIElement>('ul > li')];
  const toggle = (row = rows()[0]!) => row.querySelector<HTMLButtonElement>('button[aria-controls]')!;
  const panel = (row = rows()[0]!) => document.getElementById(toggle(row).getAttribute('aria-controls')!)!;
  const price = () => panel().querySelector<HTMLInputElement>('input[name="price"]')!;
  const button = (name: string) =>
    [...panel().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)!;
  const click = (node: HTMLElement) => act(async () => user.click(node));
  const type = (text: string) => act(async () => user.type(price(), text));
  const settle = (index: number, result: CreatorOfferResult | Error) =>
    act(async () => {
      if (result instanceof Error) writes[index]!.work.reject(result);
      else writes[index]!.work.resolve(result);
    });
  return {
    host,
    data,
    first,
    second,
    show,
    rows,
    toggle,
    panel,
    price,
    button,
    click,
    type,
    settle,
    user,
    retire() {
      current = false;
    },
    async close() {
      await act(async () => root.unmount());
      host.remove();
      overwriteGetLocale(previousLocale);
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('Offer identity, money, state and full title stay outside independent keyboard management disclosures', async () => {
  const p = await surface();
  try {
    await p.show();
    expect(p.rows().map((row) => row.querySelector('h2')!.textContent)).toEqual([
      p.first.title,
      delistedCreatorOfferFixture.title,
      p.second.title,
    ]);
    const row = p.rows()[0]!;
    expect(row.querySelector('a')?.getAttribute('href')).toBe(`/en/offers/${p.first.id}`);
    expect(row.querySelector('[data-content-item-slot="metadata"]')!.textContent).toContain('$12.00 USD');
    expect(row.querySelector('[data-content-item-slot="state"]')!.textContent).toBe(m.creator_offers_active());
    expect(p.rows()[1]!.querySelector('a, form, button[aria-controls]')).toBeNull();
    expect(p.rows()[1]!.textContent).toContain(m.creator_offers_delisted());
    expect(p.panel().hidden).toBe(true);
    expect(p.toggle().getAttribute('aria-expanded')).toBe('false');
    expect(p.toggle().getAttribute('aria-label')).toBe(m.creator_offer_controls_manage_offer({ title: p.first.title }));
    expect(p.toggle().closest('a, summary')).toBeNull();
    expect(p.toggle().getAttribute('aria-controls')).not.toBe(p.toggle(p.rows()[2]!).getAttribute('aria-controls'));
    row.querySelector('a')!.focus();
    await act(async () => p.user.tab());
    const summary = row.querySelector<HTMLElement>('summary')!;
    expect(document.activeElement).toBe(summary);
    await p.click(summary);
    expect(row.querySelector('details > p')?.textContent).toBe(p.first.title);
    await act(async () => p.user.tab());
    expect(document.activeElement).toBe(p.toggle());
    await act(async () => p.user.keyboard(' '));
    expect(p.panel().hidden).toBe(false);
    expect(row.querySelector('details')?.open).toBe(true);
    await act(async () => p.user.tab());
    expect(document.activeElement).toBe(p.price());
    await p.click(p.toggle());
    expect(p.panel().hidden).toBe(true);
    expect(document.activeElement).toBe(p.toggle());
    expect(p.panel(p.rows()[2]!).hidden).toBe(true);
    await p.show(p.data, false);
    expect(p.rows()[0]!.querySelector('a')).toBeNull();
    expect(p.rows()[0]!.querySelector('h2')!.textContent).toBe(p.first.title);
    expect(writes).toHaveLength(0);
  } finally {
    await p.close();
  }
});

test('An edited draft cannot collapse or disappear during a same-origin omitted-row refresh', async () => {
  const p = await surface();
  try {
    await p.show();
    await p.click(p.toggle());
    await p.type('13.25');
    const input = p.price();
    await p.click(p.toggle());
    expect(p.toggle().getAttribute('aria-disabled')).toBe('true');
    expect(p.panel().hidden).toBe(false);
    expect(p.panel().textContent).toContain(m.creator_offer_controls_retained());
    await p.show({ ...p.data, page: { kind: 'ready', offers: [p.second], next: null } });
    const retained = p.rows().find((row) => row.querySelector('h2')!.textContent === p.first.title)!;
    expect(retained.querySelector('input')).toBe(input);
    expect(input.value).toBe('13.25');
    await act(async () => p.user.clear(input));
    await p.click(p.toggle(retained));
    expect(p.panel(retained).hidden).toBe(false);
    expect(writes).toHaveLength(0);
  } finally {
    await p.close();
  }
});

test('Pending, uncertain and saved reprice outcomes stay open with the exact original request and token', async () => {
  const p = await surface();
  try {
    await p.show();
    await p.click(p.toggle());
    await p.type('13.25');
    await p.click(p.button(m.creator_reprice()));
    expect(writes).toHaveLength(1);
    const original = writes[0]!;
    expect(original.data).toEqual({
      operation: 'reprice',
      expectedRevision: p.first.revision,
      offerId: p.first.id,
      unitAmountMinor: 1325,
      idempotencyKey: id(1),
    });
    expect(original.headers).toEqual({ 'X-CSRF-Token': 'origin-csrf' });
    expect(p.panel().querySelector('[role="status"]')!.textContent).toBe(m.creator_saving());
    await p.click(p.toggle());
    expect(p.panel().hidden).toBe(false);
    expect(p.price().disabled).toBe(true);
    await p.click(p.button(m.creator_reprice()));
    expect(writes).toHaveLength(1);
    await p.settle(0, new Error('Response lost'));
    expect(p.panel().querySelector('[role="alert"]')!.textContent).toBe(m.creator_uncertain());
    await p.show({
      ...p.data,
      schema: null,
      csrfToken: 'replacement-loader-token',
      keys: { [p.first.id]: { reprice: id(50), delist: id(51) } },
      page: { kind: 'ready', offers: [{ ...p.first, unitAmountMinor: 9900, state: 'delisted' }], next: null },
    });
    expect(p.price().value).toBe('13.25');
    await p.click(p.toggle());
    expect(p.panel().hidden).toBe(false);
    await p.click(p.button(m.creator_retry()));
    expect(writes[1]!.data).toBe(original.data);
    expect(writes[1]!.headers).toEqual(original.headers);
    await p.settle(1, { kind: 'saved', id: p.first.id });
    await p.click(p.toggle());
    expect(p.panel().hidden).toBe(false);
    expect(p.panel().querySelector('[role="status"]')!.textContent).toBe(m.creator_saved());
    expect(p.price().disabled).toBe(true);
  } finally {
    await p.close();
  }
});

test('Delist is discoverable without a price draft; rejection and uncertain original delist stay recoverable', async () => {
  const p = await surface();
  try {
    await p.show();
    expect(p.toggle().textContent).toBe(m.creator_offer_controls_manage());
    await p.click(p.toggle());
    await p.click(p.button(m.creator_delist()));
    expect(writes[0]!.data).toEqual({
      operation: 'delist',
      expectedRevision: p.first.revision,
      offerId: p.first.id,
      idempotencyKey: id(2),
    });
    await p.settle(0, { kind: 'rejected' });
    await p.click(p.toggle());
    expect(p.panel().hidden).toBe(false);
    expect(p.panel().querySelector('[role="alert"]')!.textContent).toBe(m.creator_rejected());
    await p.click(p.button(m.creator_delist()));
    expect(writes[1]!.data.idempotencyKey).not.toBe(id(2));
    await p.settle(1, { kind: 'retry' });
    await p.click(p.toggle());
    expect(p.panel().hidden).toBe(false);
    await p.click(p.button(m.creator_retry()));
    expect(writes[2]!.data).toBe(writes[1]!.data);
    await p.settle(2, { kind: 'saved', id: p.first.id });
  } finally {
    await p.close();
  }
});

test('Unavailable price rules preserve recorded unknowns and a separately usable delist command', async () => {
  const p = await surface();
  try {
    await p.show({
      ...p.data,
      schema: null,
      page: {
        kind: 'ready',
        offers: [{ ...p.first, moneyUnit: null, taxBehavior: null, contentEdition: null }],
        next: null,
      },
    });
    const facts = p.rows()[0]!.querySelector('[data-content-item-slot="metadata"]')!.textContent;
    expect(facts).toContain(m.creator_offers_amount_unavailable());
    expect(facts).toContain('USD');
    expect(facts).toContain(m.commerce_tax_unknown());
    expect(facts).toContain(m.creator_offers_unknown());
    await p.click(p.toggle());
    expect(p.price().disabled).toBe(true);
    expect(p.panel().textContent).toContain(m.creator_price_unavailable());
    expect(p.button(m.creator_reprice()).disabled).toBe(true);
    expect(p.button(m.creator_delist()).disabled).toBe(false);
    await p.click(p.button(m.creator_delist()));
    expect(writes[0]!.data.operation).toBe('delist');
    await p.settle(0, { kind: 'saved', id: p.first.id });
  } finally {
    await p.close();
  }
});

test('Authority retirement removes private disclosure and rejects a late completion and retained submit handler', async () => {
  const p = await surface();
  try {
    await p.show();
    await p.click(p.toggle());
    await p.type('13.25');
    const form = p.panel().querySelector('form')!;
    await p.click(p.button(m.creator_reprice()));
    p.retire();
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(writes).toHaveLength(1);
    await p.show({ ...p.data, selling: false, page: { kind: 'denied' } });
    expect(p.host.querySelector('input, form, button[aria-controls]')).toBeNull();
    expect(p.host.textContent).not.toContain(p.first.title);
    await p.settle(0, { kind: 'saved', id: p.first.id });
    expect(p.host.textContent).not.toContain(m.creator_saved());
    expect(p.host.textContent).toContain(m.creator_offers_denied());
  } finally {
    await p.close();
  }
});
