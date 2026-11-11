import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { CurrentPost } from '../threads/actions';
import type { StudioResult } from './contract';

type AvailablePost = Extract<CurrentPost, { availability: 'available' }>;
export type PostDocumentHead = Readonly<{ post: AvailablePost; title: string; viewerId: string }>;
const contentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const accountId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Current Content disclosure only. Project membership remains the mounted consumer's native admission. */
export const readPostDocumentHead = createServerFn({ method: 'GET' })
  .validator((input: { postId: string; accountId: string }) => {
    if (!input || !contentId.test(input.postId) || !accountId.test(input.accountId))
      throw new Error('Invalid Studio document address');
    return { postId: input.postId, accountId: input.accountId };
  })
  .handler(async ({ data }): Promise<StudioResult<PostDocumentHead>> => {
    setResponseHeader('cache-control', 'private, no-store');
    const unavailable = (): StudioResult<PostDocumentHead> => ({
      ok: false,
      error: { kind: 'unavailable', message: 'This document is unavailable. Try again.' },
    });
    try {
      const request = getRequest();
      await prepareSession(request, env as Partial<SessionEnv>);
      const authorization = viewerCredential(request);
      const viewerId = sessionSubject(request);
      if (!authorization || viewerId !== data.accountId)
        return { ok: false, error: { kind: 'denied', message: 'Open this workspace with its original account.' } };
      const client = kernelClient();
      const options = { headers: { authorization }, fetch: { cache: 'no-store' as const, signal: request.signal } };
      const result = await client.posts({ id: data.postId }).get(options);
      if (result.error || !result.data) return unavailable();
      const post = result.data.post;
      if (post.id !== data.postId || post.availability !== 'available') return unavailable();
      // A head must carry the strong native revision used by the existing If-Match writer.
      if (new Headers(result.headers).get('etag') !== JSON.stringify(post.revisionId)) return unavailable();
      const context = await client.threads({ id: post.threadId }).get(options);
      if (context.error || !context.data) return unavailable();
      const thread = context.data.thread;
      if (thread.id !== post.threadId || thread.firstPost.availability !== 'available' || thread.title === null)
        return unavailable();
      // Post revisions have no title field. This is the current conversation label, never a saved title.
      return { ok: true, value: { post, title: thread.title, viewerId } };
    } catch {
      return unavailable();
    }
  });
