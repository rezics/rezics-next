import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import type { BanReadState, BanWriteInput } from '../src/community/realm-bans';

// Actual default caller, real session cache, original server handlers and generated native
// client. Only browser/server plumbing and HTTP responses are supplied. Authored; UNRUN.
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const realmId = id(10);
const viewer = (subject = id(1), csrfToken: string | null = 'original-csrf') => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});
const account = {
  id: id(2),
  kind: 'actor',
  state: 'active',
  handle: 'river',
  displayName: 'Private reviewed person',
  automated: false,
  operatorId: null,
};
const row = { accountId: account.id, reason: 'Private native ban reason', actor: id(1), at: '2026-10-31T10:00:00Z' };
const receipt = { ...row, realmId, workflowId: 'removal-pending' };
type Pending = ReturnType<typeof deferred<Response>> & { request: Request };
const lists: Pending[] = [];
const lookups: Pending[] = [];
const writes: Pending[] = [];
const boundaries: { data: unknown; headers?: Record<string, string> }[] = [];
let responseGate: ReturnType<typeof deferred<void>> | undefined;
const native = createKernelClient('https://kernel.test', {
  fetch: async (url, init) => {
    const request = new Request(url, init);
    expect(request.headers.get('authorization')).toBe('Bearer original-native-reader');
    const pending = { ...deferred<Response>(), request };
    const path = new URL(request.url);
    if (request.method === 'GET' && path.pathname.endsWith('/bans')) {
      expect(path.searchParams.get('limit')).toBe('20');
      lists.push(pending);
    } else if (request.method === 'GET' && path.pathname === '/v1/accounts') {
      expect(Object.fromEntries(path.searchParams)).toEqual({ handle: 'river' });
      lookups.push(pending);
    } else {
      expect(['PUT', 'DELETE']).toContain(request.method);
      writes.push(pending);
    }
    return pending.promise;
  },
});
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn: () => {
    const original = start.createServerFn();
    const chain = {
      validator(next: (input: unknown) => unknown) {
        original.validator(next);
        return chain;
      },
      handler<T extends (...args: never[]) => unknown>(handler: T): T {
        const invoke = original.handler(handler);
        return ((input: unknown) => {
          const boundary = input as { data: unknown; headers?: Record<string, string> };
          if (boundary && 'data' in boundary) boundaries.push(boundary);
          // Defer the original server-function's response independently of native completion.
          const gate = responseGate;
          responseGate = undefined;
          return Promise.resolve(invoke(input as never)).then(async (value) => {
            await gate?.promise;
            return value;
          });
        }) as unknown as T;
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () =>
    new Request('https://site.test/action', {
      headers: { authorization: 'Bearer original-native-reader' },
    }),
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const originalKernel = { ...(await import('../src/kernel/client')) };
mock.module('../src/kernel/client', () => ({ ...originalKernel, kernelClient: () => native }));
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { RealmBansPanel } = await import('../src/community/realm-bans-panel');
const { RealmBansControl } = await import('../src/community/realm-bans-control');
const actions = await import('../src/community/space-actions');
const { m } = await import('../src/paraglide/messages.js');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let mounted = false;
let client: InstanceType<typeof QueryClient>;
let currentRealm = realmId;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function paint(content = <RealmBansPanel realmId={currentRealm} />) {
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>{content}</QueryClientProvider>
      </StrictMode>,
    );
    await tick();
  });
}
async function close() {
  if (!mounted) return;
  await act(async () => {
    root.unmount();
    await tick();
  });
  mounted = false;
  client.clear();
}
async function mount(session: unknown = viewer()) {
  await close();
  currentRealm = realmId;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session);
  root = createRoot(host);
  mounted = true;
  await paint();
}
function button(label: string) {
  const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(node).toBeDefined();
  return node!;
}
const click = (label: string) =>
  act(async () => {
    button(label).click();
    await tick();
  });
