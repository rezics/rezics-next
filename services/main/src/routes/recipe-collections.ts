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
import { LibraryFileMissing } from '../modules/library-import/file-store.ts';
import { emptyRow, type CanonicalRow } from '../modules/library-import/formats/contract.ts';
import { judgmentScaleSchema } from '../modules/rating/scale.ts';

export const openApiOperations = {
  '/v1/recipes/file-imports/{id}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/recipes/file-imports': { post: { exposure: 'public', rateLimitFamily: 'upload', bearer: true, idempotencyKey: true } },
} as const;
const importedItem = t.Object({ index: t.Integer(), name: t.String(), identity: t.String(),
  status: t.Literal('imported'), work: t.String(), structure: t.String(), revision: t.String(),
  content: t.Object({ post: t.String(), variantId: t.String(), revisionId: t.String() }, { additionalProperties: false }),
  sourceObservation: t.String(), kept: t.Array(t.String()), retainedOnly: t.Array(t.String()),
  sourceOmittedFields: t.Array(t.String()),
  rating: t.Optional(t.Union([t.Object({ status: t.Literal('native'), context: t.String(), value: t.Number(),
    revision: t.String(), scale: judgmentScaleSchema }, { additionalProperties: false }),
  t.Object({ status: t.Literal('retained'), reason: t.String() }, { additionalProperties: false })])),
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
  fileId: t.String({ format: 'uuid' }), state: t.String(), reason: t.Nullable(t.String()),
  receipt: t.Optional(t.String()), completed: t.Integer(), issues: t.Integer(),
  total: t.Integer(), next: t.Nullable(t.Integer()), pending: t.Boolean() }, { additionalProperties: false });

