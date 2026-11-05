import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import * as start from '../.storybook/react-start';
import recording from '../src/kernel/recorded/library-follows.json';
import type { MineFollow, MineFollowingPage } from '../src/library/mine-following';

// UNRUN: composed DOM assertions with the real shared item and follow controls.
// Controlled IO does not establish native, browser, visual or integration acceptance.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

test('Following uses shared item headings and independent native actions while preserving unavailable targets reasons and current viewer lifetime', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library/following', width: 1280, height: 900 });
  window.document.documentElement.lang = 'en';
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    CSS: window.CSS,
    scrollTo: window.scrollTo.bind(window),
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
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
    await import('@tanstack/react-router');
  const { sessionQuery } = await import('../src/session/query');
  const { MineFollowingPageView } = await import('../src/library/mine-following-page');
  const followActions = await import('../src/library/follow-actions');
  const { subjectOf } = await import('../src/library/reads');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });

  const follows: MineFollow[] = recording.follows.map((follow) => ({
    targetId: follow.targetId,
    targetType: follow.targetType as MineFollow['targetType'],
    state: 'following',
    reason: follow.reason as MineFollow['reason'],
    target: subjectOf(follow.target),
    idempotencyKey: crypto.randomUUID(),
  }));
  const subject: MineFollow = {
    ...follows.find((follow) => follow.targetType === 'subject')!,
    target: {
      ...follows.find((follow) => follow.targetType === 'subject')!.target!,
      id: 'canonical-subject',
      label: { value: 'こころ', language: 'ja' },
      typeLabel: 'Book',
    },
  };
  const collection = follows.find((follow) => follow.targetType === 'collection')!;
  const space: MineFollow = { ...follows.find((follow) => follow.targetType === 'space')!, reason: 'membership' };
  const unavailable: MineFollow = {
    ...subject,
    targetId: 'unavailable-target',
    target: null,
    idempotencyKey: crypto.randomUUID(),
  };
  const page: MineFollowingPage = { signedIn: true, follows: [space, collection, subject, unavailable], next: null };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: 'current-csrf' });
  const admit = (admitted: string[]) =>
    client.setQueriesData(
      {
        predicate: ({ queryKey }) => queryKey[0] === 'exposure' && queryKey[1] === 'viewer' && queryKey[2] === 'owner',
      },
      { subject: 'owner', admitted },
    );
  const write = spyOn(followActions, 'setFollow')
    .mockResolvedValueOnce({ ok: false, reason: 'conflict' })
    .mockResolvedValue({ ok: true, following: false });
  let reviews = 0;
  const edgeRead = spyOn(followActions, 'readFollowState').mockImplementation(() => {
    throw new Error('Following already supplies its own edge state');
  });
  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  let replacePage!: (next: MineFollowingPage) => void;
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/following',
    component: function FollowingFixture() {
      const [current, setCurrent] = useState(page);
      replacePage = setCurrent;
      return (
        <MineFollowingPageView
          page={current}
          cursor={null}
          onReview={async () => {
            reviews++;
            return { state: 'ready', following: true };
          }}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/library/following'] }),
  });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  try {
    await router.load();
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      await tick();
    });
    await act(async () => {
      admit(['personal_library', 'collections']);
      await tick();
    });
    const nativeRows = [...host.querySelectorAll<HTMLElement>('li[data-slot="list-row"]')];
    // Native order replaces type grouping; the other assertions retain their target identities.
    expect(nativeRows.map((row) => row.dataset.followTargetType)).toEqual([
      'space',
      'collection',
      'subject',
      'subject',
    ]);
    const rows = [nativeRows[2]!, nativeRows[3]!, nativeRows[1]!, nativeRows[0]!];
    expect(host.textContent).not.toContain(m.library_directory_address_invalid());
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.querySelector('h3')?.textContent)).toEqual([
      'こころ',
      m.library_subject_unavailable(),
      collection.target!.label,
      space.target!.label,
    ]);
    expect(host.querySelector('ul')?.getAttribute('aria-label')).toBe(m.library_following_heading());
    const primary = rows[0]!.querySelector<HTMLAnchorElement>('a')!;
    const heading = rows[0]!.querySelector<HTMLHeadingElement>('h3')!;
    expect(primary.getAttribute('href')).toBe(subjectHref({ id: 'canonical-subject', label: 'こころ' }, 'en').href);
    expect(primary.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(primary.getAttribute('aria-label')).toBeNull();
    expect(primary.lang).toBe('ja');
    expect(heading.lang).toBe('ja');
    expect(heading.closest('[aria-hidden="true"]')).toBeNull();
    expect(heading.tabIndex).toBe(-1);
    expect(rows[0]!.querySelectorAll('a')).toHaveLength(1);
    expect(rows[0]!.querySelector('a a, a button, h3 a')).toBeNull();
    expect(rows[2]!.querySelector('a')?.getAttribute('href')).toBe(
      `/en/collections/${encodeURIComponent(collection.target!.id)}`,
    );
    expect(rows[2]!.querySelector('a')?.getAttribute('aria-labelledby')).toBe(rows[2]!.querySelector('h3')!.id);
    expect(rows[1]!.querySelector('a')).toBeNull();
    expect(rows[3]!.querySelector('a')).toBeNull();
    expect(rows[0]!.querySelector('[data-content-item-slot="metadata"]')?.textContent).toContain('Book');
    expect(rows[0]!.textContent).toContain(m.library_follow_reason_library());
    expect(rows[1]!.textContent).toContain(m.library_following_subjects());
    expect(rows[1]!.textContent).toContain(m.library_follow_reason_library());
    expect(rows[2]!.textContent).toContain(m.library_following_kind_collection());
    expect(rows[3]!.textContent).toContain(m.library_following_kind_space());
    expect(rows[3]!.textContent).toContain(m.library_follow_reason_membership());

    await act(async () => {
      admit(['personal_library']);
      await tick();
    });
    expect(rows[2]!.querySelector('a')).toBeNull();
    expect(rows[2]!.querySelector('h3')?.textContent).toBe(collection.target!.label);
    expect(rows[2]!.querySelector('button')).not.toBeNull();

    let navigations = 0;
    primary.addEventListener('click', () => navigations++);
    const trigger = rows[0]!.querySelector<HTMLButtonElement>('[data-content-item-slot="actions"] button')!;
    expect(trigger.getAttribute('aria-label')).toBe(m.library_follow_more_actions({ title: 'こころ' }));
    expect(trigger.closest('a')).toBeNull();
    expect(trigger.tabIndex).toBe(0);
    trigger.focus();
    expect(window.document.activeElement).toBe(trigger);
    await act(async () => {
      await user.keyboard('{Enter}');
      await tick();
    });
    const action = window.document.querySelector<HTMLElement>('[role="menuitem"]');
    expect(action?.textContent).toBe(m.library_follow_unfollow());
    await act(async () => {
      await user.click(action!);
      await tick();
    });
    expect(write.mock.calls).toHaveLength(1);
    expect(write.mock.calls[0]![0].data).toEqual({
      targetId: subject.targetId,
      following: false,
      idempotencyKey: subject.idempotencyKey,
    });
    expect(new Headers(write.mock.calls[0]![0].headers).get('X-CSRF-Token')).toBe('current-csrf');
    expect(host.querySelectorAll('li[data-slot="list-row"]')).toHaveLength(4);
    await act(async () => {
      const review = [...host.querySelectorAll('button')].find(
        (node) => node.textContent === m.library_follow_conflict_recovery_review(),
      )!;
      await user.click(review);
      await tick();
    });
    expect(reviews).toBe(1);
    expect(write.mock.calls).toHaveLength(1);
    await act(async () => {
      await user.click(trigger);
      await tick();
      await user.click(window.document.querySelector<HTMLElement>('[role="menuitem"]')!);
      await tick();
    });
    expect(write.mock.calls).toHaveLength(2);
    expect(write.mock.calls[1]![0].data.idempotencyKey).not.toBe(subject.idempotencyKey);
    expect(host.querySelectorAll('li[data-slot="list-row"]')).toHaveLength(3);
    expect(heading.isConnected).toBe(false);
    expect(rows.slice(1).every((row) => row.isConnected)).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.library_follow_removed());
    expect(navigations).toBe(0);
    expect(router.state.location.href).toBe('/library/following');
    expect(window.location.pathname).toBe('/en/library/following');
    expect(edgeRead.mock.calls).toHaveLength(0);

    await act(async () => {
      replacePage({ signedIn: true, follows: [], next: null });
      await tick();
    });
    expect(host.textContent).toContain(m.library_following_empty());
    expect(host.textContent).not.toContain(m.library_following_page_empty());
    expect(host.querySelector('nav')).toBeNull();
    await act(async () => {
      replacePage({ signedIn: true, follows: [], next: 'bounded/next+' });
      await tick();
    });
    expect(host.textContent).toContain(m.library_following_page_empty());
    expect(host.textContent).not.toContain(m.library_following_empty());
    expect(host.querySelector('[data-slot="empty"] a')?.getAttribute('href')).toBe('/en/search');
    const more = host.querySelector<HTMLAnchorElement>('nav a')!;
    expect(new URL(more.href).searchParams.get('cursor')).toBe('bounded/next+');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    write.mockRestore();
    edgeRead.mockRestore();
    await window.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
