import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import recording from '../src/kernel/recorded/library-continue-progress-sessions.json';
import type { NativeContinuePage } from '../src/library/continue-adapter';
import type { ContinueResult, ContinueView } from '../src/library/continue-source';

// UNRUN: mounted presentation regressions. DOM geometry is not physical layout proof;
// the connected stories carry future browser target, focus and overflow assertions.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/continue' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
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
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { ContinueSection, useContinueRefresh } = await import('../src/library/continue');
const { nativeContinueSource, presentContinuePage } = await import('../src/library/continue-adapter');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const oldLocale = getLocale();
setLocale('en', { reload: false });
const incidentalFetch = spyOn(globalThis, 'fetch').mockRejectedValue(
  new Error('Supplied Continue presentation must not fetch'),
);

const page: NativeContinuePage = {
  subjects: recording.progressSessions.map(({ subject, ...session }, index) => {
    const { mode, state } = session;
    if (mode !== 'scalar_amount' && mode !== 'cursor_position' && mode !== 'completed_units')
      throw new Error('Unknown recorded mode');
    if (state !== 'active') throw new Error('Expected active recorded session');
    return {
      subjectId: session.subjectId,
      state: null,
      lastActivityAt: session.startedAt,
      subject,
      activeProgressSession: {
        ...session,
        mode,
        state,
        ...(index === 0 ? { completedUnitCount: 0 } : {}),
        ...(index === 1 ? { amount: '999999999999.123456', total: null } : {}),
      },
    };
  }),
  next: 'opaque+/next==?&cursor=unchanged',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
type Props = {
  initial: ContinueView;
  read: () => Promise<ContinueResult>;
  scope: string;
  destination?: boolean;
  busy?: boolean;
};
let refresh: ReturnType<typeof useContinueRefresh>['refresh'];
function Reader({ initial, read, scope, destination, busy }: Props) {
  const current = useContinueRefresh(initial, read, scope);
  refresh = current.refresh;
  return (
    <ContinueSection
      state={current.result}
      locale="en"
      destination={destination ?? false}
      onRetry={() => void current.refresh()}
      busy={busy ?? current.busy}
    />
  );
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  expect(incidentalFetch).not.toHaveBeenCalled();
  incidentalFetch.mockClear();
});
afterAll(async () => {
  setLocale(oldLocale, { reload: false });
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(props: Props) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: 'original-csrf' });
  const lifetime = viewerExposureLifetime(client);
  const stop = lifetime.subscribe(() => {});
  const admission = lifetime.getSnapshot();
  if (admission.state !== 'signed-in') throw new Error('Expected current prepared viewer');
  client.setQueryData(viewerExposureQuery(admission.observation).queryKey, {
    subject: 'owner',
    admitted: ['personal_library', 'reading_progress'],
  });
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library/continue'] }),
  });
  await router.load();
  const show = async (next: Props = props) => {
    props = next;
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            <Reader {...props} />
          </RouterContextProvider>
        </QueryClientProvider>,
      ),
    );
  };
  await show();
  let mounted = true;
  const close = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    stop();
    client.clear();
    host.remove();
  };
  cleanups.push(close);
  return { host, show, close };
}
function navigation(host: HTMLElement, text: string) {
  const link = [...host.querySelectorAll('a')].find((link) => link.textContent === text);
  if (!link) throw new Error(`Missing navigation: ${text}`);
  return link;
}
function retry(host: HTMLElement) {
  const button = [...host.querySelectorAll('button')].find((button) => button.textContent === m.library_follow_retry());
  if (!button) throw new Error('Missing current recovery control');
  return button;
}
function targetPolicy(control: HTMLElement) {
  expect(control.classList.contains('min-h-11')).toBe(true);
  expect(control.classList.contains('focus-visible:outline-2')).toBe(true);
  expect(control.classList.contains('focus-visible:outline-offset-2')).toBe(true);
}

