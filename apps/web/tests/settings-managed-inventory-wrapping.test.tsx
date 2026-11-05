import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import type {
  ManagedAccountsCursors,
  ManagedAccountsPage,
  ManagedAccountsResult,
} from '../src/settings/managed-accounts-read';

// Actual mounted components/readers with supplied bounded IO. DOM plumbing is illustrative, not geometry proof.
// This additive regression and its browser story geometry counterparts are authored, UNRUN.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => {
    throw new Error('Unexpected native session read');
  },
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/de/settings?panel=compact#account' });
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
  matchMedia: window.matchMedia.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { ManagedAccounts, ManagedAccountsSection } = await import('../src/settings/managed-accounts');
const { managedAccountHref, managedAccountsFailure } = await import('../src/settings/managed-accounts-read');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');

const viewer = '019a0000-0000-7000-8000-000000000001';
const org = '019a0000-0000-7000-8000-000000000002';
const operator = '019a0000-0000-7000-8000-000000000003';
const withheld = '019a0000-0000-7000-8000-000000000099';
const longName = 'InternationaleLesegemeinschaftFürUnabhängigeVeröffentlichungen'.repeat(5);
const settingsHref = '/de/settings?panel=compact&managedAccount=old#profile';
function page(size = 1): ManagedAccountsPage {
  return {
    account: { id: viewer, kind: 'actor', displayName: longName, handle: longName.toLowerCase() },
    viewer: { state: 'current', account: { id: viewer, kind: 'actor', displayName: longName, handle: longName.toLowerCase() } },
    organizations: {
      state: 'ready',
      items: Array.from({ length: size }, (_, index) => ({
        account: {
          id: `${org.slice(0, -12)}${String(index + 2).padStart(12, '0')}`,
          kind: 'organization',
          displayName: `Organization ${index} ${longName}`,
          handle: longName,
        },
        role: index % 2 ? 'member' : 'owner',
        navigation: { state: 'admitted' },
      })),
      next: 'organization opaque +/= &?%',
    },
    responsibilities: {
      items: [
        {
          reservationId: org,
          accountId: operator,
          account: { id: operator, kind: 'actor', displayName: `Operator ${longName}`, handle: null },
          state: 'current',
          navigation: { state: 'admitted' },
        },
        { reservationId: operator, accountId: withheld, account: null, state: 'reconciling', navigation: { state: 'concealed' } },
      ],
      next: 'responsibility opaque +/= &?%',
    },
  };
}
const ready = (value = page()): ManagedAccountsResult => ({ ok: true, page: value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function controlled() {
  const calls: ManagedAccountsCursors[] = [];
  const replies: ReturnType<typeof deferred<ManagedAccountsResult>>[] = [];
  return {
    calls,
    replies,
    io: (cursors: ManagedAccountsCursors) => {
      calls.push(cursors);
      const reply = deferred<ManagedAccountsResult>();
      replies.push(reply);
      return reply.promise;
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(action: () => void) {
  await act(async () => {
    action();
    await tick();
  });
}
async function mount(content: ReactNode) {
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  await settle(() => root.render(<StrictMode>{content}</StrictMode>));
  return {
    host,
    close: async () => {
      await settle(() => root.unmount());
      host.remove();
    },
  };
}
function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
  expect(found).toBeDefined();
  return found!;
}
function feed(host: Element, label: string) {
  const list = [...host.querySelectorAll('ul')].find((node) => node.getAttribute('aria-label') === label);
  expect(list).toBeDefined();
  return list!.parentElement!;
}
function geometryContract(host: Element) {
  for (const control of host.querySelectorAll<HTMLButtonElement>('button')) {
    expect(control.tagName).toBe('BUTTON');
    expect(control.type).toBe('button');
    for (const token of [
      'h-auto',
      'min-h-11',
      'min-w-11',
      'max-w-full',
      'shrink',
      'whitespace-normal',
      'wrap-anywhere',
      'py-2',
    ])
      expect(control.classList.contains(token)).toBe(true);
    expect(control.classList.contains('whitespace-nowrap')).toBe(false);
    expect(control.closest('a')).toBeNull();
  }
  for (const card of host.querySelectorAll('[data-slot="card"], [data-slot="card-header"], [data-slot="card-content"]'))
    expect(card.classList.contains('min-w-0')).toBe(true);
  for (const badge of host.querySelectorAll('[data-slot="badge"]')) {
    expect(badge.classList.contains('h-auto')).toBe(true);
    expect(badge.classList.contains('whitespace-normal')).toBe(true);
  }
  for (const list of host.querySelectorAll('ul')) expect(list.classList.contains('min-w-0')).toBe(true);
}

test('mounted independent inventories retain native controls, long and unavailable identity, independent busy/retry/first-page and sparse distinctions', async () => {
  setLocale('de', { reload: false });
  const a = controlled();
  const b = controlled();
  const view = await mount(
    <>
      <section data-case="a">
        <ManagedAccounts viewerId={viewer} settingsHref={settingsHref} io={a.io} />
      </section>
      <section data-case="b">
        <ManagedAccounts viewerId={viewer} settingsHref={settingsHref} io={b.io} />
      </section>
    </>,
  );
  try {
    expect(a.calls).toEqual([{}]);
    expect(b.calls).toEqual([{}]);
    await settle(() => {
      a.replies[0]!.resolve(ready());
      b.replies[0]!.resolve(ready());
    });
    const first = view.host.querySelector('[data-case="a"]')!;
    const second = view.host.querySelector('[data-case="b"]')!;
    expect(first.querySelectorAll('h3')).toHaveLength(3);
    expect(first.querySelectorAll('h4')).toHaveLength(4);
    for (const row of first.querySelectorAll('li')) {
      expect(row.querySelectorAll('h4')).toHaveLength(1);
      const missing = row.textContent?.includes(m.settings_managed_identity_unavailable());
      expect(row.querySelectorAll('a')).toHaveLength(missing ? 0 : 1);
      if (missing) expect(row.querySelector('[data-slot="avatar"]')).toBeNull();
    }
    expect(first.innerHTML).not.toContain(withheld);
    expect(first.textContent).toContain(m.managed_current());
    expect(first.textContent).toContain(m.managed_reconciling());
    expect(first.querySelector('a')?.getAttribute('href')).toBe(managedAccountHref(settingsHref, viewer));
    const organizations = feed(first, m.managed_organizations_title());
    const responsibilities = feed(first, m.managed_operated_title());
    await settle(() => button(organizations, m.settings_managed_load_more()).click());
    expect(organizations.getAttribute('aria-busy')).toBe('true');
    expect(button(organizations, m.settings_managed_loading()).disabled).toBe(true);
    await settle(() => button(organizations, m.settings_managed_loading()).click());
    expect(a.calls).toHaveLength(2);
    expect(button(responsibilities, m.settings_managed_load_more()).disabled).toBe(false);
    await settle(() => button(feed(second, m.managed_operated_title()), m.settings_managed_load_more()).click());
    expect(b.calls).toEqual([{}, { operatorsCursor: page().responsibilities.next! }]);
    await settle(() =>
      a.replies[1]!.resolve(managedAccountsFailure(409, { code: 'stale_cursor' }, { 'Retry-After': '1' })),
    );
    const alert = organizations.querySelector('[role="alert"]')!;
    expect(alert.getAttribute('data-response-status')).toBe('409');
    expect(alert.getAttribute('data-response-code')).toBe('stale_cursor');
    expect(alert.getAttribute('data-retry-after')).toBe('1');
    const retry = button(organizations, m.settings_retry());
    const restart = button(organizations, m.settings_managed_restart_list());
    expect(retry.disabled).toBe(true);
    expect(restart.disabled).toBe(true);
    geometryContract(view.host);
    await settle(() => {
      retry.click();
      restart.click();
    });
    expect(a.calls).toHaveLength(2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    expect(retry.disabled).toBe(false);
    expect(organizations.querySelector('[role="alert"]')).not.toBeNull(); // no automatic recovery
    await settle(() => {
      retry.focus();
      retry.click();
    });
    expect(window.document.activeElement).toBe(retry);
    expect(a.calls[2]).toEqual({ organizationsCursor: page().organizations.next! });
    expect(retry.disabled).toBe(true);
    expect(restart.disabled).toBe(true);
    await settle(() => a.replies[2]!.resolve(managedAccountsFailure(503, { code: 'dependency_unavailable' })));
    await settle(() => button(organizations, m.settings_managed_restart_list()).click());
    expect(a.calls[3]).toEqual({});
    expect(organizations.textContent).toContain(longName);
    const sparse = page();
    sparse.organizations = { state: 'ready', items: [], next: 'sparse continuation +/=' };
    await settle(() => a.replies[3]!.resolve(ready(sparse)));
    expect(organizations.textContent).toContain(m.managed_no_current_page());
    expect(organizations.textContent).not.toContain(m.managed_no_organizations());
    expect(responsibilities.textContent).toContain(m.managed_reconciling());
    expect(b.calls).toHaveLength(2);
    await settle(() => button(organizations, m.settings_managed_load_more()).click());
    const exhausted = page();
    exhausted.organizations = { state: 'ready', items: [], next: null };
    await settle(() => a.replies[4]!.resolve(ready(exhausted)));
    expect(a.calls[4]).toEqual({ organizationsCursor: 'sparse continuation +/=' });
    expect(organizations.textContent).toContain(m.managed_no_organizations());
    expect(organizations.querySelector('button')).toBeNull();
    await settle(() => b.replies[1]!.resolve(ready()));
    geometryContract(view.host);
  } finally {
    await view.close();
  }
});

test('mounted preparing and sparse responsibilities remain distinct from empty and failures, with no invented authority or extra reads', async () => {
  const source = controlled();
  const view = await mount(<ManagedAccounts viewerId={viewer} settingsHref={settingsHref} io={source.io} />);
  try {
    const preparing = page();
    preparing.organizations = { state: 'preparing', items: [], next: null };
    preparing.responsibilities = { items: [], next: 'filtered responsibility +/=' };
    await settle(() => source.replies[0]!.resolve(ready(preparing)));
    expect(view.host.textContent).toContain(m.managed_preparing_text());
    expect(view.host.textContent).toContain(m.settings_managed_no_responsibilities_page());
    expect(view.host.textContent).not.toContain(m.managed_no_responsibilities());
    geometryContract(view.host);
    await settle(() => button(view.host, m.settings_retry()).click());
    expect(source.calls).toEqual([{}, {}]);
    await settle(() => source.replies[1]!.resolve(managedAccountsFailure(400, { code: 'invalid_cursor' })));
    expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(
      [...view.host.querySelectorAll('button')].some((node) => node.textContent === m.settings_managed_restart_list()),
    ).toBe(false);
    await settle(() => button(view.host, m.settings_managed_load_more()).click());
    const empty = page();
    empty.responsibilities = { items: [], next: null };
    await settle(() => source.replies[2]!.resolve(ready(empty)));
    expect(source.calls[2]).toEqual({ operatorsCursor: 'filtered responsibility +/=' });
    expect(view.host.textContent).toContain(m.managed_no_responsibilities());
    expect(view.host.textContent).toContain(m.managed_preparing_text());
    expect(source.calls).toHaveLength(3);
  } finally {
    await view.close();
  }
});

for (const outcome of ['wait', 'denied', 'unavailable'] as const) {
  test(`mounted initial ${outcome} retains exact metadata and deliberate recovery without private rows`, async () => {
    const source = controlled();
    const view = await mount(<ManagedAccounts viewerId={viewer} settingsHref={settingsHref} io={source.io} />);
    try {
      await settle(() =>
        source.replies[0]!.resolve(
          managedAccountsFailure(
            outcome === 'denied' ? 403 : outcome === 'wait' ? 429 : 503,
            { code: outcome === 'denied' ? 'forbidden' : 'dependency_unavailable' },
            outcome === 'wait' ? { 'Retry-After': '1' } : undefined,
          ),
        ),
      );
      expect(view.host.querySelector('ul')).toBeNull();
      expect(view.host.innerHTML).not.toContain(longName);
      const retry = button(view.host, m.settings_retry());
      expect(retry.disabled).toBe(outcome === 'wait');
      geometryContract(view.host);
      if (outcome === 'wait') {
        expect(view.host.querySelector('[role="alert"]')?.getAttribute('data-response-status')).toBe('429');
        expect(view.host.textContent).toContain(m.settings_managed_inventory_retry_wait());
        await settle(() => retry.click());
        expect(source.calls).toHaveLength(1);
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1100));
        });
      }
      expect(source.calls).toHaveLength(1);
      await settle(() => retry.click());
      expect(source.calls).toEqual([{}, {}]);
      await settle(() => source.replies[1]!.resolve(ready()));
      expect(view.host.textContent).toContain(longName);
    } finally {
      await view.close();
    }
  });
}

for (const transition of ['error', 'signed-out', 'subject', 'remove'] as const) {
  for (const late of ['success', 'failure'] as const) {
    test(`connected inventory ${transition} retirement prevents stale click/auxclick navigation and late private ${late}`, async () => {
      const source = controlled();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      const session = { state: 'signed-in', subject: viewer, csrfToken: 'original-token' };
      client.setQueryData(sessionQuery.queryKey, session);
      const route = createRootRoute({ component: () => <ManagedAccountsSection io={source.io} /> });
      const router = createRouter({
        routeTree: route,
        history: createMemoryHistory({ initialEntries: [settingsHref] }),
      });
      await router.load();
      const view = await mount(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      try {
        expect(source.calls).toEqual([{}]);
        await settle(() => source.replies[0]!.resolve(ready()));
        const links = [...view.host.querySelectorAll('a')];
        await settle(() => button(feed(view.host, m.managed_operated_title()), m.settings_managed_load_more()).click());
        await settle(() => {
          if (transition === 'error')
            client
              .getQueryCache()
              .find({ queryKey: sessionQuery.queryKey, exact: true })!
              .setState({ status: 'error', error: new Error('unavailable') });
          else if (transition === 'remove') client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
          else
            client.setQueryData(sessionQuery.queryKey, {
              ...session,
              state: transition === 'signed-out' ? 'signed-out' : 'signed-in',
              subject: transition === 'subject' ? operator : null,
            });
          for (const link of links)
            for (const type of ['click', 'auxclick'])
              expect(
                link.dispatchEvent(
                  new window.MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'auxclick' ? 1 : 0 }),
                ),
              ).toBe(false);
        });
        expect(view.host.innerHTML).not.toContain(longName);
        expect(view.host.innerHTML).not.toContain('managedAccount=');
        const reads = source.calls.length;
        await settle(() =>
          source.replies[1]!.resolve(
            late === 'success'
              ? ready()
              : managedAccountsFailure(503, { code: 'late_private_failure' }, { 'Retry-After': '7' }),
          ),
        );
        expect(view.host.innerHTML).not.toContain(longName);
        expect(view.host.innerHTML).not.toContain('late_private_failure');
        expect(source.calls).toHaveLength(reads);
        await settle(() => client.setQueryData(sessionQuery.queryKey, session));
        const fresh = source.replies.at(-1)!;
        expect(source.calls).toHaveLength(reads + 1);
        expect(view.host.innerHTML).not.toContain(longName);
        await settle(() => fresh.resolve(ready()));
        expect(view.host.textContent).toContain(longName);
      } finally {
        await view.close();
        client.clear();
      }
    });
  }
}

