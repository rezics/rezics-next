import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { requestLocale } from '../kernel/client.ts';
import { viewerCredential } from '../session/request.ts';
import { readRelease } from '../subject/definitions.ts';
import {
  conditionConceptRetryAdvice,
  conditionTypeExtends,
  type ConditionConceptReference,
} from './condition-concept-model';

const CONCEPT = 'skos:Concept';
const SCHEME = 'skos:ConceptScheme';
const IN_SCHEME = 'skos:inScheme';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function statusForFailure(status: number, code: unknown): Exclude<ConditionConceptReference['status'], 'ready'> {
  if (status === 202 || code === 'index_not_ready') return 'preparing';
  if (status === 409 || code === 'search_restart_required') return 'restart';
  if (status === 401 || status === 403 || code === 'platform_closed' || code === 'forbidden') return 'refused';
  if (status === 404 || status === 422 || code === 'unsupported_query') return 'unsupported';
  return 'unavailable';
}

function failureReference(
  status: number,
  code: unknown,
  id: string,
  headers: HeadersInit | undefined,
): ConditionConceptReference {
  const result = statusForFailure(status, code);
  if (result !== 'preparing' && result !== 'unavailable') return { status: result, id };
  const retryAfter = conditionConceptRetryAdvice(new Headers(headers).get('retry-after'));
  return { status: result, id, ...(retryAfter ? { retryAfter } : {}) };
}

function typeExtends(release: Awaited<ReturnType<typeof readRelease>>, type: string, base: string): boolean {
  return conditionTypeExtends(release.types, type, base);
}

function relationTarget(statement: SubjectRead['subject']['statements'][string][number]): string | undefined {
  return statement.value.type === 'value' && typeof statement.value.content === 'string'
    ? statement.value.content
    : undefined;
}

function conceptLabels(data: SubjectRead, id: string, locale: string): string | undefined {
  const labels = data.subject.id === id ? data.subject.labels : undefined;
  if (!labels) return;
  const text = pickText(labels, locale).text;
  return text || undefined;
}

function schemeReference(
  data: SubjectRead,
  id: string,
  locale: string,
  release: Awaited<ReturnType<typeof readRelease>>,
) {
  const related = data.related[id];
  if (
    !related ||
    !('labels' in related) ||
    typeof related.type !== 'string' ||
    !typeExtends(release, related.type, SCHEME)
  )
    return undefined;
  const label = pickText(related.labels ?? {}, locale).text;
  return { id, ...(label ? { label } : {}) };
}

/** Read one exact current Semantic subject and its directly asserted schemes; never walks the graph. */
export async function readConditionConcept(
  request: Request,
  id: string,
  digest: string,
): Promise<ConditionConceptReference> {
  const unavailable: ConditionConceptReference = { status: 'unavailable', id };
  if (!UUID.test(id) || digest.length < 1 || digest.length > 256) return unavailable;
  request.signal.throwIfAborted();
  try {
    const { kernelClient } = await import('../kernel/client.ts');
    const release = await readRelease();
    if (request.signal.aborted) return unavailable;
    if (!release.digest || release.digest !== digest) return { status: 'restart', id };
    const locale = new URL(request.url).searchParams.get('locale') ?? requestLocale(request) ?? 'en';
    const client = kernelClient(locale);
    const credential = viewerCredential(request);
    const result = await client.subjects({ id }).get({
      query: { language: locale },
      headers: credential === null ? {} : { authorization: credential },
      fetch: { signal: request.signal, redirect: 'manual', cache: 'no-store' },
    });
    if (request.signal.aborted) return unavailable;
    // The native subject route returns its preparation outcome as HTTP 202, which is still ok to fetch.
    if (result.status === 202) return failureReference(result.status, undefined, id, result.headers);
    if (result.error) {
      const body = result.error.value as { code?: unknown };
      return failureReference(result.status, body?.code, id, result.headers);
    }
    const data = result.data;
    if (!data || data.subject.id !== id) return unavailable;
    if (data.subject.release !== release.digest) return { status: 'restart', id };
    if (!typeExtends(release, data.subject.type, CONCEPT)) return { status: 'unsupported', id };

    const schemes = new Map<string, { id: string; label?: string }>();
    for (const statement of data.subject.statements[IN_SCHEME] ?? []) {
      const target = relationTarget(statement);
      if (!target || schemes.has(target)) continue;
      const scheme = schemeReference(data, target, locale, release);
      if (scheme) schemes.set(target, scheme);
    }
    if (!schemes.size) return { status: 'unsupported', id };
    const label = conceptLabels(data, id, locale);
    return { status: 'ready', id, ...(label ? { label } : {}), schemes: [...schemes.values()] };
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (error instanceof TypeError || error instanceof SyntaxError) return unavailable;
    throw error;
  }
}
