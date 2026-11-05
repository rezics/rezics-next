import { expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ComponentProps } from 'react';
import type { CreatorStatement } from '../src/checkout/creator-statements';
import {
  creatorStatementFixture,
  historicalCreatorStatementFixture,
  paidCreatorStatementFixture,
} from '../src/kernel/fake/creator-statements';

// UNRUN: composed assertions using the installed shared UI. Native, browser and visual proof remain deferred.
test('Creator Statement shared summaries retain historical money month currency and exact nonpreloading detail context', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/creator/statements', width: 390, height: 844 });
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
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
    await import('@tanstack/react-router');
  const { CreatorStatementsPage } = await import('../src/checkout/creator-statements-page');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale, deLocalizeUrl, localizeUrl } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const cursor = 'signed/list+page?filter=paid&lang=ja#二%';
  const next = 'signed/next+page?from=else&locale=fr#三%';
  const statements: CreatorStatement[] = [
    creatorStatementFixture,
    { ...paidCreatorStatementFixture, currency: 'eur' },
    {
      ...creatorStatementFixture,
      id: '019a2100-0000-7000-8000-000000000005',
      period: '2024-12',
      currency: 'jpy',
      creatorShareMinor: 0,
      moneyUnit: { system: 'stripe-api', exponent: 0, factsVersion: 'stripe-money-v1' },
    },
    historicalCreatorStatementFixture,
  ];
  const initial: ComponentProps<typeof CreatorStatementsPage> = {
    locale: 'en',
    cursor,
    page: { kind: 'ready', payoutStatements: statements, next },
  };
  let show!: (view: typeof initial) => void;
  let detailReads = 0;
  const rootRoute = createRootRoute();
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/creator/statements',
    component: function StatementsFixture() {
      const [view, setView] = useState(initial);
      show = setView;
      return <CreatorStatementsPage {...view} />;
    },
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/creator/statements/$id',
    loader: () => detailReads++,
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ['/en/creator/statements'] }),
    defaultPreload: 'intent',
    defaultPreloadDelay: 0,
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const preload = spyOn(router, 'preloadRoute');
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Supplied summaries need no reads'));
  const rows = () => [...host.querySelectorAll<HTMLLIElement>('ul > li')];
  try {
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
    const originalRows = rows();
    expect(originalRows).toHaveLength(4);
    const titles = ['October 2026 · USD', 'September 2026 · EUR', 'December 2024 · JPY', 'September 2025 · USD'];
    const amounts = [
      m.money_formatted_recorded_minor({ display: '-$3.15', amount: '-315', currency: 'USD', exponent: '2' }),
      m.money_formatted_recorded_minor({ display: '€6.75', amount: '675', currency: 'EUR', exponent: '2' }),
      m.money_formatted_recorded_minor({ display: '¥0', amount: '0', currency: 'JPY', exponent: '0' }),
      m.money_raw_minor_unknown_unit({ amount: '675', currency: 'USD' }),
    ];
    for (const [index, row] of originalRows.entries()) {
      const heading = row.querySelector('h2')!;
      expect(row.getAttribute('data-slot')).toBe('list-row');
      expect(heading.textContent).toBe(titles[index]!);
      expect(heading.getAttribute('data-content-item-slot')).toBe('title');
      expect(heading.closest('[aria-hidden="true"], .sr-only')).toBeNull();
      const links = row.querySelectorAll('a');
      expect(links).toHaveLength(1);
      const primary = links[0]!;
      expect(primary.getAttribute('data-slot')).toBe('list-row-link');
      expect(primary.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(primary.getAttribute('aria-label')).toBeNull();
      expect(primary.getAttribute('href')).toBe(
        `/en/creator/statements/${statements[index]!.id}?from=signed%2Flist%2Bpage%3Ffilter%3Dpaid%26lang%3Dja%23%E4%BA%8C%25`,
      );
      expect(row.querySelector('li, a a, a button, h2 a')).toBeNull();
      expect(row.querySelector('[data-content-item-slot="visual"], [data-content-item-slot="preview"]')).toBeNull();
      expect(row.querySelector('[data-content-item-slot="state"]')?.textContent).toBe(
        statements[index]!.state === 'paid' ? 'External payment recorded' : 'No external payment recorded',
      );
      const money = row.querySelector('[data-content-item-slot="trailing"]')!;
      expect([...money.querySelectorAll('p')].map((part) => part.textContent)).toEqual([
        'Your recorded royalties',
        amounts[index]!,
      ]);
      expect(money.querySelector('.tabular-nums')?.textContent).toBe(amounts[index]!);
      expect(money.closest('a, [aria-hidden="true"]')).toBeNull();
      expect(row.textContent).not.toMatch(/spendable|funds received|payment received|available balance|net receipts/i);
    }
    expect(originalRows[3]!.textContent).not.toContain('$6.75');
    expect(host.textContent).not.toContain(cursor);
    const pagination = [...host.querySelectorAll<HTMLAnchorElement>('nav a')];
    expect(pagination.map((link) => link.textContent)).toEqual([m.statements_restart(), m.statements_next()]);
    const restartUrl = new URL(pagination[0]!.href);
    const nextUrl = new URL(pagination[1]!.href);
    expect([restartUrl.pathname, restartUrl.search]).toEqual(['/en/creator/statements', '']);
    expect(nextUrl.pathname).toBe('/en/creator/statements');
    expect([...nextUrl.searchParams]).toEqual([['cursor', next]]);
    const refresh = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent === m.statements_refresh(),
    )!;
    expect([...new URL(refresh.href).searchParams]).toEqual([['cursor', cursor]]);

    // Exercise real primary and pagination anchors under the router's intent-preload default.
    await act(async () => {
      for (const anchor of host.querySelectorAll<HTMLAnchorElement>('a')) {
        anchor.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
        anchor.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false }));
        anchor.focus();
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(preload.mock.calls).toHaveLength(0);
    expect(detailReads).toBe(0);
    expect(fetch.mock.calls).toHaveLength(0);

    overwriteGetLocale(() => 'fr');
    await act(async () =>
      show({
        ...initial,
        locale: 'fr',
        page: { kind: 'ready', payoutStatements: [...statements].reverse(), next },
      }),
    );
    expect(rows()[0]).toBe(originalRows[3]);
    expect(rows()[3]).toBe(originalRows[0]);
    expect(rows()[3]!.querySelector('h2')?.textContent).toBe('octobre 2026 · USD');
    const frenchDetail = new URL(rows()[3]!.querySelector<HTMLAnchorElement>('a')!.href);
    expect(frenchDetail.pathname).toBe(`/fr/creator/statements/${creatorStatementFixture.id}`);
    expect([...frenchDetail.searchParams]).toEqual([['from', cursor]]);

    overwriteGetLocale(() => 'en');
    await act(async () => show({ ...initial, page: { kind: 'ready', payoutStatements: [], next } }));
    expect(rows()).toHaveLength(0);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(m.statements_page_empty());
    expect(host.querySelector('[role="status"]')?.textContent).not.toContain(m.statements_empty());
    expect(host.querySelectorAll('nav a')).toHaveLength(2);
    await act(async () => show({ locale: 'en', page: { kind: 'ready', payoutStatements: [], next: null } }));
    expect(host.querySelector('[role="status"]')?.textContent).toContain(m.statements_empty());
    expect(host.querySelectorAll('nav a')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    preload.mockRestore();
    fetch.mockRestore();
    overwriteGetLocale(previousLocale);
    await window.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
