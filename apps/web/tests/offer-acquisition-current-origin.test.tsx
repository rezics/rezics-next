import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { OfferPageData } from '../src/checkout/offer';
import * as recovery from '../src/checkout/offer-recovery';
import { acquisitionProblems } from '../src/kernel/fake/checkout';
import { fixedEditionTerms } from '../src/kernel/fake/entitlements';

mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
type Viewer = { state: 'signed-in' | 'signed-out' | 'unknown'; subject?: string | null; csrfToken: string | null };
const buyer: Viewer = { state: 'signed-in', subject: id(80), csrfToken: 'buyer-csrf' };
const other: Viewer = { ...buyer, subject: id(81), csrfToken: 'other-csrf' };
const signedOut: Viewer = { state: 'signed-out', subject: null, csrfToken: null };
const first: OfferPageData = {
  id: id(1),
  revision: 7,
  title: 'Original fixed edition',
  currency: 'usd',
  unitAmountMinor: 1200,
  state: 'active',
  price: '$12.00',
  taxBehavior: 'exclusive',
  moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
  idempotencyKey: id(2),
  subject: {
    subject: { id: fixedEditionTerms.targetSubjectId, title: 'Original subject', types: ['schema:Book'] },
    cover: null,
    href: null,
  },
  benefit: { kind: 'mapped', terms: fixedEditionTerms },
};
const second: OfferPageData = {
  ...first,
  id: id(3),
  revision: 9,
  idempotencyKey: id(4),
  title: 'Replacement edition',
  price: '$24.00',
};
const intent = (offer: OfferPageData) => ({
  offerId: offer.id,
  expectedOfferRevision: offer.revision,
  idempotencyKey: offer.idempotencyKey,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const checkout = (url = 'https://checkout.stripe.com/current') => Response.json({ checkoutUrl: url });

// Composed component regressions using the existing installed DOM facility and actual
// session/exposure hooks, query cache, page and decoder. UNRUN: deferred execution;
// constructed responses do not establish native or browser evidence.
async function withPage(run: (page: Awaited<ReturnType<typeof mountPage>>) => Promise<void>, routed = false) {
  const page = await mountPage(routed);
  try {
    await run(page);
  } finally {
    await page.dispose();
  }
}
async function mountPage(routed: boolean) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.test/en/offers/${first.id}?from=subject` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
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
  const { createRouter, createRootRoute, createRoute, createMemoryHistory, RouterContextProvider } =
    await import('@tanstack/react-router');
  const { OfferPage } = await import('../src/checkout/offer-page');
  const { AnonymousSessionContext } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const route = createRootRoute();
  const router = createRouter({
    routeTree: route.addChildren([createRoute({ getParentRoute: () => route, path: '/en/offers/$id' })]),
    history: createMemoryHistory({ initialEntries: [`/en/offers/${first.id}`] }),
  });
  const responses: Promise<Response>[] = [];
  const calls: { intent: recovery.OfferIntent; csrf: string | null }[] = [];
  const redirects: string[] = [];
  const assign = spyOn(window.location, 'assign').mockImplementation((url: string | URL) => {
    redirects.push(String(url));
  });
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(input).toBe('/checkout');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    calls.push({ intent: JSON.parse(String(init?.body)), csrf: new Headers(init?.headers).get('x-csrf-token') });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected checkout dispatch');
    return response;
  });
  const session = (viewer: Viewer) => client.setQueryData(['session'], viewer);
  const admission = (allowed: boolean, audience = 'viewer') =>
    client.setQueryData(['exposure', audience], allowed ? ['purchases'] : []);
  const render = async (offer = first, viewer = buyer, isolated = false) => {
    await act(async () => {
      if (routed) await router.navigate({ href: `/en/offers/${offer.id}` });
      session(viewer);
      admission(true);
      admission(true, 'anonymous');
      const page = <OfferPage offer={offer} />;
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <AnonymousSessionContext.Provider value={isolated}>
              {routed ? <RouterContextProvider router={router}>{page}</RouterContextProvider> : page}
            </AnonymousSessionContext.Provider>
          </QueryClientProvider>
        </StrictMode>,
      );
      await new Promise((done) => setTimeout(done, 0));
    });
  };
  const action = (label = m.offer_buy()) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
    if (!button) throw new Error(`Missing offer action: ${label}`);
    return button;
  };
  return {
    host,
    client,
    router,
    m,
    calls,
    redirects,
    render,
    action,
    session,
    admission,
    enqueue: (response: Response | Promise<Response>) => responses.push(Promise.resolve(response)),
    click: async (label = m.offer_buy()) => {
      await act(async () => action(label).click());
    },
    settle: async <T,>(work: ReturnType<typeof deferred<T>>, value: T) => {
      await act(async () => {
        work.resolve(value);
      });
    },
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      transport.mockRestore();
      assign.mockRestore();
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

test('signed-in without an actual subject or credential cannot acquire; unknown keeps public offer terms', async () => {
  await withPage(async (page) => {
    for (const viewer of [
      { state: 'signed-in' as const, csrfToken: buyer.csrfToken },
      { ...buyer, subject: null },
      { ...buyer, subject: '' },
      { ...buyer, csrfToken: null },
      { state: 'unknown' as const, csrfToken: null },
    ]) {
      await page.render(first, viewer);
      expect(page.host.textContent).toContain(first.title);
      expect(page.host.textContent).toContain(first.price);
      expect(page.action().disabled).toBe(true);
      await page.click();
    }
    expect(page.calls).toEqual([]);
    expect(page.redirects).toEqual([]);
  });
});

test('actual cache replacement retires the retained button before commit, including observed ABA', async () => {
  await withPage(async (page) => {
    await page.render();
    const old = page.action();
    await act(async () => {
      page.session(other);
      expect(page.action()).toBe(old); // The replacement React tree has not committed.
      old.click();
      page.session(buyer);
      old.click();
      expect(page.calls).toEqual([]);
    });
    expect(page.action().disabled).toBe(false);
    for (const lost of [
      { ...buyer, subject: null },
      { ...buyer, csrfToken: null },
      signedOut,
      { state: 'unknown' as const, csrfToken: null },
    ]) {
      const retained = page.action();
      await act(async () => {
        page.session(lost);
        retained.click();
        page.session(buyer);
        retained.click();
        expect(page.calls).toEqual([]);
        expect(page.redirects).toEqual([]);
      });
      expect(page.action().disabled).toBe(false);
    }
    const admitted = page.action();
    await act(async () => {
      page.admission(false);
      admitted.click();
      page.admission(true);
      admitted.click();
      expect(page.calls).toEqual([]);
    });
    // A replacement lifetime remains usable after all observed retirements.
    page.enqueue(checkout());
    await page.click();
    expect(page.calls).toEqual([{ intent: intent(first), csrf: buyer.csrfToken }]);
    expect(page.redirects).toEqual(['https://checkout.stripe.com/current']);
  });
});

test('actual offer navigation retires the retained action before the replacement route commits', async () => {
  await withPage(async (page) => {
    await page.render();
    const retained = page.action();
    page.enqueue(checkout());
    const unsubscribe = page.router.subscribe('onBeforeNavigate', () => {
      expect(page.action()).toBe(retained);
      retained.click();
      expect(page.calls).toEqual([]);
    });
    try {
      await act(async () => {
        await page.router.navigate({ href: `/en/offers/${second.id}` });
      });
    } finally {
      unsubscribe();
    }
    expect(page.action().disabled).toBe(true);
    await page.render(second, other);
    expect(page.action().disabled).toBe(false);
    await page.click();
    // Only the deliberate current click consumed the queued response.
    expect(page.calls).toEqual([{ intent: intent(second), csrf: other.csrfToken }]);
    expect(page.redirects).toEqual(['https://checkout.stripe.com/current']);
  }, true);
});

test('current viewer/offer can acquire while the old one is pending; viewer and offer ABA cannot revive it', async () => {
  await withPage(async (page) => {
    const original = deferred<Response>();
    page.enqueue(original.promise);
    await page.render();
    await page.click();
    await page.render(second, other);
    expect(page.action().disabled).toBe(false);
    const replacement = deferred<Response>();
    page.enqueue(replacement.promise);
    await page.click();
    await page.settle(original, Response.json(acquisitionProblems.owned, { status: 409 }));
    expect(page.host.querySelector('a[href*="/entitlements/"], a[href*="/orders/"]')).toBeNull();
    expect(page.host.textContent).toContain(second.title);
    await page.render(first, buyer);
    const returned = deferred<Response>();
    page.enqueue(returned.promise);
    await page.click();
    await page.settle(replacement, checkout('https://checkout.stripe.com/retired'));
    expect(page.redirects).toEqual([]);
    expect(page.calls).toEqual([
      { intent: intent(first), csrf: buyer.csrfToken },
      { intent: intent(second), csrf: other.csrfToken },
      { intent: intent(first), csrf: buyer.csrfToken },
    ]);
    await page.settle(returned, checkout());
    expect(page.redirects).toEqual(['https://checkout.stripe.com/current']);
  });
});

test('cache retirement during decoding refuses late checkout and private recovery, even after ABA before commit', async () => {
  for (const response of [
    checkout(),
    Response.json(acquisitionProblems.owned, { status: 409 }),
    Response.json(acquisitionProblems.pending, { status: 409 }),
  ]) {
    await withPage(async (page) => {
      const body = deferred<unknown>();
      const payload = await response.clone().json();
      spyOn(response, 'json').mockImplementation(() => body.promise);
      page.enqueue(response);
      await page.render();
      await page.click();
      await act(async () => {
        page.client.removeQueries({ queryKey: ['session'], exact: true });
        page.session(buyer);
        page.client.removeQueries({ queryKey: ['exposure', 'viewer'], exact: true });
        page.admission(true);
        body.resolve(payload);
        await body.promise;
      });
      expect(page.redirects).toEqual([]);
      expect(page.host.querySelector('a[href*="/entitlements/"], a[href*="/orders/"]')).toBeNull();
      expect(page.host.querySelector('[data-slot="offer-decision"] [role="status"]')).toBeNull();
      expect(page.action().disabled).toBe(false);
      // The newly current lifetime may still present parsed native recovery.
      page.enqueue(Response.json({ ...acquisitionProblems.pending, href: 'https://attacker.test' }, { status: 409 }));
      await page.click();
      const link = page.host.querySelector<HTMLAnchorElement>('a[href*="/orders/"]')!;
      expect(link.getAttribute('href')?.endsWith(`/orders/${acquisitionProblems.pending.orderId}`)).toBe(true);
      await act(async () => {
        page.session(other);
        const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
        expect(link.dispatchEvent(event)).toBe(false);
        expect(event.defaultPrevented).toBe(true);
      });
      expect(page.calls).toHaveLength(2);
    });
  }
});

test('same owner refresh and token rotation retain exact uncertain consent, request instance and explicit retry', async () => {
  const factory = spyOn(recovery, 'createOfferRequest');
  try {
    await withPage(async (page) => {
      const pending = deferred<Response>();
      page.enqueue(pending.promise);
      await page.render();
      await act(async () => {
        page.action().click();
        page.action().click();
      });
      const refreshed = { ...second, id: first.id, state: 'delisted' as const, benefit: { kind: 'unknown' as const } };
      await page.render(refreshed, { ...buyer, csrfToken: 'rotated-while-pending' });
      expect(page.host.textContent).toContain(first.title);
      expect(page.host.textContent).toContain(first.price);
      expect(page.host.textContent).toContain(page.m.offer_terms_revision({ revision: String(first.revision) }));
      expect(page.host.textContent).toContain(page.m.benefit_acquisition());
      expect(page.host.querySelector('article')!.dataset.idempotencyKey).toBe(first.idempotencyKey);
      expect(page.calls).toHaveLength(1);
      await page.settle(pending, Response.json({}, { status: 503 }));
      expect(page.action(page.m.offer_retry()).disabled).toBe(false);
      page.enqueue(checkout());
      await act(async () => {
        // Rotation is visible in the cache before a replacement render or layout effect.
        page.session({ ...buyer, csrfToken: 'latest-at-dispatch' });
        const retry = page.action(page.m.offer_retry());
        retry.click();
        retry.click();
      });
      expect(factory).toHaveBeenCalledTimes(1);
      expect(page.calls).toEqual([
        { intent: intent(first), csrf: buyer.csrfToken },
        { intent: intent(first), csrf: 'latest-at-dispatch' },
      ]);
      expect(page.redirects).toEqual(['https://checkout.stripe.com/current']);
    });
  } finally {
    factory.mockRestore();
  }
});

test('signed-out sign-in uses actual public admission and isolated anonymous context without borrowing the viewer', async () => {
  await withPage(async (page) => {
    await page.render(first, signedOut);
    const old = page.action();
    await act(async () => {
      page.session({ state: 'unknown', csrfToken: null });
      old.click();
      page.session(signedOut);
      old.click();
    });
    expect(page.redirects).toEqual([]);
    await page.render(first, buyer, true);
    await act(async () => {
      page.admission(false, 'anonymous');
    });
    expect(page.action().disabled).toBe(true);
    await act(async () => {
      page.admission(true, 'anonymous');
    });
    expect(page.action().disabled).toBe(false);
    const isolated = page.action();
    await act(async () => {
      page.admission(false, 'anonymous');
      isolated.click();
      page.admission(true, 'anonymous');
      isolated.click();
    });
    expect(page.redirects).toEqual([]);
    await page.click();
    expect(page.redirects).toEqual([
      `/auth/sign-in?return_to=${encodeURIComponent(`/en/offers/${first.id}?from=subject`)}`,
    ]);
    expect(page.calls).toEqual([]);
  });
});
