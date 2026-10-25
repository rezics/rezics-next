import { checkDocument, hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client.ts';
import { prepareSession, viewerCredential } from '../session/request.ts';

const licence = 'LicenseRef-rezics-terms';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type FailureReason = 'forbidden' | 'invalid' | 'rate-limited' | 'unavailable';
export type WriteFailure = { ok: false; reason: FailureReason; retryAfter?: number };
export type ThreadResource = ReturnType<KernelClient['threads']>;
export type ThreadCreated = NonNullable<Awaited<ReturnType<KernelClient['threads']['post']>>['data']>;
export type PostCreated = NonNullable<Awaited<ReturnType<ThreadResource['posts']['post']>>['data']>;
export type CreatedPost = PostCreated['post'];

function validateDraft(input: unknown): { body: DocumentSnapshot; idempotencyKey: string } {
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
  return { body: input.body as DocumentSnapshot, idempotencyKey: input.idempotencyKey };
}

function validateThreadDraft(input: unknown): {
  boardId: string;
  title: string;
  body: DocumentSnapshot;
  idempotencyKey: string;
} {
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
  return { ...draft, boardId: input.boardId, title: input.title };
}

function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, Math.ceil(seconds));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(3600, Math.max(0, Math.ceil((date - Date.now()) / 1000)));
}

function refusal(status: number, headers: HeadersInit | undefined): WriteFailure {
  if (status === 403 || status === 401) return { ok: false, reason: 'forbidden' };
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
    const authorization = await sessionBearer();
    try {
      const result = await kernelClient().threads.post(
        {
          boardId: data.boardId,
          title: data.title,
          body: data.body,
          licence,
          subjectIds: [],
          visibility: 'published',
        },
        {
          headers: { authorization, 'idempotency-key': data.idempotencyKey } as { 'idempotency-key': string },
        },
      );
      if (result.error) return refusal(result.status, result.headers);
      return { ok: true, thread: result.data.thread };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
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
          { body: data.body, licence },
          {
            headers: { authorization, 'idempotency-key': data.idempotencyKey } as { 'idempotency-key': string },
          },
        );
      if (result.error) return refusal(result.status, result.headers);
      return { ok: true, post: result.data.post };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  });
