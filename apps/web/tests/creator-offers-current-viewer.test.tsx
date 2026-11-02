import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { EditionMetadata } from '../src/content-editions/edition-api';
import type {
  CreatorEditorCurrentRead,
  CreatorOffersCurrentRead,
  CreatorOfferMutation,
  CreatorOfferResult,
} from '../src/checkout/creator-offers';
import { configuredPriceExample, creatorOfferFixture } from '../src/kernel/fake/creator-offers';

// UNRUN: focused mounted/deferred assertions for integration. These fixtures prove neither native
// authorization nor browser/visual acceptance. Reuse the installed DOM and ordinary Query provider.
const id = (n: number) => `019a2100-0000-7000-8000-${String(n).padStart(12, '0')}`;
const A = creatorOfferFixture.contentEdition!.creatorAccountId;
const B = id(90);
const edition: EditionMetadata = {
  editionId: creatorOfferFixture.contentEdition!.benefit.resource.id,
  editionRevision: id(2),
  state: 'published',
  targetSubjectId: creatorOfferFixture.targetSubjectId,
  creatorAccountId: A,
  revisionId: id(3),
  sha256: 'a'.repeat(64),
  licence: 'CC-BY-4.0',
};
const cookieRequest = () =>
  new Request('https://site.test/en/creator/offers', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
let actualRequest = cookieRequest();
let preparedSubject: string | undefined = A;
let preparation: 'active' | 'absent' = 'active';
let preparations = 0;
const headers = new Headers();
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => actualRequest,
  setResponseHeader: (name: string, value: string) => headers.set(name, value),
}));
mock.module('cloudflare:workers', () => ({
  env: {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        credential: async () => {
          preparations++;
          return preparation === 'absent'
            ? { status: 'absent' }
            : {
                status: 'active',
                accessToken: `seller-${preparations}`,
                subject: preparedSubject,
                csrfToken: 'prepared-csrf',
              };
        },
        // Identity/CSRF lookup remains distinct and cannot lend its different subject to the read.
        signedIn: async () => ({ signedIn: true, subject: B, csrfToken: 'identity-csrf' }),
      }),
    },
  },
}));
afterAll(() => mock.restore());
const readers = await import('../src/checkout/creator-offers');

