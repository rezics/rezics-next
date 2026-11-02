import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, Fragment, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type {
  InboxPage,
  InboxSeenAttempt,
  InboxSeenResult,
  ResolvedInboxPage,
  UnreadCount,
} from '../src/inbox/inbox-read';

// UNRUN: production callers, real QueryClient/session observers and shared UI, with held IO only.
// Native admission, browser journeys and original acceptance are deferred by the launch contract.
let sessionRequests = 0;
let failSession = false;
let sessionSubject = 'alice';
let sessionToken = 'original-token';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => {
    sessionRequests++;
    if (failSession) throw new Error('session query failed');
    return new Request('https://site.test/en/inbox', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
  },
  setResponseHeader: () => {},
}));
mock.module('cloudflare:workers', () => ({
  env: {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'inbox-authority',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({ signedIn: async () => ({ signedIn: true, subject: sessionSubject, csrfToken: sessionToken }) }),
    },
  },
}));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/inbox' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
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
const buttonModule = await import('@rezics/ui/shadcn/button');
const OriginalButton = buttonModule.Button;
const callbacks = new Map<string, () => unknown>();
// Retain the caller's actual callbacks, while continuing to render the actual shared Button.
spyOn(buttonModule, 'Button').mockImplementation((props) => {
  if (typeof props.children === 'string' && props.onClick)
    callbacks.set(props.children, props.onClick as () => unknown);
  return createElement(OriginalButton, props);
});
const reads = await import('../src/inbox/inbox-read');
let countRead: () => Promise<UnreadCount> = async () => {
  throw new Error('No count transport installed');
};
let seenSend: (input: { data: InboxSeenAttempt; headers?: HeadersInit }) => Promise<InboxSeenResult> = async () => {
  throw new Error('No marker transport installed');
};
spyOn(reads, 'readUnreadCount').mockImplementation(() => countRead());
spyOn(reads, 'markInboxSeen').mockImplementation((input) => seenSend(input));
const { InboxPageView } = await import('../src/inbox/inbox-page');
const { UnreadBadge } = await import('../src/inbox/unread-badge');
const { currentInboxViewer, inboxViewerStore, forInboxViewer } = await import('../src/inbox/inbox-viewer');
const { inboxPageQuery, inboxViewerQueryKey, unreadCountQuery, unreadCountQueryFor, markInboxViewerSeen } =
  await import('../src/inbox/inbox-query');
const { retryInboxSession } = await import('../src/inbox/inbox-entry-state');
const { sessionQuery } = await import('../src/session/query');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
setLocale('en', { reload: false });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const session = (subject = 'alice', csrfToken = 'original-token') => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});
const continuation = 'opaque.second+page/cursor==';
const third = 'opaque.third+page/cursor==';
const fourth = 'opaque.fourth+page/cursor==';
const notice = (id: string, unread = true): ResolvedInboxPage['items'][number] => ({
  id,
  unread,
  kind: 'reply',
  createdAt: '2026-10-29T10:00:00.000Z',
  actorId: 'actor',
  actorName: 'Momo',
  threadId: 'thread',
  postId: id,
  decisionId: null,
  reportId: null,
  href: `/threads/thread#post-${id}`,
  text: `Private reply ${id}`,
  unavailable: false,
});
const ready = (ids = ['newest'], next: string | null = continuation): InboxPage => ({
  signedIn: true,
  state: 'ready',
  items: ids.map((id) => notice(id)),
  next,
});
const count = (value: number): UnreadCount => ({ signedIn: true, state: 'ready', count: value, capped: false });
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
async function failedSession(client: InstanceType<typeof QueryClient>) {
  failSession = true;
  try {
    await expect(retryInboxSession(client)).rejects.toThrow('session query failed');
  } finally {
    failSession = false;
  }
}

