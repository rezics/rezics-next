import { bundledDigest } from '@rezics/definitions/bundled';
import { fromPlainText, normalizeDocument } from '@rezics/document';
import { startAuthStack, type AuthJourney, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const jsonHeaders = { 'content-type': 'application/json' };
const idempotency = () => JSON.stringify(crypto.randomUUID());

export type NotificationPersona = 'alice' | 'bob' | 'editor' | 'governor';
export type NativeNoticeThread = { id: string; route: number; firstPostId: string };
export type NativeNotificationFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  aliceId: string;
  bobId: string;
  aliceJourney: AuthJourney;
  bobJourney: AuthJourney;
  boardId: string;
  boardRoute: number;
  createBoard(visibility: 'published' | 'protected', title: string): Promise<{ id: string; route: number }>;
  createThread(
    actor: NotificationPersona,
    title: string,
    boardId?: string,
    boardRoute?: number,
  ): Promise<NativeNoticeThread>;
  createPost(
    actor: NotificationPersona,
    thread: NativeNoticeThread,
    options?: { parentId?: string; mentionIds?: string[]; text?: string },
  ): Promise<{ id: string; threadId: string; nativeResponse: { path: string; status: number; body: unknown } }>;
  takeDownThread(thread: NativeNoticeThread, reason: string): Promise<void>;
  grant(resource: { id: string; route: number }, accountId: string, action: string): Promise<void>;
  revoke(resource: { id: string; route: number }, accountId: string, action: string): Promise<void>;
  close(): Promise<void>;
};

function routeOf(id: string): number {
  const route = Number.parseInt(id.slice(24, 28), 16);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(route)) throw new Error(`Invalid native route id: ${id}`);
  return route;
}

function body(text: string, mentionIds: string[] = []) {
  const plain = fromPlainText(text, 'text');
  const paragraphs = plain.doc.content ?? [];
  const first = paragraphs[0]!;
  return normalizeDocument({
    ...plain,
    doc: {
      ...plain.doc,
      content: [
        {
          ...first,
          content: [
            ...(first.content ?? []),
            ...mentionIds.map((accountId) => ({ type: 'mention', attrs: { accountId } })),
          ],
        },
        ...paragraphs.slice(1),
      ],
    },
  });
}

