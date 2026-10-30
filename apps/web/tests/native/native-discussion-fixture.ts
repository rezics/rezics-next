import { fromPlainText } from '@rezics/document';
import { routeOf } from '../../../../services/kernel/src/route/route.ts';
import type { NativeWebStack } from './stack.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';

export type NativeDiscussionThread = { id: string; title: string; authorId: string; firstPost: { id: string } };
export type NativeDiscussionBoard = {
  id: string;
  title: string;
  realmId: string | null;
  purpose: 'discussion' | 'reviews';
};
export type NativeDiscussionFixture = {
  aliceId: string;
  bobId: string;
  publicBoard: NativeDiscussionBoard;
  reviewBoard: NativeDiscussionBoard;
  banBoard: NativeDiscussionBoard;
  removalBoard: NativeDiscussionBoard;
  reviewSubjectId: string;
  banRealmId: string;
  removalRealmId: string;
  publicThreads: NativeDiscussionThread[];
  banThread: NativeDiscussionThread;
  removalThread: NativeDiscussionThread;
  createThread(
    board: NativeDiscussionBoard,
    title: string,
    body: string,
    persona?: string,
  ): Promise<NativeDiscussionThread>;
  createReply(
    thread: NativeDiscussionThread,
    body: string,
    persona?: string,
  ): Promise<{ id: string; authorId: string }>;
  grant(resourceId: string, accountId: string, actions: string[], persona?: string): Promise<void>;
  addMember(realmId: string, accountId: string, persona?: string): Promise<void>;
  createUnrelatedSubjects(count: number): Promise<void>;
};

async function checked<T>(response: Response, status: number, label: string): Promise<T> {
  const body = await response
    .clone()
    .json()
    .catch(async () => await response.text());
  if (response.status !== status)
    throw new Error(`${label}: expected ${status}, received ${response.status}: ${JSON.stringify(body)}`);
  return body as T;
}

function headers(key: string | undefined = crypto.randomUUID(), extra: Record<string, string> = {}) {
  return { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key), ...extra };
}

