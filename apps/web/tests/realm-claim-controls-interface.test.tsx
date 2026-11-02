import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import type {
  RealmClaimAdapter,
  RealmClaimInput,
  RealmClaimRead,
  RealmClaimResult,
} from '../src/community/realm-claim';
import { eligible, orphan, receipt } from '../src/stories/patterns/realm-claim/example';
import * as start from '../.storybook/react-start';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/realms/example' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const unexpectedNative = () => {
  throw new Error('Unexpected native call');
};
mock.module('../src/community/space-actions', () => ({
  readRealmClaimState: unexpectedNative,
  submitRealmClaim: unexpectedNative,
  readOwnRealmClaimStatus: unexpectedNative,
}));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { RealmClaimPanel } = await import('../src/community/realm-claim-panel');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const viewer = (csrfToken = 'original') => ({ state: 'signed-in', subject: 'claimant', csrfToken });
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
let client: InstanceType<typeof QueryClient>;
let clipboardDescriptor: PropertyDescriptor | undefined;
const deferred = <T,>() => Promise.withResolvers<T>();
const onRead = () => {};
async function paint(adapter: RealmClaimAdapter, realmId = orphan.realmId) {
  if (!root) {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, viewer());
    root = createRoot(host);
    setLocale('en', { reload: false });
  }
  const props = { realmId, initial: orphan, adapter, returnTo: '/spaces/example', onRead };
  await act(async () =>
    root!.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <RealmClaimPanel {...props} />
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
}
const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label);
async function click(label: string) {
  const node = button(label);
  expect(node).toBeDefined();
  await act(async () => node!.click());
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  client?.clear();
  if (clipboardDescriptor) Object.defineProperty(window.navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(window.navigator, 'clipboard');
  clipboardDescriptor = undefined;
});
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('A claimant can submit an eligible claim, see its actual result, and resume uncertainty without carrying a claim or private receipt into a different Realm or session.', async () => {
  const calls: RealmClaimInput[] = [];
  let reply = deferred<RealmClaimResult>();
  let read = Promise.resolve<RealmClaimRead>(eligible);
  const adapter: RealmClaimAdapter = {
    read: () => read,
    mine: async () => ({ kind: 'ready', source: orphan, claimRequest: null }),
    request: async (input) => {
      calls.push(input);
      return reply.promise;
    },
  };
  await paint(adapter);
  const submit = button(m.realm_claim_request())!;
  await act(async () => {
    submit.click();
    submit.click();
  });
  expect(calls).toHaveLength(1);
  await act(async () => reply.resolve({ kind: 'unavailable' }));
  expect(host.textContent).toContain(m.realm_claim_uncertain());
  await click(m.realm_claim_refresh());
  reply = deferred<RealmClaimResult>();
  await click(m.realm_claim_retry());
  expect(calls).toEqual([calls[0]!, calls[0]!]);
  await act(async () => reply.resolve({ kind: 'pending', request: receipt }));
  expect(host.textContent).toContain(m.realm_claim_pending());
  expect(host.textContent).not.toContain(m.realm_claim_uncertain());
  expect(host.textContent).toContain(receipt.requestId);
  expect([...host.querySelectorAll('time')].map((node) => node.dateTime)).toEqual([
    orphan.orphanedAt!,
    orphan.claimEligibleAt!,
    receipt.requestedAt,
  ]);
  expect(host.querySelector('a')?.getAttribute('href')).toContain(`/claim-requests/${receipt.requestId}`);
  expect(button(m.realm_claim_request())).toBeUndefined();
  expect(button(m.realm_claim_retry())).toBeUndefined();

  // A same-account CSRF change retires eligibility and the receipt before a new read settles.
  const freshRead = deferred<RealmClaimRead>();
  read = freshRead.promise;
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer('replacement'));
  });
  expect(host.innerHTML).not.toContain(receipt.requestId);
  expect(button(m.realm_claim_request())).toBeUndefined();
  // Reusing an old page payload for another Realm cannot supply eligibility there.
  await paint(adapter, '01a1a000-0000-7000-8000-000000000098');
  await act(async () => freshRead.resolve(eligible));
  expect(host.innerHTML).not.toContain(receipt.requestId);
  expect(button(m.realm_claim_request())).toBeUndefined();
});

test('bounded recovery replaces uncertainty with the supplied outcome; retired sends cannot publish a receipt', async () => {
  let found = false;
  let reply = deferred<RealmClaimResult>();
  const approvedAt = '2026-10-31T12:34:56.123456Z';
  const adapter: RealmClaimAdapter = {
    read: async () => eligible,
    mine: async () => ({
      kind: 'ready',
      source: orphan,
      claimRequest: found
        ? {
            realmId: receipt.realmId,
            requestId: receipt.requestId,
            state: 'approved',
            orphanedAt: receipt.orphanedAt,
            requestedAt: receipt.requestedAt,
            approvedAt,
            currentEpisode: true,
          }
        : null,
    }),
    request: async () => reply.promise,
  };
  await paint(adapter);
  await click(m.realm_claim_request());
  await act(async () => reply.resolve({ kind: 'unavailable' }));
  found = true;
  await click(m.realm_claim_refresh());
  expect(host.textContent).toContain(m.realm_claim_status_approved());
  expect(host.textContent).not.toContain(m.realm_claim_uncertain());
  expect(host.querySelector(`time[datetime="${approvedAt}"]`)?.textContent).toContain(approvedAt);
  expect(button(m.realm_claim_retry())).toBeUndefined();
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null });
  });
  expect(host.innerHTML).not.toContain(receipt.requestId);
  expect(host.textContent).toContain(m.realm_claim_sign_in());
  found = false;
  reply = deferred<RealmClaimResult>();
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer());
  });
  await click(m.realm_claim_request());
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null });
    client.setQueryData(sessionQuery.queryKey, viewer());
    reply.resolve({ kind: 'pending', request: receipt });
  });
  expect(host.innerHTML).not.toContain(receipt.requestId);
  expect(button(m.realm_claim_retry())).toBeUndefined();
});

