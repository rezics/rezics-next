import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import type {
  RealmClaimApprovalInput,
  RealmClaimApprovalResult,
  RealmClaimReviewRead,
  RealmClaimReviewRequest,
} from '../src/community/realm-claim-review';
import type {
  RealmClaimAdapter,
  RealmClaimInput,
  RealmClaimResult,
  RealmClaimSnapshot,
} from '../src/community/realm-claim';
import type { RealmClaimStatusInput, RealmClaimStatusRead } from '../src/community/realm-claim-status';
import * as start from '../.storybook/react-start';

// Actual panels and controllers with the real session QueryClient cache. Only their foreground
// server-function results are deferred so each retirement boundary can settle independently.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/realms/0192f3a0-6c1e-7b2a-9d4e-000000000010/claims' });
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
const requestId = id(20);
const replacementRequestId = id(21);
const reviewerId = id(30);
const claimantId = id(31);
const key = id(40);
const viewer = (subject = reviewerId, csrfToken: string | null = 'csrf-original') => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});

const row: RealmClaimReviewRequest = {
  realmId,
  requestId,
  claimantAccountId: claimantId,
  state: 'pending',
  orphanedAt: '2026-09-01T10:00:00.000Z',
  claimEligibleAt: '2026-10-01T10:00:00.000Z',
  requestedAt: '2026-10-31T10:00:00.000Z',
  claimant: { label: 'River Chen', href: '/@river' },
  approvalAdvice: {
    method: 'POST',
    destination: `/v1/realms/${realmId}/claimRequests/${requestId}:approve`,
    requiredAction: 'realm:approve_claim',
    requiredHeader: 'Idempotency-Key',
  },
};
const reviewPage = (rows: RealmClaimReviewRequest[] = [row], next: string | null = null): RealmClaimReviewRead => ({
  kind: 'ready',
  page: {
    claimRequests: rows,
    next,
    selectedRequest: rows[0]
      ? (({ realmId: _realm, ...row }) => ({ ...row, currentEpisode: true as const }))(rows[0])
      : null,
    realmPresentation: { state: 'unavailable' },
  },
});
const approvalReceipt = {
  realmId,
  requestId,
  claimantAccountId: claimantId,
  state: 'owned' as const,
  orphanedAt: row.orphanedAt,
  approvedAt: '2026-10-31T11:00:00.000Z',
};
const source: RealmClaimSnapshot = {
  realmId,
  spaceId: id(50),
  contextId: id(51),
  headRevisionId: id(52),
  ownershipState: 'orphaned',
  governanceReadOnly: true,
  orphanedAt: row.orphanedAt,
  claimEligibleAt: row.claimEligibleAt,
};
const statusRead = (targetRequestId: string, state: 'pending' | 'approved' = 'pending'): RealmClaimStatusRead => ({
  kind: 'ready',
  source,
  claimRequest: {
    realmId,
    requestId: targetRequestId,
    state,
    orphanedAt: row.orphanedAt,
    requestedAt: row.requestedAt,
    approvedAt: state === 'approved' ? '2026-10-31T11:00:00.000Z' : null,
    currentEpisode: true,
  },
});

