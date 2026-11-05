import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import type {
  ManagedAccountsCursors,
  ManagedAccountsPage,
  ManagedAccountsResult,
} from '../src/settings/managed-accounts-read';

// UNRUN: real component, router, session admission and inventory; only supplied IO/DOM are illustrative.
// Layout, native disclosure and browser acceptance remain with integration.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/settings?panel=compact#account' });
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
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { within } = await import('storybook/test');
const { ManagedAccountsSection } = await import('../src/settings/managed-accounts');
const { ManagedAccountSelectionUnavailable } = await import('../src/settings/settings-page');
const { managedAccountsFailure } = await import('../src/settings/managed-accounts-read');
const { sessionQuery } = await import('../src/session/query');
const { managedAccountsExample, managedViewer } = await import('../src/stories/patterns/managed-accounts.fixtures');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const previousLocale = getLocale();
setLocale('en', { reload: false });

const longName = 'Independent Readers and Translators — 読書会 — مجموعة القراءة — ' + 'ReadTogether'.repeat(12);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function source() {
  const calls: ManagedAccountsCursors[] = [];
  const replies: ((result: ManagedAccountsResult) => void)[] = [];
  return {
    calls,
    io: (cursors: ManagedAccountsCursors) => {
      calls.push(cursors);
      return new Promise<ManagedAccountsResult>((resolve) => replies.push(resolve));
    },
    answer: (result: ManagedAccountsResult, index = 0) =>
      act(async () => {
        const [reply] = replies.splice(index, 1);
        expect(reply).toBeDefined();
        reply!(result);
        await tick();
      }),
  };
}
const ready = (page: ManagedAccountsPage): ManagedAccountsResult => ({ ok: true, page });
const names = () => [m.managed_your_account(), m.managed_organizations_title(), m.managed_operated_title()];
function region(host: HTMLElement, name: string) {
  return within(host).getByRole('region', { name });
}
function button(host: HTMLElement, name: string) {
  return within(host).getByRole('button', { name }) as HTMLButtonElement;
}
function associations(host: HTMLElement) {
  for (const name of names()) {
    const card = region(host, name);
    const heading = within(card).getByRole('heading', { level: 3, name });
    expect(card.getAttribute('aria-labelledby')).toBe(heading.id);
    for (const group of within(card).queryAllByRole('group')) {
      expect(group.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(within(card).getByRole('group', { name })).toBe(group);
      for (const control of within(group).getAllByRole('button')) {
        const description = control.getAttribute('aria-describedby')!.split(' ');
        expect(description[0]).toBe(heading.id);
        for (const id of description) expect(card.contains(document.getElementById(id))).toBe(true);
      }
    }
    for (const status of within(card).queryAllByRole('status'))
      expect(status.getAttribute('aria-labelledby')).toBe(heading.id);
  }
}
async function mounted(sources: ReturnType<typeof source>[], dir?: 'rtl') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: managedViewer, csrfToken: 'story-csrf' });
  const route = createRootRoute({
    component: () => (
      <>
        {sources.map(({ io }, index) => (
          <section key={index} aria-label={`Inventory ${index + 1}`} dir={dir}>
            <ManagedAccountsSection io={io} />
          </section>
        ))}
      </>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/en/settings?panel=compact#account'] }),
  });
  await router.load();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    );
    await tick();
  });
  return {
    host,
    client,
    inventory: (index = 1) => within(host).getByRole('region', { name: `Inventory ${index}` }),
    click: (control: HTMLElement) =>
      act(async () => {
        control.click();
        await tick();
      }),
    close: async () => {
      await act(async () => {
        root.unmount();
        await tick();
      });
      client.clear();
      host.remove();
    },
  };
}

