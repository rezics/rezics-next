import type { KernelClient } from '@rezics/client';
import { requestLanguages } from '../kernel/languages.ts';
import { dependencyUnavailable, problem, problemResponse } from '../media/kernel.ts';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { parseNativeSuggestionPage } from './header-search/suggestion-page';
import { validSuggestionText } from './typeahead';
import type { SubjectHit } from './results.tsx';

type Suggested = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$suggest']['get']>>['data']>;
export type SuggestQuery = { q: string; limit: number; languages: string[]; filter?: string };
export const SUGGESTION_LIMIT = 8;

export function validateSuggestQuery(query: SuggestQuery): SuggestQuery {
  if (
    !validSuggestionText(query.q) ||
    !Number.isInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 10 ||
    query.languages.length < 1 ||
    query.languages.length > 8 ||
    new Set(query.languages).size !== query.languages.length ||
    query.languages.some((language) => language.length > 35 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(language)) ||
    (query.filter !== undefined && typeof query.filter !== 'string')
  )
    throw problem(400, 'invalid_request', 'Invalid suggestion parameters');
  return query;
}

/** One native operation, with the supplied identity and cancellation; never retry anonymously. */
export async function readSubjectSuggestions(
  client: KernelClient,
  query: SuggestQuery,
  credential: string | null,
  signal: AbortSignal,
): Promise<Suggested> {
  signal.throwIfAborted();
  const result = await client.subjects.$suggest.get({
    query: validateSuggestQuery(query),
    headers: credential === null ? {} : { authorization: credential },
    fetch: { signal },
  });
  signal.throwIfAborted();
  if (result.error) {
    const body = result.error.value as { code?: unknown };
    const failure = problem(
      result.status,
      typeof body?.code === 'string' ? body.code : 'dependency_unavailable',
      'Suggestions unavailable',
    );
    const retryAfter = new Headers(result.headers).get('retry-after');
    if (retryAfter !== null) throw Object.assign(failure, { headers: { 'retry-after': retryAfter } });
    throw failure;
  }
  try {
    const page = parseNativeSuggestionPage(result.data);
    return { ...page, subjects: page.subjects.slice(0, query.limit) };
  } catch (error) {
    if (error instanceof TypeError) throw dependencyUnavailable();
    throw error;
  }
}

/**
 * The kernel's suggestions with the names of the types they carry, so the typeahead can print each suggestion's type
 * without reading the definitions release in the browser.
 */
export type SuggestionResult = Omit<Suggested, 'subjects'> & {
  subjects: (Suggested['subjects'][number] & Pick<SubjectHit, 'summary' | 'facts'>)[];
  types: Record<string, Record<string, string>>;
};

export async function suggestSubjects(
  query: string,
  request: Request,
  requestedLocale?: string,
): Promise<SuggestionResult> {
  const [{ kernelClient, requestLocale }, { readRelease }, { viewerCredential }] = await Promise.all([
    import('../kernel/client.ts'),
    import('../subject/definitions.ts'),
    import('../session/request.ts'),
  ]);
  const locale = requestedLocale ?? new URL(request.url).searchParams.get('locale') ?? requestLocale(request);
  const languages = requestLanguages(locale ?? 'en');
  const rawLimit = new URL(request.url).searchParams.get('limit');
  const searchParams = new URL(request.url).searchParams;
  const filters = searchParams.getAll('filter');
  if (filters.length > 1) throw problem(400, 'invalid_request', 'Use one complete search filter');
  const languagesParam = searchParams.getAll('language');
  const parameters = validateSuggestQuery({
    q: query,
    limit: rawLimit === null ? SUGGESTION_LIMIT : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN,
    languages: languagesParam.length ? languagesParam : languages,
    ...(filters.length ? { filter: filters[0] } : {}),
  });
  // The release is cached by digest; a failed read leaves the suggestions without type names.
  const [result, release] = await Promise.all([
    readSubjectSuggestions(kernelClient(locale), parameters, viewerCredential(request), request.signal),
    readRelease().catch(() => undefined),
  ]);
  const types: SuggestionResult['types'] = {};
  for (const subject of result.subjects)
    if (release && Object.hasOwn(release.types, subject.type))
      types[subject.type] = release.types[subject.type]?.labels ?? {};
  return { ...result, types };
}

/** The shell and subject pickers share the ordinary, private no-store BFF route. */
export async function suggestionResponse(
  request: Request,
  env: Partial<SessionEnv>,
  read = suggestSubjects,
): Promise<Response> {
  const privateNoStore = (response: Response) => {
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
  if (request.method !== 'GET')
    return privateNoStore(new Response(null, { status: 405, headers: { allow: 'GET' } }));
  try {
    const [{ prepareSession, viewerCredential }, { carriesSession }] = await Promise.all([
      import('../session/request.ts'),
      import('../session/csrf.ts'),
    ]);
    const stale = await prepareSession(request, env);
    if (stale) throw problem(401, 'invalid_credentials', 'Sign in again');
    if (carriesSession(request) && !viewerCredential(request))
      throw problem(503, 'dependency_unavailable', 'Session unavailable');
    const query = new URL(request.url).searchParams.get('q') ?? '';
    return Response.json(await read(query, request), { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    if (isPlatformClosedError(error))
      return privateNoStore(problemResponse(problem(403, 'platform_closed', 'Not open yet')));
    return privateNoStore(problemResponse(error));
  }
}
