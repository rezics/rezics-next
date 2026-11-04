import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { CreatorEditionsPage } from '../src/content-editions/creator-editions';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test'),
  setResponseHeader() {},
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/fr/editions?cursor=continued%2F%2B%3D' });
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
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { CreatorEditionsOriginView } = await import('../src/content-editions/creator-editions-view');
const {
  createCreatorEditionOrigin,
  creatorEditionOriginReturnHref,
  readCreatorEditionOrigin,
  bindCreatorEditionOriginEdition,
} = await import('../src/content-editions/creator-edition-origin');
const { publicationFixture } = await import('../src/stories/patterns/edition-publication/edition-publication-fixtures');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const previousLocale = getLocale();
setLocale('fr', { reload: false });

afterAll(async () => {
  mock.restore();
  setLocale(previousLocale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function tree(
  router: ReturnType<typeof createRouter>,
  client: InstanceType<typeof QueryClient>,
  page: CreatorEditionsPage,
  cursor?: string,
) {
  return (
    <RouterContextProvider router={router}>
      <QueryClientProvider client={client}>
        <CreatorEditionsOriginView page={page} cursor={cursor} />
      </QueryClientProvider>
    </RouterContextProvider>
  );
}

test('continued inventory resumes its exact Edition and returns to only that re-admitted occurrence', async () => {
  const fixture = await publicationFixture('resumed-draft');
  const edition = fixture.controller.snapshot().edition!;
  const exactEditionId = edition.editionId;
  const accountId = edition.creatorAccountId;
  const page = { kind: 'ready' as const, editions: [edition], next: null };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: accountId, csrfToken: 'csrf' });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const rootRoute = createRootRoute({ component: () => null });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/fr/editions?cursor=continued%2F%2B%3D'] }),
  });
  const navigate = spyOn(router, 'navigate').mockResolvedValue(undefined);
  try {
    await act(async () => root.render(tree(router, client, page, 'continued/+=')));
    const resume = [...host.querySelectorAll('a')].find((link) => link.textContent === m.creator_editions_resume());
    expect(resume?.getAttribute('href')).toBe(`/fr/editions/new?editionId=${exactEditionId}`);
    expect(resume?.getAttribute('href')).not.toContain('editionOrigin');
    await act(async () => resume!.click());
    const handoff = navigate.mock.calls.at(-1)![0] as { href: string };
    const handoffUrl = new URL(handoff.href, 'https://site.test');
    const token = handoffUrl.searchParams.get('editionOrigin')!;
    expect(handoffUrl.searchParams.get('editionId')).toBe(exactEditionId);
    expect(handoffUrl.searchParams.has('cursor')).toBe(false);
    const admitted = readCreatorEditionOrigin(token, accountId, exactEditionId);
    expect(admitted.kind).toBe('current');
    if (admitted.kind !== 'current') throw new Error('origin receipt was not retained');
    expect(admitted.receipt.cursor).toBe('continued/+=');
    const returnHref = creatorEditionOriginReturnHref(admitted.receipt);
    const returnUrl = new URL(returnHref, 'https://site.test');
    expect(returnUrl.searchParams.get('cursor')).toBe('continued/+=');
    expect(returnUrl.searchParams.get('editionOrigin')).toBe(token);
    expect(returnUrl.searchParams.has('editionId')).toBe(false);

    const returnRouter = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: [returnHref] }),
    });
    await act(async () => root.render(tree(returnRouter, client, { kind: 'loading' }, 'continued/+=')));
    expect(host.textContent).toContain(m.creator_edition_origin_checking());
    expect(readCreatorEditionOrigin(token, accountId, exactEditionId).kind).toBe('current');

    await act(async () => root.render(tree(returnRouter, client, page, 'continued/+=')));
    expect(document.activeElement?.id).toBe(`creator-edition-${exactEditionId}`);
    expect(host.textContent).toContain(m.creator_edition_origin_present());

    await act(async () =>
      root.render(tree(returnRouter, client, { kind: 'ready', editions: [], next: null }, 'continued/+=')),
    );
    expect(host.textContent).toContain(m.creator_edition_origin_missing());
    expect(
      [...host.querySelectorAll('button')].some((button) => button.textContent === m.creator_edition_origin_restart()),
    ).toBe(true);
    expect(
      [...host.querySelectorAll('button')].some((button) => button.textContent === m.creator_edition_origin_return()),
    ).toBe(false);

    const replacement = createCreatorEditionOrigin({ accountId, cursor: 'continued/+=', editionId: exactEditionId });
    expect(replacement).toBeTruthy();
    expect(
      bindCreatorEditionOriginEdition(
        replacement!,
        fixture.controller.snapshot().edition!.editionId.replace(/.$/, '1'),
      ),
    ).toBe(false);
    expect(readCreatorEditionOrigin(replacement, accountId, exactEditionId).kind).toBe('lost');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    navigate.mockRestore();
  }
});
