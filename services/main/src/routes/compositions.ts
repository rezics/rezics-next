import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { createAdmittedComposition, changeAdmittedComposition, sealAdmittedComposition }
  from '../modules/structure/change-admitted.ts';
import { CompositionConflict, CompositionExists, CompositionTooLarge, InvalidCompositionChange,
  StaleCompositionHead } from '../modules/structure/change.ts';
import { CompositionCorrupt, CompositionUnavailable, NATIVE_ID, readCompositionHeader }
  from '../modules/structure/graph.ts';
import { readCompositionPage } from '../modules/structure/read.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from '../modules/structure/tree.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

const ref = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const selection = t.Union([t.Object({ mode: t.Literal('follow-context') }),
  t.Object({ mode: t.Literal('fixed-revision'), revision: t.String() })]);
const label = t.Object({ value: t.String({ minLength: 1, maxLength: 500 }),
  language: t.String() });
const position = t.Union([t.Literal('first'), t.Literal('last'),
  t.Object({ after: ref }, { additionalProperties: false })]);
const operation = t.Union([
  t.Object({ op: t.Literal('insert'), parent: ref, position,
    role: t.Union([t.Literal('group'), t.Literal('chapter')]), target: t.Optional(ref),
    selection: t.Optional(selection), label: t.Optional(label), sourceKey: t.Optional(t.String()) },
  { additionalProperties: false }),
  t.Object({ op: t.Literal('move'), occurrence: ref, parent: ref, position },
    { additionalProperties: false }),
  t.Object({ op: t.Literal('remove'), occurrence: ref }, { additionalProperties: false }),
]);
const sourcePosition = t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(),
  sequence: t.String() });
const cost = t.Object({ pagesRead: t.Integer(), pagesWritten: t.Integer(),
  placementsWritten: t.Integer(), segmentsWritten: t.Integer(), rebalanced: t.Integer() });
const writeResult = t.Object({ structure: ref, mainVersion: t.Optional(ref),
  revision: t.Optional(ref), expectedHead: t.Optional(ref), seal: t.Optional(ref),
  receipt: t.String(), replayed: t.Boolean(), occurrences: t.Optional(t.Array(ref)),
  cost: t.Optional(cost), sourcePosition });
const occurrence = t.Object({ occurrence: ref, state: t.Union([t.Literal('active'),
  t.Literal('removed')]), parent: ref,
  segmentKey: t.Optional(t.String()), orderKey: t.Optional(t.String()),
  removedBy: t.Optional(ref), role: t.Union([t.Literal('group'),
    t.Literal('chapter')]), target: t.Optional(t.String()), selection: t.Optional(selection),
  labels: t.Array(label), sourceKey: t.Optional(t.String()), introducedBy: ref });
const pageResult = t.Object({ structure: ref, work: ref, mainVersion: ref, revision: ref,
  predecessor: t.Nullable(ref), placementCount: t.Integer(), occurrences: t.Array(occurrence),
  next: t.Nullable(t.String()), sourcePosition,
  cost: t.Object({ pagesRead: t.Integer(), pagesWritten: t.Integer() }) });
const writeResponses = { 200: writeResult, 201: writeResult, 202: pendingOperation,
  400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
  404: problemResult(404), 409: problemResult(409), 500: problemResult(500),
  503: problemResult(503) };
const readResponses = { 200: pageResult, ...authorizedReadProblems };

function key(request: Request): string | null {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
}

function compositionError(error: unknown): Response {
  if (error instanceof InvalidCompositionChange) return problem(400, 'invalid_composition', error.message);
  if (error instanceof CompositionUnavailable) return problem(404, 'composition_unavailable',
    'Composition is unavailable');
  if (error instanceof StaleCompositionHead) return problem(409, 'stale_composition_head', error.message);
  if (error instanceof CompositionConflict || error instanceof CompositionExists
    || error instanceof CompositionTooLarge) return problem(409, 'composition_conflict', error.message);
  if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
    || error instanceof StructureObjectUnavailable) return problem(503, 'composition_unavailable',
    'Composition history is unavailable');
  return commandError(error);
}

const writeBody = t.Object({ actingSubject: ref }, { additionalProperties: false });

