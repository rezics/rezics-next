import { Elysia, t } from 'elysia';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionExpired, AdmissionUnavailable }
  from '../modules/access/admission.ts';
import { createAdmittedExport, ExportPending, readAuthorizedExport } from '../modules/export/operations.ts';
import { InvalidExportPlan } from '../modules/export/planner.ts';
import { ExportSourceNotFound, ExportSourceUnavailable, ExportStale } from '../modules/export/readers.ts';
import { ExportConflict, ExportDenied, ExportNotFound, ExportUnavailable }
  from '../modules/export/store.ts';
import { CompositionCorrupt } from '../modules/structure/graph.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from '../modules/structure/tree.ts';
import { RevisionCorrupt, RevisionNotFound, RevisionUnavailable } from '../modules/work/history.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupUuid } from './shared.ts';

export const openApiOperations = {
  '/v1/exports': { post: { bearer: true, idempotencyKey: true } },
  '/v1/exports/{export}': { get: { bearer: true } },
};

const position = t.Object({ dataEpoch: t.String({ minLength: 1, maxLength: 100 }),
  sequence: t.String({ pattern: '^(0|[1-9][0-9]*)$' }) }, { additionalProperties: false });
const selection = t.Union([
  t.Object({ kind: t.Union([t.Literal('fixed-release'), t.Literal('assessment')]),
    reference: groupAgent, expectedPosition: position }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('composition-seal'), reference: groupAgent,
    structure: groupAgent, expectedPosition: position }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('semantic-revision'), reference: groupAgent,
    resource: groupAgent, expectedPosition: position }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('vndb-concept-run'), reference: groupAgent,
    expectedPosition: position }, { additionalProperties: false }),
]);
const body = t.Object({ profile: t.Literal('export-create-v1'), actingSubject: groupAgent,
  useScope: t.Union([t.Literal('full'), t.Literal('excerpt'), t.Literal('quotation'), t.Literal('evaluation')]),
  selection }, { additionalProperties: false });
const result = t.Object({}, { additionalProperties: true });
const write = { 200: result, 201: result, 202: pendingOperation,
  ...writeProblems, 404: problemResult(404) };

function exportError(error: unknown): Response {
  if (error instanceof ExportPending) {
    return Response.json({ operationId: error.operationId, status: 'reconciling', phase: 'export',
      result: null, retry: { allowed: true, afterMs: 1000 } }, { status: 202,
      headers: { 'cache-control': 'no-store', 'retry-after': '1' } });
  }
  if (error instanceof ExportDenied || error instanceof AdmissionDenied || error instanceof AdmissionExpired) {
    return problem(403, 'export_denied', 'Export authority or disclosure is not current');
  }
  if (error instanceof InvalidExportPlan) return problem(400, 'export_invalid', error.message);
  if (error instanceof RevisionNotFound || error instanceof ExportNotFound
    || error instanceof ExportSourceNotFound) {
    return problem(404, 'export_source_missing', 'Selected source is unavailable');
  }
  if (error instanceof ExportStale) return problem(409, 'export_source_stale', error.message);
  if (error instanceof ExportConflict || error instanceof AdmissionConflict) {
    return problem(409, 'idempotency_conflict', 'Export key binds another intent');
  }
  if (error instanceof ExportSourceUnavailable || error instanceof ExportUnavailable
    || error instanceof AdmissionUnavailable || error instanceof RevisionUnavailable
    || error instanceof RevisionCorrupt || error instanceof CompositionCorrupt
    || error instanceof StructureObjectCorrupt || error instanceof StructureObjectUnavailable) {
    return problem(503, 'export_unavailable', 'Exact export evidence is unavailable');
  }
  return commandError(error);
}

export function exportRoutes(work: MainWorkDependencies) {
  const dependencies = () => {
    if (!work.exports) throw new ExportUnavailable('export owner is unavailable');
    return { account: work.account, access: work.access, store: work.exports,
      readers: { env: work.environment,
        canReadWork: (principal: { issuer: string; subject: string }, actor: string, workId: string) =>
          work.access.canReadWork(principal, actor, workId),
        canReadSemantic: async (principal: { issuer: string; subject: string }, actor: string,
          resource: string, revision?: string) => await work.access.canReadSemanticResource?.(principal, actor, resource, revision)
          || revision === undefined && await work.access.canReadWork(principal, actor, resource),
        principalIdOf: (principal: { issuer: string; subject: string }) =>
          work.access.activePrincipalId(principal),
        sourceRuns: work.sourceAcquisitions?.runs,
        structureObjects: work.structureObjects,
        verification: work.exportVerificationPrivate, rights: work.exportRights } };
  };
  const send = (value: unknown, status = 200) => Response.json(value,
    { status, headers: { 'cache-control': 'no-store' } });
  return new Elysia()
    .post('/v1/exports', { body, response: write }, async ({ request, body: input }) => {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A bounded Idempotency-Key is required');
      }
      try {
        const saved = await createAdmittedExport(dependencies(), request, {
          selection: input.selection, actingSubject: input.actingSubject,
          useScope: input.useScope, idempotencyKey: key });
        return send({ profile: 'export-manifest-v1', ...saved }, saved.replayed ? 200 : 201);
      } catch (error) { return exportError(error); }
    })
    .get('/v1/exports/:export', {
      params: t.Object({ export: groupUuid }), response: { 200: result, ...authorizedReadProblems,
        409: problemResult(409) },
    }, async ({ request, params }) => {
      try { return send({ profile: 'export-manifest-v1',
        ...await readAuthorizedExport(dependencies(), request, params.export) }); }
      catch (error) { return exportError(error); }
    });
}