for (const selected of ['organizations', 'responsibilities'] as const) {
  test(`mounted ${selected} first-page recovery preserves a pending sibling and retained rows through retry wait`, async () => {
    const source = controlled();
    const view = await mount(<ManagedAccounts viewerId={viewer} settingsHref={settingsHref} io={source.io} />);
    try {
      await settle(() => source.replies[0]!.resolve(ready()));
      const label = selected === 'organizations' ? m.managed_organizations_title() : m.managed_operated_title();
      const siblingLabel = selected === 'organizations' ? m.managed_operated_title() : m.managed_organizations_title();
      const region = feed(view.host, label);
      const sibling = feed(view.host, siblingLabel);
      const rows = region.querySelector('ul')!.innerHTML;
      await settle(() => button(region, m.settings_managed_load_more()).click());
      await settle(() => source.replies[1]!.resolve(managedAccountsFailure(400, { code: 'invalid_cursor' })));
      await settle(() => button(sibling, m.settings_managed_load_more()).click());
      await settle(() => button(region, m.settings_managed_restart_list()).click());
      expect(source.calls[3]).toEqual({});
      expect(button(region, m.settings_retry()).disabled).toBe(true);
      expect(button(region, m.settings_managed_restart_list()).disabled).toBe(true);
      expect(region.querySelector('ul')!.innerHTML).toBe(rows);
      await settle(() =>
        source.replies[3]!.resolve(managedAccountsFailure(429, { code: 'rate_limited' }, { 'Retry-After': '1' })),
      );
      expect(region.querySelector('[role="alert"]')?.getAttribute('data-response-status')).toBe('429');
      expect(button(region, m.settings_managed_restart_list()).disabled).toBe(true);
      expect(sibling.getAttribute('aria-busy')).toBe('true');
      geometryContract(view.host);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
      });
      expect(source.calls).toHaveLength(4);
      await settle(() => button(region, m.settings_managed_restart_list()).click());
      const replacement = page();
      replacement[selected].items = [];
      replacement[selected].next = null;
      await settle(() => source.replies[4]!.resolve(ready(replacement)));
      expect(region.querySelectorAll('li')).toHaveLength(0);
      expect(region.querySelector('button')).toBeNull();
      expect(sibling.getAttribute('aria-busy')).toBe('true');
      await settle(() => source.replies[2]!.resolve(ready()));
      expect(sibling.querySelectorAll('li').length).toBeGreaterThan(0);
      expect(region.querySelectorAll('li')).toHaveLength(0);
      expect(source.calls).toHaveLength(5);
    } finally {
      await view.close();
    }
  });
}

