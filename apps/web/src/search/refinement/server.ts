import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { parseFilter, FILTER_LIMITS } from '@rezics/filter';
import { kernelClient } from '../../kernel/client';
import { requestLanguages } from '../../kernel/languages';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { readRelease } from '../../subject/definitions';
import { compileRefinement } from './model';
import { facetRequest, readFacetPage, facetProblem, type FacetState } from './request';

const input = v.strictObject({
  query: v.pipe(v.string(), v.maxLength(256)),
  locale: v.pipe(v.string(), v.maxLength(35)),
  conditions: v.strictObject({
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

/** The existing anonymous Search API boundary; no browser credential, permission mirror or alternate loader. */
export const readRefinement = createServerFn({ method: 'POST' })
  .validator((value: unknown) => v.parse(input, value))
  .handler(async ({ data }): Promise<FacetState> => {
    const signal = getRequest().signal;
    const release = await readRelease();
    const filter = compileRefinement(release, data.conditions);
    const request = facetRequest(
      {
        ...(data.query ? { text: data.query } : {}),
        ...(filter ? { filter } : {}),
        languages: requestLanguages(data.locale),
      },
      data.facets,
    );
    try {
      return await readFacetPage(request, (body) =>
        kernelClient(data.locale).subjects.$facets.post(body, { fetch: { signal } }),
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
