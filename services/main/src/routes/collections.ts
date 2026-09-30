import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { bootstrapAdmittedStructureOwner } from '../modules/structure/bootstrap.ts';
import { changeAdmittedComposition } from '../modules/structure/change-admitted.ts';
import { CompositionConflict, InvalidCompositionChange, StaleCompositionHead }
  from '../modules/structure/change.ts';
import { CompositionCorrupt, CompositionUnavailable, readCompositionHeader }
  from '../modules/structure/graph.ts';
import { readVisibleCompositionPage } from '../modules/collection/visible-page.ts';
import { CollectionNameInvalid, CollectionNameStale, CollectionNameUnavailable,
  publishCollectionName, readCollectionName } from '../modules/collection/names.ts';
import type { LocalizedText } from '../modules/display-language/select.ts';
import { canReadStructureTarget, structureProfileFor } from '../modules/structure/profiles.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable }
  from '../modules/structure/tree.ts';
import { createAdmittedOwner } from '../modules/zone/owner-create.ts';
import { CollectionDisplayGroupUnavailable, saveCollectionDisplayGroupMove }
  from '../modules/collection/display-group.ts';
import { GraphLayoutConflict, GraphLayoutDenied, GraphLayoutMissing,
  GraphLayoutStale, GraphLayoutUnavailable } from '../modules/graph-layout/store.ts';
import { checkDynamicQuery, DynamicCollectionStale, DynamicCollectionUnavailable,
  executeDynamicDefinition, InvalidDynamicCollection, readCapturedSnapshot,
  readDynamicDefinition, reviseDynamicDefinition }
  from '../modules/collection/dynamic.ts';
import { InvalidPublicQuery, PublicQueryBudgetExceeded, PublicQueryUnavailable }
  from '../modules/work/search-public.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { GRAPHS, hash, iri } from '../modules/work/activate.ts';
import { pendingOperation } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import type { GraphLayoutDependencies } from './graph-layouts.ts';
import { problem } from './problems.ts';
import { resourceTargetReader } from '../modules/target/resolve.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
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
  sourcePosition });
const errors = workReadProblems;

interface DynamicDefinitionBody { definition: string; name: string; language?: string;
  disclosure: 'public' | 'private'; actingSubject: string;
  query: { phrase: string; language: string | null;
    context?: { kind: 'realm-local'; id: string } }; resultBudget: number }
interface CaptureBody { definitionRevision: string; collection: string; name: string; language?: string;
  disclosure: 'public' | 'private'; actingSubject: string }

export const openApiOperations = {
  '/v1/collections': { post: { bearer: true, idempotencyKey: true } },
  '/v1/collections/{id}/name': { get: { bearer: false },
    put: { bearer: true, idempotencyKey: true } },
  '/v1/collections/{id}/changes': { post: { bearer: true, idempotencyKey: true } },
  '/v1/collections/{id}/display-groups/{group}/moves': {
    post: { bearer: true, idempotencyKey: true } },
  '/v1/collections/{id}': { get: { bearer: true } },
  '/v1/collections/{id}/revisions/{revision}': { get: { bearer: true } },
  '/v1/collection-definitions': { post: { bearer: true, idempotencyKey: true } },
  '/v1/collection-definitions/{id}': { get: { bearer: true } },
  '/v1/collection-definitions/{id}/revisions': { post: { bearer: true, idempotencyKey: true } },
  '/v1/collection-definitions/{id}/queries': { post: { bearer: true } },
  '/v1/collection-definitions/{id}/captures': { post: { bearer: true, idempotencyKey: true } },
} as const;

function key(request: Request) {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
}