test('two mounted inventories name their independent feeds and retain exact sparse, retry, cooldown and first-page operands', async () => {
  const first = source();
  const second = source();
  const view = await mounted([first, second]);
  try {
    const initial = managedAccountsExample();
    initial.organizations.items[0]!.account.displayName = longName;
    initial.organizations.next = ' org +/= &?% ';
    initial.responsibilities.next = ' op +/= &?% ';
    const sparse = managedAccountsExample();
    sparse.organizations = { state: 'ready', items: [], next: '' };
    await first.answer(ready(initial));
    await second.answer(ready(sparse));
    const a = view.inventory();
    const b = view.inventory(2);
    associations(a);
    associations(b);
    const ids = [...view.host.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    const org = region(a, m.managed_organizations_title());
    const resp = region(a, m.managed_operated_title());
    const otherOrg = region(b, m.managed_organizations_title());
    const identity = within(org).getByRole('heading', { name: longName, level: 4 });
    expect(within(a).queryByRole('link')).toBeNull();
    expect(a.textContent).toContain(m.settings_managed_navigation_unavailable());
    const unavailable = within(resp)
      .getByRole('heading', { level: 4, name: m.settings_managed_identity_unavailable() })
      .closest('li')!;
    expect(unavailable.querySelector('a')).toBeNull();
    expect(unavailable.textContent).toContain(m.managed_reconciling());
    expect(a.innerHTML).not.toContain(initial.responsibilities.items[1]!.accountId);
    expect(otherOrg.textContent).toContain(m.managed_no_current_page());
    expect(otherOrg.textContent).not.toContain(m.managed_no_organizations());
    await view.click(button(org, m.managed_next()));
    await view.click(button(resp, m.managed_next()));
    expect(org.getAttribute('aria-busy')).toBe('true');
    expect(resp.getAttribute('aria-busy')).toBe('true');
    expect(region(a, m.managed_your_account()).getAttribute('aria-busy')).toBe('false');
    expect(otherOrg.getAttribute('aria-busy')).toBe('false');
    expect(button(org, m.settings_managed_loading()).disabled).toBe(true);
    // A later responsibility failure must not end or restart the pending organization read.
    await first.answer(managedAccountsFailure(409, { code: 'stale_cursor' }, { 'Retry-After': '1' }), 1);
    expect(org.getAttribute('aria-busy')).toBe('true');
    expect(resp.getAttribute('aria-busy')).toBe('false');
    expect(button(org, m.settings_managed_loading()).disabled).toBe(true);
    associations(a);
    await first.answer(ready({ ...initial, organizations: { state: 'ready', items: [], next: 'next org +/=' } }));
    expect(org.getAttribute('aria-busy')).toBe('false');
    expect(within(org).queryByRole('heading', { name: longName, level: 4 })).toBeNull();
    expect(document.activeElement).not.toBe(within(org).getByRole('heading', { level: 3 }));
    expect(org.textContent).toContain(m.managed_no_current_page());
    expect(resp.textContent).toContain(m.settings_managed_responsibilities_retry_wait());
    expect(org.textContent).not.toContain(m.settings_managed_responsibilities_retry_wait());
    associations(a);
    for (const name of [m.settings_retry(), m.settings_managed_restart_list()]) {
      expect(button(resp, name).disabled).toBe(true);
      await view.click(button(resp, name));
    }
    expect(first.calls).toEqual([
      {},
      { organizationsCursor: initial.organizations.next! },
      { operatorsCursor: initial.responsibilities.next! },
    ]);
    await view.click(button(otherOrg, m.managed_next()));
    await second.answer(ready({ ...sparse, organizations: { state: 'ready', items: [], next: null } }));
    expect(otherOrg.textContent).toContain(m.managed_no_organizations());
    expect(button(otherOrg, m.prq_previous()).disabled).toBe(false);
    expect(button(otherOrg, m.settings_managed_restart_list()).disabled).toBe(false);
    expect(second.calls).toEqual([{}, { organizationsCursor: '' }]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    expect(button(resp, m.settings_retry()).disabled).toBe(false);
    expect(first.calls).toHaveLength(3); // Cooldown expiry never requests a page.
    await view.click(button(resp, m.settings_retry()));
    await first.answer(managedAccountsFailure(503, { code: 'dependency_unavailable' }));
    expect(resp.contains(unavailable)).toBe(true);
    await view.click(button(resp, m.settings_managed_restart_list()));
    await first.answer(
      ready({
        ...initial,
        organizations: { state: 'preparing', items: [], next: null },
        responsibilities: { items: [], next: null },
      }),
    );
    expect(resp.textContent).toContain(m.managed_no_responsibilities());
    expect(within(resp).queryByRole('button')).toBeNull();
    expect(org.contains(identity)).toBe(false);
    expect(document.activeElement).not.toBe(within(resp).getByRole('heading', { level: 3 }));
    expect(within(org).queryByText(m.managed_preparing_text())).toBeNull();
    expect(first.calls).toEqual([
      {},
      { organizationsCursor: initial.organizations.next! },
      { operatorsCursor: initial.responsibilities.next! },
      { operatorsCursor: initial.responsibilities.next! },
      {},
    ]);
    associations(a);
  } finally {
    await view.close();
  }
});

test('an unadmitted managed-account selection stays unavailable and returns to the settings account list', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ManagedAccountSelectionUnavailable backHref="/en/settings?panel=compact#account" />);
    await tick();
  });
  try {
    expect(within(host).getByRole('status').textContent).toBe(m.settings_managed_navigation_unavailable());
    expect(within(host).getByRole('link', { name: m.managed_back() }).getAttribute('href')).toBe(
      '/en/settings?panel=compact#account',
    );
  } finally {
    await act(async () => {
      root.unmount();
      await tick();
    });
    host.remove();
  }
});