async function screen(strict = false) {
  callbacks.clear();
  sessionSubject = 'alice';
  sessionToken = 'original-token';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session());
  const pageCalls: { cursor?: string; work?: ReturnType<typeof deferred<InboxPage>> }[] = [];
  const countCalls: ReturnType<typeof deferred<UnreadCount>>[] = [];
  const commands: {
    data: InboxSeenAttempt;
    token: string | null;
    work: ReturnType<typeof deferred<InboxSeenResult>>;
  }[] = [];
  let holdPages = false;
  let pageResult = (cursor?: string): InboxPage => (cursor ? ready(['older', 'oldest'], null) : ready());
  const loadPage = async (cursor?: string) => {
    const call = { ...(cursor ? { cursor } : {}), ...(holdPages ? { work: deferred<InboxPage>() } : {}) };
    pageCalls.push(call);
    return call.work ? call.work.promise : pageResult(cursor);
  };
  countRead = () => {
    const work = deferred<UnreadCount>();
    countCalls.push(work);
    return work.promise;
  };
  seenSend = ({ data, headers }) => {
    const work = deferred<InboxSeenResult>();
    commands.push({ data, token: new Headers(headers).get('X-CSRF-Token'), work });
    return work.promise;
  };
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/inbox?from=header#latest'] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (page = true, badge = true) =>
    act(async () => {
      const contents = createElement(
        QueryClientProvider,
        { client },
        createElement(
          RouterContextProvider,
          { router },
          createElement(
            Fragment,
            null,
            page ? createElement(InboxPageView, { loadPage }) : null,
            badge ? createElement('aside', { 'data-badge': true }, createElement(UnreadBadge)) : null,
          ),
        ),
      );
      root.render(strict ? createElement(StrictMode, null, contents) : contents);
    });
  const button = (label: string) => {
    const node = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
    expect(node, label).toBeDefined();
    return node!;
  };
  const click = (label: string) =>
    act(async () => {
      button(label).click();
    });
  const retain = (label: string) => {
    expect(callbacks.has(label), label).toBe(true);
    return callbacks.get(label)!;
  };
  const rows = () =>
    [...host.querySelectorAll<HTMLElement>('[data-notice-id]')].map((row) => [
      row.dataset.noticeId,
      row.dataset.unread,
    ]);
  await render();
  await tick();
  // Resolve only the current count (StrictMode may cancel an earlier observation).
  await act(async () => {
    for (const work of countCalls) work.resolve(count(7));
  });
  await tick();
  return {
    client,
    host,
    pageCalls,
    countCalls,
    commands,
    render,
    click,
    retain,
    rows,
    hold: () => {
      holdPages = true;
    },
    resume: () => {
      holdPages = false;
    },
    respond: (next: typeof pageResult) => {
      pageResult = next;
    },
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}

test('keyboard continuation keeps sparse pages and exact retries usable, focuses only admitted successes and retires late handoffs', async () => {
  const { default: userEvent } = await import(
    Bun.resolveSync('@testing-library/user-event', dirname(Bun.resolveSync('storybook/test', import.meta.dir)))
  );
  const user = userEvent.setup({ document });
  const view = await screen();
  const { client, host, pageCalls, commands } = view;
  const viewer = currentInboxViewer(client)!;
  const heading = host.querySelector('h1')!;
  const outside = document.createElement('button');
  document.body.append(outside);
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
  const enter = () =>
    act(async () => {
      await user.keyboard('{Enter}');
    });
  const settle = async (result: InboxPage) => {
    await act(async () => {
      pageCalls.at(-1)!.work!.resolve(result);
    });
    await tick();
  };
  try {
    expect(document.activeElement).not.toBe(heading);
    const filter = button(m.inbox_triage_filter_all());
    filter.focus();
    await act(async () => {
      client.setQueryData(inboxPageQuery(viewer).queryKey, ready([]));
    });
    await tick();
    expect(document.activeElement).toBe(filter);
    view.hold();
    const next = button(m.inbox_next_page());
    next.focus();
    await act(async () => {
      await user.keyboard('{Enter}{Enter}');
    });
    expect(pageCalls).toHaveLength(2);
    expect(next.getAttribute('aria-busy')).toBe('true');
    expect(next.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(next);
    await settle(ready([], third));
    expect(document.activeElement).toBe(heading);
    expect(heading.tabIndex).toBe(-1);
    expect(host.textContent).toContain(m.inbox_page_loaded());
    const retry = button(m.inbox_next_page());
    retry.focus();
    await enter();
    await settle({ signedIn: true, state: 'unavailable', failure: { status: 503 } });
    expect(button(m.inbox_retry())).toBe(retry);
    expect(document.activeElement).toBe(retry);
    expect(host.textContent).not.toContain(m.inbox_empty());
    await act(async () => {
      await user.keyboard(' ');
    });
    expect(pageCalls.slice(-2).map(({ cursor }) => cursor)).toEqual([third, third]);
    await settle(ready([], null));
    expect(document.activeElement).toBe(heading);
    expect(host.textContent).toContain(m.inbox_empty());
    expect(host.textContent).toContain(m.inbox_page_end());
    expect(host.contains(retry)).toBe(false);
    filter.focus();
    await act(async () => {
      client.setQueryData(inboxPageQuery(viewer, third).queryKey, ready(['fresh']));
    });
    await tick();
    expect(document.activeElement).toBe(filter);
    expect(view.rows()).toEqual([['fresh', 'true']]);
    button(m.inbox_load_more()).focus();
    await enter();
    outside.focus();
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out' });
    });
    expect(view.rows()).toEqual([]);
    await settle(ready(['late-private'], null));
    expect(document.activeElement).toBe(outside);
    expect(host.textContent).not.toContain('late-private');
    expect(host.textContent).not.toContain(m.inbox_page_loaded());
    expect(commands).toHaveLength(0);
  } finally {
    outside.remove();
    await view.close();
  }
});