function routeError(error: unknown): Response {
  if (error instanceof CollectionNameInvalid) return problem(400, 'invalid_collection_name', error.message);
  if (error instanceof CollectionNameStale) return problem(409, 'stale_collection_name', error.message);
  if (error instanceof CollectionNameUnavailable) return problem(404, 'collection_name_unavailable', error.message);
  if (error instanceof InvalidCompositionChange) return problem(400, 'invalid_collection_change', error.message);
  if (error instanceof InvalidDynamicCollection || error instanceof InvalidPublicQuery) {
    return problem(400, 'invalid_dynamic_collection', error.message);
  }
  if (error instanceof PublicQueryBudgetExceeded) return problem(422, 'collection_query_budget', error.message);
  if (error instanceof PublicQueryUnavailable) return problem(503, 'collection_query_unavailable',
    'Collection query is unavailable');
  if (error instanceof DynamicCollectionUnavailable) return problem(404, 'collection_definition_unavailable',
    'Dynamic Collection is unavailable');
  if (error instanceof DynamicCollectionStale) return problem(409, 'stale_collection_definition',
    error.message);
  if (error instanceof CollectionDisplayGroupUnavailable || error instanceof GraphLayoutMissing) {
    return problem(404, 'display_group_unavailable', 'Collection display group is unavailable');
  }
  if (error instanceof GraphLayoutDenied) return problem(403, 'display_group_denied',
    'Display group authority is missing');
  if (error instanceof GraphLayoutConflict || error instanceof GraphLayoutStale) {
    return problem(409, 'display_group_conflict', 'Display group revision conflicts');
  }
  if (error instanceof GraphLayoutUnavailable) return problem(503, 'display_group_unavailable',
    'Display group owner is unavailable');
  if (error instanceof StaleCompositionHead || error instanceof CompositionConflict) {
    return problem(409, 'collection_conflict', error.message);
  }
  if (error instanceof CompositionUnavailable) return problem(404, 'collection_unavailable', 'Collection is unavailable');
  if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
    || error instanceof StructureObjectUnavailable) {
    return problem(503, 'collection_unavailable', 'Collection history is unavailable');
  }
  return workReadError(error);
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
  const result = await readVisibleCompositionPage(work.environment, { structure,
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.parent ? { parent: input.parent } : {}), ...(input.after ? { after: input.after } : {}),
    limit: input.limit ?? 50, visible: item => item.role !== 'member' || !!item.target,
    canReadTarget: async target => {
      return mayReadTargets && canReadStructureTarget(structureProfileFor(header.profile), {
        access: work.access, principal: targetPrincipal, actingSubject: input.actingSubject, target,
        targetReader: resourceTargetReader(work, request, input.actingSubject) });
    } });
  // The shared page retains hidden uses for exact owner history. This projection
  // returns only disclosed members and has no hidden count or timing counters.
  return { collection, structure, revision: result.revision, predecessor: result.predecessor,
    occurrences: result.occurrences, next: result.next, sourcePosition: result.sourcePosition };
}

