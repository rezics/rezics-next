import type { KernelClient } from '@rezics/client';
import type { DocumentMentions } from '@rezics/ui/document-body';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { VerificationConfig } from '../report/turnstile';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import { prepareSession, viewerCredential } from '../session/request';
import { kernelClient } from '../kernel/client';
import { threadTitle } from './thread-href';
import { loadBoardPageWithAuthors, loadThreadPageWithAuthors } from '../identity/page-loaders';
import { sessionSubject } from '../session/request';
import type { PageAuthors } from '../identity/read';
import type { BoardRealm } from './board-context';
import type { ThreadSubject } from './subjects';
import type { ThreadPost, ThreadSlugRedirect } from './thread-page';

type BoardResource = ReturnType<KernelClient['boards']>;
type ThreadResource = ReturnType<KernelClient['threads']>;
type Board = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>;
type Thread = NonNullable<Awaited<ReturnType<ThreadResource['get']>>['data']>;
type PostPage = NonNullable<Awaited<ReturnType<ThreadResource['posts']['get']>>['data']>;
export type { ThreadPost };

type PageInput = {
  id: string;
  cursor?: string;
  sort?: 'hot' | 'new';
  expectedSlug?: string;
  credentialMode?: ReadCredentialMode;
};
function validatePageInput(input: unknown): PageInput {
  if (
    !input ||
    typeof input !== 'object' ||
    !('id' in input) ||
    typeof input.id !== 'string' ||
    input.id.length > 128 ||
    ('cursor' in input && input.cursor !== undefined && typeof input.cursor !== 'string') ||
    ('sort' in input && input.sort !== undefined && input.sort !== 'hot' && input.sort !== 'new') ||
    ('expectedSlug' in input && input.expectedSlug !== undefined && typeof input.expectedSlug !== 'string') ||
    ('credentialMode' in input &&
      input.credentialMode !== undefined &&
      input.credentialMode !== 'anonymous' &&
      input.credentialMode !== 'session')
  )
    throw notFound();
  return {
    id: input.id,
    ...('cursor' in input && typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    ...('sort' in input && (input.sort === 'hot' || input.sort === 'new') ? { sort: input.sort } : {}),
    ...('expectedSlug' in input && typeof input.expectedSlug === 'string' ? { expectedSlug: input.expectedSlug } : {}),
    ...('credentialMode' in input && (input.credentialMode === 'anonymous' || input.credentialMode === 'session')
      ? { credentialMode: input.credentialMode }
      : {}),
  };
}

function checkRead<T>(result: { error?: unknown; status?: number; data?: T | null }, resource: string): NonNullable<T> {
  if (result.error) {
    if (result.status === 404) throw notFound();
    throw new Error(`Kernel ${resource} read failed`);
  }
  return result.data as NonNullable<T>;
}

export const readBoardPage = createServerFn({ method: 'GET' })
  .validator(validatePageInput)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    let authorization: string | null = null;
    if (data.credentialMode === 'session') {
      try {
        await prepareSession(getRequest(), env as Partial<SessionEnv>);
        authorization = viewerCredential(getRequest());
      } catch {
        authorization = null;
      }
    }
    return loadBoardPageWithAuthors(kernelClient(), data, authorization);
  });

export const readNewThreadPage = createServerFn({ method: 'GET' })
  .validator(validatePageInput)
  .handler(async ({ data }): Promise<{ board: Board['board']; idempotencyKey: string }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await kernelClient().boards({ id: data.id }).get();
    const board = checkRead<Board>(result, 'board');
    if (board.board.id !== data.id) throw notFound();
    return { board: board.board, idempotencyKey: crypto.randomUUID() };
  });

/** The thread read that decides the slug. A redirect stops here and does not read posts. */
export const readThreadSlug = createServerFn({ method: 'GET' })
  .validator(validatePageInput)
  .handler(async ({ data }): Promise<{ id: string; title: string | null }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    let authorization: string | null = null;
    if (data.credentialMode === 'session') {
      try {
        await prepareSession(request, env as Partial<SessionEnv>);
        authorization = viewerCredential(request);
      } catch {
        authorization = null;
      }
    }
    const result = authorization
      ? await kernelClient().threads({ id: data.id }).get({ headers: { authorization } })
      : await kernelClient().threads({ id: data.id }).get();
    const thread = checkRead<Thread>(result, 'thread');
    if (thread.thread.id !== data.id) throw notFound();
    return { id: thread.thread.id, title: threadTitle(thread.thread) };
  });

export const readThreadPersonal = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      !('postIds' in input) ||
      !Array.isArray(input.postIds) ||
      input.postIds.length > 101 ||
      input.postIds.some((id) => typeof id !== 'string' || id.length > 128)
    )
      throw notFound();
    return { id: input.id, postIds: input.postIds as string[] };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    const viewerId = sessionSubject(request);
    if (!authorization || !viewerId) return { viewerId: null, reactions: {} as Record<string, string | null> };
    const client = kernelClient();
    const targets = [data.id, ...data.postIds];
    const values = await Promise.all(
      targets.map(async (target) => {
        const resource = target === data.id ? client.threads({ id: target }) : client.posts({ id: target });
        try {
          const result = await (
            resource as unknown as {
              reaction: {
                get(options: { headers: { authorization: string } }): Promise<{ data?: { kind?: string | null } }>;
              };
            }
          ).reaction.get({ headers: { authorization } });
          return [target, result.data?.kind ?? null] as const;
        } catch {
          return [target, null] as const;
        }
      }),
    );
    return { viewerId, reactions: Object.fromEntries(values) };
  });

export const readThreadPage = createServerFn({ method: 'GET' })
  .validator(validatePageInput)
  .handler(
    async ({
      data,
    }): Promise<
      | {
          thread: Thread['thread'];
          board?: Board['board'];
          realm?: BoardRealm;
          posts: PostPage;
          mentions: DocumentMentions;
          viewerId?: string;
          verification: VerificationConfig;
          authors: PageAuthors;
          subjects: ThreadSubject[];
          now: string;
        }
      | ThreadSlugRedirect
    > => {
      setResponseHeader('cache-control', 'private, no-store');
      const config = env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SCRIPT_URL?: string };
      const request = getRequest();
      const page = await loadThreadPageWithAuthors(
        kernelClient(),
        request,
        env as Partial<SessionEnv>,
        data,
        {
          sitekey: config.TURNSTILE_SITE_KEY ?? '',
          scriptUrl:
            (import.meta.env.DEV && config.TURNSTILE_SCRIPT_URL) ||
            'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
        },
        data.credentialMode ?? 'anonymous',
      );
      if ('redirect' in page) return page;
      return page;
    },
  );
