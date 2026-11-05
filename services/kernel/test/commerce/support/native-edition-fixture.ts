import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';

export type NativeEditionRequest = (
  method: 'DELETE' | 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  headers?: Readonly<Record<string, string>>,
) => Promise<Response>;

export type NativeContentEdition = {
  contentEditionId: string;
  targetSubjectId: string;
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
 */
export async function createNativeEditionFixture(request: NativeEditionRequest): Promise<NativeEditionFixture> {
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
          boardId: board.board.id,
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
