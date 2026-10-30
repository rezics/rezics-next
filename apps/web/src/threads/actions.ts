import { checkDocument, hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed.ts';
import type { SessionEnv } from '../session/client.ts';
import { prepareSession, viewerCredential } from '../session/request.ts';
import { readDraftMediaStates, type DraftMediaState } from './media-state';
import {
  erasePostRequest,
  restorePostRequest,
  revisePostRequest,
  startThreadRequest,
  type StartThreadInput,
  type VoteCitation,
} from './post-writes';
import { forgetThreadSlug, rememberThreadSlug } from './thread-href';

const licence = 'LicenseRef-rezics-terms';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type FailureReason =
  | 'closed'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'media-unavailable'
  | 'invalid'
  | 'rate-limited'
  | 'unavailable';
export type WriteFailure = {
  ok: false;
  reason: FailureReason;
  retryAfter?: number;
  existingReviewId?: string;
  media?: DraftMediaState[];
};
export type ThreadResource = ReturnType<KernelClient['threads']>;
export type PostResource = ReturnType<KernelClient['posts']>;
export type ThreadCreated = NonNullable<Awaited<ReturnType<KernelClient['threads']['post']>>['data']>;
export type PostCreated = NonNullable<Awaited<ReturnType<ThreadResource['posts']['post']>>['data']>;
export type CreatedPost = PostCreated['post'];
export type CurrentPost = NonNullable<Awaited<ReturnType<PostResource['get']>>['data']>['post'];
export type RevisedPost = NonNullable<Awaited<ReturnType<PostResource['revisions']['post']>>['data']>['post'];
export type EditFailure = WriteFailure | { ok: false; reason: 'stale'; currentPost?: CurrentPost };

function validateMediaIds(input: object): string[] | undefined {
  if (!('mediaIds' in input) || input.mediaIds === undefined) return undefined;
  const value = input.mediaIds;
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid contribution draft');
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) throw new Error('Invalid contribution draft');
    seen.add(id);
  }
  return value;
}

function validateDraft(input: unknown): { body: DocumentSnapshot; idempotencyKey: string; mediaIds?: string[] } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('body' in input) ||
    !checkDocument(input.body) ||
    input.body.profile !== 'blocks' ||
    !hasDocumentContent(input.body) ||
    !('idempotencyKey' in input) ||
    typeof input.idempotencyKey !== 'string' ||
    !uuid.test(input.idempotencyKey)
  )
    throw new Error('Invalid contribution draft');
  const mediaIds = validateMediaIds(input);
  return {
    body: input.body as DocumentSnapshot,
    idempotencyKey: input.idempotencyKey,
    ...(mediaIds === undefined ? {} : { mediaIds }),
  };
}

function validateVoteCitation(value: unknown): VoteCitation | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    !('questionId' in value) ||
    typeof value.questionId !== 'string' ||
    !uuid.test(value.questionId) ||
    !('units' in value) ||
    typeof value.units !== 'number' ||
    !Number.isInteger(value.units) ||
    value.units < 0 ||
    value.units > 20 ||
    !('revision' in value) ||
    typeof value.revision !== 'number' ||
    !Number.isInteger(value.revision) ||
    value.revision < 1 ||
    value.revision > 2_147_483_647
  )
    throw new Error('Invalid review vote citation');
  return { questionId: value.questionId, units: value.units as number, revision: value.revision as number };
}

function validateThreadDraft(input: unknown): StartThreadInput {
  const draft = validateDraft(input);
  if (
    !input ||
    typeof input !== 'object' ||
    !('boardId' in input) ||
    typeof input.boardId !== 'string' ||
    !input.boardId ||
    input.boardId.length > 128 ||
    !('title' in input) ||
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.length > 512
  )
    throw new Error('Invalid thread draft');
  const base = { ...draft, boardId: input.boardId, title: input.title };
  if ('kind' in input && input.kind !== undefined) {
    if (
      input.kind !== 'review' ||
      !('subjectId' in input) ||
      typeof input.subjectId !== 'string' ||
      !uuid.test(input.subjectId)
    )
      throw new Error('Invalid review draft');
    const voteCitation = 'voteCitation' in input ? validateVoteCitation(input.voteCitation) : undefined;
    return {
      ...base,
      kind: 'review',
      subjectId: input.subjectId,
      ...(voteCitation ? { voteCitation } : {}),
    };
  }
  if (
    ('subjectId' in input && input.subjectId !== undefined) ||
    ('voteCitation' in input && input.voteCitation !== undefined)
  )
    throw new Error('Invalid discussion draft');
  return base;
}

function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, Math.ceil(seconds));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(3600, Math.max(0, Math.ceil((date - Date.now()) / 1000)));
}

function refusal(status: number, headers: HeadersInit | undefined, body?: unknown): WriteFailure {
  if (isPlatformClosedProblem(status, body)) return { ok: false, reason: 'closed' };
  if (status === 403 || status === 401) return { ok: false, reason: 'forbidden' };
  if (status === 404) return { ok: false, reason: 'not-found' };
  if (status === 409) {
    const code = body && typeof body === 'object' && 'code' in body ? body.code : undefined;
    return { ok: false, reason: code === 'media_unavailable' ? 'media-unavailable' : 'conflict' };
  }
  if (status === 400 || status === 413 || status === 422) return { ok: false, reason: 'invalid' };
  if (status === 429) {
    const retryAfter = parseRetryAfter(new Headers(headers).get('retry-after'));
    return { ok: false, reason: 'rate-limited', ...(retryAfter === undefined ? {} : { retryAfter }) };
  }
  return { ok: false, reason: 'unavailable' };
}