test('organization retry and first-page controls preserve retained responsibilities and never advance their cursor', async () => {
  const feed = source();
  const view = await mounted([feed]);
  try {
    const initial = managedAccountsExample();
    await feed.answer(ready(initial));
    const inventory = view.inventory();
    const org = region(inventory, m.managed_organizations_title());
    const resp = region(inventory, m.managed_operated_title());
    const retained = resp.innerHTML;
    await view.click(button(org, m.managed_next()));
    await feed.answer(managedAccountsFailure(400, { code: 'invalid_cursor' }));
    associations(inventory);
    await view.click(button(org, m.settings_retry()));
    await feed.answer(managedAccountsFailure(409, { code: 'stale_cursor' }));
    expect(resp.innerHTML).toBe(retained);
    await view.click(button(org, m.settings_managed_restart_list()));
    await feed.answer(
      ready({
        ...initial,
        organizations: { state: 'ready', items: [], next: null },
        responsibilities: { items: [], next: null },
      }),
    );
    expect(org.textContent).toContain(m.managed_no_organizations());
    expect(resp.innerHTML).toBe(retained);
    expect(feed.calls).toEqual([
      {},
      { organizationsCursor: initial.organizations.next! },
      { organizationsCursor: initial.organizations.next! },
      {},
    ]);
  } finally {
    await view.close();
  }
});

