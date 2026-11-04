import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../../session/client';
import { kernelClient } from '../../kernel/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../../session/request';
import {
  preparedReviewReader,
  sameReviewReader,
  validateReviewReaderExpectation,
  type ReviewReaderExpectation,
  type ReviewReaderProvenance,
} from '../../subject/write-review-lifetime';
import { loadReviewDestinationPage, type ReviewDestinationPage } from '../review-board-choices';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReviewDestinationInput = {
  realmId: string;
  subjectId: string;
  locale: string;
  cursor?: string;
  boardId?: string;
  expected: ReviewReaderExpectation;
};

type ReviewDestinationRead =
  | { kind: 'ready'; page: ReviewDestinationPage; provenance: ReviewReaderProvenance }
  | { kind: 'mismatch' };

function validateReviewDestinationInput(input: unknown): ReviewDestinationInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid review destination request');
  const value = input as Record<string, unknown>;
  if (
    typeof value.realmId !== 'string' ||
    !uuid.test(value.realmId) ||
    typeof value.subjectId !== 'string' ||
    !uuid.test(value.subjectId) ||
    typeof value.locale !== 'string' ||
    value.locale.length < 2 ||
    value.locale.length > 32 ||
    (value.cursor !== undefined &&
      (typeof value.cursor !== 'string' || value.cursor.length < 1 || value.cursor.length > 4096)) ||
    (value.boardId !== undefined && (typeof value.boardId !== 'string' || !uuid.test(value.boardId))) ||
    (value.cursor !== undefined && value.boardId !== undefined)
  )
    throw new Error('Invalid review destination request');
  return {
    realmId: value.realmId,
    subjectId: value.subjectId,
    locale: value.locale,
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
    ...(typeof value.boardId === 'string' ? { boardId: value.boardId } : {}),
    expected: validateReviewReaderExpectation(value.expected),
  };
}

export const readReviewDestination = createServerFn({ method: 'GET' })
  .validator(validateReviewDestinationInput)
  .handler(async ({ data }): Promise<ReviewDestinationRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    request.signal.throwIfAborted();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    const provenance = await preparedReviewReader(sessionSubject(request), requestCsrfToken(request));
    request.signal.throwIfAborted();
    if (!authorization || !sameReviewReader(data.expected, provenance)) return { kind: 'mismatch' };
    const page = await loadReviewDestinationPage(
      kernelClient(
        data.locale,
        authorization,
        (fetcher) =>
          (async (input, init) => {
            request.signal.throwIfAborted();
            const response = await fetcher(input, {
              ...init,
              signal: request.signal,
              cache: 'no-store',
              credentials: 'omit',
            });
            request.signal.throwIfAborted();
            return response;
          }) as typeof fetch,
      ),
      {
        realmId: data.realmId,
        subjectId: data.subjectId,
        ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
        ...(data.boardId === undefined ? {} : { boardId: data.boardId }),
      },
      authorization,
    );
    const finalProvenance = await preparedReviewReader(sessionSubject(request), requestCsrfToken(request));
    request.signal.throwIfAborted();
    if (!sameReviewReader(data.expected, finalProvenance)) return { kind: 'mismatch' };
    return { kind: 'ready', page, provenance: provenance! };
  });
