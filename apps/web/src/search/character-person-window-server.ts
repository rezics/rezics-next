import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { kernelClient } from '../kernel/client';
import { characterPersonRequest, type CharacterPersonSearch } from './character-person';
import { readDiscovery } from './discovery';

const searchSchema = v.object({
  mode: v.picklist(['characters', 'people']),
  name: v.string(),
  works: v.array(v.string()),
  role: v.optional(v.string()),
  languages: v.array(v.string()),
  threshold: v.picklist([0, 1, 2]),
  sort: v.picklist(['name', 'relevance']),
  cursor: v.optional(v.string()),
});

/** One native read at the requested address. Native restart remains a deliberate first-window action. */
export const readCharacterPerson = createServerFn({ method: 'GET' })
  .validator(v.object({ locale: v.string(), search: searchSchema }))
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const signal = getRequest().signal;
    return readDiscovery(characterPersonRequest(data.search as CharacterPersonSearch), (body) =>
      kernelClient(data.locale).subjects.$search.post(body, { fetch: { signal, cache: 'no-store' } }),
    );
  });
