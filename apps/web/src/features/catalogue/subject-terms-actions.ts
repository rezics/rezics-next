import { expectedCandidateReader } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { cookie, SESSION_COOKIE } from '../../session/cookies';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import {
  isTermsCommand,
  unavailableTermsAuthority,
  type TermsCommand,
  type TermsPageAuthority,
  type TermsRead,
  type TermsResult,
  type TermsViewerState,
} from './subject-terms';
import { patchSubjectTerms, readSubjectTerms, readTermsPageAuthority } from './subject-terms-request';

function currentViewer(request: Request, stale: boolean): TermsViewerState {
  if (viewerCredential(request)) return 'signed-in';
  if (stale || cookie(request, SESSION_COOKIE) === undefined) return 'signed-out';
  return 'unavailable';
}

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
      if ((sessionSubject(request) ?? null) !== data.expectedReader) return { state: 'denied' };
      if (data.expectedReader === null && data.session) return { state: 'denied' };
      const client = kernelClient();
      const authorization = viewerCredential(request) ?? undefined;
      const read = await readSubjectTerms(
        client,
        data.id,
        requestLocale() ?? 'en',
        authorization,
        data.session,
      );
      return read;
    } catch {
      return { state: 'unavailable' };
    }
  });

export const readCatalogueTermsAuthority = createServerFn({ method: 'GET', strict: false })
  .validator((input: { expectedReader?: string | null }) => {
    if (
      !input ||
      (input.expectedReader !== undefined && input.expectedReader !== null && typeof input.expectedReader !== 'string')
    )
      throw new Error('Invalid terms authority read');
    return { expectedReader: input.expectedReader == null ? null : expectedCandidateReader(input) };
  })
  .handler(async ({ data }): Promise<TermsPageAuthority> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    try {
      const stale = await prepareSession(request, env as Partial<SessionEnv>);
      if ((sessionSubject(request) ?? null) !== data.expectedReader) return unavailableTermsAuthority;
      const authorization = viewerCredential(request) ?? undefined;
      return readTermsPageAuthority(kernelClient(), currentViewer(request, stale), authorization);
    } catch {
      return unavailableTermsAuthority;
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
