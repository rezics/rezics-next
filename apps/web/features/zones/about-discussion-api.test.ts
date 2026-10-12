import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import { direction } from '@rezics/main/language';
import type { MainApp } from '@rezics/main/app';
import type { ThreadRead } from '../feed/thread.ts';
import { storyQuietThread } from '../feed/thread-fixtures.ts';
import { mainAboutDiscussionApi, readAboutDiscussion, type AboutPostIntent } from './about-discussion-api.ts';

const reference = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const local = (value: string) => value.slice(-36);
const zone = reference(1), realm = reference(2), about = reference(3), actor = reference(4);
const reply = reference(5), targetRevision = reference(6), routeRevision = reference(7);
const realmName = { value: 'Live reading community', language: 'en', direction: direction('en', 'Live reading community') };
const intent: AboutPostIntent = { key: 'page-discussion:uncertain-intent', actingSubject: actor,
  basis: { realm, about, targetRevision, zone, path: '/chapter-one', routeRevision },
  body: 'لماذا انتهى الفصل هنا؟\nSecond line stays unchanged.', language: 'ar', spoiler: true };
interface Sent {
  url: URL; method: string; key: string | null; body: unknown;
}
function client(answer: (call: Sent) => Response | Promise<Response>) {
  const calls: Sent[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const text = await request.clone().text();
    const call = { url: new URL(request.url), method: request.method,
      key: request.headers.get('idempotency-key'), body: text ? JSON.parse(text) as unknown : null };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { main: treaty<MainApp>('https://main.test', { fetcher, parseDate: false }), calls };
}
const posted = { profile: 'realm-about-post-v1', realm, about, author: actor, reply,
  revisionId: local(reference(8)), placement: reference(9) };
const failure = (status: number) => Response.json({ code: 'realm_reply_unavailable' }, { status });

test('a lost first-post response retries exactly one command with the same complete intent and key', async () => {
  let attempted = false;
  const transport = client(() => {
    if (!attempted) { attempted = true; throw new TypeError('Response connection was lost'); }
    return Response.json(posted, { status: 200 });
  });
  const api = mainAboutDiscussionApi(() => transport.main);
  const retained = structuredClone(intent);
  expect(await api.post(retained)).toEqual({ kind: 'recovery' });
  expect(transport.calls).toHaveLength(1);
  expect(await api.post(retained)).toEqual({ kind: 'posted', reply });
  expect(transport.calls).toHaveLength(2);
  expect(retained).toEqual(intent);
  const bodies = transport.calls.map(call => ({ method: call.method, path: call.url.pathname,
    key: call.key, body: call.body }));
  expect(bodies[0]).toEqual({ method: 'POST', path: `/v1/realms/${local(realm)}/about-posts`, key: intent.key,
    body: { profile: 'realm-about-post-v1', about, targetRevision, zone, path: '/chapter-one', routeRevision,
      actingSubject: actor, body: intent.body, language: 'ar', direction: 'rtl', spoiler: true } });
  expect(bodies[1]).toEqual(bodies[0]);
});

test('pending is not posted and every response keeps one posting request per attempt', async () => {
  const statuses = [202, 409, 403, 401, 404, 503, 429, 201];
  const kinds = ['pending', 'stale', 'refused', 'recovery', 'refused', 'recovery', 'recovery', 'posted'] as const;
  const transport = client(() => {
    const status = statuses[transport.calls.length - 1]!;
    return status === 202 ? Response.json({ operationId: local(reference(10)) }, { status })
      : status === 201 ? Response.json(posted, { status }) : failure(status);
  });
  const api = mainAboutDiscussionApi(() => transport.main);
  for (const [index, kind] of kinds.entries()) {
    expect((await api.post(intent)).kind).toBe(kind);
    expect(transport.calls).toHaveLength(index + 1);
  }
  expect(transport.calls.every(call => call.method === 'POST'
    && call.url.pathname === `/v1/realms/${local(realm)}/about-posts` && call.key === intent.key)).toBe(true);
  expect(transport.calls.every(call => JSON.stringify(call.body) === JSON.stringify(transport.calls[0]!.body))).toBe(true);
});

test('a closed platform grant preserves the complete intent for recovery when it reopens', async () => {
  const transport = client(() => transport.calls.length === 1
    ? Response.json({ code: 'platform_closed' }, { status: 403 })
    : Response.json(posted, { status: 200 }));
  const api = mainAboutDiscussionApi(() => transport.main);
  const saved = structuredClone(intent);
  expect(await api.post(saved)).toEqual({ kind: 'closed' });
  expect(saved).toEqual(intent);
  expect(await api.post(saved)).toEqual({ kind: 'posted', reply });
  expect(transport.calls.map(call => ({ key: call.key, body: call.body })))
    .toEqual(Array(2).fill({ key: intent.key, body: transport.calls[0]!.body }));
});

const visibleThread: ThreadRead = { ...storyQuietThread, realm, thread: reply, focus: reply,
  work: { ...storyQuietThread.work, id: about }, rootRevision: targetRevision,
  items: [{ ...storyQuietThread.items[0]!, reply, placement: reference(9), parent: null, revisionId: local(reference(8)),
    author: { id: actor, name: 'Chapter reader', handle: null }, title: 'A question',
    body: 'The exact admitted discussion body', language: 'en', spoiler: true }] };
interface ReadOptions {
  attachedRealm?: string | null; routeKind?: 'detail' | 'document' | 'home' | 'index';
  thread?: typeof visibleThread | null; reviewMode?: 'open' | 'trusted-members' | 'mandatory';
  joined?: boolean; fail?: 'route' | 'target' | 'lookup' | 'header' | 'joining' | 'thread';
}
function reader(options: ReadOptions = {}) {
  const attachedRealm = options.attachedRealm === undefined ? realm : options.attachedRealm;
  return client(({ url, method }) => {
    expect(method).toBe('GET');
    if (url.pathname === `/v1/zones/${local(zone)}/routes`) {
      if (options.fail === 'route') return failure(503);
      const kind = options.routeKind ?? 'detail';
      return Response.json({ kind, zone, path: '/canonical-chapter', realm: attachedRealm, revision: routeRevision,
        ...(kind === 'home' ? { page: { reference: { resourceId: about } } }
          : kind === 'index' ? {} : { resource: { id: about } }) });
    }
    if (url.pathname === `/v1/resources/${local(about)}/page`) return options.fail === 'target'
      ? failure(404) : Response.json({ target: { resource: about, revision: targetRevision } });
    if (url.pathname.endsWith('/about-thread')) return options.fail === 'lookup' ? failure(503)
      : Response.json({ realm: attachedRealm, about,
        thread: options.thread ? { reply, rootRevision: targetRevision } : null });
    if (url.pathname.endsWith('/joining')) return options.fail === 'joining' ? failure(503)
      : Response.json({ realm: attachedRealm, state: options.joined ? 'joined' : 'absent',
        open: true, selfJoin: true, membershipGeneration: '1', policyRevision: '2', termsRevision: '2' });
    if (url.pathname.endsWith(`/threads/${local(reply)}`)) return options.fail === 'thread' ? failure(503)
      : Response.json(options.thread);
    if (url.pathname === `/v1/realms/${local(attachedRealm!)}`) return options.fail === 'header' ? failure(503)
      : Response.json({ realm: attachedRealm, name: realmName, reviewMode: options.reviewMode ?? 'open' });
    throw new Error(`Unexpected discussion read: ${url.pathname}`);
  });
}
const readInput = { zone, path: '/chapter-one', signedIn: true, actingSubject: actor, personal: true };

test('a closed posting grant keeps the discussion lookup and existing thread readable', async () => {
  const transport = reader({ thread: visibleThread });
  expect(await readAboutDiscussion(transport.main, { ...readInput, postingOpen: false }))
    .toMatchObject({ kind: 'ready', mode: 'closed', thread: visibleThread, basis: { realm, about } });
  expect(transport.calls.every(call => call.method === 'GET')).toBe(true);
  expect(transport.calls.some(call => call.url.pathname.endsWith('/about-thread'))).toBe(true);
  expect(transport.calls.some(call => call.url.pathname.endsWith(`/threads/${local(reply)}`))).toBe(true);
});

test('a withdrawn live route or an index never performs about-thread lookup', async () => {
  for (const options of [{ attachedRealm: null }, { routeKind: 'index' as const }]) {
    const transport = reader(options);
    expect(await readAboutDiscussion(transport.main, readInput)).toEqual({ kind: 'none' });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.url.pathname).toBe(`/v1/zones/${local(zone)}/routes`);
  }
});