for (const [locale, direction, width] of [
  ['de', 'ltr', 390],
  ['fr', 'ltr', 1280],
  ['de', 'rtl', 390],
] as const) {
  test(`supplied ${locale}/${direction}/${width} inventory retains wrapping classes and independent focusable anchors`, async () => {
    setLocale(locale, { reload: false });
    const source = controlled();
    const view = await mount(
      <div dir={direction} style={{ width }}>
        <ManagedAccounts viewerId={viewer} settingsHref={settingsHref} io={source.io} />
      </div>,
    );
    try {
      await settle(() => source.replies[0]!.resolve(ready()));
      geometryContract(view.host);
      const anchor = view.host.querySelector<HTMLAnchorElement>('a')!;
      anchor.focus();
      expect(window.document.activeElement).toBe(anchor);
      expect(anchor.getAttribute('href')).toBe(managedAccountHref(settingsHref, viewer));
      expect(source.calls).toEqual([{}]);
    } finally {
      await view.close();
    }
  });
}

// Native pages admit at most 20 per feed. Exercise supplied sizes 1/8/20, never pretend 64 is admitted.
for (const size of [1, 8, 20]) {
  test(`mounted supplied ${size}-row page adds no IO per identity`, async () => {
    const source = controlled();
    const view = await mount(<ManagedAccounts viewerId={viewer} settingsHref={settingsHref} io={source.io} />);
    try {
      await settle(() => source.replies[0]!.resolve(ready(page(size))));
      expect(feed(view.host, m.managed_organizations_title()).querySelectorAll('li')).toHaveLength(size);
      expect(source.calls).toEqual([{}]);
      geometryContract(view.host);
    } finally {
      await view.close();
    }
  });
}

afterAll(() => {
  setLocale('en', { reload: false });
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.happyDOM.abort();
});
