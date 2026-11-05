import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import {
  historicalReadEnvelope,
  preparedReaderProvenance,
  validateHistoricalReadBinding,
  type HistoricalReadBinding,
  type HistoricalReadEnvelope,
  type HistoricalReadTarget,
} from './historical-reader-provenance';
import { loadExactRevision } from './exact-revision';

const contentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const readExactRevision = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('postId' in input) ||
      typeof input.postId !== 'string' ||
      !contentId.test(input.postId) ||
      !('revisionId' in input) ||
      typeof input.revisionId !== 'string' ||
      !contentId.test(input.revisionId) ||
      !('locale' in input) ||
      typeof input.locale !== 'string' ||
      input.locale.length < 1 ||
      input.locale.length > 64 ||
      !('credentialMode' in input) ||
      (input.credentialMode !== 'anonymous' && input.credentialMode !== 'session')
    )
      throw notFound();
    const target: HistoricalReadTarget = {
      kind: 'exact-revision' as const,
      postId: input.postId,
      revisionId: input.revisionId,
      locale: input.locale,
      credentialMode: input.credentialMode,
    };
    const binding = validateHistoricalReadBinding('binding' in input ? input.binding : undefined, target);
    if (!binding) throw notFound();
    return { ...target, binding };
  })
  .handler(async ({ data }): Promise<HistoricalReadEnvelope<Awaited<ReturnType<typeof loadExactRevision>>>> => {
    setResponseHeader('cache-control', 'private, no-store');
    let authorization: string | null = null;
    let subject: string | undefined;
    if (data.credentialMode === 'session') {
      try {
        const request = getRequest();
        await prepareSession(request, env as Partial<SessionEnv>);
        authorization = viewerCredential(request);
        subject = sessionSubject(request);
      } catch {
        authorization = null;
        subject = undefined;
      }
    }
    const page = await loadExactRevision(
      kernelClient(),
      { postId: data.postId, revisionId: data.revisionId },
      authorization,
    );
    if (page.state === 'unavailable' || page.state === 'problem') setResponseStatus(page.status);
    return historicalReadEnvelope(
      data.binding as HistoricalReadBinding,
      preparedReaderProvenance(authorization, subject),
      page,
    );
  });