test('the live route selects the Realm, canonical path and current target, then reads visible thread bodies', async () => {
  const currentRealm = reference(22);
  const currentThread = { ...visibleThread, realm: currentRealm };
  const transport = reader({ attachedRealm: currentRealm, thread: currentThread });
  const result = await readAboutDiscussion(transport.main, readInput);
  expect(result).toEqual({ kind: 'ready', mode: 'open', actingSubject: actor,
    basis: { realm: currentRealm, about, targetRevision, zone, path: '/canonical-chapter', routeRevision },
    thread: currentThread, realmName });
  expect(transport.calls).toHaveLength(6);
  const realmReads = transport.calls.filter(call => call.url.pathname.includes('/realms/'));
  expect(realmReads.every(call => call.url.pathname.startsWith(`/v1/realms/${local(currentRealm)}`))).toBe(true);
  expect(transport.calls.every(call => call.url.searchParams.get('actingSubject') === actor)).toBe(true);
  expect(transport.calls.find(call => call.url.pathname.endsWith('/about-thread'))!.url.searchParams.get('about')).toBe(about);
});

test('a shared current projection supplies the posting revision without another resource-page read', async () => {
  const transport = reader({ thread: visibleThread });
  const currentRevision = reference(66), resources: string[] = [];
  const result = await readAboutDiscussion(transport.main, readInput, async resource => {
    resources.push(resource);
    return { resource, revision: currentRevision };
  });
  expect(resources).toEqual([about]);
  expect(result).toMatchObject({ kind: 'ready', basis: { about, targetRevision: currentRevision },
    thread: { rootRevision: targetRevision } });
  expect(transport.calls).toHaveLength(5);
  expect(transport.calls.some(call => call.url.pathname.includes('/resources/'))).toBe(false);
});

