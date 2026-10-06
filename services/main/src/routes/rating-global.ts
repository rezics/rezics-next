import { Elysia, t } from 'elysia';
import { readerLanguages } from '../modules/display-language/select.ts';
import { questionLanguagesQuery, questionReadFields } from '../modules/rating/question-presentation-schema.ts';
import { presentRatingContext } from '../modules/rating/question-presentation-read.ts';
import { pendingOperation, problemResult, sourcePosition } from '../api-contract.ts';
import { readProblems, writeProblems } from '../api-responses.ts';
import { RatingAggregateUnavailable } from '../modules/rating/aggregate.ts';
import { setAdmittedGlobalRating, createAdmittedGlobalRatingContext } from '../modules/rating/global-admitted.ts';
import { queryGlobalRatingAggregate, queryRealmGlobalSynthesis } from '../modules/rating/global-aggregate.ts';
import { globalAggregateInput, globalAggregateResult, globalContextInput, globalContextRead, globalContextWrite,
  globalObservationInput, globalObservationWrite, synthesisInput, synthesisResult } from '../modules/rating/global-api.ts';
import { GLOBAL_CONTEXT_ID, GLOBAL_OBSERVATION_ID, GLOBAL_RATING_POPULATION_OWNER, readGlobalRatingContext }
  from '../modules/rating/global.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { GRAPHS, RV, iri } from '../modules/work/activate.ts';
import { StaleRatingObservation, standingRatingSlotIri }
  from '../modules/rating/observation.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const policy = { targetGrain: 'mainVersion', scale: { min: 1, max: 5, step: 1 }, cadence: 'standing',
  population: 'global-account-principal', aggregation: 'latest-per-rater-mean', profile: GLOBAL_CONTEXT_ID } as const;

const staleRating = t.Object({ ...problemResult(409).properties,
  currentHead: t.Nullable(globalObservationInput.properties.context),
  sourcePosition: t.Nullable(sourcePosition) });

function idempotencyKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key');
  return key && /^[A-Za-z0-9:_./-]{1,128}$/.test(key) ? key : null;
}

function inventory(work: MainWorkDependencies) {
  if (!work.access.readRatingAggregateInventory || !work.access.checkRatingAggregateFence) {
    throw new RatingAggregateUnavailable('Rating inventory is unavailable');
  }
  return work.access as Required<Pick<MainWorkDependencies['access'],
    'readRatingAggregateInventory' | 'checkRatingAggregateFence'>>;
}

