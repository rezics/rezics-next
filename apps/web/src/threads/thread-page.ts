import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import type { VerificationConfig } from '../report/turnstile';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';

type ThreadResource = ReturnType<KernelClient['threads']>;
type Thread = NonNullable<Awaited<ReturnType<ThreadResource['get']>>['data']>;
type PostPage = NonNullable<Awaited<ReturnType<ThreadResource['posts']['get']>>['data']>;
export type ThreadPost = PostPage['posts'][number];

type PageInput = { id: string; cursor?: string };

function checkRead<T>(result: { error?: unknown; status?: number; data?: T | null }, resource: string): NonNullable<T> {
  if (result.error) {
    if (result.status === 404) throw notFound();
    throw new Error(`Kernel ${resource} read failed`);
  }
  return result.data as NonNullable<T>;
}

export async function loadThreadPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: PageInput,
  verification: VerificationConfig,
): Promise<{
  thread: Thread['thread'];
  posts: PostPage;
  viewerId?: string;
  verification: VerificationConfig;
}> {
  let authorization: string | null = null;
  let viewerId: string | undefined;
  try {
    await prepareSession(request, sessionEnv);
    authorization = viewerCredential(request);
    viewerId = sessionSubject(request);
  } catch {
    // A page remains usable when the session credential cannot be read.
    authorization = null;
    viewerId = undefined;
  }
  const threadRead = authorization
    ? client.threads({ id: data.id }).get({ headers: { authorization } })
    : client.threads({ id: data.id }).get();
  const postsRead = authorization
    ? client
        .threads({ id: data.id })
        .posts.get(
          data.cursor ? { query: { cursor: data.cursor }, headers: { authorization } } : { headers: { authorization } },
        )
    : client.threads({ id: data.id }).posts.get(data.cursor ? { query: { cursor: data.cursor } } : {});
  const [threadResult, postsResult] = await Promise.all([threadRead, postsRead]);
  const thread = checkRead<Thread>(threadResult, 'thread');
  const posts = checkRead<PostPage>(postsResult, 'thread posts');
  if (thread.thread.id !== data.id) throw notFound();
  return {
    thread: thread.thread,
    posts,
    ...(viewerId ? { viewerId } : {}),
    verification,
  };
}
