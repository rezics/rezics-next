import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import {
  CURRENT_REVIEW_VOTE_UNAVAILABLE,
  loadCurrentReviewVote,
  type CurrentReviewVoteReadResult,
} from './review-vote';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Existing private read seam; callers never submit a vote the viewer did not explicitly select. */
export const readCurrentReviewVote = createServerFn({ method: 'GET' })
  .validator((input: unknown): { subjectId: string } => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('subjectId' in input) ||
      typeof input.subjectId !== 'string' ||
      !uuid.test(input.subjectId)
    )
      throw new Error('Invalid review subject');
    return { subjectId: input.subjectId };
  })
  .handler(async ({ data }): Promise<CurrentReviewVoteReadResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) return CURRENT_REVIEW_VOTE_UNAVAILABLE;
    return loadCurrentReviewVote(kernelClient(), data.subjectId, authorization);
  });
