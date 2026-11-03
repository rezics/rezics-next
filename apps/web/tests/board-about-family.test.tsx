import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { loadBoardPageWithAuthors } from '../src/identity/page-loaders';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import realmBoard from '../src/kernel/recorded/board-realm.json';
import realm from '../src/kernel/recorded/board-realm-realm.json';
import globalBoard from '../src/kernel/recorded/board.json';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import type { CommunityPresentation, RealmPresentationImage } from '../src/threads/board-community-source';
import type { CommunityBoardPage } from '../src/threads/board-feed-data';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { BoardCommunity, BoardCommunityStatus } = await import('../src/threads/board-community');

const require = createRequire(import.meta.url);
const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
const summary = `${'Read together, compare interpretations, and give every reader room to contribute. '.repeat(16)}\n${'UnbrokenDescription'.repeat(24)}\nThe final description sentence is supplied.`;
const rulesText = `${'Mark spoilers, respect other readers, and explain your interpretation of the work. '.repeat(24)}\n${'UnbrokenRule'.repeat(32)}\nThe last supplied rule must remain reachable.`;
const body = fromPlainText(rulesText);
const avatar: RealmPresentationImage = {
  id: '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d0001',
  containerId: realm.realm.realmId,
  digest: 'a'.repeat(64),
  width: 320,
  height: 480,
  variants: [{ format: 'webp', width: 320, height: 480 }],
  placeholder: null,
  focalPoint: null,
  credit: {
    rightsHolder: 'Independent avatar artist',
    via: { name: 'Avatar original', url: 'https://example.org/avatar-original' },
    license: 'CC-BY-4.0',
    obligations: ['cc:Attribution'],
  },
};
const banner: RealmPresentationImage = {
  ...avatar,
  id: '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d0003',
  credit: {
    rightsHolder: 'Independent banner photographer',
    via: { name: 'Banner original', url: 'https://example.org/banner-original' },
    license: 'CC-BY-SA-4.0',
    obligations: ['cc:Attribution', 'cc:ShareAlike'],
  },
};
const supplied: CommunityPresentation = {
  realmId: realm.realm.realmId,
  spaceId: realm.realm.spaceId,
  contextId: realm.realm.contextId,
  name: realm.realm.title,
  description: summary,
  avatar: { state: 'available', value: avatar },
  banner: { state: 'available', value: banner },
  members: { state: 'current', count: 128, version: 'supplied-version' },
  rules: {
    state: 'available',
    value: {
      postId: '01a17ce8-2850-71fd-a965-456700000001',
      revisionId: '01a17ce8-2850-71fe-874d-456700000002',
      body,
      licence: 'MIT',
      sha256: createHash('sha256').update(serializeDocument(body)).digest('hex'),
    },
  },
  join: { membership: 'unknown', action: null },
};

async function load(community: CommunityPresentation | 'unavailable' | null) {
  const calls: string[] = [];
  const recorded = createStoryRecordedKernelFetch();
  const id = community === null ? globalBoard.board.id : realmBoard.board.id;
  const page = await loadBoardPageWithAuthors(
    createKernelClient('https://kernel.test', {
      fetch: (input, init) => {
        const path = new URL(new Request(input, init).url).pathname;
        calls.push(path);
        if (community !== null && path === `/v1/boards/${id}`)
          return Promise.resolve(
            Response.json({
              board: {
                ...realmBoard.board,
                ...(community === 'unavailable' ? {} : { community }),
              },
            }),
          );
        if (community === 'unavailable' && path.startsWith('/v1/realms/'))
          return Promise.resolve(Response.json({ code: 'not_found' }, { status: 404 }));
        return recorded(input, init);
      },
    }),
    { id },
  );
  return { page, calls };
}

async function render(content: ReactNode) {
  setLocale('en', { reload: false });
  const route = createRootRoute({ component: () => content });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
  const window = new Window({ url: 'https://site.test/en/' });
  window.document.body.innerHTML = html;
  return { html, document: window.document, close: () => window.happyDOM.abort() };
}

function board(page: CommunityBoardPage) {
  return <BoardCommunity page={page} sort="hot" />;
}

