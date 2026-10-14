import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import { direction } from '@rezics/main/language';
import type { ThreadsPage, ThreadSummary } from '../feed/thread.ts';
import type { RankingRequest } from './ranking-read.ts';

/** Constructed from realm/ranking's contract; no ranking answers have been recorded yet. */
export const rankingStateSource = 'Contract state — missing recorded realm/ranking and realm/closure-rankings answers';
export const rankingPersonas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
export type RankingState = 'populated' | 'continuation' | 'empty' | 'missing' | 'error' | 'invalid-cursor' | 'moved' | 'loading';
const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-1234-4123-8123-123456789abc`;
export const rankingRealm = id(1);
export const rankingAuthor = id(10);
export const rankingNow = Date.parse('2026-10-14T08:00:00.000Z');
export const rankingPosition = { dataEpoch: '00000000-1234-4123-8123-123456789abc', sequence: '300' };

export function rankingReader(persona: AnswerPersona): string | null {
  return persona === 'visitor' ? null : persona === 'owner' ? rankingAuthor : id(20 + rankingPersonas.indexOf(persona));
}

function item(index: number, history: 'public' | 'retained' | 'current'): ThreadSummary {
  return { reply: id(1000 + index), placement: id(2000 + index),
    work: { id: id(100), title: { value: 'Original ranking garden', language: 'en', direction: direction('en', 'Original ranking garden'), basis: 'requested' },
      cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'ranking-garden', resourceType: 'work' } },
    author: { id: rankingAuthor, name: 'Ranking garden author', handle: null },
    time: new Date(rankingNow - index * 60_000).toISOString(), language: 'en',
    title: `Original ${history} thread ${index}`, excerpt: 'Original synthetic discussion text by the credited owner Person.',
    vote: { score: 300 - index, value: 0, revision: null, open: false }, replies: { value: 0, kind: 'exact' } };
}

export interface RankingContractState {
  source: typeof rankingStateSource;
  persona: AnswerPersona;
  realmState: 'public' | 'private' | 'closed';
  rights: { basis: 'original-contribution'; author: string };
  request: RankingRequest;
  /** Exact service-relative request/state for the prove-phase recording. */
  path: string;
  status: number;
  answer: ThreadsPage | { type: string; title: string; status: number; code: string };
  loading: boolean;
}

/** These are expected answers, not a policy implementation: Main still decides live admission and grants. */
export function rankingContractState({ persona, state, privateRealm = false, sort = 'best', window = 'all' }: {
  persona: AnswerPersona; state: RankingState; privateRealm?: boolean;
  sort?: 'best' | 'top'; window?: 'week' | 'month' | 'all';
}): RankingContractState {
  const actingSubject = rankingReader(persona);
  const cursor = state === 'continuation' ? `contract:${persona}:page-${privateRealm ? persona === 'member' ? 2 : 3 : 14}` :
    state === 'invalid-cursor' || state === 'moved' ? 'contract:another-viewer:page-2' : undefined;
  const request = { realm: rankingRealm, sort, window, cursor, actingSubject };
  const query = new URLSearchParams({ sort, window: sort === 'best' ? 'all' : window });
  if (cursor) query.set('cursor', cursor);
  if (actingSubject) query.set('actingSubject', actingSubject);
  const hidden = privateRealm && !['member', 'owner', 'moderator'].includes(persona);
  const status = state === 'missing' || hidden ? 404 : state === 'error' ? 503 :
    state === 'invalid-cursor' ? 400 : state === 'moved' ? 409 : 200;
  let items: ThreadSummary[] = [];
  if (status === 200 && state !== 'empty') {
    const history = privateRealm ? persona === 'member' ? 'current' : 'retained' : 'public';
    items = state === 'continuation' ? privateRealm && persona !== 'member'
      ? [item(40, 'current'), item(41, 'current')]
      : [item(privateRealm ? 41 : 260, privateRealm ? 'current' : 'public')] :
      Array.from({ length: 20 }, (_, index) => item(index + (privateRealm && persona === 'member' ? 21 : 0), history));
  }
  const code = status === 404 ? 'work_unavailable' : status === 400 ? 'invalid_realm_thread_read' :
    status === 409 ? 'read_basis_changed' : 'work_read_unavailable';
  const answer = status === 200 ? {
    profile: 'realm-threads-v1' as const, realm: rankingRealm, sort, window: sort === 'best' ? 'all' as const : window,
    items, nextCursor: items.length === 20 ? `contract:${persona}:page-2` : null,
    sourcePosition: rankingPosition, count: { value: items.length, kind: 'exact-page' as const, total: null },
  } : { type: `https://rezics.com/problems/${code}`, status, code,
    title: status === 404 ? 'Resource is unavailable' : 'The ranking read could not complete' };
  return { source: rankingStateSource, persona, realmState: state === 'missing' ? 'closed' : privateRealm ? 'private' : 'public',
    rights: { basis: 'original-contribution', author: rankingAuthor }, request,
    path: `/v1/realms/${rankingRealm.slice(-36)}/threads?${query}`, status, answer, loading: state === 'loading' };
}

/** Transport only: an unmatched request fails rather than fabricating a domain answer. */
export function rankingContractFetch(sample: RankingContractState): { fetcher: typeof fetch; dispose: () => void } {
  let release: (() => void) | undefined;
  let disposed = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (disposed) throw new DOMException('Ranking story ended', 'AbortError');
    const request = new Request(input, init);
    const url = new URL(request.url);
    const expected = new URL(sample.path, url.origin);
    if (request.method !== 'GET' || url.pathname !== `/api/main${expected.pathname}` ||
      [...expected.searchParams].some(([key, value]) => url.searchParams.get(key) !== value) ||
      [...url.searchParams].length !== [...expected.searchParams].length) throw new Error('Unexpected ranking contract request');
    if (sample.loading) return new Promise<Response>((_resolve, reject) => {
      release = () => reject(new DOMException('Ranking story ended', 'AbortError'));
    });
    return Response.json(sample.answer, { status: sample.status });
  }) as typeof fetch;
  return { fetcher, dispose: () => { disposed = true; release?.(); } };
}
