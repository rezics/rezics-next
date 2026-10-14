import { browserMainApi, BFF_PREFIX } from '../../api/browser.ts';
import { NOW, streamId } from './fixtures.ts';
import type { NotificationCount, NotificationDelivery, NotificationWindow, StreamItem } from './window.ts';

export const closurePersonas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
export type ClosurePersona = (typeof closurePersonas)[number];
export type ClosureState = 'populated' | 'empty' | 'loading' | 'error' | 'count-error' | 'delivery-error'
  | 'delivery-missing' | 'delivery-uncertain' | 'continuation-denied' | 'role-only' | 'process-authorized';

/** Contract-built answers, NOT captures. The prove phase must record these requests after Realm closure.
 * Original reply credit stays with its author Person, including the independently published control.
 * The receiver's Person is distinct from both authors; owning/moderating/operating grants no process authority.
 */
export const closureCredit = {
  basis: 'original-contribution', closedAuthor: `https://rezics.com/id/${streamId(800)}`,
  liveAuthor: `https://rezics.com/id/${streamId(801)}`,
} as const;
export const closureRequests = {
  latest: '/v1/me/notifications?before=latest&limit=50',
  count: '/v1/me/notifications/unread-count',
  older: '/v1/me/notifications?before=contract-older-page&limit=50',
} as const;

function notice(id: number, sequence: string): StreamItem {
  return { id: streamId(id), sequence, purpose: 'social', topic: 'reply', state: 'active',
    read: false, saved: false, done: false, triageRevision: null, reason: null, proposal: null,
    subject: null, display: null, deliveries: [], createdAt: new Date(NOW - 60_000).toISOString() };
}

export function closureAnswers(persona: ClosurePersona, state: ClosureState = 'populated') {
  const offset = closurePersonas.indexOf(persona) * 100;
  const recipient = `https://rezics.com/id/${streamId(900 + offset)}`;
  const closed = notice(1 + offset, '500');
  closed.deliveries = [{ id: streamId(20 + offset), channel: 'push' }];
  const live = notice(2 + offset, '400');
  live.subject = { owner: 'reply', ref: `https://rezics.com/id/${streamId(700)}`, revision: null };
  live.display = { kind: 'reply', actor: { id: closureCredit.liveAuthor, name: 'Live member', handle: null, avatar: null },
    realm: `https://rezics.com/id/${streamId(710)}`, realmName: 'Independent public Realm', realmRouteSegment: 'independent',
    roleName: null, roleChange: null, groupKey: null,
    target: { title: 'Independent original source', excerpt: 'Original reply by the credited live member Person.',
      language: 'en', linkTarget: live.subject.ref, reviewId: null } };
  live.deliveries = [{ id: streamId(21 + offset), channel: 'push' }];
  const process = notice(3 + offset, '300');
  process.purpose = 'governance';
  process.topic = 'review-requested';
  // These are distinct supplied contract states, not a surface policy check.
  const processAuthorized = state === 'process-authorized';
  if (processAuthorized) {
    process.reason = 'steward';
    process.proposal = { id: streamId(750), revision: 2 };
    process.subject = { owner: 'proposal', ref: `urn:rezics:proposal:${streamId(750)}`, revision: '2' };
  }
  const older = { ...live, id: streamId(4 + offset), sequence: '200', deliveries: [], read: true };
  const items = state === 'empty' ? [] : [closed, live, process];
  const page: NotificationWindow & { profile: 'notification-stream-page-v1' } = {
    profile: 'notification-stream-page-v1', generation: '1', head: '500', reset: false, readThrough: '0',
    items, groups: [], next: items.length ? 'contract-older-page' : null };
  const continuation = { ...page, items: [older], next: null };
  const count: NotificationCount = { profile: 'notification-unread-count-v1', generation: '1',
    count: items.length ? processAuthorized ? 2 : 1 : 0, overflow: false };
  const deliveries: NotificationDelivery[] = [
    { profile: 'notification-delivery-v1', id: closed.deliveries[0]!.id, itemId: closed.id, channel: 'push',
      state: 'cancelled', cancelReason: 'subject_unavailable', attempts: 1, terminalAt: new Date(NOW).toISOString() },
    { profile: 'notification-delivery-v1', id: live.deliveries[0]!.id, itemId: live.id, channel: 'push',
      state: state === 'delivery-uncertain' ? 'uncertain' : 'delivered', cancelReason: null,
      attempts: 1, terminalAt: state === 'delivery-uncertain' ? null : new Date(NOW).toISOString() },
  ];
  return { recipient, closed, live, process, processAuthorized, page, continuation, count, deliveries };
}

