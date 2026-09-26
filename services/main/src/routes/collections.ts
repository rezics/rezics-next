import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { bootstrapAdmittedStructureOwner } from '../modules/structure/bootstrap.ts';
import { changeAdmittedComposition } from '../modules/structure/change-admitted.ts';
import { CompositionConflict, InvalidCompositionChange, StaleCompositionHead }
  from '../modules/structure/change.ts';
import { CompositionCorrupt, CompositionUnavailable, readCompositionHeader }
  from '../modules/structure/graph.ts';
import { readCompositionPage } from '../modules/structure/read.ts';
import { canReadStructureTarget, structureProfileFor } from '../modules/structure/profiles.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable }
  from '../modules/structure/tree.ts';
import { createAdmittedOwner } from '../modules/zone/owner-create.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { GRAPHS, hash, iri } from '../modules/work/activate.ts';
import { problemResult, pendingOperation } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

const ref = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const position = t.Union([t.Literal('first'), t.Literal('last'),
  t.Object({ after: ref }, { additionalProperties: false })]);
const selection = t.Union([t.Object({ mode: t.Literal('follow-context') }, { additionalProperties: false }),
  t.Object({ mode: t.Literal('fixed-revision'), revision: t.String() }, { additionalProperties: false })]);
const operation = t.Union([
  t.Object({ op: t.Literal('insert'), parent: ref, position,
    role: t.Union([t.Literal('group'), t.Literal('member')]), target: t.Optional(ref),
    selection: t.Optional(selection), sourceKey: t.Optional(t.String({ maxLength: 200 })),
    label: t.Optional(t.Object({ value: t.String({ maxLength: 500 }), language: t.String() })) },
  { additionalProperties: false }),
  t.Object({ op: t.Literal('move'), occurrence: ref, parent: ref, position },
    { additionalProperties: false }),
  t.Object({ op: t.Literal('remove'), occurrence: ref }, { additionalProperties: false }),
]);
const cost = t.Object({ pagesRead: t.Integer(), pagesWritten: t.Integer(),
  placementsWritten: t.Integer(), segmentsWritten: t.Integer(), rebalanced: t.Integer() });
const sourcePosition = t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() });
const write = t.Object({ collection: ref, structure: ref, revision: ref, receipt: t.String(),
  replayed: t.Boolean(), occurrences: t.Optional(t.Array(ref)), cost: t.Optional(cost),
  sourcePosition: t.Optional(sourcePosition) });
const read = t.Object({ collection: ref, structure: ref, revision: ref,
  predecessor: t.Nullable(ref), occurrences: t.Array(t.Any()), next: t.Nullable(t.String()),
  cost: t.Object({ pagesRead: t.Integer(), pagesWritten: t.Integer(), authorizationChecks: t.Integer() }),
  sourcePosition });
const errors = { 400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
  404: problemResult(404), 409: problemResult(409), 500: problemResult(500),
  503: problemResult(503) };

export const openApiOperations = {
  '/v1/collections': { post: { bearer: true, idempotencyKey: true } },
  '/v1/collections/{id}/changes': { post: { bearer: true, idempotencyKey: true } },
  '/v1/collections/{id}': { get: { bearer: true } },
  '/v1/collections/{id}/revisions/{revision}': { get: { bearer: true } },
} as const;

function key(request: Request) {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
}

function routeError(error: unknown): Response {
  if (error instanceof InvalidCompositionChange) return problem(400, 'invalid_collection_change', error.message);
  if (error instanceof StaleCompositionHead || error instanceof CompositionConflict) {
    return problem(409, 'collection_conflict', error.message);
  }
  if (error instanceof CompositionUnavailable) return problem(404, 'collection_unavailable', 'Collection is unavailable');
  if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
    || error instanceof StructureObjectUnavailable) {
    return problem(503, 'collection_unavailable', 'Collection history is unavailable');
  }
  return commandError(error);
}

async function ownerStructure(fuseki: FusekiClient, collection: string): Promise<string | null> {
  const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?structure WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(collection)} a rv:Collection ;
      rv:collectionState rv:Active ; rv:structure ?structure . } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  return rows.length === 1 ? rows[0]?.structure?.value ?? null : null;
}