test('Inbox session failure retires retained private rows badges and exact marker callbacks before recovery', async () => {
  for (const outcome of ['confirmed', 'failed'] as const) {
    const view = await screen();
    const { client, host, pageCalls, countCalls, commands } = view;
    try {
      expect(view.rows()).toEqual([['newest', 'true']]);
      expect(host.querySelector('[data-badge]')?.textContent).toBe('7');
      const alice = currentInboxViewer(client)!;
      const oldPageKey = inboxPageQuery(alice).queryKey;
      const oldCountKey = unreadCountQueryFor(alice).queryKey;
      const mark = view.retain(m.inbox_triage_mark());
      const more = view.retain(m.inbox_load_more());
      await view.click(m.inbox_triage_mark());
      expect(commands).toHaveLength(1);
      const original = { ...commands[0]!.data };
      expect(original.through).toBe('newest');
      expect(original.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(host.textContent).not.toContain(m.inbox_triage_marked());

      // Real active query refetches retain the private rows/count while transport is pending.
      view.hold();
      let pageRefetch!: Promise<void>;
      let countRefetch!: Promise<void>;
      await act(async () => {
        pageRefetch = client.refetchQueries({ queryKey: oldPageKey, exact: true });
        countRefetch = client.refetchQueries({ queryKey: oldCountKey, exact: true });
      });
      const latePage = pageCalls.at(-1)!.work!;
      const lateCount = countCalls.at(-1)!;
      expect(view.rows()).toEqual([['newest', 'true']]);
      const before = { pages: pageCalls.length, counts: countCalls.length, sessions: sessionRequests };
      await act(async () => {
        await failedSession(client);
        expect(client.getQueryData(sessionQuery.queryKey)).toEqual(session());
        expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('error');
        expect(alice.isCurrent()).toBe(false);
        // Invoke the retained production handlers before React can replace their page.
        mark();
        more();
      });
      await tick();
      expect(sessionRequests).toBe(before.sessions + 1);
      expect(pageCalls).toHaveLength(before.pages);
      expect(countCalls).toHaveLength(before.counts);
      expect(commands).toHaveLength(1);
      expect(view.rows()).toEqual([]);
      expect(host.querySelector('[data-badge]')?.textContent).toBe('');
      expect(host.querySelector('[data-badge] [aria-label]')).toBeNull();
      expect(host.textContent).toContain(m.inbox_session_unavailable());
      expect(host.textContent).not.toContain(m.inbox_empty());

      // The existing deliberate Retry, through the installed sessionQuery, is sufficient.
      view.resume();
      view.respond(() => ready(['recovered'], null));
      await view.click(m.inbox_retry());
      await tick();
      const recovered = currentInboxViewer(client)!;
      expect(recovered.subject).toBe('alice');
      expect(recovered.epoch).not.toBe(alice.epoch);
      expect(alice.isCurrent()).toBe(false);
      await act(async () => countCalls.at(-1)!.resolve(count(2)));
      await tick();
      expect(view.rows()).toEqual([['recovered', 'true']]);
      expect(host.querySelector('[data-badge]')?.textContent).toBe('2');
      const newPageKey = inboxPageQuery(recovered).queryKey;
      const newCountKey = unreadCountQueryFor(recovered).queryKey;
      const freshReads = pageCalls.length;
      await act(async () => {
        if (outcome === 'confirmed') {
          latePage.resolve(ready(['obsolete-private-row'], 'obsolete-cursor'));
          lateCount.resolve(count(99));
          commands[0]!.work.resolve({ signedIn: true });
        } else {
          latePage.reject(new Error('old page failed'));
          lateCount.reject(new Error('old count failed'));
          commands[0]!.work.reject(new Error('old marker response lost'));
        }
        await Promise.all([pageRefetch, countRefetch]);
        mark();
        more();
      });
      await tick();
      expect(view.rows()).toEqual([['recovered', 'true']]);
      expect(host.textContent).not.toContain('obsolete');
      expect(host.textContent).not.toContain(m.inbox_seen_unavailable());
      expect(host.textContent).not.toContain(m.inbox_triage_marked());
      expect(host.querySelector('[data-badge]')?.textContent).toBe('2');
      expect(client.getQueryState(newPageKey)?.isInvalidated).toBe(false);
      expect(client.getQueryState(newCountKey)?.isInvalidated).toBe(false);
      expect(pageCalls).toHaveLength(freshReads);
      expect(commands).toHaveLength(1);
      await view.click(m.inbox_triage_mark());
      expect(commands).toHaveLength(2);
      expect(commands[1]!.data.through).toBe('recovered');
      expect(commands[1]!.data.idempotencyKey).not.toBe(original.idempotencyKey);
    } finally {
      await view.close();
    }
  }
});

test('same-stack errors, query removal and invalid sessions permanently retire production page and badge epochs', async () => {
  for (const loss of [
    'error',
    'removed',
    'unknown',
    'signed-out',
    'unavailable',
    'changed-subject',
    'invalid-subject',
  ] as const) {
    const view = await screen();
    try {
      const old = currentInboxViewer(view.client)!;
      const more = view.retain(m.inbox_load_more());
      const mark = view.retain(m.inbox_triage_mark());
      const readsBefore = view.pageCalls.length;
      await act(async () => {
        if (loss === 'error') await failedSession(view.client);
        else if (loss === 'removed') view.client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
        else
          view.client.setQueryData<unknown>(
            sessionQuery.queryKey,
            loss === 'changed-subject'
              ? session('bob')
              : loss === 'invalid-subject'
                ? { ...session(), subject: ' ' }
                : { state: loss, subject: null, csrfToken: null },
          );
        expect(old.isCurrent()).toBe(false);
        view.client.setQueryData(sessionQuery.queryKey, session());
        // Neither retained data nor a same-subject success can resurrect the original object.
        more();
        mark();
        expect(old.isCurrent()).toBe(false);
        expect(currentInboxViewer(view.client)).not.toBe(old);
      });
      await tick();
      expect(view.pageCalls).toHaveLength(readsBefore + 1);
      expect(view.commands).toHaveLength(0);
      expect(view.rows()).toEqual([['newest', 'true']]);
      expect(view.host.querySelector('[data-badge]')?.textContent).not.toBe('7');
      await act(async () => view.countCalls.at(-1)!.resolve(count(3)));
      await tick();
      expect(view.host.querySelector('[data-badge]')?.textContent).toBe('3');
    } finally {
      await view.close();
    }
  }
});

test('retained exact marker retry and access callbacks cannot read sessions or send into a recovered owner', async () => {
  const view = await screen();
  try {
    await view.click(m.inbox_triage_mark());
    await act(async () => view.commands[0]!.work.reject(new Error('unknown marker outcome')));
    await tick();
    const retry = view.retain(m.inbox_retry());
    const access = view.retain(m.inbox_check_access());
    const old = currentInboxViewer(view.client)!;
    const before = { pages: view.pageCalls.length, sessions: sessionRequests };
    await act(async () => {
      await failedSession(view.client);
      retry();
      access();
    });
    await tick();
    expect(old.isCurrent()).toBe(false);
    expect(sessionRequests).toBe(before.sessions + 1);
    expect(view.pageCalls).toHaveLength(before.pages);
    await view.click(m.inbox_retry());
    await tick();
    const afterRecovery = { pages: view.pageCalls.length, sessions: sessionRequests };
    await act(async () => {
      retry();
      access();
    });
    await tick();
    expect(view.pageCalls).toHaveLength(afterRecovery.pages);
    expect(sessionRequests).toBe(afterRecovery.sessions);
    expect(view.commands).toHaveLength(1);
    expect(view.host.textContent).not.toContain(m.inbox_seen_unavailable());
  } finally {
    await view.close();
  }
});

test('successful same-subject CSRF refresh keeps exact marker intent and original whole loaded eligible set', async () => {
  const view = await screen();
  try {
    let confirmed = false;
    view.respond((cursor) => ({
      signedIn: true,
      state: 'ready',
      items: (cursor === fourth
        ? ['unloaded-fourth']
        : cursor === third
          ? ['later-loaded']
          : cursor
            ? ['older', 'oldest']
            : ['newest']
      ).map((id) => notice(id, !confirmed || id.startsWith('unloaded') || id === 'later-loaded')),
      next: cursor === fourth ? null : cursor === third ? fourth : cursor ? third : continuation,
    }));
    await view.click(m.inbox_load_more());
    await tick();
    expect(view.rows()).toEqual([
      ['newest', 'true'],
      ['older', 'true'],
      ['oldest', 'true'],
    ]);
    const owner = currentInboxViewer(view.client)!;
    await view.click(m.inbox_triage_mark());
    const original = { ...view.commands[0]!.data };
    await act(async () => view.commands[0]!.work.reject(new Error('response lost')));
    await tick();
    expect(view.host.textContent).toContain(m.inbox_seen_unknown());
    expect(view.host.textContent).not.toContain(m.inbox_triage_marked());
    // Page loading is deliberate and cannot expand the original marker's eligible set.
    await view.click(m.inbox_load_more());
    await tick();
    await view.click(m.inbox_load_more());
    await tick();
    expect(view.rows().map(([id]) => id)).toEqual(['newest', 'older', 'oldest', 'later-loaded', 'unloaded-fourth']);
    const exactRetry = view.retain(m.inbox_retry());
    const beforeRefresh = view.commands.length;
    sessionToken = 'refreshed-token';
    await view.click(m.inbox_check_access());
    await tick();
    expect(currentInboxViewer(view.client)).toBe(owner);
    expect(view.commands).toHaveLength(beforeRefresh);
    // Refresh again before React renders, then invoke the actual retained retry closure.
    await act(async () => {
      view.client.setQueryData(sessionQuery.queryKey, session('alice', 'latest-token'));
      exactRetry();
      exactRetry();
    });
    expect(view.commands).toHaveLength(2);
    expect(view.commands.map(({ data }) => data)).toEqual([original, original]);
    expect(view.commands.map(({ token }) => token)).toEqual(['original-token', 'latest-token']);
    expect(currentInboxViewer(view.client)).toBe(owner);
    confirmed = true;
    await act(async () => {
      view.commands[1]!.work.resolve({ signedIn: true });
    });
    await tick();
    await act(async () => {
      for (const pending of view.countCalls) pending.resolve(count(2));
    });
    await tick();
    // All originally loaded pages reconcile, and post-attempt loads cannot join an exact retry.
    expect(view.rows()).toEqual([
      ['newest', 'false'],
      ['older', 'false'],
      ['oldest', 'false'],
      ['later-loaded', 'true'],
      ['unloaded-fourth', 'true'],
    ]);
    expect(view.host.textContent).toContain(m.inbox_triage_marked());
    await view.click(m.inbox_triage_filter_unread());
    expect(view.rows()).toEqual([
      ['later-loaded', 'true'],
      ['unloaded-fourth', 'true'],
    ]);
    expect(view.pageCalls.map(({ cursor }) => cursor)).toEqual([
      undefined,
      continuation,
      third,
      fourth,
      fourth,
      fourth,
    ]);
    expect(view.commands).toHaveLength(2);
  } finally {
    await view.close();
  }
});

test('a delayed access page cannot complete an old marker recovery after session retirement', async () => {
  for (const outcome of ['ready', 'denied'] as const) {
    const view = await screen();
    try {
      await view.click(m.inbox_triage_mark());
      await act(async () => view.commands[0]!.work.reject(new Error('unknown marker outcome')));
      await tick();
      const retry = view.retain(m.inbox_retry());
      const access = view.retain(m.inbox_check_access());
      view.hold();
      await view.click(m.inbox_check_access());
      await tick();
      const pending = view.pageCalls.at(-1)!.work!;
      expect(pending).toBeDefined();
      await act(async () => failedSession(view.client));
      await tick();
      expect(view.rows()).toEqual([]);
      view.resume();
      view.respond(() => ready(['fresh-owner'], null));
      await view.click(m.inbox_retry());
      await tick();
      const fresh = currentInboxViewer(view.client)!;
      const freshReads = view.pageCalls.length;
      const requests = sessionRequests;
      await act(async () => {
        pending.resolve(
          outcome === 'ready'
            ? ready(['obsolete-access'], null)
            : {
                signedIn: true,
                state: 'unavailable',
                failure: { status: 403, code: 'forbidden' },
              },
        );
        retry();
        access();
      });
      await tick();
      expect(view.rows()).toEqual([['fresh-owner', 'true']]);
      expect(view.host.textContent).not.toContain(m.inbox_seen_access_checked());
      expect(view.host.textContent).not.toContain(m.inbox_seen_access_unavailable());
      expect(view.host.textContent).not.toContain(m.inbox_seen_unavailable());
      expect(view.commands).toHaveLength(1);
      expect(view.pageCalls).toHaveLength(freshReads);
      expect(sessionRequests).toBe(requests);
      expect(view.client.getQueryState(inboxPageQuery(fresh).queryKey)?.isInvalidated).toBe(false);
    } finally {
      await view.close();
    }
  }
});

test('current page timestamp corrections retain exact shared ContentItem announcements and neutral rows', async () => {
  const view = await screen();
  try {
    const corrected = '2026-10-30T12:13:14.000Z';
    let createdAt = notice('linked').createdAt;
    const plainNotice = notice('plain');
    delete plainNotice.href;
    const response = (): InboxPage => ({
      signedIn: true,
      state: 'ready',
      next: null,
      items: [
        { ...notice('linked'), createdAt },
        plainNotice,
        {
          ...notice('hidden'),
          unavailable: true,
          text: 'must stay hidden',
          actorName: 'Private name',
          href: '/private',
        },
      ],
    });
    view.respond(response);
    const owner = currentInboxViewer(view.client)!;
    await act(async () => {
      await view.client.refetchQueries({ queryKey: inboxViewerQueryKey(owner) });
    });
    await tick();
    const row = () => view.host.querySelector<HTMLElement>('[data-notice-id="linked"]')!;
    const label = (date: string) =>
      [
        'Private reply linked',
        'Momo',
        m.inbox_kind_reply(),
        m.inbox_notice_unread(),
        new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(new Date(date)),
      ].join('. ');
    const original = row().querySelector('a')!.getAttribute('aria-label');
    expect(original).toBe(label(createdAt));
    await view.click(m.inbox_triage_mark());
    const attempt = { ...view.commands[0]!.data };
    await act(async () => view.commands[0]!.work.reject(new Error('unknown marker outcome')));
    await tick();
    createdAt = corrected;
    await act(async () => {
      await view.client.refetchQueries({ queryKey: inboxViewerQueryKey(owner) });
    });
    await tick();
    expect(currentInboxViewer(view.client)).toBe(owner);
    expect(row().getAttribute('data-slot')).toBe('list-row');
    expect(row().querySelectorAll('h2')).toHaveLength(1);
    expect(row().querySelector('h2')?.textContent).toBe('Private reply linked');
    expect(row().querySelectorAll('a')).toHaveLength(1);
    expect(row().querySelector('a')!.getAttribute('aria-label')).toBe(label(corrected));
    expect(row().querySelector('a')!.getAttribute('aria-label')).not.toBe(original);
    expect(row().querySelector('a')!.getAttribute('href')).toBe('/threads/thread#post-linked');
    expect(row().querySelector('time')!.getAttribute('datetime')).toBe(corrected);
    expect(row().querySelector('time')!.getAttribute('title')).toBe(
      new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }).format(
        new Date(corrected),
      ),
    );
    const plain = view.host.querySelector('[data-notice-id="plain"]')!;
    expect(plain.querySelector('a')).toBeNull();
    expect(plain.querySelector('time.sr-only')).not.toBeNull();
    const hidden = view.host.querySelector('[data-notice-id="hidden"]')!;
    expect(hidden.querySelector('a')).toBeNull();
    expect(hidden.textContent).toContain(m.inbox_unavailable_item());
    expect(hidden.textContent).not.toContain('must stay hidden');
    expect(hidden.textContent).not.toContain('Private name');
    expect(hidden.getAttribute('data-actor-id')).toBeNull();
    expect(view.commands).toHaveLength(1);
    await view.click(m.inbox_retry());
    expect(view.commands[1]!.data).toEqual(attempt);
  } finally {
    await view.close();
  }
});

