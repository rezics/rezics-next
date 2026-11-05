import { fromPlainText } from '@rezics/document';
import { routeOf } from '../../../../services/kernel/src/route/route.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { currentNativeLifecycle } from './lifecycle.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const personas = ['moderation-alice', 'moderation-author', 'moderator', 'appeal-moderator', 'outsider'] as const;
type Persona = (typeof personas)[number];
type Identity = { accountId: string; email: string; authorization: string };

export type NativeModerationFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  identities: Record<Persona | 'governor', Identity>;
  boardId: string;
  unrelatedBoardId: string;
  threadId: string;
  unrelatedThreadId: string;
  postId: string;
  unrelatedPostId: string;
  addUnrelatedPosts(count: number): Promise<void>;
  stop(): Promise<void>;
};

async function responseValue<T>(response: Response, operation: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${operation}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Starts the served Worker/Auth boundary and builds all native fixtures through production APIs. */
export async function startNativeModerationFixture(): Promise<NativeModerationFixture> {
  const lifecycle = currentNativeLifecycle();
  if (!lifecycle) throw new Error('Native moderation fixture requires an active native test lifecycle');
  lifecycle.assertOpen('start native moderation fixture');
  const turnstile = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/api.js') return new Response('Not Found', { status: 404 });
      return new Response(
        `window.turnstile={ready:function(callback){callback()},render:function(node,options){queueMicrotask(function(){options.callback('native-test-token')});return 'native-widget'},reset:function(){},remove:function(){}};`,
        { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } },
      );
    },
  });
  lifecycle.register({
    label: 'native moderation Turnstile listener',
    close: () => turnstile.stop(true),
    force: () => turnstile.stop(true),
  });
  const originalSiteKey = process.env.TURNSTILE_SITE_KEY;
  const originalScriptUrl = process.env.TURNSTILE_SCRIPT_URL;
  process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
  process.env.TURNSTILE_SCRIPT_URL = `${turnstile.url.origin}/api.js`;

  let stack: NativeWebStack | undefined;
  let auth: NativeAuthStack | undefined;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await auth?.stop();
    } finally {
      try {
        await stack?.stop();
      } finally {
        turnstile.stop(true);
      }
    }
  };
  const restoreEnvironment = () => {
    if (originalSiteKey === undefined) delete process.env.TURNSTILE_SITE_KEY;
    else process.env.TURNSTILE_SITE_KEY = originalSiteKey;
    if (originalScriptUrl === undefined) delete process.env.TURNSTILE_SCRIPT_URL;
    else process.env.TURNSTILE_SCRIPT_URL = originalScriptUrl;
  };

  try {
    stack = await startNativeWebStack();
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  } finally {
    // The Worker process captured these bindings at startup; the test process no longer needs them.
    restoreEnvironment();
  }

  try {
    const identities = Object.fromEntries(
      await Promise.all(
        [...personas, 'governor' as const].map(
          async (persona) => [persona, await stack!.authPersona(persona)] as const,
        ),
      ),
    ) as Record<Persona | 'governor', Identity>;

    async function command<T = Record<string, unknown>>(
      path: string,
      method: string,
      body: unknown,
      persona: string,
      extraHeaders: Record<string, string> = {},
    ): Promise<T> {
      const response = await stack!.kernel(
        path,
        {
          method,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(crypto.randomUUID()),
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        },
        persona,
      );
      return responseValue<T>(response, `${method} ${path} as ${persona}`);
    }

    async function grant(accountId: string, actions: string[], resource = { route: 0, id: globalContext }) {
      await command(
        '/v1/grants',
        'POST',
        {
          resource,
          subject: { kind: 'account', id: accountId },
          actions,
          valid: '(,)',
        },
        'governor',
      );
    }

    await grant(identities['moderation-author'].accountId, ['space:create', 'realm:create', 'subject:create']);

    const { space } = await command<{ space: { spaceId: string } }>(
      '/v1/spaces',
      'POST',
      { title: 'Native moderation space', summary: 'Native moderation flow fixture' },
      'moderation-author',
    );
    const { realm } = await command<{ realm: { realmId: string; headRevisionId: string } }>(
      '/v1/realms',
      'POST',
      {
        spaceId: space.spaceId,
        title: 'Native moderation realm',
        summary: 'Native moderation flow fixture',
        visibility: 'public',
        contextId: globalContext,
      },
      'moderation-author',
    );
    const { subject: scheme } = await command<{ subject: { id: string } }>(
      '/v1/subjects',
      'POST',
      { type: 'skos:ConceptScheme', labels: { en: 'Native moderation board scheme' } },
      'moderation-author',
    );
    await command(`/v1/realms/${realm.realmId}/boardScheme`, 'PUT', { schemeId: scheme.id }, 'moderation-author', {
      'if-match': JSON.stringify(realm.headRevisionId),
    });
    const createBoard = async (name: string) => {
      const { subject: concept } = await command<{ subject: { id: string } }>(
        '/v1/subjects',
        'POST',
        {
          type: 'skos:Concept',
          labels: { en: name },
          statements: {
            'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
          },
        },
        'moderation-author',
      );
      const { board } = await command<{ board: { id: string } }>(
        `/v1/realms/${realm.realmId}/boards`,
        'POST',
        { conceptId: concept.id, title: name, visibility: 'published' },
        'moderation-author',
      );
      return board.id;
    };
    const boardId = await createBoard('Moderation reports board');
    const unrelatedBoardId = await createBoard('Unrelated moderation board');

    const createThread = async (board: string, title: string, bodyText: string) => {
      const result = await command<{
        thread: { id: string; firstPost: { id: string } };
      }>(
        '/v1/threads',
        'POST',
        {
          boardId: board,
          subjectIds: [],
          title,
          licence: 'CC-BY-SA-4.0',
          visibility: 'published',
          body: fromPlainText(bodyText),
        },
        'moderation-author',
      );
      return result.thread;
    };
    const thread = await createThread(
      boardId,
      'Visible moderation report target',
      'This thread remains visible while Alice reports one reply.',
    );
    const unrelatedThread = await createThread(
      unrelatedBoardId,
      'Unrelated target',
      'This content is outside the moderator grant.',
    );
    const createReply = async (threadId: string, text: string) => {
      const { post } = await command<{ post: { id: string } }>(
        `/v1/threads/${threadId}/posts`,
        'POST',
        { body: fromPlainText(text), licence: 'CC-BY-SA-4.0' },
        'moderation-author',
      );
      return post.id;
    };
    const postId = await createReply(thread.id, 'A visible reply that Alice can report.');
    const unrelatedPostId = await createReply(unrelatedThread.id, 'An unrelated reply that must remain visible.');

    const boardResource = { route: routeOf(boardId)!, id: boardId };
    const postResource = { route: routeOf(postId)!, id: postId };
    await grant(identities['moderation-alice'].accountId, ['report:create'], postResource);
    await grant(identities.moderator.accountId, ['moderation:read_reports'], postResource);
    await grant(identities['appeal-moderator'].accountId, ['moderation:read_reports'], boardResource);
    await grant(identities['appeal-moderator'].accountId, ['moderation:read_reports'], postResource);
    for (const persona of ['moderator', 'appeal-moderator'] as const) {
      await grant(identities[persona].accountId, ['moderation:takedown'], postResource);
    }

    auth = await startAuthStack(stack);
    return {
      stack,
      auth,
      identities,
      boardId,
      unrelatedBoardId,
      threadId: thread.id,
      unrelatedThreadId: unrelatedThread.id,
      postId,
      unrelatedPostId,
      async addUnrelatedPosts(count) {
        for (let index = 0; index < count; index++)
          await command(
            `/v1/threads/${unrelatedThread.id}/posts`,
            'POST',
            { body: fromPlainText(`Unrelated resource ${index + 2}`), licence: 'CC-BY-SA-4.0' },
            'moderation-author',
          );
      },
      async stop() {
        await stop();
      },
    };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
