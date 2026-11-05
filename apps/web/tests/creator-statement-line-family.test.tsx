import { expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ComponentProps } from 'react';
import type { CreatorStatementPage } from '../src/checkout/creator-statement-page';
import type { CreatorStatementLine } from '../src/checkout/creator-statements';
import { creatorLineFixture, creatorStatementFixture } from '../src/kernel/fake/creator-statements';
import { m } from '../src/paraglide/messages.js';

type View = ComponentProps<typeof CreatorStatementPage>;
const cursor = 'signed/lines+page?filter=refund&locale=ja#二%';
const from = 'signed/statements+page?period=2026-10&locale=fr#三%';
const next = 'signed/next+lines?from=else&locale=de#四%';
const initial = (lines: CreatorStatementLine[]): View => ({
  id: creatorStatementFixture.id,
  locale: 'en',
  cursor,
  from,
  page: { kind: 'ready', statement: creatorStatementFixture, lines: { kind: 'ready', lines, next } },
});

// UNRUN: composed rendering cases only. Native, browser and visual acceptance remain controller-owned.
async function withPage(
  view: View,
  run: (page: {
    host: HTMLElement;
    show: (view: View) => Promise<void>;
    hoverLinks: () => Promise<void>;
  }) => Promise<void>,
) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.test/en/creator/statements/${view.id}`, width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    FocusEvent: window.FocusEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    scrollTo: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
    await import('@tanstack/react-router');
  const { CreatorStatementPage } = await import('../src/checkout/creator-statement-page');
  const { getLocale, overwriteGetLocale, deLocalizeUrl, localizeUrl } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  let update!: (view: View) => void;
  const rootRoute = createRootRoute();
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/creator/statements/$id',
    component: function StatementFixture() {
      const [current, setCurrent] = useState(view);
      update = setCurrent;
      return <CreatorStatementPage {...current} />;
    },
  });
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/creator/statements',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([detailRoute, listRoute]),
    history: createMemoryHistory({ initialEntries: [`/en/creator/statements/${view.id}`] }),
    defaultPreload: 'intent',
    defaultPreloadDelay: 0,
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const preload = spyOn(router, 'preloadRoute');
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Statement lines use only supplied evidence'));
  try {
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
    await run({
      host,
      show: async (current) => {
        await act(async () => update(current));
      },
      hoverLinks: async () => {
        await act(async () => {
          for (const anchor of host.querySelectorAll('a')) {
            anchor.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
            anchor.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false }));
            anchor.focus();
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
      },
    });
    expect(fetch.mock.calls).toHaveLength(0);
    expect(preload.mock.calls).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    preload.mockRestore();
    fetch.mockRestore();
    overwriteGetLocale(previousLocale);
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function field(row: Element, label: string) {
  const terms = [...row.querySelectorAll('dt')].filter((term) => term.textContent === label);
  expect(terms).toHaveLength(1);
  return terms[0]!.nextElementSibling!;
}

function link(host: HTMLElement, label: string) {
  const links = [...host.querySelectorAll<HTMLAnchorElement>('a')].filter((anchor) => anchor.textContent === label);
  expect(links).toHaveLength(1);
  return new URL(links[0]!.href);
}

test('Creator statement lines use the shared item surface while retaining every exact ledger field and independent source disclosure', async () => {
  const refund: CreatorStatementLine = {
    ...creatorLineFixture,
    kind: 'refund',
    balanceTransactionId: 'txn_refund',
    grossMinor: -9007199254740991,
    taxMinor: -101,
    feeMinor: 57,
    disputeFeeMinor: -2,
    netReceiptsMinor: -1101,
    royaltyBasisPoints: 9001,
  };
  const yen: CreatorStatementLine = {
    ...creatorLineFixture,
    kind: 'dispute',
    balanceTransactionId: 'txn_yen',
    currency: 'jpy',
    moneyUnit: { system: 'stripe-api', exponent: 0, factsVersion: 'stripe-money-v1' },
    netReceiptsMinor: -315,
  };
  const unknown: CreatorStatementLine = { ...creatorLineFixture, balanceTransactionId: 'txn_unknown', moneyUnit: null };
  await withPage(initial([refund, yen, unknown]), async ({ host, show }) => {
    const rows = [...host.querySelectorAll<HTMLLIElement>('#statement-lines ~ ul > li')];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector('[data-content-item-slot="title"]')?.textContent)).toEqual([
      m.statements_refund(),
      m.statements_dispute(),
      m.statements_charge(),
    ]);
    for (const [index, row] of rows.entries()) {
      const line = [refund, yen, unknown][index]!;
      expect(row.querySelector('h3[data-content-item-slot="title"]')).not.toBeNull();
      expect(row.firstElementChild?.className).toContain('has-[:focus-visible]:before:opacity-100');
      expect(row.classList.contains('border')).toBe(false);
      expect(row.firstElementChild?.classList.contains('bg-card')).toBe(false);
      expect(row.querySelector('li, [data-content-item-slot="preview"]')).toBeNull();
      expect(row.querySelector('a')?.getAttribute('href')).toBe(`/en/offers/${line.offerId}`);
      expect(field(row, m.statements_recording_month()).textContent).toBe(line.period);
      expect(field(row, m.statements_royalty_basis()).textContent).toBe(index === 0 ? '9,001' : '9,000');
      expect(field(row, m.statements_created()).querySelector('time')?.dateTime).toBe(line.created);
      expect(field(row, m.statements_recorded()).querySelector('time')?.dateTime).toBe(line.recordedAt);
      for (const label of [
        m.statements_gross(),
        m.statements_tax(),
        m.statements_fee(),
        m.statements_dispute_fee(),
        m.statements_net(),
      ]) {
        expect(field(row, label).closest('[data-slot="accordion-content"], [hidden], .sr-only')).toBeNull();
      }
      for (const [label, value] of [
        [m.statements_transaction(), line.balanceTransactionId],
        [m.statements_order_source(), line.orderId],
        [m.statements_offer_source(), line.offerId],
      ]) {
        expect(field(row, label!).textContent).toBe(value!);
        expect(field(row, label!).closest('[data-slot="accordion-content"]')).not.toBeNull();
      }
    }
    for (const [label, display, amount] of [
      [m.statements_gross(), '-$90,071,992,547,409.91', '-9007199254740991'],
      [m.statements_tax(), '-$1.01', '-101'],
      [m.statements_fee(), '$0.57', '57'],
      [m.statements_dispute_fee(), '-$0.02', '-2'],
      [m.statements_net(), '-$11.01', '-1101'],
    ])
      expect(field(rows[0]!, label!).textContent).toBe(
        m.money_formatted_recorded_minor({ display: display!, amount: amount!, currency: 'USD', exponent: '2' }),
      );
    expect(field(rows[1]!, m.statements_net()).textContent).toBe(
      m.money_formatted_recorded_minor({ display: '-¥315', amount: '-315', currency: 'JPY', exponent: '0' }),
    );
    for (const [label, amount] of [
      [m.statements_gross(), '1000'],
      [m.statements_tax(), '200'],
      [m.statements_fee(), '50'],
      [m.statements_dispute_fee(), '0'],
      [m.statements_net(), '750'],
    ])
      expect(field(rows[2]!, label!).textContent).toBe(
        m.money_raw_minor_unknown_unit({ amount: amount!, currency: 'USD' }),
      );
    expect(rows[2]!.textContent).not.toContain('$7.50');

    const triggers = rows.map((row) => row.querySelector<HTMLButtonElement>('[data-slot="accordion-trigger"]')!);
    expect(triggers.map((trigger) => trigger.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false']);
    await act(async () => triggers[0]!.click());
    await act(async () => triggers[1]!.click());
    expect(triggers.map((trigger) => trigger.getAttribute('aria-expanded'))).toEqual(['true', 'true', 'false']);
    await act(async () => triggers[0]!.click());
    expect(triggers[1]!.getAttribute('aria-expanded')).toBe('true');

    await show(initial([unknown, yen, refund]));
    const reordered = [...host.querySelectorAll('#statement-lines ~ ul > li')];
    expect(reordered[0]).toBe(rows[2]);
    expect(reordered[1]).toBe(rows[1]);
    expect(reordered[2]).toBe(rows[0]);
    expect(reordered[1]!.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  });
});

test('Creator statement source and bounded first-page next refresh and from navigation retain exact nonpreloading operands', async () => {
  await withPage(initial([creatorLineFixture]), async ({ host, show, hoverLinks }) => {
    const point = `/en/creator/statements/${creatorStatementFixture.id}`;
    const back = link(host, m.statements_back());
    expect(back.pathname).toBe('/en/creator/statements');
    expect([...back.searchParams]).toEqual([['cursor', from]]);
    const refresh = link(host, m.statements_refresh());
    expect(refresh.pathname).toBe(point);
    expect([...refresh.searchParams]).toEqual([
      ['cursor', cursor],
      ['from', from],
    ]);
    const restart = link(host, m.statements_restart_lines());
    expect(restart.pathname).toBe(point);
    expect([...restart.searchParams]).toEqual([['from', from]]);
    const following = link(host, m.statements_next_lines());
    expect(following.pathname).toBe(point);
    expect([...following.searchParams]).toEqual([
      ['cursor', next],
      ['from', from],
    ]);
    expect(host.textContent).not.toContain(cursor);
    expect(host.textContent).not.toContain(from);
    const offer = link(host, m.creator_sale_open_offer());
    expect([offer.pathname, offer.search, offer.hash]).toEqual([`/en/offers/${creatorLineFixture.offerId}`, '', '']);
    expect(host.querySelector(`a[href*="${creatorLineFixture.orderId}"]`)).toBeNull();
    await hoverLinks();

    await show({
      ...initial([]),
      page: { kind: 'ready', statement: creatorStatementFixture, lines: { kind: 'ready', lines: [], next } },
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.statements_lines_empty());
    expect(host.querySelectorAll('nav a')).toHaveLength(2);
    const first = initial([creatorLineFixture]);
    delete first.cursor;
    delete first.from;
    await show(first);
    expect(host.querySelectorAll('nav a')).toHaveLength(1);
    expect(link(host, m.statements_back()).search).toBe('');
    expect([...link(host, m.statements_next_lines()).searchParams]).toEqual([['cursor', next]]);

    await show({
      ...initial([]),
      navigation: { previous: 'line-previous+/=', restart: true },
      page: { kind: 'ready', statement: creatorStatementFixture, lines: { kind: 'ready', lines: [], next: null } },
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.statements_lines_empty());
    expect([...link(host, m.statements_previous_lines()).searchParams]).toEqual([
      ['cursor', 'line-previous+/='],
      ['from', from],
    ]);
    expect([...link(host, m.statements_restart_lines()).searchParams]).toEqual([['from', from]]);
  });
});

test('Creator statement incomplete error refused and preparing states preserve honest recovery without stale line bodies', async () => {
  await withPage(initial([creatorLineFixture]), async ({ host, show }) => {
    for (const kind of ['unavailable', 'error', 'stale', 'denied'] as const) {
      const view = initial([]);
      view.page = { kind: 'ready', statement: creatorStatementFixture, lines: { kind } };
      await show(view);
      expect(host.querySelectorAll('ul > li')).toHaveLength(0);
      expect(host.querySelectorAll('#statement-summary, #statement-payment')).toHaveLength(2);
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      expect([...link(host, m.statements_retry()).searchParams]).toEqual([
        ['cursor', cursor],
        ['from', from],
      ]);
      expect([...link(host, m.statements_restart_lines()).searchParams]).toEqual([['from', from]]);
    }
    await show({ ...initial([]), page: { kind: 'denied' } });
    expect(host.querySelector('#statement-summary, #statement-payment, ul')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.statements_denied());
    await show({ ...initial([]), page: { kind: 'preparing' } });
    expect(host.querySelector('[role="status"]')?.textContent).toContain(m.statements_preparing());
    expect([...link(host, m.statements_restart_lines()).searchParams]).toEqual([['from', from]]);
  });
});