export function collectionRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const layouts = (work as MainWorkDependencies & GraphLayoutDependencies).graphLayouts;
  if (work.structureObjects) (work.environment as typeof work.environment
    & { structureObjects?: typeof work.structureObjects }).structureObjects = work.structureObjects;
  return new Elysia()
    .post('/v1/collection-definitions', { body: t.Object({ definition: ref,
      name: t.String({ minLength: 1, maxLength: 300 }), language: t.Optional(t.String({ minLength: 2, maxLength: 35 })), disclosure: t.Union([
        t.Literal('public'), t.Literal('private') ]), actingSubject: ref,
      query: t.Object({ phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([t.String({ minLength: 2, maxLength: 35 }), t.Null()]),
        context: t.Optional(t.Object({ kind: t.Literal('realm-local'), id: ref },
          { additionalProperties: false })) }, { additionalProperties: false }),
      resultBudget: t.Integer({ minimum: 1, maximum: 16 }) }, { additionalProperties: false }),
      response: { 200: t.Any(), 201: t.Any(), 202: pendingOperation, ...errors } },
    async ({ request, body }: { request: Request; body: DynamicDefinitionBody }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        checkDynamicQuery(body.query, body.resultBudget);
        const requestDigest = hash(JSON.stringify({ family: 'dynamic-collection-create-v1', ...body }));
        const result = await createAdmittedOwner(work.environment, work.account, work.access,
          request, { kind: 'definition', owner: body.definition, actingSubject: body.actingSubject,
            idempotencyKey, requestDigest, disclosure: body.disclosure, name: body.name, language: body.language,
            query: body.query, resultBudget: body.resultBudget });
        return Response.json({ definition: result.owner, revision: result.revision,
          receipt: result.receipt, replayed: result.replayed },
        { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .get('/v1/collection-definitions/:id', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref, revision: t.Optional(ref) },
        { additionalProperties: false }), response: { 200: t.Any(), ...authorizedReadProblems, ...workReadProblems } },
    async ({ request, params, query }: { request: Request; params: { id: string };
      query: { actingSubject: string; revision?: string } }) => {
      try {
        const definition = `https://rezics.com/id/${params.id}`;
        const principal = await work.account.verify(request, ['semantic:read']);
        if (!await work.access.canReadSemanticResource?.(principal, query.actingSubject, definition)) {
          throw new DynamicCollectionUnavailable('Dynamic Collection is unavailable');
        }
        return Response.json(await readDynamicDefinition(work.environment, definition, query.revision),
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/collection-definitions/:id/revisions', { params: t.Object({ id: groupUuid }),
      body: t.Object({ expectedHead: ref, actingSubject: ref,
        query: t.Object({ phrase: t.String({ minLength: 2, maxLength: 80 }),
          language: t.Union([t.String({ minLength: 2, maxLength: 35 }), t.Null()]),
          context: t.Optional(t.Object({ kind: t.Literal('realm-local'), id: ref },
            { additionalProperties: false })) }, { additionalProperties: false }),
        resultBudget: t.Integer({ minimum: 1, maximum: 16 }) },
      { additionalProperties: false }), response: { 200: t.Any(), 202: pendingOperation, ...errors } },
    async ({ request, params, body }: { request: Request; params: { id: string };
      body: { expectedHead: string; actingSubject: string; query: DynamicDefinitionBody['query'];
        resultBudget: number } }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await reviseDynamicDefinition(work.environment, work.account, work.access,
          request, { definition: `https://rezics.com/id/${params.id}`,
            expectedHead: body.expectedHead, actingSubject: body.actingSubject,
            idempotencyKey, query: body.query, resultBudget: body.resultBudget });
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/collection-definitions/:id/queries', { params: t.Object({ id: groupUuid }),
      body: t.Object({ actingSubject: ref, revision: t.Optional(ref) },
        { additionalProperties: false }), response: { 200: t.Any(), ...errors } },
    async ({ request, params, body }: { request: Request; params: { id: string };
      body: { actingSubject: string; revision?: string } }) => {
      try {
        const definition = `https://rezics.com/id/${params.id}`;
        const principal = await work.account.verify(request, ['semantic:read']);
        if (!await work.access.canReadSemanticResource?.(principal, body.actingSubject, definition)) {
          throw new DynamicCollectionUnavailable('Dynamic Collection is unavailable');
        }
        const saved = await readDynamicDefinition(work.environment, definition, body.revision);
        return Response.json(await executeDynamicDefinition(work.environment, saved),
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/collection-definitions/:id/captures', { params: t.Object({ id: groupUuid }),
      body: t.Object({ definitionRevision: ref, collection: ref,
        name: t.String({ minLength: 1, maxLength: 300 }),
        language: t.Optional(t.String({ minLength: 2, maxLength: 35 })),
        disclosure: t.Union([t.Literal('public'), t.Literal('private')]), actingSubject: ref },
      { additionalProperties: false }), response: { 200: t.Any(), 201: t.Any(),
        202: pendingOperation, ...errors } },
    async ({ request, params, body }: { request: Request; params: { id: string };
      body: CaptureBody }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const definition = `https://rezics.com/id/${params.id}`;
        const principal = await work.account.verify(request, ['semantic:read']);
        if (!await work.access.canReadSemanticResource?.(principal, body.actingSubject, definition)) {
          throw new DynamicCollectionUnavailable('Dynamic Collection is unavailable');
        }
        const saved = await readDynamicDefinition(work.environment, definition, body.definitionRevision);
        let snapshot = await readCapturedSnapshot(work.environment, body.collection);
        if (!snapshot) {
          const executed = await executeDynamicDefinition(work.environment, saved);
          snapshot = { from: saved.revision, coverage: executed.coverage,
            members: executed.members, sourcePosition: executed.sourcePosition };
        }
        if (snapshot.from !== saved.revision) throw new InvalidDynamicCollection('capture source differs');
        const requestDigest = hash(JSON.stringify({ family: 'collection-capture-v1',
          definition, ...body }));
        const captured = await bootstrapAdmittedStructureOwner(work.environment, work.account,
          work.access, request, { profile: 'collection-membership', owner: body.collection,
            actingSubject: body.actingSubject, idempotencyKey, requestDigest,
            createOwner: step => createAdmittedOwner(work.environment, work.account, work.access,
              request, { kind: 'collection', owner: step.owner,
                actingSubject: body.actingSubject, idempotencyKey: step.idempotencyKey,
                requestDigest: step.requestDigest, disclosure: body.disclosure,
                name: body.name, language: body.language, capture: snapshot }) });
        let revision = captured.revision;
        let receipt = captured.structureReceipt;
        let replayed = captured.replayed;
        if (snapshot.members.length) {
          const inserted = await changeAdmittedComposition(work.environment, work.account, work.access,
            request, { structure: captured.structure, expectedHead: captured.revision,
              actingSubject: body.actingSubject,
              idempotencyKey: `capture-members:${hash(idempotencyKey)}`,
              operations: snapshot.members.map(member => ({ op: 'insert' as const,
                parent: captured.structure, position: 'last' as const, role: 'member' as const,
                target: member.work, selection: { mode: 'follow-context' as const } })) },
            resourceTargetReader(work, request, body.actingSubject));
          if (!inserted.revision) throw new DynamicCollectionUnavailable('capture revision is unavailable');
          revision = inserted.revision;
          receipt = inserted.receipt;
          replayed = inserted.replayed;
        }
        return Response.json({ collection: body.collection, structure: captured.structure,
          revision, receipt, replayed, definitionRevision: snapshot.from,
          coverage: snapshot.coverage, members: snapshot.members.length,
          sourcePosition: snapshot.sourcePosition },
        { status: replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/collections', { body: t.Object({ collection: ref, name: t.String({ minLength: 1, maxLength: 300 }),
      language: t.Optional(t.String({ minLength: 2, maxLength: 35 })),
      disclosure: t.Union([t.Literal('public'), t.Literal('private')]), actingSubject: ref },
    { additionalProperties: false }), response: { 200: write, 201: write, 202: pendingOperation, ...errors } },
    async ({ request, body }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const requestDigest = hash(JSON.stringify({ family: 'collection-create-v1',
          collection: body.collection, name: body.name, disclosure: body.disclosure,
          ...(body.language !== undefined ? { language: body.language } : {}),
          actingSubject: body.actingSubject }));
        const result = await bootstrapAdmittedStructureOwner(work.environment, work.account,
          work.access, request, { profile: 'collection-membership', owner: body.collection,
            actingSubject: body.actingSubject, idempotencyKey, requestDigest,
            createOwner: step => createAdmittedOwner(work.environment, work.account, work.access,
              request, { kind: 'collection', owner: step.owner, actingSubject: body.actingSubject,
                idempotencyKey: step.idempotencyKey, requestDigest: step.requestDigest,
                disclosure: body.disclosure, name: body.name, language: body.language }) });
        return Response.json({ collection: result.owner, structure: result.structure,
          revision: result.revision, receipt: result.structureReceipt, replayed: result.replayed },
        { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .get('/v1/collections/:id/name', { params: t.Object({ id: groupUuid }),
      response: { 200: t.Any(), ...errors } }, async ({ params }: { params: { id: string } }) => {
      try { return Response.json(await readCollectionName(work.environment,
        `https://rezics.com/id/${params.id}`), { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return routeError(error); }
    })
    .put('/v1/collections/:id/name', { params: t.Object({ id: groupUuid }),
      body: t.Object({ profile: t.Literal('collection-public-name-v1'),
        expectedHead: t.Nullable(ref), actingSubject: ref,
        name: t.Object({ original: t.String({ minLength: 2, maxLength: 35 }),
          labels: t.Record(t.String(), t.String({ minLength: 1, maxLength: 300 })) },
        { additionalProperties: false }) }, { additionalProperties: false }),
      response: { 200: t.Any(), 201: t.Any(), 202: pendingOperation, ...errors } },
    async ({ request, params, body }: { request: Request; params: { id: string };
      body: { profile: 'collection-public-name-v1'; expectedHead: string | null;
        actingSubject: string; name: LocalizedText } }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      try {
        const result = await publishCollectionName(work.environment, work.account, work.access,
          request, { collection: `https://rezics.com/id/${params.id}`,
            actingSubject: body.actingSubject, expectedHead: body.expectedHead,
            name: body.name, idempotencyKey });
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
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
            actingSubject: body.actingSubject, idempotencyKey }, resourceTargetReader(work, request, body.actingSubject));
        return Response.json({ collection, structure, revision: result.revision,
          receipt: result.receipt, replayed: result.replayed, occurrences: result.occurrences ?? [],
          ...(result.cost ? { cost: result.cost } : {}), sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .post('/v1/collections/:id/display-groups/:group/moves', {
      params: t.Object({ id: groupUuid, group: t.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }) }),
      body: t.Object({ layout: ref,
        expectedHead: t.String({ pattern: '^[0-9a-f-]{36}$' }), actingSubject: ref,
        placement: t.Object({ x: t.Number({ minimum: -1_000_000, maximum: 1_000_000 }),
          y: t.Number({ minimum: -1_000_000, maximum: 1_000_000 }),
          collapsed: t.Boolean() }, { additionalProperties: false }) },
      { additionalProperties: false }), response: { 200: t.Any(), 202: pendingOperation, ...errors } },
    async ({ request, params, body }: { request: Request; params: { id: string; group: string };
      body: { layout: string; expectedHead: string; actingSubject: string;
        placement: { x: number; y: number; collapsed: boolean } } }) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      if (!layouts) return problem(503, 'display_group_unavailable', 'Display group owner is unavailable');
      try {
        const principal = await work.account.verify(request, ['work:edit']);
        const result = await saveCollectionDisplayGroupMove(layouts,
          { principal, actingSubject: body.actingSubject }, {
            collection: `https://rezics.com/id/${params.id}`, layout: body.layout,
            expectedHead: body.expectedHead, group: params.group,
            placement: body.placement, idempotencyKey });
        return Response.json({ profile: 'graph-layout-v1', ...result },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return routeError(error); }
    })
    .get('/v1/collections/:id', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: ref, parent: t.Optional(ref),
        after: t.Optional(t.String({ maxLength: 512 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })) },
      { additionalProperties: false }), response: { 200: read, ...authorizedReadProblems, ...workReadProblems } },
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
      { additionalProperties: false }), response: { 200: read, ...authorizedReadProblems, ...workReadProblems } },
    async ({ request, params, query }) => {
      try { return Response.json(await page(fuseki, work, request,
        `https://rezics.com/id/${params.id}`, { ...query,
          revision: `https://rezics.com/id/${params.revision}` }),
      { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return routeError(error); }
    });
}
