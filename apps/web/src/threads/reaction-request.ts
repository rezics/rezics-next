import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed.ts';
import type { SessionEnv } from '../session/client.ts';
import { prepareSession, viewerCredential } from '../session/request.ts';

const kinds = new Set(['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad']);

export type ReactionKind = 'upvote' | 'downvote' | 'like' | 'love' | 'laugh' | 'insightful' | 'sad';

/** A subject admits these kinds only; its score is its rating, so there is no upvote or downvote. */
export const subjectReactionKinds = ['like', 'love', 'laugh', 'insightful', 'sad'] as const;

export type ChangeReactionInput = {
  target: 'thread' | 'post' | 'subject';
  id: string;
  kind: ReactionKind | null;
};

type FailureReason = 'closed' | 'forbidden' | 'not-found' | 'conflict' | 'invalid' | 'rate-limited' | 'unavailable';

export type ReactionFailure = { ok: false; reason: FailureReason; retryAfter?: number };

export function validateReaction(input: unknown): ChangeReactionInput {
  if (
    !input ||
    typeof input !== 'object' ||
    !('target' in input) ||
    (input.target !== 'thread' && input.target !== 'post' && input.target !== 'subject') ||
    !('id' in input) ||
    typeof input.id !== 'string' ||
    !input.id ||
    input.id.length > 128 ||
    !('kind' in input) ||
    !(input.kind === null || (typeof input.kind === 'string' && kinds.has(input.kind)))
  )
    throw new Error('Invalid reaction');
  if (input.target === 'subject' && (input.kind === 'upvote' || input.kind === 'downvote'))
    throw new Error('Invalid reaction');
  return { target: input.target, id: input.id, kind: input.kind as ReactionKind | null };
}

function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, Math.ceil(seconds));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(3600, Math.max(0, Math.ceil((date - Date.now()) / 1000)));
}

function refusal(status: number, headers: HeadersInit | undefined, body?: unknown): ReactionFailure {
  if (isPlatformClosedProblem(status, body)) return { ok: false, reason: 'closed' };
  if (status === 403 || status === 401) return { ok: false, reason: 'forbidden' };
  if (status === 404) return { ok: false, reason: 'not-found' };
  if (status === 409) return { ok: false, reason: 'conflict' };
  if (status === 400 || status === 413 || status === 422) return { ok: false, reason: 'invalid' };
  if (status === 429) {
    const retryAfter = parseRetryAfter(new Headers(headers).get('retry-after'));
    return { ok: false, reason: 'rate-limited', ...(retryAfter === undefined ? {} : { retryAfter }) };
  }
  return { ok: false, reason: 'unavailable' };
}

export async function changeReactionRequest(
  input: ChangeReactionInput,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  client: KernelClient,
): Promise<{ ok: true } | ReactionFailure> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization) return { ok: false, reason: 'forbidden' };
  const headers = { authorization, 'idempotency-key': crypto.randomUUID() } as { 'idempotency-key': string };
  const resource =
    input.target === 'thread'
      ? client.threads({ id: input.id })
      : input.target === 'post'
        ? client.posts({ id: input.id })
        : // The generated client declarations lack the subject slot route; its calls match a thread's.
          (client.subjects({ id: input.id }) as unknown as ReturnType<KernelClient['threads']>);
  try {
    const result =
      input.kind === null
        ? await resource.reaction.delete(undefined, { headers })
        : await resource.reaction.put({ kind: input.kind }, { headers });
    if (result.error) return refusal(result.status, result.headers, result.error.value);
    return { ok: true };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}
