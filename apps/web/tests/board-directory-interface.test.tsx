import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createKernelClient } from '@rezics/client';
import recording from '../src/kernel/recorded/board.json';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { BoardDirectory } from '../src/threads/board-directory-view';
import {
  boardDirectoryHref,
  createNativeBoardDirectoryAdapter,
  loadBoardDirectory,
  type BoardDirectoryRequest,
  type DirectoryBoard,
} from '../src/threads/board-directory';

// Authored UNRUN. DOM semantics/callbacks do not establish browser layout or native authorization.
type Props = ComponentProps<typeof BoardDirectory>;
const title = `A board for reading across languages العربية 日本語 ${'UnbrokenBoardTitle'.repeat(12)}`;
const contribution = {
  subject: '01a17a3b-0884-721b-91ef-d7ffd7bb58e4',
  subjectTitle: '原作 العربية & '.repeat(40).slice(0, 512),
};
const request: BoardDirectoryRequest = { purpose: 'reviews', cursor: 'signed:current/+opaque=', limit: 20 };
const prior: BoardDirectoryRequest = { purpose: 'reviews', cursor: 'signed:prior/+opaque=', limit: 20 };
const next = 'signed:next/+opaque=';
const board: DirectoryBoard = {
  ...recording.board,
  community: null,
  title,
  purpose: 'reviews',
  visibility: 'published',
  availability: 'available',
};
const props: Props = {
  request,
  contribution,
  result: { state: 'ready', boards: [board], next },
  previous: { request: prior, target: request.cursor!, contribution },
  onRetry: () => {},
};
const { contribution: _contribution, ...ordinaryProps } = props;