test('a missing, mismatched or failed shared projection keeps the discussion unavailable without rereading it', async () => {
  for (const target of [null, { resource: reference(99), revision: targetRevision }, new Error('Projection unavailable')]) {
    const transport = reader();
    expect(await readAboutDiscussion(transport.main, readInput, async () => {
      if (target instanceof Error) throw target;
      return target;
    })).toEqual({ kind: 'unavailable' });
    expect(transport.calls.some(call => call.url.pathname.includes('/resources/'))).toBe(false);
  }
});

test('document and detail lookup responses with no visible thread keep their target basis without reading bodies', async () => {
  for (const routeKind of ['document', 'detail'] as const) {
    const hidden = reader({ routeKind, thread: null }), absent = reader({ routeKind, thread: null });
    const hiddenRead = await readAboutDiscussion(hidden.main, readInput);
    expect(hiddenRead).toEqual(await readAboutDiscussion(absent.main, readInput));
    expect(hiddenRead).toMatchObject({ kind: 'ready', thread: null, basis: { about, targetRevision } });
    expect(hidden.calls).toHaveLength(5);
    expect(hidden.calls.some(call => call.url.pathname.includes('/threads/'))).toBe(false);
  }
});

test('posting guidance uses sign-in, Person identity, membership and review owner reads', async () => {
  const cases = [
    { input: { ...readInput, signedIn: false, actingSubject: undefined }, options: {}, mode: 'sign-in' },
    { input: { ...readInput, postingOpen: false }, options: {}, mode: 'closed' },
    { input: { ...readInput, personal: false }, options: {}, mode: 'identity' },
    { input: { ...readInput, actingSubject: undefined }, options: {}, mode: 'identity' },
    { input: readInput, options: { reviewMode: 'trusted-members' as const, joined: false }, mode: 'join' },
    { input: readInput, options: { reviewMode: 'trusted-members' as const, joined: true }, mode: 'open' },
    { input: readInput, options: { reviewMode: 'mandatory' as const, joined: true }, mode: 'reviewed' },
    { input: readInput, options: { reviewMode: 'trusted-members' as const, fail: 'joining' as const }, mode: 'unavailable' },
  ];
  for (const { input, options, mode } of cases) {
    const transport = reader(options);
    expect(await readAboutDiscussion(transport.main, input)).toMatchObject({ kind: 'ready', mode });
    expect(transport.calls.every(call => call.method === 'GET')).toBe(true);
    expect(transport.calls.some(call => call.url.pathname.endsWith('/joining'))).toBe(Boolean(input.actingSubject));
  }
});

test('unavailable route, target, lookup, header or visible-body reads never invent an empty discussion', async () => {
  for (const fail of ['route', 'target', 'lookup', 'header', 'thread'] as const) {
    const transport = reader({ fail, thread: visibleThread });
    expect(await readAboutDiscussion(transport.main, readInput)).toEqual({ kind: 'unavailable' });
  }
});
