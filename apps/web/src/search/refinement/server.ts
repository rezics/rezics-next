import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { parseFilter, FILTER_LIMITS } from '@rezics/filter';
import { kernelClient } from '../../kernel/client';
import { requestLanguages } from '../../kernel/languages';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { readRelease } from '../../subject/definitions';
import { compileRefinement } from './model';
import { readFacetPage, facetProblem, type FacetState } from './request';
import { scopedRefinementRequests } from './scoped-refinement';
import { isSearchResourceScope, parseSearchResourceScope } from '../advanced-scope';
import { readScopedSearchReader } from '../search-reader';
import type { SearchLoaderDeps } from '../search-params';

const input = v.strictObject({
  query: v.pipe(
    v.string(),
    v.check((text) => new TextEncoder().encode(text).length <= 512),
  ),
  locale: v.pipe(v.string(), v.maxLength(35)),
  reader: v.exactOptional(v.pipe(v.string(), v.maxLength(256))),
  conditions: v.strictObject({
    kinds: v.exactOptional(v.pipe(v.array(v.string()), v.maxLength(FILTER_LIMITS.in))),
    languages: v.exactOptional(v.pipe(v.array(v.string()), v.maxLength(8))),
    filter: v.exactOptional(v.pipe(v.string(), v.maxLength(16384))),
    resourceScope: v.exactOptional(
      v.strictObject({
        kind: v.picklist(['realm', 'collection']),
        id: v.pipe(
          v.string(),
          v.check((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)),
        ),
      }),
    ),
    type: v.exactOptional(v.string()),
    facetValues: v.record(v.string(), v.pipe(v.array(v.string()), v.maxLength(FILTER_LIMITS.in))),
    ranges: v.exactOptional(
      v.record(
        v.string(),
        v.strictObject({
          gte: v.exactOptional(v.number()),
          lte: v.exactOptional(v.number()),
          unit: v.exactOptional(v.string()),
        }),
      ),
    ),
    condition: v.exactOptional(
      v.pipe(
        v.unknown(),
        v.transform((value) => parseFilter(value)),
      ),
    ),
  }),
  facets: v.pipe(
    v.array(
      v.strictObject({ property: v.string(), size: v.exactOptional(v.number()), cursor: v.exactOptional(v.string()) }),
    ),
    v.maxLength(8),
  ),
});

/** Refinement and result pages share the admitted scoped Search predicate and verified reader. */
export const readRefinement = createServerFn({ method: 'POST' })
  .validator((value: unknown) => v.parse(input, value))
  .handler(async ({ data }): Promise<FacetState> => {
    const requestContext = getRequest();
    const signal = requestContext.signal;
    const parsedScope = parseSearchResourceScope(data.conditions.filter);
    if (parsedScope.invalidInput) return { status: 'invalid', code: 'invalid_scope_filter' };
    const resourceScope = isSearchResourceScope(data.conditions.resourceScope)
      ? data.conditions.resourceScope
      : parsedScope.scope;
    if (
      resourceScope &&
      parsedScope.scope &&
      (resourceScope.kind !== parsedScope.scope.kind || resourceScope.id.toLowerCase() !== parsedScope.scope.id)
    )
      return { status: 'invalid', code: 'scope_mismatch' };
    const reader = resourceScope ? await readScopedSearchReader(requestContext) : undefined;
    if (resourceScope && (!reader || data.reader !== reader.owner))
      return { status: 'restart', httpStatus: 401, code: 'reader_changed' };
    const release = await readRelease();
    compileRefinement(release, data.conditions);
    const state: SearchLoaderDeps = {
      query: data.query,
      type: data.conditions.type,
      facets: data.conditions.facetValues,
      cursor: undefined,
      sort: undefined,
      ...(data.conditions.kinds ? { kinds: data.conditions.kinds } : {}),
      ...(data.conditions.languages ? { languages: data.conditions.languages } : {}),
      ...(data.conditions.filter ? { filter: data.conditions.filter } : {}),
      ...(resourceScope ? { resourceScope } : {}),
      ...(data.conditions.ranges ? { ranges: data.conditions.ranges } : {}),
      ...(data.conditions.condition ? { condition: data.conditions.condition } : {}),
    };
    let requests: ReturnType<typeof scopedRefinementRequests>;
    try {
      requests = scopedRefinementRequests(state, requestLanguages(data.locale), data.facets);
    } catch {
      return { status: 'invalid', code: 'invalid_refinement_request' };
    }
    const facetRead = requests.facets;
    if (!facetRead) return { status: 'invalid', code: 'invalid_refinement_request' };
    try {
      return await readFacetPage(facetRead, (body) =>
        kernelClient(data.locale).subjects.$facets.post(body, {
          ...(reader?.authorization ? { headers: { authorization: reader.authorization } } : {}),
          fetch: { signal },
        }),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (isPlatformClosedError(error))
        return {
          status: 'refused',
          httpStatus: error.status,
          code: 'platform_closed',
          problem: facetProblem(error.problem),
        };
      throw error;
    }
  });
