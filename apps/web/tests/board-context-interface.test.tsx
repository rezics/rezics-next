import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import realmRecording from '../src/kernel/recorded/board-realm-realm.json';
import boardRecording from '../src/kernel/recorded/board-realm.json';
import { m } from '../src/paraglide/messages.js';
import { deLocalizeUrl, getLocale, localizeUrl, setLocale } from '../src/paraglide/runtime.js';
import { boardRealmId, readBoardRealm } from '../src/threads/board-context';
import { BoardContext } from '../src/threads/thread-context';

const require = createRequire(import.meta.url);
const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
type Props = ComponentProps<typeof BoardContext>;
const realm = { id: realmRecording.realm.realmId, title: realmRecording.realm.title };
const board = { id: boardRecording.board.id, title: boardRecording.board.title };

// Public router and SSR APIs; no Link mock, private rendering channel or cache injection.
async function render(props: Props, direction: 'ltr' | 'rtl' = 'ltr') {
  const root = createRootRoute({
    component: () => createElement('main', { dir: direction }, createElement(BoardContext, props)),
  });
  const realms = createRoute({ getParentRoute: () => root, path: '/realms/$id', component: () => null });
  const boards = createRoute({ getParentRoute: () => root, path: '/boards/$id', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([realms, boards]),
    history: createMemoryHistory({ initialEntries: [`/${getLocale()}/`] }),
    rewrite: {
      input: ({ url }) => deLocalizeUrl(url).href,
      output: ({ url }) => localizeUrl(url).href,
    },
  });
  await router.load();
  const window = new Window({ url: `https://site.test/${getLocale()}/` });
  window.document.body.innerHTML = renderToStaticMarkup(createElement(RouterProvider, { router }));
  return { document: window.document, close: () => window.happyDOM.abort() };
}

