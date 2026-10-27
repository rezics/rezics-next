import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { VerificationConfig } from '../report/turnstile';
import type { SessionEnv } from '../session/client';
import { cookie } from '../session/cookies';
import { prepareSession, viewerCredential } from '../session/request';
import { kernelClient } from '../kernel/client';
import { threadTitle } from './thread-href';
import { loadBoardPageWithAuthors, loadThreadPageWithAuthors } from '../identity/page-loaders';
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

type PageInput = { id: string; cursor?: string; sort?: 'hot' | 'new'; expectedSlug?: string };
const draftCookie = 'rezics_draft_key';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function carriedDraftKey(request: Request, threadId: string): string | undefined {
  const raw = cookie(request, draftCookie);
  const split = raw?.lastIndexOf('.') ?? -1;
  if (!raw || split < 1 || raw.slice(0, split) !== threadId) return undefined;
  const key = raw.slice(split + 1);
  return uuid.test(key) ? key : undefined;
}

function validatePageInput(input: unknown): PageInput {
  if (
    !input ||
    typeof input !== 'object' ||
    !('id' in input) ||
    typeof input.id !== 'string' ||
    input.id.length > 128 ||
    ('cursor' in input && input.cursor !== undefined && typeof input.cursor !== 'string') ||
    ('sort' in input && input.sort !== undefined && input.sort !== 'hot' && input.sort !== 'new') ||
    ('expectedSlug' in input && input.expectedSlug !== undefined && typeof input.expectedSlug !== 'string')
  )
    throw notFound();
  return {
    id: input.id,
    ...('cursor' in input && typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    ...('sort' in input && (input.sort === 'hot' || input.sort === 'new') ? { sort: input.sort } : {}),
    ...('expectedSlug' in input && typeof input.expectedSlug === 'string' ? { expectedSlug: input.expectedSlug } : {}),
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
    return loadBoardPageWithAuthors(kernelClient(), data);
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
    try {
      await prepareSession(request, env as Partial<SessionEnv>);
      authorization = viewerCredential(request);
    } catch {
      authorization = null;
    }
    const result = authorization
      ? await kernelClient().threads({ id: data.id }).get({ headers: { authorization } })
      : await kernelClient().threads({ id: data.id }).get();
    const thread = checkRead<Thread>(result, 'thread');
    if (thread.thread.id !== data.id) throw notFound();
    return { id: thread.thread.id, title: threadTitle(thread.thread) };
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
          idempotencyKey: string;
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
      const page = await loadThreadPageWithAuthors(kernelClient(), request, env as Partial<SessionEnv>, data, {
        sitekey: config.TURNSTILE_SITE_KEY ?? '',
        scriptUrl:
          (import.meta.env.DEV && config.TURNSTILE_SCRIPT_URL) ||
          'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
      });
      if ('redirect' in page) return page;
      return { ...page, idempotencyKey: carriedDraftKey(request, data.id) ?? crypto.randomUUID() };
    },
  );