/** Global standing Contexts, observations, their aggregate and the named Realm/Global synthesis. */
export function globalRatingRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/global-rating-contexts', {
      body: globalContextInput,
      response: { 200: globalContextWrite, 201: globalContextWrite, 202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        const receipt = await createAdmittedGlobalRatingContext(work.environment, work.account, work.access,
          request, { question: body.question, actingSubject: body.actingSubject, idempotencyKey: key });
        return Response.json({ context: receipt.context, populationOwner: GLOBAL_RATING_POPULATION_OWNER,
          question: body.question, contextRevision: receipt.revision, ...policy,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
          replayed: receipt.replayed }, { status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/global-rating-contexts/:id', {
      params: t.Object({ id: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object(questionLanguagesQuery, { additionalProperties: false }),
      response: { 200: t.Object({ ...globalContextRead.properties, ...questionReadFields }), ...readProblems },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(work.environment.fuseki, work.environment.lineage);
        const context = await readGlobalRatingContext(work.environment, `https://rezics.com/id/${params.id}`);
        if (!context) return problem(404, 'rating_context_unavailable', 'Rating context is unavailable');
        return Response.json(await presentRatingContext(work.environment, { ...context, populationOwner: GLOBAL_RATING_POPULATION_OWNER, ...policy },
          readerLanguages(query.languages, request.headers.get('accept-language'))),
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/global-rating-observations', {
      body: globalObservationInput,
      response: { 200: globalObservationWrite, 201: globalObservationWrite, 202: pendingOperation,
        ...writeProblems, 409: t.Union([staleRating, problemResult(409)]) },
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        const receipt = await setAdmittedGlobalRating(work.environment, work.account, work.access, request, {
          context: body.context, work: body.work, mainVersion: body.mainVersion,
          expectedRevisionHead: body.expectedRevisionHead, value: body.value,
          actingSubject: body.actingSubject, idempotencyKey: key });
        await work.libraryStatus?.projectRating(body.actingSubject, body.work, body.value);
        return Response.json({ observation: receipt.observation, observationRevision: receipt.revision,
          predecessor: receipt.predecessor, context: receipt.context, work: receipt.work,
          mainVersion: receipt.mainVersion, value: receipt.value, availability: receipt.availability,
          profile: GLOBAL_OBSERVATION_ID,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
          replayed: receipt.replayed }, { status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (!(error instanceof StaleRatingObservation)) return commandError(error);
        try {
          const principal = await work.account.verify(request, ['rating:submit']);
          // The refusal reveals only this principal's head, under live Person control.
          if (!await work.access.canReadAsBaselineMember?.(principal, body.actingSubject)) {
            return problem(403, 'authority_denied', 'Authority is not admitted');
          }
          const principalId = await work.access.activePrincipalId(principal);
          if (!principalId) return problem(403, 'authority_denied', 'Authority is not admitted');
          const slot = standingRatingSlotIri(principalId, body.context, body.mainVersion);
          // One slot-leading graph lookup. Keep the revision's own position even
          // when a newer operation or an idempotent replay caused this refusal.
          const result = await work.environment.fuseki.query(`PREFIX rv: <${RV}>
            SELECT ?head ?dataEpoch ?sequence WHERE {
              GRAPH ${iri(GRAPHS.current)} { ?observation a rv:GlobalRatingObservation ;
                rv:ratingContext ${iri(body.context)} ; rv:targetMainVersion ${iri(body.mainVersion)} ;
                rv:ratingSlot ${iri(slot)} ; rv:observationHead ?head }
              OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:GlobalRatingObservationRevision ;
                rv:component ?observation ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
                FILTER NOT EXISTS { ?head a rv:ErasedRevision } } }
            } LIMIT 2`);
          const rows = result.results?.bindings ?? [], row = rows[0];
          if (rows.length > 1 || (row && (!row.head || !row.dataEpoch?.value
            || !/^[0-9]+$/.test(row.sequence?.value ?? '')))) {
            return problem(503, 'rating_revision_unavailable', 'Own rating revision position is unavailable');
          }
          if (!await work.access.canReadAsBaselineMember?.(principal, body.actingSubject)) {
            return problem(403, 'authority_denied', 'Authority is not admitted');
          }
          return Response.json({ type: 'https://rezics.com/problems/stale_head',
            title: 'Expected standing rating revision is stale', status: 409, code: 'stale_head',
            currentHead: row?.head!.value ?? null,
            sourcePosition: row ? { datasetId: 'product', dataEpoch: row.dataEpoch!.value,
              sequence: row.sequence!.value } : null },
          { status: 409, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
        } catch (readError) { return commandError(readError); }
      }
    })
    .post('/v1/global-rating-aggregates', {
      body: globalAggregateInput,
      response: { 200: globalAggregateResult, ...readProblems, 422: problemResult(422) },
    }, async ({ body }) => {
      try {
        const result = await queryGlobalRatingAggregate(work.environment, inventory(work), body);
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/rating-syntheses', {
      body: synthesisInput,
      response: { 200: synthesisResult, ...readProblems, 422: problemResult(422) },
    }, async ({ body }) => {
      try {
        const result = await queryRealmGlobalSynthesis(work.environment, inventory(work), body);
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}

export const openApiOperations = {
  '/v1/rating-syntheses': { post: { exposure: 'public' } },
  '/v1/global-rating-aggregates': { post: { exposure: 'public' } },
  '/v1/global-rating-observations': { post: { exposure: 'public' } },
  '/v1/global-rating-contexts/{id}': { get: { exposure: 'public' } },
  '/v1/global-rating-contexts': { post: { exposure: 'public' } },
} as const;
