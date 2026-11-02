import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type {
  PublicationAddress,
  PublicationInput,
  PublicationPage,
  PublicationResult,
  PublicationViewer,
} from '../src/library/collection-publication';

// UNRUN: mounted deferred-result regressions for controller integration. Reuse the installed DOM and
// canonical recorded subjects. Controlled BFF responses do not prove native authority or browser behavior.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const reads: { address: PublicationAddress; work: ReturnType<typeof deferred<PublicationPage>> }[] = [];
const writes: { input: PublicationInput; csrf: string | null; work: ReturnType<typeof deferred<PublicationResult>> }[] =
  [];

// Intercept only the two server functions at the existing validator boundary. Keep the production
// collectionPublicationQuery queryFn, including its actual viewer/address validation, installed.
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn() {
    const delegate = start.createServerFn();
    let validate: ((input: unknown) => unknown) | undefined;
    const chain = {
      validator(next: (input: unknown) => unknown) {
        validate = next;
        delegate.validator(next);
        return chain;
      },
      handler<T extends (...args: never[]) => unknown>(handler: T): T {
        const original = delegate.handler(handler);
        return ((input?: { data: unknown; headers?: HeadersInit }) => {
          if (validate?.name === 'expectedSubject')
            return Promise.resolve({
              subject: validate(input?.data),
              admitted: ['collections'],
            });
          if (validate?.name === 'publicationAddress') {
            const call = { address: validate(input?.data) as PublicationAddress, work: deferred<PublicationPage>() };
            reads.push(call);
            return call.work.promise;
          }
          if (validate?.name === 'publicationInput') {
            const call = {
              input: validate(input?.data) as PublicationInput,
              csrf: new Headers(input?.headers).get('X-CSRF-Token'),
              work: deferred<PublicationResult>(),
            };
            writes.push(call);
            return call.work.promise;
          }
          return original(input as never);
        }) as T;
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

type Session = {
  state: 'signed-in' | 'signed-out' | 'unknown';
  subject: string | null;
  csrfToken: string | null;
};
const viewer = (subject = 'story-viewer', csrfToken = 'csrf-one'): Session => ({
  state: 'signed-in',
  subject,
  csrfToken,
});
const address: PublicationAddress = { id: 'publication-example' };
const complete = (input: PublicationInput): PublicationResult => ({
  ok: true,
  collection: { id: input.collectionId, revision: input.revision + 1 },
  publication: { generation: 'native-complete', state: 'complete', itemCount: input.subjectIds.length },
});

async function mount() {
  reads.length = writes.length = 0;
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/collections/publication-example/publish' });
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
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
    await import('@tanstack/react-router');
  const { CollectionPublicationPage, CollectionPublicationPageView } =
    await import('../src/library/collection-publication-page');
  const { collectionPublicationQuery, publicationCandidates } = await import('../src/library/collection-publication');
  const { publicationExample } = await import('../src/kernel/fake/collection-publication');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  if (publicationExample.source.state !== 'ready') throw new Error('Expected canonical disclosed publication fixture');
  const exampleSource = publicationExample.source;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/collections/publication-example/publish'] }),
  });
  await router.load();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  const flush = (work: () => void) =>
    act(async () => {
      work();
      await tick();
    });
  let session = viewer();
  let currentAddress = address;
  const ready = (revision = 7, members = exampleSource.page.members): PublicationPage => ({
    viewer: { subject: session.subject!, csrfToken: session.csrfToken! },
    address: currentAddress,
    source: {
      state: 'ready',
      revision,
      page: { ...exampleSource.page, id: currentAddress.id, curatorAccountId: session.subject!, revision, members },
    },
  });
  const tree = (node: ReactNode) => (
    <QueryClientProvider client={client}>
      <RouterContextProvider router={router}>{node}</RouterContextProvider>
    </QueryClientProvider>
  );
  const show = (nextSession = session, nextAddress = currentAddress) =>
    flush(() => {
      session = nextSession;
      currentAddress = nextAddress;
      client.setQueryData(sessionQuery.queryKey, session);
      root.render(tree(<CollectionPublicationPage address={currentAddress} />));
    });
  const button = (label: string) => {
    const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
    expect(node).toBeDefined();
    return node!;
  };
  const click = (label: string, twice = false) =>
    flush(() => {
      const node = button(label);
      // Dispatch both clicks before React can commit disabled=true.
      node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      if (twice) node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
  const checkboxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const choose = async (indices = [0]) => {
    for (const index of indices) await flush(() => checkboxes()[index]!.click());
    await flush(() => checkboxes().at(-1)!.click());
  };
  const settle = <T,>(work: ReturnType<typeof deferred<T>>, outcome: T | Error) =>
    flush(() => {
      if (outcome instanceof Error) work.reject(outcome);
      else work.resolve(outcome);
    });
  const refresh = () =>
    flush(() => {
      void client.refetchQueries({
        queryKey: collectionPublicationQuery(session as PublicationViewer, currentAddress).queryKey,
      });
    });
  return {
    host,
    m,
    ready,
    show,
    choose,
    click,
    button,
    checkboxes,
    settle,
    refresh,
    ids: publicationCandidates(exampleSource.page).map((member) => member.subject!.id),
    members: exampleSource.page.members,
    hide: () => flush(() => root.render(tree(null))),
    view: (page: PublicationPage) =>
      flush(() =>
        root.render(
          tree(
            <CollectionPublicationPageView
              page={page}
              submit={(input) => {
                const call = { input, csrf: page.viewer?.csrfToken ?? null, work: deferred<PublicationResult>() };
                writes.push(call);
                return call.work.promise;
              }}
            />,
          ),
        ),
      ),
    seed: (page: PublicationPage, credential: PublicationViewer) =>
      flush(() => {
        const query = client.getQueryCache().find({
          queryKey: collectionPublicationQuery(credential, currentAddress).queryKey,
        });
        expect(query).toBeDefined();
        client.setQueryData(query!.queryKey, page);
      }),
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
      overwriteGetLocale(previousLocale);
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
async function mounted(run: (page: Awaited<ReturnType<typeof mount>>) => Promise<void>) {
  const page = await mount();
  try {
    await run(page);
  } finally {
    await page.dispose();
  }
}

test('a null-token owner can select and refresh an exact publication review without revealing private notes or sending writes', async () => {
  await mounted(async (page) => {
    await page.show({ ...viewer(), csrfToken: null });
    expect(reads).toHaveLength(1);
    await page.settle(reads[0]!.work,
      page.ready(7, page.members.map((member) => ({ ...member, note: 'Private occurrence note' }))));
    await page.choose();
    expect(page.host.textContent).not.toContain('Private occurrence note');
    expect(page.host.querySelector('[data-source-revision="7"]')).not.toBeNull();
    expect(page.button(page.m.library_publication_publish()).disabled).toBe(true);
    await page.click(page.m.library_publication_publish());
    await page.click(page.m.library_collection_reload());
    await page.settle(reads[1]!.work, page.ready(8));
    expect(page.host.querySelector('[data-source-revision="8"]')).not.toBeNull();
    await page.show(viewer());
    await page.settle(reads[2]!.work, page.ready(8));
    expect(writes).toHaveLength(0);
    await page.choose([]);
    await page.click(page.m.library_publication_publish());
    expect(writes[0]!.input.revision).toBe(8);
  });
});

test('Uncertain selected publication retains its exact native intent across current-viewer credential refresh', async () => {
  await mounted(async (page) => {
    await page.show();
    expect(reads).toHaveLength(1);
    await page.settle(reads[0]!.work, page.ready());
    await page.choose();
    await page.click(page.m.library_publication_publish(), true);
    expect(writes).toHaveLength(1);
    const original = structuredClone(writes[0]!.input);
    expect(original.collectionId).toBe(address.id);
    expect(original.revision).toBe(7);
    expect(original.subjectIds).toEqual([page.ids[0]!]);
    expect(writes[0]!.csrf).toBe('csrf-one');

    await page.show(viewer('story-viewer', 'csrf-two'));
    expect(reads).toHaveLength(2);
    expect(page.checkboxes()).toHaveLength(0);
    // Even an old source injected at the new key cannot become ready while its required read is pending.
    await page.seed(
      { ...page.ready(), viewer: { subject: 'story-viewer', csrfToken: 'csrf-one' } },
      { subject: 'story-viewer', csrfToken: 'csrf-two' },
    );
    expect(page.checkboxes()).toHaveLength(0);
    await page.settle(reads[1]!.work, page.ready(12, page.members.slice(1)));
    expect(page.button(page.m.library_publication_publish()).disabled).toBe(true);
    expect(writes).toHaveLength(1);
    await page.settle(writes[0]!.work, new Error('Native response lost after dispatch'));
    expect(page.host.textContent).toContain(page.m.library_publication_unknown());

    await page.refresh();
    expect(reads).toHaveLength(3);
    expect(page.checkboxes()).toHaveLength(0);
    expect(page.host.textContent).toContain(page.m.library_publication_unknown());
    await page.settle(reads[2]!.work, new Error('Current source refresh failed'));
    expect(page.checkboxes()).toHaveLength(0);
    expect(page.host.textContent).toContain(page.m.library_publication_unknown());
    await page.click(page.m.library_collection_reload());
    expect(reads).toHaveLength(4);
    await page.settle(reads[3]!.work, page.ready(20, page.members.slice(1)));
    expect(writes).toHaveLength(1);
    expect(page.checkboxes().every((node) => node.disabled)).toBe(true);
    await page.click(page.m.library_publication_retry(), true);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.input).toEqual(original);
    expect(writes[1]!.csrf).toBe('csrf-one');
    await page.settle(writes[1]!.work, { ok: false, reason: 'unknown' });

    await page.show(viewer('story-viewer', 'csrf-three'));
    expect(reads).toHaveLength(5);
    await page.settle(reads[4]!.work, page.ready(21, page.members.slice(1)));
    expect(writes).toHaveLength(2);
    await page.click(page.m.library_publication_retry(), true);
    expect(writes).toHaveLength(3);
    expect(writes[2]!.input).toEqual(original);
    expect(writes[2]!.csrf).toBe('csrf-one');
    await page.settle(writes[2]!.work, complete(original));
    expect(page.host.textContent).toContain(page.m.library_publication_complete_one({ count: '1' }));
    expect(page.checkboxes().at(-1)!.checked).toBe(false);

    // Resolving uncertainty permits an intentional new selection against the freshly read revision.
    await page.choose();
    await page.click(page.m.library_publication_publish(), true);
    expect(writes).toHaveLength(4);
    expect(writes[3]!.input.revision).toBe(21);
    expect(writes[3]!.input.subjectIds).toEqual([page.ids[1]!]);
    expect(writes[3]!.input.idempotencyKey).not.toBe(original.idempotencyKey);
    await page.settle(writes[3]!.work, complete(writes[3]!.input));
    expect(reads).toHaveLength(5);
  });
});

for (const boundary of ['viewer', 'collection', 'cursor', 'authority', 'unmount'] as const) {
  test(`Old publication success, failure and completion cannot paint or unlock a replacement ${boundary} lifetime`, async () => {
    for (const outcome of ['complete', 'denied', 'throw'] as const)
      await mounted(async (page) => {
        const original = page.ready();
        if (original.source.state !== 'ready') throw new Error('Ready fixture');
        await page.view(original);
        await page.choose();
        await page.click(page.m.library_publication_publish(), true);
        const old = writes[0]!;
        if (boundary === 'unmount') await page.hide();
        if (boundary === 'authority') {
          await page.view({ ...original, viewer: null });
          expect(page.checkboxes()).toHaveLength(0);
        }
        const replacementAddress =
          boundary === 'collection'
            ? { id: 'replacement-collection' }
            : boundary === 'cursor'
              ? { ...address, cursor: 'replacement-page' }
              : address;
        const subject = boundary === 'viewer' ? 'replacement-viewer' : 'story-viewer';
        await page.view({
          ...original,
          viewer: { subject, csrfToken: 'current-csrf' },
          address: replacementAddress,
          source: {
            ...original.source,
            page: { ...original.source.page, id: replacementAddress.id, curatorAccountId: subject },
          },
        });
        // The replacement is usable while the old native operation is still outstanding.
        await page.choose([]);
        await page.click(page.m.library_publication_publish(), true);
        expect(writes).toHaveLength(2);
        await page.settle(
          old.work,
          outcome === 'complete'
            ? complete(old.input)
            : outcome === 'denied'
              ? { ok: false, reason: 'denied' }
              : new Error('Old response failed'),
        );
        expect(page.host.querySelector('[aria-busy="true"]')).not.toBeNull();
        expect(page.button(page.m.library_publication_publish()).disabled).toBe(true);
        expect(page.host.textContent).not.toContain(page.m.library_publication_complete_one({ count: '1' }));
        expect(page.host.textContent).not.toContain(page.m.library_publication_denied());
        expect(page.host.textContent).not.toContain(page.m.library_publication_unknown());
        await page.settle(writes[1]!.work, complete(writes[1]!.input));
        expect(page.host.textContent).toContain(page.m.library_publication_complete({ count: '0' }));
        expect(page.checkboxes().at(-1)!.checked).toBe(false);
        expect(reads).toHaveLength(0);
      });
  });
}

test('Retired reload success and failure cannot reset a replacement viewer or address selection', async () => {
  for (const boundary of ['viewer', 'address'] as const)
    for (const fail of [false, true])
      await mounted(async (page) => {
        await page.show();
        await page.settle(reads[0]!.work, page.ready());
        await page.choose();
        await page.click(page.m.library_collection_reload());
        expect(reads).toHaveLength(2);
        const oldReload = reads[1]!;
        const oldSource = page.ready(99);
        await page.show(
          boundary === 'viewer' ? viewer('replacement-viewer') : viewer(),
          boundary === 'address' ? { id: 'replacement-collection' } : address,
        );
        expect(reads).toHaveLength(3);
        await page.settle(reads[2]!.work, page.ready(9));
        await page.choose();
        await page.settle(oldReload.work, fail ? new Error('Old reload failed') : oldSource);
        expect(page.checkboxes()[0]!.checked).toBe(true);
        expect(page.checkboxes().at(-1)!.checked).toBe(true);
        expect(page.button(page.m.library_publication_publish()).disabled).toBe(false);
        await page.click(page.m.library_publication_publish(), true);
        expect(writes).toHaveLength(1);
        expect(writes[0]!.input.revision).toBe(9);
        await page.settle(writes[0]!.work, complete(writes[0]!.input));
      });
});

test('Missing current authority and mismatched current source refuse starts; a fresh valid read enables a healthy retry', async () => {
  await mounted(async (page) => {
    for (const session of [
      { state: 'unknown', subject: null, csrfToken: null },
      { state: 'signed-out', subject: null, csrfToken: null },
      { state: 'signed-in', subject: null, csrfToken: 'csrf' },
    ] satisfies Session[]) {
      await page.show(session);
      expect(page.checkboxes()).toHaveLength(0);
    }
    expect(reads).toHaveLength(0);
    await page.show(viewer());
    for (const mismatch of ['subject', 'collection', 'cursor', 'source', 'unavailable'] as const) {
      const valid = page.ready();
      const invalid: PublicationPage =
        mismatch === 'subject'
          ? { ...valid, viewer: { ...valid.viewer!, subject: 'foreign-viewer' } }
            : mismatch === 'collection'
              ? { ...valid, address: { id: 'foreign-collection' } }
              : mismatch === 'cursor'
                ? { ...valid, address: { ...address, cursor: 'foreign-page' } }
                : mismatch === 'source' && valid.source.state === 'ready'
                  ? { ...valid, source: { ...valid.source, page: { ...valid.source.page, id: 'foreign-source' } } }
                  : { ...valid, source: { state: 'unavailable' } };
      await page.settle(reads.at(-1)!.work, invalid);
      expect(page.checkboxes()).toHaveLength(0);
      expect(page.button(page.m.library_publication_publish()).disabled).toBe(true);
      expect(writes).toHaveLength(0);
      await page.refresh();
    }
    await page.settle(reads.at(-1)!.work, page.ready());
    await page.choose([]);
    await page.click(page.m.library_publication_publish(), true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.input.subjectIds).toEqual([]);
    await page.settle(writes[0]!.work, { ok: false, reason: 'unknown' });
    await page.click(page.m.library_publication_retry(), true);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.input).toEqual(writes[0]!.input);
    await page.settle(writes[1]!.work, complete(writes[1]!.input));
    expect(page.host.textContent).toContain(page.m.library_publication_complete({ count: '0' }));
  });
});
