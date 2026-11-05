import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { ManagementWindow } from '../src/accounts/management/window';
import { readManagementWindow, useManagementWindow } from '../src/accounts/management/window-route';
import { readCursors, type Cursors, type Detail, type Inventory, type Page } from '../src/accounts/management/data';
import { AccountManagementPage, ManagedAccountsPage } from '../src/accounts/management/pages';
import { detailExample, inventoryExample, organization } from '../src/accounts/management/story-api';
import { browserObservation } from '../src/session';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

test('admitted coordinate history is independent, bounded and never invents a direct-address predecessor', () => {
  const history = new ManagementWindow({ organizationsCursor: 'direct', operatorsCursor: 'other' });
  expect(history.previous('organizationsCursor')).toBeUndefined();
  let address: Cursors = { organizationsCursor: 'direct', operatorsCursor: 'other' };
  for (let index = 0; index < 12; index++) {
    address = history.request('organizationsCursor', `${index}`.padEnd(4096, 'x'), 'next', address);
    history.admit(address, () => true);
  }
  for (let index = 11; index > 3; index--) {
    const cursor = history.previous('organizationsCursor')!.cursor;
    expect(cursor).toBe(`${index - 1}`.padEnd(4096, 'x'));
    address = history.request('organizationsCursor', cursor, 'previous', address);
    history.admit(address, () => true);
    expect(address.operatorsCursor).toBe('other');
  }
  expect(history.previous('organizationsCursor')).toBeUndefined();
  expect(readCursors({ membersCursor: 'x'.repeat(4097) })).toEqual({});
  history.retire();
  expect(history.previous('operatorsCursor')).toBeUndefined();
});

