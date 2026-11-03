import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import type {
  CommunityKind,
  CommunityRegion,
  CommunityThread,
  SubjectCommunity,
} from '../src/features/pages/subject-community';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

// UNRUN under MINIMAL: mounted presentation regression; no native or visual proof is claimed.
test('Subject discussion and review summaries keep native read destinations and order while withholding non-admitted actions', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/fr/subjects/subject/reviews' });
  const reads: string[] = [];
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
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (async (input: RequestInfo | URL) => {
      reads.push(String(input));
      throw new Error('Supplied community summaries must not fetch additional data');
    }) as typeof fetch,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { SubjectCommunityRegion } = await import('../src/features/pages/subject-community-view');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const { within } = await import(storybook.resolve('@testing-library/dom'));
  const user = userEvent.setup({ document: window.document });
  const previousLocale = getLocale();
  const locale = 'fr';
  const options = { locale } as const;
  const subject = { id: '01a17a3b-0884-721b-91ef-d7ffd7bb58e4', label: 'Les lectures & العودة' };
  const now = '2026-11-02T12:00:00.000Z';
  const longTitle = `Zulu ${'longunbrokentitle'.repeat(18)} العربية`;
  const longSummary = `Résumé ${'تفاصيلSansEspaces'.repeat(12)} & <ordinary text> fin.`;
  const threads: CommunityThread[] = [
    {
      id: 'thread /+?=#版%',
      title: longTitle,
      boardId: 'board /+?=#版%',
      authorId: 'mira',
      createdAt: '2026-11-02T11:00:00.000Z',
      summary: longSummary,
      licence: 'MIT',
      voteCitation: {
        questionId: '01a17a3b-0884-721b-91ef-d7ffd7bb58e5',
        units: 0,
        revision: 2,
      },
      reactions: { upvote: 4, like: 2 },
      viewerReaction: 'like',
    },
    {
      id: 'second',
      title: null,
      boardId: 'another-board',
      authorId: 'missing',
      createdAt: '2026-11-02T11:30:00.000Z',
      summary: '',
      licence: 'MIT',
      voteCitation: null,
      reactions: {},
    },
    {
      id: 'third',
      title: 'Alpha last',
      boardId: 'third-board',
      authorId: 'handle-only',
      createdAt: '2026-10-24T00:00:00.000Z',
      summary: 'The final supplied row.',
      licence: 'MIT',
    },
  ];
  const authors: SubjectCommunity['authors'] = {
    mira: {
      id: 'mira',
      kind: 'actor',
      handle: 'mira/+é',
      displayName: 'Mira العودة',
      state: 'active',
      automated: false,
      operatorId: null,
    },
    'handle-only': {
      id: 'handle-only',
      kind: 'actor',
      handle: 'lecteur',
      displayName: null,
      state: 'active',
      automated: false,
      operatorId: null,
    },
  };
  const original = structuredClone({ threads, authors });
  const cursor = 'native:/+?=&版%';
  const node = 'reviews /+?=&版%';
  const ready: CommunityRegion = { state: 'ready', threads, next: cursor };
  const fullHref = (kind: CommunityKind) =>
    `/fr/subjects/${subject.id}/lectures/${kind === 'review' ? 'reviews' : 'discussion'}?context=public&cursor=previous&node=old`;
  const expectedTitles = [longTitle, m.threads_untitled({}, options), 'Alpha last'];
  const primaryHrefs = [
    '/fr/threads/thread%20%2F%2B%3F%3D%23%E7%89%88%25/zulu',
    '/fr/threads/second/thread',
    '/fr/threads/third/alpha-last',
  ];
  const boardHrefs = [
    '/fr/boards/board%20%2F%2B%3F%3D%23%E7%89%88%25',
    '/fr/boards/another-board',
    '/fr/boards/third-board',
  ];
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  host.dir = 'rtl';
  const root = createRoot(host);
  const navigations: string[] = [];
  host.addEventListener('click', (event) => {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a');
    if (!anchor) return;
    event.preventDefault();
    navigations.push(anchor.getAttribute('href')!);
  });
  const show = async (kind: CommunityKind, paged: boolean, region: CommunityRegion = ready, href = fullHref(kind)) => {
    await act(async () =>
      root.render(
        <SubjectCommunityRegion
          id="community"
          kind={kind}
          region={region}
          authors={authors}
          now={now}
          subject={subject}
          locale={locale}
          href={href}
          paged={paged}
          node={node}
        />,
      ),
    );
  };
  const rows = () => [...host.querySelectorAll('section > ul > li')];
  const slot = (name: string) => host.querySelector<HTMLAnchorElement>(`[data-slot="${name}"]`);
  const titleTexts = () => rows().map((row) => row.querySelector('h3')?.textContent);

  try {
    setLocale(locale, { reload: false });
    for (const kind of ['discussion', 'review'] as const) {
      for (const paged of [false, true]) {
        await show(kind, paged);
        const canvas = within(host);
        const heading = canvas.getByRole('heading', { level: 2 });
        expect(heading.textContent).toBe(
          kind === 'review' ? m.subject_reviews({}, options) : m.subject_discussion({}, options),
        );
        expect(host.querySelector('section')?.getAttribute('aria-labelledby')).toBe(heading.id);
        expect(host.querySelector('section')?.getAttribute('data-slot')).toBe(
          kind === 'review' ? 'review-list' : 'thread-list',
        );
        expect(host.querySelector('section')?.getAttribute('data-state')).toBe('populated');
        expect(canvas.getAllByRole('list')).toHaveLength(1);
        expect(canvas.getAllByRole('listitem')).toHaveLength(3);
        expect(titleTexts()).toEqual(expectedTitles);
        expect(slot('choose-board')).toBeNull();
        expect(slot('retry')).toBeNull();
        expect(slot('see-all')?.getAttribute('href')).toBe(paged ? undefined : fullHref(kind));
        const next = new URL(slot('community-next')!.getAttribute('href')!, window.location.origin);
        if (paged) {
          expect(next.pathname).toBe(new URL(fullHref(kind), window.location.origin).pathname);
          expect([...next.searchParams]).toEqual([
            ['context', 'public'],
            ['cursor', cursor],
            ['node', node],
          ]);
        } else expect(slot('community-next')!.getAttribute('href')).toBe(fullHref(kind));

        for (const [index, row] of rows().entries()) {
          const item = within(row);
          const title = item.getByRole('heading', { level: 3, name: expectedTitles[index] });
          const primary = item.getByRole('link', { name: expectedTitles[index], exact: true });
          expect(title.contains(primary)).toBe(true);
          expect(primary.getAttribute('href')).toBe(primaryHrefs[index]!);
          expect(primary.hasAttribute('tabindex') || primary.hasAttribute('role')).toBe(false);
          expect(title.getAttribute('data-content-item-slot')).toBe('title');
          expect(title.className).not.toMatch(/truncate|line-clamp|text-left|text-right/);
          expect(title.className).toContain('[overflow-wrap:anywhere]');
          expect(primary.classList.contains('min-h-11')).toBe(true);
          expect(primary.classList.contains('focus-visible:outline-2')).toBe(true);
          expect(row.querySelector('a a, a button, li, h2, img, button')).toBeNull();
          const board = item.getByRole('link', { name: m.subject_community_board({}, options), exact: true });
          expect(board.getAttribute('href')).toBe(boardHrefs[index]!);
          expect(
            item.queryByRole('link', {
              name:
                kind === 'review' ? m.subject_community_review({}, options) : m.subject_community_discuss({}, options),
              exact: true,
            }),
          ).toBeNull();
          expect(primary.contains(board)).toBe(false);
          const actions = board.closest('[data-content-item-slot="actions"]')!;
          expect(row.querySelector('[data-slot="create-thread"]')).toBeNull();
          expect(row.querySelector('[data-slot="reaction-chip"]')).toBeNull();
          expect(item.queryByRole('link', { name: m.feed_action_reply({}, options) })).toBeNull();
          expect(actions.classList.contains('z-10')).toBe(true);
          expect(actions.className).toContain('[&_a]:min-h-11');
          expect(actions.className).toContain('[&_a]:min-w-11');
          expect(actions.className).toContain('[&_a:focus-visible]:outline-2');
          expect(row.querySelector('time')?.getAttribute('datetime')).toBe(threads[index]!.createdAt);
        }
        const first = rows()[0]!;
        const preview = first.querySelector('[data-content-item-slot="preview"]')!;
        expect(preview.textContent).toBe(longSummary);
        expect(preview.className).toContain('[overflow-wrap:anywhere]');
        expect(preview.className).not.toMatch(/truncate|line-clamp|text-left|text-right/);
        if (kind === 'review') {
          const citation = first.querySelector<HTMLElement>('[data-slot="review-citation"]')!;
          expect(citation.dataset.state).toBe('unavailable');
          expect(citation.textContent).toContain(m.subject_community_citation_unavailable({}, options));
          expect(citation.textContent).not.toContain(
            m.discussion_provenance_details_rating_units({ units: '0' }, options),
          );
          expect(citation.textContent).not.toContain(m.thread_provenance_current_vote({}, options));
          expect(first.querySelector('[data-slot="community-reaction-summary"]')?.textContent).toContain(
            m.board_feed_reactions({ count: '6' }, options),
          );
          expect(rows()[1]!.querySelector('[data-slot="review-citation"]')?.getAttribute('data-state')).toBe(
            'unscored',
          );
          expect(rows()[2]!.textContent).toContain(m.subject_community_citation_unavailable({}, options));
        }
        expect(rows()[1]!.querySelector('[data-content-item-slot="preview"]')).toBeNull();
        expect(rows()[1]!.textContent).toContain(m.thread_author_unknown({}, options));
        expect(within(rows()[2]!).getByRole('link', { name: '@lecteur' }).getAttribute('href')).toBe('/fr/@lecteur');
        const author = within(first).getByRole('link', { name: 'Mira العودة', exact: true });
        expect(author.getAttribute('href')).toBe('/fr/@mira%2F%2B%C3%A9');
        expect(first.textContent).toContain('@mira/+é');
        expect(first.querySelector('time')?.textContent).toBe('il y a 1 heure');
        expect(first.querySelector('time')?.getAttribute('title')).toBeTruthy();
        const metadata = author.closest('[data-content-item-slot="metadata"]')!;
        expect(metadata.classList.contains('z-10')).toBe(true);
        expect(metadata.className).toContain('[&_a]:min-h-11');
        expect(metadata.className).toContain('[&_a]:min-w-11');
        expect(metadata.className).toContain('[&_a:focus-visible]:outline-2');
        expect(first.querySelector('h3 a')?.contains(author)).toBe(false);
        // Each native anchor gets a separate Tab stop and Enter follows only that destination.
        const links = [...first.querySelectorAll<HTMLAnchorElement>('a')];
        expect(links.map((link) => link.getAttribute('href'))).toEqual([
          primaryHrefs[0]!,
          '/fr/@mira%2F%2B%C3%A9',
          boardHrefs[0]!,
          `${boardHrefs[0]}/new?subject=${subject.id}&subjectTitle=${encodeURIComponent(subject.label)}`,
        ]);
        links[0]!.focus();
        for (const [index, link] of links.entries()) {
          if (index) await act(async () => user.tab());
          expect(window.document.activeElement).toBe(link);
          const count = navigations.length;
          await act(async () => user.keyboard('{Enter}'));
          expect(navigations.slice(count)).toEqual([link.getAttribute('href')!]);
        }
      }
      const originalRows = rows();
      await show(kind, true, { ...ready, state: 'ready', threads: threads.toReversed(), next: null });
      expect(titleTexts()).toEqual(expectedTitles.toReversed());
      expect(rows()[0]).toBe(originalRows[2]!);
      expect(slot('community-next')).toBeNull();

      const nativePage = Array.from({ length: 20 }, (_, index) => ({
        ...threads[2]!,
        id: `native-${20 - index}`,
        title: `Native ${20 - index}`,
      }));
      await show(kind, true, { state: 'ready', threads: nativePage, next: cursor });
      expect(titleTexts()).toEqual(nativePage.map((thread) => thread.title));
      expect(rows()).toHaveLength(20);
      expect(new URL(slot('community-next')!.href).searchParams.get('cursor')).toBe(cursor);

      // A sparse native page is continuation, including Global pages; it never invites a contribution.
      await show(kind, true, { state: 'ready', threads: [], next: cursor });
      expect(host.querySelector('section')?.getAttribute('data-state')).toBe('continuation');
      expect(host.textContent).toContain(m.subject_community_continue({}, options));
      expect(host.textContent).not.toContain(
        kind === 'review' ? m.subject_reviews_empty({}, options) : m.subject_threads_empty({}, options),
      );
      expect(host.querySelector('ul, h3')).toBeNull();
      expect(slot('choose-board')).toBeNull();
      expect(slot('community-next')).not.toBeNull();
      expect(new URL(slot('community-next')!.href).searchParams.get('cursor')).toBe(cursor);
      expect(new URL(slot('community-next')!.href).searchParams.get('node')).toBe(node);
      expect(host.textContent).not.toContain(m.subject_community_board_unavailable({}, options));

      await show(kind, false, { state: 'ready', threads: [], next: null });
      expect(host.querySelector('section')?.getAttribute('data-state')).toBe('empty');
      expect(host.textContent).toContain(
        kind === 'review' ? m.subject_reviews_empty({}, options) : m.subject_threads_empty({}, options),
      );
      expect(slot('community-next')).toBeNull();
      expect(slot('choose-board')).toBeNull();
      expect(host.textContent).toContain(m.subject_community_board_unavailable({}, options));
      for (const state of ['loading', 'closed', 'unavailable'] as const) {
        for (const paged of [false, true]) {
          await show(kind, paged, { state });
          expect(host.querySelector('section')?.getAttribute('data-state')).toBe(state);
          expect(within(host).getAllByRole('heading', { level: 2 })).toHaveLength(1);
          expect(within(host).getByRole('status').textContent).toBe(
            state === 'loading'
              ? m.subject_community_loading({}, options)
              : state === 'closed'
                ? m.platform_closed_message({}, options)
                : m.subject_section_failed({}, options),
          );
          expect(host.querySelector('ul, h3, [data-slot="create-thread"]')).toBeNull();
          expect(slot('choose-board')).toBeNull();
          expect(slot('community-next')).toBeNull();
          expect(slot('see-all')).toBeNull();
          if (state === 'unavailable') {
            expect(slot('retry')?.getAttribute('href')).toBe(
              paged ? fullHref(kind) : '?context=public&cursor=previous&node=old',
            );
            expect(slot('retry')?.textContent).toBe(m.subject_section_retry({}, options));
          } else expect(host.querySelector('a')).toBeNull();
        }
      }
    }
    expect({ threads, authors }).toEqual(original);
    expect(reads).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
}, 30_000);
