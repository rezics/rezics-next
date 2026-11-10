import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';

export type NativeEditionRequest = (
  method: 'DELETE' | 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  headers?: Readonly<Record<string, string>>,
) => Promise<Response>;

export type NativeContentEdition = {
  contentEditionId: string;
  targetSubjectId: string;
  boardId: string;
  threadId: string;
  postId: string;
  revisionId: string;
  sha256: string;
  body: ReturnType<typeof fromPlainText>;
  title: string;
};

export type NativeEditionFixture = {
  publish(input: { title: string; subjectTitle?: string; body: string }): Promise<NativeContentEdition>;
};

export type NativeEditionHome = 'showcase' | 'realm';

async function command<T>(
  request: NativeEditionRequest,
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await request(method, path, body, {
    'content-type': 'application/json',
    'idempotency-key': JSON.stringify(randomUUID()),
    ...headers,
  });
  const text = await response.text();
  if (response.status !== status) throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/**
 * Build published editions through Content's normal subject, board, thread and
 * edition commands. The edition owner created by Content supplies real sale
 * authority to the caller; this helper writes no Access or Commerce rows.
 *
 * `home: 'realm'` is the buyer sale-capture composition: a public Realm and a
 * published Realm board. Global showcase boards stay the default for historical
 * callers that only hold `board:create`.
 * The request must retain one admitted account through source authorship and
 * publication. Its Global Context grants are `subject:create` and `board:create`;
 * bootstrap the governance grantor's local showcase authority before delegating
 * them. The mounted Content runtime supplies the original publisher's current
 * consent reader for subsequent sale capture. Another seller cannot reuse this
 * publisher's edition merely by holding `offer:create`.
 */
export async function createNativeEditionFixture(
  request: NativeEditionRequest,
  options?: { home?: NativeEditionHome },
): Promise<NativeEditionFixture> {
  const suffix = randomUUID();
  const scheme = await command<{ subject: { id: string } }>(
    request,
    'POST',
    '/v1/subjects',
    { type: 'skos:ConceptScheme', labels: { en: `Native edition scheme ${suffix}` } },
    201,
  );
  const category = await command<{ subject: { id: string } }>(
    request,
    'POST',
    '/v1/subjects',
    {
      type: 'skos:Concept',
      labels: { en: `Native edition board ${suffix}` },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } }],
      },
    },
    201,
  );
  let boardId: string;
  if (options?.home === 'realm') {
    const space = await command<{ space: { spaceId: string } }>(
      request,
      'POST',
      '/v1/spaces',
      { title: `Native edition home ${suffix}` },
      201,
    );
    const realm = await command<{ realm: { realmId: string; headRevisionId: string } }>(
      request,
      'POST',
      '/v1/realms',
      {
        spaceId: space.space.spaceId,
        title: `Native edition realm ${suffix}`,
        visibility: 'public',
        contextId: GLOBAL_CONTEXT,
      },
      201,
    );
    await command(
      request,
      'PUT',
      `/v1/realms/${realm.realm.realmId}/boardScheme`,
      { schemeId: scheme.subject.id },
      200,
      { 'if-match': JSON.stringify(realm.realm.headRevisionId) },
    );
    const board = await command<{ board: { id: string } }>(
      request,
      'POST',
      `/v1/realms/${realm.realm.realmId}/boards`,
      {
        conceptId: category.subject.id,
        title: `Native edition board ${suffix}`,
        visibility: 'published',
      },
      201,
    );
    boardId = board.board.id;
  } else {
    const board = await command<{ board: { id: string } }>(
      request,
      'POST',
      '/v1/boards',
      {
        conceptId: category.subject.id,
        title: `Native edition board ${suffix}`,
        visibility: 'published',
        purpose: 'discussion',
      },
      201,
    );
    boardId = board.board.id;
  }

  return {
    async publish(input) {
      const subject = await command<{ subject: { id: string } }>(
        request,
        'POST',
        '/v1/subjects',
        {
          type: 'skos:Concept',
          labels: { en: input.subjectTitle ?? input.title },
          statements: {
            'skos:inScheme': [
              { property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } },
            ],
          },
        },
        201,
      );
      const body = fromPlainText(input.body);
      const source = await command<{
        thread: { id: string; firstPost: { id: string; revisionId: string; sha256: string } };
      }>(
        request,
        'POST',
        '/v1/threads',
        {
          title: input.title,
          body,
          licence: 'CC0-1.0',
          subjectIds: [subject.subject.id],
          boardId,
          visibility: 'protected',
        },
        201,
      );
      const edition = await command<{ editionId: string; editionRevision: string }>(
        request,
        'POST',
        '/v1/contentEditions',
        {
          postId: source.thread.firstPost.id,
          revisionId: source.thread.firstPost.revisionId,
          targetSubjectId: subject.subject.id,
        },
        201,
      );
      await command(request, 'POST', `/v1/contentEditions/${edition.editionId}:publish`, {}, 200, {
        'if-match': JSON.stringify(edition.editionRevision),
      });
      return {
        contentEditionId: edition.editionId,
        targetSubjectId: subject.subject.id,
        boardId,
        threadId: source.thread.id,
        postId: source.thread.firstPost.id,
        revisionId: source.thread.firstPost.revisionId,
        sha256: source.thread.firstPost.sha256,
        body,
        title: input.title,
      };
    },
  };
}