test('inventory failure, preparing and sparse responsibility recovery keep their own original operations', async () => {
  const feed = source();
  const view = await mounted([feed]);
  try {
    const inventory = view.inventory();
    const viewer = region(inventory, m.managed_your_account());
    expect(viewer.getAttribute('aria-busy')).toBe('true');
    expect(within(viewer).getByRole('status', { name: m.managed_your_account() }).textContent).toBe(
      m.settings_managed_loading(),
    );
    await feed.answer(managedAccountsFailure(503, undefined, { 'Retry-After': '0' }));
    expect(within(inventory).getAllByRole('region')).toHaveLength(1);
    expect(within(viewer).getByRole('group', { name: m.managed_your_account() })).toBeDefined();
    expect(button(viewer, m.settings_retry()).getAttribute('aria-describedby')!.split(' ')[0]).toBe(
      viewer.getAttribute('aria-labelledby'),
    );
    await view.click(button(viewer, m.settings_retry()));
    const preparing = managedAccountsExample();
    preparing.organizations = { state: 'preparing', items: [], next: null };
    preparing.responsibilities = { items: [], next: 'sparse responsibility +/=' };
    await feed.answer(ready(preparing));
    const org = region(inventory, m.managed_organizations_title());
    const resp = region(inventory, m.managed_operated_title());
    expect(org.textContent).toContain(m.managed_preparing_text());
    expect(org.textContent).not.toContain(m.managed_no_organizations());
    expect(resp.textContent).toContain(m.settings_managed_no_responsibilities_page());
    expect(within(resp).queryByText(m.managed_no_responsibilities(), { exact: true })).toBeNull();
    associations(inventory);
    await view.click(button(org, m.settings_retry()));
    expect(within(org).getAllByRole('status')).toHaveLength(1);
    expect(within(org).queryByRole('button', { name: m.settings_managed_restart_list() })).toBeNull();
    await feed.answer(ready({ ...preparing, organizations: { state: 'ready', items: [], next: null } }));
    await view.click(button(resp, m.managed_next()));
    await feed.answer(ready({ ...preparing, responsibilities: { items: [], next: null } }));
    expect(resp.textContent).toContain(m.managed_no_responsibilities());
    expect(feed.calls).toEqual([{}, {}, {}, { operatorsCursor: preparing.responsibilities.next! }]);
  } finally {
    await view.close();
  }
});

test('supplied handle and unnamed fallbacks stay human while unavailable responsibility identities stay absent', async () => {
  const feed = source();
  const view = await mounted([feed], 'rtl');
  try {
    const initial = managedAccountsExample();
    initial.account.displayName = null;
    initial.account.handle = 'reader-with-a-long-handle-for-independent-groups';
    initial.organizations.items[0]!.account.displayName = null;
    initial.organizations.items[0]!.account.handle = null;
    const inventory = view.inventory();
    await feed.answer(ready(initial));
    const viewer = region(inventory, m.managed_your_account());
    const org = region(inventory, m.managed_organizations_title());
    const resp = region(inventory, m.managed_operated_title());
    expect(within(viewer).getByRole('heading', { level: 4 }).textContent).toBe(`@${initial.account.handle}`);
    expect(within(org).getByRole('heading', { name: m.managed_unnamed(), level: 4 })).toBeDefined();
    expect(within(inventory).queryByRole('link')).toBeNull();
    const unavailable = within(resp)
      .getByRole('heading', { name: m.settings_managed_identity_unavailable() })
      .closest('li')!;
    expect(unavailable.querySelector('a')).toBeNull();
    for (const value of [
      initial.responsibilities.items[1]!.accountId,
      initial.responsibilities.items[1]!.reservationId,
    ])
      expect(inventory.innerHTML).not.toContain(value);
    const next = button(org, m.managed_next());
    next.focus();
    expect(document.activeElement).toBe(next);
    associations(inventory);
    expect(feed.calls).toEqual([{}]);
  } finally {
    await view.close();
  }
});

test('current-viewer withdrawal withholds every identity and refuses retained controls before commit', async () => {
  const feed = source();
  const view = await mounted([feed]);
  try {
    const initial = managedAccountsExample();
    await feed.answer(ready(initial));
    const inventory = view.inventory();
    const controls = [...inventory.querySelectorAll('button')];
    await view.click(button(region(inventory, m.managed_organizations_title()), m.managed_next()));
    await act(async () => {
      view.client
        .getQueryCache()
        .find({ queryKey: sessionQuery.queryKey })!
        .setState({ status: 'error', error: new Error('Session unavailable') });
      for (const control of controls) control.click();
      await tick();
    });
    expect(view.client.getQueryData(sessionQuery.queryKey)).toMatchObject({ subject: managedViewer });
    await feed.answer(ready(initial));
    expect(within(inventory).queryByRole('region')).toBeNull();
    for (const identity of [
      initial.account,
      ...initial.organizations.items.map((item) => item.account),
      initial.responsibilities.items[0]!.account!,
    ]) {
      for (const value of [identity.id, identity.displayName, identity.handle])
        if (value) expect(view.host.innerHTML).not.toContain(value);
    }
    expect(feed.calls).toEqual([{}, { organizationsCursor: initial.organizations.next! }]);
  } finally {
    await view.close();
  }
});

