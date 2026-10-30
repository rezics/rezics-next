import type { KernelClient } from '@rezics/client';
import type { DocumentSnapshot } from '@rezics/document';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import type { SessionEnv } from '../session/client.ts';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request.ts';
import { readDraftMediaStates } from './media-state';
import type { EditFailure, RevisedPost, WriteFailure } from './actions';

type Refusal = (status: number, headers: HeadersInit | undefined, body?: unknown) => WriteFailure;
type StartedThread = NonNullable<Awaited<ReturnType<KernelClient['threads']['post']>>['data']>['thread'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StartThreadBase = {
  boardId: string;
  title: string;
  body: DocumentSnapshot;
  idempotencyKey: string;
  mediaIds?: string[];
};

export type VoteCitation = { questionId: string; units: number; revision: number };
export type StartThreadInput = StartThreadBase &
  (
    | { kind: 'review'; subjectId: string; voteCitation?: VoteCitation }
    | { kind?: undefined; subjectId?: undefined; voteCitation?: undefined }
  );

/** Reads the optional author-owned review id returned by the native conflict response. */
export function findExistingReview(problem: unknown): string | undefined {
  if (!problem || typeof problem !== 'object' || !('existingThreadId' in problem)) return undefined;
  const id = problem.existingThreadId;
  return typeof id === 'string' && uuid.test(id) ? id : undefined;
}

export async function startThreadRequest(
  input: StartThreadInput,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  client: KernelClient,
  refusal: Refusal,
): Promise<{ ok: true; thread: StartedThread } | WriteFailure> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization) throw new Error('A signed-in session is required to post.');
  try {
    const result = await client.threads.post(
      {
        boardId: input.boardId,
        title: input.title,
        body: input.body,
        licence: 'LicenseRef-rezics-terms',
        ...(input.kind === 'review'
          ? {
              kind: 'review' as const,
              subjectIds: [input.subjectId],
              ...(input.voteCitation ? { voteCitation: input.voteCitation } : {}),
            }
          : { subjectIds: [] }),
        visibility: 'published',
        ...(input.mediaIds === undefined || input.mediaIds.length === 0 ? {} : { mediaIds: input.mediaIds }),
      },
      {
        headers: { authorization, 'idempotency-key': JSON.stringify(input.idempotencyKey) } as {
          'idempotency-key': string;
        },
      },
    );
    if (result.error) {
      const failure = refusal(result.status, result.headers, result.error.value);
      if (failure.reason === 'media-unavailable') {
        failure.media = await readDraftMediaStates(client, authorization, input.mediaIds ?? []);
      }
      if (failure.reason === 'conflict' && input.kind === 'review') {
        const authorId = sessionSubject(request);
        if (authorId) {
          const existingReviewId = findExistingReview(result.error.value);
          if (existingReviewId) return { ...failure, existingReviewId };
        }
      }
      return failure;
    }
    return { ok: true, thread: result.data.thread };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}

export type RevisePostInput = {
  postId: string;
  revisionId: string;
  body: import('@rezics/document').DocumentSnapshot;
  idempotencyKey: string;
  mediaIds?: string[];
};

export type ErasePostInput = { postId: string; idempotencyKey: string };
export type RestorePostInput = { postId: string; idempotencyKey: string };

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
          'idempotency-key': JSON.stringify(input.idempotencyKey),
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
      const failure = refusal(result.status, result.headers, result.error.value);
      if (failure.reason === 'media-unavailable') {
        failure.media = await readDraftMediaStates(client, authorization, input.mediaIds ?? []);
      }
      return failure;
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
        'idempotency-key': JSON.stringify(input.idempotencyKey),
      } as { 'idempotency-key': string },
    });
    if (result.error) return refusal(result.status, result.headers, result.error.value);
    return { ok: true };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}

export async function restorePostRequest(
  input: RestorePostInput,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  client: KernelClient,
  refusal: Refusal,
): Promise<{ ok: true } | WriteFailure> {
  const authorization = await sessionAuthorization(request, sessionEnv);
  try {
    const result = await client.posts({ id: input.postId }).$restore.post(undefined, {
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