async function sessionBearer(): Promise<string> {
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  const credential = viewerCredential(request);
  if (!credential) throw new Error('A signed-in session is required to post.');
  return credential;
}

export const startThread = createServerFn({ method: 'POST' })
  .validator(validateThreadDraft)
  .handler(async ({ data }): Promise<{ ok: true; thread: ThreadCreated['thread'] } | WriteFailure> => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await startThreadRequest(data, getRequest(), env as Partial<SessionEnv>, kernelClient(), refusal);
    if (result.ok) rememberThreadSlug(result.thread.id, result.thread.title);
    return result;
  });

export const replyToThread = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const draft = validateDraft(input);
    if (
      !input ||
      typeof input !== 'object' ||
      !('threadId' in input) ||
      typeof input.threadId !== 'string' ||
      !input.threadId ||
      input.threadId.length > 128
    )
      throw new Error('Invalid thread id');
    return { ...draft, threadId: input.threadId };
  })
  .handler(async ({ data }): Promise<{ ok: true; post: CreatedPost } | WriteFailure> => {
    setResponseHeader('cache-control', 'private, no-store');
    const authorization = await sessionBearer();
    try {
      const result = await kernelClient()
        .threads({ id: data.threadId })
        .posts.post(
          {
            body: data.body,
            licence,
            ...(data.mediaIds === undefined || data.mediaIds.length === 0 ? {} : { mediaIds: data.mediaIds }),
          },
          {
            headers: { authorization, 'idempotency-key': JSON.stringify(data.idempotencyKey) } as {
              'idempotency-key': string;
            },
          },
        );
      if (result.error) {
        const failure = refusal(result.status, result.headers, result.error.value);
        if (failure.reason === 'media-unavailable') {
          failure.media = await readDraftMediaStates(kernelClient(), authorization, data.mediaIds ?? []);
        }
        return failure;
      }
      return { ok: true, post: result.data.post };
    } catch (error) {
      if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
      return { ok: false, reason: 'unavailable' };
    }
  });

function validatePostId(input: unknown): { postId: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('postId' in input) ||
    typeof input.postId !== 'string' ||
    !input.postId ||
    input.postId.length > 128
  )
    throw new Error('Invalid post id');
  return { postId: input.postId };
}

function validateEdit(input: unknown): {
  postId: string;
  revisionId: string;
  body: DocumentSnapshot;
  idempotencyKey: string;
  mediaIds?: string[];
} {
  const draft = validateDraft(input);
  const postId = validatePostId(input).postId;
  if (
    !input ||
    typeof input !== 'object' ||
    !('revisionId' in input) ||
    typeof input.revisionId !== 'string' ||
    !input.revisionId ||
    input.revisionId.length > 128
  )
    throw new Error('Invalid post revision');
  return { ...draft, postId, revisionId: input.revisionId };
}

export const revisePost = createServerFn({ method: 'POST' })
  .validator(validateEdit)
  .handler(async ({ data }): Promise<{ ok: true; post: RevisedPost } | EditFailure> => {
    setResponseHeader('cache-control', 'private, no-store');
    return revisePostRequest(data, getRequest(), env as Partial<SessionEnv>, kernelClient(), refusal);
  });

export const erasePost = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const { postId } = validatePostId(input);
    if (
      !input ||
      typeof input !== 'object' ||
      !('idempotencyKey' in input) ||
      typeof input.idempotencyKey !== 'string' ||
      !uuid.test(input.idempotencyKey)
    )
      throw new Error('Invalid post deletion');
    if (
      'openingThreadId' in input &&
      (typeof input.openingThreadId !== 'string' || !input.openingThreadId || input.openingThreadId.length > 128)
    )
      throw new Error('Invalid opening thread id');
    return {
      postId,
      idempotencyKey: input.idempotencyKey,
      ...('openingThreadId' in input && typeof input.openingThreadId === 'string'
        ? { openingThreadId: input.openingThreadId }
        : {}),
    };
  })
  .handler(async ({ data }): Promise<{ ok: true } | WriteFailure> => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await erasePostRequest(data, getRequest(), env as Partial<SessionEnv>, kernelClient(), refusal);
    if (result.ok && data.openingThreadId) forgetThreadSlug(data.openingThreadId);
    return result;
  });

export const restorePost = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const { postId } = validatePostId(input);
    if (
      !input ||
      typeof input !== 'object' ||
      !('idempotencyKey' in input) ||
      typeof input.idempotencyKey !== 'string' ||
      !uuid.test(input.idempotencyKey)
    )
      throw new Error('Invalid post restoration');
    return { postId, idempotencyKey: input.idempotencyKey };
  })
  .handler(async ({ data }): Promise<{ ok: true } | WriteFailure> => {
    setResponseHeader('cache-control', 'private, no-store');
    return restorePostRequest(data, getRequest(), env as Partial<SessionEnv>, kernelClient(), refusal);
  });
