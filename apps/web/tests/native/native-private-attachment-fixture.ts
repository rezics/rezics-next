import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { threadLocation } from '../../src/threads/thread-href.ts';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { routeOf } from '../../../../services/kernel/src/route/route.ts';
import type { NativeWebStack } from './stack.ts';

type JsonObject = Record<string, unknown>;

async function call(
  stack: NativeWebStack,
  persona: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response; value: JsonObject }> {
  const headers = new Headers(extraHeaders);
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (method !== 'GET' && method !== 'HEAD') headers.set('idempotency-key', JSON.stringify(randomUUID()));
  const response = await stack.kernel(
    path,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    persona,
  );
  const text = await response.text();
  let value: JsonObject = {};
  if (text) {
    try {
      value = JSON.parse(text) as JsonObject;
    } catch {
      throw new Error(`Native fixture ${method} ${path} returned non-JSON (${response.status}): ${text}`);
    }
  }
  return { response, value };
}

async function requireOk<T extends JsonObject>(
  stack: NativeWebStack,
  persona: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const result = await call(stack, persona, method, path, body, extraHeaders);
  if (!result.response.ok)
    throw new Error(
      `Native private-attachment fixture ${method} ${path} failed (${result.response.status}): ${JSON.stringify(result.value)}`,
    );
  return result.value as T;
}

function accountId(authorization: string): string {
  const token = authorization.match(/^Bearer [^.]+\.([^.]+)\./)?.[1];
  if (!token) throw new Error('Native private-attachment persona has no bearer token');
  const claims = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { sub?: unknown };
  if (typeof claims.sub !== 'string') throw new Error('Native private-attachment persona has no subject');
  return claims.sub;
}

export type NativePrivateAttachmentFixture = {
  aliceAccountId: string;
  bobAccountId: string;
  realmId: string;
  boardId: string;
  threadId: string;
  threadTitle: string;
  threadUrl: string;
  revokeAliceRealmRead(): Promise<void>;
  restoreAliceRealmRead(): Promise<void>;
  banAlice(): Promise<void>;
};

/** Build one isolated protected discussion using only native production APIs. */
export async function createNativePrivateAttachmentFixture(
  stack: NativeWebStack,
): Promise<NativePrivateAttachmentFixture> {
  const [governor, alice, bob] = await Promise.all([
    stack.authPersona('governor'),
    stack.authPersona('alice'),
    stack.authPersona('bob'),
  ]);
  const aliceAccountId = accountId(alice.authorization);
  const bobAccountId = accountId(bob.authorization);
  const suffix = randomUUID().slice(0, 8);

  await requireOk(stack, 'governor', 'POST', '/v1/grants', {
    resource: { route: 0, id: GLOBAL_CONTEXT },
    subject: { kind: 'account', id: bobAccountId },
    actions: ['realm:create', 'space:create', 'subject:create'],
    valid: '(,)',
  });

  const { space } = await requireOk<{ space: { spaceId: string } }>(stack, 'bob', 'POST', '/v1/spaces', {
    title: `Private attachment space ${suffix}`,
    summary: 'An isolated native website attachment fixture.',
  });
  const { realm } = await requireOk<{
    realm: { realmId: string; headRevisionId: string };
  }>(stack, 'bob', 'POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: `Private attachment Realm ${suffix}`,
    summary: 'An isolated protected Realm for the native website attachment flow.',
    visibility: 'protected',
    contextId: GLOBAL_CONTEXT,
  });
  const route = routeOf(realm.realmId);
  if (route === null) throw new Error('Native fixture Realm id has no route');

  const { subject: scheme } = await requireOk<{ subject: { id: string } }>(stack, 'bob', 'POST', '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: `Private attachment scheme ${suffix}` },
  });
  const { subject: concept } = await requireOk<{ subject: { id: string } }>(stack, 'bob', 'POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: `Private attachment topic ${suffix}` },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
    },
  });
  const boardScheme = await call(
    stack,
    'bob',
    'PUT',
    `/v1/realms/${realm.realmId}/boardScheme`,
    { schemeId: scheme.id },
    { 'if-match': JSON.stringify(realm.headRevisionId) },
  );
  if (boardScheme.response.status !== 200)
    throw new Error(
      `Native fixture could not set the board scheme (${boardScheme.response.status}): ${JSON.stringify(boardScheme.value)}`,
    );

  const { board } = await requireOk<{ board: { id: string } }>(
    stack,
    'bob',
    'POST',
    `/v1/realms/${realm.realmId}/boards`,
    {
      conceptId: concept.id,
      title: `Private attachment board ${suffix}`,
      visibility: 'protected',
    },
  );

  // A protected board is required for the native Realm-ban read fence. A published
  // board is intentionally public under content's current disclosure contract.
  // Delegate grant administration to its owner, who already holds board:read, then
  // let that owner grant Alice only the read action she needs.
  await requireOk(stack, 'governor', 'POST', '/v1/grants', {
    resource: { route, id: board.id },
    subject: { kind: 'account', id: bobAccountId },
    actions: ['access:grant'],
    valid: '(,)',
  });
  await requireOk(stack, 'bob', 'POST', '/v1/grants', {
    resource: { route, id: board.id },
    subject: { kind: 'account', id: aliceAccountId },
    actions: ['board:read'],
    valid: '(,)',
  });

  // This Realm grant is independent from Alice's direct board read grant; it is restored before the final ban check.
  await requireOk(stack, 'bob', 'POST', '/v1/grants', {
    resource: { route, id: realm.realmId },
    subject: { kind: 'account', id: aliceAccountId },
    actions: ['realm:read'],
    valid: '(,)',
  });

  const threadTitle = `Private attachment thread ${suffix}`;
  const { thread } = await requireOk<{ thread: { id: string; title: string | null } }>(
    stack,
    'alice',
    'POST',
    '/v1/threads',
    {
      title: threadTitle,
      body: fromPlainText('Protected thread body.'),
      licence: 'LicenseRef-rezics-terms',
      subjectIds: [],
      boardId: board.id,
      visibility: 'published',
    },
  );

  return {
    aliceAccountId,
    bobAccountId,
    realmId: realm.realmId,
    boardId: board.id,
    threadId: thread.id,
    threadTitle,
    threadUrl: new URL(threadLocation('en', { id: thread.id, title: thread.title }), stack.web).href,
    async revokeAliceRealmRead() {
      const revoked = await call(stack, 'bob', 'POST', '/v1/grants:revoke', {
        resource: { route, id: realm.realmId },
        subject: { kind: 'account', id: aliceAccountId },
        actions: ['realm:read'],
        valid: '(,)',
      });
      if (revoked.response.status !== 200)
        throw new Error(
          `Native fixture could not revoke Alice's Realm read permission (${revoked.response.status}): ${JSON.stringify(revoked.value)}`,
        );
    },
    async restoreAliceRealmRead() {
      await requireOk(stack, 'bob', 'POST', '/v1/grants', {
        resource: { route, id: realm.realmId },
        subject: { kind: 'account', id: aliceAccountId },
        actions: ['realm:read'],
        valid: '(,)',
      });
    },
    async banAlice() {
      const ban = await call(stack, 'bob', 'PUT', `/v1/realms/${realm.realmId}/bans/${aliceAccountId}`, {
        reason: 'Native attachment authorization test ban.',
      });
      if (ban.response.status !== 200)
        throw new Error(`Native fixture could not ban Alice (${ban.response.status}): ${JSON.stringify(ban.value)}`);
    },
  };
}
