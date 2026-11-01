import { documentText, parseDocument } from '@rezics/document';
import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import { isPlatformClosedError, isPlatformClosedProblem, PlatformClosedError } from '../kernel/platform-closed';

export type ModerationDecision = {
  id: string;
  targetKind: 'post' | 'thread';
  targetId: string;
  action: 'takedown';
  statement: string;
  decidedAt: string;
  appealDeadline: string;
  appeal: {
    id: string;
    outcome: 'reversed' | 'upheld' | null;
    statement: string | null;
    resolvedAt: string | null;
  } | null;
};
export type DecisionTarget = {
  id: string;
  authorId?: string;
  threadId?: string;
  createdAt?: string;
  text: string;
  href: string;
};
export type DecisionPage = {
  decision: ModerationDecision;
  target: DecisionTarget | null;
  viewerId: string | null;
  /** Prepared browser session and read lifetime; optional for existing injected presentation fixtures. */
  sessionEpoch?: string;
  readGeneration?: string;
};

type ReadResult = { data?: unknown; error?: unknown; status?: number };
type DecisionReads = {
  decision: (id: string) => Promise<ModerationDecision | null>;
  post: (id: string) => Promise<DecisionTarget | null>;
  thread: (id: string) => Promise<DecisionTarget | null>;
};

function postText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  try {
    return documentText(parseDocument(record.body));
  } catch {
    return '';
  }
}

/** Resolves the private decision and exactly one existing target read when the native visibility permits it. */
export async function loadDecisionPage(id: string, reads: DecisionReads): Promise<DecisionPage | null> {
  const decision = await reads.decision(id);
  if (!decision || decision.id !== id) return null;
  const target =
    decision.targetKind === 'post' ? await reads.post(decision.targetId) : await reads.thread(decision.targetId);
  return { decision, target, viewerId: null };
}

/** Keep the private decision gated before and after the independent target read. */
export async function loadCurrentDecisionPage(id: string, reads: DecisionReads): Promise<DecisionPage | null> {
  const page = await loadDecisionPage(id, reads);
  if (!page) return null;
  const current = await reads.decision(id);
  if (
    !current ||
    current.id !== id ||
    current.targetKind !== page.decision.targetKind ||
    current.targetId !== page.decision.targetId
  )
    return null;
  return { ...page, decision: current };
}

export function canAppealDecision(
  decision: ModerationDecision,
  targetAuthorId: string | null,
  viewerId: string | null,
  now: number,
): boolean {
  return Boolean(
    viewerId &&
    targetAuthorId &&
    viewerId === targetAuthorId &&
    !decision.appeal &&
    now <= Date.parse(decision.appealDeadline),
  );
}

/** The native appeal write remains authoritative when moderation hides the target read. */
export function canAttemptAppealWithoutTarget(
  decision: ModerationDecision,
  viewerId: string | null,
  now: number,
): boolean {
  return Boolean(viewerId && !decision.appeal && now <= Date.parse(decision.appealDeadline));
}

const readOptions = (authorization: string) => ({
  headers: { authorization },
  fetch: { cache: 'no-store' as const },
});

function readStatus(result: ReadResult): number | undefined {
  if (typeof result.status === 'number') return result.status;
  if (result.error && typeof result.error === 'object' && 'status' in result.error) return Number(result.error.status);
  return undefined;
}

function refused(result: ReadResult): boolean {
  const status = readStatus(result);
  const problem =
    result.error && typeof result.error === 'object' && 'value' in result.error ? result.error.value : null;
  if (isPlatformClosedProblem(status, problem)) throw new PlatformClosedError(403, problem);
  if (status !== undefined && [401, 403, 404].includes(status)) return true;
  throw new Error('Decision read unavailable');
}

function targetHref(kind: 'post' | 'thread', id: string, threadId?: string) {
  return kind === 'thread' ? `/threads/${id}` : `/threads/${threadId ?? id}#${id}`;
}

export const readDecisionPage = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      input.id.length > 128
    )
      throw notFound();
    return { id: input.id };
  })
  .handler(async ({ data }): Promise<DecisionPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    try {
      await prepareSession(request, env as Partial<SessionEnv>);
    } catch {
      throw new Error('Decision read unavailable');
    }
    const authorization = viewerCredential(request);
    const viewerId = sessionSubject(request);
    const sessionEpoch = requestCsrfToken(request);
    if (!authorization || !viewerId || !sessionEpoch) throw notFound();
    const page = await loadCurrentDecisionPage(data.id, decisionReadAdapters(kernelClient(), authorization));
    if (!page) throw notFound();
    return { ...page, viewerId, sessionEpoch, readGeneration: crypto.randomUUID() };
  });

export function decisionReadAdapters(client: KernelClient, authorization: string): DecisionReads {
  return {
    decision: async (id) => {
      const result = await client['moderation-decisions']({ id }).get(readOptions(authorization));
      if (result.error && refused(result)) return null;
      if (!result.data) throw new Error('Decision read unavailable');
      return result.data;
    },
    post: async (id) => {
      // Target failure cannot revoke the independently readable private decision.
      const result = await client
        .posts({ id })
        .get(readOptions(authorization))
        .catch((error: unknown) => {
          if (isPlatformClosedError(error)) throw error;
          return null;
        });
      if (!result || result.error) return null;
      const record = result.data?.post;
      if (!record) return null;
      if (record.id !== id || record.availability !== 'available' || ('removed' in record && record.removed === true))
        return null;
      if (typeof record.threadId !== 'string') return null;
      return {
        id,
        ...(typeof record.authorId === 'string' ? { authorId: record.authorId } : {}),
        ...(typeof record.threadId === 'string' ? { threadId: record.threadId } : {}),
        ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
        text: postText(record),
        href: targetHref('post', encodeURIComponent(id), encodeURIComponent(record.threadId)),
      };
    },
    thread: async (id) => {
      const result = await client
        .threads({ id })
        .get(readOptions(authorization))
        .catch((error: unknown) => {
          if (isPlatformClosedError(error)) throw error;
          return null;
        });
      if (!result || result.error) return null;
      const record = result.data?.thread;
      if (!record) return null;
      if (record.id !== id || record.availability !== 'available' || ('removed' in record && record.removed === true))
        return null;
      return {
        id,
        ...(typeof record.authorId === 'string' ? { authorId: record.authorId } : {}),
        ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
        text: String(record.title ?? ''),
        href: targetHref('thread', encodeURIComponent(id)),
      };
    },
  };
}
