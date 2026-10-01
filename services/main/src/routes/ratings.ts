import { Elysia, t } from 'elysia';
import { DAILY_CONTEXT_PROFILE, DAILY_CADENCE, DAILY_OBSERVATION_PROFILE, DAILY_OBSERVATION_ID,
  dailyRatingSlotIri, canonicalRatingTimeZone } from '../modules/rating/calendar.ts';
import { readDailyRevisionPeriod } from '../modules/rating/daily-period.ts';
import { queryExperienceRatingAggregate } from '../modules/rating/experience-aggregate.ts';
import { experienceAggregateInput, experienceAggregateResult, experienceContextDefaultInput,
  experienceContextDefaultResult } from '../modules/rating/aggregate-api.ts';
import { EXPERIENCE_CONTEXT_ID, EXPERIENCE_CONTEXT_PROFILE, EXPERIENCE_CADENCE,
  EXPERIENCE_OBSERVATION_ID, EXPERIENCE_OBSERVATION_PROFILE, OCCASION_PATTERN,
  experienceRatingIdentity, readExperienceRevision } from '../modules/rating/experience.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { readComponentState } from '../modules/work/history.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { iri } from '../modules/work/activate.ts';
import { createAdmittedRatingContext } from '../modules/rating/context-admitted.ts';
import { setAdmittedRatingDefaultPolicy } from '../modules/rating/policy-admitted.ts';
import { RatingPolicyUnavailable, readExactRatingPolicyRevision, readRatingPolicyBasis }
  from '../modules/rating/policy.ts';
import { REALM_STANDING_RATING_CONTEXT_PROFILE, RATING_STANDING_CADENCE,
  RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY } from '../modules/rating/context.ts';
import { setAdmittedStandingRating } from '../modules/rating/observation-admitted.ts';
import { sameRatingInstant, standingRatingSlotIri, STANDING_RATING_OBSERVATION_PROFILE }
  from '../modules/rating/observation.ts';
import { RatingAggregateUnavailable } from '../modules/rating/aggregate.ts';
import { queryRealmStandingAggregate } from '../modules/rating/global-aggregate.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, dailyRatingContextWriteResult, dailyRatingContextReadResult,
  dailyRatingObservationWriteResult, dailyRatingObservationReadResult,
  experienceRatingContextWriteResult, experienceRatingContextReadResult,
  experienceRatingObservationWriteResult, experienceRatingObservationReadResult,
  ratingAggregateResult, ratingContextReadResult, ratingContextWriteResult,
  ratingPolicyReadResult, ratingPolicyWriteResult, ratingObservationReadResult,
  ratingObservationWriteResult, readProblems, writeProblems } from '../api-responses.ts';
import { classifyRatingGrain, createAdmittedReleaseRatingContext, readReleaseRatingContext,
  readReleaseRatingRevision, RatingTargetGrainMismatch, RELEASE_CONTEXT_ID, RELEASE_OBSERVATION_ID,
  setAdmittedReleaseRating } from '../modules/rating/release.ts';
import { queryReleaseRatingAggregate, RELEASE_AGGREGATE_PROFILE } from '../modules/rating/release-aggregate.ts';
import { releaseAggregateInput, releaseAggregateResult, releaseRatingContextInput,
  releaseRatingContextReadResult, releaseRatingContextWriteResult, releaseRatingObservationInput,
  releaseRatingObservationReadResult, releaseRatingObservationWriteResult } from '../modules/rating/release-api.ts';
import { RatingObservationUnavailable } from '../modules/rating/observation.ts';
import { workRead, WorkReadMissing } from '../modules/work/read-session.ts';
import { targetRead, TargetNotBound } from '../modules/target/resolve.ts';
import { readId } from '../modules/work/read-contract.ts';
import { createAdmittedTargetRatingContext, setAdmittedTargetRating, readTargetRatingContext,
  resolveRatingTarget, readTargetRatingRevision, TARGET_CONTEXT_ID, TARGET_OBSERVATION_ID } from '../modules/rating/target.ts';
import { queryTargetRatingAggregate, TARGET_AGGREGATE_PROFILE } from '../modules/rating/target-aggregate.ts';
import { targetAggregateInput, targetAggregateResult, targetRatingContextInput,
  targetRatingContextReadResult, targetRatingContextWriteResult, targetRatingObservationInput,
  targetRatingObservationWriteResult, targetRatingObservationReadResult } from '../modules/rating/target-api.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

