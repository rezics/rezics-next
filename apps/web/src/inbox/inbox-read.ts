import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';

export const INBOX_PAGE_SIZE = 20;

export type InboxNotice = {
  id: string;
  kind: 'reply' | 'mention' | 'moderation_decision';
  createdAt: string;
  actorId: string | null;
  threadId: string | null;
  postId: string | null;
  decisionId: string | null;
  reportId: string | null;
  unread: boolean;
};
type NoticePage = { items: InboxNotice[]; next: string | null };
type ResolvedNotice = InboxNotice & {
  href?: string;
  text: string;
  unavailable: boolean;
};
export type ResolvedInboxPage = { items: ResolvedNotice[]; next: string | null };
export type InboxReads = {
  post: (threadId: string, postId: string) => Promise<{ title?: string; href?: string; text?: string } | null>;
  decision: (id: string) => Promise<{ statement: string; href?: string } | null>;
  report: (id: string) => Promise<{ outcome: string; href?: string } | null>;
};

/** Resolves thin notice identities through their existing owner reads, once per distinct target. */
export async function resolveInboxItems(page: NoticePage, reads: InboxReads): Promise<ResolvedInboxPage> {
  const cache = new Map<string, Promise<{ href?: string; text: string } | null>>();
  const resolve = (key: string, read: () => Promise<{ href?: string; text: string } | null>) => {
    let result = cache.get(key);
    if (!result) {
      result = read().catch(() => null);
      cache.set(key, result);
    }
    return result;
  };
  const items = await Promise.all(
    page.items.map(async (notice): Promise<ResolvedNotice> => {
      let target: { href?: string; text: string } | null = null;
      if (notice.reportId) {
        target = await resolve(`report:${notice.reportId}`, async () => {
          const report = await reads.report(notice.reportId!);
          return report
            ? { href: report.href ?? `/moderation/reports/${notice.reportId}`, text: report.outcome }
            : null;
        });
      } else if (notice.kind === 'moderation_decision' && notice.decisionId) {
        target = await resolve(`decision:${notice.decisionId}`, async () => {
          const decision = await reads.decision(notice.decisionId!);
          return decision
            ? {
                href: decision.href ?? `/moderation/decisions/${notice.decisionId}`,
                text: decision.statement,
              }
            : null;
        });
      } else if (notice.threadId && notice.postId) {
        target = await resolve(`post:${notice.threadId}:${notice.postId}`, async () => {
          const post = await reads.post(notice.threadId!, notice.postId!);
          return post
            ? {
                href: post.href ?? `/threads/${notice.threadId}#${notice.postId}`,
                text: post.text ?? post.title ?? '',
              }
            : null;
        });
      }
      return {
        ...notice,
        ...(target?.href ? { href: target.href } : {}),
        text: target?.text ?? '',
        unavailable: !target,
      };
    }),
  );
  return { items, next: page.next };
}

type ReadResult = { data?: unknown; error?: unknown };
type InboxKernelClient = {
  accounts: (params: { accountId: string }) => {
    notifications: {
      get: (options: unknown) => Promise<ReadResult>;
      count: { get: (options: unknown) => Promise<ReadResult> };
      $markSeen: { post: (options: unknown) => Promise<{ error?: unknown }> };
    };
  };
  posts: (params: { id: string }) => { get: (options: unknown) => Promise<ReadResult> };
  'moderation-decisions': (params: { id: string }) => { get: (options: unknown) => Promise<ReadResult> };
  reports: (params: { id: string }) => { get: (options: unknown) => Promise<ReadResult> };
};
function authHeaders(authorization: string) {
  return { authorization };
}

