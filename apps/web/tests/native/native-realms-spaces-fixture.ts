import { bundledDigest } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { routeOf } from '../../../../services/kernel/src/route/route.ts';
import type { NativeWebStack } from './stack.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';

export type NativeRealmFixture = {
  spaceId: string;
  address: string;
  spaceTitle: string;
  realmId: string;
  realmTitle: string;
  boardId?: string;
  boardTitle?: string;
  threadId?: string;
  threadTitle?: string;
  subjectId?: string;
  subjectTitle?: string;
};

export type NativeRealmsSpacesFixture = {
  ownerId: string;
  aliceId: string;
  bobId: string;
  publicRealm: NativeRealmFixture;
  protectedRealm: NativeRealmFixture;
  emptyRealm: NativeRealmFixture;
  addUnrelatedSubjects(count: number): Promise<unknown>;
};

type JsonResponse = { response: Response; body: Record<string, any> };

function commandHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return { ...headers, 'idempotency-key': JSON.stringify(crypto.randomUUID()) };
}

async function call(
  stack: NativeWebStack,
  actor: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const requestHeaders = method === 'GET' ? headers : commandHeaders(headers);
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    const response = await stack.kernel(
      path,
      {
        method,
        headers: requestHeaders,
        ...(requestBody === undefined ? {} : { body: requestBody }),
      },
      actor,
    );
    if (!response.ok && attempt < 3) {
      const problem = (await response
        .clone()
        .json()
        .catch(() => null)) as { retryable?: unknown; effect_status?: unknown; request_id?: unknown } | null;
      if (problem?.retryable === true && problem.effect_status === 'not_applied') {
        console.info(
          `native-community-fixture-retry: route=${path} status=${response.status} request_id=${String(problem.request_id)} retry=${attempt + 1}`,
        );
        await response.body?.cancel();
        await Bun.sleep(1000 * 2 ** attempt);
        continue;
      }
    }
    const text = await response.text();
    let parsed: Record<string, any> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, any>) : {};
    } catch {
      parsed = { raw: text };
    }
    return { response, body: parsed };
  }
}

async function requireStatus(
  stack: NativeWebStack,
  actor: string,
  method: string,
  path: string,
  body: unknown,
  expected: number,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const result = await call(stack, actor, method, path, body, headers);
  if (result.response.status !== expected)
    throw new Error(
      `Native fixture ${method} ${path} expected ${expected}, received ${result.response.status}: ${JSON.stringify(result.body)}`,
    );
  return result;
}

