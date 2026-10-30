import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import type { ModerationTarget } from './reports-page';

export const MODERATION_APPEALS_PAGE_SIZE = 20;
export type Appeal = {
  id: string;
  decisionId: string;
  appellantId: string;
  statement: string;
  createdAt: string;
  decision: {
    statement: string;
    target?: { kind: 'post' | 'thread'; id: string };
    targetKind?: 'post' | 'thread';
    targetId?: string;
    /** Retained for existing component fixtures; native lists expose only canResolve. */
    deciderId?: string;
    appeal?: { outcome: 'reversed' | 'upheld'; statement: string; resolvedAt: string } | null;
  };
  canResolve?: boolean;
};
export type AppealPage = { appeals: Appeal[]; next: string | null };
export type AppealReadSource = {
  boardAppeals: (id: string, cursor?: string) => Promise<AppealPage>;
  threadAppeals: (id: string, cursor?: string) => Promise<AppealPage>;
};
export type AppealTargetReads = {
  post: (id: string) => Promise<ModerationTarget['value']>;
  thread: (id: string) => Promise<ModerationTarget['value']>;
};

function parseAppealPage(value: unknown): AppealPage {
  if (!value || typeof value !== 'object') throw notFound();
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.appeals) || (page.next !== null && typeof page.next !== 'string')) throw notFound();
  const appeals = page.appeals.map((item): Appeal => {
    if (!item || typeof item !== 'object') throw notFound();
    const appeal = item as Record<string, unknown>;
    const decision =
      appeal.decision && typeof appeal.decision === 'object' ? (appeal.decision as Record<string, unknown>) : null;
    if (
      typeof appeal.id !== 'string' ||
      typeof appeal.decisionId !== 'string' ||
      typeof appeal.appellantId !== 'string' ||
      typeof appeal.statement !== 'string' ||
      typeof appeal.createdAt !== 'string' ||
      typeof appeal.canResolve !== 'boolean' ||
      !decision ||
      typeof decision.statement !== 'string' ||
      !decision.target ||
      typeof decision.target !== 'object'
    )
      throw notFound();
    const target = decision.target as Record<string, unknown>;
    if ((target.kind !== 'post' && target.kind !== 'thread') || typeof target.id !== 'string') throw notFound();
    return {
      id: appeal.id,
      decisionId: appeal.decisionId,
      appellantId: appeal.appellantId,
      statement: appeal.statement,
      createdAt: appeal.createdAt,
      decision: {
        statement: decision.statement,
        target: { kind: target.kind, id: target.id },
      },
      canResolve: appeal.canResolve,
    };
  });
  return { appeals, next: page.next as string | null };
}

/** Reads one native page, then resolves each distinct target with at most one ordinary read. */
export async function readModerationAppeals(
  source: AppealReadSource,
  input: { boardId: string; threadId?: string; cursor?: string },
): Promise<AppealPage> {
  return input.threadId
    ? source.threadAppeals(input.threadId, input.cursor)
    : source.boardAppeals(input.boardId, input.cursor);
}

export async function resolveAppealTargets(appeals: Appeal[], reads: AppealTargetReads): Promise<ModerationTarget[]> {
  const unique = new Map<string, NonNullable<Appeal['decision']['target']>>();
  for (const appeal of appeals) {
    const target = appealTarget(appeal);
    if (target) unique.set(`${target.kind}:${target.id}`, target);
  }
  return Promise.all(
    [...unique].map(async ([key, target]) => ({
      key,
      kind: target.kind,
      value: await reads[target.kind](target.id).catch(() => null),
    })),
  );
}

export function appealTarget(appeal: Appeal): Appeal['decision']['target'] {
  return (
    appeal.decision.target ??
    (appeal.decision.targetKind && appeal.decision.targetId
      ? { kind: appeal.decision.targetKind, id: appeal.decision.targetId }
      : undefined)
  );
}

type ReadResult = { data?: unknown; error?: unknown };
type Client = {
  boards: (params: { id: string }) => {
    appeals: { get: (options: unknown) => Promise<ReadResult> };
  };
  threads: (params: { id: string }) => {
    appeals: { get: (options: unknown) => Promise<ReadResult> };
    get: (options?: unknown) => Promise<ReadResult>;
  };
  posts: (params: { id: string }) => { get: (options?: unknown) => Promise<ReadResult> };
};
const auth = (authorization: string) => ({ headers: { authorization } });

export const loadModerationAppeals = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object') throw notFound();
    const value = input as Record<string, unknown>;
    if (typeof value.boardId !== 'string' || value.boardId.length > 128) throw notFound();
    if (value.threadId !== undefined && (typeof value.threadId !== 'string' || value.threadId.length > 128))
      throw notFound();
    if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 4096))
      throw notFound();
    return {
      boardId: value.boardId,
      ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
      ...(typeof value.cursor === 'string' && value.cursor ? { cursor: value.cursor } : {}),
    };
  })
  .handler(async ({ data }): Promise<AppealPage & { targets: ModerationTarget[] }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) throw notFound();
    const client = kernelClient() as unknown as Client;
    const headers = auth(authorization);
    const page = await readModerationAppeals(
      {
        boardAppeals: async (id, cursor) => {
          const result = await client.boards({ id }).appeals.get({
            ...headers,
            query: { limit: MODERATION_APPEALS_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
          });
          if (result.error || !result.data) throw notFound();
          return parseAppealPage(result.data);
        },
        threadAppeals: async (id, cursor) => {
          const result = await client.threads({ id }).appeals.get({
            ...headers,
            query: { limit: MODERATION_APPEALS_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
          });
          if (result.error || !result.data) throw notFound();
          return parseAppealPage(result.data);
        },
      },
      data,
    );
    const targets = await resolveAppealTargets(page.appeals, {
      post: async (id) => {
        const result = await client.posts({ id }).get(headers);
        return result.error ? null : ((result.data as ModerationTarget['value'] | undefined) ?? null);
      },
      thread: async (id) => {
        const result = await client.threads({ id }).get(headers);
        return result.error ? null : ((result.data as ModerationTarget['value'] | undefined) ?? null);
      },
    });
    return { ...page, targets };
  });
