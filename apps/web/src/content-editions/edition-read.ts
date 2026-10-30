import { pickText } from '@rezics/composition';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server';
import { notFound } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { readPageAuthors } from '../identity/read';
import { UUID } from '../checkout/price';
import { getLocale } from '../paraglide/runtime.js';
import { prepareSession, viewerCredential } from '../session/request';
import type { SessionEnv } from '../session/client';
import { recordPageReadCacheControl } from '../security/page-cache';
import { nativeEditionApi } from './edition-api';
import { loadContentEdition, type ContentEditionState, type EditionContext } from './edition-model';

export const readContentEdition = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('editionId' in input) ||
      typeof input.editionId !== 'string' ||
      !UUID.test(input.editionId)
    )
      throw notFound();
    return { editionId: input.editionId };
  })
  .handler(async ({ data }): Promise<ContentEditionState> => {
    const request = getRequest();
    setResponseHeader('cache-control', 'private, no-store');
    recordPageReadCacheControl(request, 'private, no-store');
    let page: ContentEditionState;
    try {
      // Resolve the real delivery actor even during SSR. Never borrow the seller's or a Commerce snapshot's identity.
      await prepareSession(request, env as Partial<SessionEnv>);
      const authorization = viewerCredential(request);
      const context: EditionContext = {
        async subject(id) {
          const result = await kernelClient()
            .subjects({ id })
            .get({
              ...(authorization ? { headers: { authorization } } : {}),
              fetch: { redirect: 'manual' },
            });
          if (result.status !== 200 || result.error || result.data?.subject.id !== id) return null;
          const label = pickText(result.data.subject.labels, getLocale()).text;
          return label ? { id, label } : null;
        },
        async creator(id) {
          // The existing identity point supplies public names only; never a profile/avatar read.
          const author = (await readPageAuthors(kernelClient(), [id]))?.[id];
          if (!author || author.id !== id || author.state === 'deleted') return null;
          const name = author.displayName || (author.handle ? `@${author.handle}` : '');
          return name ? { id, name } : null;
        },
      };
      page = await loadContentEdition(nativeEditionApi, data.editionId, authorization, context);
    } catch {
      page = { state: 'unavailable', status: 503, reason: 'dependency' };
    }
    if ('status' in page) setResponseStatus(page.status);
    return page;
  });