test('real Continue retains FULL order, historical decimals, literal zero, original session links and opaque navigation without render/focus reads', async () => {
  const calls: Request[] = [];
  const kernel = createKernelClient('https://kernel.example.test', {
    async fetch(input, init) {
      calls.push(new Request(input, init));
      return Response.json(page);
    },
  });
  const read = () => nativeContinueSource(kernel, 'Bearer original-owner', { limit: 6 });
  const initial = await read();
  const ui = await mount({ initial, read, scope: 'owner:first' });
  const titles = [...ui.host.querySelectorAll<HTMLAnchorElement>('[data-slot="cover-card-title"]')];
  expect(titles.map((title) => title.textContent)).toEqual(page.subjects.map((row) => row.subject!.label!.value));
  expect(titles.map((title) => title.getAttribute('href'))).toEqual(
    page.subjects.map((row) => `/en/library/progress/${encodeURIComponent(row.activeProgressSession!.id)}`),
  );
  expect(ui.host.textContent).toContain('999,999,999,999.123456');
  expect([...ui.host.querySelectorAll('[data-slot="cover-card-state"]')].some((node) => node.textContent === '0')).toBe(
    true,
  );
  expect(ui.host.textContent).not.toContain('%');
  const more = navigation(ui.host, m.library_more());
  targetPolicy(more);
  expect(more.getAttribute('href')).toBe('/en/library/continue');
  const followed: string[] = [];
  ui.host.addEventListener('click', (event) => {
    const link = (event.target as Element).closest('a');
    if (link) {
      followed.push(link.getAttribute('href')!);
      event.preventDefault();
    }
  });
  await act(async () => {
    more.focus();
    more.click();
  });
  expect(document.activeElement).toBe(more);
  await ui.show({ initial, read, scope: 'owner:first', destination: true });
  expect(ui.host.querySelector('h2')).toBeNull();
  const next = navigation(ui.host, m.library_next_page());
  targetPolicy(next);
  expect(next.getAttribute('href')).toBe(`/en/library/continue?cursor=${encodeURIComponent(page.next!)}`);
  await act(async () => {
    next.focus();
    next.click();
    window.dispatchEvent(new window.Event('resize'));
  });
  expect(document.activeElement).toBe(next);
  expect(followed).toEqual(['/en/library/continue', `/en/library/continue?cursor=${encodeURIComponent(page.next!)}`]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer original-owner');
  expect([...new URL(calls[0]!.url).searchParams]).toEqual([
    ['limit', '6'],
    ['view', 'FULL'],
  ]);
});

test('actual row controls keep scroll operands and unavailable/disabled tab semantics outside the cards', async () => {
  const read = mock(async () => presentContinuePage(page));
  const ui = await mount({ initial: presentContinuePage(page), read, scope: 'row' });
  const row = ui.host.querySelector<HTMLElement>('[data-slot="cover-row"]')!;
  const buttons = [m.home_continue_previous(), m.home_continue_next()].map((name) =>
    ui.host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!,
  );
  const [back, forward] = buttons as [HTMLButtonElement, HTMLButtonElement];
  for (const button of buttons) {
    targetPolicy(button);
    expect(button.classList.contains('min-w-11')).toBe(true);
    expect(button.classList.contains('pointer-fine:flex')).toBe(true);
    expect(button.classList.contains('pointer-coarse:hidden')).toBe(true);
    expect(row.contains(button)).toBe(false);
    expect(row.nextElementSibling?.contains(button)).toBe(true);
  }
  expect(back.disabled).toBe(true);
  expect(back.tabIndex).toBe(-1);
  expect(back.getAttribute('aria-hidden')).toBe('true');
  // Geometry supplies scroll availability only, never a physical target/layout assertion.
  Object.defineProperties(row, { clientWidth: { value: 240 }, scrollWidth: { value: 720 } });
  const scrollBy = mock(() => {});
  Object.defineProperty(row, 'scrollBy', { value: scrollBy });
  await act(async () => row.dispatchEvent(new window.Event('scroll')));
  expect(forward.disabled).toBe(false);
  expect(forward.tabIndex).toBe(0);
  await act(async () => {
    forward.focus();
    forward.click();
    row.scrollLeft = 240;
    row.dispatchEvent(new window.Event('scroll'));
  });
  expect(back.disabled).toBe(false);
  expect(back.getAttribute('aria-hidden')).toBe('false');
  await act(async () => back.click());
  expect(scrollBy.mock.calls).toEqual([[{ left: 240, behavior: 'smooth' }], [{ left: -240, behavior: 'smooth' }]]);
  expect(read).not.toHaveBeenCalled();
});

test('retry uses the current callback, withholds pending data and retires late results and retained callbacks', async () => {
  const pending = deferred<ContinueResult>();
  const oldRead = mock(async () => presentContinuePage(page));
  const currentRead = mock(() => pending.promise);
  const initial: ContinueView = { state: 'unavailable', status: 503 };
  const ui = await mount({ initial, read: oldRead, scope: 'old-cursor', destination: true });
  expect(ui.host.querySelector('[role="alert"]')?.textContent).toBe(m.library_continue_unavailable());
  const button = retry(ui.host);
  targetPolicy(button);
  expect(button.classList.contains('h-auto')).toBe(true);
  expect(button.classList.contains('whitespace-normal')).toBe(true);
  await ui.show({ initial, read: currentRead, scope: 'old-cursor', destination: true });
  await act(async () => {
    button.focus();
  });
  expect(currentRead).not.toHaveBeenCalled();
  await act(async () => button.click());
  expect(oldRead).not.toHaveBeenCalled();
  expect(currentRead).toHaveBeenCalledTimes(1);
  expect(ui.host.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(ui.host.querySelector('[role="status"]')?.textContent).toBe(m.library_continue_loading());
  expect(ui.host.querySelector('a')).toBeNull();
  const retired = refresh;
  const replacement: ContinueView = { state: 'loaded', entries: [], next: null };
  await ui.show({ initial: replacement, read: oldRead, scope: 'new-cursor', destination: true });
  await act(async () => pending.resolve(presentContinuePage(page)));
  expect(ui.host.querySelector('[role="status"]')?.textContent).toBe(m.library_continue_empty());
  expect(ui.host.querySelector('[data-slot="cover-card"]')).toBeNull();
  expect(ui.host.querySelector('a')).toBeNull();
  await act(async () => {
    await retired();
  });
  expect(currentRead).toHaveBeenCalledTimes(1);
  const unmounted = refresh;
  await ui.close();
  await unmounted();
  expect(oldRead).not.toHaveBeenCalled();
});

test('current recovery reads one FULL page with its original opaque cursor and credential', async () => {
  const calls: Request[] = [];
  const kernel = createKernelClient('https://kernel.example.test', {
    async fetch(input, init) {
      calls.push(new Request(input, init));
      return Response.json(page);
    },
  });
  const cursor = 'original+/cursor==?&';
  const read = () => nativeContinueSource(kernel, 'Bearer current-owner', { limit: 6, cursor });
  const ui = await mount({ initial: { state: 'unavailable' }, read, scope: cursor, destination: true });
  await act(async () => retry(ui.host).click());
  expect(ui.host.querySelector('section')?.getAttribute('data-continue-state')).toBe('loaded');
  expect(ui.host.querySelector('[role="alert"]')).toBeNull();
  const next = navigation(ui.host, m.library_next_page());
  await act(async () => next.focus());
  expect(calls).toHaveLength(1);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer current-owner');
  expect([...new URL(calls[0]!.url).searchParams]).toEqual([
    ['limit', '6'],
    ['view', 'FULL'],
    ['cursor', cursor],
  ]);
});

test('loading, empty, denied and signed-out presentations stay distinct without automatic recovery reads', async () => {
  const read = mock(async () => presentContinuePage(page));
  const ui = await mount({ initial: { state: 'unknown' }, read, scope: 'loading' });
  expect(ui.host.querySelector('[role="status"]')?.textContent).toBe(m.library_continue_loading());
  expect(ui.host.querySelector('[aria-busy="true"]')).not.toBeNull();
  await ui.show({ initial: { state: 'loaded', entries: [], next: null }, read, scope: 'empty' });
  expect(ui.host.querySelector('[role="status"]')?.textContent).toBe(m.library_continue_empty());
  await ui.show({ initial: { state: 'denied', status: 403 }, read, scope: 'denied' });
  expect(ui.host.querySelector('[role="status"]')?.textContent).toBe(m.library_continue_denied());
  expect(ui.host.querySelector('button')).toBeNull();
  await ui.show({ initial: { state: 'signed-out' }, read, scope: 'signed-out' });
  expect(ui.host.querySelector('section')).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

test('preparing remains honest after two bounded retries and busy recovery cannot start a read', async () => {
  const timers = new Map<number, () => void>();
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let nextId = -1;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((run, delay, ...args) => {
    if (delay !== 30_000) return originalTimeout(run, delay, ...args);
    const id = nextId--;
    timers.set(id, () => run(...args));
    return id;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id) => {
    if (!timers.delete(Number(id))) originalClear(id);
  }) as typeof clearTimeout);
  const read = mock(async (): Promise<ContinueResult> => ({ state: 'preparing', retryAfter: 600 }));
  try {
    const initial: ContinueView = { state: 'preparing', retryAfter: 600 };
    const ui = await mount({ initial, read, scope: 'bounded', busy: true });
    const button = retry(ui.host);
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(read).not.toHaveBeenCalled();
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect(timers.size).toBe(1);
      const [id, run] = [...timers][0]!;
      timers.delete(id);
      await act(async () => run());
      expect(read).toHaveBeenCalledTimes(attempt);
    }
    expect(timers.size).toBe(0);
    expect(ui.host.querySelector('[role="status"]')?.textContent).toBe(m.library_continue_preparing());
    expect(ui.host.textContent).not.toContain(m.library_continue_empty());
    await ui.close();
  } finally {
    timer.mockRestore();
    clear.mockRestore();
  }
});
