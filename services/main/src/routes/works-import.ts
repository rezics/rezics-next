import { Elysia, t } from 'elysia';
import type { MainWorkDependencies } from './dependencies.ts';
import { catalogueImportInput, importCatalogueWorks, InvalidCatalogueImport } from '../modules/work/catalogue-import.ts';
import { commandError, problem } from './problems.ts';
import { writeProblems } from '../api-responses.ts';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' });
const key = t.String({ pattern: '^[A-Za-z0-9:_./-]{1,128}$' });
const receipt = t.Object({ outcome: t.Union([t.Literal('succeeded'), t.Literal('cancelled')]),
  receipt: t.String(), admissionId: t.String(), requestDigest: t.String(), authorityEpoch: t.String(),
  scope: t.String(), dataEpoch: t.String(), sequence: t.String(), work: t.Optional(t.String()),
  mainVersion: t.Optional(t.String()), workRevision: t.Optional(t.String()), mainRevision: t.Optional(t.String()) });
const outcome = t.Object({ key, status: t.Union(['succeeded', 'denied', 'invalid', 'conflict', 'pending'].map(value => t.Literal(value))),
  receipt: t.Optional(receipt), replayed: t.Optional(t.Boolean()) });
const closed = { additionalProperties: false } as const;
export function catalogueImportRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/work-imports', {
      body: t.Object({ actingSubject: native, input: catalogueImportInput }, closed),
      response: { 200: outcome, 201: outcome, 202: outcome, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey))
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        const result = (await importCatalogueWorks(work, request, body.actingSubject,
          [{ key: idempotencyKey, input: body.input }]))[0]!;
        if (result.status === 'denied') return problem(403, 'catalogue_import_denied', 'Catalogue import authority is required');
        if (result.status === 'invalid') return problem(400, 'invalid_catalogue_import', 'Catalogue item failed validation');
        if (result.status === 'conflict') return problem(409, 'catalogue_import_conflict', 'Catalogue creation basis changed');
        return Response.json(result, { status: result.status === 'pending' ? 202 : result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof InvalidCatalogueImport) return problem(400, 'invalid_catalogue_import', error.message);
        return commandError(error);
      }
    })
    .post('/v1/work-imports/bulk', {
      body: t.Object({ actingSubject: native, items: t.Array(t.Object({ key, input: catalogueImportInput }, closed),
        { minItems: 1, maxItems: 128 }) }, closed),
      response: { 200: t.Object({ items: t.Array(outcome), complete: t.Boolean(), partial: t.Boolean() }), ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const items = await importCatalogueWorks(work, request, body.actingSubject, body.items);
        return Response.json({ items, complete: items.every(item => item.status !== 'pending'),
          partial: items.some(item => item.status !== 'succeeded') }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof InvalidCatalogueImport) return problem(400, 'invalid_catalogue_import', error.message);
        return commandError(error);
      }
    });
}
export const openApiOperations = {
  '/v1/work-imports': { post: { bearer: true, idempotencyKey: true } },
  // Item keys are independent of batching and stable across regrouped retries.
  '/v1/work-imports/bulk': { post: { bearer: true } },
} as const;