type ReviewReadPending = ReturnType<typeof deferred<RealmClaimReviewRead>> & {
  input: { realmId: string; cursor?: string };
};
type ApprovalPending = ReturnType<typeof deferred<RealmClaimApprovalResult>> & {
  input: RealmClaimApprovalInput;
  headers?: Record<string, string>;
};
type StatusPending = ReturnType<typeof deferred<RealmClaimStatusRead>> & { input: RealmClaimStatusInput };
const reviewReads: ReviewReadPending[] = [];
const approvals: ApprovalPending[] = [];
const statusReads: StatusPending[] = [];
const requests: (ReturnType<typeof deferred<RealmClaimResult>> & { input: RealmClaimInput })[] = [];
const claimAdapter: RealmClaimAdapter = {
  read: async () => ({ kind: 'ready', snapshot: source, admission: 'allowed' }),
  request: (input) => {
    const pending = { ...deferred<RealmClaimResult>(), input };
    requests.push(pending);
    return pending.promise;
  },
};

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/community/realm-claim-review-actions', () => ({
  readRealmClaimReviewPage: ({ data }: { data: { realmId: string; cursor?: string } }) => {
    const pending = { ...deferred<RealmClaimReviewRead>(), input: data };
    reviewReads.push(pending);
    return pending.promise;
  },
  submitRealmClaimApproval: ({
    data,
    headers,
  }: {
    data: RealmClaimApprovalInput;
    headers?: Record<string, string>;
  }) => {
    const pending = { ...deferred<RealmClaimApprovalResult>(), input: data, headers };
    approvals.push(pending);
    return pending.promise;
  },
}));
mock.module('../src/community/space-actions', () => ({
  readRealmClaimState: () => {
    throw new Error('Unexpected native read');
  },
  submitRealmClaim: () => {
    throw new Error('Unexpected native request');
  },
  readOwnRealmClaimStatus: ({ data }: { data: RealmClaimStatusInput }) => {
    const pending = { ...deferred<RealmClaimStatusRead>(), input: data };
    statusReads.push(pending);
    return pending.promise;
  },
}));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { realmClaimCallerSessionSource } = await import('../src/community/realm-claim-caller-lifetime');
const { RealmClaimReviewPanel } = await import('../src/community/realm-claim-review-panel');
const { RealmClaimStatusPanel } = await import('../src/community/realm-claim-status-panel');
const { RealmClaimPanel } = await import('../src/community/realm-claim-panel');
const { AuthoringDepartureProvider, useAuthoringDeparture } = await import('../src/threads/authoring-departure');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { m } = await import('../src/paraglide/messages.js');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);

