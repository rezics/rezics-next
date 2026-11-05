import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { OfferPageData } from '../src/checkout/offer';
import type { OfferIntent } from '../src/checkout/offer-recovery';
import { acquisitionProblems } from '../src/kernel/fake/checkout';
import { fixedEditionTerms } from '../src/kernel/fake/entitlements';

mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const buyer = id(80);
type Viewer = {
  state: 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
  csrfToken: string | null;
  subject?: string | null;
};
const signedIn: Viewer = { state: 'signed-in', subject: buyer, csrfToken: 'buyer-csrf' };
const first: OfferPageData = {
  id: id(1),
  revision: 7,
  title: 'First fixed edition',
  currency: 'usd',
  unitAmountMinor: 1200,
  state: 'active',
  price: '$12.00',
  taxBehavior: 'exclusive',
  moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
  idempotencyKey: id(2),
  subject: {
    subject: { id: fixedEditionTerms.targetSubjectId, title: 'First subject', types: ['schema:Book'] },
    cover: null,
    href: null,
  },
  benefit: { kind: 'mapped', terms: fixedEditionTerms },
};
const second: OfferPageData = {
  ...first,
  id: id(4),
  revision: 9,
  title: 'Second fixed edition',
  unitAmountMinor: 2400,
  price: '$24.00',
  idempotencyKey: id(5),
  subject: { ...first.subject, subject: { ...first.subject.subject, title: 'Second subject' } },
};
const repriced: OfferPageData = { ...second, id: first.id, state: 'delisted' };
const intent = (offer: OfferPageData): OfferIntent => ({
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
const staleResults = {
  checkout: () => checkout('https://checkout.stripe.com/stale'),
  order: () => Response.json({ orderId: id(3) }),
  owned: () => Response.json(acquisitionProblems.owned, { status: 409 }),
  pending: () => Response.json(acquisitionProblems.pending, { status: 409 }),
  terms: () => Response.json({ code: 'offer_revision_conflict' }, { status: 409 }),
  unavailable: () => Response.json({ code: 'offer_unavailable' }, { status: 409 }),
  closed: () => Response.json({ code: 'platform_closed' }, { status: 403 }),
  retry: () => Response.json({}, { status: 503 }),
};

// Constructed responses exercise the mounted production page, hooks and request decoder.
// They are component regressions, not native evidence.
async function withPage(run: (page: Awaited<ReturnType<typeof mountPage>>) => Promise<void>) {
  const page = await mountPage();
  try {
    await run(page);
  } finally {
    await page.dispose();
  }
}

async function mountPage() {
  // Reuse the installed DOM facility, as the existing mounted Library regressions do.
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
  const { OfferPage } = await import('../src/checkout/offer-page');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const responses: Promise<Response>[] = [];
  const calls: { intent: OfferIntent; csrf: string | null }[] = [];
  const redirects: string[] = [];
  let reloads = 0;
  const assign = spyOn(window.location, 'assign').mockImplementation((url: string | URL) => {
    redirects.push(String(url));
  });
  const reload = spyOn(window.location, 'reload').mockImplementation(() => {
    reloads++;
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
  let mounted = true;
  const render = async (offer = first, viewer = signedIn, admitted = true) => {
    await act(async () => {
      client.setQueryData(['session'], viewer);
      client.setQueryData(['exposure', 'viewer'], admitted ? ['purchases'] : []);
      client.setQueryData(['exposure', 'anonymous'], admitted ? ['purchases'] : []);
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <OfferPage offer={offer} />
          </QueryClientProvider>
        </StrictMode>,
      );
      await new Promise((done) => setTimeout(done, 0));
    });
  };
  const action = (label = m.offer_buy()) => {
    const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label);
    if (!node) throw new Error(`Missing offer action: ${label}`);
    return node;
  };
  const click = async (label = m.offer_buy(), twice = false) => {
    await act(async () => {
      const node = action(label);
      node.click();
      if (twice) node.click();
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
    redirects,
    render,
    action,
    click,
    unmount,
    reloads: () => reloads,
    enqueue: (response: Response | Promise<Response>) => responses.push(Promise.resolve(response)),
    async settle<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
      await act(async () => {
        pending.resolve(value);
      });
    },
    async disclose() {
      const details = host.querySelector('details')!;
      await act(async () => {
        details.open = true;
        details.dispatchEvent(new window.Event('toggle'));
      });
      return details;
    },
    async dispose() {
      if (mounted) await unmount();
      client.clear();
      transport.mockRestore();
      assign.mockRestore();
      reload.mockRestore();
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

test('navigation during response body decoding cannot redirect or disclose original recovery', async () => {
  for (const response of [staleResults.checkout, staleResults.owned, staleResults.pending]) {
    await withPage(async (page) => {
      const completed = response();
      const payload = await completed.clone().json();
      const body = deferred<unknown>();
      spyOn(completed, 'json').mockImplementation(() => body.promise);
      page.enqueue(completed);
      await page.render();
      await page.click();
      await page.render(second);
      await page.settle(body, payload);
      expect(page.redirects).toEqual([]);
      expect(page.action().disabled).toBe(false);
      expect(page.host.querySelector('a[href*="/orders/"], a[href*="/entitlements/"]')).toBeNull();
      expect(page.host.querySelector('[data-slot="offer-decision"] [role="status"]')).toBeNull();
    });
  }
});

for (const [kind, response] of Object.entries(staleResults)) {
  test(`Offer navigation cannot retain another offer purchase intent or redirect from a stale checkout completion: ${kind}`, async () => {
    await withPage(async (page) => {
      const pending = deferred<Response>();
      page.enqueue(pending.promise);
      await page.render();
      await page.disclose();
      await page.click(undefined, true);
      expect(page.calls).toEqual([{ intent: intent(first), csrf: signedIn.csrfToken }]);

      await page.render({ ...second, state: 'delisted' });
      expect(page.host.textContent).toContain(second.title);
      expect(page.host.textContent).toContain(page.m.offer_unavailable());
      expect(page.action().disabled).toBe(true);
      // A different active offer is usable even while the original write is pending.
      const current = { ...second, id: id(6) };
      await page.render(current);
      expect(page.host.textContent).toContain(second.price);
      expect(page.host.textContent).not.toContain(first.title);
      expect(page.host.querySelector('details')!.open).toBe(false);
      expect(page.action().disabled).toBe(false);
      const currentPending = deferred<Response>();
      page.enqueue(currentPending.promise);
      await page.click();
      expect(page.calls.map((call) => call.intent)).toEqual([intent(first), intent(current)]);
      await page.settle(pending, response());
      expect(page.redirects).toEqual([]);
      expect(page.host.querySelector('[data-slot="offer-decision"] [role="status"]')).toBeNull();
      expect(page.host.querySelector('a[href*="/orders/"], a[href*="/entitlements/"]')).toBeNull();
      expect(page.action().disabled).toBe(true);
      await page.settle(currentPending, checkout());
      expect(page.redirects).toEqual(['https://checkout.stripe.com/current']);
    });
  });
}

for (const bodyPending of [false, true]) {
  test(`unmount retires checkout and recovery after ${bodyPending ? 'body decoding' : 'dispatch'}`, async () => {
    for (const response of [staleResults.checkout, staleResults.owned, staleResults.pending]) {
      await withPage(async (page) => {
        const pending = deferred<Response>();
        const body = deferred<unknown>();
        const completed = response();
        const payload = await completed.clone().json();
        if (bodyPending) spyOn(completed, 'json').mockImplementation(() => body.promise);
        page.enqueue(bodyPending ? completed : pending.promise);
        await page.render();
        await page.click();
        await page.unmount();
        if (bodyPending) await page.settle(body, payload);
        else await page.settle(pending, completed);
        expect(page.redirects).toEqual([]);
        expect(page.host.textContent).toBe('');
        expect(page.calls).toHaveLength(1);
      });
    }
  });
}

const authorityChanges: [string, Viewer, boolean][] = [
  ['actual viewer', { ...signedIn, subject: id(81) }, true],
  ['signed out', { state: 'signed-out', csrfToken: null, subject: null }, true],
  ['unknown session', { state: 'unknown', csrfToken: null }, true],
  ['unavailable session', { state: 'unavailable', csrfToken: null }, true],
  ['lost CSRF', { ...signedIn, csrfToken: null }, true],
  ['lost admission', signedIn, false],
];
for (const [name, viewer, admitted] of authorityChanges) {
  test(`${name} retires pending results even when original authority returns before completion`, async () => {
    for (const response of [staleResults.checkout, staleResults.owned, staleResults.pending]) {
      await withPage(async (page) => {
        const pending = deferred<Response>();
        page.enqueue(pending.promise);
        await page.render();
        await page.click();
        await page.render(first, viewer, admitted);
        if (
          !admitted ||
          viewer.state === 'unknown' ||
          viewer.state === 'unavailable' ||
          (viewer.state === 'signed-in' && !viewer.csrfToken)
        ) {
          expect(page.action().disabled).toBe(true);
          await page.click();
          expect(page.calls).toHaveLength(1);
          expect(page.redirects).toEqual([]);
        }
        await page.render();
        await page.settle(pending, response());
        expect(page.redirects).toEqual([]);
        expect(page.action().disabled).toBe(false);
        expect(page.host.querySelector('a[href*="/orders/"], a[href*="/entitlements/"]')).toBeNull();
        expect(page.calls).toHaveLength(1);
      });
    }
  });
}

test('same-offer refresh and repricing preserve uncertain consent, request identity, disclosure and deliberate retry', async () => {
  await withPage(async (page) => {
    const pending = deferred<Response>();
    page.enqueue(pending.promise);
    await page.render();
    const disclosure = await page.disclose();
    await page.click(undefined, true);
    await page.render(repriced);
    expect(page.host.textContent).toContain(first.title);
    expect(page.host.textContent).toContain(first.price);
    expect(page.host.textContent).toContain(page.m.offer_terms_revision({ revision: String(first.revision) }));
    expect(page.host.querySelector('article')!.dataset.idempotencyKey).toBe(first.idempotencyKey);
    expect(page.host.querySelector('details')).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    expect(disclosure.textContent).toContain(first.title);
    expect(page.calls).toHaveLength(1);
    await page.settle(pending, Response.json({}, { status: 503 }));
    const rotated = { ...signedIn, csrfToken: 'fresh-buyer-csrf' };
    await page.render({ ...repriced }, rotated);
    expect(page.host.textContent).toContain(page.m.offer_retry_note());
    expect(page.action(page.m.offer_retry()).disabled).toBe(false);
    expect(page.calls).toHaveLength(1);
    const retried = deferred<Response>();
    page.enqueue(retried.promise);
    await page.click(page.m.offer_retry(), true);
    expect(page.calls).toEqual([
      { intent: intent(first), csrf: signedIn.csrfToken },
      { intent: intent(first), csrf: rotated.csrfToken },
    ]);
    await page.settle(retried, checkout());
    expect(page.redirects).toEqual(['https://checkout.stripe.com/current']);
  });
});

test('current native recovery and explicit terms review persist across same-offer rerenders, then clear for a new viewer', async () => {
  for (const [response, label, href] of [
    [staleResults.owned, 'owned', `/entitlements/${acquisitionProblems.owned.entitlementId}`],
    [staleResults.pending, 'pending', `/orders/${acquisitionProblems.pending.orderId}`],
    [staleResults.terms, 'terms', null],
    [staleResults.unavailable, 'unavailable', null],
    [staleResults.closed, 'closed', null],
  ] as const) {
    await withPage(async (page) => {
      page.enqueue(response());
      await page.render();
      await page.click();
      const disclosure = await page.disclose();
      await page.render({ ...repriced });
      expect(page.host.textContent).toContain(first.price);
      expect(page.host.querySelector('details')).toBe(disclosure);
      if (href) expect(page.host.querySelector(`a[href$="${href}"]`)).not.toBeNull();
      else if (label === 'terms') {
        expect(page.host.textContent).toContain(page.m.offer_terms_changed());
        await page.click(page.m.offer_review_terms());
        expect(page.reloads()).toBe(1);
      } else if (label === 'closed') {
        expect(page.host.textContent).toContain(page.m.offer_start_closed());
        expect(page.host.querySelector('button')).toBeNull();
      } else expect(page.host.textContent).toContain(page.m.offer_unavailable());
      expect(page.calls).toHaveLength(1);
      expect(page.redirects).toEqual([]);
      await page.render(first, { ...signedIn, subject: id(81) });
      expect(page.action().disabled).toBe(false);
      expect(page.host.querySelector('a[href*="/orders/"], a[href*="/entitlements/"]')).toBeNull();
      expect(page.host.querySelector('[data-slot="offer-decision"] [role="status"]')).toBeNull();
    });
  }
});

test('before submission, same-offer availability refresh preserves disclosure and uses the currently displayed draft', async () => {
  await withPage(async (page) => {
    await page.render();
    const disclosure = await page.disclose();
    await page.render(repriced);
    expect(page.action().disabled).toBe(true);
    expect(page.host.textContent).toContain(page.m.offer_unavailable());
    const active = { ...repriced, state: 'active' as const };
    await page.render(active);
    expect(page.action().disabled).toBe(false);
    expect(page.host.querySelector('details')).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    expect(page.calls).toHaveLength(0);
    page.enqueue(checkout());
    await page.click();
    expect(page.calls.map((call) => call.intent)).toEqual([intent(active)]);
    expect(page.redirects).toEqual(['https://checkout.stripe.com/current']);
  });
});

test('an admitted signed-out buyer keeps current-page sign-in; unknown session keeps loader terms without dispatch', async () => {
  await withPage(async (page) => {
    await page.render(first, { state: 'unknown', csrfToken: null });
    expect(page.host.textContent).toContain(first.title);
    expect(page.host.textContent).toContain(first.price);
    expect(page.action().disabled).toBe(true);
    await page.click();
    await page.render(first, { state: 'signed-out', csrfToken: null, subject: null });
    expect(page.action().disabled).toBe(false);
    await page.click();
    expect(page.redirects).toEqual([
      `/auth/sign-in?return_to=${encodeURIComponent(`/en/offers/${first.id}?from=subject`)}`,
    ]);
    expect(page.calls).toHaveLength(0);
  });
});
