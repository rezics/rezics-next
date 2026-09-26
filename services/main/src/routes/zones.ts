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
import { StructureObjectCorrupt, StructureObjectUnavailable } from '../modules/structure/tree.ts';
import { createAdmittedOwner } from '../modules/zone/owner-create.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { GRAPHS, hash, iri } from '../modules/work/activate.ts';
import { problemResult, pendingOperation } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

const ref = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const disclosure = t.Union([t.Literal('public'), t.Literal('private')]);
const sourcePosition = t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() });
const cost = t.Object({ pagesRead: t.Integer(), pagesWritten: t.Integer(),
  placementsWritten: t.Integer(), segmentsWritten: t.Integer(), rebalanced: t.Integer() });
const write = t.Object({ zone: ref, navigation: ref, revision: ref, receipt: t.String(),
  replayed: t.Boolean(), occurrences: t.Optional(t.Array(ref)), cost: t.Optional(cost),
  sourcePosition: t.Optional(sourcePosition) });
const read = t.Object({ zone: ref, navigation: ref, revision: ref,
  predecessor: t.Nullable(ref), mounts: t.Array(t.Any()), next: t.Nullable(t.String()),
  cost: t.Object({ pagesRead: t.Integer(), pagesWritten: t.Integer(), authorizationChecks: t.Integer() }),
  sourcePosition });
const errors = { 400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
  404: problemResult(404), 409: problemResult(409), 500: problemResult(500),
  503: problemResult(503) };

export const openApiOperations = {
  '/v1/zones': { post: { bearer: true, idempotencyKey: true } },
  '/v1/zones/{id}/mounts': { post: { bearer: true, idempotencyKey: true } },
  '/v1/zones/{id}/mounts/{occurrence}': { delete: { bearer: true, idempotencyKey: true } },
  '/v1/zones/{id}': { get: { bearer: true } },
  '/v1/zones/{id}/revisions/{revision}': { get: { bearer: true } },
} as const;

function key(request: Request) {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
}

function routeError(error: unknown): Response {
  if (error instanceof InvalidCompositionChange) return problem(400, 'invalid_zone_change', error.message);
  if (error instanceof StaleCompositionHead || error instanceof CompositionConflict) {
    return problem(409, 'zone_conflict', error.message);
  }
  if (error instanceof CompositionUnavailable) return problem(404, 'zone_unavailable', 'Zone is unavailable');
  if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
    || error instanceof StructureObjectUnavailable) {
    return problem(503, 'zone_unavailable', 'Zone history is unavailable');
  }
  return commandError(error);
}

async function navigation(fuseki: FusekiClient, zone: string): Promise<string | null> {
  const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?navigation WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} a rv:Zone ; rv:zoneState rv:Active ;
      rv:navigation ?navigation . } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  return rows.length === 1 ? rows[0]?.navigation?.value ?? null : null;
}

async function zonePage(fuseki: FusekiClient, work: MainWorkDependencies, request: Request,
  zone: string, input: { actingSubject: string; revision?: string; after?: string; limit?: number }) {
  await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
  const principal = await work.account.verify(request, ['semantic:read']);
  if (!await work.access.canReadSemanticResource?.(principal, input.actingSubject, zone)) {
    throw new CompositionUnavailable('Zone is unavailable');
  }
  const structure = await navigation(fuseki, zone);
  if (!structure) throw new CompositionUnavailable('Zone is unavailable');
  const header = await readCompositionHeader(work.environment, structure);
  if (!header || header.profile !== 'zone-navigation' || header.owner !== zone) {
    throw new CompositionUnavailable('Zone is unavailable');
  }
  let authorizationChecks = 0;
  const result = await readCompositionPage(work.environment, { structure,
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.after ? { after: input.after } : {}), limit: input.limit ?? 50,
    canReadTarget: async target => {
      authorizationChecks++;
      return canReadStructureTarget(structureProfileFor(header.profile), {
        access: work.access, principal, actingSubject: input.actingSubject, target });
    } });
  const hidden = result.occurrences.some(item => item.role === 'mount' && !item.target);
  return { zone, navigation: structure, revision: result.revision,
    predecessor: result.predecessor,
    mounts: result.occurrences.filter(item => item.role === 'mount' && item.target),
    next: hidden ? null : result.next, sourcePosition: result.sourcePosition,
    cost: { ...result.cost, authorizationChecks } };
}

