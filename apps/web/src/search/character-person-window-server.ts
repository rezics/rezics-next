import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { kernelClient } from '../kernel/client';
import { FILTER_LIMITS } from '@rezics/filter';
import {
  characterPersonRequest,
  characterPersonSearchFromFields,
  parseCharacterPersonSearch,
} from './character-person';
import { readDiscovery, readDiscoveryKinds } from './discovery';
import { parseQueryShare, shareUnavailable } from './query-share';

const searchSchema = v.pipe(
  v.object({
    mode: v.picklist(['characters', 'people', 'works']),
    name: v.pipe(v.string(), v.maxLength(512)),
    works: v.pipe(v.array(v.string()), v.maxLength(FILTER_LIMITS.in)),
    kinds: v.pipe(v.array(v.string()), v.maxLength(FILTER_LIMITS.in)),
    role: v.optional(v.pipe(v.string(), v.maxLength(128))),
    languages: v.pipe(v.array(v.string()), v.maxLength(8)),
    threshold: v.picklist([0, 1, 2]),
    sort: v.picklist(['name', 'relevance']),
    cursor: v.optional(v.pipe(v.string(), v.maxLength(4864))),
  }),
  v.check((search) => {
    const parsed = parseCharacterPersonSearch(
      {
        mode: search.mode,
        name: search.name,
        work: search.works,
        kinds: search.kinds,
        role: search.role,
        language: search.languages,
        threshold: search.threshold,
        sort: search.sort,
        cursor: search.cursor,
      },
      'en',
    );
    return parsed.error === undefined;
  }, 'Invalid credited search request'),
);

/** One native read at the requested address. Native restart remains a deliberate first-window action. */
export const readCharacterPerson = createServerFn({ method: 'GET' })
  .validator(v.object({ locale: v.string(), search: searchSchema }))
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const signal = getRequest().signal;
    return readDiscovery(characterPersonRequest(characterPersonSearchFromFields(data.search)), (body) =>
      kernelClient(data.locale).subjects.$search.post(body, { fetch: { signal, cache: 'no-store' } }),
    );
  });

/** Continue the bounded kind directory under the same credited query and reader request. */
export const readCharacterPersonKinds = createServerFn({ method: 'GET' })
  .validator(
    v.object({
      locale: v.string(),
      search: searchSchema,
      cursor: v.pipe(v.string(), v.minLength(1), v.maxLength(4864)),
    }),
  )
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const signal = getRequest().signal;
    const request = characterPersonRequest(characterPersonSearchFromFields({ ...data.search, cursor: undefined }));
    return readDiscoveryKinds(request, data.cursor, (body) =>
      kernelClient(data.locale).subjects.$search.post(body, { fetch: { signal, cache: 'no-store' } }),
    );
  });

/** Prepare an ordinary, current-reader share document for the exact credited query. */
export const prepareCharacterPersonShare = createServerFn({ method: 'GET' })
  .validator(v.object({ locale: v.string(), search: searchSchema }))
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const signal = getRequest().signal;
    try {
      const response = await kernelClient(data.locale).subjects.$search.post(
        {
          ...characterPersonRequest(characterPersonSearchFromFields({ ...data.search, cursor: undefined })),
          prepareShare: true,
        },
        { fetch: { signal, cache: 'no-store' } },
      );
      return response.status === 200 ? parseQueryShare(response.data) : shareUnavailable();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return shareUnavailable();
    }
  });