let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let mounted = false;
let router: ReturnType<typeof journeyRouter> | undefined;
let destination = deferred<void>();
let destinationReads = 0;
let siblingDirty = false;
function Sibling() {
  useAuthoringDeparture(() => siblingDirty, false, 'sibling');
  return null;
}
function journeyRouter() {
  const root = createRootRoute({ component: Outlet });
  const current = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => (
      <AuthoringDepartureProvider sessionBound={false}>
        <Sibling />
        <App />
      </AuthoringDepartureProvider>
    ),
  });
  const next = createRoute({
    getParentRoute: () => root,
    path: '/next',
    loader: () => {
      destinationReads++;
      return destination.promise;
    },
    component: () => <p>Destination</p>,
  });
  return createRouter({
    routeTree: root.addChildren([current, next]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
}
let target:
  | { kind: 'review'; realmId: string; initial: RealmClaimReviewRead }
  | { kind: 'request'; realmId: string }
  | { kind: 'status'; realmId: string; requestId: string };
function App() {
  if (target.kind === 'request')
    return (
      <RealmClaimPanel
        realmId={target.realmId}
        initial={source}
        adapter={claimAdapter}
        returnTo="/"
        onRead={() => {}}
      />
    );
  return target.kind === 'review' ? (
    <RealmClaimReviewPanel realmId={target.realmId} initial={target.initial} />
  ) : (
    <RealmClaimStatusPanel realmId={target.realmId} requestId={target.requestId} />
  );
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function paint() {
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          {router ? <RouterProvider router={router} /> : <App />}
        </QueryClientProvider>
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
  host.textContent = '';
  router = undefined;
  siblingDirty = false;
  destination = deferred<void>();
  destinationReads = 0;
}
function clearCalls() {
  reviewReads.length = 0;
  approvals.length = 0;
  statusReads.length = 0;
  requests.length = 0;
}
async function mountReview(
  initial: RealmClaimReviewRead = reviewPage(),
  session: ReturnType<typeof viewer> | { state: string; subject: string | null; csrfToken: string | null } = viewer(),
  targetRealmId = realmId,
  journey?: 'request' | 'review',
) {
  await close();
  clearCalls();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session);
  const count = client.getQueryState(sessionQuery.queryKey)?.dataUpdateCount ?? 0;
  target = {
    kind: 'review',
    realmId: targetRealmId,
    initial: {
      ...initial,
      callerRealmId: targetRealmId,
      callerSessionSourceId: realmClaimCallerSessionSource(client).id,
      callerSessionSubject: session.subject ?? undefined,
      callerSessionDataUpdateCount: count,
      callerSessionDataUpdatedAt: client.getQueryState(sessionQuery.queryKey)?.dataUpdatedAt,
    },
  };
  if (journey === 'request') target = { kind: 'request', realmId: targetRealmId };
  if (journey) {
    router = journeyRouter();
    await router.load();
  }
  root = createRoot(host);
  mounted = true;
  await paint();
}
async function mountStatus(session: ReturnType<typeof viewer> = viewer(), targetRequestId = requestId) {
  await close();
  clearCalls();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session);
  target = { kind: 'status', realmId, requestId: targetRequestId };
  root = createRoot(host);
  mounted = true;
  await paint();
}
function button(label: string) {
  const found = [...window.document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found!;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
    await tick();
  });
}
async function settle<T>(pending: ReturnType<typeof deferred<T>>, result: T) {
  await act(async () => {
    pending.resolve(result);
    await tick();
  });
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

test('review panel retires a queued prepare across CSRF readiness replacement and uses only the new token for a fresh confirmation', async () => {
  await mountReview();
  expect(host.textContent).toContain(claimantId);
  await click(m.realm_review_review());
  expect(reviewReads).toHaveLength(1);

  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, { state: 'preparing', subject: reviewerId, csrfToken: null });
    client.setQueryData(sessionQuery.queryKey, viewer(reviewerId, 'csrf-replacement'));
    await tick();
  });
  expect(host.textContent).not.toContain(claimantId);
  expect(reviewReads).toHaveLength(2);
  await settle(reviewReads[0]!, reviewPage());
  expect(approvals).toHaveLength(0);
  expect(host.textContent).not.toContain(claimantId);
  await settle(reviewReads[1]!, reviewPage());
  expect(host.textContent).toContain(claimantId);

  await click(m.realm_review_review());
  await settle(reviewReads[2]!, reviewPage());
  expect(host.textContent).toContain(m.realm_review_confirm_heading());
  await click(m.realm_review_confirm());
  expect(approvals).toHaveLength(1);
  expect(approvals[0]!.headers).toEqual({ 'X-CSRF-Token': 'csrf-replacement' });
  expect(approvals[0]!.input).toEqual({ realmId, requestId, idempotencyKey: expect.any(String) });

  await settle(approvals[0]!, { kind: 'approved', claim: approvalReceipt });
  expect(reviewReads).toHaveLength(4);
  expect(host.textContent).not.toContain(m.realm_review_success());
  await settle(reviewReads[3]!, reviewPage([], null));
  expect(host.textContent).toContain(m.realm_review_success());
  expect(host.textContent).toContain(claimantId);
});