async function createCommunity(
  stack: NativeWebStack,
  owner: string,
  options: {
    address: string;
    spaceTitle: string;
    realmTitle: string;
    visibility: 'public' | 'protected';
    board?: boolean;
  },
): Promise<NativeRealmFixture> {
  const createdSpace = await requireStatus(
    stack,
    owner,
    'POST',
    '/v1/spaces',
    { title: options.spaceTitle, summary: `Native Space for ${options.realmTitle}` },
    201,
  );
  const space = createdSpace.body.space as { spaceId: string; title: string; headRevisionId: string };
  if (!space?.spaceId || !createdSpace.response.headers.get('etag'))
    throw new Error('Native Space creation did not return its native identity and ETag');

  const claimedAddress = await call(
    stack,
    owner,
    'PUT',
    `/v1/spaces/${space.spaceId}/address`,
    {
      address: options.address,
    },
    { 'if-match': createdSpace.response.headers.get('etag')! },
  );
  if (![200, 202].includes(claimedAddress.response.status))
    throw new Error(
      `Native fixture PUT /v1/spaces/${space.spaceId}/address expected 200 or 202, received ${claimedAddress.response.status}: ${JSON.stringify(claimedAddress.body)}`,
    );
  await waitForAddress(stack, options.address, space.spaceId);

  const realmCreated = await requireStatus(
    stack,
    owner,
    'POST',
    '/v1/realms',
    {
      spaceId: space.spaceId,
      title: options.realmTitle,
      summary: `Native Realm for ${options.spaceTitle}`,
      visibility: options.visibility,
      contextId: globalContext,
    },
    201,
  );
  const realm = realmCreated.body.realm as { realmId: string; headRevisionId: string };
  if (!realm?.realmId) throw new Error('Native Realm creation did not return its native identity');

  const fixture: NativeRealmFixture = {
    spaceId: space.spaceId,
    address: options.address,
    spaceTitle: options.spaceTitle,
    realmId: realm.realmId,
    realmTitle: options.realmTitle,
  };
  if (!options.board) return fixture;
  const boardContext = options.realmTitle.slice(0, 160);

  const schemeRead = await requireStatus(
    stack,
    owner,
    'POST',
    '/v1/subjects',
    { type: 'skos:ConceptScheme', labels: { en: `${boardContext} board scheme` } },
    201,
  );
  const schemeId = schemeRead.body.subject?.id as string | undefined;
  if (!schemeId) throw new Error('Native board scheme creation did not return its native subject ID');

  const schemeUpdate = await requireStatus(
    stack,
    owner,
    'PUT',
    `/v1/realms/${realm.realmId}/boardScheme`,
    { schemeId },
    200,
    { 'if-match': JSON.stringify(realm.headRevisionId) },
  );
  const boardRealm = schemeUpdate.body.realm as { headRevisionId?: string };
  if (!boardRealm?.headRevisionId) throw new Error('Native board scheme update did not return the current Realm head');

  const conceptRead = await requireStatus(
    stack,
    owner,
    'POST',
    '/v1/subjects',
    {
      type: 'skos:Concept',
      labels: { en: `${boardContext} board concept` },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
      },
    },
    201,
  );
  const conceptId = conceptRead.body.subject?.id as string | undefined;
  if (!conceptId) throw new Error('Native board concept creation did not return its native subject ID');

  const boardTitle = `${boardContext} discussion board`;
  const boardRead = await requireStatus(
    stack,
    owner,
    'POST',
    `/v1/realms/${realm.realmId}/boards`,
    { conceptId, title: boardTitle, visibility: 'published' },
    201,
  );
  const boardId = boardRead.body.board?.id as string | undefined;
  if (!boardId) throw new Error('Native board creation did not return its native ID');

  const subjectTitle = `${boardContext} published guide`;
  const subjectRead = await requireStatus(
    stack,
    owner,
    'POST',
    '/v1/subjects',
    { type: 'schema:Book', labels: { en: subjectTitle, 'zh-Hans': `${boardContext} 已发布指南` } },
    201,
  );
  const subjectId = subjectRead.body.subject?.id as string | undefined;
  if (!subjectId) throw new Error('Native subject creation did not return its native ID');
  await requireStatus(stack, owner, 'POST', `/v1/realms/${realm.realmId}/publications`, { subjectId }, 201);

  const threadTitle = `${boardContext} welcome thread`;
  const threadRead = await requireStatus(
    stack,
    owner,
    'POST',
    '/v1/threads',
    {
      boardId,
      title: threadTitle,
      body: fromPlainText('A native thread for the Realm page navigation receipt.'),
      licence: 'MIT',
      subjectIds: [],
      visibility: 'published',
    },
    201,
  );
  const threadId = threadRead.body.thread?.id as string | undefined;
  if (!threadId) throw new Error('Native thread creation did not return its native ID');

  return { ...fixture, boardId, boardTitle, subjectId, subjectTitle, threadId, threadTitle };
}