test('mounted router windows reread exact native targets, retain failed movements and fence private readers', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/accounts' });
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
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const locale = getLocale();
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = (subject: string, csrfToken = subject) =>
    client.setQueryData(['session'], { state: 'signed-in', subject, csrfToken });
  session('A');
  const stop = browserObservation(client).subscribe(() => {});
  const calls: Cursors[] = [];
  const signals: AbortSignal[] = [];
  let fail: boolean | 'signed-out' = false;
  let release: ((page: Page<Inventory | Detail>) => void) | undefined;
  let defer = false;
  let transition: Promise<unknown> = Promise.resolve();
  const ready = (detail: boolean, cursors: Cursors): Page<Inventory | Detail> => {
    const value = detail ? detailExample(organization.id) : inventoryExample();
    value.responsibilities!.next = cursors.operatorsCursor ? 'operator-3' : 'operator +/=?& 2';
    if ('organizations' in value)
      value.organizations = { state: 'ready', items: [], next: cursors.organizationsCursor ? 'org-3' : 'org +/=?& 2' };
    if ('members' in value) value.members.next = cursors.membersCursor ? 'member-3' : 'member +/=?& 2';
    return { state: 'ready', value, issuer: null, organizationsAvailable: null };
  };
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts',
    validateSearch: readCursors,
    loaderDeps: ({ search }) => search,
    gcTime: 0,
    loader: ({ deps, abortController }) =>
      readManagementWindow(client, detail ? organization.id : 'inventory', abortController.signal, async (signal) => {
        calls.push({ ...deps });
        signals.push(signal);
        if (defer)
          return new Promise<Page<Inventory | Detail>>((resolve) => {
            release = resolve;
          });
        return fail ? { state: fail === 'signed-out' ? 'signed-out' : 'unavailable' } : ready(detail, deps);
      }),
    component: View,
  });
  let detail = false;
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/accounts'] }),
    defaultPendingMs: 60_000,
  });
  function View() {
    const cursors = route.useSearch();
    const visit = useManagementWindow({
      read: route.useLoaderData(),
      cursors,
      target: detail ? organization.id : 'inventory',
      navigate: (search) => {
        transition = router.navigate({ to: '.', search });
      },
      retry: () => {
        transition = router.invalidate();
      },
    });
    return detail ? (
      <AccountManagementPage
        page={visit.page as Page<Detail>}
        cursors={cursors}
        navigation={visit.navigation}
        retry={visit.retry}
      />
    ) : (
      <ManagedAccountsPage
        page={visit.page as Page<Inventory>}
        cursors={cursors}
        navigation={visit.navigation}
        retry={visit.retry}
      />
    );
  }
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const move = async (field: keyof Cursors, label: string, keyboard = false) => {
    const nav =
      host.querySelector(`[data-management-feed="${field}"] nav`) ??
      [...host.querySelectorAll('nav')].find((nav) => nav.querySelector('a')?.textContent === label);
    const link = [...nav!.querySelectorAll<HTMLAnchorElement>('a')].find((item) => item.textContent === label)!;
    expect(link).toBeDefined();
    if (keyboard) link.focus();
    const before = calls.length;
    await act(async () => {
      link.dispatchEvent(
        new window.MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: keyboard ? 0 : 1,
        }) as unknown as MouseEvent,
      );
      await transition;
    });
    expect(calls.length).toBe(before + 1);
  };
  const retry = async () =>
    act(async () => {
      host.querySelector<HTMLButtonElement>('button')!.click();
      await transition;
    });
  try {
    await act(async () => {
      await router.load();
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    });
    expect(calls).toEqual([{}]);
    await move('organizationsCursor', m.managed_next(), true);
    expect(document.activeElement?.getAttribute('data-management-feed')).toBe('organizationsCursor');
    await move('operatorsCursor', m.managed_next());
    expect(calls.at(-1)).toEqual({ organizationsCursor: 'org +/=?& 2', operatorsCursor: 'operator +/=?& 2' });
    await move('organizationsCursor', m.prq_previous());
    expect(calls.at(-1)).toEqual({ operatorsCursor: 'operator +/=?& 2' });
    await move('organizationsCursor', m.managed_next());
    await retry(); // Refresh rereads the current combination without another history entry.
    await move('organizationsCursor', m.prq_previous());
    expect(calls.at(-1)).toEqual({ operatorsCursor: 'operator +/=?& 2' });
    await move('organizationsCursor', m.managed_next());
    fail = true;
    await move('organizationsCursor', m.prq_previous());
    const failedPrevious = calls.at(-1);
    await retry();
    expect(calls.at(-1)).toEqual(failedPrevious);
    fail = false;
    await retry();
    expect(host.querySelector('[data-management-feed="organizationsCursor"] a[rel="prev"]')).toBeNull();
    await move('organizationsCursor', m.managed_next());
    fail = true;
    await move('organizationsCursor', m.settings_managed_start_first_page());
    expect(calls.at(-1)).toEqual({ operatorsCursor: 'operator +/=?& 2' });
    fail = false;
    await retry();
    expect(calls.at(-1)).toEqual({ operatorsCursor: 'operator +/=?& 2' });
    fail = true;
    await move('organizationsCursor', m.managed_next());
    fail = false;
    await retry();
    expect(calls.at(-1)).toEqual({ organizationsCursor: 'org +/=?& 2', operatorsCursor: 'operator +/=?& 2' });
    await move('organizationsCursor', m.prq_previous());
    detail = true;
    await act(async () => {
      await router.navigate({
        to: '.',
        search: { membersCursor: 'direct-member', operatorsCursor: 'direct-operator' },
      });
    });
    expect(host.querySelector('a[rel="prev"]')).toBeNull();
    await move('membersCursor', m.managed_next());
    await move('operatorsCursor', m.managed_next());
    await move('membersCursor', m.prq_previous());
    expect(calls.at(-1)).toEqual({ membersCursor: 'direct-member', operatorsCursor: 'operator-3' });
    await move('membersCursor', m.settings_managed_start_first_page());
    expect(calls.at(-1)).toEqual({ operatorsCursor: 'operator-3' });
    // An unrelated focus move cancels keyboard handoff while the native page is pending.
    defer = true;
    const pendingLink = host.querySelector<HTMLAnchorElement>('[data-management-feed="membersCursor"] a[rel="next"]')!;
    pendingLink.focus();
    await act(async () => {
      pendingLink.click();
    });
    const elsewhere = host.querySelector<HTMLButtonElement>('button')!;
    elsewhere.focus();
    defer = false;
    await act(async () => {
      release!(ready(true, { membersCursor: 'member +/=?& 2' }));
      await transition;
    });
    expect(document.activeElement).toBe(elsewhere);
    // Late A work cannot survive an observed credential change or A/B/A replacement.
    defer = true;
    const link = host.querySelector<HTMLAnchorElement>('[data-management-feed="membersCursor"] a[rel="next"]')!;
    link.focus();
    await act(async () => {
      link.click();
    });
    await act(async () => {
      session('B');
      session('A', 'new-credential');
    });
    expect(host.querySelector('[data-management-feed]')).toBeNull();
    expect(signals.at(-1)!.aborted).toBe(true);
    defer = false;
    await act(async () => {
      release!(ready(true, { membersCursor: 'late-A' }));
      await transition;
    });
    expect(host.querySelector('[data-management-feed]')).toBeNull();
    await retry();
    expect(host.querySelector('a[rel="prev"]')).toBeNull();
    fail = 'signed-out';
    await retry();
    expect(host.textContent).toContain(m.managed_sign_in_title());
    expect(host.querySelector('[data-management-feed]')).toBeNull();
    expect(host.querySelector('a[rel="prev"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    stop();
    client.clear();
    await window.happyDOM.close();
    setLocale(locale, { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
