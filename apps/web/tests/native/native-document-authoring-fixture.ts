import { fromPlainText } from '@rezics/document';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const boardOwner = 'document-board-owner';
const creationActions = ['space:create', 'realm:create', 'subject:create'];
const boardOwnerScopes = [
  ...creationActions,
  'space:manage',
  'context:read',
  'realm:read',
  'realm:manage',
  'realm:participate',
  'subject:read',
  'board:create',
  'board:read',
];

type Account = Awaited<ReturnType<NativeWebStack['authPersona']>>;
type ApiObject = Record<string, unknown>;

async function requireStatus(response: Response, status: number, label: string): Promise<ApiObject> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${label} returned ${response.status}: ${text}`);
  return text ? (JSON.parse(text) as ApiObject) : {};
}

async function write(
  stack: NativeWebStack,
  actor: string | Account,
  path: string,
  body: unknown,
  {
    method = 'POST',
    ifMatch,
    status = method === 'POST' ? 201 : 200,
  }: { method?: 'POST' | 'PUT'; ifMatch?: string; status?: number } = {},
): Promise<ApiObject> {
  const headers = new Headers({
    'content-type': 'application/json',
    'idempotency-key': JSON.stringify(crypto.randomUUID()),
  });
  if (ifMatch !== undefined) headers.set('if-match', JSON.stringify(ifMatch));
  if (typeof actor !== 'string') headers.set('authorization', actor.authorization);
  return requireStatus(
    await stack.kernel(
      path,
      { method, headers, body: JSON.stringify(body) },
      typeof actor === 'string' ? actor : undefined,
    ),
    status,
    `${method} ${path}`,
  );
}

export type NativeDocumentAuthoringFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  spaceId: string;
  realmId: string;
  boardId: string;
  alice: Account;
  aliceHandle: string;
  bob: Account;
  bobHandle: string;
  growthWriters: { persona: string; accountId: string }[];
};

export async function seedDocumentHistory(fixture: NativeDocumentAuthoringFixture) {
  const { stack, boardId } = fixture;
  const licence = 'LicenseRef-rezics-terms';
  const originalText = 'Unicode 雪 café authored whitespace  bold';
  const created = await write(stack, 'alice', '/v1/threads', {
    title: 'Unicode document round trip',
    body: fromPlainText(originalText, 'blocks'),
    licence,
    subjectIds: [],
    boardId,
    visibility: 'published',
  });
  const thread = created.thread as { id: string; firstPost: { id: string; revisionId: string } };
  const { id: postId, revisionId } = thread.firstPost;
  await write(
    stack,
    'alice',
    `/v1/posts/${postId}/revisions`,
    { body: fromPlainText(`${originalText}\nEdited in the served editor`, 'blocks'), licence, mediaIds: [] },
    { ifMatch: revisionId, status: 200 },
  );
  return { threadId: thread.id, postId };
}

/** Create a published discussion board and its posting grant through native production APIs. */
export async function createNativeDocumentAuthoringFixture(): Promise<NativeDocumentAuthoringFixture> {
  const stack = await startNativeWebStack();
  const auth = await startAuthStack(stack);
  const [alice, bob, owner, editor] = await Promise.all([
    stack.authPersona('alice'),
    stack.authPersona('bob'),
    stack.authPersona(boardOwner),
    stack.authPersona('editor'),
  ]);

  await write(stack, 'governor', '/v1/grants', {
    resource: { route: 0, id: globalContext },
    subject: { kind: 'account', id: owner.accountId },
    actions: creationActions,
    valid: '(,)',
  });
  // The ordinary Space and Realm owner roles authorize the remaining fixture writes.
  const creator = await stack.authPersona(boardOwner, boardOwnerScopes);

  const schemeResponse = await write(stack, creator, '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Native document authoring scheme' },
  });
  const scheme = schemeResponse.subject as { id: string };
  if (!scheme?.id) throw new Error('Native scheme response did not contain its subject id');

  const conceptResponse = await write(stack, creator, '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Native document authoring' },
    statements: {
      'skos:inScheme': [
        {
          property: { id: 'skos:inScheme' },
          value: { type: 'value', content: scheme.id },
        },
      ],
    },
  });
  const concept = conceptResponse.subject as { id: string };
  if (!concept?.id) throw new Error('Native concept response did not contain its subject id');

  const spaceResponse = await write(stack, creator, '/v1/spaces', {
    title: 'Native document authoring space',
  });
  const space = spaceResponse.space as { spaceId: string };
  if (!space?.spaceId) throw new Error('Native space response did not contain its space id');

  const realmResponse = await write(stack, creator, '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Native document authoring realm',
    visibility: 'public',
    contextId: globalContext,
  });
  const realm = realmResponse.realm as { realmId: string; headRevisionId: string };
  if (!realm?.realmId || !realm.headRevisionId) throw new Error('Native realm response was incomplete');

  const updatedRealmBody = await write(
    stack,
    creator,
    `/v1/realms/${realm.realmId}/boardScheme`,
    { schemeId: scheme.id },
    {
      method: 'PUT',
      ifMatch: realm.headRevisionId,
    },
  );
  const updatedRealm = updatedRealmBody.realm as { headRevisionId: string };
  if (!updatedRealm?.headRevisionId) throw new Error('Native realm scheme response was incomplete');

  const boardResponse = await write(stack, creator, `/v1/realms/${realm.realmId}/boards`, {
    conceptId: concept.id,
    title: 'Native document authoring',
    visibility: 'published',
    purpose: 'discussion',
  });
  const board = boardResponse.board as {
    id: string;
    route: number;
    realmId: string;
    visibility: string;
    purpose: string;
  };
  if (!board?.id || !Number.isInteger(board.route)) throw new Error('Native board response was incomplete');
  if (board.realmId !== realm.realmId || board.visibility !== 'published' || board.purpose !== 'discussion')
    throw new Error('Native fixture did not create a published discussion board in the requested Realm');
  const growthWriters = [
    { persona: 'alice', accountId: alice.accountId },
    { persona: 'bob', accountId: bob.accountId },
    { persona: 'editor', accountId: editor.accountId },
    { persona: boardOwner, accountId: owner.accountId },
  ];

  const accountsResponse = await stack.kernel(
    `/v1/accounts?ids=${encodeURIComponent(`${alice.accountId},${bob.accountId}`)}`,
    undefined,
    'editor',
  );
  const accountBody = await requireStatus(accountsResponse, 200, 'GET /v1/accounts');
  const accountList = accountBody.accounts as { id: string; handle: string | null }[] | undefined;
  const aliceAccount = accountList?.find((account) => account.id === alice.accountId);
  const bobAccount = accountList?.find((account) => account.id === bob.accountId);
  if (!aliceAccount?.handle || !bobAccount?.handle)
    throw new Error("Native account read did not expose Alice and Bob's active public handles");

  return {
    stack,
    auth,
    spaceId: space.spaceId,
    realmId: realm.realmId,
    boardId: board.id,
    alice,
    aliceHandle: aliceAccount.handle,
    bob,
    bobHandle: bobAccount.handle,
    growthWriters,
  };
}
