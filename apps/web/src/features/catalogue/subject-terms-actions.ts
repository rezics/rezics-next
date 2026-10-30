import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { isTermsCommand, type TermsCommand, type TermsRead, type TermsResult } from './subject-terms';
import { patchSubjectTerms, readSubjectTerms } from './subject-terms-request';

export const loadCatalogueTerms = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; session?: string }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
    )
      throw new Error('Invalid terms read');
    return { id: input.id, ...(input.session === undefined ? {} : { session: input.session }) };
  })
  .handler(async ({ data }): Promise<TermsRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    try {
      await prepareSession(request, env as Partial<SessionEnv>);
      return readSubjectTerms(
        kernelClient(),
        data.id,
        requestLocale() ?? 'en',
        viewerCredential(request) ?? undefined,
        data.session,
      );
    } catch {
      return { state: 'unavailable' };
    }
  });

export const saveCatalogueTerms = createServerFn({ method: 'POST', strict: false })
  .validator((input: TermsCommand): TermsCommand => {
    if (!isTermsCommand(input)) throw new Error('Invalid terms patch');
    return {
      id: input.id,
      etag: input.etag,
      key: input.key,
      patch: input.patch,
      ...(input.session ? { session: input.session } : {}),
    };
  })
  .handler(async ({ data }): Promise<TermsResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return patchSubjectTerms(kernelClient(), getRequest(), env as Partial<SessionEnv>, data, requestLocale() ?? 'en');
  });
