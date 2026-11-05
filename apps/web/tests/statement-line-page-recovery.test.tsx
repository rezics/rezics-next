import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import type { CreatorStatementPage } from '../src/checkout/creator-statement-page';
import type { CreatorStatementCurrentRead, CreatorStatementLine } from '../src/checkout/creator-statements';
import { creatorLineFixture, creatorStatementFixture } from '../src/kernel/fake/creator-statements';

// UNRUN: focused presentation and actual current-reader regressions for controller execution.
// Supplied fixtures and cache transitions are not native authorization or browser evidence.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
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
  ResizeObserver: window.ResizeObserver,
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
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { CreatorStatementPage: StatementPage } = await import('../src/checkout/creator-statement-page');
const { CreatorStatementCurrent } = await import('../src/checkout/creator-statements-current');
const reads = await import('../src/checkout/creator-statements');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, overwriteGetLocale, deLocalizeUrl, localizeUrl } = await import('../src/paraglide/runtime.js');
const previousLocale = getLocale;
overwriteGetLocale(() => 'en');
afterAll(async () => {
  mock.restore();
  overwriteGetLocale(previousLocale);
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

type View = ComponentProps<typeof CreatorStatementPage>;
const cursor = ' signed/lines+page?filter=refund&locale=ja#二% ';
const from = ' signed/statements+page?period=2026-10&locale=fr#三% ';
const next = ' signed/next+lines?from=else&locale=de#四% ';
const empty = (later = false, continuation: string | null = null): View => ({
  id: creatorStatementFixture.id.toUpperCase(),
  locale: 'en',
  ...(later ? { cursor } : {}),
  from,
  page: {
    kind: 'ready',
    statement: { ...creatorStatementFixture, id: creatorStatementFixture.id.toUpperCase() },
    lines: { kind: 'ready', lines: [], next: continuation },
  },
});
const currentRead = (view: View): CreatorStatementCurrentRead => ({
  sessionSubject: creatorStatementFixture.creatorAccountId,
  requested: { kind: 'detail', locale: view.locale, id: view.id, cursor: view.cursor ?? null, from: view.from ?? null },
  page: view.page.kind === 'preparing' ? { kind: 'unavailable' } : view.page,
});

async function mount(view: View, current = false, admitted = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, {
    state: 'signed-in',
    subject: creatorStatementFixture.creatorAccountId,
    csrfToken: 'current-credential',
  });
  const lifetime = viewerExposureLifetime(client);
  const release = lifetime.subscribe(() => {});
  const admit = (open: boolean) => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('Expected the actual viewer observation');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject: snapshot.observation.subject,
      admitted: open ? ['selling'] : [],
    });
  };
  admit(admitted);
  const rootRoute = createRootRoute();
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/creator/statements/$id', component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: '/creator/statements', component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: [`/en/creator/statements/${view.id}`] }),
    defaultPreload: 'intent',
    defaultPreloadDelay: 0,
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  const pending: { input: unknown; resolve: (value: CreatorStatementCurrentRead) => void }[] = [];
  const read = spyOn(reads, 'readCreatorStatementCurrent').mockImplementation(
    ({ data }) => new Promise((resolve) => pending.push({ input: data, resolve })),
  );
  const preload = spyOn(router, 'preloadRoute');
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected presentation request'));
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const flush = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const show = async (value: View) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            {current ? (
              <CreatorStatementCurrent {...value} initial={currentRead(value)} />
            ) : (
              <StatementPage {...value} />
            )}
          </RouterContextProvider>
        </QueryClientProvider>,
      ),
    );
    await flush();
  };
  await router.load();
  await show(view);
  return {
    host,
    show,
    admit,
    client,
    pending,
    flush,
    hover: async () =>
      act(async () => {
        for (const anchor of host.querySelectorAll('a')) {
          anchor.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
          anchor.focus();
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }),
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      release();
      host.remove();
      const counts = [fetch.mock.calls.length, preload.mock.calls.length];
      read.mockRestore();
      fetch.mockRestore();
      preload.mockRestore();
      expect(counts).toEqual([0, 0]);
    },
  };
}