// Render the actual owned view. Browser layout, native disclosure and physical checks remain owed; this suite is authored UNRUN.
test('two simultaneous Boards retain local About/Rules associations, full supplied content, exact destinations and independent credits', async () => {
  const { page, calls } = await load(supplied);
  const before = [...calls];
  const view = await render(
    <>
      <BoardCommunity
        page={page}
        sort="active"
        participation={<button type="button">Supplied participation</button>}
        start={<a href="/en/supplied-composer">Supplied start</a>}
        overflow={<button type="button">Supplied overflow</button>}
      />
      {board({ ...page, board: { ...page.board, visibility: 'protected' } })}
    </>,
  );
  try {
    const asides = Array.from(view.document.querySelectorAll('aside')) as HTMLElement[];
    expect(asides).toHaveLength(2);
    const identities: string[] = [];
    for (const aside of asides) {
      const about = aside.querySelector('h2')!;
      const rules = aside.querySelector('section')!;
      const rulesHeading = rules.querySelector('h3')!;
      expect(about.textContent).toBe(m.board_community_about());
      expect(rulesHeading.textContent).toBe(m.board_community_rules());
      expect(aside.getAttribute('aria-labelledby')).toBe(about.id);
      expect(rules.getAttribute('aria-labelledby')).toBe(rulesHeading.id);
      for (const heading of [about, rulesHeading]) {
        expect(heading.id.length).toBeGreaterThan(0);
        expect(view.document.getElementById(heading.id)).toBe(heading);
        identities.push(heading.id);
      }
      expect(Array.from(aside.querySelectorAll('p')).some((p) => p.textContent === summary)).toBe(true);
      const document = rules.querySelector('[data-slot="document-body"]')!;
      for (const paragraph of rulesText.split('\n')) expect(document.textContent).toContain(paragraph);
      expect(aside.querySelector('details')).toBeNull();
      expect(aside.querySelector('[class*="line-clamp"], [class*="truncate"], [class*="overflow-hidden"]')).toBeNull();
      expect(aside.querySelector('li')).toBeNull();
      const links = Array.from(aside.querySelectorAll('a'));
      expect(links.find((link) => link.textContent === supplied.name)?.getAttribute('href')).toBe(
        `/en/realms/${supplied.realmId}`,
      );
      expect(links.find((link) => link.textContent === m.board_community_rules_revision())?.getAttribute('href')).toBe(
        '/en/posts/01a17ce8-2850-71fd-a965-456700000001/revisions/01a17ce8-2850-71fe-874d-456700000002',
      );
      expect(rules.textContent).toContain('MIT');
      for (const image of [avatar, banner]) {
        const credit = image.credit!;
        const source = links.find((link) => link.textContent === credit.via.name)!;
        expect(source.getAttribute('href')).toBe(credit.via.url);
        expect(source.getAttribute('rel')).toBe('noopener noreferrer nofollow');
        expect(source.parentElement?.textContent).toContain(credit.rightsHolder);
        expect(source.parentElement?.textContent).toContain(credit.license);
        expect(source.parentElement?.closest('a')).toBeNull();
      }
    }
    expect(new Set(identities).size).toBe(4);
    expect(view.document.querySelectorAll('h1')).toHaveLength(2);
    expect(view.document.querySelector('h1')?.textContent).toBe(page.board.title);
    expect(view.html).toContain('Supplied participation');
    expect(view.html).toContain('Supplied start');
    expect(view.html).toContain('Supplied overflow');
    expect(view.html).toContain('data-slot="board-feed-card"');
    expect(view.html).toContain(m.board_community_members({ count: 128 }));
    expect(view.html).not.toContain(m.board_community_members_unknown());
    expect(view.html).toContain(m.board_community_protected());
    expect(view.html).toContain(m.board_community_protected_help());
    expect(view.html).not.toContain(supplied.members.state === 'current' ? supplied.members.version : 'unexpected');
    expect(calls).toEqual(before);
    expect(calls.filter((path) => path === '/v1/accounts')).toHaveLength(1);
    expect(calls.some((path) => /^\/v1\/(posts|media|members)\//u.test(path))).toBe(false);
  } finally {
    await view.close();
  }
});

test('native none and unavailable remain distinct, empty descriptions stay authored, and unavailable images never acquire credits', async () => {
  for (const state of ['none', 'unavailable'] as const) {
    const { page } = await load({
      ...supplied,
      description: '',
      avatar: { state: 'none', value: null },
      banner: { state: 'unavailable', value: null },
      members: { state: 'unknown', count: null, version: null },
      rules: { state, value: null },
    });
    const view = await render(board(page));
    try {
      const aside = view.document.querySelector('aside')!;
      expect(aside.textContent).toContain(
        state === 'none' ? m.board_community_rules_none() : m.board_community_rules_unavailable(),
      );
      expect(aside.textContent).not.toContain(
        state === 'none' ? m.board_community_rules_unavailable() : m.board_community_rules_none(),
      );
      expect(aside.textContent).not.toContain(realm.realm.summary);
      expect(view.html).not.toContain(summary);
      expect(view.html).toContain(m.board_community_members_unknown());
      expect(view.html).not.toContain(m.board_community_members({ count: 0 }));
      expect(aside.querySelector('[data-slot="document-body"]')).toBeNull();
      expect(aside.querySelector('a[href*="/revisions/"]')).toBeNull();
      expect(aside.textContent).not.toContain('MIT');
      expect(view.html).not.toContain('https://example.org/');
      expect(view.html).not.toContain(`/media/${avatar.id}/`);
      expect(view.html).not.toContain(`/media/${banner.id}/`);
      expect(view.html).not.toContain(m.board_community_global());
      expect(aside.querySelector(`a[href="/en/realms/${supplied.realmId}"]`)).not.toBeNull();
    } finally {
      await view.close();
    }
  }
  const { page } = await load({ ...supplied, members: { state: 'current', count: 0, version: 'current-zero' } });
  const zero = await render(board(page));
  try {
    expect(zero.html).toContain(m.board_community_members({ count: 0 }));
    expect(zero.html).not.toContain(m.board_community_members_unknown());
  } finally {
    await zero.close();
  }
});

test('unavailable Realm information never becomes Global, and Global has no invented rules or Join', async () => {
  for (const state of ['unavailable', null] as const) {
    const { page } = await load(state);
    const view = await render(board(page));
    try {
      const aside = view.document.querySelector('aside')!;
      expect(aside.textContent).toContain(
        state === null ? m.board_community_global() : m.board_community_source_unavailable(),
      );
      expect(aside.querySelector('h3') === null).toBe(state === null);
      expect(aside.querySelector('a[href*="/realms/"]')).toBeNull();
      expect(aside.querySelector('a[href*="/revisions/"]')).toBeNull();
      expect(view.html).not.toContain(m.realm_join());
      expect(view.html).not.toContain(summary);
      if (state !== null) {
        expect(view.html).not.toContain(m.board_community_global());
        expect(aside.textContent).toContain(m.board_community_rules_unavailable());
      }
    } finally {
      await view.close();
    }
  }
});

test('each available image keeps its own credit when the other image is not supplied', async () => {
  for (const slot of ['avatar', 'banner'] as const) {
    const { page } = await load({
      ...supplied,
      ...(slot === 'avatar'
        ? { banner: { state: 'unavailable' as const, value: null } }
        : { avatar: { state: 'none' as const, value: null } }),
    });
    const view = await render(board(page));
    try {
      const present = slot === 'avatar' ? avatar : banner;
      const absent = slot === 'avatar' ? banner : avatar;
      expect(view.html).toContain(present.credit!.via.url);
      expect(view.html).toContain(present.credit!.rightsHolder);
      expect(view.html).not.toContain(absent.credit!.via.url);
      expect(view.html).not.toContain(absent.credit!.rightsHolder);
    } finally {
      await view.close();
    }
  }
});

test('local loading, error and closed statuses never render an empty-success feed; retry stays explicit and large', async () => {
  for (const state of ['loading', 'error', 'closed'] as const) {
    let retries = 0;
    const view = await render(
      <BoardCommunityStatus
        state={state}
        onRetry={() => {
          retries += 1;
        }}
      />,
    );
    try {
      const status = view.document.querySelector('[role="status"]')!;
      expect(status.textContent).toBe(
        state === 'loading'
          ? m.board_community_loading()
          : state === 'error'
            ? m.error_message()
            : m.platform_closed_message(),
      );
      expect(view.document.querySelector('section')?.getAttribute('aria-busy')).toBe(String(state === 'loading'));
      expect(view.html).not.toContain(m.board_threads_empty());
      expect(view.html).not.toContain(m.board_threads_page_empty());
      expect(view.document.querySelector('aside, ul, [data-slot="board-feed-card"]')).toBeNull();
      const retry = view.document.querySelector('button');
      expect(retry === null).toBe(state !== 'error');
      if (retry) {
        expect(retry.textContent).toBe(m.board_community_retry());
        expect(retry.classList.contains('min-h-11')).toBe(true);
        expect(retry.classList.contains('min-w-11')).toBe(true);
      }
      expect(retries).toBe(0);
    } finally {
      await view.close();
    }
  }
  const withoutRetry = await render(<BoardCommunityStatus state="error" />);
  try {
    expect(withoutRetry.document.querySelector('button')).toBeNull();
  } finally {
    await withoutRetry.close();
  }
});