test('review panel observes batched A-B-A, suppresses a late approval receipt read, and never re-seeds an obsolete loader page', async () => {
  await mountReview();
  await click(m.realm_review_review());
  await settle(reviewReads[0]!, reviewPage());
  await click(m.realm_review_confirm());
  expect(approvals).toHaveLength(1);

  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer(reviewerId, 'csrf-away'));
    client.setQueryData(sessionQuery.queryKey, viewer(reviewerId, 'csrf-original'));
    await tick();
  });
  expect(host.textContent).not.toContain(claimantId);
  expect(reviewReads).toHaveLength(2);
  await settle(approvals[0]!, { kind: 'approved', claim: approvalReceipt });
  expect(reviewReads).toHaveLength(2);
  expect(host.textContent).not.toContain(m.realm_review_success());
  await settle(reviewReads[1]!, reviewPage());
  expect(host.textContent).toContain(claimantId);

  await close();
  clearCalls();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, viewer());
  const stale = {
    ...reviewPage(),
    callerRealmId: realmId,
    callerSessionSourceId: realmClaimCallerSessionSource(client).id,
    callerSessionSubject: reviewerId,
    callerSessionDataUpdateCount: (client.getQueryState(sessionQuery.queryKey)?.dataUpdateCount ?? 0) - 1,
    callerSessionDataUpdatedAt: client.getQueryState(sessionQuery.queryKey)?.dataUpdatedAt,
  } satisfies RealmClaimReviewRead;
  target = { kind: 'review', realmId, initial: stale };
  root = createRoot(host);
  mounted = true;
  await paint();
  expect(host.textContent).not.toContain(claimantId);
  expect(reviewReads).toHaveLength(1);
  await settle(reviewReads[0]!, reviewPage());
  expect(host.textContent).toContain(claimantId);
});

test('review panel retires a queued prepare across an account A-B-A transition before rendering', async () => {
  await mountReview();
  await click(m.realm_review_review());
  expect(reviewReads).toHaveLength(1);

  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer(id(32), 'csrf-other-account'));
    client.setQueryData(sessionQuery.queryKey, viewer(reviewerId, 'csrf-original'));
    await tick();
  });
  expect(host.textContent).not.toContain(claimantId);
  expect(reviewReads).toHaveLength(2);
  await settle(reviewReads[0]!, reviewPage());
  expect(approvals).toHaveLength(0);
  expect(host.textContent).not.toContain(claimantId);
  await settle(reviewReads[1]!, reviewPage());
  expect(host.textContent).toContain(claimantId);
});

test('uncertain review retry preserves the original command after its row leaves the current queue', async () => {
  await mountReview();
  await click(m.realm_review_review());
  await settle(reviewReads[0]!, reviewPage());
  await click(m.realm_review_confirm());
  const original = approvals[0]!;
  await settle(original, { kind: 'unavailable' });
  expect(host.textContent).toContain(m.realm_review_uncertain());

  await click(m.realm_review_inspect_original());
  expect(reviewReads[1]!.input).toEqual({ realmId, inspectRequestId: requestId });
  await settle(reviewReads[1]!, reviewPage([], null));
  expect(approvals).toHaveLength(1);
  await click(m.realm_review_retry());
  expect(approvals).toHaveLength(2);
  expect(approvals[1]!.input).toEqual(original.input);
  expect(approvals[1]!.headers).toEqual(original.headers);
  await settle(approvals[1]!, { kind: 'approved', claim: approvalReceipt });
  await settle(reviewReads[2]!, reviewPage([], null));
  expect(host.textContent).toContain(m.realm_review_success());
});

test('a retired uncertain retry read cannot launch the original approval', async () => {
  await mountReview();
  await click(m.realm_review_review());
  await settle(reviewReads[0]!, reviewPage());
  await click(m.realm_review_confirm());
  await settle(approvals[0]!, { kind: 'unavailable' });
  await click(m.realm_review_inspect_original());
  expect(reviewReads).toHaveLength(2);

  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    await tick();
  });
  expect(host.textContent).not.toContain(claimantId);
  await settle(reviewReads[1]!, reviewPage([], null));
  expect(approvals).toHaveLength(1);
  expect(host.textContent).not.toContain(m.realm_review_success());
});

test('status panel withholds a late point read after A-B-A and requires a fresh read for a changed request', async () => {
  await mountStatus();
  expect(statusReads).toHaveLength(1);
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer(reviewerId, 'csrf-away'));
    client.setQueryData(sessionQuery.queryKey, viewer(reviewerId, 'csrf-original'));
    await tick();
  });
  expect(host.textContent).not.toContain(requestId);
  expect(statusReads).toHaveLength(2);
  await settle(statusReads[0]!, statusRead(requestId, 'approved'));
  expect(host.textContent).not.toContain(requestId);

  target = { kind: 'status', realmId, requestId: replacementRequestId };
  await paint();
  expect(statusReads).toHaveLength(3);
  expect(statusReads[2]!.input).toEqual({ realmId, requestId: replacementRequestId });
  await settle(statusReads[1]!, statusRead(requestId, 'approved'));
  expect(host.textContent).not.toContain(requestId);
  await settle(statusReads[2]!, statusRead(replacementRequestId));
  expect(host.textContent).toContain(replacementRequestId);
  expect(host.textContent).toContain(m.realm_claim_pending());
  expect(host.textContent).not.toContain(requestId);
});