export function recipeCollectionRoutes(deps: MainWorkDependencies) {
  return new Elysia().post('/v1/recipes/file-imports', {
    query: t.Object({ actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      format: t.Optional(t.Union([t.Literal('paprikarecipes'), t.Literal('melarecipes'), t.Literal('melarecipe')])),
      fileId: t.Optional(t.String({ format: 'uuid' })),
      after: t.Optional(t.Integer({ minimum: 0, maximum: RECIPE_COLLECTION_LIMITS.recipes })),
      limit: t.Optional(t.Integer({ minimum: 1, maximum: RECIPE_COLLECTION_LIMITS.page })),
    }, { additionalProperties: false }), parse: 'none',
    detail: { description: 'Import a private Paprika or Mela collection. Retain fileId and submit it with next as after to continue without uploading again; GET the file status to inspect completed, stalled or failed jobs. Each recipe reports native fields, source-only fields and losses. Re-importing unchanged recipes replays; changed source identities conflict without overwriting edits.',
      requestBody: { required: false, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
        'application/zip': { schema: { type: 'string', format: 'binary' } },
        'application/json': { schema: { type: 'object' } } } } },
    response: { 200: importPage, 404: problemResult(404), 400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
      409: problemResult(409), 413: problemResult(413), 422: problemResult(422), 429: problemResult(429),
      500: problemResult(500), 503: problemResult(503) },
  }, async ({ request, query }: { request: Request; query: { actingSubject: string; format?: RecipeCollectionFormat; fileId?: string;
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
      if (!deps.sourceIntake || !deps.libraryImport || !deps.libraryFiles || !deps.contentAuthoring) {
        return problem(503, 'recipe_import_unavailable', 'Recipe import owners are unavailable');
      }
      const files = deps.libraryFiles;
      let fileId = query.fileId;
      if (!fileId) {
        if (!query.format) return problem(400, 'invalid_recipe_file', 'format is required for an upload');
        const bytes = await readRecipeFileBytes(request, RECIPE_COLLECTION_LIMITS.bytes);
        const entries = readRecipeCollection(bytes, query.format);
        const rows: CanonicalRow[] = entries.map((entry,index) => {
          let value = entry.value, error = entry.error;
          if (entry.bytes) {
            try { value=JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(entry.bytes)); }
            catch { error='Recipe must contain UTF-8 JSON'; }
          }
          return emptyRow(`${query.format}:${index}`,entry.name,
            { entry: { name: entry.name,...(value===undefined ? {} : { value }),...(error ? { error } : {}) } });
        });
        const digest = createHash('sha256').update(query.format).update(bytes).digest('hex');
        fileId = (await files.create(query.actingSubject,requestKey,digest,query.format,rows)).id;
      }
      const file = await files.file(query.actingSubject,fileId);
      if (!['paprikarecipes','melarecipes','melarecipe'].includes(file.format)
        || query.format && query.format!==file.format) throw new ReaderImportConflict('Import format changed');
      const after = query.after ?? 0, limit = query.limit ?? RECIPE_COLLECTION_LIMITS.page;
      if (after > file.total) return problem(400,'invalid_recipe_cursor','Recipe offset is outside this collection');
      const page = await files.applyPage(query.actingSubject,fileId,`recipe-page:${requestKey}`,after,limit,async row => {
        const entry = row.source.raw.entry as { name: string; value?: unknown; error?: string };
        let result: Record<string, unknown>;
        try {
          const recipe = normalizeCollectionRecipe(entry,file.format as RecipeCollectionFormat);
          const outcome = await importCollectionRecipe(deps,request,query.actingSubject,principalId,recipe);
          if (!outcome) return null;
          result = { index: row.index,name: entry.name,...outcome };
        } catch (error) {
          if (!(error instanceof RecipeFileInvalid || error instanceof RecipeNotImportable || collectionRecipeConflict(error))) throw error;
          result = { index: row.index,name: entry.name,status: 'failed',
            reason: collectionRecipeConflict(error) ? 'source-changed' : 'invalid-or-unsupported-recipe',
            detail: (error instanceof Error ? error.message : 'Recipe was refused').slice(0,512),
            ...(error instanceof RecipeNotImportable ? { importability: error.importability } : {}) };
        }
        return { applied: result.status==='imported' ? ['native-recipe'] : [],
          issues: result.status==='failed' ? [String(result.reason)] : [],result };
      });
      return Response.json({ fileId,items: page.rows.map(row => ({ ...row.outcome!.result,
        ...(row.outcome!.result?.status==='imported' && row.replayed ? { replayed: true } : {}) })),
        total: page.total,completed: page.completed,issues: page.issues,receipt: page.receipt,
        state: page.state,reason: page.reason,next: page.next,pending: page.pagePending },
      { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      if (error instanceof LibraryFileMissing) return problem(404,'recipe_import_missing','Import file is unavailable');
      if (error instanceof RecipeFileTooLarge) return problem(413, 'recipe_not_importable', error.message);
      if (error instanceof RecipeFileInvalid) return problem(422, 'invalid_recipe_file', error.message);
      if (error instanceof ReaderImportUnavailable) return problem(503, 'recipe_import_unavailable', error.message);
      if (error instanceof ReaderImportConflict) return problem(409, 'recipe_import_conflict', 'Recipe upload key changed intent');
      if (error instanceof PendingActivation) return problem(503, 'recipe_import_pending', error.message);
      return commandError(error);
    } finally { cancelRecipeFileBody(request); }
  }).get('/v1/recipes/file-imports/:id', {
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
    query: t.Object({ actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) }),
    response: { 200: t.Object({ total: t.Integer(),completed: t.Integer(),issues: t.Integer(),
      state: t.String(),reason: t.Nullable(t.String()),pending: t.Boolean() }),
      400: problemResult(400),401: problemResult(401),403: problemResult(403),404: problemResult(404),
      429: problemResult(429),500: problemResult(500),503: problemResult(503) },
  }, async ({ request,params,query }) => {
    try {
      const principal=await deps.account.verify(request,['work:read']);
      if (!await deps.access.canReadAsBaselineMember?.(principal,query.actingSubject)) {
        return problem(403,'recipe_import_denied','Recipe imports are private to your own Person');
      }
      if (!deps.libraryFiles) return problem(503,'recipe_import_unavailable','Import owner is unavailable');
      const file=await deps.libraryFiles.file(query.actingSubject,params.id);
      if (!['paprikarecipes','melarecipes','melarecipe'].includes(file.format)) throw new LibraryFileMissing();
      return Response.json(await deps.libraryFiles.progress(query.actingSubject,params.id),
        { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      if (error instanceof LibraryFileMissing) return problem(404,'recipe_import_missing','Import file is unavailable');
      return commandError(error);
    }
  });
}