async function readNoticePage(client: InboxKernelClient, accountId: string, authorization: string, cursor?: string) {
  const result = await client.accounts({ accountId }).notifications.get({
    query: { limit: INBOX_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    headers: authHeaders(authorization),
  });
  if (result.error || !result.data) throw new Error('Kernel notification read failed');
  return result.data as NoticePage;
}

async function currentInboxReads(client: InboxKernelClient, authorization: string): Promise<InboxReads> {
  return {
    post: async (threadId, postId) => {
      const result = await client.posts({ id: postId }).get({ headers: authHeaders(authorization) });
      const data = result.data as
        | { post?: { threadId?: string; availability?: string; removed?: boolean; body?: unknown } }
        | undefined;
      if (
        result.error ||
        !data?.post ||
        data.post.threadId !== threadId ||
        data.post.availability === 'erased' ||
        data.post.removed === true
      )
        return null;
      return { text: postText(data.post), href: `/threads/${threadId}#${postId}` };
    },
    decision: async (id) => {
      const result = await client['moderation-decisions']({ id }).get({ headers: authHeaders(authorization) });
      const data = result.data as { statement?: string } | undefined;
      if (result.error || !data?.statement) return null;
      return { statement: data.statement, href: `/moderation/decisions/${id}` };
    },
    report: async (id) => {
      const result = await client.reports({ id }).get({ headers: authHeaders(authorization) });
      const data = result.data as { report?: { outcome?: string } } | undefined;
      const outcome = data?.report?.outcome;
      return result.error || !outcome ? null : { outcome, href: `/moderation/reports/${id}` };
    },
  };
}

function postText(post: unknown): string {
  if (!post || typeof post !== 'object') return '';
  const record = post as Record<string, unknown>;
  const revision =
    record.revision && typeof record.revision === 'object' ? (record.revision as Record<string, unknown>) : record;
  const document = record.body ?? revision.body ?? revision.document;
  if (!document || typeof document !== 'object') return '';
  const text: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const value = node as Record<string, unknown>;
    if (value.type === 'text' && typeof value.text === 'string') text.push(value.text);
    if (Array.isArray(value.content)) value.content.forEach(visit);
  };
  visit(document);
  return text.join('');
}

export type InboxPage = { signedIn: boolean; items: ResolvedNotice[]; next: string | null };
export const setInboxResponsePolicy = createServerFn({ method: 'GET' }).handler(() => {
  setResponseHeader('cache-control', 'private, no-store');
  return null;
});

export const readInboxPage = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if ('cursor' in value && value.cursor !== undefined && typeof value.cursor !== 'string')
      throw new Error('Invalid inbox cursor');
    return typeof value.cursor === 'string' && value.cursor ? { cursor: value.cursor } : {};
  })
  .handler(async ({ data }): Promise<InboxPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    const accountId = sessionSubject(request);
    if (!authorization || !accountId) return { signedIn: false, items: [], next: null };
    const client = kernelClient() as unknown as InboxKernelClient;
    const page = await readNoticePage(client, accountId, authorization, data.cursor);
    const resolved = await resolveInboxItems(page, await currentInboxReads(client, authorization));
    return { signedIn: true, ...resolved };
  });

export const readUnreadCount = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) return { signedIn: false, count: 0, capped: false };
  const client = kernelClient() as unknown as InboxKernelClient;
  const result = await client.accounts({ accountId }).notifications.count.get({ headers: authHeaders(authorization) });
  const count = result.data as { count: number; capped: boolean } | undefined;
  if (result.error || !count) return { signedIn: true, count: 0, capped: false };
  return { signedIn: true, ...count };
});

export const markInboxSeen = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object' || !('through' in input) || typeof input.through !== 'string')
      throw new Error('Invalid notice id');
    return { through: input.through };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    const accountId = sessionSubject(request);
    if (!authorization || !accountId) return { signedIn: false };
    const client = kernelClient() as unknown as InboxKernelClient;
    const result = await client.accounts({ accountId }).notifications.$markSeen.post({
      body: { through: data.through },
      headers: { ...authHeaders(authorization), 'idempotency-key': crypto.randomUUID() },
    });
    if (result.error) throw new Error('Kernel notification mark seen failed');
    return { signedIn: true };
  });
