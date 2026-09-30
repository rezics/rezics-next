import { Elysia, t } from 'elysia';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { readProblems, writeProblems } from '../api-responses.ts';
import { RatingAggregateUnavailable } from '../modules/rating/aggregate.ts';
import { setAdmittedGlobalRating, createAdmittedGlobalRatingContext } from '../modules/rating/global-admitted.ts';
import { queryGlobalRatingAggregate, queryRealmGlobalSynthesis } from '../modules/rating/global-aggregate.ts';
import { globalAggregateInput, globalAggregateResult, globalContextInput, globalContextRead, globalContextWrite,
  globalObservationInput, globalObservationWrite, synthesisInput, synthesisResult } from '../modules/rating/global-api.ts';
import { GLOBAL_CONTEXT_ID, GLOBAL_OBSERVATION_ID, GLOBAL_RATING_POPULATION_OWNER, readGlobalRatingContext }
  from '../modules/rating/global.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const policy = { targetGrain: 'mainVersion', scale: { min: 1, max: 5, step: 1 }, cadence: 'standing',
  population: 'global-account-principal', aggregation: 'latest-per-rater-mean', profile: GLOBAL_CONTEXT_ID } as const;

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
      response: { 200: globalContextRead, ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(work.environment.fuseki, work.environment.lineage);
        const context = await readGlobalRatingContext(work.environment, `https://rezics.com/id/${params.id}`);
        if (!context) return problem(404, 'rating_context_unavailable', 'Rating context is unavailable');
        return Response.json({ ...context, populationOwner: GLOBAL_RATING_POPULATION_OWNER, ...policy },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/global-rating-observations', {
      body: globalObservationInput,
      response: { 200: globalObservationWrite, 201: globalObservationWrite, 202: pendingOperation, ...writeProblems },
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
      } catch (error) { return commandError(error); }
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
