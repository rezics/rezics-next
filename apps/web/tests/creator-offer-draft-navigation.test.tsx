import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import { configuredPriceExample, creatorOfferFixture } from '../src/kernel/fake/creator-offers';
import type { CreatorEditorPageData, CreatorOfferResult } from '../src/checkout/creator-offers';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test'),
  setResponseHeader() {},
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/creator/offers/new' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLAnchorElement: window.HTMLAnchorElement,
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
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { CreatorOfferEditor } = await import('../src/checkout/creator-offer-editor');
const { CreatorOffersPage } = await import('../src/checkout/creator-offers-page');
const offers = await import('../src/checkout/creator-offers');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
const editionId = creatorOfferFixture.contentEdition!.benefit.resource.id;
const data: CreatorEditorPageData = {
  selling: true,
  csrfToken: 'csrf',
  createKey: crypto.randomUUID(),
  editor: {
    kind: 'ready',
    schema: configuredPriceExample,
    edition: {
      editionId,
      editionRevision: crypto.randomUUID(),
      state: 'published',
      targetSubjectId: creatorOfferFixture.targetSubjectId,
      creatorAccountId: creatorOfferFixture.contentEdition!.creatorAccountId,
      revisionId: crypto.randomUUID(),
      sha256: 'a'.repeat(64),
      licence: 'CC-BY-4.0',
    },
  },
};
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
async function mount(list = false) {
  let authorized = true;
  const guard = { isCurrent: () => authorized, csrfToken: () => (authorized ? 'csrf' : null) };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const render = () =>
    act(async () =>
      root.render(
        <RouterContextProvider router={router}>
          {list ? (
            <CreatorOffersPage
              locale="en"
              guard={guard}
              data={{
                selling: true,
                csrfToken: 'csrf',
                schema: configuredPriceExample,
                keys: { [creatorOfferFixture.id]: { reprice: crypto.randomUUID(), delist: crypto.randomUUID() } },
                page: { kind: 'ready', offers: [creatorOfferFixture], next: null },
              }}
            />
          ) : (
            <CreatorOfferEditor data={data} locale="en" guard={guard} />
          )}
        </RouterContextProvider>,
      ),
    );
  await render();
  const input = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const fill = (name: string, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(name), value);
      input(name).dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const click = (label: string) =>
    act(async () => {
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent === label);
      expect(button).toBeDefined();
      button!.click();
    });
  const unload = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  let destination = 0;
  const navigate = () =>
    act(async () => {
      void router.navigate({ href: `/elsewhere-${++destination}` });
    });
  const submit = () =>
    act(async () => {
      host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  const draft = async () => {
    await fill('title', '  Exact title  ');
    await act(async () => {
      const select = host.querySelector('select')!;
      select.value = 'usd';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await fill('price', '12.90');
    await fill('taxCode', 'txcd_10000000');
  };
  return {
    host,
    input,
    fill,
    click,
    unload,
    navigate,
    submit,
    draft,
    retire: async () => {
      authorized = false;
      await render();
    },
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('exact raw create edits prompt once, Stay preserves fields, edition and focus, reverting and Leave do not write', async () => {
  const write = spyOn(offers, 'manageCreatorOffer');
  const page = await mount();
  try {
    expect(page.unload()).toBe(false);
    await page.fill('title', 'invalid incomplete');
    expect(page.unload()).toBe(true);
    await page.fill('title', '');
    expect(page.unload()).toBe(false);
    await page.draft();
    page.input('price').focus();
    await act(async () => {
      page.host.querySelector<HTMLAnchorElement>('a')!.click();
    });
    expect(document.querySelectorAll('[role="alertdialog"]').length).toBe(1);
    await page.click(m.creator_offer_draft_navigation_stay());
    expect(page.input('title').value).toBe('  Exact title  ');
    expect(page.input('price').value).toBe('12.90');
    expect(page.host.querySelector('select')!.value).toBe('usd');
    expect(page.input('taxCode').value).toBe('txcd_10000000');
    expect(page.host.textContent).toContain(editionId);
    expect(document.activeElement).toBe(page.input('price'));
    await page.navigate();
    await page.click(m.creator_offer_draft_navigation_leave());
    expect(page.unload()).toBe(false);
    expect(page.input('title').value).toBe('');
    expect(write).not.toHaveBeenCalled();
  } finally {
    await page.close();
    write.mockRestore();
  }
});

test('leaving pending or uncertain create never cancels or replaces the original command; confirmed save stops warnings', async () => {
  let resolve!: (result: CreatorOfferResult) => void;
  const write = spyOn(offers, 'manageCreatorOffer').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const page = await mount();
  try {
    await page.draft();
    await page.submit();
    expect(page.unload()).toBe(true);
    await page.navigate();
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain(
      m.creator_offer_draft_navigation_uncertain(),
    );
    await page.click(m.creator_offer_draft_navigation_leave());
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ kind: 'retry' }));
    expect(page.unload()).toBe(true);
    await page.navigate();
    await page.click(m.creator_offer_draft_navigation_stay());
    await page.click(m.creator_retry());
    expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
    await act(async () => resolve({ kind: 'saved', id: creatorOfferFixture.id }));
    expect(page.unload()).toBe(false);
  } finally {
    await page.close();
    write.mockRestore();
  }
});

test('reprice protects invalid text, clears on exact reversion or saved result, and retirement dismisses the choice', async () => {
  const write = spyOn(offers, 'manageCreatorOffer').mockResolvedValue({ kind: 'saved', id: creatorOfferFixture.id });
  const page = await mount(true);
  try {
    await page.click(m.creator_offer_controls_manage());
    expect(page.unload()).toBe(false);
    await page.fill('price', '12.');
    expect(page.unload()).toBe(true);
    expect(page.host.textContent).toContain(m.creator_offer_draft_navigation_unsaved());
    await page.fill('price', '');
    expect(page.unload()).toBe(false);
    await page.fill('price', '12.90');
    await page.submit();
    expect(page.unload()).toBe(false);
  } finally {
    await page.close();
    write.mockRestore();
  }
  const retired = await mount();
  try {
    await retired.draft();
    await retired.navigate();
    await retired.retire();
    expect(retired.unload()).toBe(false);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  } finally {
    await retired.close();
  }
});
