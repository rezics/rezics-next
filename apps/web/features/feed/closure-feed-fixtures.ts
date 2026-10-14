import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { profileHref } from '../profile/route.ts';
import { onRezics, page, people, post, realms, storyId } from './fixtures.ts';
import type { FeedHead, FeedPage, FeedQuery } from './types.ts';

/** Contract specimens, not recorded answers. Capture these requests in the prove phase.
 * Original title and text are authored for this fixture by the owner Person;
 * a Realm selection is separate from authorship. No policy runs in this transport. */
export const closurePersonas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
export const closureOwner = people.mei;
export const closedRealm = realms.fiction.id;
export const closureSuccessor = 'contract-successor/closed-realm+independent=2';
export type ClosureState = 'populated' | 'empty' | 'loading' | 'forbidden' | 'unavailable' |
  'continuation-error' | 'continuation-forbidden' | 'sparse';

export function closureActor(persona: AnswerPersona): string | undefined {
  return persona === 'visitor' ? undefined : persona === 'owner' ? closureOwner.id
    : storyId(850 + closurePersonas.indexOf(persona), 'bbbb');
}

export function closureQuery(persona: AnswerPersona, realmOnly = false): FeedQuery {
  return { scope: 'all', sort: 'new', language: 'en', limit: 20,
    ...(closureActor(persona) ? { actingSubject: closureActor(persona) } : {}),
    ...(realmOnly ? { realms: [closedRealm] } : {}) };
}

export const independentOriginals = [1, 2].map(n => post(920 + n, {
  actor: closureOwner, realm: null, authors: [onRezics(closureOwner)],
  reason: { kind: 'recommended', basis: 'all' },
  reasons: [{ kind: 'new-work', actor: closureOwner.id }],
  target: { title: { value: `Closure garden original ${n}`, language: 'en', direction: 'ltr', basis: 'requested' },
    excerpt: `An independently published garden story, part ${n}.` },
}));

export function closurePage(query: FeedQuery, cursor?: string): FeedPage {
  const empty = Boolean(query.realms?.length);
  return page(empty ? [] : [independentOriginals[cursor ? 1 : 0]!], {
    scope: query.scope ?? 'all', sort: 'new', nextCursor: empty || cursor ? null : closureSuccessor,
  });
}

export function closureHead(scope: string, after: string): FeedHead {
  return { profile: 'home-feed-head-v1', scope, afterSequence: after,
    newPosts: { value: 0, kind: 'exact' }, state: 'current',
    projection: { sequence: '40', reviewSequence: '7', dataEpoch: 'story' } };
}

export const closureProblem = { code: 'forbidden', detail: 'The acting Agent cannot read this feed.' };
export const closureUnavailableProblem = { code: 'work_read_unavailable', detail: 'Feed read unavailable.',
  reference: 'feed-read-contract-503' };

/** Exact specimen requests, including independent-original continuation and all closure scopes.
 * There is no 202 in the feed read contract; catching-up 200 is not pending. */
export const missingClosureAnswers = closurePersonas.flatMap(persona => {
  const actor = closureActor(persona);
  const identity: Record<string, string> = actor ? { actingSubject: actor } : {};
  const base = { scope: 'all', sort: 'new', language: 'en', limit: '20', ...identity };
  const request = (path: string, query: Record<string, string>, state: string, status: number) =>
    ({ persona, method: 'GET', path: `${path}?${new URLSearchParams(query)}`, state, status });
  return [
    request('/v1/feed', base, 'populated', 200),
    request('/v1/feed', { ...base, cursor: closureSuccessor }, 'populated successor', 200),
    request('/v1/feed', { ...base, realms: closedRealm }, 'empty closed Realm', 200),
    ...(actor ? [request('/v1/feed', { ...base, scope: 'following' }, 'Following after closure', 200)] : []),
    ...['all', ...(actor ? ['following'] : []), `realm:${closedRealm}`].map(scope =>
      request('/v1/feed/head', { scope, after: '40', afterReview: '7', ...identity }, 'zero closed activity', 200)),
    request('/v1/feed', base, 'loading (held request)', 200),
    request('/v1/feed', base, 'refusal', 403),
    request('/v1/feed', base, 'unavailable', 503),
    request('/v1/feed', { ...base, cursor: closureSuccessor }, 'successor unavailable', 503),
    request('/v1/feed', { ...base, cursor: closureSuccessor }, 'successor refusal', 403),
    request('/v1/feed', base, 'empty page with successor', 200),
  ];
});

export const missingClosureWatermarks = closurePersonas.filter(persona => persona !== 'visitor').map(persona => ({
  persona, method: 'PUT', path: '/v1/me/feed-watermarks/all', status: 200, state: 'completed',
  body: { actingSubject: closureActor(persona)!, dataEpoch: 'story', sequence: '40', scope: 'all' },
}));

export function closureTransport(persona: AnswerPersona, state: ClosureState) {
  const calls: { method: string; path: string }[] = [];
  let disposed = false;
  const held = new Set<() => void>();
  const fetcher: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(BFF_PREFIX, '');
    calls.push({ method: request.method, path: path + url.search });
    if (disposed) throw new DOMException('Story ended', 'AbortError');
    const body = request.method === 'GET' ? null : await request.json() as { actingSubject?: string };
    if ((url.searchParams.get('actingSubject') ?? body?.actingSubject) !== closureActor(persona))
      throw new Error('Feed specimen identity mismatch');
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (path === '/v1/feed/head') return json(closureHead(url.searchParams.get('scope') ?? 'all',
      url.searchParams.get('after')!));
    if (path.startsWith('/v1/me/feed-watermarks/')) return json({ profile: 'home-watermark-v1',
      scope: path.split('/').at(-1), dataEpoch: 'story', sequence: '40', replayed: false });
    if (path !== '/v1/feed' || request.method !== 'GET') throw new Error(`Unmatched feed specimen: ${path}`);
    if (url.searchParams.get('sort') !== 'new' || url.searchParams.get('language') !== 'en' ||
      url.searchParams.get('limit') !== '20') throw new Error('Feed specimen query mismatch');
    if (state === 'empty' && url.searchParams.get('realms') !== closedRealm)
      throw new Error('Closed Realm filter mismatch');
    const cursor = url.searchParams.get('cursor') ?? undefined;
    if (cursor && cursor !== closureSuccessor) throw new Error('Invented feed successor');
    if (state === 'loading') return new Promise<Response>((_resolve, reject) => {
      const release = () => { held.delete(release); reject(new DOMException('Story ended', 'AbortError')); };
      held.add(release);
    });
    if (state === 'forbidden' || (state === 'continuation-forbidden' && cursor)) return json(closureProblem, 403);
    if (state === 'unavailable' || (state === 'continuation-error' && cursor))
      return json(closureUnavailableProblem, 503);
    const query = closureQuery(persona, state === 'empty');
    query.scope = url.searchParams.get('scope') === 'following' ? 'following' : 'all';
    const answer = closurePage(query, cursor);
    return json(state === 'sparse' && !cursor
      ? { ...answer, items: [], count: { ...answer.count, value: 0 } } : answer);
  }, { preconnect: globalThis.fetch.preconnect });
  return { calls, main: browserMainApi('https://contract.invalid', { anonymous: persona === 'visitor', fetcher }),
    dispose() { disposed = true; for (const release of held) release(); } };
}

export const closureCreditHref = profileHref(closureOwner);
