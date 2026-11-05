import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import type {
  DetailRequest,
  DetailResult,
  DetailSection,
  ManagementDetail,
} from '../src/settings/managed-account-detail-read';

// Mounted presentation/interaction coverage. Browser geometry and native authority remain separate obligations.
mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/de/settings?view=accounts#account' });
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
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { ManagedAccountDetailCard } = await import('../src/settings/managed-account-detail');
const { ManagedAccountReader } = await import('../src/settings/managed-account-detail-read');
const { AnonymousSessionContext } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const originalLocale = getLocale();
const viewer = '019a0000-0000-7000-8000-000000000001';
const target = '019a0000-0000-7000-8000-000000000002';
const missing = '019a0000-0000-7000-8000-000000000003';
const longName = 'InternationaleLesegemeinschaftFürUnabhängigeVeröffentlichungen'.repeat(5);
const backHref = '/de/settings?view=accounts&safe=a%2Bb#account';
function detail(): ManagementDetail {
  const account = { id: target, kind: 'actor' as const, displayName: longName, handle: 'indexer' };
  return {
    account,
    self: false,
    role: 'owner',
    operator: { ...account, id: viewer, displayName: 'Operator', handle: null },
    relation: { operatorAccountId: viewer, reservationId: target, version: 'private-version' },
    members: {
      state: 'ready',
      items: [{ accountId: viewer, account: null, role: 'owner' }],
      next: 'members opaque +/= %',
    },
    responsibilities: {
      items: [{ accountId: missing, account: null, reservationId: missing, state: 'reconciling' }],
      next: 'responsibilities opaque +/= %',
    },
  };
}
const ready = (value = detail()): DetailResult => ({ ok: true, viewerId: viewer, value });
const settle = async (action: () => unknown) => {
  await act(async () => {
    await action();
  });
};
async function mount(reader: InstanceType<typeof ManagedAccountReader>) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  await settle(() =>
    root.render(
      <QueryClientProvider client={client}>
        <AnonymousSessionContext value={true}>
          <ManagedAccountDetailCard reader={reader} backHref={backHref} />
        </AnonymousSessionContext>
      </QueryClientProvider>,
    ),
  );
  return {
    host,
    close: async () => {
      await settle(() => root.unmount());
      reader.clear();
      client.clear();
      host.remove();
    },
  };
}
function button(host: Element, label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => (node.getAttribute('aria-label') || node.textContent) === label,
  );
  expect(found).toBeDefined();
  return found!;
}

test('recognizable account and operator lead; supplied IDs stay selectable in closed disclosures and unknown rows never use an ID as a name', async () => {
  setLocale('de', { reload: false });
  const reader = new ManagedAccountReader(viewer, target, async () => ready());
  await reader.load();
  const { host, close } = await mount(reader);
  try {
    expect(host.querySelector('#settings-account-heading')?.tagName).toBe('H2');
    expect(host.textContent).toContain(longName);
    expect(host.textContent).toContain('@indexer');
    expect(host.textContent).toContain('Operator');
    expect(host.querySelectorAll('[data-slot="avatar"]')).toHaveLength(4);
    expect([...host.querySelectorAll('h4')].map((node) => node.textContent)).toEqual([
      m.settings_managed_detail_identity_unavailable(),
      m.settings_managed_detail_identity_unavailable(),
    ]);
    const disclosures = [...host.querySelectorAll('details')];
    expect(disclosures.map((node) => node.querySelector('dd')?.textContent)).toEqual([target, viewer, viewer, missing]);
    for (const node of disclosures) {
      expect(node.open).toBe(false);
      expect(node.querySelector('dd')?.className).toContain('select-all');
      node.querySelector('summary')!.focus();
      expect(document.activeElement).toBe(node.querySelector('summary'));
    }
    expect(host.querySelector('a')?.getAttribute('href')).toBe(backHref);
    expect(host.querySelector('a')?.className).toContain('min-h-11');
    expect(host.textContent).not.toContain('private-version');
    expect(host.querySelectorAll('a')).toHaveLength(1); // Identity presentation cannot invent management/navigation rights.
  } finally {
    await close();
  }
});

test('whole-detail retry recovers initial and refreshed reads without leaving a Refresh bypass during Retry-After', async () => {
  let result: DetailResult = { ok: false, failure: { status: 503, transient: true } };
  const calls: DetailRequest[] = [];
  const reader = new ManagedAccountReader(viewer, target, async (input) => {
    calls.push(input);
    return result;
  });
  const refresh = reader.load.bind(reader);
  await reader.load();
  const { host, close } = await mount(reader);
  try {
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain(longName);
    result = ready();
    await settle(() => button(host, m.settings_retry()).click());
    expect(host.textContent).toContain(longName);
    result = { ok: false, failure: { status: 429, transient: true, retryAfter: '60' } };
    await settle(() => button(host, m.managed_refresh()).click());
    expect(button(host, m.settings_retry()).disabled).toBe(true);
    const saved = reader.snapshot();
    await refresh();
    await reader.load();
    expect(reader.snapshot()).toBe(saved);
    expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.managed_refresh())).toBe(false);
    expect(host.textContent).toContain(longName);
    expect(calls).toEqual(Array.from({ length: 3 }, () => ({ viewerId: viewer, accountId: target })));
  } finally {
    await close();
  }
});

