import type { KernelClient } from '@rezics/client';
import { requestLanguages } from '../kernel/languages.ts';
import { dependencyUnavailable, problem, problemResponse } from '../media/kernel.ts';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { parseNativeSuggestionPage } from './header-search/suggestion-page';
import { validSuggestionText } from './typeahead';
import type { SubjectHit } from './results.tsx';
import { parseSearchResourceScope } from './advanced-scope';

type Suggested = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$suggest']['get']>>['data']>;
export type SuggestQuery = { q: string; limit: number; languages: string[]; filter?: string; release?: string };
export const SUGGESTION_LIMIT = 8;
const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ConditionEntityLabelRead =
  | Readonly<{
      state: 'ready';
      id: string;
      labels: Record<string, string>;
      type: string;
      typeLabels: Record<string, string>;
    }>
  | Readonly<{ state: 'withheld'; id: string }>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidEntityRead(): never {
  throw problem(400, 'invalid_request', 'Invalid condition entity read');
}

function admittedConditionTargets(filter: string): string[] {
  let document: unknown;
  try {
    document = JSON.parse(filter);
  } catch {
    return invalidEntityRead();
  }
  const clauses =
    record(document) && Object.keys(document).length === 1 && Array.isArray(document.and) ? document.and : [document];
  const typeClauses = clauses.filter((clause) => record(clause) && Object.hasOwn(clause, 'type'));
  if (typeClauses.length !== 1) return invalidEntityRead();
  const typeClause = typeClauses[0]!;
  if (
    !record(typeClause) ||
    Object.keys(typeClause).length !== 1 ||
    !record(typeClause.type) ||
    Object.keys(typeClause.type).length !== 1 ||
    !Array.isArray(typeClause.type.in) ||
    typeClause.type.in.length < 1 ||
    typeClause.type.in.length > 64 ||
    typeClause.type.in.some((target) => typeof target !== 'string' || target.length === 0 || target.length > 256)
  )
    return invalidEntityRead();
  const parsedScope = parseSearchResourceScope(filter);
  if (parsedScope.invalidInput) return invalidEntityRead();
  const extras = clauses.filter((clause) => clause !== typeClause);
  if (extras.length !== (parsedScope.scope ? 1 : 0)) return invalidEntityRead();
  if (parsedScope.scope) {
    const extra = extras[0];
    if (
      !record(extra) ||
      Object.keys(extra).length !== 1 ||
      !record(extra[parsedScope.scope.kind]) ||
      Object.keys(extra[parsedScope.scope.kind] as Record<string, unknown>).length !== 1 ||
      (extra[parsedScope.scope.kind] as Record<string, unknown>).id !== parsedScope.scope.id
    )
      return invalidEntityRead();
  }
  return typeClause.type.in as string[];
}

function typeMatchesTarget(
  release: { types: Record<string, { bases?: readonly string[] }> },
  type: string,
  target: string,
  visited = new Set<string>(),
): boolean {
  if (type === target) return true;
  if (visited.has(type)) return false;
  visited.add(type);
  return (release.types[type]?.bases ?? []).some((base) => typeMatchesTarget(release, base, target, visited));
}