async function json<T>(
  stack: NativeWebStack,
  path: string,
  actor: NotificationPersona,
  method = 'GET',
  data?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  const response = await stack.kernel(
    path,
    {
      method,
      headers: {
        ...(data === undefined ? {} : jsonHeaders),
        ...(method === 'GET' ? {} : { 'idempotency-key': idempotency() }),
        ...extraHeaders,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    },
    actor,
  );
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${await response.text()}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export async function startNativeNotificationFixture(): Promise<NativeNotificationFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  try {
    auth = await startAuthStack(stack);
    const [alice, bob] = await Promise.all([auth.signIn('alice'), auth.signIn('bob')]);
    const [aliceIdentity, bobIdentity] = await Promise.all([stack.authPersona('alice'), stack.authPersona('bob')]);

    const active = (await json<{ digest: string }>(stack, '/v1/definitions/active', 'editor')).digest;
    if (active !== bundledDigest)
      throw new Error(
        `Native notifications fixture definition mismatch: expected ${bundledDigest}, received ${active}`,
      );

    const schemeResult = await json<{ subject: { id: string } }>(stack, '/v1/subjects', 'editor', 'POST', {
      type: 'skos:ConceptScheme',
      labels: { en: `Native notification scheme ${crypto.randomUUID()}` },
    });
    const conceptResult = await json<{ subject: { id: string } }>(stack, '/v1/subjects', 'editor', 'POST', {
      type: 'skos:Concept',
      labels: { en: `Native notifications ${crypto.randomUUID()}` },
      statements: {
        'skos:inScheme': [
          {
            property: { id: 'skos:inScheme' },
            value: { type: 'value', content: schemeResult.subject.id },
          },
        ],
      },
    });
    const conceptId = conceptResult.subject.id;

    const spaceResult = await json<{ space: { spaceId: string } }>(stack, '/v1/spaces', 'governor', 'POST', {
      title: 'Native notification host Space',
      summary: 'Host for native notification boards.',
    });
    const realmResult = await json<{
      realm: { realmId: string; headRevisionId: string };
    }>(stack, '/v1/realms', 'governor', 'POST', {
      spaceId: spaceResult.space.spaceId,
      title: 'Native notification host Realm',
      summary: 'Host for native notification boards.',
      visibility: 'public',
      contextId: globalContext,
    });
    const realmId = realmResult.realm.realmId;
    await json(
      stack,
      `/v1/realms/${realmId}/boardScheme`,
      'governor',
      'PUT',
      { schemeId: schemeResult.subject.id },
      {
        'if-match': JSON.stringify(realmResult.realm.headRevisionId),
      },
    );

    async function createBoard(visibility: 'published' | 'protected', title: string) {
      const result = await json<{ board: { id: string; route?: number } }>(
        stack,
        `/v1/realms/${realmId}/boards`,
        'governor',
        'POST',
        { conceptId, title, visibility },
      );
      const board = result.board;
      return { id: board.id, route: board.route ?? routeOf(board.id) };
    }
    const grants = new Set<string>();
    const grantKey = (resource: { id: string; route: number }, accountId: string, action: string) =>
      `${resource.route}/${resource.id}/${accountId}/${action}`;
    async function grant(resource: { id: string; route: number }, accountId: string, action: string) {
      const key = grantKey(resource, accountId, action);
      if (grants.has(key)) return;
      await json(stack, '/v1/grants', 'governor', 'POST', {
        resource: { id: resource.id, route: resource.route },
        subject: { kind: 'account', id: accountId },
        actions: [action],
        valid: '(,)',
      });
      grants.add(key);
    }
    async function revoke(resource: { id: string; route: number }, accountId: string, action: string) {
      const key = grantKey(resource, accountId, action);
      if (!grants.has(key)) return;
      await json(stack, '/v1/grants:revoke', 'governor', 'POST', {
        resource: { id: resource.id, route: resource.route },
        subject: { kind: 'account', id: accountId },
        actions: [action],
        valid: '(,)',
      });
      grants.delete(key);
    }

    const publicBoard = await createBoard('published', 'Native notification discussion');
    for (const accountId of [aliceIdentity.accountId, bobIdentity.accountId]) {
      await grant(publicBoard, accountId, 'thread:create');
    }
    const editor = await stack.authPersona('editor');
    await grant(publicBoard, editor.accountId, 'thread:create');

    async function createThread(
      actor: NotificationPersona,
      title: string,
      boardId = publicBoard.id,
      boardRoute = publicBoard.route,
    ): Promise<NativeNoticeThread> {
      await grant({ id: boardId, route: boardRoute }, (await stack.authPersona(actor)).accountId, 'thread:create');
      const result = await json<{
        thread: { id: string; route?: number; firstPost: { id: string } };
      }>(stack, '/v1/threads', actor, 'POST', {
        boardId,
        title,
        body: body(`${title} opening post`),
        licence: 'MIT',
        subjectIds: [],
        visibility: 'published',
      });
      const thread = result.thread;
      return { id: thread.id, route: thread.route ?? routeOf(thread.id), firstPostId: thread.firstPost.id };
    }

    async function createPost(
      actor: NotificationPersona,
      thread: NativeNoticeThread,
      options: { parentId?: string; mentionIds?: string[]; text?: string } = {},
    ) {
      const actorId = (await stack.authPersona(actor)).accountId;
      await grant(thread, actorId, 'post:create');
      const path = `/v1/threads/${thread.id}/posts`;
      const response = await stack.kernel(
        path,
        {
          method: 'POST',
          headers: { ...jsonHeaders, 'idempotency-key': idempotency() },
          body: JSON.stringify({
            ...(options.parentId ? { parentId: options.parentId } : {}),
            body: body(options.text ?? 'Native notification reply', options.mentionIds),
            licence: 'MIT',
            subjectIds: [],
          }),
        },
        actor,
      );
      const responseBody = await response.json();
      if (!response.ok) throw new Error(`POST ${path} returned ${response.status}: ${JSON.stringify(responseBody)}`);
      const result = responseBody as { post: { id: string; threadId?: string } };
      return {
        id: result.post.id,
        threadId: thread.id,
        nativeResponse: { path, status: response.status, body: responseBody },
      };
    }

    async function takeDownThread(thread: NativeNoticeThread, reason: string) {
      await json(stack, `/v1/threads/${thread.id}:takeDown`, 'governor', 'POST', { reason });
    }
    return {
      stack,
      auth,
      aliceId: aliceIdentity.accountId,
      bobId: bobIdentity.accountId,
      aliceJourney: alice,
      bobJourney: bob,
      boardId: publicBoard.id,
      boardRoute: publicBoard.route,
      createBoard,
      createThread,
      createPost,
      takeDownThread,
      grant,
      revoke,
      async close() {
        const errors: unknown[] = [];
        try {
          await auth?.stop();
        } catch (error) {
          errors.push(error);
        }
        try {
          await stack.stop();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, 'Native notification fixture cleanup failed');
      },
    };
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop().catch(() => {});
    throw error;
  }
}
