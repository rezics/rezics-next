import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';

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
export type DecisionPage = { decision: ModerationDecision; target: DecisionTarget; viewerId: string | null };

type ReadResult = { data?: unknown; error?: unknown; status?: number };
type DecisionReads = {
  decision: (id: string) => Promise<ModerationDecision | null>;
  post: (id: string) => Promise<DecisionTarget | null>;
  thread: (id: string) => Promise<DecisionTarget | null>;
};

function postText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const body = record.body;
  const parts: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const current = node as Record<string, unknown>;
    if (current.type === 'text' && typeof current.text === 'string') parts.push(current.text);
    if (Array.isArray(current.content)) current.content.forEach(visit);
  };
  visit(body);
  return parts.join('');
}

/** Resolves the private decision and exactly one existing target read. */
export async function loadDecisionPage(id: string, reads: DecisionReads): Promise<DecisionPage | null> {
  const decision = await reads.decision(id);
  if (!decision) return null;
  const target =
    decision.targetKind === 'post' ? await reads.post(decision.targetId) : await reads.thread(decision.targetId);
  return target ? { decision, target, viewerId: null } : null;
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

type DecisionKernel = {
  'moderation-decisions': (params: { id: string }) => { get: (options: unknown) => Promise<ReadResult> };
  posts: (params: { id: string }) => { get: (options: unknown) => Promise<ReadResult> };
  threads: (params: { id: string }) => { get: (options: unknown) => Promise<ReadResult> };
};
function headers(authorization: string) {
  return { authorization };
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
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) throw notFound();
    const reads = decisionReadAdapters(kernelClient() as unknown as DecisionKernel, authorization);
    const page = await loadDecisionPage(data.id, reads);
    if (!page) throw notFound();
    return { ...page, viewerId: sessionSubject(request) ?? null };
  });

export function decisionReadAdapters(client: DecisionKernel, authorization: string): DecisionReads {
  return {
    decision: async (id) => {
      const result = await client['moderation-decisions']({ id }).get({ headers: headers(authorization) });
      return result.error ? null : ((result.data as ModerationDecision | undefined) ?? null);
    },
    post: async (id) => {
      const result = await client.posts({ id }).get({ headers: headers(authorization) });
      const record = (result.data as { post?: Record<string, unknown> } | undefined)?.post;
      return result.error || !record
        ? null
        : {
            id,
            ...(typeof record.authorId === 'string' ? { authorId: record.authorId } : {}),
            ...(typeof record.threadId === 'string' ? { threadId: record.threadId } : {}),
            ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
            text: postText(record),
            href: targetHref('post', id, String(record.threadId ?? id)),
          };
    },
    thread: async (id) => {
      const result = await client.threads({ id }).get({ headers: headers(authorization) });
      const record = (result.data as { thread?: Record<string, unknown> } | undefined)?.thread;
      return result.error || !record
        ? null
        : {
            id,
            ...(typeof record.authorId === 'string' ? { authorId: record.authorId } : {}),
            ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
            text: String(record.title ?? ''),
            href: targetHref('thread', id),
          };
    },
  };
}
