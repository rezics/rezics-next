import type { KernelClient } from '@rezics/client';
import type { StudioPage, StudioResult, StudioRevisionHeader } from './contract';

export type PostRevisionHeadersPage = StudioResult<StudioPage<StudioRevisionHeader>>;

export function revisionHeadersUnavailable(): PostRevisionHeadersPage {
  return { ok: false, error: { kind: 'unavailable', message: 'Revision history is unavailable. Try again.' } };
}

/** One native metadata page. No head, body, title or display-record reads belong to enumeration. */
export async function loadPostRevisionHeaders(
  client: KernelClient,
  address: { postId: string; cursor?: string },
  authorization: string,
  signal: AbortSignal,
): Promise<PostRevisionHeadersPage> {
  const result = await client.posts({ id: address.postId })['revision-headers'].get({
    query: { limit: 20, ...(address.cursor === undefined ? {} : { cursor: address.cursor }) },
    headers: { authorization },
    fetch: { cache: 'no-store', signal },
  });
  if (result.error || !result.data) return revisionHeadersUnavailable();
  // A foreign Post or malformed digest must never become a selectable exact document.
  if (result.data.revisions.some((row) => row.postId !== address.postId || !/^[a-f0-9]{64}$/.test(row.sha256)))
    return revisionHeadersUnavailable();
  return {
    ok: true,
    value: {
      items: result.data.revisions.map((row) => ({
        exact: { postId: row.postId, revisionId: row.revisionId, sha256: row.sha256 },
        savedAt: row.recordedAt,
      })),
      nextCursor: result.data.next,
    },
  };
}