export async function createNativeDiscussionFixture(stack: NativeWebStack): Promise<NativeDiscussionFixture> {
  const [{ accountId: aliceId }, { accountId: bobId }] = await Promise.all([
    stack.authPersona('alice'),
    stack.authPersona('bob'),
  ]);

  async function grant(resourceId: string, accountId: string, actions: string[], persona = 'alice') {
    const route = routeOf(resourceId);
    if (route === null) throw new Error(`Cannot grant access to unrouted resource ${resourceId}`);
    await checked(
      await stack.kernel(
        '/v1/grants',
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            resource: { route, id: resourceId },
            subject: { kind: 'account', id: accountId },
            actions,
            valid: '(,)',
          }),
        },
        persona,
      ),
      201,
      `grant ${actions.join(',')} on ${resourceId}`,
    );
  }

  async function trusted(accountId: string) {
    const key = crypto.randomUUID();
    await checked(
      await stack.kernel(
        `/v1/accounts/${encodeURIComponent(accountId)}:setRateTier`,
        {
          method: 'POST',
          headers: headers(key),
          body: JSON.stringify({ key, tier: 'trusted' }),
        },
        'governor',
      ),
      200,
      `set trusted rate tier for ${accountId}`,
    );
  }

  await grant(globalContext, aliceId, ['space:create', 'realm:create', 'subject:create'], 'governor');
  await Promise.all([trusted(aliceId), trusted(bobId)]);

  async function createSubject(type: string, label: string, schemeId?: string): Promise<string> {
    const response = await checked<{ subject: { id: string } }>(
      await stack.kernel(
        '/v1/subjects',
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            type,
            labels: { en: label },
            ...(schemeId
              ? {
                  statements: {
                    'skos:inScheme': [
                      { property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } },
                    ],
                  },
                }
              : {}),
          }),
        },
        'alice',
      ),
      201,
      `create ${type} subject ${label}`,
    );
    return response.subject.id;
  }

  async function createRealm(title: string, visibility: 'public' | 'protected') {
    const { space } = await checked<{ space: { spaceId: string } }>(
      await stack.kernel(
        '/v1/spaces',
        { method: 'POST', headers: headers(), body: JSON.stringify({ title }) },
        'alice',
      ),
      201,
      `create Space ${title}`,
    );
    const { realm } = await checked<{
      realm: { realmId: string; headRevisionId: string; boardSchemeId: string | null };
    }>(
      await stack.kernel(
        '/v1/realms',
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ spaceId: space.spaceId, title, visibility, contextId: globalContext }),
        },
        'alice',
      ),
      201,
      `create ${visibility} Realm ${title}`,
    );
    const schemeId = await createSubject('skos:ConceptScheme', `${title} board scheme`);
    await checked(
      await stack.kernel(
        `/v1/realms/${realm.realmId}/boardScheme`,
        {
          method: 'PUT',
          headers: headers(crypto.randomUUID(), { 'if-match': JSON.stringify(realm.headRevisionId) }),
          body: JSON.stringify({ schemeId }),
        },
        'alice',
      ),
      200,
      `set ${title} board scheme`,
    );
    return { realmId: realm.realmId, schemeId };
  }

  async function createBoard(
    realmId: string,
    schemeId: string,
    title: string,
    purpose: 'discussion' | 'reviews' = 'discussion',
  ): Promise<NativeDiscussionBoard> {
    const conceptId = await createSubject('skos:Concept', `${title} concept`, schemeId);
    const { board } = await checked<{ board: NativeDiscussionBoard }>(
      await stack.kernel(
        `/v1/realms/${realmId}/boards`,
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ conceptId, title, visibility: 'published', purpose }),
        },
        'alice',
      ),
      201,
      `create ${purpose} board ${title}`,
    );
    return board;
  }

  async function createThread(board: NativeDiscussionBoard, title: string, body: string, persona = 'alice') {
    const { thread } = await checked<{ thread: NativeDiscussionThread }>(
      await stack.kernel(
        '/v1/threads',
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            boardId: board.id,
            title,
            body: fromPlainText(body),
            licence: 'CC-BY-4.0',
            subjectIds: [],
            visibility: 'published',
            ...(board.purpose === 'reviews' ? { kind: 'review', subjectIds: [reviewSubjectId] } : {}),
          }),
        },
        persona,
      ),
      201,
      `create thread ${title}`,
    );
    return thread;
  }

  async function createReply(thread: NativeDiscussionThread, body: string, persona = 'alice') {
    const { post } = await checked<{ post: { id: string; authorId: string } }>(
      await stack.kernel(
        `/v1/threads/${thread.id}/posts`,
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ body: fromPlainText(body), licence: 'CC-BY-4.0', subjectIds: [] }),
        },
        persona,
      ),
      201,
      `create reply to ${thread.id}`,
    );
    return post;
  }

  async function addMember(realmId: string, accountId: string, persona = 'alice') {
    await checked(
      await stack.kernel(
        `/v1/realms/${realmId}/members`,
        { method: 'POST', headers: headers(), body: JSON.stringify({ accountId }) },
        persona,
      ),
      202,
      `add member ${accountId} to ${realmId}`,
    );
  }

  async function createUnrelatedSubjects(count: number) {
    for (let index = 0; index < count; index++)
      await createSubject('schema:Book', `Unrelated growth subject ${index + 1}`);
  }

  const publicContext = await createRealm('Native public discussion', 'public');
  const publicBoard = await createBoard(publicContext.realmId, publicContext.schemeId, 'Open board');
  const reviewBoard = await createBoard(publicContext.realmId, publicContext.schemeId, 'Subject reviews', 'reviews');
  const reviewSubjectId = await createSubject('schema:Book', 'Native review subject');
  const publicThreads: NativeDiscussionThread[] = [];
  for (let index = 1; index <= 21; index++) {
    const ordinal = String(index).padStart(2, '0');
    const thread = await createThread(publicBoard, `Native board thread ${ordinal}`, `Opening post ${ordinal}`);
    publicThreads.push(thread);
  }
  await createReply(publicThreads[0]!, 'Attributed reply by Bob', 'bob');

  const banContext = await createRealm('Native ban Realm', 'protected');
  const banBoard = await createBoard(banContext.realmId, banContext.schemeId, 'Protected ban board');
  const banThread = await createThread(banBoard, 'Protected ban target', 'Protected opening post');

  const removalContext = await createRealm('Native membership Realm', 'protected');
  const removalBoard = await createBoard(removalContext.realmId, removalContext.schemeId, 'Protected membership board');
  const removalThread = await createThread(removalBoard, 'Protected membership target', 'Membership opening post');

  return {
    aliceId,
    bobId,
    publicBoard,
    reviewBoard,
    banBoard,
    removalBoard,
    reviewSubjectId,
    banRealmId: banContext.realmId,
    removalRealmId: removalContext.realmId,
    publicThreads,
    banThread,
    removalThread,
    createThread,
    createReply,
    grant,
    addMember,
    createUnrelatedSubjects,
  };
}