export function closureTransport(persona: ClosurePersona, state: ClosureState = 'populated') {
  const answers = closureAnswers(persona, state);
  const requests: { method: string; path: string; credentials: RequestCredentials }[] = [];
  const held = new Set<() => void>();
  const problem = (status: number, code: string) => Response.json({ code }, { status });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.slice(BFF_PREFIX.length);
    requests.push({ method: request.method, path: path + url.search,
      credentials: init?.credentials ?? request.credentials });
    if (request.method !== 'GET') throw new Error(`Unexpected closure story command: ${request.method} ${path}`);
    if (persona === 'visitor') return problem(401, 'account_assertion_denied');
    if (path === '/v1/me/notifications') {
      if (state === 'loading') return new Promise<Response>((_resolve, reject) => {
        held.add(() => reject(new DOMException('Story disposed', 'AbortError')));
      });
      if (state === 'error') return Response.json({ code: 'notification_unavailable', reference: 'closure-inbox-503' }, { status: 503 });
      const before = url.searchParams.get('before');
      if (url.searchParams.get('limit') !== '50') throw new Error('Unexpected notification window');
      if (before === 'contract-older-page') return state === 'continuation-denied'
        ? problem(401, 'account_assertion_denied') : Response.json(answers.continuation);
      if (before !== 'latest') throw new Error('Unexpected notification cursor');
      return Response.json(answers.page);
    }
    if (path === closureRequests.count) return state === 'count-error'
      ? Response.json({ code: 'notification_unavailable', reference: 'closure-count-503' }, { status: 503 })
      : Response.json(answers.count);
    if (path.startsWith('/v1/deliveries/')) {
      const delivery = answers.deliveries.find(value => path === `/v1/deliveries/${value.id}`);
      if (!delivery || state === 'delivery-missing') return problem(404, 'not_found');
      if (state === 'delivery-error') return Response.json({ code: 'notification_unavailable', reference: 'closure-delivery-503' }, { status: 503 });
      return Response.json(delivery);
    }
    throw new Error(`Unexpected closure story request: ${path}`);
  }) as typeof fetch;
  return { ...answers, requests, fetcher, main: browserMainApi('https://contract.invalid', { fetcher }),
    dispose() { for (const release of held) release(); held.clear(); } };
}

/** Exact constructed request/state inventory for prove-phase replacement with unchanged recorded answers.
 * Capture the authenticated recipient's real IDs/cursor from the completed closure setup, then replay its
 * deliveries and `next` unchanged. For role-only, remove case/proposal authority while retaining the role.
 * Loading holds a read; uncertain is a completed HTTP 200 delivery. There is no HTTP 202 pending answer.
 */
export function closureRecordPlan(persona: ClosurePersona, state: ClosureState = 'populated') {
  const answers = closureAnswers(persona, state);
  const denied = persona === 'visitor';
  const hasWindow = !denied && state !== 'empty' && state !== 'error' && state !== 'loading';
  return {
    persona, state, recipient: answers.recipient,
    processAuthority: answers.processAuthorized ? 'explicit-case-or-proposal-grant' : 'none',
    requests: [
      { method: 'GET', path: closureRequests.latest, status: denied ? 401 : state === 'error' ? 503 : 200,
        state: denied || state === 'error' ? 'error' : state === 'loading' ? 'loading' : state === 'empty' ? 'empty' : 'populated' },
      { method: 'GET', path: closureRequests.count, status: denied ? 401 : state === 'count-error' ? 503 : 200,
        state: denied || state === 'count-error' ? 'error' : 'populated' },
      ...(hasWindow ? [{ method: 'GET', path: closureRequests.older, status: state === 'continuation-denied' ? 401 : 200,
        state: state === 'continuation-denied' ? 'error' : 'populated' }] : []),
      ...(hasWindow || denied ? answers.deliveries.map(delivery => ({ method: 'GET', path: `/v1/deliveries/${delivery.id}`,
        status: denied ? 401 : state === 'delivery-missing' ? 404 : state === 'delivery-error' ? 503 : 200,
        state: denied || state === 'delivery-missing' || state === 'delivery-error' ? 'error' : 'populated' })) : []),
    ],
  };
}
