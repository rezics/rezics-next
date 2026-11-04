import { fromPlainText } from '@rezics/document';
import { compileViewerActionBindings } from '../../../src/access/viewer-actions.ts';
import { contentViewerActionResources } from '../../../src/content/viewer-actions.ts';
import type { ReadingPageDependencies } from '../../../src/content/reading-page.ts';
import { openApiDocument } from '../../../src/http/openapi.ts';
import { routeOf } from '../../../src/route/route.ts';
import { createReviewLifecycleFixture } from '../review-native-lifecycle-fixture.ts';

/** Ordinary signed accounts, production Kernel/Access and isolated PostgreSQL; no permission substitutes. */
export async function createThreadReadingPageFixture() {
  const f = await createReviewLifecycleFixture();
  const { system } = f;
  let commandTime = Date.now();
  const setTime = async (instant: number) => {
    commandTime = instant;
    await system.clock.setCommandTime(new Date(instant).toISOString());
  };
  const checked = async (method: string, path: string, options: Parameters<typeof f.call>[2] = {}, status = 201) => {
    const result = await f.call(method, path, options);
    if (result.response.status !== status)
      throw new Error(`${method} ${path}: expected ${status}, received ${result.response.status} ${result.text}`);
    return result.value;
  };
  const guestSecurity = new Map<string, 'anonymous' | 'authenticated' | 'unknown'>();
  for (const path of Object.values(openApiDocument(system.kernel).paths)) {
    for (const operation of Object.values(path ?? {})) {
      if (typeof operation !== 'object' || !operation || !('operationId' in operation)) continue;
      const { operationId, security } = operation;
      if (typeof operationId !== 'string') continue;
      guestSecurity.set(
        operationId,
        !Array.isArray(security)
          ? 'unknown'
          : security.some((requirement) => Object.keys(requirement).length === 0)
            ? 'anonymous'
            : security.length > 0
              ? 'authenticated'
              : 'unknown',
      );
    }
  }
  const dependencies: ReadingPageDependencies = {
    pool: system.database.pool,
    access: system.access,
    tokens: system.tokenKeys,
    routeKey: system.routeKey,
    clock: () => new Date(commandTime),
    viewerActionRuntime: () => ({
      access: system.access,
      resources: contentViewerActionResources,
      bindings: compileViewerActionBindings(system.kernel.routes),
      guestSecurity,
      clock: () => new Date(commandTime),
    }),
  };
  const thread = async () =>
    (
      await checked('POST', '/v1/threads', {
        bearer: f.author.bearer,
        body: {
          kind: 'review',
          title: 'Native reading journey',
          body: fromPlainText('Exact opening'),
          licence: 'CC0-1.0',
          boardId: f.boardId,
          subjectIds: [f.subjectId],
          visibility: 'published',
        },
      })
    ).thread;
  const post = async (threadId: string, text: string, parentId?: string, visibility = 'published') => {
    await setTime(commandTime + 1);
    return (
      await checked('POST', `/v1/threads/${threadId}/posts`, {
        bearer: f.author.bearer,
        body: {
          body: fromPlainText(text),
          licence: 'CC0-1.0',
          subjectIds: [],
          visibility,
          ...(parentId ? { parentId } : {}),
        },
      })
    ).post;
  };
  const revise = async (postId: string, revisionId: string, text: string) =>
    (
      await checked(
        'POST',
        `/v1/posts/${postId}/revisions`,
        {
          bearer: f.author.bearer,
          ifMatch: revisionId,
          body: { body: fromPlainText(text), licence: 'CC0-1.0', subjectIds: [] },
        },
        200,
      )
    ).post;
  const grant = async (id: string, accountId: string, actions: string[]) => {
    await checked('POST', '/v1/grants', {
      bearer: f.governance.bearer,
      body: {
        resource: { route: routeOf(id), id },
        subject: { kind: 'account', id: accountId },
        actions,
        valid: '(,)',
      },
    });
  };
  const page = (threadId: string, bearer?: string, cursor?: string) =>
    f.call('GET', `/v1/threads/${threadId}/reading-page${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
      bearer,
    });
  return { ...f, checked, dependencies, setTime, thread, post, revise, grant, page };
}
