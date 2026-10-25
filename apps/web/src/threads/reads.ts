import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../session/client';
import { readSessionIdentity } from '../session/state';
import type { VerificationConfig } from '../report/turnstile';
import { kernelClient } from '../kernel/client';

type BoardResource = ReturnType<KernelClient['boards']>;
type ThreadResource = ReturnType<KernelClient['threads']>;
type Board = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>;
type Thread = NonNullable<Awaited<ReturnType<ThreadResource['get']>>['data']>;
type ThreadPage = NonNullable<Awaited<ReturnType<BoardResource['threads']['get']>>['data']>;
type PostPage = NonNullable<Awaited<ReturnType<ThreadResource['posts']['get']>>['data']>;

type PageInput = { id: string; cursor?: string };

function validatePageInput(input: unknown): PageInput {
  if (
    !input ||
    typeof input !== 'object' ||
    !('id' in input) ||
    typeof input.id !== 'string' ||
    input.id.length > 128 ||
    ('cursor' in input && input.cursor !== undefined && typeof input.cursor !== 'string')
  )
    throw notFound();
  return {
    id: input.id,
    ...('cursor' in input && typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
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
  .handler(async ({ data }): Promise<{ board: Board['board']; threads: ThreadPage }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const client = kernelClient();
    const query = data.cursor ? { query: { cursor: data.cursor } } : {};
    const [boardResult, threadsResult] = await Promise.all([
      client.boards({ id: data.id }).get(),
      client.boards({ id: data.id }).threads.get(query),
    ]);
    const board = checkRead<Board>(boardResult, 'board');
    const threads = checkRead<ThreadPage>(threadsResult, 'board threads');
    if (board.board.id !== data.id) throw notFound();
    return { board: board.board, threads };
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

export const readThreadPage = createServerFn({ method: 'GET' })
  .validator(validatePageInput)
  .handler(
    async ({
      data,
    }): Promise<{
      thread: Thread['thread'];
      posts: PostPage;
      idempotencyKey: string;
      viewerId?: string;
      verification: VerificationConfig;
    }> => {
      setResponseHeader('cache-control', 'private, no-store');
      const client = kernelClient();
      const query = data.cursor ? { query: { cursor: data.cursor } } : {};
      const [threadResult, postsResult] = await Promise.all([
        client.threads({ id: data.id }).get(),
        client.threads({ id: data.id }).posts.get(query),
      ]);
      const thread = checkRead<Thread>(threadResult, 'thread');
      const posts = checkRead<PostPage>(postsResult, 'thread posts');
      if (thread.thread.id !== data.id) throw notFound();
      const identity = await readSessionIdentity(getRequest(), env as Partial<SessionEnv>);
      const config = env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SCRIPT_URL?: string };
      return {
        thread: thread.thread,
        posts,
        idempotencyKey: crypto.randomUUID(),
        ...(identity.subject ? { viewerId: identity.subject } : {}),
        verification: {
          sitekey: config.TURNSTILE_SITE_KEY ?? '',
          scriptUrl:
            (import.meta.env.DEV && config.TURNSTILE_SCRIPT_URL) ||
            'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
        },
      };
    },
  );
