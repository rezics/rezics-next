import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createContext, useContext } from 'react';
import * as start from '../.storybook/react-start';
import recording from '../src/kernel/recorded/library-published-logs.json';
import type { MyLogsPage } from '../src/library/my-logs';
import type { MyLogsViewerHistory } from '../src/library/logs-server';

// UNRUN: real mounted presentation/current-viewer regressions. DOM geometry is not layout proof.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/fr/library/logs' });
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
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
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
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useSearch } =
  await import('@tanstack/react-router');
const { MyLogsPageView, MyLogsCurrentViewer } = await import('../src/library/my-logs-page');
const { myLogsSearch } = await import('../src/library/my-logs');
const server = await import('../src/library/logs-server');
const { subjectOf } = await import('../src/library/reads');
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale, localizeUrl, deLocalizeUrl } = await import('../src/paraglide/runtime.js');
const { fullDateTime } = await import('../src/threads/byline');
const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
const user = userEvent.setup({ document: window.document });
afterAll(async () => {
  mock.restore();
  setLocale('en', { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const cursor = 'native/+?q=原文#% &==';
const next = 'next/+?q=次#% &==';
const recorded = recording.publishedLogs[0]!;
const logs = [
  { ...recorded, subject: subjectOf(recorded.subject), note: `0\n${'Full original note. '.repeat(45)}` },
  {
    ...recorded,
    id: '01a17a3b-70dd-709a-b040-f4cc8099977c',
    sessionState: 'completed' as const,
    completedAt: '2026-10-27T09:00:00.000Z',
    publishedAt: '2026-10-27T09:05:00.000Z',
    subject: subjectOf(recorded.subject),
    note: 'Second note\n0',
  },
];
const loaded: MyLogsPage = { state: 'loaded', logs, next, restarted: false };
const viewer = (subject: string) => ({ state: 'signed-in', subject, csrfToken: `csrf-${subject}` });
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function settle(action: () => unknown) {
  await act(async () => {
    action();
    await tick();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

async function mount(currentViewer = false) {
  setLocale('fr', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, viewer('A'));
  client.setQueryData(['exposure', 'anonymous'], []);
  const lifetime = viewerExposureLifetime(client);
  const keep = lifetime.subscribe(() => {});
  const admit = (admitted = ['reading_progress']) => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('Expected actual viewer observation');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject: snapshot.observation.subject,
      admitted,
    });
  };
  admit();
  let live = true;
  let retries = 0;
  const onRetry = () => retries++;
  const initial: MyLogsViewerHistory = {
    sessionSubject: null,
    cursor: null,
    locale: 'fr',
    page: { state: 'unavailable' },
  };
  const Props = createContext<{ page: MyLogsPage; retry: (() => void) | undefined }>({ page: loaded, retry: onRetry });
  function Page() {
    const props = useContext(Props);
    const search = useSearch({ strict: false }) as { cursor?: string };
    return currentViewer ? (
      <MyLogsCurrentViewer initial={initial} cursor={search.cursor} />
    ) : (
      <MyLogsPageView
        page={props.page}
        cursor={search.cursor}
        onRetry={props.retry}
        origin={{ lifetime: initial, isCurrent: () => live }}
      />
    );
  }
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/logs',
    validateSearch: myLogsSearch,
    component: Page,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/fr/library/logs'] }),
    parseSearch: (value) => Object.fromEntries(new URLSearchParams(value)),
    stringifySearch: (value) => {
      const query = new URLSearchParams(value as Record<string, string>).toString();
      return query ? `?${query}` : '';
    },
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const show = (page: MyLogsPage, retry: (() => void) | null = onRetry) =>
    settle(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Props.Provider value={{ page, retry: retry ?? undefined }}>
            <RouterProvider router={router} />
          </Props.Provider>
        </QueryClientProvider>,
      ),
    );
  await router.load();
  await show(loaded);
  return {
    host,
    client,
    router,
    show,
    admit,
    retries: () => retries,
    retire: () => {
      live = false;
    },
    resume: () => {
      live = true;
    },
    link: (label: string) => [...host.querySelectorAll('a')].find((item) => item.textContent === label)!,
    address: (value?: string) =>
      act(async () => {
        await router.navigate({ to: '/library/logs', search: value ? { cursor: value } : {} });
        await tick();
      }),
    close: async () => {
      await act(async () => root.unmount());
      keep();
      client.clear();
      host.remove();
    },
  };
}

function target(control: HTMLElement) {
  // Assert the actual element's local sizing/focus policy, never Happy DOM's zero layout bounds.
  for (const name of ['min-h-11', 'max-w-full', 'whitespace-normal', 'focus-visible:outline-2'])
    expect(control.classList.contains(name)).toBe(true);
}

test('More and Newest keep exact localized opaque destinations, keyboard activation, retirement and immutable full-note rows', async () => {
  const incidental = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected presentation IO'));
  const page = await mount();
  try {
    await page.address(cursor);
    const rows = [...page.host.querySelectorAll('ol > li')];
    expect(rows).toHaveLength(2);
    for (const [index, log] of logs.entries()) {
      const row = rows[index]!;
      expect([...row.querySelectorAll('time')].map((time) => time.dateTime)).toEqual([
        log.publishedAt,
        log.startedAt,
        ...(log.completedAt ? [log.completedAt] : []),
      ]);
      expect(row.querySelector('details > p')?.textContent).toBe(log.note);
      expect(row.querySelector('[data-content-item-slot="state"]')?.textContent).toBe(
        `${m.library_logs_session_state()}: ${index === 0 ? m.library_progress_state_active() : m.library_progress_state_completed()}`,
      );
      expect([...row.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
        `/fr/logs/${encodeURIComponent(log.id)}`,
      ]);
      expect(row.querySelector('a')?.getAttribute('aria-label')).toBe(
        m.library_my_logs_read({
          title: row.querySelector('h2')!.textContent!,
          date: fullDateTime(log.publishedAt, 'fr'),
        }),
      );
      expect(row.querySelector('a a, a button, a summary, summary a, [role="progressbar"]')).toBeNull();
    }
    const details = rows[1]!.querySelector('details')!;
    rows[1]!.querySelector<HTMLElement>('a')!.focus();
    await act(async () => user.tab({ shift: true }));
    expect(document.activeElement).toBe(details.querySelector('summary'));
    await act(async () => user.click(details.querySelector('summary')!));
    await page.show({ ...loaded, state: 'loaded', logs: [logs[1]!, logs[0]!] });
    expect(page.host.querySelector('ol > li')).toBe(rows[1]);
    expect(details.open).toBe(true);
    expect(details.querySelector('p')?.textContent).toBe(logs[1]!.note);
    const more = page.link(m.library_logs_more());
    const newest = page.link(m.library_my_logs_newest());
    expect(more.getAttribute('href')).toBe(`/fr/library/logs?${new URLSearchParams({ cursor: next })}`);
    expect(newest.getAttribute('href')).toBe('/fr/library/logs');
    expect([...more.parentElement!.querySelectorAll('a')]).toEqual([more, newest]);
    expect(more.parentElement!.classList.contains('flex-wrap')).toBe(true);
    for (const control of [more, newest]) target(control);
    page.retire();
    for (const control of [more, newest]) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      await settle(() => control.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    }
    expect(page.router.state.location.search.cursor).toBe(cursor);
    page.resume();
    await settle(() => page.admit([]));
    expect(page.host.querySelectorAll('ol a')).toHaveLength(0);
    expect(page.link(m.library_logs_more())).toBeUndefined();
    expect(details.open).toBe(true);
    await settle(() => page.admit());
    page.link(m.library_logs_more()).focus();
    await act(async () => {
      await user.keyboard('{Enter}');
      await tick();
    });
    expect(page.router.state.location.search.cursor).toBe(next);
    page.link(m.library_my_logs_newest()).focus();
    await act(async () => {
      await user.keyboard('{Enter}');
      await tick();
    });
    expect(page.router.state.location.search).toEqual({});
    expect(page.router.state.location.publicHref).toBe('/fr/library/logs');
    await settle(() => window.dispatchEvent(new Event('resize')));
    expect(incidental).toHaveBeenCalledTimes(0);
  } finally {
    await page.close();
    incidental.mockRestore();
  }
});

test('first-page empty, zero-row later pages, restart, failures and signed-out recovery retain distinct meanings', async () => {
  const page = await mount();
  const empty: MyLogsPage = { state: 'loaded', logs: [], next: null, restarted: false };
  try {
    await page.show(empty);
    expect(page.host.textContent).toContain(m.library_logs_empty());
    expect(page.link(m.library_my_logs_newest())).toBeUndefined();
    await page.address(cursor);
    expect(page.host.textContent).toContain(m.library_my_logs_no_visible());
    expect(page.host.textContent).not.toContain(m.library_logs_empty());
    target(page.link(m.library_my_logs_newest()));
    page.link(m.library_my_logs_newest()).focus();
    await act(async () => {
      await user.keyboard('{Enter}');
      await tick();
    });
    expect(page.router.state.location.search).toEqual({});
    expect(page.host.textContent).toContain(m.library_logs_empty());
    await page.address(cursor);
    await page.show({ ...empty, state: 'loaded', next });
    target(page.link(m.library_logs_more()));
    await page.show({ ...empty, state: 'loaded', restarted: true });
    expect(page.host.querySelector('[role="status"]')?.textContent).toBe(m.library_my_logs_restarted());
    expect(page.host.textContent).toContain(m.library_logs_empty());
    target(page.link(m.library_my_logs_newest()));
    await page.show({ ...empty, state: 'loaded', restarted: true, next });
    expect(page.host.textContent).toContain(m.library_my_logs_no_visible());
    await page.address();
    await page.show({ ...empty, state: 'loaded', next });
    expect(page.host.textContent).toContain(m.library_my_logs_no_visible());
    expect(page.link(m.library_my_logs_newest())).toBeUndefined();
    for (const [state, message] of [
      ['unavailable', m.library_my_logs_unavailable()],
      ['denied', m.library_my_logs_denied()],
      ['preparing', m.library_my_logs_preparing()],
    ] as const) {
      await page.show({ state });
      expect(page.host.querySelector(`[role="${state === 'preparing' ? 'status' : 'alert'}"]`)?.textContent).toBe(
        message,
      );
      expect(page.host.textContent).not.toContain(m.library_logs_empty());
      const retry = page.host.querySelector('button')!;
      target(retry);
      expect(retry.classList.contains('h-auto')).toBe(true);
      retry.focus();
      await act(async () => user.keyboard('{Enter}'));
    }
    expect(page.retries()).toBe(3);
    await settle(() => window.dispatchEvent(new Event('resize')));
    expect(page.retries()).toBe(3);
    await page.show({ state: 'unavailable' }, null);
    expect(page.host.querySelector('button')).toBeNull();
    await page.show({ state: 'signed-out' });
    const signIn = page.link(m.library_my_logs_sign_in());
    target(signIn);
    const expected = '/auth/sign-in?return_to=%2Ffr%2Flibrary%2Flogs';
    expect(signIn.getAttribute('href')).toBe(expected);
    let activated = '';
    signIn.addEventListener('click', (event) => {
      event.preventDefault();
      activated = signIn.getAttribute('href')!;
    });
    signIn.focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(activated).toBe(expected);
    expect(page.host.querySelector('ol, button, [role="alert"]')).toBeNull();
    expect(page.retries()).toBe(3);
  } finally {
    await page.close();
  }
});

test('retry and navigation presentation add no reads and retire late results across actual viewer replacement and ABA', async () => {
  const reads: (ReturnType<typeof deferred<MyLogsViewerHistory>> & { cursor: string | null })[] = [];
  const read = spyOn(server, 'readMyPublishedLogHistoryForViewer').mockImplementation(({ data }) => {
    const call = { ...deferred<MyLogsViewerHistory>(), cursor: data.cursor ?? null };
    reads.push(call);
    return call.promise;
  });
  const incidental = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected presentation IO'));
  const page = await mount(true);
  const result = (subject: string, nextCursor = next): MyLogsViewerHistory => ({
    sessionSubject: subject,
    cursor: null,
    locale: 'fr',
    page: {
      ...loaded,
      state: 'loaded',
      next: nextCursor,
      logs: logs.map((log) => ({
        ...log,
        note: `${subject}: ${log.note}`,
        subject: { ...log.subject!, label: `${subject} published history` },
      })),
    },
  });
  try {
    expect(reads).toHaveLength(1);
    await settle(() =>
      reads[0]!.resolve({ sessionSubject: null, cursor: null, locale: 'fr', page: { state: 'unavailable' } }),
    );
    const retry = page.host.querySelector('button')!;
    target(retry);
    retry.focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(reads).toHaveLength(2);
    const retiredA = reads[1]!;
    await settle(() => {
      page.client.setQueryData(sessionQuery.queryKey, viewer('B'));
      page.admit();
    });
    expect(page.host.querySelector('ol, button')).toBeNull();
    expect(page.link(m.library_logs_more())).toBeUndefined();
    expect(reads).toHaveLength(3);
    await settle(() => reads[2]!.resolve(result('B')));
    expect(page.host.textContent).toContain('B published history');
    await settle(() => retiredA.resolve(result('A', 'retired-A')));
    expect(page.link(m.library_logs_more()).getAttribute('href')).toBe(
      `/fr/library/logs?${new URLSearchParams({ cursor: next })}`,
    );
    expect(page.host.innerHTML).not.toContain('retired-A');
    expect(page.host.textContent).not.toContain('A published history');
    const count = reads.length;
    await act(async () => user.click(page.host.querySelector('summary')!));
    page.link(m.library_logs_more()).focus();
    await act(async () => user.tab());
    await settle(() => window.dispatchEvent(new Event('resize')));
    expect(reads).toHaveLength(count);
    await settle(() => page.client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null }));
    expect(page.host.querySelector('ol, button')).toBeNull();
    expect(page.link(m.library_my_logs_sign_in()).getAttribute('href')).toBe(
      '/auth/sign-in?return_to=%2Ffr%2Flibrary%2Flogs',
    );
    await settle(() => {
      page.client.setQueryData(sessionQuery.queryKey, viewer('A'));
      page.admit();
    });
    const abaA = reads.at(-1)!;
    await settle(() => {
      page.client.setQueryData(sessionQuery.queryKey, viewer('B'));
      page.admit();
    });
    const freshB = reads.at(-1)!;
    expect(freshB).not.toBe(abaA);
    await settle(() => abaA.resolve(result('A')));
    expect(page.host.querySelector('ol')).toBeNull();
    await settle(() => freshB.resolve(result('B')));
    expect(page.host.textContent).toContain('B published history');
    expect(page.host.querySelectorAll('ol > li')).toHaveLength(logs.length);
    expect(reads.every((call) => call.cursor === null)).toBe(true);
    expect(incidental).toHaveBeenCalledTimes(0);
  } finally {
    await page.close();
    read.mockRestore();
    incidental.mockRestore();
  }
});
