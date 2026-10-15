import { Elysia, t } from 'elysia';
import { createHash } from 'node:crypto';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem, commandError } from './problems.ts';
import { problemResult } from '../api-contract.ts';
import { cancelRecipeFileBody, readRecipeFileBytes, RecipeFileInvalid, RecipeFileTooLarge }
  from '../modules/recipe/file-intake.ts';
import { readRecipeCollection, normalizeCollectionRecipe, RECIPE_COLLECTION_LIMITS,
  type RecipeCollectionFormat } from '../modules/recipe/collection-file.ts';
import { importCollectionRecipe, collectionRecipeConflict } from '../modules/recipe/collection-import.ts';
import { ReaderImportConflict, ReaderImportUnavailable } from '../modules/library-import/reader-import.ts';
import { RecipeNotImportable } from '../modules/recipe/importer.ts';
import { PendingActivation } from '../modules/work/activate.ts';

export const openApiOperations = {
  '/v1/recipes/file-imports': { post: { exposure: 'public', rateLimitFamily: 'upload', bearer: true, idempotencyKey: true } },
} as const;
const importedItem = t.Object({ index: t.Integer(), name: t.String(), identity: t.String(),
  status: t.Literal('imported'), work: t.String(), structure: t.String(), revision: t.String(),
  content: t.Object({ post: t.String(), variantId: t.String(), revisionId: t.String() }, { additionalProperties: false }),
  sourceObservation: t.String(), kept: t.Array(t.String()), retainedOnly: t.Array(t.String()),
  sourceOmittedFields: t.Array(t.String()),
  losses: t.Array(t.Object({ field: t.String(), reason: t.String() }, { additionalProperties: false })),
  photos: t.Array(t.Object({ asset: t.String(), representation: t.Nullable(t.String()), clearance: t.String(),
    use: t.Optional(t.String()) }, { additionalProperties: false })), replayed: t.Boolean(),
}, { additionalProperties: false });
const failedItem = t.Object({ index: t.Integer(), name: t.String(), status: t.Literal('failed'),
  reason: t.Union([t.Literal('source-changed'), t.Literal('invalid-or-unsupported-recipe')]),
  detail: t.String({ maxLength: 512 }), importability: t.Optional(t.Object({ status: t.Literal('not-importable'),
    code: t.Literal('recipe_not_importable'), limit: t.Union(['occurrences', 'bytes', 'depth', 'section-depth'].map(value => t.Literal(value))),
    measured: t.Integer(), allowed: t.Integer() }, { additionalProperties: false })),
}, { additionalProperties: false });
const importPage = t.Object({ items: t.Array(t.Union([importedItem, failedItem]), { maxItems: RECIPE_COLLECTION_LIMITS.page }),
  total: t.Integer(), next: t.Nullable(t.Integer()), pending: t.Boolean() }, { additionalProperties: false });

export function recipeCollectionRoutes(deps: MainWorkDependencies) {
  return new Elysia().post('/v1/recipes/file-imports', {
    query: t.Object({ actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      format: t.Union([t.Literal('paprikarecipes'), t.Literal('melarecipes'), t.Literal('melarecipe')]),
      after: t.Optional(t.Integer({ minimum: 0, maximum: RECIPE_COLLECTION_LIMITS.recipes })),
      limit: t.Optional(t.Integer({ minimum: 1, maximum: RECIPE_COLLECTION_LIMITS.page })),
    }, { additionalProperties: false }), parse: 'none',
    detail: { description: 'Import a private Paprika or Mela collection. Re-submit the same file with next as after to continue. Each recipe reports native fields, source-only fields and losses. Re-importing unchanged recipes replays; changed source identities conflict without overwriting edits.',
      requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
        'application/zip': { schema: { type: 'string', format: 'binary' } },
        'application/json': { schema: { type: 'object' } } } } },
    response: { 200: importPage, 400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
      409: problemResult(409), 413: problemResult(413), 422: problemResult(422), 429: problemResult(429),
      500: problemResult(500), 503: problemResult(503) },
  }, async ({ request, query }: { request: Request; query: { actingSubject: string; format: RecipeCollectionFormat;
    after?: number; limit?: number } }) => {
    try {
      const requestKey = request.headers.get('idempotency-key') ?? '';
      if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(requestKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      }
      const principal = await deps.account.verify(request, ['work:read', 'work:create', 'work:edit', 'library:write']);
      if (!await deps.access.canReadAsBaselineMember?.(principal, query.actingSubject)) {
        return problem(403, 'recipe_import_denied', 'Recipe imports are private to your own Person');
      }
      const principalId = await deps.access.activePrincipalId(principal);
      if (!principalId) return problem(403, 'recipe_import_denied', 'Recipe import principal is inactive');
      if (!deps.sourceIntake || !deps.libraryImport || !deps.contentAuthoring) {
        return problem(503, 'recipe_import_unavailable', 'Recipe import owners are unavailable');
      }
      const bytes = await readRecipeFileBytes(request, RECIPE_COLLECTION_LIMITS.bytes);
      const entries = readRecipeCollection(bytes, query.format);
      const after = query.after ?? 0, limit = query.limit ?? RECIPE_COLLECTION_LIMITS.page;
      if (after > entries.length) return problem(400, 'invalid_recipe_cursor', 'Recipe offset is outside this collection');
      const intent = createHash('sha256').update(JSON.stringify([query.format, after, limit]))
        .update(bytes).digest('hex');
      await deps.libraryImport.beginBatch(query.actingSubject,
        `recipe-upload:${createHash('sha256').update(requestKey).digest('hex')}`, intent, 1);
      const items: unknown[] = [];
      for (let index = after; index < Math.min(entries.length, after + limit); index++) {
        const entry = entries[index]!;
        try {
          const recipe = normalizeCollectionRecipe(entry, query.format);
          const outcome = await importCollectionRecipe(deps, request, query.actingSubject, principalId, recipe);
          if (!outcome) {
            return Response.json({ items, total: entries.length, next: index, pending: true },
              { headers: { 'cache-control': 'private, no-store' } });
          }
          items.push({ index, name: entry.name, ...outcome });
        } catch (error) {
          if (error instanceof RecipeFileInvalid || error instanceof RecipeNotImportable || collectionRecipeConflict(error)) {
            items.push({ index, name: entry.name, status: 'failed',
              reason: collectionRecipeConflict(error) ? 'source-changed' : 'invalid-or-unsupported-recipe',
              detail: (error instanceof Error ? error.message : 'Recipe was refused').slice(0, 512),
              ...(error instanceof RecipeNotImportable ? { importability: error.importability } : {}) });
          } else throw error;
        }
      }
      const next = after + items.length;
      return Response.json({ items, total: entries.length, next: next < entries.length ? next : null, pending: false },
        { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      if (error instanceof RecipeFileTooLarge) return problem(413, 'recipe_not_importable', error.message);
      if (error instanceof RecipeFileInvalid) return problem(422, 'invalid_recipe_file', error.message);
      if (error instanceof ReaderImportUnavailable) return problem(503, 'recipe_import_unavailable', error.message);
      if (error instanceof ReaderImportConflict) return problem(409, 'recipe_import_conflict', 'Recipe upload key changed intent');
      if (error instanceof PendingActivation) return problem(503, 'recipe_import_pending', error.message);
      return commandError(error);
    } finally { cancelRecipeFileBody(request); }
  });
}
