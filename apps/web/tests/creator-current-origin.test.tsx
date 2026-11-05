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
import type { CreatorStatementCurrentRead, CreatorStatementsCurrentRead } from '../src/checkout/creator-statements';
import type { CreatorSalesCurrentRead } from '../src/checkout/creator-sales';
import { creatorSaleFixture } from '../src/kernel/fake/creator-sales';
import { configuredPriceExample, creatorOfferFixture } from '../src/kernel/fake/creator-offers';
import { creatorLineFixture, paidCreatorStatementFixture } from '../src/kernel/fake/creator-statements';

// UNRUN: composed cache/DOM regressions for integration. These use the actual session QueryClient,
// viewerExposureLifetime and subject-scoped admission, without native or browser acceptance claims.
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
  getRequest: () => new Request('https://site.test/en'),
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
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { sessionQuery } = await import('../src/session/query');
const offers = await import('../src/checkout/creator-offers');
const statements = await import('../src/checkout/creator-statements');
const sales = await import('../src/checkout/creator-sales');
const { CreatorSalesCurrent } = await import('../src/checkout/creator-sales-current');
const { CreatorOfferEditor } = await import('../src/checkout/creator-offer-editor');
const { CreatorOffersPage } = await import('../src/checkout/creator-offers-page');
const { CreatorOffersCurrent, CreatorOfferEditorCurrent } = await import('../src/checkout/creator-offers-current');
const { CreatorStatementsCurrent, CreatorStatementCurrent } =
  await import('../src/checkout/creator-statements-current');
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
      page: {
        kind: 'ready',
        offers: [
          {
            ...creatorOfferFixture,
            title: `Private offer ${subject}`,
            contentEdition: { ...creatorOfferFixture.contentEdition!, creatorAccountId: subject },
          },
        ],
        next: null,
      },
    },
  };
}
function editor(subject = A, contentEditionId = editionId): CreatorEditorCurrentRead {
  return {
    sessionSubject: subject,
    requested: { kind: 'editor', contentEditionId },
    data: {
      selling: true,
      csrfToken: 'loader',
      createKey: id(13),
      editor: {
        kind: 'ready',
        schema: configuredPriceExample,
        edition: {
          editionId: contentEditionId,
          editionRevision: id(2),
          state: 'published',
          targetSubjectId: creatorOfferFixture.targetSubjectId,
          creatorAccountId: subject,
          revisionId: id(3),
          sha256: 'a'.repeat(64),
          licence: 'CC-BY-4.0',
        },
      },
    },
  };
}
function statementList(subject = A, cursor: string | null = null): CreatorStatementsCurrentRead {
  return {
    sessionSubject: subject,
    requested: { kind: 'list', locale: 'en', cursor },
    page: {
      kind: 'ready',
      payoutStatements: [
        {
          ...paidCreatorStatementFixture,
          id: subject === A ? paidCreatorStatementFixture.id : id(22),
          creatorAccountId: subject,
          paidReference: `Private payment ${subject}`,
        },
      ],
      next: 'next+/=',
    },
  };
}
function detail(subject = A, cursor: string | null = null): CreatorStatementCurrentRead {
  const statement = {
    ...paidCreatorStatementFixture,
    creatorAccountId: subject,
    paidReference: `Private payment ${subject}`,
  };
  return {
    sessionSubject: subject,
    requested: { kind: 'detail', locale: 'en', id: statement.id, cursor, from: 'back+/=' },
    page: {
      kind: 'ready',
      statement,
      lines: {
        kind: 'ready',
        lines: [
          {
            ...creatorLineFixture,
            creatorAccountId: subject,
            statementId: statement.id,
            period: statement.period,
            balanceTransactionId: `txn-${subject}`,
          },
        ],
        next: 'line-next+/=',
      },
    },
  };
}
function sale(): CreatorSalesCurrentRead {
  return {
    sessionSubject: A,
    requested: { cursor: null },
    selling: true,
    page: {
      kind: 'ready',
      sales: [{ ...creatorSaleFixture, title: 'Private sale' }],
      next: null,
      projectionState: 'ready',
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type StatementRead = CreatorStatementsCurrentRead | CreatorStatementCurrentRead;
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
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: A, csrfToken: 'csrf-A' });
  const lifetime = viewerExposureLifetime(client);
  const keep = lifetime.subscribe(() => {});
  const admit = (admitted: string[] = ['selling', 'purchases'], subject?: string) => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('No actual viewer observation');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject: subject ?? snapshot.observation.subject,
      admitted,
    });
  };
  const session = (subject = A, csrfToken: string | null = 'csrf-A') => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject, csrfToken });
  };
  admit();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/creator/statements'] }),
  });
  const listReads: ReturnType<typeof deferred<CreatorOffersCurrentRead>>[] = [];
  const editorReads: ReturnType<typeof deferred<CreatorEditorCurrentRead>>[] = [];
  const statementReads: { input: unknown; work: ReturnType<typeof deferred<StatementRead>> }[] = [];
  const writes: {
    data: CreatorOfferMutation;
    csrf: string | null;
    work: ReturnType<typeof deferred<CreatorOfferResult>>;
  }[] = [];
  const salesReads: ReturnType<typeof deferred<CreatorSalesCurrentRead>>[] = [];
  const spies = [
    spyOn(sales, 'readCreatorSalesCurrent').mockImplementation(() => {
      const work = deferred<CreatorSalesCurrentRead>();
      salesReads.push(work);
      return work.promise;
    }),
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
    spyOn(statements, 'readCreatorStatementsCurrent').mockImplementation((input) => {
      const work = deferred<StatementRead>();
      statementReads.push({ input: input.data, work });
      return work.promise as Promise<CreatorStatementsCurrentRead>;
    }),
    spyOn(statements, 'readCreatorStatementCurrent').mockImplementation((input) => {
      const work = deferred<StatementRead>();
      statementReads.push({ input: input.data, work });
      return work.promise as Promise<CreatorStatementCurrentRead>;
    }),
    spyOn(offers, 'manageCreatorOffer').mockImplementation((input) => {
      const work = deferred<CreatorOfferResult>();
      writes.push({ data: structuredClone(input.data), csrf: new Headers(input.headers).get('X-CSRF-Token'), work });
      return work.promise;
    }),
  ];
  let mode: 'offers' | 'editor' | 'statements' | 'detail' | 'sales' = 'offers';
  let cursor: string | undefined;
  let locale = 'en';
  let initialOffers = list();
  let initialEditor = editor();
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          {mode === 'sales' ? (
            <CreatorSalesCurrent initial={sale()} locale={locale} />
          ) : mode === 'offers' ? (
            <CreatorOffersCurrent initial={initialOffers} locale={locale} cursor={cursor} />
          ) : mode === 'editor' ? (
            <CreatorOfferEditorCurrent initial={initialEditor} locale={locale} contentEditionId={editionId} />
          ) : mode === 'statements' ? (
            <CreatorStatementsCurrent initial={statementList()} locale={locale} {...(cursor ? { cursor } : {})} />
          ) : (
            <CreatorStatementCurrent
              initial={detail()}
              locale={locale}
              id={paidCreatorStatementFixture.id}
              from="back+/="
              {...(cursor ? { cursor } : {})}
            />
          )}
        </RouterContextProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const show = async (next: typeof mode = mode, address = cursor, nextLocale = locale) => {
    mode = next;
    cursor = address;
    locale = nextLocale;
    await act(async () => root.render(tree()));
    await tick();
  };
  const settle = async <T,>(work: ReturnType<typeof deferred<T>>, value: T | Error) => {
    await act(async () => {
      if (value instanceof Error) work.reject(value);
      else work.resolve(value);
    });
    await tick();
  };
  const props = (element: Element) => {
    const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactProps$'))!;
    return (
      element as unknown as Record<
        string,
        { onSubmit?: (event: { preventDefault(): void }) => unknown; onClick?: () => unknown }
      >
    )[key]!;
  };
  const submitCallback = () => props(host.querySelector('form')!).onSubmit!;
  const submit = () =>
    act(async () => {
      submitCallback()({ preventDefault() {} });
    });
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
  const click = (label: string) =>
    act(async () => {
      button(label).click();
    });
  const fill = (name: string, value: string) =>
    act(async () => {
      const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const createDraft = async () => {
    await fill('title', 'Captured title');
    await act(async () => {
      const select = host.querySelector('select')!;
      select.value = 'usd';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await fill('price', '12.99');
    await fill('taxCode', 'txcd_10000000');
  };
  const queryCallback = (prefix: string) => {
    const query = client
      .getQueryCache()
      .findAll({ queryKey: [prefix] })
      .at(-1)!;
    return query.options.queryFn as () => Promise<unknown>;
  };
  return {
    client,
    host,
    session,
    admit,
    show,
    tick,
    settle,
    fill,
    createDraft,
    submit,
    submitCallback,
    click,
    button,
    props,
    queryCallback,
    listReads,
    editorReads,
    statementReads,
    salesReads,
    writes,
    refreshOffers: (value: CreatorOffersCurrentRead) => {
      initialOffers = value;
    },
    refreshEditor: (value: CreatorEditorCurrentRead) => {
      initialEditor = value;
    },
    async close() {
      await act(async () => root.unmount());
      keep();
      client.clear();
      spies.forEach((spy) => spy.mockRestore());
      host.remove();
    },
  };
}

test('authorized offers, Sales and statement readers refresh without CSRF and retire late replies across same-subject renewal', async () => {
  for (const mode of ['offers', 'editor', 'sales', 'statements', 'detail'] as const) {
    await workspace(async (p) => {
      await act(async () => {
        p.session(A, null);
        p.admit();
      });
      await p.show(mode);
      const marker =
        mode === 'offers'
          ? `Private offer ${A}`
          : mode === 'editor'
            ? 'a'.repeat(64)
            : mode === 'sales'
              ? 'Private sale'
              : `Private payment ${A}`;
      const visible = () =>
        mode === 'statements'
          ? p.host.querySelector(`a[href*="${paidCreatorStatementFixture.id}"]`) !== null
          : p.host.textContent!.includes(marker);
      expect(visible()).toBe(true);
      if (mode === 'offers' || mode === 'editor') {
        expect(p.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
        await p.submit();
        expect(p.writes).toHaveLength(0);
      }
      const prefix =
        mode === 'sales'
          ? 'creator-sales-current'
          : mode === 'offers' || mode === 'editor'
            ? 'creator-offers-current'
            : 'creator-statements-current';
      const oldRead = p.queryCallback(prefix);
      const pending = oldRead();
      const work =
        mode === 'sales'
          ? p.salesReads.at(-1)!
          : mode === 'offers'
            ? p.listReads.at(-1)!
            : mode === 'editor'
              ? p.editorReads.at(-1)!
              : p.statementReads.at(-1)!.work;
      await act(async () => {
        p.session(A, 'temporary');
        p.admit();
        p.session(A, null); // same subject and token, different session epoch
        expect(await oldRead()).toBeNull();
      });
      await p.tick();
      expect(visible()).toBe(false);
      await p.settle(
        work,
        mode === 'sales'
          ? sale()
          : mode === 'offers'
            ? list()
            : mode === 'editor'
              ? editor()
              : mode === 'detail'
                ? detail()
                : statementList(),
      );
      expect(await pending).toBeNull();
      expect(visible()).toBe(false);
      await act(async () => p.admit());
      await p.tick();
      // A healthy renewal can retain an accepted same-viewer read, but never its delayed reply.
      expect(visible()).toBe(true);
      await act(async () => {
        p.admit([]);
        p.admit();
      });
      await p.tick();
      expect(visible()).toBe(false);
      const fresh =
        mode === 'sales'
          ? p.salesReads.at(-1)!
          : mode === 'offers'
            ? p.listReads.at(-1)!
            : mode === 'editor'
              ? p.editorReads.at(-1)!
              : p.statementReads.at(-1)!.work;
      await p.settle(
        fresh,
        mode === 'sales'
          ? sale()
          : mode === 'offers'
            ? list()
            : mode === 'editor'
              ? editor()
              : mode === 'detail'
                ? detail()
                : statementList(),
      );
      expect(visible()).toBe(true);
    });
  }
});

describe('Creator workspace retires observed stale read and command origins before React commit including ABA while preserving exact uncertain offer operations', () => {
  test('retained reprice/delist callbacks cannot borrow replacement credentials; B stays usable while A is unresolved', async () =>
    workspace(async (p) => {
      await p.show();
      await p.fill('price', '12.99');
      const oldSubmit = p.submitCallback();
      const oldDelist = p.props(p.button(m.creator_delist())).onClick!;
      const oldRead = p.queryCallback('creator-offers-current');
      await p.submit();
      expect(p.writes).toHaveLength(1);
      await act(async () => {
        p.session(B, 'csrf-B');
        p.admit();
        oldSubmit({ preventDefault() {} });
        oldDelist();
        expect(await oldRead()).toBeNull();
        expect(p.writes).toHaveLength(1);
      });
      await p.tick();
      expect(p.host.textContent).not.toContain(`Private offer ${A}`);
      expect(p.listReads).toHaveLength(1);
      await p.settle(p.listReads[0]!, list(B));
      await p.click(m.creator_delist());
      expect(p.writes[1]!.csrf).toBe('csrf-B');
      await p.settle(p.writes[0]!.work, new Error('A response lost'));
      expect(p.button(m.creator_delist()).disabled).toBe(true);
      expect(p.host.textContent).not.toContain(m.creator_uncertain());
      await p.settle(p.writes[1]!.work, { kind: 'retry' });
      const captured = p.writes[1]!.data;
      const refreshed = list(B);
      refreshed.data.keys[creatorOfferFixture.id] = { reprice: id(70), delist: id(71) };
      p.refreshOffers(refreshed);
      await act(async () => {
        p.session(B, 'csrf-rotated');
        p.admit();
      });
      await p.show();
      expect(p.listReads).toHaveLength(1);
      await p.click(m.creator_retry());
      expect(p.writes[2]!.data).toEqual(captured);
      expect(p.writes[2]!.csrf).toBe('csrf-B');
      const retired = p.submitCallback();
      await act(async () => {
        p.admit([]);
        p.admit(); // admission ABA before any React commit
        retired({ preventDefault() {} });
        expect(p.writes).toHaveLength(3);
      });
      await p.tick();
      await p.settle(p.writes[2]!.work, { kind: 'saved', id: creatorOfferFixture.id });
      expect(p.host.textContent).not.toContain(m.creator_saved());
      await p.show('offers', 'next+/=', 'fr');
      const count = p.listReads.length;
      await act(async () => {
        oldSubmit({ preventDefault() {} });
        oldDelist();
      });
      expect(p.writes).toHaveLength(3);
      await p.settle(p.listReads[count - 1]!, list(B, 'wrong-address'));
      expect(p.host.textContent).not.toContain(`Private offer ${B}`);
    }));

  test('create and reprice preserve exact uncertain operands through rotation, authority gaps and equivalent refresh', async () =>
    workspace(async (p) => {
      expect(renderToStaticMarkup(<CreatorOfferEditor data={editor().data} locale="en" />)).toContain('a'.repeat(64));
      expect(renderToStaticMarkup(<CreatorOffersPage data={list().data} locale="en" />)).toContain(
        `Private offer ${A}`,
      );
      expect(p.writes).toHaveLength(0);
      await p.show('editor');
      await p.createDraft();
      const oldCreate = p.submitCallback();
      await p.submit();
      await p.settle(p.writes[0]!.work, { kind: 'retry' });
      const refreshed = editor();
      refreshed.data.createKey = id(75);
      if (refreshed.data.editor.kind === 'ready')
        refreshed.data.editor.schema = { ...configuredPriceExample, configuredSaleCurrencies: [] };
      p.refreshEditor(refreshed);
      await act(async () => {
        p.session(A, 'csrf-rotated');
        p.admit();
      });
      await p.show();
      await p.submit();
      expect(p.writes[1]!.data).toEqual(p.writes[0]!.data);
      expect(p.writes[1]!.csrf).toBe('csrf-A');
      expect(p.writes[1]!.data).toMatchObject({
        operation: 'create',
        idempotencyKey: id(13),
        contentEditionId: editionId,
        title: 'Captured title',
        currency: 'usd',
        unitAmountMinor: 1299,
        taxCode: 'txcd_10000000',
      });
      await act(async () => {
        p.session(B, 'csrf-B');
        p.admit();
        p.session(A, 'csrf-return');
        p.admit();
        oldCreate({ preventDefault() {} });
        expect(p.writes).toHaveLength(2);
      });
      await p.tick();
      await p.settle(p.writes[1]!.work, new Error('Late retired create error'));
      expect(p.host.textContent).not.toContain(m.creator_saved());
      await p.settle(p.editorReads.at(-1)!, editor());
      await p.submit();
      expect(p.writes[2]!.data).toEqual(p.writes[0]!.data);
      const retainedCreate = p.submitCallback();
      await act(async () => {
        p.session(B, 'csrf-B');
        p.admit();
        retainedCreate({ preventDefault() {} });
        expect(p.writes).toHaveLength(3);
      });
      await p.tick();
      await p.settle(p.editorReads.at(-1)!, editor(B));
      await p.createDraft();
      await p.submit();
      expect(p.writes[3]!.csrf).toBe('csrf-B');
      await p.settle(p.writes[2]!.work, { kind: 'saved', id: id(88) });
      expect(p.host.querySelector(`a[href="/en/offers/${id(88)}"]`)).toBeNull();
      expect(p.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      expect(p.host.querySelector<HTMLInputElement>('input[name="title"]')!.value).toBe('Captured title');
      await act(async () => {
        p.session();
        p.admit();
      });
      await p.tick();
      await p.show('offers');
      await p.fill('price', '12.99');
      await p.submit();
      const reprice = p.writes.at(-1)!;
      await p.settle(reprice.work, { kind: 'retry' });
      await act(async () => {
        p.session(A, null);
      });
      await p.tick();
      expect(p.host.querySelector('input')).toBeNull();
      await act(async () => p.admit());
      await p.tick();
      expect(p.host.textContent).toContain(`Private offer ${A}`);
      expect(p.button(m.creator_retry()).disabled).toBe(true);
      const count = p.writes.length;
      await p.click(m.creator_retry());
      expect(p.writes).toHaveLength(count);
      const refresh = p.queryCallback('creator-offers-current')();
      await p.settle(p.listReads.at(-1)!, list());
      await refresh;
      expect(p.host.textContent).toContain(m.creator_uncertain());
      await act(async () => {
        p.session(A, 'csrf-restored');
        p.admit(['selling']);
      });
      await p.tick();
      await p.settle(p.listReads.at(-1)!, list());
      expect(p.host.querySelector(`a[href="/en/offers/${creatorOfferFixture.id}"]`)).toBeNull();
      await p.click(m.creator_retry());
      expect(p.writes.at(-1)!.data).toEqual(reprice.data);
      expect(p.writes.at(-1)!.csrf).toBe(reprice.csrf);
      expect(reprice.data).toMatchObject({ operation: 'reprice', unitAmountMinor: 1299, idempotencyKey: id(11) });
    }));

  test('statement first/next/detail and line results require exact actual read provenance and retire before commit', async () =>
    workspace(async (p) => {
      const visible = (mode: 'statements' | 'detail', subject: string) =>
        mode === 'detail'
          ? p.host.textContent!.includes(`Private payment ${subject}`)
          : p.host.querySelector(`a[href*="${subject === A ? paidCreatorStatementFixture.id : id(22)}"]`) !== null;
      for (const [mode, cursor] of [
        ['statements', undefined],
        ['statements', 'page+/='],
        ['detail', 'lines+/='],
      ] as const) {
        await p.show(mode, cursor);
        const oldRead = p.queryCallback('creator-statements-current');
        const first = oldRead(); // explicit refresh, not a production prefetch or retry
        const pendingA = p.statementReads.at(-1)!;
        await act(async () => {
          p.session(B, 'csrf-B');
          p.admit();
          p.session(A, 'csrf-A');
          p.admit();
          expect(await oldRead()).toBeNull();
        });
        await p.tick();
        expect(visible(mode, A)).toBe(false);
        const currentA = p.statementReads.at(-1)!;
        expect(currentA).not.toBe(pendingA);
        await p.settle(currentA.work, mode === 'detail' ? detail(A, cursor ?? null) : statementList(A, cursor ?? null));
        expect(visible(mode, A)).toBe(true);
        await act(async () => {
          p.session(B, 'csrf-B');
          p.admit();
        });
        await p.tick();
        const bRead = p.statementReads.at(-1)!;
        await p.settle(bRead.work, mode === 'detail' ? detail(B, cursor ?? null) : statementList(B, cursor ?? null));
        expect(visible(mode, B)).toBe(true);
        await p.settle(
          pendingA.work,
          mode === 'detail' ? new Error('Retired statement failure') : statementList(A, cursor ?? null),
        );
        expect(await first).toBeNull();
        expect(visible(mode, B)).toBe(true);
        if (mode === 'detail') {
          expect(p.host.textContent).toContain(`txn-${B}`);
          expect(p.host.querySelector('a[href*="from=back%2B%2F%3D"]')).not.toBeNull();
        }
        await act(async () => {
          p.session(A, 'csrf-A');
          p.admit();
        });
        await p.tick();
        const invalid = mode === 'detail' ? detail(A, cursor ?? null) : statementList(B, cursor ?? null);
        if (invalid.page.kind === 'ready' && 'payoutStatements' in invalid.page) invalid.page.payoutStatements = [];
        if (invalid.page.kind === 'ready' && 'statement' in invalid.page && invalid.page.lines.kind === 'ready')
          invalid.page.lines.lines[0]!.statementId = id(88);
        await p.settle(p.statementReads.at(-1)!.work, invalid);
        expect(p.host.textContent).not.toContain(m.statements_empty());
        expect(p.host.textContent).not.toContain(`txn-${A}`);
      }
      await act(async () => {
        p.admit(['purchases']);
      });
      await p.tick();
      const before = p.statementReads.length;
      await p.show('statements');
      expect(p.statementReads).toHaveLength(before);
      await p.show('offers');
      expect(p.host.querySelector('input')).toBeNull();
      // Cached viewer data cannot certify either private list after an actual session error/sign-out ABA.
      await act(async () => {
        const query = p.client.getQueryCache().find({ queryKey: sessionQuery.queryKey })!;
        query.setState({ status: 'error', error: new Error('Session unavailable') });
        p.session();
        p.admit();
      });
      await p.tick();
      const wrong = list(B);
      wrong.data.page = { kind: 'ready', offers: [], next: null };
      await p.settle(p.listReads.at(-1)!, wrong);
      expect(p.host.textContent).not.toContain(m.creator_offers_empty());
      const retiredRead = p.queryCallback('creator-offers-current');
      await act(async () => {
        p.client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
        p.session();
        p.admit(['selling'], B); // A's observation cannot accept B's exposure.
        expect(await retiredRead()).toBeNull();
      });
      await p.tick();
      expect(p.host.querySelector('input')).toBeNull();
      await act(async () => {
        p.admit(['selling']);
      });
      await p.tick();
      const emptyWrongAddress = list();
      emptyWrongAddress.requested.cursor = 'foreign-page';
      emptyWrongAddress.data.page = { kind: 'ready', offers: [], next: null };
      await p.settle(p.listReads.at(-1)!, emptyWrongAddress);
      expect(p.host.textContent).not.toContain(m.creator_offers_empty());
    }));
});
