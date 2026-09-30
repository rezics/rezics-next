import { Elysia, t } from 'elysia';
import { authorizedReadProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import { readWorkParts, readWorkWholes } from '../modules/composition/read.ts';
import { CompositionUnavailable, CompositionCorrupt } from '../modules/structure/graph.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from '../modules/structure/tree.ts';
import { workRead } from '../modules/work/read-session.ts';
import { workReadError } from './work-reads.ts';
import { problem } from './problems.ts';
import { groupUuid } from './shared.ts';
import type { MainWorkDependencies } from './dependencies.ts';

const ref = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const params = t.Object({ id: groupUuid });
const query = t.Object({ actingSubject: ref, parent: t.Optional(ref),
  after: t.Optional(t.String({ maxLength: 2048 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })) }, { additionalProperties: false });
const position = t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() });
const identity = { occurrence: ref, mainVersion: t.Optional(ref), work: t.Optional(ref),
  segmentKey: t.String(), orderKey: t.String() };
const parts = t.Object({ resource: ref, mainVersion: ref, structure: ref, revision: ref,
  completion: t.Object({ status: t.Union([t.Literal('concluded'), t.Literal('ongoing'), t.Literal('unknown')]),
    evidence: t.Array(t.String()) }),
  parts: t.Array(t.Object({ ...identity, parent: ref, role: t.Union([t.Literal('group'), t.Literal('part')]),
    labels: t.Array(t.Object({ value: t.String(), language: t.String() })),
    displayLabel: t.Optional(t.String()), inclusion: t.Optional(t.Union([
      t.Literal('required'), t.Literal('optional'), t.Literal('extra')])) })),
  next: t.Nullable(t.String()), sourcePosition: position });
const wholes = t.Object({ resource: ref, wholes: t.Array(t.Object({ ...identity, work: ref,
  mainVersion: ref, structure: ref })), next: t.Nullable(t.String()), sourcePosition: position });
const errors = { ...authorizedReadProblems, 409: problemResult(409), 422: problemResult(422) };
const failure = (error: unknown) => {
  if (error instanceof CompositionUnavailable) return problem(404, 'composition_unavailable', 'Composition is unavailable');
  if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
    || error instanceof StructureObjectUnavailable) return problem(503, 'composition_unavailable', 'Composition history is unavailable');
  return workReadError(error);
};
export const openApiOperations = {
  '/v1/resources/{id}/parts': { get: { bearer: true } },
  '/v1/resources/{id}/wholes': { get: { bearer: true } },
} as const;

export function compositionReadRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/resources/:id/parts', { params, query, response: { 200: parts, ...errors } }, async ({ request, params, query }) => {
      try { return Response.json(await workRead(work, request, { actingSubject: query.actingSubject },
        session => readWorkParts(session, `https://rezics.com/id/${params.id}`, { ...query, limit: query.limit ?? 50 })),
      { headers: { 'cache-control': 'private, no-store' } }); }
      catch (error) { return failure(error); }
    })
    .get('/v1/resources/:id/wholes', { params, query: t.Object({ actingSubject: ref,
      after: query.properties.after, limit: query.properties.limit }, { additionalProperties: false }),
    response: { 200: wholes, ...errors } }, async ({ request, params, query }) => {
      try { return Response.json(await workRead(work, request, { actingSubject: query.actingSubject },
        session => readWorkWholes(session, `https://rezics.com/id/${params.id}`, { ...query, limit: query.limit ?? 50 })),
      { headers: { 'cache-control': 'private, no-store' } }); }
      catch (error) { return failure(error); }
    });
}
