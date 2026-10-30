import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
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
      !contentId.test(input.revisionId)
    )
      throw notFound();
    return {
      postId: input.postId,
      revisionId: input.revisionId,
      credentialMode: 'credentialMode' in input && input.credentialMode === 'session' ? 'session' : 'anonymous',
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    let authorization: string | null = null;
    if (data.credentialMode === 'session') {
      try {
        const request = getRequest();
        await prepareSession(request, env as Partial<SessionEnv>);
        authorization = viewerCredential(request);
      } catch {
        authorization = null;
      }
    }
    const page = await loadExactRevision(kernelClient(), data, authorization);
    if (page.state === 'unavailable' || page.state === 'problem') setResponseStatus(page.status);
    return page;
  });