export function validateSuggestQuery(query: SuggestQuery): SuggestQuery {
  if (
    !validSuggestionText(query.q) ||
    !Number.isInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 10 ||
    query.languages.length < 1 ||
    query.languages.length > 8 ||
    new Set(query.languages).size !== query.languages.length ||
    query.languages.some(
      (language) => language.length > 35 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(language),
    ) ||
    (query.filter !== undefined && typeof query.filter !== 'string') ||
    (query.release !== undefined &&
      (typeof query.release !== 'string' || query.release.length < 1 || query.release.length > 256))
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
  const { release: _release, ...nativeQuery } = validateSuggestQuery(query);
  const result = await client.subjects.$suggest.get({
    query: nativeQuery,
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
  const releases = [...searchParams.getAll('release'), ...searchParams.getAll('digest')];
  if (releases.length > 1 || (releases.length === 1 && !releases[0]))
    throw problem(400, 'invalid_request', 'Use one definitions release');
  const languagesParam = searchParams.getAll('language');
  const parameters = validateSuggestQuery({
    q: query,
    limit: rawLimit === null ? SUGGESTION_LIMIT : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN,
    languages: languagesParam.length ? languagesParam : languages,
    ...(filters.length ? { filter: filters[0] } : {}),
    ...(releases.length ? { release: releases[0] } : {}),
  });
  // The release is cached by digest; a failed read leaves the suggestions without type names.
  const [result, release] = await Promise.all([
    readSubjectSuggestions(kernelClient(locale), parameters, viewerCredential(request), request.signal),
    readRelease().catch(() => undefined),
  ]);
  if (parameters.release && (!release || release.digest !== parameters.release))
    throw release ? problem(409, 'search_restart_required', 'Search definitions changed') : dependencyUnavailable();
  const types: SuggestionResult['types'] = {};
  for (const subject of result.subjects)
    if (release && Object.hasOwn(release.types, subject.type))
      types[subject.type] = release.types[subject.type]?.labels ?? {};
  return { ...result, types };
}

/** Read one admitted identity through the existing public subject.get operation; never substitute a name match. */
export async function readConditionEntityLabel(id: string, request: Request): Promise<ConditionEntityLabelRead> {
  if (!subjectIdPattern.test(id)) return invalidEntityRead();
  request.signal.throwIfAborted();
  const searchParams = new URL(request.url).searchParams;
  const filters = searchParams.getAll('filter');
  const releases = searchParams.getAll('release');
  if (filters.length !== 1 || releases.length !== 1) return invalidEntityRead();
  const targets = admittedConditionTargets(filters[0]!);
  const [{ kernelClient, requestLocale }, { readRelease }, { viewerCredential }] = await Promise.all([
    import('../kernel/client.ts'),
    import('../subject/definitions.ts'),
    import('../session/request.ts'),
  ]);
  const locale = searchParams.get('locale') ?? requestLocale(request) ?? 'en';
  const release = await readRelease().catch(() => undefined);
  request.signal.throwIfAborted();
  if (!release) throw dependencyUnavailable();
  const expectedRelease = releases[0]!;
  if (release.digest !== expectedRelease) throw problem(409, 'search_restart_required', 'Search definitions changed');
  if (targets.some((target) => !Object.hasOwn(release.types, target)))
    throw problem(409, 'search_restart_required', 'Search definitions changed');

  request.signal.throwIfAborted();
  const credential = viewerCredential(request);
  const result = await kernelClient(locale)
    .subjects({ id })
    .get({
      query: { language: locale },
      headers: credential ? { authorization: credential } : {},
      fetch: { signal: request.signal, redirect: 'manual' },
    });
  request.signal.throwIfAborted();
  if (result.status === 404 || result.status === 308) return { state: 'withheld', id };
  if (result.error || result.status !== 200) {
    const body = result.error?.value as { code?: unknown } | undefined;
    const failure = problem(
      result.status,
      typeof body?.code === 'string' ? body.code : 'dependency_unavailable',
      'Subject label unavailable',
    );
    const retryAfter = new Headers(result.headers).get('retry-after');
    if (retryAfter !== null) throw Object.assign(failure, { headers: { 'retry-after': retryAfter } });
    throw failure;
  }
  const subject = result.data?.subject;
  if (!subject || subject.id.toLowerCase() !== id.toLowerCase()) return { state: 'withheld', id };
  if (!targets.some((target) => typeMatchesTarget(release, subject.type, target))) return { state: 'withheld', id };
  return {
    state: 'ready',
    id,
    labels: subject.labels,
    type: subject.type,
    typeLabels: release.types[subject.type]?.labels ?? {},
  };
}

/** The shell and subject pickers share the ordinary, private no-store BFF route. */
export async function suggestionResponse(
  request: Request,
  env: Partial<SessionEnv>,
  read = suggestSubjects,
  readEntity = readConditionEntityLabel,
): Promise<Response> {
  const privateNoStore = (response: Response) => {
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
  if (request.method !== 'GET') return privateNoStore(new Response(null, { status: 405, headers: { allow: 'GET' } }));
  try {
    const [{ prepareSession, viewerCredential }, { carriesSession }] = await Promise.all([
      import('../session/request.ts'),
      import('../session/csrf.ts'),
    ]);
    const stale = await prepareSession(request, env);
    if (stale) throw problem(401, 'invalid_credentials', 'Sign in again');
    if (carriesSession(request) && !viewerCredential(request))
      throw problem(503, 'dependency_unavailable', 'Session unavailable');
    const searchParams = new URL(request.url).searchParams;
    const conceptIds = searchParams.getAll('concept');
    const entityIds = searchParams.getAll('id');
    if (conceptIds.length) {
      if (
        conceptIds.length !== 1 ||
        entityIds.length > 0 ||
        searchParams.has('q') ||
        searchParams.has('filter') ||
        searchParams.has('release')
      )
        throw problem(400, 'invalid_request', 'Use one Concept read without a scoped filter');
      const digests = searchParams.getAll('digest');
      if (digests.length !== 1 || !digests[0]) throw problem(400, 'invalid_request', 'Use one definitions release');
      const { readConditionConcept } = await import('./condition-concept-read');
      return Response.json(await readConditionConcept(request, conceptIds[0]!, digests[0]), {
        headers: { 'cache-control': 'private, no-store' },
      });
    }
    if (entityIds.length) {
      if (entityIds.length !== 1 || searchParams.has('q'))
        throw problem(400, 'invalid_request', 'Use one suggestion or entity read');
      return Response.json(await readEntity(entityIds[0]!, request), {
        headers: { 'cache-control': 'private, no-store' },
      });
    }
    const query = searchParams.get('q') ?? '';
    return Response.json(await read(query, request), { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    if (isPlatformClosedError(error))
      return privateNoStore(problemResponse(problem(403, 'platform_closed', 'Not open yet')));
    return privateNoStore(problemResponse(error));
  }
}