test('continuation retry and restart callbacks retire before they can refetch or remove another epoch', async () => {
  const view = await screen();
  try {
    view.respond(() => ({
      signedIn: true,
      state: 'unavailable',
      failure: { status: 409, requestId: 'cursor-rejected' },
    }));
    await view.click(m.inbox_load_more());
    await tick();
    expect(view.rows()).toEqual([]);
    expect(view.host.querySelector('[data-response-status="409"]')).not.toBeNull();
    const retry = view.retain(m.inbox_retry());
    const restart = view.retain(m.inbox_start_first_page());
    view.respond(() => ready(['fresh-first'], null));
    await act(async () => {
      view.client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
      view.client.setQueryData(sessionQuery.queryKey, session());
      retry();
      restart();
    });
    await tick();
    const fresh = currentInboxViewer(view.client)!;
    const key = inboxPageQuery(fresh).queryKey;
    const installed = view.client.getQueryData(key);
    const countBefore = view.pageCalls.length;
    await act(async () => {
      retry();
      restart();
    });
    await tick();
    expect(view.pageCalls).toHaveLength(countBefore);
    expect(view.client.getQueryData(key)).toBe(installed);
    expect(view.rows()).toEqual([['fresh-first', 'true']]);
  } finally {
    await view.close();
  }
});

