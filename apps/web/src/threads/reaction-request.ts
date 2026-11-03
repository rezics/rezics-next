import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed.ts';
import type { SessionEnv } from '../session/client.ts';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request.ts';

const kinds = new Set(['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad']);

export type ReactionKind = 'upvote' | 'downvote' | 'like' | 'love' | 'laugh' | 'insightful' | 'sad';

/** A subject admits these kinds only; its score is its rating, so there is no upvote or downvote. */
export const subjectReactionKinds = ['like', 'love', 'laugh', 'insightful', 'sad'] as const;

export type ChangeReactionInput = {
  target: 'thread' | 'post' | 'subject';
  id: string;
  kind: ReactionKind | null;
  /** Original reader captured by the mounted browser caller; it is only a mismatch fence. */
  expectedReader?: string;
};

type FailureReason = 'closed' | 'forbidden' | 'not-found' | 'conflict' | 'invalid' | 'rate-limited' | 'unavailable';

export type ReactionFailure = { ok: false; reason: FailureReason; retryAfter?: number };

export type ReactionSnapshot = {
  ok: true;
  counts: Partial<Record<ReactionKind, number>>;
  value: ReactionKind | null;
  reactionsAsOf?: NonNullable<Awaited<ReturnType<ReturnType<KernelClient['threads']>['get']>>['data']>['reactionsAsOf'];
};

// Existing point producers: one thread/post read, or one Subject counts read plus one own-slot read.
export const REACTION_RECOVERY_READS = { thread: 1, post: 1, subject: 2 } as const;
export const MAX_REACTION_RECOVERY_READS = Math.max(...Object.values(REACTION_RECOVERY_READS));
export const MAX_REACTION_RECOVERY_REQUESTS = 1 + MAX_REACTION_RECOVERY_READS;

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
  const expectedReader = 'expectedReader' in input ? input.expectedReader : undefined;
  if (
    expectedReader !== undefined &&
    (typeof expectedReader !== 'string' || !expectedReader || expectedReader.length > 128)
  )
    throw new Error('Invalid reaction');
  if (input.target === 'subject' && (input.kind === 'upvote' || input.kind === 'downvote'))
    throw new Error('Invalid reaction');
  return {
    target: input.target,
    id: input.id,
    kind: input.kind as ReactionKind | null,
    ...(typeof expectedReader === 'string' ? { expectedReader } : {}),
  };
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
  const actualReader = sessionSubject(request);
  if (!input.expectedReader || !actualReader || input.expectedReader !== actualReader || !authorization)
    return { ok: false, reason: 'forbidden' };
  const commandId = request.headers.get('idempotency-key');
  if (commandId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId))
    return { ok: false, reason: 'invalid' };
  const headers = { authorization, 'idempotency-key': commandId ?? crypto.randomUUID() } as {
    'idempotency-key': string;
  };
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

/** Read the current slot and projected totals; never infer them from a replayed command receipt. */
export async function readReactionRequest(
  input: ChangeReactionInput,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  client: KernelClient,
): Promise<ReactionSnapshot | ReactionFailure> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization || !input.expectedReader || sessionSubject(request) !== input.expectedReader)
    return { ok: false, reason: 'forbidden' };
  const headers = { authorization };
  try {
    let counts: Partial<Record<ReactionKind, number>>;
    let value: unknown;
    let reactionsAsOf: ReactionSnapshot['reactionsAsOf'];
    if (input.target === 'subject') {
      const resource = client.subjects({ id: input.id });
      const counted = await resource.reactions.get({ headers });
      if (counted.error) return refusal(counted.status, counted.headers, counted.error.value);
      // Same missing generated own-slot declaration used by the ordinary Subject reader.
      const own = await (
        resource as unknown as {
          reaction: {
            get(options: { headers: { authorization: string } }): Promise<{
              data?: { kind?: unknown };
              error?: { value: unknown };
              status: number;
              headers?: HeadersInit;
            }>;
          };
        }
      ).reaction.get({ headers });
      if (own.error) return refusal(own.status, own.headers, own.error.value);
      if (!counted.data) return { ok: false, reason: 'unavailable' };
      counts = Object.fromEntries(counted.data.counts.map(({ kind, count }) => [kind, count]));
      value = own.data?.kind;
    } else {
      const result =
        input.target === 'thread'
          ? await client.threads({ id: input.id }).get({ headers })
          : await client.posts({ id: input.id }).get({ headers });
      if (result.error) return refusal(result.status, result.headers, result.error.value);
      reactionsAsOf = result.data?.reactionsAsOf;
      const data = result.data as { thread?: unknown; post?: unknown } | null;
      const target = (input.target === 'thread' ? data?.thread : data?.post) as
        | { reactions?: Partial<Record<ReactionKind, number>>; viewerReaction?: unknown }
        | undefined;
      if (!target?.reactions) return { ok: false, reason: 'unavailable' };
      counts = target.reactions;
      value = target.viewerReaction;
    }
    const allowed: readonly string[] = input.target === 'subject' ? subjectReactionKinds : [...kinds];
    if (!(value === null || (typeof value === 'string' && allowed.includes(value))))
      return { ok: false, reason: 'unavailable' };
    if (
      Object.entries(counts).some(
        ([kind, count]) => !allowed.includes(kind) || !Number.isSafeInteger(count) || count! < 0,
      )
    )
      return { ok: false, reason: 'unavailable' };
    return {
      ok: true,
      counts,
      value: value as ReactionKind | null,
      ...(input.target === 'subject' ? {} : { reactionsAsOf }),
    };
  } catch (error) {
    return { ok: false, reason: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}
