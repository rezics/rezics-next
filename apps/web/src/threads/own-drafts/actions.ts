import { checkDocument, hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import type { CurrentPost, EditFailure, RevisedPost, WriteFailure } from '../actions';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid own-draft command');
  return value;
}

function publishInput(value: unknown) {
  if (!value || typeof value !== 'object' || !('body' in value) || !checkDocument(value.body))
    throw new Error('Invalid own-draft publication');
  const body = value.body as DocumentSnapshot;
  if (body.profile !== 'blocks' || !hasDocumentContent(body)) throw new Error('Invalid own-draft publication');
  if (!('revisionId' in value) || typeof value.revisionId !== 'string' || !value.revisionId || value.revisionId.length > 128)
    throw new Error('Invalid own-draft revision');
  if (!('mediaIds' in value) || !Array.isArray(value.mediaIds) || value.mediaIds.length > 32)
    throw new Error('Invalid own-draft media');
  if (!value.mediaIds.every((id) => typeof id === 'string' && id.length > 0) || new Set(value.mediaIds).size !== value.mediaIds.length)
    throw new Error('Invalid own-draft media');
  return {
    postId: requiredId('postId' in value ? value.postId : undefined),
    body,
    revisionId: value.revisionId,
    idempotencyKey: requiredId('idempotencyKey' in value ? value.idempotencyKey : undefined),
    mediaIds: value.mediaIds as string[],
  };
}

function failure(status: number): WriteFailure {
  if (status === 404) return { ok: false, reason: 'not-found' };
  if (status === 403 || status === 401) return { ok: false, reason: 'forbidden' };
  if (status === 409) return { ok: false, reason: 'conflict' };
  if (status === 422) return { ok: false, reason: 'invalid' };
  if (status === 429) return { ok: false, reason: 'rate-limited' };
  if (status === 410) return { ok: false, reason: 'closed' };
  return { ok: false, reason: 'unavailable' };
}

async function authorization(): Promise<string | null> {
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request) ?? null;
}

export const publishOwnDraft = createServerFn({ method: 'POST' })
  .validator(publishInput)
  .handler(async ({ data }): Promise<{ ok: true; post: RevisedPost } | EditFailure> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const credential = await authorization();
      if (!credential) return { ok: false, reason: 'forbidden' };
      const client = kernelClient();
      const result = await client.posts({ id: data.postId }).revisions.post(
        { body: data.body, mediaIds: data.mediaIds, visibility: 'published' },
        {
          headers: {
            authorization: credential,
            'idempotency-key': JSON.stringify(data.idempotencyKey),
            'if-match': `"${data.revisionId}"`,
          } as { 'idempotency-key': string; 'if-match': string },
        },
      );
      if (!result.error) return { ok: true, post: result.data.post };
      if (result.status === 412) {
        const current = await client.posts({ id: data.postId }).get({
          headers: { authorization: credential },
        });
        if (!current.error && current.data) {
          const revision = new Headers(current.headers).get('etag')?.replace(/^"|"$/g, '');
          return {
            ok: false,
            reason: 'stale',
            currentPost: revision ? { ...current.data.post, revisionId: revision } : current.data.post,
          };
        }
        return { ok: false, reason: 'stale' };
      }
      if (result.status >= 500) return { ok: false, reason: 'unavailable' };
      return { ...failure(result.status), ...(result.status === 429 ? { retryAfter: 1 } : {}) };
    } catch (error) {
      if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
      return { ok: false, reason: 'unavailable' };
    }
  });

export const readOwnDraftPost = createServerFn({ method: 'GET' })
  .validator((value: unknown) => ({ postId: requiredId(value && typeof value === 'object' && 'postId' in value ? value.postId : undefined) }))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const credential = await authorization();
      if (!credential) return 'denied' as const;
      const result = await kernelClient().posts({ id: data.postId }).get({
        headers: { authorization: credential },
      });
      if (result.error) {
        if (result.status === 404) return 'concealed' as const;
        if (result.status === 401 || result.status === 403) return 'denied' as const;
        return 'unavailable' as const;
      }
      const post = result.data.post;
      if (post.availability !== 'available') return 'concealed' as const;
      const revision = new Headers(result.headers).get('etag')?.replace(/^"|"$/g, '') ?? post.revisionId;
      return {
        state: 'available' as const,
        revision,
        visibility:
          post.visibility === 'draft' || post.visibility === 'published'
            ? post.visibility
            : 'other' as const,
        body: post.body ?? null,
        mediaIds: post.mediaIds,
      };
    } catch (error) {
      return isPlatformClosedError(error) ? ('unavailable' as const) : ('unavailable' as const);
    }
  });