export async function createNativeRealmsSpacesFixture(stack: NativeWebStack): Promise<NativeRealmsSpacesFixture> {
  const active = await call(stack, 'anonymous', 'GET', '/v1/definitions/active');
  if (active.response.status !== 200 || active.body.digest !== bundledDigest)
    throw new Error(
      `Native stack must serve the activated bundled definition ${bundledDigest}; received ${active.response.status} ${String(active.body.digest)}`,
    );

  const [owner, alice, bob] = await Promise.all([
    stack.authPersona('native-community-owner'),
    stack.authPersona('alice'),
    stack.authPersona('bob'),
  ]);
  const creationGrant = {
    resource: { route: 0, id: globalContext },
    subject: { kind: 'account', id: owner.accountId },
    actions: ['space:create', 'realm:create', 'subject:create'],
    valid: '(,)',
  };
  await requireStatus(stack, 'governor', 'POST', '/v1/grants', creationGrant, 201);

  const longSegment = 'A long community name for patient readers, careful notes, and shared discoveries';
  const longSpaceTitle = Array.from({ length: 4 }, () => longSegment).join(' · ');
  const longRealmTitle = Array.from({ length: 3 }, () => longSegment).join(' · ');
  const publicRealm = await createCommunity(stack, 'native-community-owner', {
    address: `native-open-${crypto.randomUUID().slice(0, 8)}`,
    spaceTitle: longSpaceTitle,
    realmTitle: longRealmTitle,
    visibility: 'public',
    board: true,
  });
  const protectedRealm = await createCommunity(stack, 'native-community-owner', {
    address: `native-protected-${crypto.randomUUID().slice(0, 8)}`,
    spaceTitle: 'Invitation-only Space',
    realmTitle: 'Invitation-only Realm',
    visibility: 'protected',
    board: true,
  });
  const emptyRealm = await createCommunity(stack, 'native-community-owner', {
    address: `native-empty-${crypto.randomUUID().slice(0, 8)}`,
    spaceTitle: 'Quiet Space',
    realmTitle: 'Quiet Realm',
    visibility: 'public',
    board: false,
  });

  return {
    ownerId: owner.accountId,
    aliceId: alice.accountId,
    bobId: bob.accountId,
    publicRealm,
    protectedRealm,
    emptyRealm,
    async addUnrelatedSubjects(count) {
      if (!Number.isInteger(count) || count < 0 || count > 63)
        throw new RangeError('Unrelated subject count must be between 0 and 63');
      if (count === 0) return [];
      const created = [];
      for (let index = 0; index < count; index++) {
        const result = await call(stack, 'native-community-owner', 'POST', '/v1/subjects', {
          type: 'schema:Book',
          labels: { en: `Unrelated catalogue entry ${index + 1}` },
        });
        if (result.response.status !== 201 || !result.body.subject?.id)
          throw new Error(
            `Native fixture POST /v1/subjects expected 201, received ${result.response.status}: ${JSON.stringify(result.body)}`,
          );
        created.push(result.body.subject);
      }
      return created;
    },
  };
}

async function waitForAddress(stack: NativeWebStack, address: string, spaceId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const result = await call(stack, 'anonymous', 'GET', `/v1/spaceAddresses/${address}`);
    lastStatus = result.response.status;
    if (lastStatus === 200 && result.body.spaceId === spaceId) return;
    await Bun.sleep(100);
  }
  throw new Error(`Native Space address ${address} did not become active within 30000ms (last status ${lastStatus})`);
}

export async function requestNativeCommunity(
  stack: NativeWebStack,
  actor: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: Record<string, any> }> {
  const result = await call(stack, actor, method, path, body, headers);
  return { status: result.response.status, data: result.body };
}

export async function waitForRealmMembership(
  stack: NativeWebStack,
  realmId: string,
  persona: string,
  expected: 'member' | 'none' | 'banned',
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: { status: number; body: Record<string, unknown> } | undefined;
  while (Date.now() < deadline) {
    const result = await call(stack, persona, 'GET', `/v1/realms/${realmId}/members/me`);
    last = { status: result.response.status, body: result.body };
    if (expected === 'member' && result.response.status === 200 && result.body.state === 'member') return result.body;
    if (expected !== 'member' && (result.response.status === 404 || result.body.state === expected)) return result.body;
    await Bun.sleep(100);
  }
  throw new Error(
    `Native ${persona} membership did not reach ${expected} for Realm ${realmId} within ${timeoutMs}ms: ${JSON.stringify(last)}`,
  );
}

export function nativeRouteOf(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new Error(`Native Realm identity has no route: ${id}`);
  return route;
}
