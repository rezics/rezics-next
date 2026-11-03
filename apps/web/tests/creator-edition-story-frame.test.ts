import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  useLocation,
} from '@tanstack/react-router';
import { act, createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import { creatorEditionSearch } from '../src/checkout/creator-offer-address';
import type { CreatorEditorPageData, CreatorOfferGuard } from '../src/checkout/creator-offers';
import { configuredPriceExample } from '../src/kernel/fake/creator-offers';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
afterAll(() => mock.restore());

const { CreatorOfferEditor } = await import('../src/checkout/creator-offer-editor');

const editionId = '019a2100-0000-7000-8000-000000000001';
const localEditingGuard: CreatorOfferGuard = { isCurrent: () => true, csrfToken: () => null };
const retiredGuard: CreatorOfferGuard = { isCurrent: () => false, csrfToken: () => null };
const ready = {
  selling: true,
  csrfToken: '',
  createKey: '019a2100-0000-7000-8000-000000000006',
  editor: {
    kind: 'ready' as const,
    edition: {
      editionId,
      editionRevision: '019a2100-0000-7000-8000-000000000002',
      state: 'published' as const,
      targetSubjectId: '019a2100-0000-7000-8000-000000000003',
      creatorAccountId: '019a2100-0000-7000-8000-000000000004',
      revisionId: '019a2100-0000-7000-8000-000000000005',
      sha256: 'abcdef0123456789'.repeat(4),
      licence: 'CC-BY-4.0',
    },
    schema: configuredPriceExample,
  },
} satisfies CreatorEditorPageData;

function parseSearch(searchString: string): Record<string, unknown> {
  const search = new URLSearchParams(searchString);
  const parsed: Record<string, unknown> = Object.create(null);
  for (const [key, value] of search) parsed[key] = value;
  return parsed;
}

function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) if (typeof value === 'string') params.append(key, value);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function BoundEditor({ data, retired = false }: { data: CreatorEditorPageData; retired?: boolean }) {
  const selected = creatorEditionSearch(
    useLocation({ select: (location) => location.search as Record<string, unknown> }),
  ).contentEditionId;
  const readyEdition = data.editor.kind === 'ready' ? data.editor.edition : undefined;
  const bound =
    readyEdition && selected !== readyEdition.editionId
      ? { ...data, editor: { kind: 'choose-edition' as const } }
      : data;
  return createElement(CreatorOfferEditor, {
    data: bound,
    locale: 'en',
    guard: retired ? retiredGuard : localEditingGuard,
  });
}

async function frameHtml(path: string, data: CreatorEditorPageData, extra?: ReactNode, retired = false) {
  const { AppShell } = await import('../src/shell/shell');
  start.setStoryRequestContext({ visitor: 'Signed In', url: path });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => createElement(AppShell, null, extra, createElement(BoundEditor, { data, retired })),
    }),
    history: createMemoryHistory({ initialEntries: [path] }),
    parseSearch,
    stringifySearch,
  });
  await router.load();
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
  );
}

test('selected-edition editor stays inside the shared frame and cannot create after typing or retirement', async () => {
  const offers = await import('../src/checkout/creator-offers');
  const { m } = await import('../src/paraglide/messages.js');
  const { overwriteGetLocale, getLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const transport = spyOn(offers, 'manageCreatorOffer').mockRejectedValue(new Error('creation must not dispatch'));
  const selectedPath = `/en/creator/offers/new?editionId=${encodeURIComponent(editionId)}`;
  const editorPath = '/en/creator/offers/new';
  try {
    const normal = await frameHtml(selectedPath, ready);
    expect(normal).toMatch(/<main[^>]*id="main-content"/);
    expect(normal).toContain(m.creator_new_offer());
    expect(normal).toContain('CC-BY-4.0');
    expect(normal).toContain(editionId);
    expect(normal).toContain(m.creator_create());
    expect(normal).toMatch(/disabled/);
    expect(normal).not.toContain('max-w-xs');

    const narrow = await frameHtml(selectedPath, {
      ...ready,
      editor: {
        ...ready.editor,
        edition: { ...ready.editor.edition, licence: 'https://creativecommons.org/licenses/by/4.0/legalcode.en' },
      },
    });
    expect(narrow).toMatch(/<main[^>]*id="main-content"/);
    expect(narrow).toContain('https://creativecommons.org/licenses/by/4.0/legalcode.en');
    expect(narrow).toContain(m.creator_create());
    expect(narrow).not.toContain('max-w-xs');

    const choose = await frameHtml(editorPath, { ...ready, editor: { kind: 'choose-edition' } });
    expect(choose).toMatch(/<main[^>]*id="main-content"/);
    expect(choose).toContain(m.creator_choose_edition());
    expect(choose).not.toContain('CC-BY-4.0');

    const unavailable = await frameHtml(editorPath, { ...ready, editor: { kind: 'unavailable' } });
    expect(unavailable).toMatch(/<main[^>]*id="main-content"/);
    expect(unavailable).toContain(m.creator_unavailable());
    expect(unavailable).not.toContain(m.creator_create());

    const retired = await frameHtml(
      selectedPath,
      { ...ready, selling: false, editor: { kind: 'denied' } },
      createElement('button', { type: 'button' }, 'Retire supplied authority'),
      true,
    );
    expect(retired).toMatch(/<main[^>]*id="main-content"/);
    expect(retired).toContain(m.creator_denied());
    expect(retired).not.toContain(m.creator_create());

    const { Window } = await import(
      Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
    );
    const window = new Window({ url: `https://site.test${selectedPath}` });
    const globals = {
      window,
      document: window.document,
      HTMLElement: window.HTMLElement,
      HTMLInputElement: window.HTMLInputElement,
      HTMLButtonElement: window.HTMLButtonElement,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const { createRoot } = await import('react-dom/client');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(createElement(CreatorOfferEditor, { data: ready, locale: 'en', guard: localEditingGuard }));
      });
      const title = host.querySelector<HTMLInputElement>('input[name="title"]')!;
      const create = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      expect(create.disabled).toBe(true);
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title, 'My offer title');
        title.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      expect(title.value).toBe('My offer title');
      expect(create.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      for (const [key, descriptor] of previous)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      await window.happyDOM.close();
    }
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
    overwriteGetLocale(previousLocale);
  }
});
