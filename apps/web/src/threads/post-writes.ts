import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import type { SessionEnv } from '../session/client.ts';
import { prepareSession, viewerCredential } from '../session/request.ts';
import type { EditFailure, RevisedPost, WriteFailure } from './actions';

type Refusal = (status: number, headers: HeadersInit | undefined, body?: unknown) => WriteFailure;

export type RevisePostInput = {
  postId: string;
  revisionId: string;
  body: import('@rezics/document').DocumentSnapshot;
  idempotencyKey: string;
  mediaIds?: string[];
};

export type ErasePostInput = { postId: string; idempotencyKey: string };

async function sessionAuthorization(request: Request, sessionEnv: Partial<SessionEnv>): Promise<string> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization) throw new Error('A signed-in session is required to edit posts.');
  return authorization;
}

export async function revisePostRequest(
  input: RevisePostInput,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  client: KernelClient,
  refusal: Refusal,
): Promise<{ ok: true; post: RevisedPost } | EditFailure> {
  const authorization = await sessionAuthorization(request, sessionEnv);
  try {
    const result = await client.posts({ id: input.postId }).revisions.post(
      {
        body: input.body,
        licence: 'LicenseRef-rezics-terms',
        mediaIds: input.mediaIds ?? [],
      },
      {
        headers: {
          authorization,
          'idempotency-key': input.idempotencyKey,
          'if-match': `"${input.revisionId}"`,
        } as { 'idempotency-key': string; 'if-match': string },
      },
    );
    if (result.error) {
      if (result.status === 412) {
        const current = await client.posts({ id: input.postId }).get();
        if (!current.error && current.data) {
          const etag = new Headers(current.headers).get('etag')?.replace(/^"|"$/g, '');
          return {
            ok: false,
            reason: 'stale',
            currentPost: etag ? { ...current.data.post, revisionId: etag } : current.data.post,
          };
        }
        return { ok: false, reason: 'stale' };
      }
      return refusal(result.status, result.headers, result.error.value);
    }
    return { ok: true, post: result.data.post };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}

export async function erasePostRequest(
  input: ErasePostInput,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  client: KernelClient,
  refusal: Refusal,
): Promise<{ ok: true } | WriteFailure> {
  const authorization = await sessionAuthorization(request, sessionEnv);
  try {
    const result = await client.posts({ id: input.postId }).delete(undefined, {
      headers: {
        authorization,
        'idempotency-key': input.idempotencyKey,
      } as { 'idempotency-key': string },
    });
    if (result.error) return refusal(result.status, result.headers, result.error.value);
    return { ok: true };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}