test('status panel suppresses a point read that resolves after unmount', async () => {
  await mountStatus();
  expect(statusReads).toHaveLength(1);
  const late = statusReads[0]!;
  await close();
  await settle(late, statusRead(requestId, 'approved'));
  expect(host.textContent).toBe('');
  expect(statusReads).toHaveLength(1);
});

test('review panel does not refresh or expose a receipt after its approval resolves on an unmounted visit', async () => {
  await mountReview();
  await click(m.realm_review_review());
  await settle(reviewReads[0]!, reviewPage());
  await click(m.realm_review_confirm());
  expect(approvals).toHaveLength(1);
  const readsBeforeUnmount = reviewReads.length;
  await close();
  await settle(approvals[0]!, { kind: 'approved', claim: approvalReceipt });
  expect(reviewReads).toHaveLength(readsBeforeUnmount);
  expect(host.textContent).toBe('');
});

test('replacing the QueryClient retires both callers even when the account is unchanged', async () => {
  await mountReview();
  expect(host.textContent).toContain(claimantId);
  const oldReviewClient = client;
  const replacementReviewClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  replacementReviewClient.setQueryData(sessionQuery.queryKey, viewer(reviewerId, 'csrf-on-replacement-client'));
  client = replacementReviewClient;
  await paint();
  expect(host.textContent).not.toContain(claimantId);
  expect(reviewReads).toHaveLength(1);
  await settle(reviewReads[0]!, reviewPage());
  expect(host.textContent).toContain(claimantId);
  oldReviewClient.clear();

  await mountStatus();
  const oldStatusClient = client;
  const replacementStatusClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  replacementStatusClient.setQueryData(sessionQuery.queryKey, viewer(reviewerId, 'csrf-on-second-client'));
  client = replacementStatusClient;
  await paint();
  expect(host.textContent).not.toContain(requestId);
  expect(statusReads).toHaveLength(2);
  await settle(statusReads[0]!, statusRead(requestId, 'approved'));
  expect(host.textContent).not.toContain(requestId);
  await settle(statusReads[1]!, statusRead(requestId));
  expect(host.textContent).toContain(requestId);
  oldStatusClient.clear();
});

test('review panel rejects an obsolete Realm loader page and fences a queued read after target change', async () => {
  const otherRealm = id(11);
  await mountReview(reviewPage(), viewer(), otherRealm);
  expect(host.textContent).not.toContain(claimantId);
  expect(reviewReads).toHaveLength(1);
  expect(reviewReads[0]!.input.realmId).toBe(otherRealm);
  const late = reviewReads[0]!;
  const obsoleteLoader = target.kind === 'review' ? target.initial : reviewPage();

  target = { kind: 'review', realmId, initial: obsoleteLoader };
  await paint();
  expect(reviewReads).toHaveLength(2);
  expect(reviewReads[1]!.input.realmId).toBe(realmId);
  await settle(late, reviewPage());
  expect(host.textContent).not.toContain(claimantId);
  await settle(reviewReads[1]!, reviewPage());
  expect(host.textContent).toContain(claimantId);
});

test('sparse review continuation advances by one exact opaque cursor', async () => {
  const cursor = 'signed.cursor+/keep?realm=exact&part=%2F';
  await mountReview(reviewPage([], cursor));
  expect(reviewReads).toHaveLength(0);
  await click(m.realm_review_next());
  expect(reviewReads).toHaveLength(1);
  expect(reviewReads[0]!.input).toEqual({ realmId, cursor });
  await settle(reviewReads[0]!, reviewPage());
  expect(reviewReads).toHaveLength(1);
  expect(host.textContent).toContain(claimantId);
});

