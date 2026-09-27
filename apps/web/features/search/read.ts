import { iriOf } from '../discover/scope.ts';
import { type MainClient, problemCode, type WorkCover, type WorkName } from '../discover/types.ts';
import type { SearchState } from './state.ts';
import { reasonsOf, type SearchContinuation, searchFailureOf, type SearchLoaded, type SearchPage,
  type SearchPageRequest } from './types.ts';

export const SEARCH_PAGE_SIZE = 10;

/** The phrase page profile for a state: Main or Realm context, with or without a classification term. */
export function searchRequest(state: SearchState, continuation?: SearchContinuation): SearchPageRequest {
  const base = { phrase: state.phrase, language: state.language, pageSize: SEARCH_PAGE_SIZE,
    ...(continuation ? { continuation } : {}) };
  const context = state.scope.kind === 'realm'
    ? { kind: 'realm-local' as const, id: iriOf(state.scope.realm) } : null;
  if (state.term) {
    const sense = iriOf(state.term);
    return context ? { profile: 'public-realm-classified-phrase-page-v1', context, sense, ...base }
      : { profile: 'public-main-classified-phrase-page-v1', sense, ...base };
  }
  return context ? { profile: 'public-realm-phrase-page-v1', context, ...base }
    : { profile: 'public-main-phrase-page-v1', ...base };
}

type Named = { name: WorkName; avatar: WorkCover };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function nameOf(value: unknown): WorkName | null {
  if (!object(value) || typeof value.value !== 'string' || typeof value.language !== 'string') return null;
  if (value.direction !== 'ltr' && value.direction !== 'rtl') return null;
  if (value.basis !== 'requested' && value.basis !== 'fallback') return null;
  return { value: value.value, language: value.language, direction: value.direction, basis: value.basis };
}

function avatarOf(value: unknown): WorkCover | null {
  if (!object(value)) return null;
  if (value.kind === 'fallback' && typeof value.policy === 'string' && typeof value.key === 'string'
    && typeof value.resourceType === 'string') {
    return { kind: 'fallback', policy: value.policy, key: value.key, resourceType: value.resourceType };
  }
  if (value.kind === 'image' && typeof value.url === 'string' && value.url.startsWith('/v1/media/')
    && typeof value.selection === 'string' && typeof value.mediaType === 'string'
    && Number.isInteger(value.width) && Number.isInteger(value.height) && object(value.basis)
    && typeof value.basis.policy === 'string' && typeof value.basis.context === 'string') {
    return { kind: 'image', url: value.url, selection: value.selection, mediaType: value.mediaType,
      width: value.width as number, height: value.height as number,
      crop: typeof value.crop === 'string' ? value.crop : null,
      basis: { policy: value.basis.policy, context: value.basis.context } };
  }
  return null;
}

/**
 * Names and covers for results, in one bounded batch. Main declares this
 * response untyped, so each summary is checked here before it is shown.
 * Null when Main could not answer: the results still stand, without names.
 */
export async function readSummaries(main: MainClient, resources: readonly string[], language: string,
  actingSubject?: string): Promise<Map<string, Named> | null> {
  if (!resources.length) return new Map();
  try {
    const { data, error } = await main.v1.resources.summaries.post({ profile: 'resource-summary-batch-v1',
      resources: [...resources], language, ...(actingSubject ? { actingSubject } : {}) });
    if (error || !object(data) || !Array.isArray(data.summaries)) return null;
    const named = new Map<string, Named>();
    for (const item of data.summaries as unknown[]) {
      if (!object(item) || item.status !== 'available' || typeof item.reference !== 'string') continue;
      const name = nameOf(item.name);
      const avatar = avatarOf(item.avatar);
      if (name && avatar) named.set(item.reference, { name, avatar });
    }
    return named;
  } catch {
    return null;
  }
}

/**
 * One page of phrase results, then one summary batch for their Works and
 * concepts. `search` carries the session (for its mutes); `names` may be
 * anonymous, since only public Works are ever results.
 */
export async function readSearchPage(clients: { search: MainClient; names: MainClient }, state: SearchState,
  options: { language: string; actingSubject?: string; continuation?: SearchContinuation }): Promise<SearchLoaded> {
  let page: SearchPage;
  try {
    const { data, error } = await clients.search.v1.queries.page.post(searchRequest(state, options.continuation));
    if (error) return { ok: false, failure: searchFailureOf(error.status, problemCode(error.value)) };
    if (!data || data.profile === 'public-content-phrase-page-v1') return { ok: false, failure: 'unavailable' };
    page = data;
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
  const matches = page.results.map(match => ({ match, reasons: reasonsOf(match) }));
  const concepts = matches.flatMap(({ reasons }) => reasons.classification?.concept ?? []);
  const named = await readSummaries(clients.names, [...new Set([...matches.map(({ match }) => match.work),
    ...concepts])], options.language, options.actingSubject);
  return { ok: true, page: { total: page.total, population: page.population, sequence: page.sourcePosition.sequence,
    indexGeneration: page.indexGeneration, next: page.next, titles: named !== null,
    hits: matches.map(({ match, reasons }) => ({ matchUnit: match.matchUnit, work: match.work,
      mainVersion: match.mainVersion, title: named?.get(match.work)?.name ?? null,
      cover: named?.get(match.work)?.avatar ?? null,
      reasons: { ...reasons, classification: reasons.classification ? { ...reasons.classification,
        conceptName: reasons.classification.concept
          ? named?.get(reasons.classification.concept)?.name ?? null : null } : null } })) } };
}
