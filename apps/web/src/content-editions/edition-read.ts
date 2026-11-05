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
import { createNativeEditionApi } from './edition-api';
import { loadContentEdition, type ContentEditionState, type EditionContext } from './edition-model';
import { loadDocumentMedia } from './edition-media';

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
      if (!authorization) {
        setResponseStatus(401);
        return { state: 'refused', status: 401 };
      }
      // Native delivery must never use the development fixture transport.
      if (!(env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN) {
        setResponseStatus(503);
        return { state: 'unavailable', status: 503, reason: 'native-pending' };
      }
      const client = kernelClient();
      const context: EditionContext = {
        media: (ids, credential) => loadDocumentMedia(client, ids, credential),
        async subject(id) {
          const result = await client.subjects({ id }).get({
            ...(authorization ? { headers: { authorization } } : {}),
            fetch: { redirect: 'manual' },
          });
          if (result.status !== 200 || result.error || result.data?.subject.id !== id) return null;
          const label = pickText(result.data.subject.labels, getLocale()).text;
          return label ? { id, label } : null;
        },
        async creator(id) {
          // The existing identity point supplies public names only; never a profile/avatar read.
          const author = (await readPageAuthors(client, [id]))?.[id];
          if (!author || author.id !== id || author.state === 'deleted') return null;
          const name = author.displayName || (author.handle ? `@${author.handle}` : '');
          return name ? { id, name } : null;
        },
      };
      page = await loadContentEdition(createNativeEditionApi(client), data.editionId, authorization, context);
    } catch {
      page = { state: 'unavailable', status: 503, reason: 'dependency' };
    }
    if ('status' in page) setResponseStatus(page.status);
    return page;
  });
