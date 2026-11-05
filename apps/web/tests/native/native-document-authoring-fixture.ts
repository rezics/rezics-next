import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';

type Account = Awaited<ReturnType<NativeWebStack['authPersona']>>;
type ApiObject = Record<string, unknown>;

async function requireStatus(response: Response, status: number, label: string): Promise<ApiObject> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${label} returned ${response.status}: ${text}`);
  return text ? (JSON.parse(text) as ApiObject) : {};
}

async function write(stack: NativeWebStack, persona: string, path: string, body: unknown): Promise<ApiObject> {
  return requireStatus(
    await stack.kernel(
      path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify(body),
      },
      persona,
    ),
    201,
    `POST ${path}`,
  );
}

export type NativeDocumentAuthoringFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  boardId: string;
  alice: Account;
  aliceHandle: string;
  bob: Account;
  bobHandle: string;
  growthWriters: { persona: string; accountId: string }[];
  close(): Promise<void>;
};

/** Create a published discussion board and its posting grant through native production APIs. */
export async function createNativeDocumentAuthoringFixture(): Promise<NativeDocumentAuthoringFixture> {
  const stack = await startNativeWebStack();
  let auth: NativeAuthStack | undefined;
  try {
    auth = await startAuthStack(stack);
    const [alice, bob, governor] = await Promise.all([
      stack.authPersona('alice'),
      stack.authPersona('bob'),
      stack.authPersona('governor'),
    ]);
    const editor = await stack.authPersona('editor');

    const schemeResponse = await write(stack, 'editor', '/v1/subjects', {
      type: 'skos:ConceptScheme',
      labels: { en: 'Native document authoring scheme' },
    });
    const scheme = schemeResponse.subject as { id: string };
    if (!scheme?.id) throw new Error('Native scheme response did not contain its subject id');

    const conceptResponse = await write(stack, 'editor', '/v1/subjects', {
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

    const spaceResponse = await write(stack, 'governor', '/v1/spaces', {
      title: 'Native document authoring space',
    });
    const space = spaceResponse.space as { spaceId: string };
    if (!space?.spaceId) throw new Error('Native space response did not contain its space id');

    const realmResponse = await write(stack, 'governor', '/v1/realms', {
      spaceId: space.spaceId,
      title: 'Native document authoring realm',
      visibility: 'public',
      contextId: globalContext,
    });
    const realm = realmResponse.realm as { realmId: string; headRevisionId: string };
    if (!realm?.realmId || !realm.headRevisionId) throw new Error('Native realm response was incomplete');

    const schemeUpdate = await stack.kernel(
      `/v1/realms/${realm.realmId}/boardScheme`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
          'if-match': JSON.stringify(realm.headRevisionId),
        },
        body: JSON.stringify({ schemeId: scheme.id }),
      },
      'governor',
    );
    const updatedRealmBody = await requireStatus(schemeUpdate, 200, 'PUT /v1/realms/:id/boardScheme');
    const updatedRealm = updatedRealmBody.realm as { headRevisionId: string };
    if (!updatedRealm?.headRevisionId) throw new Error('Native realm scheme response was incomplete');

    const boardResponse = await write(stack, 'governor', `/v1/realms/${realm.realmId}/boards`, {
      conceptId: concept.id,
      title: 'Native document authoring',
      visibility: 'published',
    });
    const board = boardResponse.board as { id: string; route: number };
    if (!board?.id || !Number.isInteger(board.route)) throw new Error('Native board response was incomplete');
    const growthWriters = [
      { persona: 'alice', accountId: alice.accountId },
      { persona: 'bob', accountId: bob.accountId },
      { persona: 'editor', accountId: editor.accountId },
      { persona: 'governor', accountId: governor.accountId },
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
      boardId: board.id,
      alice,
      aliceHandle: aliceAccount.handle,
      bob,
      bobHandle: bobAccount.handle,
      growthWriters,
      async close() {
        await auth?.stop();
        await stack.stop();
      },
    };
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop().catch(() => {});
    throw error;
  }
}