/** Book Composition is the first Structure write/read template. */
export function compositionRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/compositions', {
      body: t.Object({ profile: t.Literal('book-composition'), work: ref,
        mainVersion: ref, ...writeBody.properties }, { additionalProperties: false }),
      response: writeResponses,
    }, async ({ request, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await createAdmittedComposition(work.environment, work.account, work.access,
          request, { work: body.work, mainVersion: body.mainVersion,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ structure: result.structure, mainVersion: result.mainVersion,
          revision: result.revision, receipt: result.receipt, replayed: result.replayed,
          sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch,
            sequence: result.sequence } }, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/changes', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ profile: t.Literal('book-composition'), expectedHead: ref,
        operations: t.Array(operation, { minItems: 1, maxItems: 16 }),
        ...writeBody.properties }, { additionalProperties: false }),
      response: writeResponses,
    }, async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await changeAdmittedComposition(work.environment, work.account, work.access,
          request, { structure: `https://rezics.com/id/${params.id}`, expectedHead: body.expectedHead,
            operations: body.operations, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ structure: result.structure, revision: result.revision,
          expectedHead: result.expectedHead, receipt: result.receipt, replayed: result.replayed,
          occurrences: result.occurrences ?? [], ...(result.cost ? { cost: result.cost } : {}),
          sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch,
            sequence: result.sequence } }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .post('/v1/compositions/:id/seals', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, ...writeBody.properties },
        { additionalProperties: false }), response: writeResponses,
    }, async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await sealAdmittedComposition(work.environment, work.account, work.access,
          request, { structure: `https://rezics.com/id/${params.id}`, expectedHead: body.expectedHead,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ structure: result.structure, revision: result.revision,
          expectedHead: result.expectedHead, seal: result.seal, receipt: result.receipt,
          replayed: result.replayed, sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id', {
      params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref, parent: t.Optional(ref),
        after: t.Optional(t.String({ maxLength: 512 })), limit: t.Optional(t.Numeric({
          minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
      response: readResponses,
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const header = await readCompositionHeader(work.environment, structure);
        if (!header || !await work.access.canReadWork(principal, query.actingSubject, header.work)) {
          return problem(404, 'composition_unavailable', 'Composition is unavailable');
        }
        const page = await readCompositionPage(work.environment, { structure,
          ...(query.parent ? { parent: query.parent } : {}), ...(query.after ? { after: query.after } : {}),
          limit: query.limit ?? 50,
          canReadTarget: target => NATIVE_ID.test(target)
            ? work.access.canReadWork(principal, query.actingSubject, target) : Promise.resolve(false) });
        return Response.json(page, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id/revisions/:revision', {
      params: t.Object({ id: groupUuid, revision: groupUuid }),
      query: t.Object({ actingSubject: ref, parent: t.Optional(ref),
        after: t.Optional(t.String({ maxLength: 512 })), limit: t.Optional(t.Numeric({
          minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
      response: readResponses,
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const header = await readCompositionHeader(work.environment, structure);
        if (!header || !await work.access.canReadWork(principal, query.actingSubject, header.work)) {
          return problem(404, 'composition_unavailable', 'Composition is unavailable');
        }
        const page = await readCompositionPage(work.environment, { structure,
          revision: `https://rezics.com/id/${params.revision}`,
          ...(query.parent ? { parent: query.parent } : {}), ...(query.after ? { after: query.after } : {}),
          limit: query.limit ?? 50,
          canReadTarget: target => NATIVE_ID.test(target)
            ? work.access.canReadWork(principal, query.actingSubject, target) : Promise.resolve(false) });
        return Response.json(page, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    })
    .get('/v1/compositions/:id/occurrences/:occurrence', {
      params: t.Object({ id: groupUuid, occurrence: groupUuid }),
      query: t.Object({ actingSubject: ref, revision: t.Optional(ref) },
        { additionalProperties: false }), response: readResponses,
    }, async ({ request, params, query }) => {
      try {
        const structure = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const header = await readCompositionHeader(work.environment, structure);
        if (!header || !await work.access.canReadWork(principal, query.actingSubject, header.work)) {
          return problem(404, 'composition_unavailable', 'Composition is unavailable');
        }
        const page = await readCompositionPage(work.environment, { structure,
          occurrence: `https://rezics.com/id/${params.occurrence}`,
          ...(query.revision ? { revision: query.revision } : {}), limit: 1,
          canReadTarget: target => NATIVE_ID.test(target)
            ? work.access.canReadWork(principal, query.actingSubject, target) : Promise.resolve(false) });
        return Response.json(page, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return compositionError(error); }
    });
}
