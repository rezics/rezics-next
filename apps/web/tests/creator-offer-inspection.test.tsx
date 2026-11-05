import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import type {
  CreatorOffer,
  CreatorOfferResult,
  CreatorOffersPageData,
  CreatorOffersCurrentRead,
} from '../src/checkout/creator-offers';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/creator/offers' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLAnchorElement: window.HTMLAnchorElement,
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
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const offersApi = await import('../src/checkout/creator-offers');
const { CreatorOffersPage } = await import('../src/checkout/creator-offers-page');
const { CreatorOffersCurrent } = await import('../src/checkout/creator-offers-current');
const { creatorOfferFixture: fixture, configuredPriceExample } = await import('../src/kernel/fake/creator-offers');
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const originalLocale = getLocale;
overwriteGetLocale(() => 'en');
const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
const user = userEvent.setup({ document });
const guard = { isCurrent: () => true, csrfToken: () => 'current-csrf' };
const id = (n: number) => `019a2100-0000-7000-8000-${String(n).padStart(12, '0')}`;
const creator = fixture.contentEdition!.creatorAccountId;
function data(rows: CreatorOffer[] = [fixture], next: string | null = null): CreatorOffersPageData {
  return {
    page: { kind: 'ready', offers: rows, next },
    selling: true,
    schema: configuredPriceExample,
    csrfToken: 'loader-csrf',
    keys: Object.fromEntries(rows.map((row) => [row.id, { reprice: id(70), delist: id(71) }])),
  };
}
function mount() {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const rows = () => [...host.querySelectorAll<HTMLLIElement>('ul > li[data-offer-state]')];
  const button = (name: string, parent: ParentNode = host) => {
    const node = [...parent.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === name);
    if (!node) throw new Error(`Missing button: ${name}`);
    return node;
  };
  const inspect = () => host.querySelector<HTMLElement>('h2[tabindex="-1"]')?.closest('section') ?? null;
  return {
    host,
    root,
    rows,
    button,
    inspect,
    show: (value: CreatorOffersPageData, locale = 'en', cursor = 'original-cursor') =>
      act(async () => root.render(<CreatorOffersPage data={value} locale={locale} cursor={cursor} guard={guard} />)),
    click: (name: string, parent: ParentNode = host) => act(async () => user.click(button(name, parent))),
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
afterAll(async () => {
  overwriteGetLocale(originalLocale);
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('exact owned offer and captured terms inspection', () => {
  test('equal titles and duplicate Editions stay distinct, including delisted and historically unknown terms', async () => {
    const page = mount();
    const sameTitle = 'Equal title / '.repeat(20) + '長い題名'.repeat(30);
    const rows: CreatorOffer[] = [
      { ...fixture, title: sameTitle },
      { ...fixture, id: id(2), revision: 7, title: sameTitle },
      { ...fixture, id: id(3), revision: 9, title: sameTitle, state: 'delisted' },
      {
        ...fixture,
        id: id(4),
        revision: 11,
        title: sameTitle,
        state: 'delisted',
        contentEdition: null,
        moneyUnit: null,
      },
    ];
    const value = data(rows, 'unread-next');
    try {
      await page.show(value);
      for (const [index, offer] of rows.entries()) {
        const row = page.rows()[index]!;
        const trigger = page.button(m.creator_inspect_open(), row);
        await act(async () => user.click(trigger));
        const panel = page.inspect()!;
        expect(panel.querySelector('h2')?.textContent).toBe(sameTitle);
        expect(document.activeElement).toBe(panel.querySelector('h2'));
        expect(panel.textContent).toContain(offer.id);
        expect(panel.textContent).toContain(String(offer.revision));
        expect(panel.textContent).toContain(
          offer.state === 'active' ? m.creator_offers_active() : m.creator_offers_delisted(),
        );
        if (offer.contentEdition) {
          const terms = offer.contentEdition;
          expect(panel.textContent).toContain(terms.source.licence);
          expect(panel.textContent).toContain(m.creator_inspect_delivery_meaning());
          expect(panel.textContent).toContain(m.creator_inspect_acquisition_meaning());
          expect(panel.textContent).toContain(m.creator_inspect_quantity_meaning());
          const references = panel.querySelector('details')!;
          expect(references.open).toBe(false);
          await act(async () => user.click(references.querySelector('summary')!));
          expect(references.open).toBe(true);
          expect(references.textContent).toContain(`${terms.benefit.resource.route}/${terms.benefit.resource.id}`);
          expect(references.textContent).toContain(terms.benefit.version.revisionId);
          expect(references.textContent).toContain(terms.benefit.version.sha256);
          expect(references.textContent).toContain(terms.saleTermsReference);
          expect(references.textContent).toContain(m.creator_inspect_hash_meaning());
        } else {
          expect(panel.textContent).toContain(m.creator_inspect_unknown_licence());
          expect(panel.textContent).toContain(m.creator_inspect_unknown_quantity());
          expect(panel.textContent).toContain(m.creator_inspect_unknown_delivery());
          expect(panel.textContent).toContain(m.creator_inspect_unknown_money());
          expect(panel.textContent).not.toContain(fixture.contentEdition!.benefit.version.sha256);
        }
        expect(row.querySelectorAll('a')).toHaveLength(offer.state === 'active' ? 1 : 0);
        expect(panel.querySelector('a')?.getAttribute('href') ?? null).toBe(
          offer.state === 'active' ? `/en/offers/${offer.id}` : null,
        );
        await page.click(m.creator_inspect_close(), panel);
        expect(page.inspect()).toBeNull();
        expect(document.activeElement).toBe(trigger);
      }
      expect(page.rows().map((row) => row.querySelector('h2')?.textContent)).toEqual(rows.map((row) => row.title));
      expect(page.host.querySelector('nav a:last-child')?.getAttribute('href')).toBe(
        '/en/creator/offers?cursor=unread-next',
      );
    } finally {
      await page.close();
    }
  });
});

describe('same row management handoff', () => {
  test('inspection dispatches nothing and preserves original reprice/delist recovery through refresh', async () => {
    for (const operation of ['reprice', 'delist'] as const) {
      for (const outcome of ['retry', 'conflict', 'saved'] as const) {
        const page = mount();
        const current = data();
        let result: CreatorOfferResult = outcome === 'saved' ? { kind: 'saved', id: fixture.id } : { kind: outcome };
        const writes = spyOn(offersApi, 'manageCreatorOffer').mockImplementation(async () => result);
        const reads = spyOn(offersApi, 'readCreatorOffersCurrent').mockImplementation(async () => {
          throw new Error('Unexpected read');
        });
        try {
          await page.show(current);
          const row = page.rows()[0]!;
          await page.click(m.creator_inspect_open(), row);
          await page.click(m.creator_inspect_go_management(), page.inspect()!);
          const manage = page.button(m.creator_offer_controls_manage(), row);
          expect(document.activeElement).toBe(manage);
          expect(manage.getAttribute('aria-expanded')).toBe('true');
          if (operation === 'reprice') await act(async () => user.type(row.querySelector('input')!, '13.25'));
          await page.click(operation === 'reprice' ? m.creator_reprice() : m.creator_delist(), row);
          const original = writes.mock.calls[0]![0];
          expect(original.data).toMatchObject({
            operation,
            offerId: fixture.id,
            expectedRevision: fixture.revision,
            idempotencyKey: current.keys[fixture.id]![operation],
          });
          await page.show(data([{ ...fixture, revision: 8, title: 'New received title', unitAmountMinor: 2200 }]));
          await page.click(m.creator_inspect_open(), row);
          expect(page.inspect()?.textContent).toContain(m.creator_inspect_changed_heading());
          await page.click(m.creator_inspect_review_received(), page.inspect()!);
          expect(page.inspect()?.querySelector('h2')?.textContent).toBe('New received title');
          expect(page.inspect()?.textContent).toContain(m.creator_inspect_command_original());
          await page.click(m.creator_inspect_go_management(), page.inspect()!);
          expect(page.inspect()).toBeNull();
          expect(manage.getAttribute('aria-expanded')).toBe('true');
          expect(row.querySelector('input')?.value).toBe(operation === 'reprice' ? '13.25' : '');
          expect(writes).toHaveBeenCalledTimes(1);
          expect(reads).not.toHaveBeenCalled();
          if (outcome === 'retry') {
            result = { kind: 'saved', id: fixture.id };
            await page.click(m.creator_retry(), row);
            expect(writes.mock.calls[1]![0].data).toBe(original.data);
            expect(writes.mock.calls[1]![0].headers).toEqual(original.headers);
          } else {
            expect(row.querySelector('input')?.disabled).toBe(true);
          }
        } finally {
          writes.mockRestore();
          reads.mockRestore();
          await page.close();
        }
      }
    }
  });
});

describe('current received source and private inspection retirement', () => {
  test('replacement needs deliberate review, missing rows never scan, and current origin retires A/B/A selection', async () => {
    const page = mount();
    try {
      await page.show(data());
      await page.click(m.creator_inspect_open(), page.rows()[0]!);
      await page.show(data([{ ...fixture, revision: 4, title: 'Replacement', state: 'delisted' }]));
      expect(page.inspect()?.querySelector('h2')?.textContent).toBe(fixture.title);
      expect(page.inspect()?.textContent).toContain(m.creator_inspect_changed_heading());
      expect(page.rows()[0]!.querySelector('a')).toBeNull();
      await page.click(m.creator_inspect_review_received(), page.inspect()!);
      expect(page.inspect()?.querySelector('h2')?.textContent).toBe('Replacement');
      expect(page.inspect()?.querySelector('a')).toBeNull();
      await page.show(data([], 'next-not-read'));
      expect(page.inspect()?.textContent).toContain(m.creator_inspect_missing_meaning());
      expect(page.inspect()?.querySelector('a')?.getAttribute('href')).toBe('/en/creator/offers');
      await page.show({ ...data(), page: { kind: 'denied' } });
      expect(page.inspect()).toBeNull();
      expect(page.host.textContent).not.toContain(fixture.title);
      await page.show(data());
      expect(page.inspect()).toBeNull();
      await page.click(m.creator_inspect_open(), page.rows()[0]!);
      await act(async () => window.dispatchEvent(new window.Event('pagehide')));
      await act(async () => window.dispatchEvent(new window.Event('pageshow')));
      expect(page.inspect()).toBeNull();
    } finally {
      await page.close();
    }

    const privatePage = mount();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const session = (subject: string, csrfToken = 'csrf') =>
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject, csrfToken });
    session(creator);
    const lifetime = viewerExposureLifetime(client);
    const stop = lifetime.subscribe(() => {});
    function admit() {
      const state = lifetime.getSnapshot();
      if (state.state !== 'signed-in') throw new Error('No signed in observation');
      client.setQueryData(viewerExposureQuery(state.observation).queryKey, {
        subject: state.observation.subject,
        admitted: ['selling', 'purchases'],
      });
    }
    admit();
    const pending: ((value: CreatorOffersCurrentRead) => void)[] = [];
    const reads = spyOn(offersApi, 'readCreatorOffersCurrent').mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const initial: CreatorOffersCurrentRead = {
      sessionSubject: creator,
      requested: { kind: 'list', cursor: null },
      data: data(),
    };
    const render = async () => {
      await act(async () =>
        privatePage.root.render(
          <QueryClientProvider client={client}>
            <CreatorOffersCurrent initial={initial} locale="en" />
          </QueryClientProvider>,
        ),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
    };
    try {
      await render();
      await privatePage.click(m.creator_inspect_open(), privatePage.rows()[0]!);
      expect(reads).not.toHaveBeenCalled();
      await act(async () => {
        session(id(90));
        admit();
        session(creator);
        admit();
      });
      await render();
      expect(privatePage.inspect()).toBeNull();
      await act(async () => {
        for (const resolve of pending) resolve(initial);
      });
      await render();
      expect(privatePage.inspect()).toBeNull();
      if (privatePage.rows().length) {
        await privatePage.click(m.creator_inspect_open(), privatePage.rows()[0]!);
        await act(async () => session(creator, 'replacement-csrf'));
        await render();
        expect(privatePage.inspect()).toBeNull();
      }
    } finally {
      reads.mockRestore();
      stop();
      await privatePage.close();
      client.clear();
    }
  });
});
