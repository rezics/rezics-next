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
