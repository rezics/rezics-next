import { Elysia, t } from 'elysia';
import { documentSnapshotSchema } from '../api-document.ts';
import { readId } from '../modules/work/read-contract.ts';
import { languageTagSchema } from '../modules/display-language/schema.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { authorPost } from '../modules/post/author.ts';
import { commandError, problem } from './problems.ts';
import { writeProblems } from '../api-responses.ts';

export const openApiOperations = {
  '/v1/posts': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
} as const;
const result = t.Object({ post: readId, variantId: t.String(), revisionId: t.String(), byteDigest: t.String(),
  author: readId, replayed: t.Boolean() }, { additionalProperties: false });
export function authoredPostRoutes(deps: MainWorkDependencies) {
  return new Elysia().post('/v1/posts', {
    body: t.Object({ profile: t.Literal('authored-post-v1'),
      title: t.Object({ value: t.String({ minLength: 1, maxLength: 200 }), language: languageTagSchema(35) }),
      language: languageTagSchema(35), document: documentSnapshotSchema, actingSubject: readId }, { additionalProperties: false }),
    response: { 200: result, 201: result, ...writeProblems },
  }, async ({ request, body }) => {
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
    try {
      const created = await authorPost(deps, request, body, key);
      return Response.json(created, { status: created.replayed ? 200 : 201, headers: { 'cache-control': 'private, no-store' } });
    } catch (error) { return commandError(error); }
  });
}