/** A MainVersion target and an exact FixedRelease target are never interchangeable. */
function ratingError(error: unknown): Response {
  if (error instanceof TargetNotBound) return problem(422, error.code, error.message);
  if (error instanceof WorkReadMissing) return problem(404, 'resource_unavailable', error.message);
  if (error instanceof RatingTargetGrainMismatch) {
    return problem(422, 'rating_target_grain_mismatch', 'Rating target grain differs from the Context');
  }
  return commandError(error);
}

export function ratingRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/rating-aggregates', {
      body: t.Union([t.Object({ profile: t.Literal('realm-standing-latest-mean-v1'),
        context: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }), experienceAggregateInput, experienceContextDefaultInput,
      releaseAggregateInput, targetAggregateInput]),
      response: { 200: t.Union([ratingAggregateResult, experienceAggregateResult,
        experienceContextDefaultResult, releaseAggregateResult, targetAggregateResult]), ...readProblems, 422: problemResult(422) },
    }, async ({ body, request }) => {
      try {
        if (body.profile === TARGET_AGGREGATE_PROFILE) {
          if (!work.targetRatingInventory) throw new RatingAggregateUnavailable('Target inventory unavailable');
          const result = await workRead(work, request, { actingSubject: body.actingSubject }, async session => {
            await resolveRatingTarget(session, body.context, body.target);
            return queryTargetRatingAggregate(work.environment, work.targetRatingInventory!, body);
          });
          return Response.json(result, { headers: { 'cache-control': 'no-store' } });
        }
        if (body.profile === RELEASE_AGGREGATE_PROFILE) {
          if (!work.releaseRatingInventory) {
            throw new RatingAggregateUnavailable('Release Rating inventory is unavailable');
          }
          const result = await queryReleaseRatingAggregate(work.environment, work.releaseRatingInventory,
            { context: body.context, release: body.release })
            .catch(error => error instanceof RatingAggregateUnavailable
              ? classifyRatingGrain(work.environment, body.context, 'FixedRelease', error) : Promise.reject(error));
          return Response.json(result, { headers: { 'cache-control': 'no-store' } });
        }
        if (body.profile !== 'realm-standing-latest-mean-v1') {
          if (!work.access.readRatingAggregateInventory || !work.access.checkRatingAggregateFence) {
            throw new RatingAggregateUnavailable('Rating inventory is unavailable');
          }
          const result = await queryExperienceRatingAggregate(work.environment,
            work.access as Required<MainWorkDependencies['access']>, body)
            .catch(error => error instanceof RatingAggregateUnavailable
              ? classifyRatingGrain(work.environment, body.context, 'MainVersion', error) : Promise.reject(error));
          return Response.json(result, { headers: { 'cache-control': 'no-store' } });
        }
        if (!work.access.readRatingAggregateInventory || !work.access.checkRatingAggregateFence) {
          throw new RatingAggregateUnavailable('Rating inventory is unavailable');
        }
        const result = await queryRealmStandingAggregate(work.environment,
          work.access as Required<MainWorkDependencies['access']>,
          { context: body.context, work: body.work, mainVersion: body.mainVersion })
          .catch(error => error instanceof RatingAggregateUnavailable
            ? classifyRatingGrain(work.environment, body.context, 'MainVersion', error) : Promise.reject(error));
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return ratingError(error); }
    })
    .post('/v1/rating-observations', {
      body: t.Union([t.Object({ profile: t.Union([t.Literal('realm-standing-rating-observation-v1'),
        t.Literal('realm-daily-rating-observation-v1')]),
        context: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedRevisionHead: t.Union([
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }), t.Null()]),
        value: t.Union([t.Integer({ minimum: 1, maximum: 10 }), t.Null()]),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }), t.Object({ profile: t.Literal(EXPERIENCE_OBSERVATION_ID),
        context: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedRevisionHead: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        value: t.Nullable(t.Integer({ minimum: 1, maximum: 10 })),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        occasion: t.String({ pattern: OCCASION_PATTERN }),
      }, { additionalProperties: false }), releaseRatingObservationInput, targetRatingObservationInput]),
      response: { 200: t.Union([ratingObservationWriteResult, dailyRatingObservationWriteResult, experienceRatingObservationWriteResult,
        releaseRatingObservationWriteResult, targetRatingObservationWriteResult]),
        201: t.Union([ratingObservationWriteResult, dailyRatingObservationWriteResult, experienceRatingObservationWriteResult,
          releaseRatingObservationWriteResult, targetRatingObservationWriteResult]),
        202: pendingOperation, ...writeProblems, 422: problemResult(422) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      if (body.profile === TARGET_OBSERVATION_ID) {
        try {
          const principal = await work.account.verify(request, ['rating:submit']);
          const target = await targetRead(work.environment,
            { access: work.access, principal, actingSubject: body.actingSubject },
            session => resolveRatingTarget(session, body.context, body.target));
          const receipt = await setAdmittedTargetRating(work.environment, work.account, work.access,
            request, { ...body, idempotencyKey }, target);
          return Response.json({ profile: TARGET_OBSERVATION_ID, context: receipt.context, target: receipt.target,
            observation: receipt.observation, observationRevision: receipt.revision, predecessor: receipt.predecessor,
            value: receipt.value, availability: receipt.availability, replayed: receipt.replayed,
            sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence } },
          { status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
        } catch (error) { return ratingError(error); }
      }
      if (body.profile === RELEASE_OBSERVATION_ID) {
        try {
          const receipt = await setAdmittedReleaseRating(work.environment, work.account, work.access,
            request, { context: body.context, work: body.work, mainVersion: body.mainVersion,
              release: body.release, expectedRevisionHead: body.expectedRevisionHead,
              value: body.value, actingSubject: body.actingSubject, idempotencyKey })
            .catch(error => error instanceof RatingObservationUnavailable
              ? classifyRatingGrain(work.environment, body.context, 'FixedRelease', error) : Promise.reject(error));
          return Response.json({ observation: receipt.observation,
            observationRevision: receipt.revision, predecessor: receipt.predecessor,
            context: receipt.context, work: receipt.work, mainVersion: receipt.mainVersion,
            release: receipt.release, value: receipt.value, availability: receipt.availability,
            profile: RELEASE_OBSERVATION_ID,
            sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
              sequence: receipt.sequence }, replayed: receipt.replayed }, {
            status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
          });
        } catch (error) { return ratingError(error); }
      }
      try {
        const daily = body.profile === DAILY_OBSERVATION_ID;
        const receipt = await setAdmittedStandingRating(work.environment,
          work.account, work.access, request, { context: body.context, work: body.work,
            mainVersion: body.mainVersion, expectedRevisionHead: body.expectedRevisionHead,
            value: body.value, actingSubject: body.actingSubject, idempotencyKey,
            ...(body.profile === EXPERIENCE_OBSERVATION_ID ? { occasion: body.occasion } : {}) }, daily)
          .catch(error => error instanceof RatingObservationUnavailable
            ? classifyRatingGrain(work.environment, body.context, 'MainVersion', error) : Promise.reject(error));
        const period = daily ? await readDailyRevisionPeriod(work.environment, receipt.observation!, receipt.revision!) : undefined;
        return Response.json({ observation: receipt.observation,
          observationRevision: receipt.revision, predecessor: receipt.predecessor,
          context: receipt.context, work: receipt.work, mainVersion: receipt.mainVersion,
          value: receipt.value, availability: receipt.availability,
          profile: body.profile, ...(period ?? {}),
          ...(body.profile === EXPERIENCE_OBSERVATION_ID ? { occasion: body.occasion } : {}),
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return ratingError(error); }
    })
    .get('/v1/rating-observations/:observation/revisions/:revision', {
      params: t.Object({ observation: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ profile: t.Optional(t.Union([t.Literal('realm-daily-rating-observation-v1'),
        t.Literal(EXPERIENCE_OBSERVATION_ID), t.Literal(RELEASE_OBSERVATION_ID), t.Literal(TARGET_OBSERVATION_ID)])),
        context: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        release: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        target: t.Optional(readId),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) }),
      response: { 200: t.Union([ratingObservationReadResult, dailyRatingObservationReadResult,
        experienceRatingObservationReadResult, releaseRatingObservationReadResult, targetRatingObservationReadResult]), ...authorizedReadProblems,
        422: problemResult(422) },
    }, async ({ params, query, request }) => {
      if (query.profile === TARGET_OBSERVATION_ID) {
        if (!query.target || query.mainVersion || query.release) return problem(400, 'invalid_request', 'Exact target required');
        try {
          const principal = await work.account.verify(request, ['rating:read']);
          if (!await work.access.canReadStandingRating(principal, query.actingSubject, query.context)) {
            return problem(403, 'authority_denied', 'Authority is not admitted');
          }
          const principalId = await work.access.activePrincipalId(principal);
          if (!principalId) return problem(403, 'authority_denied', 'Authority is not admitted');
          const found = await targetRead(work.environment, { access: work.access, principal, actingSubject: query.actingSubject },
            async session => {
              await resolveRatingTarget(session, query.context, query.target!);
              return readTargetRatingRevision(work.environment, principalId, { context: query.context, target: query.target!,
                observation: `https://rezics.com/id/${params.observation}`, revision: `https://rezics.com/id/${params.revision}` });
            });
          if (!found) return problem(404, 'rating_revision_unavailable', 'Rating revision unavailable');
          return Response.json(found, { headers: { 'cache-control': 'no-store' } });
        } catch (error) { return ratingError(error); }
      }
      // A release revision names only its release; a MainVersion revision names only its MainVersion.
      const releaseRead = query.profile === RELEASE_OBSERVATION_ID;
      if (query.target || (releaseRead ? !query.release || query.mainVersion : !query.mainVersion || query.release)) {
        return problem(400, 'invalid_request', 'Rating revision target is invalid');
      }
      const mainVersion = query.mainVersion!;
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['rating:read']);
        if (!await work.access.canReadStandingRating(principal, query.actingSubject, query.context)) {
          return problem(403, 'authority_denied', 'Authority is not admitted');
        }
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Authority is not admitted');
        const observation = `https://rezics.com/id/${params.observation}`;
        const revision = `https://rezics.com/id/${params.revision}`;
        if (releaseRead) {
          const found = await readReleaseRatingRevision(work.environment, principalId,
            { observation, revision, context: query.context, release: query.release! });
          if (!found) return problem(404, 'rating_revision_unavailable', 'Rating revision is unavailable');
          return Response.json(found, { headers: { 'cache-control': 'no-store' } });
        }
        const daily = query.profile === DAILY_OBSERVATION_ID;
        const experience = query.profile === EXPERIENCE_OBSERVATION_ID;
        const profile = experience ? EXPERIENCE_OBSERVATION_PROFILE : daily ? DAILY_OBSERVATION_PROFILE : STANDING_RATING_OBSERVATION_PROFILE;
        const period = daily ? await readDailyRevisionPeriod(work.environment, observation, revision) : undefined;
        const occasion = experience ? await readExperienceRevision(work.environment, observation, revision) : undefined;
        const identity = occasion ? experienceRatingIdentity(principalId, query.context, mainVersion, occasion.occasion) : undefined;
        if (identity && identity.occasionKey !== occasion!.occasionKey) {
          return problem(404, 'rating_revision_unavailable', 'Rating revision is unavailable');
        }
        const slot = identity ? identity.slot : period ? dailyRatingSlotIri(principalId, query.context, mainVersion, period.day)
          : standingRatingSlotIri(principalId, query.context, mainVersion);
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?manifest ?work ?realm ?availability ?value ?predecessor
            ?evaluatedAt ?submittedAt ?originalSubmissionAt ?revisedAt WHERE {
            GRAPH <urn:rezics:graph:current> {
              ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
              ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
                rv:ratingContext ${iri(query.context)} .
              ${iri(query.context)} a rv:RatingContext ; rv:contextState rv:Active ;
                rv:realm ?realm ; rv:targetGrain rv:MainVersion ;
                rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
                rv:ratingCadence ${iri(experience ? EXPERIENCE_CADENCE : daily ? DAILY_CADENCE : RATING_STANDING_CADENCE)} ;
                rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
                rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} .
              ${iri(observation)} a rv:RatingObservation ; rv:ratingSlot ${iri(slot)} ;
                rv:ratingContext ${iri(query.context)} ;
                rv:targetMainVersion ${iri(mainVersion)} .
              ?work a <https://schema.org/CreativeWork> ;
                rv:mainVersion ${iri(mainVersion)} .
              ${iri(mainVersion)} a rv:MainVersion ; rv:work ?work .
            }
            GRAPH <urn:rezics:graph:revisions> { ${iri(revision)}
              a rv:RatingObservationRevision, rv:RevisionAnchor ;
              rv:component ${iri(observation)} ; rv:observation ${iri(observation)} ;
              rv:modelRevision ${iri(profile)} ;
              rv:manifest ?manifest ; rv:ratingAvailability ?availability ;
              rv:evaluatedAt ?evaluatedAt ; rv:submittedAt ?submittedAt ;
              rv:originalSubmissionAt ?originalSubmissionAt ; rv:revisedAt ?revisedAt .
              OPTIONAL { ${iri(revision)} rv:ratingValue ?value }
              OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.manifest || !rows[0]?.work
          || !rows[0].realm || !rows[0].availability || !rows[0].evaluatedAt
          || !rows[0].submittedAt || !rows[0].originalSubmissionAt || !rows[0].revisedAt) {
          return problem(404, 'rating_revision_unavailable', 'Rating revision is unavailable');
        }
        const state = readComponentState(work.environment.objectDirectory,
          rows[0].manifest.value, observation, profile);
        if (state.observation !== observation || state.revision !== revision
          || state.slot !== slot || state.context !== query.context
          || (occasion && (state.occasion !== occasion.occasion || state.occasionKey !== occasion.occasionKey))
          || state.realm !== rows[0].realm.value
          || state.mainVersion !== mainVersion || state.work !== rows[0].work.value
          || !['available', 'withdrawn'].includes(String(state.availability))
          || rows[0].availability.value !== `https://rezics.com/vocab/${
            state.availability === 'available' ? 'Available' : 'Withdrawn'}`
          || state.predecessor !== (rows[0].predecessor?.value ?? null)
          || !sameRatingInstant(state.evaluatedAt, rows[0].evaluatedAt.value)
          || !sameRatingInstant(state.submittedAt, rows[0].submittedAt.value)
          || !sameRatingInstant(state.originalSubmissionAt,
            rows[0].originalSubmissionAt.value)
          || !sameRatingInstant(state.revisedAt, rows[0].revisedAt.value)
          || (state.availability === 'available' && (!Number.isInteger(state.value)
            || Number(state.value) < 1 || Number(state.value) > 10
            || Number(rows[0].value?.value) !== state.value))
          || (state.availability === 'withdrawn' && (state.value !== null
            || rows[0].value))) {
          return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
        }
        return Response.json({ observation, observationRevision: revision,
          context: state.context, work: state.work, mainVersion: state.mainVersion,
          predecessor: state.predecessor, availability: state.availability,
          value: state.value, evaluatedAt: state.evaluatedAt,
          submittedAt: state.submittedAt, originalSubmissionAt: state.originalSubmissionAt,
          revisedAt: state.revisedAt, ...(period ?? {}),
          ...(occasion ? { occasion: occasion.occasion } : {}),
          profile: experience ? EXPERIENCE_OBSERVATION_ID : daily ? DAILY_OBSERVATION_ID : 'realm-standing-rating-observation-v1' },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof RatingObservationUnavailable) {
          return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
        }
        return commandError(error);
      }
    })
    .post('/v1/rating-contexts', {
      body: t.Union([t.Object({ profile: t.Union([t.Literal('realm-standing-rating-context-v1'), t.Literal(EXPERIENCE_CONTEXT_ID)]),
        realm: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        question: t.String({ minLength: 3, maxLength: 120 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
        t.Object({ profile: t.Literal('realm-daily-rating-context-v1'),
        realm: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        timeZone: t.String({ minLength: 1, maxLength: 100 }),
        question: t.String({ minLength: 3, maxLength: 120 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }), releaseRatingContextInput, targetRatingContextInput]),
      response: { 200: t.Union([ratingContextWriteResult, dailyRatingContextWriteResult, experienceRatingContextWriteResult,
        releaseRatingContextWriteResult, targetRatingContextWriteResult]),
        201: t.Union([ratingContextWriteResult, dailyRatingContextWriteResult, experienceRatingContextWriteResult,
          releaseRatingContextWriteResult, targetRatingContextWriteResult]),
        202: pendingOperation, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      if (body.profile === TARGET_CONTEXT_ID) {
        try {
          const receipt = await createAdmittedTargetRatingContext(work.environment, work.account, work.access,
            request, { ...body, idempotencyKey });
          return Response.json({ context: receipt.context, realm: receipt.realm, question: body.question,
            contextRevision: receipt.revision, targetGrain: body.targetGrain, profile: TARGET_CONTEXT_ID,
            scale: { min: 1, max: 10, step: 1 }, cadence: 'standing', population: 'account-principal',
            aggregation: 'latest-per-rater-mean', replayed: receipt.replayed,
            sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence } },
          { status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
        } catch (error) { return ratingError(error); }
      }
      if (body.profile === RELEASE_CONTEXT_ID) {
        try {
          const receipt = await createAdmittedReleaseRatingContext(work.environment, work.account,
            work.access, request, { realm: body.realm, question: body.question,
              actingSubject: body.actingSubject, idempotencyKey });
          return Response.json({ context: receipt.context, realm: receipt.realm,
            question: body.question, contextRevision: receipt.revision, targetGrain: 'fixedRelease',
            scale: { min: 1, max: 10, step: 1 }, cadence: 'standing', population: 'account-principal',
            aggregation: 'latest-per-rater-mean', profile: RELEASE_CONTEXT_ID,
            sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
              sequence: receipt.sequence }, replayed: receipt.replayed }, {
            status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
          });
        } catch (error) { return commandError(error); }
      }
      try {
        const receipt = await createAdmittedRatingContext(work.environment,
          work.account, work.access, request, { realm: body.realm,
            question: body.question, actingSubject: body.actingSubject, idempotencyKey,
            ...(body.profile === EXPERIENCE_CONTEXT_ID ? { cadence: 'experience' as const } : {}),
            ...(body.profile === 'realm-daily-rating-context-v1' ? { timeZone: body.timeZone } : {}) });
        return Response.json({ context: receipt.context, realm: receipt.realm,
          question: body.question, contextRevision: receipt.revision,
          targetGrain: 'mainVersion', scale: { min: 1, max: 10, step: 1 },
          cadence: body.profile === EXPERIENCE_CONTEXT_ID ? 'experience' : body.profile === 'realm-daily-rating-context-v1' ? 'daily' : 'standing',
          ...(body.profile === 'realm-daily-rating-context-v1'
            ? { timeZone: canonicalRatingTimeZone(body.timeZone), calendar: 'iso8601' } : {}), population: 'account-principal',
          aggregation: 'latest-per-rater-mean',
          ...(body.profile === EXPERIENCE_CONTEXT_ID ? { policyRevision: receipt.revision } : {}),
          profile: body.profile,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/rating-contexts/:id/policy-revisions', {
      params: t.Object({ id: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      body: t.Object({ profile: t.Literal('rating-aggregate-default-policy-v1'),
        expectedPolicyHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        aggregationPolicy: t.Union([t.Literal('latest-per-rater-mean'),
          t.Literal('mean-per-rater'), t.Literal('pooled-observation-mean')]),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: ratingPolicyWriteResult, 201: ratingPolicyWriteResult,
        202: pendingOperation, ...writeProblems },
    }, async ({ request, params, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await setAdmittedRatingDefaultPolicy(work.environment,
          work.account, work.access, request, {
            context: `https://rezics.com/id/${params.id}`,
            expectedPolicyHead: body.expectedPolicyHead,
            aggregationPolicy: body.aggregationPolicy,
            actingSubject: body.actingSubject, idempotencyKey,
          });
        return Response.json({ context: receipt.context, realm: receipt.realm,
          contextRevision: receipt.contextRevision, policyRevision: receipt.policyRevision,
          predecessor: receipt.predecessor, aggregationPolicy: receipt.aggregationPolicy,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/rating-contexts/:id/policy-revisions/:revision', {
      params: t.Object({ id: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) }),
      response: { 200: ratingPolicyReadResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const context = `https://rezics.com/id/${params.id}`;
        const principal = await work.account.verify(request, ['rating:read']);
        if (!await work.access.canReadStandingRating(principal, query.actingSubject, context)
          || !await work.access.activePrincipalId(principal)) {
          return problem(403, 'authority_denied', 'Authority is not admitted');
        }
        const basis = await readRatingPolicyBasis(work.environment, context);
        const witness = await work.access.readRatingContextPolicyWitness?.(context);
        if (!witness || witness.contextRevision !== basis.contextRevision
          || witness.policyRevision !== basis.policyHead) {
          throw new RatingPolicyUnavailable('Rating policy witness differs');
        }
        const result = await readExactRatingPolicyRevision(work.environment,
          context, `https://rezics.com/id/${params.revision}`);
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/rating-contexts/:id', {
      params: t.Object({ id: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: t.Union([ratingContextReadResult, dailyRatingContextReadResult, experienceRatingContextReadResult,
        releaseRatingContextReadResult, targetRatingContextReadResult]), ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const context = `https://rezics.com/id/${params.id}`;
        const targetContext = await readTargetRatingContext(work.environment, context);
        if (targetContext) return Response.json(targetContext, { headers: { 'cache-control': 'no-store' } });
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?realm ?question ?revision ?manifest ?profile ?cadence ?timeZone WHERE {
            GRAPH <urn:rezics:graph:current> {
              ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
              ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
                rv:ratingContext ${iri(context)} .
              ${iri(context)} a rv:RatingContext ; rv:contextState rv:Active ;
                rv:realm ?realm ; rv:question ?question ; rv:targetGrain rv:MainVersion ;
                rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
                rv:ratingCadence ?cadence ;
                rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
                rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
                rv:head ?revision .
              OPTIONAL { ${iri(context)} rv:ratingTimeZone ?timeZone }
            }
            GRAPH <urn:rezics:graph:revisions> { ?revision a rv:RevisionAnchor ;
              rv:component ${iri(context)} ;
              rv:modelRevision ?profile ;
              rv:manifest ?manifest . }
            VALUES ?profile { ${iri(REALM_STANDING_RATING_CONTEXT_PROFILE)} ${iri(DAILY_CONTEXT_PROFILE)} ${iri(EXPERIENCE_CONTEXT_PROFILE)} }
            FILTER(LANG(?question) = "en")
          }`);
        const rows = result.results?.bindings ?? [];
        const row = rows[0];
        if (rows.length !== 1 || !row?.realm || !row.question
          || row.question['xml:lang'] !== 'en' || !row.revision || !row.manifest) {
          // Only a miss pays for the release-grain read.
          const release = rows.length === 0 ? await readReleaseRatingContext(work.environment, context)
            .catch(error => { if (error instanceof RatingObservationUnavailable) return 'damaged' as const; throw error; })
            : null;
          if (release === 'damaged') return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
          if (release) return Response.json(release, { headers: { 'cache-control': 'no-store' } });
          return problem(404, 'rating_context_unavailable', 'Rating context is unavailable');
        }
        const state = readComponentState(work.environment.objectDirectory,
          row.manifest.value, context, row.profile!.value);
        const daily = row.profile!.value === DAILY_CONTEXT_PROFILE;
        const experience = row.profile!.value === EXPERIENCE_CONTEXT_PROFILE;
        if (state.context !== context || state.realm !== row.realm.value
          || state.question !== row.question.value || state.targetGrain !== 'MainVersion'
          || state.scaleMin !== 1 || state.scaleMax !== 10
          || state.cadence !== (experience ? EXPERIENCE_CADENCE : daily ? DAILY_CADENCE : RATING_STANDING_CADENCE)
          || state.cadence !== row.cadence?.value
          || (daily && (typeof state.timeZone !== 'string' || state.timeZone !== row.timeZone?.value
            || state.calendar !== 'iso8601'))
          || state.populationPolicy !== RATING_ACCOUNT_POPULATION
          || state.aggregationPolicy !== RATING_LATEST_MEAN_POLICY) {
          return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
        }
        const policy = experience ? await readRatingPolicyBasis(work.environment, context) : undefined;
        if (policy && policy.contextRevision !== row.revision.value) {
          return problem(503, 'rating_policy_unavailable', 'Rating policy revision is unavailable');
        }
        if (policy) {
          const witness = await work.access.readRatingContextPolicyWitness?.(context);
          if (!witness || witness.contextRevision !== policy.contextRevision
            || witness.policyRevision !== policy.policyHead) {
            throw new RatingPolicyUnavailable('Rating policy witness differs');
          }
        }
        return Response.json({ context, realm: row.realm.value, question: row.question.value,
          contextRevision: row.revision.value, targetGrain: 'mainVersion',
          scale: { min: 1, max: 10, step: 1 }, cadence: experience ? 'experience' : daily ? 'daily' : 'standing',
          ...(daily ? { timeZone: state.timeZone, calendar: 'iso8601' } : {}),
          population: 'account-principal', aggregation: policy?.aggregationPolicy ?? 'latest-per-rater-mean',
          ...(policy ? { policyRevision: policy.policyHead } : {}),
          profile: experience ? EXPERIENCE_CONTEXT_ID : daily ? 'realm-daily-rating-context-v1' : 'realm-standing-rating-context-v1' },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}