test('refreshing a successful continuation retires older pages and preserves an uncertain seen command', async () => {
  const view = await screen();
  try {
    await view.click(m.inbox_load_more());
    await tick();
    expect(view.rows()).toEqual([
      ['newest', 'true'],
      ['older', 'true'],
      ['oldest', 'true'],
    ]);
    await view.click(m.inbox_triage_mark());
    const original = { ...view.commands[0]!.data };
    await act(async () => view.commands[0]!.work.reject(new Error('response lost')));
    await tick();
    expect(view.host.textContent).toContain(m.inbox_seen_unknown());
    const retiredKey = inboxPageQuery(currentInboxViewer(view.client)!, third).queryKey;
    view.client.setQueryData(retiredKey, ready(['retired-page'], null));
    view.respond((cursor) => (cursor ? ready(['older', 'oldest'], null) : ready(['arrival', 'newest'], continuation)));
    await view.click(m.inbox_start_first_page());
    await tick();
    expect(view.rows()).toEqual([
      ['arrival', 'true'],
      ['newest', 'true'],
    ]);
    expect(view.client.getQueryData(retiredKey)).toBeUndefined();
    expect(view.commands).toHaveLength(1);
    await view.click(m.inbox_seen_retry());
    expect(view.commands[1]!.data).toEqual(original);
    await act(async () => view.commands[1]!.work.reject(new Error('response lost again')));
    await tick();
  } finally {
    await view.close();
  }
});

