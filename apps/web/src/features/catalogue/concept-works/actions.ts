import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { locales } from '../../../paraglide/runtime.js';
import { exploreContext } from '../../pages/graph-browser/actions';
import { readConceptWorksPage } from './index';
import type { DiscoveryRequest } from '../../../search/discovery';

type PublicConceptWorksInput = { locale: string; request: DiscoveryRequest };

function validate(input: PublicConceptWorksInput): PublicConceptWorksInput {
  if (
    !input ||
    !locales.some((locale) => locale === input.locale) ||
    !input.request ||
    input.request.representation !== 'discovery-v1' ||
    input.request.limit !== 24 ||
    !Array.isArray(input.request.languages) ||
    input.request.languages.length !== 1 ||
    input.request.languages[0] !== input.locale ||
    input.request.kindPage?.limit !== 8 ||
    (input.request.cursor !== undefined &&
      (typeof input.request.cursor !== 'string' || new TextEncoder().encode(input.request.cursor).byteLength > 4096)) ||
    new TextEncoder().encode(JSON.stringify(input.request)).byteLength > 65_536
  )
    throw new Error('Invalid concept works selection');
  return structuredClone(input);
}

/** Anonymous public Search visit. Signed-in readers use Search's current private aggregate/action adapter. */
export const readPublicConceptWorks = createServerFn({ method: 'POST', strict: false })
  .validator(validate)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const prepared = await exploreContext(data.locale, null);
    if (!prepared) return { status: 'denied' as const };
    const signal = getRequest().signal;
    return readConceptWorksPage(data.request, (body) =>
      prepared.client.subjects.$search.post(body, { fetch: { signal, cache: 'no-store' } }),
    );
  });
