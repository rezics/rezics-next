import { expectedCandidateReader } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { isTermsCommand, type TermsCommand, type TermsRead, type TermsResult } from './subject-terms';
import { patchSubjectTerms, readSubjectTerms } from './subject-terms-request';

export const loadCatalogueTerms = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; session?: string; expectedReader?: string | null }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
    )
      throw new Error('Invalid terms read');
    return {
      expectedReader: input.expectedReader == null ? null : expectedCandidateReader(input),
      id: input.id,
      ...(input.session === undefined ? {} : { session: input.session }),
    };
  })
  .handler(async ({ data }): Promise<TermsRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    try {
      await prepareSession(request, env as Partial<SessionEnv>);
      if (data.expectedReader !== null && sessionSubject(request) !== data.expectedReader) return { state: 'denied' };
      if (data.expectedReader === null && data.session) return { state: 'denied' };
      return readSubjectTerms(
        kernelClient(),
        data.id,
        requestLocale() ?? 'en',
        data.expectedReader === null ? undefined : (viewerCredential(request) ?? undefined),
        data.session,
      );
    } catch {
      return { state: 'unavailable' };
    }
  });

export const saveCatalogueTerms = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: TermsCommand): TermsCommand => {
      if (!isTermsCommand(input)) throw new Error('Invalid terms patch');
      return {
        id: input.id,
        etag: input.etag,
        key: input.key,
        patch: input.patch,
        ...(input.session ? { session: input.session } : {}),
      };
    }),
  )
  .handler(async ({ data }): Promise<TermsResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return patchSubjectTerms(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      data,
      requestLocale() ?? 'en',
      data.expectedReader,
    );
  });
