import type { KernelClient } from '@rezics/client';
import type { CreatedPost, WriteFailure } from './actions';
import type { ReplyCommand } from './reply-context-intent';
import { readDraftMediaStates } from './media-state';
import { isPlatformClosedError } from '../kernel/platform-closed';

export async function replyToThreadRequest(
  data: Omit<ReplyCommand, 'title' | 'mediaIds'> & { threadId: string; mediaIds?: string[] },
  client: KernelClient,
  authorization: string,
  refusal: (status: number, headers: HeadersInit | undefined, body?: unknown) => WriteFailure,
): Promise<{ ok: true; post: CreatedPost } | WriteFailure> {
  const headers = { authorization, 'idempotency-key': JSON.stringify(data.idempotencyKey) };
  try {
    const result = await client.threads({ id: data.threadId }).posts.post(
      {
        body: data.body,
        licence: 'LicenseRef-rezics-terms',
        ...(data.parentId === undefined ? {} : { parentId: data.parentId }),
        ...(data.mediaIds?.length ? { mediaIds: data.mediaIds } : {}),
      },
      { headers },
    );
    if (result.error) {
      const failure = refusal(result.status, result.headers, result.error.value);
      if (failure.reason === 'media-unavailable') {
        failure.media = await readDraftMediaStates(client, authorization, data.mediaIds ?? []);
      }
      return failure;
    }
    return { ok: true, post: result.data.post };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}