// Authored UNRUN. SSR observes supplied text, semantics and sizing rules, not browser geometry or native admission.
test('actual router context has no empty navigation, then Realm-only, Board-only and both in native order in every locale', async () => {
  const previous = getLocale();
  try {
    for (const locale of ['en', 'de', 'zh-Hant'] as const) {
      setLocale(locale, { reload: false });
      for (const props of [{}, { prominent: true }, { realm }, { board }, { realm, board }] satisfies Props[]) {
        const view = await render(props);
        try {
          const nav = view.document.querySelector('nav');
          const links = [...view.document.querySelectorAll('a')];
          const expected = [
            ...('realm' in props && props.realm ? [{ path: `/realms/${realm.id}`, title: realm.title }] : []),
            ...('board' in props && props.board ? [{ path: `/boards/${board.id}`, title: board.title }] : []),
          ];
          expect(links.map((link) => link.getAttribute('href'))).toEqual(
            expected.map(({ path }) => `/${locale}${path}`),
          );
          expect(links.map((link) => link.textContent)).toEqual(expected.map(({ title }) => title));
          if (!expected.length) {
            expect(nav).toBeNull();
            expect(view.document.querySelector('[data-slot="avatar"]')).toBeNull();
          } else {
            expect(nav?.getAttribute('aria-label')).toBe(m.board_context_label());
            expect(nav?.querySelectorAll('svg').length).toBe(expected.length === 2 ? 1 : 0);
            expect(nav?.querySelector('button, details, [tabindex], [role="button"]')).toBeNull();
            for (const link of links) {
              expect(link.hasAttribute('target')).toBe(false);
              expect(link.classList.contains('h-auto')).toBe(true);
              expect(link.classList.contains('min-h-11')).toBe(true);
              expect(link.classList.contains('min-w-11')).toBe(true);
              expect(link.classList.contains('focus-visible:outline-2')).toBe(true);
              expect(link.classList.contains('focus-visible:outline-offset-2')).toBe(true);
              expect(link.classList.contains('focus-visible:outline-ring')).toBe(true);
            }
          }
        } finally {
          await view.close();
        }
      }
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('prominent initials retain Realm priority, Board-only initials and the localized null-title fallback', async () => {
  const previous = getLocale();
  try {
    setLocale('en', { reload: false });
    const cases: { props: Props; initials: string; titles: string[] }[] = [
      { props: { realm, board, prominent: true }, initials: 'LP', titles: [realm.title, board.title] },
      { props: { realm, prominent: true }, initials: 'LP', titles: [realm.title] },
      { props: { board, prominent: true }, initials: 'RR', titles: [board.title] },
      { props: { board: { ...board, title: null }, prominent: true }, initials: '?', titles: [m.threads_untitled()] },
    ];
    for (const { props, initials, titles } of cases) {
      const view = await render(props);
      try {
        const avatar = view.document.querySelector('[data-slot="avatar"]');
        expect(avatar?.textContent).toBe(initials);
        expect(avatar?.getAttribute('aria-hidden')).toBe('true');
        expect(avatar?.nextElementSibling?.tagName).toBe('A');
        expect([...view.document.querySelectorAll('a')].map((link) => link.textContent)).toEqual(titles);
      } finally {
        await view.close();
      }
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('full supplied long and unbroken titles remain escaped in ordinary flow in LTR and RTL without a disclosure or inferred context', async () => {
  const previous = getLocale();
  try {
    setLocale('en', { reload: false });
    const realmTitle = `${'Long supplied Realm 共讀 '.repeat(15)}${'UnbrokenRealm'.repeat(50)} <script>private()</script> final Realm`;
    const boardTitle = `${'غرفة القراءة '.repeat(15)}${'無間斷標題'.repeat(60)} final Board`;
    for (const direction of ['ltr', 'rtl'] as const) {
      const view = await render(
        { realm: { ...realm, title: realmTitle }, board: { ...board, title: boardTitle }, prominent: true },
        direction,
      );
      try {
        expect(view.document.querySelector('main')?.getAttribute('dir')).toBe(direction);
        const links = [...view.document.querySelectorAll('nav a')];
        expect(links.map((link) => link.textContent)).toEqual([realmTitle, boardTitle]);
        for (const link of links) {
          expect(link.classList.contains('max-w-full')).toBe(true);
          expect(link.classList.contains('whitespace-normal')).toBe(true);
          expect(link.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
          expect(link.querySelector('span')?.classList.contains('min-w-0')).toBe(true);
          expect(link.className).not.toMatch(/(?:^|\s)(?:truncate|line-clamp-\d+|overflow-hidden|h-11)(?:\s|$)/u);
          expect(link.hasAttribute('title')).toBe(false);
        }
        expect(view.document.querySelector('script, details, button')).toBeNull();
        expect(view.document.querySelector('nav')?.textContent).not.toContain(realmRecording.realm.summary);
      } finally {
        await view.close();
      }
    }
    const absent = await render({ board });
    try {
      expect(absent.document.querySelectorAll('nav a').length).toBe(1);
      expect(absent.document.body.textContent).not.toContain(realm.title);
      expect(absent.document.body.textContent).not.toMatch(/Global|Source|Join/u);
      expect(absent.document.querySelector('a')?.getAttribute('href')).toBe(`/en/boards/${board.id}`);
    } finally {
      await absent.close();
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('the optional producer keeps zero reads without an identity and one matching active Realm read with the existing credential', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (input, init) => {
      calls.push(new Request(input, init));
      return Promise.resolve(Response.json(realmRecording));
    },
  });
  expect(boardRealmId(boardRecording.board)).toBe(realm.id);
  expect(boardRealmId({ realmId: null })).toBeNull();
  expect(await readBoardRealm(client, null)).toBeUndefined();
  expect(await readBoardRealm(client, undefined)).toBeUndefined();
  expect(calls).toHaveLength(0);
  expect(await readBoardRealm(client, realm.id, 'Bearer supplied')).toEqual({
    ...realm,
    summary: realmRecording.realm.summary,
    state: 'active',
    visibility: 'public',
  });
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/realms/${realm.id}`);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer supplied');
});

test('mismatching, inactive, untitled, denied or failed optional Realm reads never retry or infer membership', async () => {
  for (const response of [
    () => Response.json({ realm: { ...realmRecording.realm, realmId: board.id } }),
    () => Response.json({ realm: { ...realmRecording.realm, state: 'suspended' } }),
    () => Response.json({ realm: { ...realmRecording.realm, state: undefined } }),
    () => Response.json({ realm: { ...realmRecording.realm, title: '' } }),
    () => Response.json({ code: 'not_found' }, { status: 404 }),
    () => Response.json({ code: 'forbidden' }, { status: 403 }),
    () => Response.json({ code: 'dependency_unavailable' }, { status: 503 }),
    () => {
      throw new Error('Supplied optional read failure');
    },
  ]) {
    let calls = 0;
    const client = createKernelClient('https://kernel.test', {
      fetch: () => {
        calls++;
        return Promise.resolve(response());
      },
    });
    expect(await readBoardRealm(client, realm.id)).toBeUndefined();
    expect(calls).toBe(1);
  }
});