test('unmount and StrictMode churn share one viewer, retire callbacks and ignore held access completions', async () => {
  const view = await screen(true);
  try {
    const owner = currentInboxViewer(view.client)!;
    expect(owner.isCurrent()).toBe(true);
    await view.render();
    await tick();
    expect(currentInboxViewer(view.client)).toBe(owner);
    await view.click(m.inbox_triage_mark());
    await act(async () => view.commands[0]!.work.reject(new Error('response lost')));
    await tick();
    const access = view.retain(m.inbox_check_access());
    const retry = view.retain(m.inbox_retry());
    view.hold();
    await view.click(m.inbox_check_access());
    await tick();
    const held = view.pageCalls.at(-1)!.work!;
    expect(held).toBeDefined();
    // Keep the badge mounted: page activity must be checked independently of shared viewer authority.
    await view.render(false, true);
    await tick();
    expect(owner.isCurrent()).toBe(true);
    const before = { pages: view.pageCalls.length, sessions: sessionRequests };
    await act(async () => {
      access();
      retry();
      held.resolve(ready(['unmounted-access'], null));
    });
    await tick();
    expect(sessionRequests).toBe(before.sessions);
    expect(view.pageCalls).toHaveLength(before.pages);
    expect(view.commands).toHaveLength(1);
    expect(view.host.textContent).not.toContain(m.inbox_seen_access_checked());
    await view.render(false, false);
    await tick();
    expect(owner.isCurrent()).toBe(false);
    view.resume();
    await view.render();
    await tick();
    expect(currentInboxViewer(view.client)).not.toBe(owner);
    expect(view.rows()).toEqual([['newest', 'true']]);
    expect(view.host.textContent).not.toContain('unmounted-access');
  } finally {
    await view.close();
  }
});