test('each feed retries its exact failed cursor and restarts only itself; first-page failures also recover', async () => {
  for (const section of ['members', 'responsibilities'] satisfies DetailSection[]) {
    const calls: DetailRequest[] = [];
    let result = ready();
    const reader = new ManagedAccountReader(viewer, target, async (input) => {
      calls.push(input);
      return result;
    });
    await reader.load();
    const sibling = section === 'members' ? 'responsibilities' : 'members';
    const retained = reader.snapshot()[sibling];
    const { host, close } = await mount(reader);
    const label = section === 'members' ? m.managed_holders_title() : m.managed_operated_title();
    const cursor = detail()[section]!.next!;
    try {
      result = { ok: false, failure: { status: 400, transient: false, code: 'invalid_cursor' } };
      await settle(() => button(host, `${m.managed_next()} · ${label}`).click());
      await settle(() => button(host, `${m.settings_retry()} · ${label}`).click());
      expect(calls[2]).toEqual(calls[1]);
      result = ready();
      await settle(() => button(host, `${m.settings_managed_start_first_page()} · ${label}`).click());
      expect(calls[3]).toEqual({ viewerId: viewer, accountId: target, section });
      expect(reader.snapshot()[sibling].page).toBe(retained.page);
      expect(reader.snapshot()[sibling].cursor).toBe(retained.cursor);
      await settle(() => reader.load(section, cursor));
      result = { ok: false, failure: { status: 503, transient: true } };
      await settle(() => reader.load(section));
      result = ready();
      await settle(() => button(host, `${m.settings_retry()} · ${label}`).click());
      expect(calls[6]).toEqual(calls[5]);
      expect(calls[1]).toEqual({ viewerId: viewer, accountId: target, section, cursor });
      expect(calls).toHaveLength(7);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(reader.snapshot()[sibling].page).toBe(retained.page);
      expect(reader.snapshot()[sibling].cursor).toBe(retained.cursor);
    } finally {
      await close();
    }
  }
});

test('nameless supplied identities remain distinct from unavailable identities', async () => {
  const value = detail();
  value.account = { ...value.account, displayName: null, handle: null };
  const reader = new ManagedAccountReader(viewer, target, async () => ready(value));
  await reader.load();
  const { host, close } = await mount(reader);
  try {
    const region = host.querySelector(`[aria-label="${m.managed_target_title()}"]`)!;
    expect(region.textContent).toContain(m.managed_unnamed());
    expect(region.querySelector('dd')?.textContent).toBe(target);
    expect(region.textContent).not.toContain(m.settings_managed_detail_identity_unavailable());
  } finally {
    await close();
  }
});

test('each continuation retains its page during Retry-After and disables both recovery choices without automatic reads', async () => {
  for (const section of ['members', 'responsibilities'] satisfies DetailSection[]) {
    let result = ready();
    const calls: DetailRequest[] = [];
    const reader = new ManagedAccountReader(viewer, target, async (input) => {
      calls.push(input);
      return result;
    });
    await reader.load();
    const retained = reader.snapshot()[section].page;
    const { host, close } = await mount(reader);
    const label = section === 'members' ? m.managed_holders_title() : m.managed_operated_title();
    try {
      result = { ok: false, failure: { status: 429, transient: true, retryAfter: '1' } };
      await settle(() => button(host, `${m.managed_next()} · ${label}`).click());
      for (const action of [m.settings_retry(), m.settings_managed_start_first_page()]) {
        const control = button(host, `${action} · ${label}`);
        expect(control.disabled).toBe(true);
        for (const token of ['h-auto', 'min-h-11', 'min-w-11', 'max-w-full', 'whitespace-normal', 'wrap-anywhere']) {
          expect(control.className.split(' ')).toContain(token);
        }
        await settle(() => control.click());
      }
      expect(button(host, m.managed_refresh()).disabled).toBe(true);
      expect(reader.snapshot()[section].page).toBe(retained);
      await settle(() => new Promise((resolve) => setTimeout(resolve, 1100)));
      expect(button(host, `${m.settings_retry()} · ${label}`).disabled).toBe(false);
      expect(calls).toHaveLength(2);
      result = ready();
      await settle(() => button(host, `${m.settings_retry()} · ${label}`).click());
      expect(calls[2]).toEqual(calls[1]);
    } finally {
      await close();
    }
  }
});

afterAll(() => {
  setLocale(originalLocale, { reload: false });
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.happyDOM.abort();
});
