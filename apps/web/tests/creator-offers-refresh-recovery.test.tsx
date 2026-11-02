import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type {
  CreatorEditorCurrentRead,
  CreatorOffersCurrentRead,
  CreatorOfferMutation,
  CreatorOfferResult,
} from '../src/checkout/creator-offers';
import { configuredPriceExample, creatorOfferFixture } from '../src/kernel/fake/creator-offers';

// UNRUN: mounted outcome cases for controller integration, using the real session/exposure observers.
// These fixtures do not establish native authorization, browser, screenshot or whole-journey acceptance.
mock.module('@tanstack/react-start', () => ({
  ...start,
  createIsomorphicFn() {
    let server: (...args: unknown[]) => unknown = () => undefined;
    const chain = {
      server(handler: typeof server) {
        server = handler;
        return chain;
      },
      client(handler: typeof server) {
        return (...args: unknown[]) => (typeof window === 'undefined' ? server : handler)(...args);
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test/en/creator/offers'),
  setResponseHeader() {},
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
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
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { sessionQuery } = await import('../src/session/query');
const offers = await import('../src/checkout/creator-offers');
const { CreatorOffersCurrent, CreatorOfferEditorCurrent } = await import('../src/checkout/creator-offers-current');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
const id = (n: number) => `019a2100-0000-7000-8000-${String(n).padStart(12, '0')}`;
const A = creatorOfferFixture.contentEdition!.creatorAccountId;
const B = id(90);
const editionId = creatorOfferFixture.contentEdition!.benefit.resource.id;
function list(subject = A, cursor: string | null = null): CreatorOffersCurrentRead {
  return {
    sessionSubject: subject,
    requested: { kind: 'list', cursor },
    data: {
      selling: true,
      csrfToken: 'loader',
      schema: configuredPriceExample,
      keys: { [creatorOfferFixture.id]: { reprice: id(11), delist: id(12) } },
      page: { kind: 'ready', offers: [{ ...creatorOfferFixture, title: 'Observed private offer' }], next: null },
    },
  };
}
function editor(): CreatorEditorCurrentRead {
  return {
    sessionSubject: A,
    requested: { kind: 'editor', contentEditionId: editionId },
    data: {
      selling: true,
      csrfToken: 'loader',
      createKey: id(13),
      editor: {
        kind: 'ready',
        schema: configuredPriceExample,
        edition: {
          editionId,
          editionRevision: id(2),
          state: 'published',
          targetSubjectId: creatorOfferFixture.targetSubjectId,
          creatorAccountId: A,
          revisionId: id(3),
          sha256: 'a'.repeat(64),
          licence: 'CC-BY-4.0',
        },
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
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
async function workspace(run: (page: Awaited<ReturnType<typeof mount>>) => Promise<void>) {
  const page = await mount();
  try {
    await run(page);
  } finally {
    await page.close();
  }
}
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = (subject = A, csrfToken: string | null = 'csrf-A') => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject, csrfToken });
  };
  session();
  const lifetime = viewerExposureLifetime(client);
  const keep = lifetime.subscribe(() => {});
  const admit = (admitted: string[] = ['selling', 'purchases']) => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('No actual viewer observation');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject: snapshot.observation.subject,
      admitted,
    });
  };
  admit();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  const listReads: ReturnType<typeof deferred<CreatorOffersCurrentRead>>[] = [];
  const editorReads: ReturnType<typeof deferred<CreatorEditorCurrentRead>>[] = [];
  const writes: {
    data: CreatorOfferMutation;
    csrf: string | null;
    work: ReturnType<typeof deferred<CreatorOfferResult>>;
  }[] = [];
  const spies = [
    spyOn(offers, 'readCreatorOffersCurrent').mockImplementation(() => {
      const work = deferred<CreatorOffersCurrentRead>();
      listReads.push(work);
      return work.promise;
    }),
    spyOn(offers, 'readCreatorOfferEditorCurrent').mockImplementation(() => {
      const work = deferred<CreatorEditorCurrentRead>();
      editorReads.push(work);
      return work.promise;
    }),
    spyOn(offers, 'manageCreatorOffer').mockImplementation((input) => {
      const work = deferred<CreatorOfferResult>();
      writes.push({ data: structuredClone(input.data), csrf: new Headers(input.headers).get('X-CSRF-Token'), work });
      return work.promise;
    }),
  ];
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const show = async (mode: 'list' | 'editor' = 'list', cursor?: string) => {
    await act(async () =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <RouterContextProvider router={router}>
              {mode === 'list' ? (
                <CreatorOffersCurrent initial={list()} locale="en" cursor={cursor} />
              ) : (
                <CreatorOfferEditorCurrent initial={editor()} locale="en" contentEditionId={cursor ?? editionId} />
              )}
            </RouterContextProvider>
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
    await tick();
  };
  const settle = async <T,>(work: ReturnType<typeof deferred<T>>, value: T | Error) => {
    await act(async () => {
      if (value instanceof Error) work.reject(value);
      else work.resolve(value);
    });
    await tick();
  };
  const input = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const fill = (name: string, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(name), value);
      input(name).dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const draft = async () => {
    await fill('title', 'My draft');
    await act(async () => {
      const select = host.querySelector('select')!;
      select.value = 'usd';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await fill('price', '12.99');
    await fill('taxCode', 'txcd_10000000');
  };
  const submitCallback = () => {
    const form = host.querySelector('form')!;
    const key = Object.getOwnPropertyNames(form).find((name) => name.startsWith('__reactProps$'))!;
    return (form as unknown as Record<string, { onSubmit(event: { preventDefault(): void }): unknown }>)[key]!.onSubmit;
  };
  const submit = (twice = false) =>
    act(async () => {
      const callback = submitCallback();
      callback({ preventDefault() {} });
      if (twice) callback({ preventDefault() {} });
    });
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
  const click = (label: string) =>
    act(async () => {
      button(label).click();
    });
  const refresh = async () => {
    await act(async () => {
      void client.refetchQueries({ queryKey: ['creator-offers-current'], type: 'active' });
    });
  };
  return {
    host,
    client,
    session,
    admit,
    tick,
    show,
    settle,
    input,
    fill,
    draft,
    submit,
    submitCallback,
    button,
    click,
    refresh,
    listReads,
    editorReads,
    writes,
    async close() {
      await act(async () => root.unmount());
      keep();
      client.clear();
      spies.forEach((spy) => spy.mockRestore());
      host.remove();
    },
  };
}

describe('Creator offer editing recovery retains real drafts without extending private authority', () => {
  test('unsubmitted create survives a failed same-origin refresh, retry and healthy renewal, then retries its exact command', async () =>
    workspace(async (p) => {
      await p.show('editor');
      await p.draft();
      const form = p.host.querySelector('form');
      await p.refresh();
      await p.settle(p.editorReads[0]!, new Error('Temporary transport failure'));
      expect(p.host.querySelector('form')).toBe(form);
      expect(p.host.textContent).toContain(m.creator_unavailable());
      expect(p.input('title').value).toBe('My draft');
      expect(p.input('price').value).toBe('12.99');
      expect(p.input('taxCode').value).toBe('txcd_10000000');
      expect(p.host.querySelector<HTMLSelectElement>('select')!.value).toBe('usd');
      expect(p.writes).toHaveLength(0);
      await p.click(m.creator_offers_refresh());
      expect(p.button(m.creator_offers_refresh()).disabled).toBe(true);
      const changed = editor();
      changed.data.createKey = id(75);
      if (changed.data.editor.kind === 'ready') {
        changed.data.editor.edition.sha256 = 'b'.repeat(64);
        changed.data.editor.schema = { ...configuredPriceExample, configuredSaleCurrencies: [] };
      }
      await p.settle(p.editorReads[1]!, changed);
      expect(p.host.querySelector('form')).toBe(form);
      expect(p.host.textContent).not.toContain(m.creator_unavailable());
      expect(p.host.textContent).toContain('a'.repeat(64));
      await act(async () => {
        p.session(A, 'csrf-renewed');
        p.admit();
      });
      await p.tick();
      expect(p.input('title').value).toBe('My draft');
      expect(p.input('price').value).toBe('12.99');
      expect(p.input('taxCode').value).toBe('txcd_10000000');
      await p.submit(true);
      expect(p.writes).toHaveLength(1);
      expect(p.writes[0]!.data).toEqual({
        operation: 'create',
        contentEditionId: editionId,
        title: 'My draft',
        currency: 'usd',
        unitAmountMinor: 1299,
        taxCode: 'txcd_10000000',
        idempotencyKey: id(13),
      });
      expect(p.writes[0]!.csrf).toBe('csrf-renewed');
      await p.settle(p.writes[0]!.work, new Error('Response lost'));
      await p.refresh();
      await p.settle(p.editorReads.at(-1)!, new Error('Refresh still unavailable'));
      await act(async () => {
        p.session(A, 'csrf-after-failure');
        p.admit();
      });
      await p.tick();
      expect(p.host.textContent).toContain(m.creator_unavailable());
      expect(p.button(m.creator_offers_refresh()).disabled).toBe(false);
      expect(p.input('title').value).toBe('My draft');
      expect(p.input('price').value).toBe('12.99');
      await p.refresh();
      await p.settle(p.editorReads.at(-1)!, changed);
      expect(p.host.textContent).toContain(m.creator_uncertain());
      await p.submit(true);
      expect(p.writes).toHaveLength(2);
      expect(p.writes[1]!.data).toEqual(p.writes[0]!.data);
      await p.settle(p.writes[1]!.work, { kind: 'saved', id: id(88) });
      expect(p.host.querySelector(`a[href="/en/offers/${id(88)}"]`)).not.toBeNull();
      await p.submit();
      expect(p.writes).toHaveLength(2);
    }));

  test('a reprice draft survives failure and an omitted uncertain row retains its payload/key through retry and delist', async () =>
    workspace(async (p) => {
      await p.show();
      await p.fill('price', '12.99');
      const form = p.host.querySelector('form');
      await p.refresh();
      await p.settle(p.listReads[0]!, new Error('Temporary transport failure'));
      expect(p.host.querySelector('form')).toBe(form);
      expect(p.input('price').value).toBe('12.99');
      await p.click(m.creator_offers_refresh());
      await p.settle(p.listReads[1]!, list());
      await p.submit(true);
      expect(p.writes).toHaveLength(1);
      // Omission while in flight cannot remove either the form or duplicate-submit lock.
      await p.refresh();
      const omitted = list();
      omitted.data.page = { kind: 'ready', offers: [], next: null };
      omitted.data.keys = {};
      omitted.data.schema = { ...configuredPriceExample, configuredSaleCurrencies: [] };
      await p.settle(p.listReads[2]!, omitted);
      expect(p.host.querySelector('form')).toBe(form);
      expect(p.host.textContent).toContain('Observed private offer');
      expect(p.host.textContent).not.toContain(m.creator_offers_empty());
      await p.submit(true);
      expect(p.writes).toHaveLength(1);
      await p.settle(p.writes[0]!.work, { kind: 'retry' });
      const changed = list();
      if (changed.data.page.kind === 'ready') {
        changed.data.page.offers[0]!.title = 'New read title';
        changed.data.page.offers[0]!.state = 'delisted';
        changed.data.page.offers[0]!.unitAmountMinor = 900;
      }
      changed.data.keys[creatorOfferFixture.id] = { reprice: id(70), delist: id(71) };
      await p.refresh();
      await p.settle(p.listReads[3]!, changed);
      expect(p.host.textContent).not.toContain('New read title');
      expect(p.host.textContent).toContain(m.creator_uncertain());
      await act(async () => {
        p.session(A, 'csrf-rotated');
        p.admit();
      });
      await p.tick();
      await p.click(m.creator_retry());
      expect(p.writes[1]!.data).toEqual(p.writes[0]!.data);
      expect(p.writes[1]!.data).toEqual({
        operation: 'reprice',
        expectedRevision: creatorOfferFixture.revision,
        offerId: creatorOfferFixture.id,
        unitAmountMinor: 1299,
        idempotencyKey: id(11),
      });
      expect(p.writes[1]!.csrf).toBe('csrf-A');
      await p.settle(p.writes[1]!.work, { kind: 'rejected' });
      expect(p.host.textContent).toContain(m.creator_rejected());
      await p.click(m.creator_delist());
      expect(p.writes[2]!.data.operation).toBe('delist');
      expect(p.writes[2]!.data.idempotencyKey).not.toBe(id(12));
      await p.settle(p.writes[2]!.work, new Error('Delist response lost'));
      await p.refresh();
      await p.settle(p.listReads.at(-1)!, omitted);
      await p.click(m.creator_retry());
      expect(p.writes[3]!.data).toEqual(p.writes[2]!.data);
    }));

  for (const operation of ['reprice', 'delist'] as const)
    test(`stale ${operation} preserves the draft until explicit review and a separate new action`, async () =>
      workspace(async (p) => {
        await p.show();
        await p.fill('price', '13.25');
        if (operation === 'reprice') await p.submit();
        else await p.click(m.creator_delist());
        expect(p.writes[0]!.data).toMatchObject({ expectedRevision: creatorOfferFixture.revision });
        const oldSubmit = p.submitCallback();
        await p.settle(p.writes[0]!.work, { kind: 'conflict' });
        await act(async () => oldSubmit({ preventDefault() {} }));
        expect(p.listReads).toHaveLength(0);
        expect(p.input('price').value).toBe('13.25');
        await p.submit();
        await p.click(m.creator_delist());
        expect(p.writes).toHaveLength(1);
        // Background data is not consent to use a new revision.
        const latest = list();
        if (latest.data.page.kind !== 'ready') throw new Error('Expected seller page');
        Object.assign(latest.data.page.offers[0]!, {
          revision: creatorOfferFixture.revision + 1,
          unitAmountMinor: 1500,
        });
        await p.refresh();
        await p.settle(p.listReads.at(-1)!, latest);
        expect(p.input('price').disabled).toBe(true);
        await p.click(m.offer_review_terms());
        await p.settle(p.listReads.at(-1)!, new Error('Review unavailable'));
        expect(p.input('price').value).toBe('13.25');
        expect(p.writes).toHaveLength(1);
        await p.click(m.offer_review_terms());
        await p.settle(p.listReads.at(-1)!, latest);
        expect(p.host.textContent).toContain('$15.00');
        expect(p.input('price').value).toBe('13.25');
        expect(p.writes).toHaveLength(1);
        if (operation === 'reprice') await p.submit();
        else await p.click(m.creator_delist());
        expect(p.writes[1]!.data).toMatchObject({ operation, expectedRevision: creatorOfferFixture.revision + 1 });
        expect(p.writes[1]!.data.idempotencyKey).not.toBe(p.writes[0]!.data.idempotencyKey);
      }));

  for (const operation of ['reprice', 'delist'] as const)
    test(`confirmed ${operation} refreshes availability without replaying a saved command`, async () =>
      workspace(async (p) => {
        await p.show();
        await p.fill('price', '13.25');
        if (operation === 'reprice') await p.submit(true);
        else await p.click(m.creator_delist());
        expect(p.listReads).toHaveLength(0);
        await p.settle(p.writes[0]!.work, { kind: 'retry' });
        expect(p.listReads).toHaveLength(0);
        await p.click(m.creator_retry());
        expect(p.writes[1]!.data).toEqual(p.writes[0]!.data);
        await p.settle(p.writes[1]!.work, { kind: 'saved', id: creatorOfferFixture.id });
        expect(p.listReads).toHaveLength(1);
        for (const outcome of [new Error('Read response lost'), list()]) {
          await p.settle(p.listReads.at(-1)!, outcome);
          expect(p.host.textContent).toContain(m.creator_saved());
          expect(p.host.textContent).not.toContain(m.creator_uncertain());
          expect(p.input('price').value).toBe('13.25');
          expect(p.input('price').disabled).toBe(true);
          // Use the saved command's read-only recovery rather than the page refresh.
          await act(async () => {
            [...p.host.querySelectorAll('button')]
              .filter((button) => button.textContent === m.creator_offers_refresh())
              .at(-1)!
              .click();
          });
          expect(p.writes).toHaveLength(2);
        }
        const latest = list();
        if (latest.data.page.kind !== 'ready') throw new Error('Expected seller page');
        Object.assign(latest.data.page.offers[0]!, {
          revision: creatorOfferFixture.revision + 1,
          unitAmountMinor: 1325,
          state: operation === 'delist' ? 'delisted' : 'active',
        });
        latest.data.keys[creatorOfferFixture.id] = { reprice: id(80), delist: id(81) };
        await p.settle(p.listReads.at(-1)!, latest);
        expect(p.host.textContent).toContain(m.creator_saved());
        expect(p.host.textContent).toContain('$13.25');
        if (operation === 'delist') {
          expect(p.host.textContent).toContain(m.creator_offers_delisted());
          expect(p.host.querySelector(`a[href="/en/offers/${creatorOfferFixture.id}"]`)).toBeNull();
          expect(p.host.querySelector('form')).toBeNull();
        } else {
          expect(p.input('price').disabled).toBe(false);
          await p.fill('price', '14.00');
          await act(async () => {
            p.session(A, 'renewed-after-confirmation');
            p.admit();
          });
          await p.tick();
          expect(p.input('price').value).toBe('14.00');
          await p.submit(true);
          expect(p.writes).toHaveLength(3);
          expect(p.writes[2]!.data.idempotencyKey).toBe(id(80));
        }
      }));

  test('pristine reads still replace current rows and edition facts', async () =>
    workspace(async (p) => {
      await p.show();
      await p.refresh();
      const changed = list();
      if (changed.data.page.kind === 'ready') changed.data.page.offers[0]!.title = 'Fresh title';
      await p.settle(p.listReads[0]!, changed);
      expect(p.host.textContent).toContain('Fresh title');
      expect(p.host.textContent).not.toContain('Observed private offer');
      await p.refresh();
      const empty = list();
      empty.data.page = { kind: 'ready', offers: [], next: null };
      await p.settle(p.listReads[1]!, empty);
      expect(p.host.querySelector('form')).toBeNull();
      expect(p.host.textContent).toContain(m.creator_offers_empty());
      await p.show('editor');
      await p.settle(p.editorReads[0]!, editor());
      await p.refresh();
      const fresh = editor();
      if (fresh.data.editor.kind === 'ready') fresh.data.editor.edition.sha256 = 'b'.repeat(64);
      await p.settle(p.editorReads[1]!, fresh);
      expect(p.host.textContent).toContain('b'.repeat(64));
      expect(p.host.textContent).not.toContain('a'.repeat(64));
    }));

  test('real retirement and explicit authority failures withdraw retained display, dispatch and late completion', async () => {
    for (const mode of ['list', 'editor'] as const) {
      for (const retirement of [
        'viewer',
        'admission',
        'address',
        'csrf',
        'denied',
        'closed',
        'unavailable',
        'selling',
      ] as const) {
        await workspace(async (p) => {
          await p.show(mode);
          if (mode === 'editor') await p.draft();
          else await p.fill('price', '12.99');
          const oldSubmit = p.submitCallback();
          await p.submit();
          if (retirement === 'viewer' || retirement === 'admission' || retirement === 'csrf') {
            await act(async () => {
              if (retirement === 'viewer') {
                p.session(B, 'csrf-B');
                p.admit();
              } else if (retirement === 'admission') p.admit([]);
              else p.session(A, null);
              oldSubmit({ preventDefault() {} });
              expect(p.writes).toHaveLength(1);
            });
            await p.tick();
          } else if (retirement === 'address') {
            await p.show(mode, mode === 'list' ? 'another-page' : id(80));
          } else {
            await p.refresh();
            if (mode === 'list') {
              const withdrawn = list();
              if (retirement === 'selling') withdrawn.data.selling = false;
              else {
                withdrawn.data.page = { kind: retirement };
                withdrawn.sessionSubject = null;
              }
              await p.settle(p.listReads[0]!, withdrawn);
            } else {
              const withdrawn = editor();
              if (retirement === 'selling') withdrawn.data.selling = false;
              else {
                withdrawn.data.editor = { kind: retirement };
                withdrawn.sessionSubject = null;
              }
              await p.settle(p.editorReads[0]!, withdrawn);
            }
          }
          expect(p.host.textContent).not.toContain('Observed private offer');
          expect(p.host.textContent).not.toContain('a'.repeat(64));
          expect(p.host.querySelector('input')).toBeNull();
          await act(async () => {
            oldSubmit({ preventDefault() {} });
          });
          expect(p.writes).toHaveLength(1);
          await p.settle(p.writes[0]!.work, { kind: 'saved', id: creatorOfferFixture.id });
          expect(p.host.textContent).not.toContain(m.creator_saved());
          expect(p.host.textContent).not.toContain('Observed private offer');
          expect(p.host.textContent).not.toContain('a'.repeat(64));
        });
      }
    }
  });
});