async function page(fuseki: FusekiClient, work: MainWorkDependencies, request: Request,
  collection: string, input: { actingSubject: string; revision?: string; parent?: string;
    after?: string; limit?: number }) {
  await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
  const principal = await work.account.verify(request, ['semantic:read']);
  if (!await work.access.canReadSemanticResource?.(principal, input.actingSubject, collection)) {
    throw new CompositionUnavailable('Collection is unavailable');
  }
  const structure = await ownerStructure(fuseki, collection);
  if (!structure) throw new CompositionUnavailable('Collection is unavailable');
  const header = await readCompositionHeader(work.environment, structure);
  if (!header || header.profile !== 'collection-membership' || header.owner !== collection) {
    throw new CompositionUnavailable('Collection is unavailable');
  }
  let targetPrincipal = principal;
  let mayReadTargets = true;
  try { targetPrincipal = await work.account.verify(request, ['work:read']); }
  catch { mayReadTargets = false; }
  let authorizationChecks = 0;
  const result = await readCompositionPage(work.environment, { structure,
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.parent ? { parent: input.parent } : {}), ...(input.after ? { after: input.after } : {}),
    limit: input.limit ?? 50,
    canReadTarget: async target => {
      authorizationChecks++;
      return mayReadTargets && canReadStructureTarget(structureProfileFor(header.profile), {
        access: work.access, principal: targetPrincipal, actingSubject: input.actingSubject, target });
    } });
  // The shared page retains hidden uses for exact owner history. Public Collection reads
  // project only disclosed members and do not return a hidden member count or cursor.
  const hidden = result.occurrences.some(item => item.role === 'member' && !item.target);
  return { collection, structure, revision: result.revision, predecessor: result.predecessor,
    occurrences: result.occurrences.filter(item => item.role !== 'member' || item.target),
    next: hidden ? null : result.next, sourcePosition: result.sourcePosition,
    cost: { ...result.cost, authorizationChecks } };
}

export function collectionRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  if (work.structureObjects) (work.environment as typeof work.environment
    & { structureObjects?: typeof work.structureObjects }).structureObjects = work.structureObjects;
  return new Elysia()
    .post('/v1/collections', { body: t.Object({ collection: ref, name: t.String({ minLength: 1, maxLength: 300 }),
      disclosure: t.Union([t.Literal('public'), t.Literal('private')]), actingSubject: ref },
    { additionalProperties: false }), response: { 200: write, 201: write, 202: pendingOperation, ...errors } },
    async ({ request, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const requestDigest = hash(JSON.stringify({ family: 'collection-create-v1',
          collection: body.collection, name: body.name, disclosure: body.disclosure,
          actingSubject: body.actingSubject }));
        const result = await bootstrapAdmittedStructureOwner(work.environment, work.account,
          work.access, request, { profile: 'collection-membership', owner: body.collection,
            actingSubject: body.actingSubject, idempotencyKey, requestDigest,
            createOwner: step => createAdmittedOwner(work.environment, work.account, work.access,
              request, { kind: 'collection', owner: step.owner, actingSubject: body.actingSubject,
                idempotencyKey: step.idempotencyKey, requestDigest: step.requestDigest,
                disclosure: body.disclosure, name: body.name }) });
        return Response.json({ collection: result.owner, structure: result.structure,
          revision: result.revision, receipt: result.structureReceipt, replayed: result.replayed },
        { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/collections/:id/changes', { params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, actingSubject: ref,
        operations: t.Array(operation, { minItems: 1, maxItems: 16 }) },
      { additionalProperties: false }), response: { 200: write, 202: pendingOperation, ...errors } },
    async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const collection = `https://rezics.com/id/${params.id}`;
        const structure = await ownerStructure(fuseki, collection);
        if (!structure) throw new CompositionUnavailable('Collection is unavailable');
        const result = await changeAdmittedComposition(work.environment, work.account, work.access,
          request, { structure, expectedHead: body.expectedHead, operations: body.operations,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ collection, structure, revision: result.revision,
          receipt: result.receipt, replayed: result.replayed, occurrences: result.occurrences ?? [],
          ...(result.cost ? { cost: result.cost } : {}), sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .get('/v1/collections/:id', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref, parent: t.Optional(ref),
        after: t.Optional(t.String({ maxLength: 512 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false }), response: { 200: read, ...authorizedReadProblems } },
    async ({ request, params, query }) => {
      try { return Response.json(await page(fuseki, work, request,
        `https://rezics.com/id/${params.id}`, query), { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return routeError(error); }
    })
    .get('/v1/collections/:id/revisions/:revision', {
      params: t.Object({ id: groupUuid, revision: groupUuid }),
      query: t.Object({ actingSubject: ref, parent: t.Optional(ref),
        after: t.Optional(t.String({ maxLength: 512 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false }), response: { 200: read, ...authorizedReadProblems } },
    async ({ request, params, query }) => {
      try { return Response.json(await page(fuseki, work, request,
        `https://rezics.com/id/${params.id}`, { ...query,
          revision: `https://rezics.com/id/${params.revision}` }),
      { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return routeError(error); }
    });
}
