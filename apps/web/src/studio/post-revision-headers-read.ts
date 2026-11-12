import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import {
  historicalReadEnvelope,
  preparedReaderProvenance,
  validateHistoricalReadBinding,
  type HistoricalReadEnvelope,
  type HistoricalReadTarget,
} from '../threads/historical-reader-provenance';
import {
  loadPostRevisionHeaders,
  revisionHeadersUnavailable,
  type PostRevisionHeadersPage,
} from './post-revision-headers';

const contentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Session preparation supplies the actual reader; a serialized binding is only a comparison operand. */
export const readPostRevisionHeaders = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('postId' in input) ||
      typeof input.postId !== 'string' ||
      !contentId.test(input.postId) ||
      ('cursor' in input &&
        input.cursor !== undefined &&
        (typeof input.cursor !== 'string' || input.cursor.length > 4096)) ||
      !('locale' in input) ||
      typeof input.locale !== 'string' ||
      input.locale.length < 1 ||
      input.locale.length > 64 ||
      !('credentialMode' in input) ||
      input.credentialMode !== 'session'
    )
      throw notFound();
    const cursor = 'cursor' in input && typeof input.cursor === 'string' ? input.cursor : undefined;
    const target: HistoricalReadTarget = {
      kind: 'post-revision-headers',
      postId: input.postId,
      cursor: cursor ?? null,
      locale: input.locale,
      credentialMode: 'session',
    };
    const binding = validateHistoricalReadBinding('binding' in input ? input.binding : undefined, target);
    if (!binding) throw notFound();
    return { postId: input.postId, ...(cursor === undefined ? {} : { cursor }), binding };
  })
  .handler(async ({ data }): Promise<HistoricalReadEnvelope<PostRevisionHeadersPage>> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    const subject = sessionSubject(request);
    const page =
      authorization && subject
        ? await loadPostRevisionHeaders(kernelClient(), data, authorization, request.signal)
        : revisionHeadersUnavailable();
    return historicalReadEnvelope(data.binding, preparedReaderProvenance(authorization, subject), page);
  });
