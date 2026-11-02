import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import { subjectOfferFixture as offer } from '../src/kernel/fake/subject-offers';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/subjects/example' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, value });
let session = { state: 'signed-in', subject: 'reader-a', csrfToken: null };
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () =>
    new Request(window.location.href, {
      headers: session.state === 'signed-in' ? { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } : {},
    }),
}));
mock.module('cloudflare:workers', () => ({
  env: {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({ credential: async () => ({ status: 'active', ...session, accessToken: session.subject }) }),
    },
  },
}));
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { SubjectOffersRegion } = await import('../src/checkout/subject-offers-region');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

test('healthy session reads, pagination and recovery retire on every current context change without mutation credentials', async () => {
  setLocale('en', { reload: false });
  const client = new QueryClient();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let context = { subjectId: offer.targetSubjectId, subjectType: 'work', locale: 'en' };
  const offers = [offer, { ...offer, id: '0192f3a0-6c1e-7b2a-9d4e-000000000099', title: 'Second offer' }];
  const page = { offers, next: 'native/+?=#cursor', projectionState: 'ready' };
  let respond = async () => Response.json(page);
  const calls: Request[] = [];
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push(new Request(url, init));
    return respond();
  });
  const observe = (state = 'signed-in', subject = 'reader-a') => {
    session = { state, subject, csrfToken: null };
    client.setQueryData(['session'], session);
  };
  const render = () =>
    root.render(
      <QueryClientProvider client={client}>
        <SubjectOffersRegion {...context} />
      </QueryClientProvider>,
    );
  const flush = async (change: () => void = () => {}) => {
    await act(async () => {
      change();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };
  const click = async (label: string) =>
    flush(() => {
      const button = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
      expect(button).toBeDefined();
      button!.click();
    });
  const rows = () => [...host.querySelectorAll('h3')].map((node) => node.textContent);
  try {
    observe();
    await flush(render);
    await flush();
    expect(rows()).toEqual(offers.map((row) => row.title));
    expect([...host.querySelectorAll('h3 a')].map((node) => node.getAttribute('href'))).toEqual(
      offers.map((row) => `/en/offers/${row.id}`),
    );
    await click(m.subject_purchase_next());
    await flush();
    expect(new URL(calls.at(-1)!.url).searchParams.get('cursor')).toBe(page.next);
    await click(m.subject_purchase_restart());
    await flush();
    expect(new URL(calls.at(-1)!.url).searchParams.has('cursor')).toBe(false);
    respond = async () => Response.json({}, { status: 503 });
    await click(m.subject_purchase_next());
    await flush();
    expect(rows()).toEqual([]);
    expect(host.textContent).toContain(m.subject_purchase_unavailable());
    respond = async () => Response.json(page);
    await click(m.subject_purchase_retry());
    await flush();
    expect(new URL(calls.at(-1)!.url).searchParams.get('cursor')).toBe(page.next);
    for (const change of [
      () => {
        observe('signed-in', 'reader-b');
        observe();
      },
      () => client.setQueryData(['exposure', 'viewer'], ['reading']),
      () => {
        context = { ...context, subjectId: offers[1]!.id };
        render();
      },
      () => {
        context = { ...context, locale: 'fr' };
        render();
      },
    ]) {
      let finish!: (response: Response) => void;
      respond = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      await click(m.subject_purchase_restart({}, { locale: context.locale as 'en' | 'fr' }));
      expect(rows()).toEqual([]);
      respond = async () => Response.json(page);
      await flush(change);
      await flush();
      expect(rows()).toEqual(offers.map((row) => row.title));
      await flush(() => finish(Response.json({ ...page, offers: [{ ...offer, title: 'Retired offer' }] })));
      expect(host.textContent).not.toContain('Retired offer');
      expect(new URL(calls.at(-1)!.url).searchParams.has('cursor')).toBe(false);
      await click(m.subject_purchase_next({}, { locale: context.locale as 'en' | 'fr' }));
      await flush();
    }
    expect(
      calls.every(
        (call) =>
          call.method === 'GET' &&
          call.headers.get('authorization') === 'Bearer reader-a' &&
          !call.headers.has('x-csrf-token') &&
          !call.headers.has('idempotency-key'),
      ),
    ).toBe(true);
    await flush(() => observe('unavailable'));
    expect(rows()).toEqual([]);
    const before = calls.length;
    await flush();
    expect(calls).toHaveLength(before);
    respond = async () => Response.json({}, { status: 403 });
    await flush(() => observe());
    await flush();
    expect(host.textContent).toContain(m.subject_purchase_denied({}, { locale: 'fr' }));
    expect(rows()).toEqual([]);
    expect(calls).toHaveLength(before + 1);
    respond = async () => Response.json({ ...page, offers: [] });
    await flush(() => observe('signed-out'));
    await flush();
    expect(calls.at(-1)!.headers.has('authorization')).toBe(false);
    expect(host.textContent).toContain(m.subject_purchase_empty({}, { locale: 'fr' }));
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    fetcher.mockRestore();
  }
});