function link(host: HTMLElement, label: string) {
  const links = [...host.querySelectorAll<HTMLAnchorElement>('a')].filter((node) => node.textContent === label);
  expect(links).toHaveLength(1);
  return new URL(links[0]!.href);
}
function emptyHeading(host: HTMLElement) {
  return host.querySelector('h3')?.textContent;
}

test('first empty statements differ from requested empty pages, including empty pages with continuation', async () => {
  const page = await mount(empty());
  try {
    expect(emptyHeading(page.host)).toBe(m.statement_line_page_reader_first_empty());
    expect(page.host.querySelector('[role="status"]')?.textContent).toBe(m.statements_lines_empty());
    expect(page.host.querySelectorAll('nav a')).toHaveLength(0);
    for (const continuation of [null, next]) {
      await page.show(empty(true, continuation));
      expect(emptyHeading(page.host)).toBe(m.statement_line_page_reader_page_empty());
      expect(page.host.textContent).not.toContain(m.statement_line_page_reader_first_empty());
      expect(page.host.querySelectorAll('nav a')).toHaveLength(continuation ? 2 : 1);
      expect([...link(page.host, m.statements_restart_lines()).searchParams]).toEqual([['from', from]]);
    }
    await page.show(empty(false, next));
    expect(emptyHeading(page.host)).toBe(m.statement_line_page_reader_page_empty());
    expect(page.host.querySelectorAll('nav a')).toHaveLength(1);
  } finally {
    await page.close();
  }
});

test('first next refresh and list-return links preserve every opaque operand and never preload', async () => {
  const view = empty(true, next);
  const page = await mount(view);
  try {
    for (const retainedFrom of [from, undefined]) {
      await page.show({ ...view, from: retainedFrom });
      const retained = retainedFrom ? [['from', retainedFrom]] : [];
      for (const [label, expected] of [
        [m.statements_restart_lines(), retained],
        [m.statements_next_lines(), [['cursor', next], ...retained]],
        [m.statements_refresh(), [['cursor', cursor], ...retained]],
      ] as const) {
        const target = link(page.host, label);
        expect(decodeURIComponent(target.pathname)).toBe(`/en/creator/statements/${view.id}`);
        expect([...target.searchParams]).toEqual(expected);
      }
      const back = link(page.host, m.statements_back());
      expect(back.pathname).toBe('/en/creator/statements');
      expect([...back.searchParams]).toEqual(retainedFrom ? [['cursor', retainedFrom]] : []);
      await page.hover();
      expect(page.host.textContent).not.toContain(cursor);
      expect(page.host.textContent).not.toContain(from);
    }
  } finally {
    await page.close();
  }
});

test('empty pages never infer zero money, units, external payment reference or settlement', async () => {
  const view = empty(true);
  if (view.page.kind !== 'ready') throw new Error('Expected ready fixture');
  view.page.statement = { ...view.page.statement, moneyUnit: null, state: 'paid', paidAt: null, paidReference: null };
  const page = await mount(view);
  try {
    const summary = page.host.querySelector('[aria-labelledby="statement-summary"]')!;
    expect([...summary.querySelectorAll('dd')].map((node) => node.textContent)).toEqual(
      Array(9).fill(m.statements_amount_unavailable()),
    );
    const payment = page.host.querySelector('[aria-labelledby="statement-payment"]')!;
    expect([...payment.querySelectorAll('dd')].map((node) => node.textContent)).toEqual([
      m.statements_unknown(),
      m.statements_unknown(),
    ]);
    expect(payment.textContent).toContain(m.statements_paid());
    expect(payment.textContent).toContain(m.statements_payment_meaning());
    expect(payment.textContent).toContain(m.statements_funds_unknown());
    expect(page.host.textContent).not.toContain('$0.00');
    expect(view.page.statement.creatorShareMinor).toBe(-315);
  } finally {
    await page.close();
  }
});