async function withDirectory(
  run: (view: {
    host: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
    click: (node: Element, init?: MouseEventInit) => Promise<boolean>;
  }) => Promise<void>,
) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/boards' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const locale = getLocale();
  try {
    await setLocale('en', { reload: false });
    await run({
      host,
      render: async (node) => {
        await act(async () => root.render(node));
      },
      click: async (node, init = {}) => {
        const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
        await act(async () => {
          node.dispatchEvent(event);
        });
        return event.defaultPrevented;
      },
    });
  } finally {
    await act(async () => root.unmount());
    await setLocale(locale, { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('Complete readable usable Board directory and contribution choices', async () => {
  await withDirectory(async ({ host, render }) => {
    await render(
      <div dir="rtl" style={{ width: 390 }}>
        <BoardDirectory {...props} />
        <BoardDirectory {...props} />
      </div>,
    );
    expect(host.querySelectorAll('h1')).toHaveLength(2);
    const headings = [...host.querySelectorAll('h2')];
    expect(headings.map((heading) => heading.textContent)).toEqual([title, title]);
    expect(new Set(headings.map((heading) => heading.id)).size).toBe(2);
    for (const article of host.querySelectorAll('article')) {
      expect(article.querySelector('header')!.textContent).toContain(
        m.board_directory_subject({ title: contribution.subjectTitle }),
      );
      expect(article.className).toContain('[overflow-wrap:anywhere]');
      const row = article.querySelector('li')!;
      expect(row.className).toContain('[&_[data-content-item-slot=title]]:line-clamp-none');
      expect(row.className).toContain('[&>div]:sm:block');
      const heading = row.querySelector('h2')!;
      const primary = row.querySelector<HTMLAnchorElement>('[data-slot="list-row-link"]')!;
      const action = row.querySelector<HTMLAnchorElement>('[data-content-item-slot="actions"] a')!;
      expect(primary.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(primary.getAttribute('href')).toBe(`/en/boards/${board.id}`);
      expect(action.getAttribute('aria-label')).toBe(
        m.board_directory_review_named({ title, subject: contribution.subjectTitle }),
      );
      const composer = new URL(action.href);
      expect(composer.pathname).toBe(`/en/boards/${board.id}/new`);
      expect(Object.fromEntries(composer.searchParams)).toEqual(contribution);
      expect(primary.contains(action)).toBe(false);
      expect(row.querySelectorAll('a')).toHaveLength(2);
      expect(row.querySelector('[data-content-item-slot="metadata"]')!.textContent).toBe(
        `${m.board_directory_global()} · ${m.board_directory_reviews()} · ${m.board_directory_public()}`,
      );
      for (const control of article.querySelectorAll('nav a, [data-content-item-slot="actions"] a')) {
        expect(control.className).toContain('min-h-11');
        expect(control.className).toContain('min-w-11');
        expect(control.className).toContain('h-auto');
        expect(control.className).toContain('whitespace-normal');
        expect(control.className).not.toContain('whitespace-nowrap');
      }
    }
  });
});

test('purpose, prior and next retain exact payloads and modified clicks keep native anchor behavior', async () => {
  await withDirectory(async ({ host, render, click }) => {
    const calls: BoardDirectoryRequest[] = [];
    await render(<BoardDirectory {...props} onNavigate={(destination) => calls.push(destination)} />);
    const links = [...host.querySelectorAll<HTMLAnchorElement>('nav a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      boardDirectoryHref({ purpose: 'discussion', limit: 20 }, 'en', contribution),
      boardDirectoryHref({ purpose: 'reviews', limit: 20 }, 'en', contribution),
      boardDirectoryHref(prior, 'en', contribution),
      boardDirectoryHref({ ...request, cursor: next }, 'en', contribution),
    ]);
    expect(links.filter((link) => link.getAttribute('aria-current') === 'page')).toEqual([links[1]!]);
    const expected = [
      { purpose: 'discussion', limit: 20 },
      { purpose: 'reviews', limit: 20 },
      prior,
      { ...request, cursor: next },
    ];
    for (const link of links) {
      for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])
        expect(await click(link, init)).toBe(false);
      expect(await click(link)).toBe(true);
    }
    expect(calls).toEqual(expected);
    await render(<BoardDirectory {...props} />);
    expect(await click(host.querySelector('nav a')!)).toBe(false);
    for (const changed of [
      undefined,
      { ...contribution, subject: board.id },
      { ...contribution, subjectTitle: 'Other title' },
    ]) {
      await render(<BoardDirectory {...ordinaryProps} {...(changed ? { contribution: changed } : {})} />);
      expect(host.textContent).not.toContain(m.board_directory_previous());
      expect(host.textContent).toContain(m.board_directory_next());
    }
  });
});

test('all supplied native unavailable states retain selection and manual retry without false empty or disclosure', async () => {
  await withDirectory(async ({ host, render, click }) => {
    const cases = [
      { status: 400, body: { code: 'invalid_cursor' }, state: 'unavailable' },
      { status: 401, body: { code: 'invalid_credentials' }, state: 'denied' },
      { status: 403, body: { code: 'forbidden' }, state: 'denied' },
      { status: 403, body: { code: 'platform_closed' }, state: 'closed' },
      { status: 503, body: { code: 'dependency_unavailable' }, state: 'unavailable' },
      { status: 503, body: { code: 'deadline_exceeded' }, state: 'unavailable' },
      { status: 200, body: { boards: Array.from({ length: 21 }, () => board), next: null }, state: 'unavailable' },
      { status: 200, body: { boards: [], next: request.cursor }, state: 'unavailable' },
      { status: 200, body: { boards: [], next: '' }, state: 'unavailable' },
    ] as const;
    for (const response of cases) {
      const calls: Request[] = [];
      const client = createKernelClient('https://kernel.test', {
        fetch: async (input, init) => {
          calls.push(new Request(input, init));
          return Response.json(
            { ...response.body, privateTitle: 'Withheld board title', privateId: 'withheld-board-id' },
            { status: response.status },
          );
        },
      });
      const adapter = createNativeBoardDirectoryAdapter(client);
      const result = await loadBoardDirectory(request, adapter);
      expect(result.state).toBe(response.state);
      let retried = 0;
      await render(
        <BoardDirectory
          {...props}
          result={result}
          onRetry={() => {
            retried++;
            void loadBoardDirectory(request, adapter);
          }}
        />,
      );
      expect(calls).toHaveLength(1);
      expect(retried).toBe(0);
      expect(host.querySelectorAll('li, nav[aria-label="Board pages"]')).toHaveLength(0);
      for (const withheld of [
        title,
        board.id,
        'Withheld board title',
        'withheld-board-id',
        m.board_directory_empty(),
        m.board_directory_sparse(),
      ])
        expect(host.innerHTML).not.toContain(withheld);
      const retry = host.querySelector('button');
      if (response.state === 'unavailable') {
        expect(host.textContent).toContain(m.board_directory_unavailable());
        expect(retry!.className).toContain('min-h-11');
        expect(retry!.className).toContain('whitespace-normal');
        await click(retry!);
        expect(retried).toBe(1);
        expect(calls).toHaveLength(2);
      } else {
        expect(retry).toBeNull();
        expect(host.textContent).toContain(
          response.state === 'closed' ? m.platform_closed_message() : m.board_directory_denied(),
        );
      }
      for (const call of calls)
        expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({
          purpose: request.purpose,
          cursor: request.cursor!,
          limit: '20',
        });
    }
  });
});

test('an unavailable continuation can restart at the first page with its purpose and Subject', async () => {
  await withDirectory(async ({ host, render, click }) => {
    const firstPage = { purpose: request.purpose, limit: request.limit };
    const calls: BoardDirectoryRequest[] = [];
    await render(
      <BoardDirectory
        {...props}
        result={{ state: 'unavailable' }}
        onNavigate={(destination) => calls.push(destination)}
      />,
    );
    const restart = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent === m.board_directory_restart(),
    )!;
    expect(restart.getAttribute('href')).toBe(boardDirectoryHref(firstPage, 'en', contribution));
    expect(await click(restart, { ctrlKey: true })).toBe(false);
    expect(await click(restart)).toBe(true);
    expect(calls).toEqual([firstPage]);

    let retries = 0;
    await render(
      <BoardDirectory
        {...ordinaryProps}
        request={firstPage}
        result={{ state: 'unavailable' }}
        onRetry={() => retries++}
      />,
    );
    expect(host.querySelector('a[href*="cursor"]')).toBeNull();
    expect(host.querySelector('button')?.textContent).toBe(m.board_directory_retry());
    await click(host.querySelector('button')!);
    expect(retries).toBe(1);
  });
});

test('loading, sparse continuation and final empty differ while every native write predicate remains authoritative', async () => {
  await withDirectory(async ({ host, render }) => {
    await render(<BoardDirectory {...props} result={{ state: 'loading' }} />);
    expect(host.querySelector('section')!.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('[role="status"]')!.textContent).toBe(m.board_directory_loading());
    expect(host.querySelectorAll('li, button')).toHaveLength(0);
    const hidden = [
      { ...board, id: 'hidden-realm', title: 'Withheld Realm board', realmId: 'realm' },
      { ...board, id: 'hidden-purpose', title: 'Withheld purpose board', purpose: 'discussion' as const },
      { ...board, id: 'hidden-protected', title: 'Withheld protected board', visibility: 'protected' as const },
      { ...board, id: 'hidden-erased', title: 'Withheld erased board', availability: 'erased' as const },
    ];
    for (const cursor of [next, null]) {
      const result = await loadBoardDirectory(request, async () => ({ state: 'ready', boards: hidden, next: cursor }));
      await render(<BoardDirectory {...props} result={result} />);
      expect(host.textContent).toContain(cursor ? m.board_directory_sparse() : m.board_directory_empty());
      expect(host.textContent).not.toContain(cursor ? m.board_directory_empty() : m.board_directory_sparse());
      expect(host.textContent!.includes(m.board_directory_next())).toBe(cursor !== null);
      for (const withheld of hidden) {
        expect(host.innerHTML).not.toContain(withheld.id);
        expect(host.innerHTML).not.toContain(withheld.title);
      }
    }
    for (const supplied of [board, ...hidden]) {
      await render(<BoardDirectory {...props} result={{ state: 'ready', boards: [supplied], next: null }} />);
      const action = host.querySelector<HTMLAnchorElement>('[data-content-item-slot="actions"] a')!;
      expect(action.pathname.endsWith('/new')).toBe(supplied === board);
      if (supplied.visibility === 'protected') expect(host.textContent).toContain(m.board_directory_protected());
    }
    await render(<BoardDirectory {...ordinaryProps} />);
    expect(host.querySelector('[data-content-item-slot="actions"] a')!.getAttribute('aria-label')).toBe(
      m.board_directory_open_named({ title }),
    );
  });
});