export function zoneRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  if (work.structureObjects) (work.environment as typeof work.environment
    & { structureObjects?: typeof work.structureObjects }).structureObjects = work.structureObjects;
  return new Elysia()
    .post('/v1/zones', { body: t.Object({ zone: ref, space: ref, disclosure, actingSubject: ref },
      { additionalProperties: false }), response: { 200: write, 201: write, 202: pendingOperation, ...errors } },
    async ({ request, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const requestDigest = hash(JSON.stringify({ family: 'zone-create-v1', ...body }));
        const result = await bootstrapAdmittedStructureOwner(work.environment, work.account,
          work.access, request, { profile: 'zone-navigation', owner: body.zone,
            actingSubject: body.actingSubject, idempotencyKey, requestDigest,
            createOwner: step => createAdmittedOwner(work.environment, work.account, work.access,
              request, { kind: 'zone', owner: step.owner, actingSubject: body.actingSubject,
                idempotencyKey: step.idempotencyKey, requestDigest: step.requestDigest,
                space: body.space, disclosure: body.disclosure }) });
        return Response.json({ zone: result.owner, navigation: result.structure,
          revision: result.revision, receipt: result.structureReceipt, replayed: result.replayed },
        { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/zones/:id/mounts', { params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, collection: ref, routeSegment: t.String({
        pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 }),
        disclosure, presentation: t.Optional(t.String({ format: 'uri' })),
        position: t.Optional(t.Union([t.Literal('first'), t.Literal('last'),
          t.Object({ after: ref }, { additionalProperties: false })])), actingSubject: ref },
      { additionalProperties: false }), response: { 200: write, 202: pendingOperation, ...errors } },
    async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const zone = `https://rezics.com/id/${params.id}`;
        const structure = await navigation(fuseki, zone);
        if (!structure) throw new CompositionUnavailable('Zone is unavailable');
        const result = await changeAdmittedComposition(work.environment, work.account, work.access,
          request, { structure, expectedHead: body.expectedHead, actingSubject: body.actingSubject,
            idempotencyKey, operations: [{ op: 'insert', parent: structure,
              position: body.position ?? 'last', role: 'mount', target: body.collection,
              qualifier: { type: 'zone-mount', zone, routeSegment: body.routeSegment,
                disclosure: body.disclosure,
                ...(body.presentation ? { presentation: body.presentation } : {}) } }] });
        return Response.json({ zone, navigation: structure, revision: result.revision,
          receipt: result.receipt, replayed: result.replayed, occurrences: result.occurrences ?? [],
          ...(result.cost ? { cost: result.cost } : {}), sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .delete('/v1/zones/:id/mounts/:occurrence', {
      params: t.Object({ id: groupUuid, occurrence: groupUuid }),
      body: t.Object({ expectedHead: ref, actingSubject: ref }, { additionalProperties: false }),
      response: { 200: write, 202: pendingOperation, ...errors } },
    async ({ request, params, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const zone = `https://rezics.com/id/${params.id}`;
        const structure = await navigation(fuseki, zone);
        if (!structure) throw new CompositionUnavailable('Zone is unavailable');
        const result = await changeAdmittedComposition(work.environment, work.account, work.access,
          request, { structure, expectedHead: body.expectedHead, actingSubject: body.actingSubject,
            idempotencyKey, operations: [{ op: 'remove',
              occurrence: `https://rezics.com/id/${params.occurrence}` }] });
        return Response.json({ zone, navigation: structure, revision: result.revision,
          receipt: result.receipt, replayed: result.replayed,
          ...(result.cost ? { cost: result.cost } : {}), sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .get('/v1/zones/:id', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref, after: t.Optional(t.String({ maxLength: 512 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false }), response: { 200: read, ...authorizedReadProblems } },
    async ({ request, params, query }) => {
      try { return Response.json(await zonePage(fuseki, work, request,
        `https://rezics.com/id/${params.id}`, query), { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return routeError(error); }
    })
    .get('/v1/zones/:id/revisions/:revision', {
      params: t.Object({ id: groupUuid, revision: groupUuid }),
      query: t.Object({ actingSubject: ref, after: t.Optional(t.String({ maxLength: 512 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false }), response: { 200: read, ...authorizedReadProblems } },
    async ({ request, params, query }) => {
      try { return Response.json(await zonePage(fuseki, work, request,
        `https://rezics.com/id/${params.id}`, { ...query,
          revision: `https://rezics.com/id/${params.revision}` }),
      { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return routeError(error); }
    });
}
