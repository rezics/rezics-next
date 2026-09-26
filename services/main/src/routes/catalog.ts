import { Elysia, t } from 'elysia';
import { contentDraftWriteResult, writeProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import { catalogDescriptionVariantId, patchCatalogDescription } from '../modules/catalog/commands.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const resourceId = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const nativeId = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const languageTag = t.String({ pattern: '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$', maxLength: 100 });

export const openApiOperations = {
  '/v1/catalog/resources/{resource}/descriptions': { patch: { bearer: true, idempotencyKey: true } },
} as const;

/** Organization descriptions are Content drafts; publication uses the existing Content route. */
export function catalogRoutes(work: MainWorkDependencies) {
  return new Elysia().patch('/v1/catalog/resources/:resource/descriptions', {
    params: t.Object({ resource: resourceId }),
    body: t.Object({ profile: t.Literal('catalog-description-v1'),
      language: t.Object({ kind: t.Literal('tag'), tag: languageTag, originalTag: languageTag },
      { additionalProperties: false }),
      direction: t.Union([t.Literal('ltr'), t.Literal('rtl'), t.Literal('none')]),
      expectedHead: t.Nullable(resourceId),
      description: t.String({ minLength: 1, maxLength: 16_384,
        pattern: '^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]+$' }),
      actingSubject: nativeId,
    }, { additionalProperties: false }),
    response: { 200: contentDraftWriteResult, 201: contentDraftWriteResult,
      413: problemResult(413), ...writeProblems },
  }, async ({ request, params, body }) => {
    if (!work.contentAuthoring) return problem(503, 'content_unavailable', 'Content owner is unavailable');
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
      return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
    }
    const resource = `https://rezics.com/id/${params.resource}`;
    if (Buffer.byteLength(body.description, 'utf8') > 16_384) {
      return problem(413, 'description_too_large', 'Catalog description exceeds 16 KiB');
    }
    try {
      const saved = await patchCatalogDescription(work.environment, work.contentAuthoring,
        work.account, work.access, request, { resourceId: resource,
          language: body.language, direction: body.direction, expectedHead: body.expectedHead,
          description: body.description, actingSubject: body.actingSubject, idempotencyKey });
      return Response.json({ resourceId: resource,
        variantId: catalogDescriptionVariantId(resource, body.language.tag),
        revisionId: saved.revisionId, predecessor: saved.predecessor,
        sourcePosition: saved.position, replayed: saved.replayed }, {
        status: saved.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
      });
    } catch (error) { return commandError(error); }
  });
}