async function edit(tag: 'input' | 'textarea', value: string) {
  const element = host.querySelector(tag)!;
  expect(element).not.toBeNull();
  await act(async () => {
    const prototype = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function settle(pending: Pending, response: Response) {
  await act(async () => {
    pending.resolve(response);
    await tick();
  });
}
async function list(pending = lists.at(-1)!, items = [row], next: string | null = 'opaque-next') {
  await settle(pending, Response.json({ items, next }));
}
async function lookup(pending = lookups.at(-1)!, value = account) {
  await settle(pending, Response.json({ accounts: [value] }));
}
async function review() {
  await edit('input', '@river');
  await click(m.realm_bans_target_lookup());
  await lookup();
  await click(m.realm_bans_target_select());
  await edit('textarea', 'Private command reason');
  await click(m.realm_bans_ban());
}
function hidden() {
  for (const text of [row.reason, account.displayName, 'Private command reason', m.realm_bans_removal_pending()])
    expect(host.textContent).not.toContain(text);
  expect(host.querySelector('textarea')).toBeNull();
  expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.realm_bans_next())).toBe(false);
}
function clean() {
  expect(host.querySelector('input')?.value).toBe('');
  expect(host.querySelector('textarea')?.value).toBe('');
  expect(host.textContent).not.toContain(account.displayName);
  expect(host.textContent).not.toContain(m.realm_bans_removal_pending());
  expect(host.textContent).not.toContain(m.realm_bans_write_unavailable());
}
afterAll(async () => {
  await close();
  mock.restore();
  host.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Default Realm ban management retains original reader and command lifetime across session readiness replacement and fences obsolete queued native reads and writes', async () => {
  // Unknown/preparing/absent CSRF never even starts a private native list.
  for (const session of [
    { state: 'unknown', subject: null, csrfToken: null },
    { state: 'preparing', subject: id(1), csrfToken: 'preparing-token' },
    { state: 'signed-out', subject: null, csrfToken: null },
    viewer(id(1), null),
  ]) {
    const count = lists.length;
    await mount(session);
    hidden();
    expect(lists).toHaveLength(count);
  }

  // Every cache transition retires each kind of private work, even if React sees only
  // the original tuple again. Replacement current reads stay pending until explicitly settled.
  const replacements = [
    () => client.setQueryData(sessionQuery.queryKey, viewer(id(3))),
    () => client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null }),
    () =>
      client.setQueryData(sessionQuery.queryKey, { state: 'preparing', subject: id(1), csrfToken: 'original-csrf' }),
    () => client.setQueryData(sessionQuery.queryKey, viewer(id(1), null)),
    () => client.setQueryData(sessionQuery.queryKey, viewer(id(1), 'replacement-csrf')),
    () => {
      client.setQueryData(sessionQuery.queryKey, viewer(id(3), 'away-csrf'));
      client.setQueryData(sessionQuery.queryKey, viewer());
    },
  ];
  for (const replace of replacements) {
    for (const phase of ['list', 'lookup', 'revalidation', 'write', 'uncertain', 'receipt'] as const) {
      await mount();
      const oldList = lists.at(-1)!;
      let oldLookup: Pending | undefined;
      let oldWrite: Pending | undefined;
      let originalResponse: ReturnType<typeof deferred<void>> | undefined;
      if (phase !== 'list') {
        await list(oldList);
        if (phase === 'lookup') {
          await edit('input', '@river');
          await click(m.realm_bans_target_lookup());
          oldLookup = lookups.at(-1)!;
        } else {
          await review();
          await click(m.realm_bans_confirm_ban());
          oldLookup = lookups.at(-1)!;
          if (phase !== 'revalidation') {
            originalResponse = deferred<void>();
            if (phase === 'write') responseGate = originalResponse;
            await lookup(oldLookup);
            oldWrite = writes.at(-1)!;
            if (phase === 'uncertain') {
              await act(async () => {
                oldWrite!.reject(new TypeError('Failed to fetch'));
                await tick();
              });
              expect(host.textContent).toContain(m.realm_bans_write_unavailable());
            } else if (phase === 'receipt') {
              await settle(oldWrite, Response.json({ ban: receipt }));
              await list();
              expect(host.textContent).toContain(m.realm_bans_removal_pending());
            }
          }
        }
      }
      const sendCount = writes.length;
      await act(async () => {
        replace();
        await tick();
      });
      hidden();
      const afterReplacement = lists.length;
      if (phase === 'list') await list(oldList);
      if (oldLookup && (phase === 'lookup' || phase === 'revalidation')) await lookup(oldLookup);
      if (phase === 'write') {
        // Definitive remote success followed by a delayed original server-function response
        // cannot refresh, become uncertainty, or disturb the replacement operation.
        await settle(oldWrite!, Response.json({ ban: receipt }));
        await act(async () => {
          originalResponse!.resolve();
          await tick();
        });
      }
      hidden();
      expect(writes).toHaveLength(sendCount);
      expect(lists).toHaveLength(afterReplacement);
      await act(async () => {
        client.setQueryData(sessionQuery.queryKey, viewer());
        await tick();
      });
      const fresh = lists.at(-1)!;
      expect(fresh).not.toBe(oldList);
      await list(fresh);
      clean();
      // Fresh ordinary input recovers; no obsolete working guard survives retirement.
      expect(button(m.realm_bans_target_lookup()).disabled).toBe(true); // Empty input.
      expect(button(m.realm_bans_refresh()).disabled).toBe(false);
    }
  }

  // A discarded original write must not clear its successor's synchronous busy owner.
  await mount();
  await list();
  await review();
  await click(m.realm_bans_confirm_ban());
  const heldResponse = deferred<void>();
  responseGate = heldResponse;
  await lookup();
  const obsoleteWrite = writes.at(-1)!;
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer(id(1), 'successor-csrf'));
    await tick();
  });
  hidden();
  await list();
  await review();
  await click(m.realm_bans_confirm_ban());
  await lookup();
  const successorWrite = writes.at(-1)!;
  const successorReads = lists.length;
  await settle(obsoleteWrite, Response.json({ ban: receipt }));
  await act(async () => {
    heldResponse.resolve();
    await tick();
  });
  expect(button(m.realm_bans_confirm_ban()).disabled).toBe(true);
  expect(host.textContent).not.toContain(m.realm_bans_removal_pending());
  expect(host.textContent).not.toContain(m.realm_bans_write_unavailable());
  expect(lists).toHaveLength(successorReads);
  await settle(
    successorWrite,
    Response.json({ detail: 'Remove the Realm owner or moderator role first' }, { status: 409 }),
  );
  expect(button(m.realm_bans_confirm_ban()).disabled).toBe(false);
  expect(host.textContent).toContain(m.realm_bans_role_required());

  // Late denial and transport rejection cannot hide fresh data or fabricate uncertainty.
  for (const late of ['denial', 'rejection'] as const) {
    await mount();
    await list();
    await review();
    await click(m.realm_bans_confirm_ban());
    await lookup();
    const old = writes.at(-1)!;
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, viewer(id(1), 'new-csrf'));
      await tick();
    });
    await list();
    const count = lists.length;
    if (late === 'denial') await settle(old, Response.json({ code: 'forbidden' }, { status: 403 }));
    else
      await act(async () => {
        old.reject(new TypeError('Failed to fetch'));
        await tick();
      });
    expect(host.textContent).toContain(row.reason);
    expect(host.textContent).not.toContain(m.realm_bans_forbidden());
    expect(host.textContent).not.toContain(m.realm_bans_write_unavailable());
    expect(lists).toHaveLength(count);
    clean();
  }
  await mount();
  const obsoleteList = lists.at(-1)!;
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer(id(1), 'current-csrf'));
    await tick();
  });
  await list();
  await settle(obsoleteList, Response.json({ code: 'forbidden' }, { status: 403 }));
  expect(host.textContent).toContain(row.reason);
  expect(host.textContent).not.toContain(m.realm_bans_forbidden());

  // Queued caller reads/lookups/revalidations and commands are fenced before transport.
  for (const kind of ['refresh', 'lookup', 'revalidation', 'unban'] as const) {
    await mount();
    await list();
    if (kind === 'lookup') await edit('input', '@river');
    if (kind === 'revalidation') await review();
    if (kind === 'unban') await click(m.realm_bans_unban());
    const counts = [lists.length, lookups.length, writes.length];
    const label =
      kind === 'refresh'
        ? m.realm_bans_refresh()
        : kind === 'lookup'
          ? m.realm_bans_target_lookup()
          : kind === 'revalidation'
            ? m.realm_bans_confirm_ban()
            : m.realm_bans_confirm();
    await act(async () => {
      button(label).click();
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
      await tick();
    });
    hidden();
    expect([lists.length, lookups.length, writes.length]).toEqual(counts);
  }

  for (const kind of ['refresh', 'unban'] as const) {
    await mount();
    await list();
    if (kind === 'unban') await click(m.realm_bans_unban());
    const counts = [lists.length, lookups.length, writes.length];
    await act(async () => {
      button(kind === 'refresh' ? m.realm_bans_refresh() : m.realm_bans_confirm()).click();
      flushSync(() => root.unmount());
      mounted = false;
      await tick();
    });
    hidden();
    expect([lists.length, lookups.length, writes.length]).toEqual(counts);
    client.clear();
  }

  // Realm, actual QueryClient source and unmount replacement retire original callbacks.
  for (const kind of ['realm', 'source', 'unmount'] as const) {
    await mount();
    await list();
    await review();
    await click(m.realm_bans_confirm_ban());
    const oldLookup = lookups.at(-1)!;
    const sendCount = writes.length;
    const originalClient = client;
    if (kind === 'realm') {
      currentRealm = id(11);
      await paint();
    }
    if (kind === 'source') {
      client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(sessionQuery.queryKey, viewer());
      await paint();
    }
    if (kind === 'unmount') await close();
    hidden();
    const count = lists.length;
    await lookup(oldLookup);
    expect(writes).toHaveLength(sendCount);
    expect(lists).toHaveLength(count);
    hidden();
    originalClient.clear();
    if (kind !== 'unmount') {
      await list();
      clean();
    }
  }

  // Current native sparse continuation, cursor refusal/restart, and bounded20 render.
  await mount();
  await list(lists.at(-1), [], 'sparse-next');
  expect(host.textContent).toContain(m.realm_bans_empty());
  const recoveryReads = lists.length;
  const recoveryWrites = writes.length;
  await click(m.realm_bans_next());
  expect(new URL(lists.at(-1)!.request.url).searchParams.get('cursor')).toBe('sparse-next');
  await settle(lists.at(-1)!, Response.json({ code: 'unavailable' }, { status: 503 }));
  expect(lists).toHaveLength(recoveryReads + 1);
  expect(window.document.activeElement).toBe(button(m.realm_bans_read_retry()));
  await click(m.realm_bans_read_retry());
  expect(lists).toHaveLength(recoveryReads + 2);
  expect(new URL(lists.at(-1)!.request.url).searchParams.get('cursor')).toBe('sparse-next');
  await list(lists.at(-1), [], 'expired-next');
  expect(window.document.activeElement).toBe(host.querySelector('h2'));
  await click(m.realm_bans_next());
  expect(new URL(lists.at(-1)!.request.url).searchParams.get('cursor')).toBe('expired-next');
  await settle(lists.at(-1)!, Response.json({ code: 'invalid_cursor' }, { status: 400 }));
  expect(host.textContent).toContain(m.realm_bans_cursor_invalid());
  expect(lists).toHaveLength(recoveryReads + 3);
  expect(window.document.activeElement).toBe(button(m.realm_bans_restart()));
  expect(
    [...host.querySelectorAll('button')].some((node) => node.textContent === m.realm_bans_read_retry()),
  ).toBe(false);
  await click(m.realm_bans_restart());
  expect(lists).toHaveLength(recoveryReads + 4);
  expect(new URL(lists.at(-1)!.request.url).searchParams.has('cursor')).toBe(false);
  await list(
    lists.at(-1),
    Array.from({ length: 20 }, (_, n) => ({ ...row, accountId: id(100 + n) })),
    null,
  );
  expect(host.querySelectorAll('li')).toHaveLength(20);
  expect(writes).toHaveLength(recoveryWrites);

  // Editing a reason while exact lookup is pending does not strand that lookup.
  // Revalidation failure releases the current busy owner; identity changes never send.
  await mount();
  await list();
  await edit('input', '@river');
  await click(m.realm_bans_target_lookup());
  await edit('textarea', 'Private command reason');
  await lookup();
  expect(host.textContent).toContain(account.displayName);
  await click(m.realm_bans_target_select());
  await click(m.realm_bans_ban());
  const count = writes.length;
  await click(m.realm_bans_confirm_ban());
  await lookup(lookups.at(-1), { ...account, displayName: 'Changed identity' });
  expect(writes).toHaveLength(count);
  expect(host.textContent).toContain(m.realm_bans_target_changed());
  expect(button(m.realm_bans_refresh()).disabled).toBe(false);
  await review();
  await click(m.realm_bans_confirm_ban());
  await act(async () => {
    lookups.at(-1)!.reject(new Error('lookup unavailable'));
    await tick();
  });
  expect(host.textContent).toContain(m.realm_bans_target_unavailable());
  expect(button(m.realm_bans_refresh()).disabled).toBe(false);

  // A rapid repeated activation owns revalidation through send as one operation.
  await review();
  const beforeLookup = lookups.length;
  const beforeWrite = writes.length;
  await act(async () => {
    const confirm = button(m.realm_bans_confirm_ban());
    confirm.click();
    confirm.click();
    await tick();
  });
  expect(lookups).toHaveLength(beforeLookup + 1);
  await lookup();
  expect(writes).toHaveLength(beforeWrite + 1);
  expect(button(m.realm_bans_confirm_ban()).disabled).toBe(true);
  const first = writes.at(-1)!;
  expect(first.request.method).toBe('PUT');
  expect(new URL(first.request.url).pathname).toBe(`/v1/realms/${realmId}/bans/${account.id}`);
  expect(await first.request.clone().json()).toEqual({ reason: 'Private command reason' });
  expect(boundaries.at(-1)!.headers).toEqual({ 'X-CSRF-Token': 'original-csrf' });
  const exact = boundaries.at(-1)!.data as BanWriteInput;
  const readsBeforeFailure = lists.length;
  await act(async () => {
    first.reject(new TypeError('Failed to fetch'));
    await tick();
  });
  expect(host.textContent).toContain(m.realm_bans_write_unavailable());
  expect(button(m.realm_bans_refresh()).disabled).toBe(true);
  await click(m.realm_bans_refresh());
  expect(lists).toHaveLength(readsBeforeFailure);
  await click(m.realm_bans_retry());
  expect(boundaries.at(-1)!.data).toEqual(exact);
  expect(writes.at(-1)!.request.headers.get('idempotency-key')).toBe(first.request.headers.get('idempotency-key'));
  expect(lookups).toHaveLength(beforeLookup + 1); // Exact uncertain retry does not invent a fresh intent.
  await settle(writes.at(-1)!, Response.json({ ban: receipt }));
  expect(lists).toHaveLength(readsBeforeFailure + 1);
  expect(host.textContent).toContain(m.realm_bans_removal_pending());
  await settle(lists.at(-1)!, Response.json({ code: 'unavailable' }, { status: 503 }));
  expect(host.textContent).toContain(m.realm_bans_removal_pending());
  expect(host.textContent).not.toContain(m.realm_bans_write_unavailable());
  await click(m.realm_bans_read_retry());
  expect(writes).toHaveLength(beforeWrite + 2);
  expect(new URL(lists.at(-1)!.request.url).searchParams.has('cursor')).toBe(false);
  await list();
  await click(m.realm_bans_unban());
  await click(m.realm_bans_confirm());
  expect(writes.at(-1)!.request.method).toBe('DELETE');
  await settle(writes.at(-1)!, new Response(null, { status: 204 }));
  await list(lists.at(-1), [], null);
  expect(host.textContent).toContain(m.realm_bans_lifted());
  expect(host.textContent).not.toContain(m.realm_bans_removal_pending());

  // Current native permission results remain authoritative, including role-required409.
  for (const denial of ['role-required', 'forbidden', 'closed', 'signed-out'] as const) {
    await mount();
    await list();
    await review();
    await click(m.realm_bans_confirm_ban());
    await lookup();
    const status = denial === 'role-required' ? 409 : denial === 'forbidden' ? 403 : denial === 'closed' ? 403 : 401;
    const body =
      denial === 'role-required'
        ? { detail: 'Remove the Realm owner or moderator role first' }
        : denial === 'closed'
          ? { code: 'platform_closed' }
          : { code: denial };
    const reads = lists.length;
    await settle(writes.at(-1)!, Response.json(body, { status }));
    expect(lists).toHaveLength(reads);
    const text =
      denial === 'role-required'
        ? m.realm_bans_role_required()
        : denial === 'forbidden'
          ? m.realm_bans_forbidden()
          : denial === 'closed'
            ? m.realm_bans_closed()
            : m.realm_bans_signed_out();
    expect(host.textContent).toContain(text);
    if (denial === 'role-required') expect(host.querySelector('input')?.value).toBe('@river');
    else expect(host.querySelector('textarea')).toBeNull();
    expect(host.textContent).not.toContain(m.realm_bans_write_unavailable());
  }

  // Standalone compatibility also fences readiness/source/read-generation replacement.
  const read = (cursor?: string) => actions.readRealmBans({ data: { realmId, ...(cursor ? { cursor } : {}) } });
  const write = (data: BanWriteInput) => actions.changeRealmBan({ data });
  const resolve = (data: string, signal: AbortSignal) => actions.resolveRealmBanTarget({ data, signal });
  const initial: BanReadState = { state: 'ready', page: { items: [row], next: 'fixture-next' } };
  await mount();
  await paint(
    <RealmBansControl realmId={realmId} ready initial={initial} read={read} write={write} resolve={resolve} />,
  );
  await review();
  const retiredButton = button(m.realm_bans_confirm_ban());
  await paint(
    <RealmBansControl realmId={realmId} ready={false} initial={initial} read={read} write={write} resolve={resolve} />,
  );
  hidden();
  await paint(
    <RealmBansControl realmId={realmId} ready initial={initial} read={read} write={write} resolve={resolve} />,
  );
  hidden(); // Original initial cannot return; a new current native page can.
  await list();
  clean();
  const sends = writes.length;
  await act(async () => {
    retiredButton.click();
    await tick();
  });
  expect(writes).toHaveLength(sends);
  const replacementRead = (cursor?: string) => read(cursor);
  await paint(
    <RealmBansControl
      realmId={realmId}
      ready
      initial={initial}
      read={replacementRead}
      write={write}
      resolve={resolve}
    />,
  );
  hidden();
  await list();
  clean();
  // A distinct incoming read generation replaces private data and selection immediately.
  const freshInitial: BanReadState = { state: 'ready', page: { items: [], next: null } };
  await review();
  await paint(
    <RealmBansControl
      realmId={realmId}
      ready
      initial={freshInitial}
      read={replacementRead}
      write={write}
      resolve={resolve}
    />,
  );
  clean();
  expect(host.textContent).not.toContain(row.reason);
  await act(async () => {
    flushSync(() => root.unmount());
    root = createRoot(host);
    flushSync(() =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <RealmBansControl
              realmId={realmId}
              ready
              initial={freshInitial}
              read={replacementRead}
              write={write}
              resolve={resolve}
            />
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
    await tick();
  });
  hidden();
  await list();
  clean();
  expect(writes).toHaveLength(sends);
}, 60_000);