function list(subject = A, cursor: string | null = null, title = 'Origin offer'): CreatorOffersCurrentRead {
  return {
    sessionSubject: subject,
    requested: { kind: 'list', cursor },
    data: {
      selling: true,
      csrfToken: 'loader-csrf',
      schema: configuredPriceExample,
      keys: { [creatorOfferFixture.id]: { reprice: id(11), delist: id(12) } },
      page: {
        kind: 'ready',
        next: null,
        offers: [
          {
            ...creatorOfferFixture,
            title,
            contentEdition: { ...creatorOfferFixture.contentEdition!, creatorAccountId: subject },
          },
        ],
      },
    },
  };
}
function editor(subject = A, editionId = edition.editionId): CreatorEditorCurrentRead {
  return {
    sessionSubject: subject,
    requested: { kind: 'editor', contentEditionId: editionId },
    data: {
      selling: true,
      csrfToken: 'loader-csrf',
      createKey: subject === A ? id(13) : id(14),
      editor: {
        kind: 'ready',
        edition: { ...edition, editionId, creatorAccountId: subject },
        schema: configuredPriceExample,
      },
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Viewer = { state: 'signed-in' | 'signed-out' | 'unknown'; subject: string | null; csrfToken: string | null };
const viewer = (subject = A, csrfToken = 'csrf-current'): Viewer => ({ state: 'signed-in', subject, csrfToken });

async function mounted() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/creator/offers' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { CreatorOffersCurrent, CreatorOfferEditorCurrent } = await import('../src/checkout/creator-offers-current');
  const { m } = await import('../src/paraglide/messages.js');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const lists: { data: { cursor?: string }; work: ReturnType<typeof deferred<CreatorOffersCurrentRead>> }[] = [];
  const editions: {
    data: { contentEditionId?: string };
    work: ReturnType<typeof deferred<CreatorEditorCurrentRead>>;
  }[] = [];
  const writes: {
    data: CreatorOfferMutation;
    csrf: string | null;
    work: ReturnType<typeof deferred<CreatorOfferResult>>;
  }[] = [];
  const spies = [
    spyOn(readers, 'readCreatorOffersCurrent').mockImplementation((input) => {
      const work = deferred<CreatorOffersCurrentRead>();
      lists.push({ data: input.data, work });
      return work.promise;
    }),
    spyOn(readers, 'readCreatorOfferEditorCurrent').mockImplementation((input) => {
      const work = deferred<CreatorEditorCurrentRead>();
      editions.push({ data: input.data, work });
      return work.promise;
    }),
    spyOn(readers, 'manageCreatorOffer').mockImplementation((input) => {
      const work = deferred<CreatorOfferResult>();
      writes.push({ data: structuredClone(input.data), csrf: new Headers(input.headers).get('X-CSRF-Token'), work });
      return work.promise;
    }),
  ];
  const render = async ({
    initial = list(),
    cursor,
    contentEditionId = edition.editionId,
    session = viewer(),
    admitted = true,
    publicOffer = true,
    locale = 'en',
  }: {
    initial?: CreatorOffersCurrentRead | CreatorEditorCurrentRead;
    cursor?: string;
    contentEditionId?: string;
    session?: Viewer;
    admitted?: boolean;
    publicOffer?: boolean;
    locale?: string;
  } = {}) => {
    await act(async () => {
      client.setQueryData(['session'], session);
      client.setQueryData(
        ['exposure', 'viewer'],
        [...(admitted ? ['selling'] : []), ...(publicOffer ? ['purchases'] : [])],
      );
      client.setQueryData(['exposure', 'anonymous'], ['selling', 'purchases']);
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            {'page' in initial.data ? (
              <CreatorOffersCurrent initial={initial as CreatorOffersCurrentRead} locale={locale} cursor={cursor} />
            ) : (
              <CreatorOfferEditorCurrent
                initial={initial as CreatorEditorCurrentRead}
                locale={locale}
                contentEditionId={contentEditionId}
              />
            )}
          </QueryClientProvider>
        </StrictMode>,
      );
    });
  };
  const input = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const fill = async (name: string, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(name), value);
      input(name).dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const submit = async (twice = false) => {
    await act(async () => {
      const form = host.querySelector('form')!;
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      if (twice) form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  const chooseCurrency = async () => {
    await act(async () => {
      const select = host.querySelector('select')!;
      select.value = 'usd';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };
  const settle = async <T,>(work: ReturnType<typeof deferred<T>>, value: T | Error) => {
    await act(async () => {
      if (value instanceof Error) work.reject(value);
      else work.resolve(value);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const oldSubmit = () => {
    const form = host.querySelector('form')!;
    const key = Object.getOwnPropertyNames(form).find((name) => name.startsWith('__reactProps$'))!;
    return (form as unknown as Record<string, { onSubmit(event: { preventDefault(): void }): void }>)[key]!.onSubmit;
  };
  return {
    host,
    m,
    lists,
    editions,
    writes,
    render,
    input,
    fill,
    submit,
    click,
    button,
    chooseCurrency,
    settle,
    oldSubmit,
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      spies.forEach((spy) => spy.mockRestore());
      host.remove();
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
async function withPage(run: (page: Awaited<ReturnType<typeof mounted>>) => Promise<void>) {
  const page = await mounted();
  try {
    await run(page);
  } finally {
    await page.dispose();
  }
}

describe('Creator offer list creation reprice and delist accept only their actual current viewer and originating admitted address lifetime', () => {
  test('actual preparations bind empty pages and exact editions without borrowing identity or explicit-header subjects', async () => {
    actualRequest = cookieRequest();
    preparedSubject = A;
    preparation = 'active';
    preparations = 0;
    const calls: Request[] = [];
    let returnedEdition = edition;
    let offers = [] as (typeof creatorOfferFixture)[];
    let admitted = true;
    const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      switch (new URL(call.url).pathname) {
        case '/v1/platform/exposure':
          return Response.json({ admitted: admitted ? ['selling'] : [] });
        case '/v1/offers':
          return Response.json({ offers, next: null });
        case '/v1/commerceMoney':
          return Response.json(configuredPriceExample);
        default:
          return Response.json(returnedEdition);
      }
    });
    try {
      const empty = await readers.readCreatorOffersCurrent({ data: { cursor: '' } });
      expect(empty.sessionSubject).toBe(A);
      expect(empty.requested).toEqual({ kind: 'list', cursor: null });
      expect(empty.data.page).toEqual({ kind: 'ready', offers: [], next: null });
      expect(empty.data.csrfToken).toBe('identity-csrf');
      expect(preparations).toBe(1);
      expect(
        calls.every(
          (call) =>
            call.headers.get('authorization') === 'Bearer seller-1' &&
            call.cache === 'no-store' &&
            call.redirect === 'manual',
        ),
      ).toBe(true);
      expect(new URL(calls[1]!.url).search).toBe('?limit=20');
      const selected = await readers.readCreatorOfferEditorCurrent({ data: { editionId: edition.editionId } });
      expect(selected.sessionSubject).toBe(A);
      expect(selected.requested).toEqual({ kind: 'editor', contentEditionId: edition.editionId });
      expect(selected.data.editor.kind).toBe('ready');
      expect(preparations).toBe(2);
      expect(calls.slice(3).every((call) => call.headers.get('authorization') === 'Bearer seller-2')).toBe(true);
      returnedEdition = { ...edition, creatorAccountId: B };
      expect(
        (await readers.readCreatorOfferEditorCurrent({ data: { contentEditionId: edition.editionId } })).data.editor
          .kind,
      ).toBe('denied');
      returnedEdition = { ...edition, editionId: id(80) };
      expect(
        (await readers.readCreatorOfferEditorCurrent({ data: { contentEditionId: edition.editionId } })).data.editor
          .kind,
      ).toBe('unavailable');
      offers = [
        { ...creatorOfferFixture, contentEdition: { ...creatorOfferFixture.contentEdition!, creatorAccountId: B } },
      ];
      expect((await readers.readCreatorOffersCurrent({ data: {} })).data.page.kind).toBe('unavailable');
      calls.length = 0;
      preparedSubject = undefined;
      expect((await readers.readCreatorOffersCurrent({ data: {} })).sessionSubject).toBeNull();
      expect(
        (await readers.readCreatorOfferEditorCurrent({ data: { contentEditionId: edition.editionId } })).data.editor
          .kind,
      ).toBe('denied');
      expect(calls).toHaveLength(0);
      preparedSubject = A;
      preparation = 'absent';
      expect((await readers.readCreatorOffersCurrent({ data: {} })).data.page.kind).toBe('denied');
      expect(calls).toHaveLength(0);
      actualRequest = new Request('https://site.test', { headers: { authorization: 'Bearer explicit' } });
      expect((await readers.readCreatorOffersCurrent({ data: {} })).sessionSubject).toBeNull();
      expect(calls).toHaveLength(0);
      actualRequest = cookieRequest();
      preparation = 'active';
      admitted = false;
      expect((await readers.readCreatorOffersCurrent({ data: {} })).data.page.kind).toBe('closed');
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/platform/exposure']);
      expect(headers.get('cache-control')).toBe('private, no-store');
      expect(headers.get('x-robots-tag')).toBe('noindex, nofollow');
    } finally {
      transport.mockRestore();
    }
  });

  test('mismatched empty provenance stays pending; viewer and admission retirement never revive old loader data', async () =>
    withPage(async (page) => {
      const initial = list();
      initial.data.page = { kind: 'ready', offers: [], next: null };
      await page.render({ initial, session: viewer(B) });
      expect(page.host.textContent).not.toContain(page.m.creator_offers_empty());
      expect(page.lists).toHaveLength(1);
      await page.settle(page.lists[0]!.work, initial);
      expect(page.host.textContent).not.toContain(page.m.creator_offers_empty());
      await page.render({ initial, session: viewer(A) });
      expect(page.lists).toHaveLength(2);
      await page.settle(page.lists[1]!.work, list(A, null, 'Accepted A'));
      expect(page.host.textContent).toContain('Accepted A');
      await page.render({ initial, admitted: false });
      expect(page.host.textContent).not.toContain('Accepted A');
      expect(page.host.querySelector('input')).toBeNull();
      await page.render({ initial });
      expect(page.lists).toHaveLength(3);
      expect(page.host.textContent).not.toContain('Accepted A');
      await page.settle(page.lists[2]!.work, list());
      await page.render({ initial, session: { state: 'unknown', subject: null, csrfToken: null } });
      expect(page.host.querySelector('input')).toBeNull();
      await page.render({ initial, session: { state: 'signed-in', subject: null, csrfToken: 'csrf' } });
      expect(page.host.querySelector('input')).toBeNull();
      await page.render({ initial, session: { state: 'signed-out', subject: null, csrfToken: null } });
      expect(page.host.querySelector('input')).toBeNull();
    }));

  test('B can read and delist before A completes; old reprice callbacks and address ABA are fenced', async () =>
    withPage(async (page) => {
      const initial = list();
      await page.render({ initial });
      await page.fill('price', '12.99');
      const oldSubmit = page.oldSubmit();
      await page.submit(true);
      expect(page.writes).toHaveLength(1);
      await page.render({ initial, cursor: 'page-two' });
      expect(page.lists).toHaveLength(1); // A read remains pending through viewer replacement.
      await page.render({ initial, session: viewer(B), cursor: 'page-two' });
      expect(page.lists).toHaveLength(2);
      await act(async () => oldSubmit({ preventDefault() {} }));
      expect(page.writes).toHaveLength(1);
      await page.settle(page.lists[1]!.work, list(B, 'page-two', 'B current'));
      expect(page.host.textContent).toContain('B current');
      await page.click(page.m.creator_delist());
      expect(page.writes[1]!.data.operation).toBe('delist');
      expect(page.button(page.m.creator_delist()).disabled).toBe(true);
      await page.settle(page.writes[0]!.work, new Error('A outcome remains uncertain'));
      await page.settle(page.lists[0]!.work, list(A, 'page-two', 'Late A'));
      expect(page.host.textContent).toContain('B current');
      expect(page.host.textContent).not.toContain('Late A');
      expect(page.host.textContent).not.toContain(page.m.creator_uncertain());
      expect(page.button(page.m.creator_delist()).disabled).toBe(true); // A finally cannot unlock B.
      await page.settle(page.writes[1]!.work, { kind: 'saved', id: creatorOfferFixture.id });
      await page.render({ initial, cursor: 'page-two' });
      await page.render({ initial });
      expect(page.host.textContent).not.toContain('Origin offer');
      expect(page.lists).toHaveLength(4);
      await page.settle(page.lists[2]!.work, list(A, 'page-two', 'Retired address'));
      expect(page.host.textContent).not.toContain('Retired address');
      await page.settle(page.lists[3]!.work, list(A, null, 'Fresh return'));
      expect(page.host.textContent).toContain('Fresh return');
      await act(async () => oldSubmit({ preventDefault() {} }));
      expect(page.writes).toHaveLength(2);
    }));

  test('uncertain reprice and delist preserve their exact observed payload/key across refresh and CSRF rotation', async () =>
    withPage(async (page) => {
      const initial = list();
      await page.render({ initial });
      await page.fill('price', '12.99');
      const retryFromOldRender = page.oldSubmit();
      await page.submit(true);
      await page.settle(page.writes[0]!.work, { kind: 'retry' });
      const refreshed = list();
      if (refreshed.data.page.kind === 'ready') refreshed.data.page.offers[0]!.unitAmountMinor = 900;
      refreshed.data.keys[creatorOfferFixture.id] = { reprice: id(70), delist: id(71) };
      refreshed.data.schema = { ...configuredPriceExample, configuredSaleCurrencies: [] };
      await page.render({ initial: refreshed, session: viewer(A, 'csrf-rotated'), locale: 'de' });
      refreshed.data.page = { kind: 'ready', offers: [], next: null };
      await page.render({ initial: { ...refreshed }, session: viewer(A, 'csrf-rotated'), locale: 'de' });
      await act(async () => retryFromOldRender({ preventDefault() {} }));
      expect(page.writes[1]!.data).toEqual(page.writes[0]!.data);
      expect(page.writes[1]!.csrf).toBe(page.writes[0]!.csrf);
      expect(page.writes[1]!.data).toMatchObject({
        operation: 'reprice',
        unitAmountMinor: 1299,
        idempotencyKey: id(11),
      });
      await page.settle(page.writes[1]!.work, { kind: 'rejected' });
      await page.click(page.m.creator_delist());
      expect(page.writes[2]!.data.operation).toBe('delist');
      expect(page.writes[2]!.data.idempotencyKey).not.toBe(id(12)); // deliberate terminal fresh attempt
      await page.settle(page.writes[2]!.work, new Error('Lost delist response'));
      await page.render({ initial: list(), session: viewer(A, 'csrf-third') });
      await page.click(page.m.creator_retry());
      expect(page.writes[3]!.data).toEqual(page.writes[2]!.data);
      expect(page.writes[3]!.csrf).toBe(page.writes[2]!.csrf);
    }));

  test('create keeps immutable edition/schema/key on retry and retires retained editions, callbacks and writes', async () =>
    withPage(async (page) => {
      const initial = editor();
      await page.render({ initial });
      await page.fill('title', 'Observed title');
      await page.chooseCurrency();
      await page.fill('price', '12.99');
      await page.fill('taxCode', 'txcd_10000000');
      const oldSubmit = page.oldSubmit();
      await page.submit(true);
      expect(page.writes).toHaveLength(1);
      await page.settle(page.writes[0]!.work, { kind: 'retry' });
      const refreshed = editor();
      refreshed.data.createKey = id(75);
      if (refreshed.data.editor.kind === 'ready')
        refreshed.data.editor.schema = { ...configuredPriceExample, configuredSaleCurrencies: [] };
      await page.render({ initial: refreshed, locale: 'fr', session: viewer(A, 'csrf-rotated') });
      await page.render({
        initial: { ...refreshed, data: { ...refreshed.data, editor: { kind: 'unavailable' } } },
        locale: 'fr',
        session: viewer(A, 'csrf-rotated'),
      });
      await page.submit();
      expect(page.writes[1]!.data).toEqual(page.writes[0]!.data);
      expect(page.writes[1]!.csrf).toBe('csrf-rotated');
      expect(page.writes[1]!.data).toMatchObject({
        operation: 'create',
        contentEditionId: edition.editionId,
        unitAmountMinor: 1299,
        idempotencyKey: id(13),
      });
      await page.render({ initial, session: viewer(B) });
      expect(page.host.textContent).not.toContain(edition.sha256);
      expect(page.host.querySelector('input')).toBeNull();
      await act(async () => oldSubmit({ preventDefault() {} }));
      expect(page.writes).toHaveLength(2);
      await page.settle(page.editions[0]!.work, editor(B));
      await page.fill('title', 'B intent');
      await page.chooseCurrency();
      await page.fill('price', '15.00');
      await page.fill('taxCode', 'txcd_10000000');
      await page.submit();
      expect(page.writes).toHaveLength(3);
      expect(page.writes[2]!.data.idempotencyKey).not.toBe(page.writes[1]!.data.idempotencyKey);
      await page.settle(page.writes[1]!.work, { kind: 'saved', id: id(88) });
      expect(page.host.querySelector(`a[href="/en/offers/${id(88)}"]`)).toBeNull();
      expect(page.input('title').value).toBe('B intent');
      expect(page.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      await page.render({ initial, session: viewer(B), admitted: false });
      expect(page.host.querySelector('input')).toBeNull();
      await page.render({ initial, contentEditionId: id(81) });
      await page.render({ initial });
      expect(page.host.textContent).not.toContain(edition.sha256);
      await page.settle(page.editions[1]!.work, editor(A, id(81)));
      expect(page.host.textContent).not.toContain(edition.sha256);
      await page.settle(page.editions[2]!.work, editor());
      expect(page.host.textContent).toContain(edition.sha256);
    }));
});