test('line order and multiplicity and page-net versus statement-share amounts survive empty-page recovery', async () => {
  const view = empty(true);
  const page = await mount(view);
  try {
    const lines: CreatorStatementLine[] = [
      {
        ...creatorLineFixture,
        statementId: view.id,
        balanceTransactionId: 'txn_refund',
        kind: 'refund',
        netReceiptsMinor: -1100,
      },
      { ...creatorLineFixture, statementId: view.id },
      { ...creatorLineFixture, statementId: view.id },
    ];
    await page.show({
      ...view,
      cursor: undefined,
      page: {
        kind: 'ready',
        statement: { ...creatorStatementFixture, id: view.id },
        lines: { kind: 'ready', lines, next },
      },
    });
    const rows = [...page.host.querySelectorAll('#statement-lines ~ ul > li')];
    expect(rows.map((row) => row.querySelector('h3')?.textContent)).toEqual([
      m.statements_refund(),
      m.statements_charge(),
      m.statements_charge(),
    ]);
    expect(rows.map((row) => row.querySelector('dd')?.textContent)).toEqual(['-$11.00', '$7.50', '$7.50']);
    const summary = page.host.querySelector('[aria-labelledby="statement-summary"]')!;
    expect(
      [...summary.querySelectorAll('dt')].find((node) => node.textContent === m.statements_creator_share())
        ?.nextElementSibling?.textContent,
    ).toBe('-$3.15');
    expect(page.host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await page.close();
  }
});

test('unavailable denied stale error and preparing reads never acquire ready empty-page presentation', async () => {
  const view = empty(true, next);
  const page = await mount(view);
  try {
    for (const kind of ['unavailable', 'denied', 'stale', 'error'] as const) {
      for (const wholePage of [false, true]) {
        await page.show({
          ...view,
          page: wholePage
            ? { kind }
            : {
                kind: 'ready',
                statement: creatorStatementFixture,
                lines: { kind },
              },
        });
        expect(page.host.querySelector('[role="alert"]')).not.toBeNull();
        expect(page.host.querySelectorAll('nav a')).toHaveLength(0);
        expect(emptyHeading(page.host)).toBeUndefined();
        expect(page.host.textContent).not.toContain(m.statements_lines_empty());
      }
    }
    await page.show({ ...view, page: { kind: 'preparing' } });
    expect(page.host.querySelector('[role="status"]')?.textContent).toContain(m.statements_preparing());
    expect(emptyHeading(page.host)).toBeUndefined();
    expect(page.host.textContent).not.toContain(m.statements_lines_empty());
  } finally {
    await page.close();
  }
});

test('absent admission cannot disclose a ready empty statement or pagination', async () => {
  const page = await mount(empty(true, next), true, false);
  try {
    expect(page.host.textContent).toContain(m.statements_denied());
    expect(page.host.querySelector('#statement-summary, #statement-payment, #statement-lines, nav')).toBeNull();
    expect(page.host.textContent).not.toContain(m.statements_lines_empty());
    expect(page.pending).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test('retired current authority fences late empty pages and requires a fresh exact-address read after readmission', async () => {
  const view = empty(true, next);
  const page = await mount(view, true);
  try {
    expect(emptyHeading(page.host)).toBe(m.statement_line_page_reader_page_empty());
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = page.client.refetchQueries({ queryKey: ['creator-statements-current'] });
    });
    const old = page.pending.at(-1)!;
    expect(old.input).toEqual({ locale: 'en', id: view.id, cursor, from });
    await act(async () => page.admit(false));
    await page.flush();
    expect(page.host.querySelector('#statement-lines')).toBeNull();
    await act(async () => {
      old.resolve(currentRead(view));
      await refresh;
    });
    await page.flush();
    expect(page.host.textContent).not.toContain(m.statement_line_page_reader_page_empty());
    await act(async () => page.admit(true));
    await page.flush();
    expect(page.host.textContent).toContain(m.statements_preparing());
    expect(page.host.textContent).not.toContain(m.statements_lines_empty());
    const fresh = page.pending.at(-1)!;
    expect(fresh).not.toBe(old);
    expect(fresh.input).toEqual({ locale: 'en', id: view.id, cursor, from });
    await act(async () => fresh.resolve(currentRead(view)));
    await page.flush();
    expect(emptyHeading(page.host)).toBe(m.statement_line_page_reader_page_empty());
  } finally {
    await page.close();
  }
});
