import * as v from 'valibot';
import type { FilterDocument } from '@rezics/filter';
import type { SearchResourceScope } from '../advanced-scope';
import { searchRetryAt } from '../search-recovery-retry';

export type RequestedFacet = { property: string; size?: number; cursor?: string };
export type FacetRequest = { text?: string; filter?: FilterDocument; languages?: string[]; facets: RequestedFacet[] };
const problem = v.object({
  type: v.exactOptional(v.string()),
  title: v.exactOptional(v.string()),
  status: v.exactOptional(v.number()),
  code: v.exactOptional(v.string()),
  detail: v.exactOptional(v.string()),
  retryable: v.exactOptional(v.boolean()),
  effect_status: v.exactOptional(v.string()),
  request_id: v.exactOptional(v.string()),
  errors: v.exactOptional(v.array(v.object({ pointer: v.string(), code: v.string() }))),
});
export function facetProblem(input: unknown): v.InferOutput<typeof problem> | undefined {
  const body = input && typeof input === 'object' && 'value' in input ? input.value : input;
  const parsed = v.safeParse(problem, body);
  return parsed.success ? parsed.output : undefined;
}
const value = v.strictObject({ value: v.string(), labels: v.record(v.string(), v.string()) });
const facet = v.strictObject({ property: v.string(), values: v.array(value), next: v.nullable(v.string()) });
const page = v.strictObject({ facets: v.array(facet), as_of: v.pipe(v.string(), v.isoTimestamp()) });
export type FacetPage = v.InferOutput<typeof page>;
export type FacetState =
  | { status: 'ready'; page: FacetPage }
  | {
      status: 'unavailable' | 'preparing' | 'refused' | 'withheld' | 'invalid' | 'restart';
      code?: string;
      httpStatus?: number;
      retryAt?: number;
      problem?: v.InferOutput<typeof problem> | undefined;
    };
export type FacetResponse = { status: number; data?: unknown; error?: unknown; response?: { headers: Headers } };

export function problemCode(problem: unknown): string | undefined {
  if (!problem || typeof problem !== 'object') return;
  if ('code' in problem && typeof problem.code === 'string') return problem.code;
  if ('value' in problem) return problemCode(problem.value);
}

export function facetRequest(context: Omit<FacetRequest, 'facets'>, facets: RequestedFacet[]): FacetRequest {
  if (!facets.length || facets.length > 8 || new Set(facets.map((entry) => entry.property)).size !== facets.length)
    throw new Error('Invalid facet properties');
  for (const entry of facets) {
    if (entry.size !== undefined && (!Number.isInteger(entry.size) || entry.size < 1 || entry.size > 20))
      throw new Error('Invalid facet size');
    if (entry.cursor !== undefined && (typeof entry.cursor !== 'string' || !entry.cursor.length))
      throw new Error('Invalid facet cursor');
  }
  return { ...context, facets };
}

/** A legacy preview cannot prove exhaustion. Keep native order and reject count metadata. */
export async function readFacetPage(
  request: FacetRequest,
  send: (request: FacetRequest) => Promise<FacetResponse>,
): Promise<FacetState> {
  const response = await send(request);
  const code = problemCode(response.error);
  const retryAt = searchRetryAt(response.response?.headers.get('retry-after') ?? null, Date.now());
  if (response.status !== 200 || response.error)
    return {
      status:
        response.status === 409 && code === 'search_restart_required'
          ? 'restart'
          : code === 'coverage_withheld'
            ? 'withheld'
            : response.status === 403 || response.status === 404
              ? 'refused'
              : response.status === 202 || code === 'index_not_ready' || code === 'preparing'
                ? 'preparing'
                : response.status === 400 || response.status === 422 || code === 'invalid_request'
                  ? 'invalid'
                  : 'unavailable',
      httpStatus: response.status,
      ...(retryAt !== undefined ? { retryAt } : {}),
      ...(code ? { code } : {}),
      problem: facetProblem(response.error ?? response.data),
    };
  const parsed = v.safeParse(page, response.data);
  if (!parsed.success || parsed.output.facets.length !== request.facets.length)
    return { status: 'invalid', code: 'invalid_facet_response' };
  for (const [index, result] of parsed.output.facets.entries()) {
    const asked = request.facets[index]!;
    const size = asked.size ?? 10;
    if (
      result.property !== asked.property ||
      result.values.length > size ||
      new Set(result.values.map((entry) => entry.value)).size !== result.values.length ||
      (result.next !== null &&
        (result.next.length === 0 || result.next === asked.cursor || result.values.length !== size)) ||
      (asked.cursor && result.values.length === 0)
    )
      return { status: 'invalid', code: 'invalid_facet_response' };
  }
  return { status: 'ready', page: parsed.output };
}

/** Scope component state by actual reader, languages, meaning and effective source/predicate. Tokens stay out. */
export function refinementKey(context: {
  principal: string;
  languages: string[];
  release: string;
  source: string;
  text: string;
  filter?: FilterDocument;
  scope?: SearchResourceScope;
}) {
  return JSON.stringify({ ...context, scope: context.scope ?? null });
}