test('a live imperative viewer observes losses without UI subscribers and shared observers dispose monotonically', async () => {
  const client = new QueryClient();
  const cache = client.getQueryCache();
  const originalSubscribe = cache.subscribe.bind(cache);
  let observations = 0;
  const observation = spyOn(cache, 'subscribe').mockImplementation((listener) => {
    observations++;
    const release = originalSubscribe(listener);
    return () => {
      observations--;
      release();
    };
  });
  try {
    const store = inboxViewerStore(client);
    client.setQueryData(sessionQuery.queryKey, session());
    const original = store.snapshot()!;
    expect(observations).toBe(1);
    const offA = store.subscribe(() => {});
    const offB = store.subscribe(() => {});
    expect(observations).toBe(1);
    offA();
    offB();
    const reconnect = store.subscribe(() => {});
    await Promise.resolve();
    expect(store.snapshot()).toBe(original);
    expect(observations).toBe(1);
    reconnect();
    await Promise.resolve();
    expect(original.isCurrent()).toBe(false);
    expect(observations).toBe(0);
    // The imperative API has no React subscription, yet must see every intervening loss.
    for (const loss of ['error', 'removed', 'unavailable'] as const) {
      client.setQueryData(sessionQuery.queryKey, session());
      const owner = store.snapshot()!;
      expect(observations).toBe(1);
      const pageWork = deferred<string>();
      const failedWork = deferred<string>();
      const late = forInboxViewer(owner, () => pageWork.promise).catch((error: Error) => error.name);
      const lateFailure = forInboxViewer(owner, () => failedWork.promise).catch((error: Error) => error.name);
      if (loss === 'error') await failedSession(client);
      else if (loss === 'removed') client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
      else client.setQueryData<unknown>(sessionQuery.queryKey, { state: 'unavailable' });
      client.setQueryData(sessionQuery.queryKey, session());
      expect(owner.isCurrent()).toBe(false);
      const fresh = store.snapshot()!;
      expect(fresh.epoch).toBeGreaterThan(owner.epoch);
      expect(observations).toBe(1);
      pageWork.resolve('obsolete private result');
      failedWork.reject(new Error('obsolete transport error'));
      expect(await late).toBe('AbortError');
      expect(await lateFailure).toBe('AbortError');
      let sends = 0;
      await expect(
        markInboxViewerSeen(client, owner, { through: 'old', idempotencyKey: 'old-key' }, 'token', async () => {
          sends++;
          return { signedIn: true };
        }),
      ).rejects.toThrow('Inbox viewer changed');
      expect(sends).toBe(0);
      expect(inboxPageQuery(owner).enabled).toBe(false);
      expect(unreadCountQueryFor(owner).enabled).toBe(false);
      expect(inboxViewerQueryKey(fresh)).not.toEqual(inboxViewerQueryKey(owner));
      // Existing invalidation consumers still own the unchanged prefix.
      const countKey = unreadCountQueryFor(fresh).queryKey;
      client.setQueryData(countKey, count(2));
      await client.invalidateQueries({ queryKey: unreadCountQuery.queryKey });
      expect(client.getQueryState(countKey)?.isInvalidated).toBe(true);
    }
  } finally {
    client.clear();
    expect(observations).toBe(0);
    observation.mockRestore();
  }
});