const unloadProtected = () => {
  const event = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
async function depart() {
  await act(async () => {
    void router!.navigate({ to: '/next' });
    await tick();
  });
  expect(window.document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
}
for (const kind of ['request', 'review'] as const) {
  test(`${kind} departure preserves confirmation and immutable recovery on Stay, then retires before destination reads finish`, async () => {
    await mountReview(reviewPage(), viewer(), realmId, kind);
    expect(unloadProtected()).toBe(false);
    if (kind === 'review') {
      expect(reviewReads).toHaveLength(0);
      await click(m.realm_review_review());
      expect(unloadProtected()).toBe(false);
      await settle(reviewReads[0]!, reviewPage());
      await depart();
      expect(window.document.body.textContent).toContain(m.realm_claim_leave_confirmation());
      await click(m.thread_authoring_stay());
      expect(host.textContent).toContain(claimantId);
      await click(m.realm_review_cancel());
      expect(unloadProtected()).toBe(false);
      await click(m.realm_review_review());
      await settle(reviewReads[1]!, reviewPage());
    }
    await click(kind === 'request' ? m.realm_claim_request() : m.realm_review_confirm());
    const original = kind === 'request' ? requests[0]! : approvals[0]!;
    await depart();
    expect(window.document.body.textContent).toContain(m.realm_claim_leave_pending());
    await click(m.thread_authoring_stay());
    if (kind === 'request') await settle(requests[0]!, { kind: 'unavailable' });
    else await settle(approvals[0]!, { kind: 'unavailable' });
    siblingDirty = true;
    await depart();
    await click(m.thread_authoring_stay());
    await click(kind === 'request' ? m.realm_claim_retry() : m.realm_review_inspect_original());
    if (kind === 'review') {
      await settle(reviewReads[2]!, reviewPage([]));
      await click(m.realm_review_retry());
    }
    const retry = kind === 'request' ? requests[1]! : approvals[1]!;
    expect(retry.input).toEqual(original.input);
    expect(kind === 'request' ? requests.length : approvals.length).toBe(2);
    await depart();
    const reads = reviewReads.length;
    await click(m.thread_authoring_leave());
    expect(destinationReads).toBe(1);
    expect(unloadProtected()).toBe(false);
    expect(host.textContent).not.toContain(claimantId);
    if (kind === 'request') await settle(requests[1]!, { kind: 'pending', request: row });
    else await settle(approvals[1]!, { kind: 'approved', claim: approvalReceipt });
    expect(reviewReads).toHaveLength(reads);
    expect(host.textContent).not.toContain(m.realm_review_success());
    expect(host.textContent).not.toContain(m.realm_claim_pending());
    await settle(destination, undefined);
  });

  test(`${kind} releases protection as soon as a validated receipt settles`, async () => {
    await mountReview(reviewPage(), viewer(), realmId, kind);
    if (kind === 'review') {
      await click(m.realm_review_review());
      await settle(reviewReads[0]!, reviewPage());
    }
    await click(kind === 'request' ? m.realm_claim_request() : m.realm_review_confirm());
    if (kind === 'request') await settle(requests[0]!, { kind: 'pending', request: row });
    else await settle(approvals[0]!, { kind: 'approved', claim: approvalReceipt });
    expect(unloadProtected()).toBe(false);
    if (kind === 'review') {
      expect(reviewReads).toHaveLength(2);
      await settle(reviewReads[1]!, reviewPage([]));
      expect(host.textContent).toContain(m.realm_review_success());
    } else expect(host.textContent).toContain(m.realm_claim_pending());
    await act(async () => {
      void router!.navigate({ to: '/next' });
      await tick();
    });
    expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
    await settle(destination, undefined);
  });
}
