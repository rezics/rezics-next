import type { KernelClient } from '@rezics/client';
import { checkDocument } from '@rezics/document';
import type { OwnDraftReader, OwnDraftReadFailure } from './model';

function failure(status: number, value: unknown): OwnDraftReadFailure {
  const code = value && typeof value === 'object' && 'code' in value ? value.code : null;
  if (code === 'invalid_cursor' || code === 'stale_cursor') return 'stale';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'concealed';
  return 'unavailable';
}

function validAuthnEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** The supplied client owns authentication and locale; advice strings are never transport destinations. */
export function nativeOwnDraftRequests(client: KernelClient): OwnDraftReader {
  return {
    async list(request, signal) {
      if (signal.aborted) return 'unavailable';
      try {
        const result = await client.accounts({ accountId: request.accountId }).drafts.get({
          query: { limit: 20, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) },
          fetch: { cache: 'no-store', redirect: 'manual', signal },
        });
        if (signal.aborted) return 'unavailable';
        if (result.error || result.status !== 200 || !result.data) return failure(result.status, result.error?.value);
        if (
          result.data.viewer.accountId !== request.accountId ||
          !validAuthnEpoch(result.data.viewer.authnEpoch) ||
          (request.authnEpoch !== undefined && result.data.viewer.authnEpoch !== request.authnEpoch)
        )
          return 'denied';
        if (result.data.drafts.length > 20) return 'unavailable';
        return result.data;
      } catch {
        return 'unavailable';
      }
    },
    async resume(request, signal) {
      if (signal.aborted) return 'unavailable';
      try {
        const result = await client
          .accounts({ accountId: request.accountId })
          .drafts({ id: request.id })
          .get({
            query: { threadId: request.threadId },
            fetch: { cache: 'no-store', redirect: 'manual', signal },
          });
        if (signal.aborted) return 'unavailable';
        if (result.error || result.status !== 200 || !result.data) return failure(result.status, result.error?.value);
        const post = result.data.post;
        if (
          post.id !== request.id ||
          post.threadId !== request.threadId ||
          post.availability !== 'available' ||
          !('authorId' in post) ||
          post.authorId !== request.accountId ||
          post.visibility !== 'draft'
        )
          return 'concealed';
        const etag = new Headers(result.headers).get('etag');
        // Only a strong native revision may seed If-Match. A missing ETag is not a revision guess.
        const revision = etag?.match(
          /^"([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"$/i,
        )?.[1];
        if (!revision || !checkDocument(post.body)) return 'unavailable';
        if (post.revisionId !== revision) return 'stale';
        return {
          revision,
          post: {
            id: post.id,
            threadId: post.threadId,
            parentId: post.parentId,
            body: post.body,
            mediaIds: post.mediaIds,
          },
        };
      } catch {
        return 'unavailable';
      }
    },
  };
}