test('clipboard denial selects the current reference; superseded and retired writes cannot restore it', async () => {
  let write: () => Promise<void> = () => Promise.reject(new Error('denied'));
  let currentRequest = receipt;
  clipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => write() },
  });
  const adapter: RealmClaimAdapter = {
    read: async () => eligible,
    mine: async () => ({ kind: 'ready', source: orphan, claimRequest: currentRequest }),
    request: async () => ({ kind: 'pending', request: receipt }),
  };
  await paint(adapter);
  await click(m.realm_claim_request());
  await act(async () => {
    host.querySelector('details summary')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await click(m.realm_claim_copy());
  const fallback = host.querySelector<HTMLInputElement>('input[readonly]')!;
  expect(fallback.value).toBe(receipt.requestId);
  expect(fallback.readOnly).toBe(true);
  expect(host.querySelector(`label[for="${fallback.id}"]`)?.textContent).toBe(m.realm_claim_copy_fallback_label());
  expect(window.document.activeElement).toBe(fallback);
  expect(fallback.selectionStart).toBe(0);
  expect(fallback.selectionEnd).toBe(receipt.requestId.length);
  await click(m.realm_claim_copy_close());
  expect(window.document.activeElement).toBe(button(m.realm_claim_copy()));

  const superseded = deferred<void>();
  write = () => superseded.promise;
  await click(m.realm_claim_copy());
  currentRequest = { ...receipt, requestId: '018f0000-0000-7000-8000-000000000111' };
  await click(m.realm_claim_refresh());
  expect(host.textContent).toContain(currentRequest.requestId);
  await act(async () => superseded.resolve());
  expect(host.textContent).not.toContain(receipt.requestId);
  expect(host.textContent).not.toContain(m.realm_claim_copied());
  expect(host.querySelector('input[readonly]')).toBeNull();

  const retired = deferred<void>();
  write = () => retired.promise;
  await click(m.realm_claim_copy());
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null });
  });
  await act(async () => retired.reject(new Error('denied')));
  expect(host.textContent).not.toContain(currentRequest.requestId);
  expect(host.textContent).not.toContain(m.realm_claim_copy_failed());
});

test.each(['submit', 'retry', 'pointer', 'move', 'input', 'realm', 'session', 'recover'])(
  'receipt keyboard handoff through the caller: %s',
  async (scenario) => {
    let reply = deferred<RealmClaimResult>();
    let recovered = false;
    const calls: RealmClaimInput[] = [];
    const adapter: RealmClaimAdapter = {
      read: async () => eligible,
      mine: async () => ({
        kind: 'ready',
        source: orphan,
        claimRequest: recovered
          ? { ...receipt, state: 'approved', approvedAt: '2026-10-31T12:34:56.123456Z', currentEpisode: true }
          : null,
      }),
      request: async (input) => {
        calls.push(input);
        return reply.promise;
      },
    };
    await paint(adapter);
    const activate = (label: string, detail = 0) =>
      act(async () => {
        const node = button(label)!;
        node.focus();
        node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail }));
      });
    await activate(m.realm_claim_request(), scenario === 'pointer' ? 1 : 0);
    if (scenario === 'retry' || scenario === 'recover') {
      await act(async () => reply.resolve({ kind: 'unavailable' }));
      expect(host.querySelector('h3')).toBeNull();
      reply = deferred<RealmClaimResult>();
      recovered = scenario === 'recover';
      await activate(recovered ? m.realm_claim_refresh() : m.realm_claim_retry());
    }
    await act(async () => {
      if (scenario === 'move') {
        const heading = host.querySelector('h2')!;
        heading.tabIndex = -1;
        heading.focus();
        heading.blur();
      }
      if (scenario === 'input') host.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      if (scenario === 'session') client.setQueryData(sessionQuery.queryKey, viewer('replacement'));
    });
    if (scenario === 'realm') await paint(adapter, '01a1a000-0000-7000-8000-000000000098');
    if (!recovered) await act(async () => reply.resolve({ kind: 'pending', request: receipt }));
    const heading = host.querySelector('h3');
    expect(window.document.activeElement === heading).toBe(scenario === 'submit' || scenario === 'retry');
    expect(host.querySelector('details')?.open ?? false).toBe(false);
    if (recovered) {
      expect(heading?.textContent).toBe(m.realm_claim_status_approved());
      expect(window.document.activeElement).toBe(button(m.realm_claim_refresh()));
    }
    expect(calls).toHaveLength(scenario === 'retry' ? 2 : 1);
    if (scenario === 'retry') expect(calls[1]).toEqual(calls[0]);
  },
);
