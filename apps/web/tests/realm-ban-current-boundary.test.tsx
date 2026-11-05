import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import { loadRealmBans, type RealmBanPage } from '../src/community/realm-bans';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/spaces/one' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const realmId = id(100);
const requests: Request[] = [];
let page: RealmBanPage = { items: [], next: null };
const native = createKernelClient('https://kernel.test', {
  fetch: async (url, init) => {
    const request = new Request(url, init);
    requests.push(request);
    expect(new URL(request.url).pathname).toBe(`/v1/realms/${realmId}/bans`);
    expect(request.method).toBe('GET');
    expect(new URL(request.url).searchParams.get('limit')).toBe('20');
    return Response.json(page);
  },
});
const read = (cursor?: string) =>
  loadRealmBans(
    native,
    new Request('https://site.test/action', {
      headers: { authorization: 'Bearer original-reader' },
    }),
    {},
    { realmId, ...(cursor ? { cursor } : {}) },
  );
mock.module('../src/community/space-actions', () => ({
  readRealmBans: ({ data }: { data: { cursor?: string } }) => read(data.cursor),
  resolveRealmBanTarget: () => {
    throw new Error('Unexpected identity lookup');
  },
  changeRealmBan: () => {
    throw new Error('Inspection cannot submit commands');
  },
}));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { RealmBansPanel } = await import('../src/community/realm-bans-panel');
const { RealmBansControl } = await import('../src/community/realm-bans-control');
const { m } = await import('../src/paraglide/messages.js');
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
let cache: InstanceType<typeof QueryClient>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function close() {
  if (root)
    await act(async () => {
      root!.unmount();
      await tick();
    });
  root = undefined;
  cache?.clear();
}
async function mount() {
  await close();
  requests.length = 0;
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: id(200), csrfToken: 'original-csrf' });
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={cache}>
        <RealmBansPanel realmId={realmId} />
      </QueryClientProvider>,
    );
    await tick();
  });
}
function button(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(Boolean(node)).toBe(true);
  return node!;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
    await tick();
  });
}
async function select(accountId = id(999)) {
  const input = host.querySelectorAll('input')[1]!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, accountId);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await click(m.realm_bans_inspect_action());
}
afterAll(async () => {
  await close();
  host.remove();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.close();
});

test('legacy pages retain unavailable exact observations through the installed adapter for 1/10/20 rows', async () => {
  let previousBytes = 0;
  for (const count of [1, 10, 20]) {
    page = {
      items: Array.from({ length: count }, (_, n) => ({
        accountId: id(n + 1),
        actor: n % 2 ? null : id(201),
        reason: 'Actual reason',
        at: '2026-11-02T14:05:00Z',
      })),
      next: 'opaque-next',
    };
    const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
    expect(bytes).toBeGreaterThan(previousBytes);
    expect(bytes).toBeLessThan(256 * count + 128);
    previousBytes = bytes;
    await mount();
    expect(host.querySelectorAll('li').length).toBe(count);
    await select();
    expect(host.textContent).toContain(m.realm_bans_inspect_unavailable());
    expect(host.textContent).toContain(id(999));
    await click(m.realm_bans_inspect_retry());
    expect(requests.length).toBe(3);
    await click(m.realm_bans_next());
    await click(m.thread_authoring_leave());
    expect(new URL(requests[3]!.url).searchParams.get('cursor')).toBe('opaque-next');
    expect(host.textContent).not.toContain(id(999));
    expect(host.querySelectorAll('li').length).toBe(count);
    await select();
    await act(async () => {
      cache.setQueryData(sessionQuery.queryKey, { state: 'signed-out' });
      await tick();
    });
    expect(host.textContent).not.toContain(id(999));
    expect(host.querySelectorAll('li').length).toBe(0);
  }
});

test('sparse continuation survives unavailable inspection; source replacement fences duplicate and late reads', async () => {
  page = { items: [], next: 'sparse-next' };
  await mount();
  await select();
  await click(m.realm_bans_next());
  await click(m.thread_authoring_leave());
  expect(new URL(requests[2]!.url).searchParams.get('cursor')).toBe('sparse-next');
  await close();
  let finish!: (value: { state: 'unavailable' }) => void;
  let inspections = 0;
  const inspect = () => {
    inspections++;
    return new Promise<{ state: 'unavailable' }>((resolve) => {
      finish = resolve;
    });
  };
  const write = async () => ({ ok: false as const, reason: 'unavailable' as const });
  const initial = { state: 'ready' as const, page };
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <RealmBansControl realmId={realmId} ready initial={initial} read={read} write={write} inspect={inspect} />,
    );
    await tick();
  });
  await select();
  await click(m.realm_bans_inspect_retry());
  expect(inspections).toBe(1);
  await act(async () => {
    root!.render(
      <RealmBansControl realmId={id(101)} ready initial={{ state: 'ready', page }} read={read} write={write} />,
    );
    await tick();
    finish({ state: 'unavailable' });
    await tick();
  });
  expect(host.textContent).not.toContain(id(999));
  expect(host.textContent).not.toContain(m.realm_bans_inspect_unavailable());
});