test('credential replacement and an A-to-B-to-A transition retire pending directory reads synchronously', async () => {
  for (const replacement of ['credential', 'viewer'] as const) {
    const feed = source();
    const view = await mounted([feed]);
    try {
      await feed.answer(ready(managedAccountsExample()));
      const org = region(view.inventory(), m.managed_organizations_title());
      await view.click(button(org, m.managed_next()));
      await feed.answer(ready(managedAccountsExample()));
      const control = button(org, m.prq_previous());
      await view.click(control);
      await act(async () => {
        view.client.setQueryData(sessionQuery.queryKey, {
          state: 'signed-in',
          csrfToken: 'replacement',
          subject: replacement === 'credential' ? managedViewer : '019a0000-0000-7000-8000-000000000099',
        });
        view.client.setQueryData(sessionQuery.queryKey, {
          state: 'signed-in',
          csrfToken: 'story-csrf',
          subject: managedViewer,
        });
        control.click();
        await tick();
      });
      expect(feed.calls).toHaveLength(4); // The new lifecycle has one fresh initial read.
      await feed.answer(ready(managedAccountsExample())); // Retired next-page response.
      expect(within(view.inventory()).queryByRole('list')).toBeNull();
      await feed.answer(ready(managedAccountsExample()));
      expect(within(view.inventory()).getByRole('list', { name: m.managed_your_account() })).toBeDefined();
    } finally {
      await view.close();
    }
  }
});

test('keyboard terminal movement owns focus only until another feed or Settings section takes it', async () => {
  const feed = source();
  const view = await mounted([feed]);
  const outside = document.createElement('button');
  document.body.append(outside);
  try {
    const initial = managedAccountsExample();
    await feed.answer(ready(initial));
    const org = region(view.inventory(), m.managed_organizations_title());
    const resp = region(view.inventory(), m.managed_operated_title());
    const keyboard = async (control: HTMLElement) => {
      control.focus();
      await view.click(control); // A focused, zero-detail activation is the native keyboard click.
    };
    await keyboard(button(org, m.managed_next()));
    await keyboard(button(resp, m.managed_next()));
    await feed.answer(ready({ ...initial, organizations: { state: 'ready', items: [], next: null } }));
    expect(document.activeElement).not.toBe(within(org).getByRole('heading', { level: 3 }));
    await feed.answer(ready({ ...initial, responsibilities: { items: [], next: null } }));
    expect(document.activeElement).toBe(within(resp).getByRole('heading', { level: 3 }));
    expect(button(org, m.managed_next()).disabled).toBe(true);
    await keyboard(button(org, m.prq_previous()));
    outside.focus();
    await feed.answer(ready(initial));
    expect(document.activeElement).toBe(outside);
    await keyboard(button(resp, m.settings_managed_restart_list()));
    await feed.answer(managedAccountsFailure(503));
    await keyboard(button(resp, m.settings_retry()));
    await feed.answer(ready(initial));
    expect(document.activeElement).toBe(within(resp).getByRole('heading', { level: 3 }));
    expect(feed.calls).toEqual([
      {},
      { organizationsCursor: initial.organizations.next! },
      { operatorsCursor: initial.responsibilities.next! },
      {},
      {},
      {},
    ]);
  } finally {
    outside.remove();
    await view.close();
  }
});

afterAll(async () => {
  mock.restore();
  setLocale(previousLocale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
