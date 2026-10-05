import { Elysia, t } from 'elysia';
import { pendingOperation, sourcePosition, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { AdmissionDenied } from '../modules/access/admission.ts';
import { admittedQuestionPresentationChange } from '../modules/rating/question-presentation-admitted.ts';
import {
  findQuestionPresentation,
  readQuestionPresentationCurrent,
  readReviewedQuestionPresentation,
  readQuestionPresentationRevision,
} from '../modules/rating/question-presentation.ts';
import { readAuthoredRatingQuestion } from '../modules/rating/question-presentation-context.ts';
import {
  questionPresentationStateSchema,
  QUESTION_PRESENTATION_PROFILE,
  QUESTION_PRESENTATION_ACTIONS,
  questionPresentationScope,
  QUESTION_PRESENTATION_COST,
  QUESTION_PRESENTATION_KINDS,
  QUESTION_PRESENTATION_REVISION_PROFILES,
} from '../modules/rating/question-presentation-schema.ts';
import { languageTagSchema } from '../modules/display-language/schema.ts';
import { fusekiReadBudget } from '../infrastructure/fuseki.ts';
import { SemanticTargetUnavailable } from '../modules/semantic/command.ts';
import { GRAPHS, RV, iri } from '../modules/work/activate.ts';
import { readId } from '../modules/work/read-contract.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { groupUuid } from './shared.ts';
import { semanticError } from './semantic.ts';
import { problem } from './problems.ts';

const write = t.Object({
  profile: t.Literal(QUESTION_PRESENTATION_PROFILE),
  component: readId,
  revision: readId,
  predecessor: t.Nullable(readId),
  receipt: t.String(),
  sourcePosition,
  replayed: t.Boolean(),
});
const read = t.Object({
  profile: t.Literal(QUESTION_PRESENTATION_PROFILE),
  component: readId,
  revision: readId,
  predecessor: t.Nullable(readId),
  state: questionPresentationStateSchema,
  modelGeneration: t.String(),
  sourcePosition,
});
export const openApiOperations = {
  '/v1/rating-question-presentations': {
    post: { bearer: true, idempotencyKey: true },
    get: { bearer: false },
  },
  '/v1/rating-question-presentations/{id}': { get: { bearer: false } },
  '/v1/rating-question-presentations/{id}/revisions/{revision}': { get: { bearer: false } },
} as const;

export function ratingQuestionPresentationRoutes(work: MainWorkDependencies) {
  const allowed = async (
    request: Request,
    actor: string | undefined,
    component: string,
    revision?: string,
  ) => {
    await assertGraphAdmissionOpen(work.environment.fuseki, work.environment.lineage);
    const rows =
      (
        await work.environment.fuseki.query(`PREFIX rv: <${RV}> SELECT ?context ?review WHERE {
      ${
        revision
          ? `BIND(${iri(revision)} AS ?head)`
          : `GRAPH ${iri(GRAPHS.current)} {
        ${iri(component)} a ?presentationKind ; rv:questionPresentationHead ?head }
        VALUES ?presentationKind { ${QUESTION_PRESENTATION_KINDS} }`
      }
      ${QUESTION_PRESENTATION_REVISION_PROFILES}
      GRAPH ${iri(GRAPHS.revisions)} { ?head a ?presentationRevisionKind, rv:RevisionAnchor ;
        rv:component ${iri(component)} ; rv:presentationContext ?context ; rv:reviewStatus ?review .
        FILTER NOT EXISTS { ?head a rv:ErasedRevision } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(component)} rv:protectionHead ?protection } }
    } LIMIT 2`)
      ).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.context || !rows[0].review)
      throw new SemanticTargetUnavailable('Presentation is unavailable');
    const context = rows[0].context.value;
    await readAuthoredRatingQuestion(work.environment, context);
    if (rows[0].review.value === `${RV}Reviewed`) return context;
    if (!request.headers.has('authorization') || !actor || !work.access.assertAuthority) {
      throw new SemanticTargetUnavailable('Presentation is unavailable');
    }
    const principal = await work.account.verify(request, ['rating:configure']);
    for (const action of QUESTION_PRESENTATION_ACTIONS) {
      try {
        await work.access.assertAuthority({
          principal,
          actingSubject: actor,
          action,
          scope: questionPresentationScope(context),
        });
        return context;
      } catch (error) {
        if (!(error instanceof AdmissionDenied)) throw error;
      }
    }
    throw new SemanticTargetUnavailable('Presentation is unavailable');
  };
  const readRoute = async (
    request: Request,
    actor: string | undefined,
    component: string,
    revision?: string,
  ) => {
    let context: string;
    try {
      context = await allowed(request, actor, component, revision);
    } catch (error) {
      if (revision || !(error instanceof SemanticTargetUnavailable)) throw error;
      const current = await readQuestionPresentationCurrent(work.environment, component);
      if (!current) throw error;
      await readAuthoredRatingQuestion(work.environment, current.state.context);
      const reviewed = await readReviewedQuestionPresentation(
        work.environment,
        current.state.context,
        component,
      );
      if (!reviewed) throw error;
      await allowed(request, actor, component, reviewed.revision);
      return Response.json(
        { profile: QUESTION_PRESENTATION_PROFILE, ...reviewed },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    const result = revision
      ? await readQuestionPresentationRevision(work.environment, component, revision)
      : await readQuestionPresentationCurrent(work.environment, component);
    if (!result || result.state.context !== context)
      throw new SemanticTargetUnavailable('Presentation is unavailable');
    await allowed(request, actor, component, result.revision);
    return Response.json(
      { profile: QUESTION_PRESENTATION_PROFILE, ...result },
      { headers: { 'cache-control': 'no-store' } },
    );
  };
  return new Elysia()
    .get(
      '/v1/rating-question-presentations',
      {
        query: t.Object(
          { context: readId, language: languageTagSchema(255), actingSubject: t.Optional(readId) },
          { additionalProperties: false },
        ),
        response: { 200: t.Object({ presentation: t.Nullable(read) }), ...authorizedReadProblems },
      },
      async ({ request, query }) => {
        try {
          return await fusekiReadBudget.run(
            {
              callsLeft: QUESTION_PRESENTATION_COST.lookupGraphCalls,
              bytesLeft: QUESTION_PRESENTATION_COST.lookupGraphBytes,
              signal: AbortSignal.any([
                request.signal,
                AbortSignal.timeout(QUESTION_PRESENTATION_COST.lookupDeadlineMs),
              ]),
            },
            async () => {
              await assertGraphAdmissionOpen(work.environment.fuseki, work.environment.lineage);
              await readAuthoredRatingQuestion(work.environment, query.context);
              const found = await findQuestionPresentation(
                work.environment,
                query.context,
                query.language,
              );
              if (!found)
                return Response.json(
                  { presentation: null },
                  { headers: { 'cache-control': 'no-store' } },
                );
              try {
                // Hydrate the immutable head captured by the tuple lookup. Reading
                // current again can mix a concurrent review's projection with the
                // prior manifest; the caller's next write already uses head CAS.
                let response: Response;
                try {
                  response = await readRoute(
                    request,
                    query.actingSubject,
                    found.component,
                    found.revision,
                  );
                } catch (error) {
                  if (!(error instanceof SemanticTargetUnavailable)) throw error;
                  response = await readRoute(request, query.actingSubject, found.component);
                }
                const presentation = await response.json();
                return Response.json(
                  { presentation },
                  { headers: { 'cache-control': 'no-store' } },
                );
              } catch (error) {
                if (!(error instanceof SemanticTargetUnavailable)) throw error;
                // A draft or protected head must be indistinguishable from an empty
                // language slot to a caller without editorial authority.
                return Response.json(
                  { presentation: null },
                  { headers: { 'cache-control': 'no-store' } },
                );
              }
            },
          );
        } catch (error) {
          return semanticError(error);
        }
      },
    )
    .post(
      '/v1/rating-question-presentations',
      {
        body: t.Object(
          {
            profile: t.Literal(QUESTION_PRESENTATION_PROFILE),
            target: t.Optional(readId),
            expectedHead: t.Nullable(readId),
            state: questionPresentationStateSchema,
            /** With a draft of an existing presentation: withdraw its public review, freeing the language. */
            retire: t.Optional(t.Literal(true)),
            actingSubject: readId,
          },
          { additionalProperties: false },
        ),
        response: {
          200: write,
          201: write,
          202: pendingOperation,
          ...writeProblems,
          404: problemResult(404),
          422: problemResult(422),
        },
      },
      async ({ request, body }) => {
        const key = request.headers.get('idempotency-key');
        if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key))
          return problem(
            400,
            'invalid_idempotency_key',
            'A valid Idempotency-Key header is required',
          );
        try {
          const result = await admittedQuestionPresentationChange(
            work.environment,
            work.account,
            work.access,
            request,
            { ...body, idempotencyKey: key },
          );
          const { dataEpoch, sequence, ...fields } = result;
          return Response.json(
            {
              profile: QUESTION_PRESENTATION_PROFILE,
              ...fields,
              sourcePosition: { datasetId: 'product', dataEpoch, sequence },
            },
            {
              status: body.target || result.replayed ? 200 : 201,
              headers: { 'cache-control': 'no-store' },
            },
          );
        } catch (error) {
          return semanticError(error);
        }
      },
    )
    .get(
      '/v1/rating-question-presentations/:id',
      {
        params: t.Object({ id: groupUuid }),
        query: t.Object({ actingSubject: t.Optional(readId) }, { additionalProperties: false }),
        response: { 200: read, ...authorizedReadProblems },
      },
      async ({ request, params, query }) => {
        try {
          return await readRoute(
            request,
            query.actingSubject,
            `https://rezics.com/id/${params.id}`,
          );
        } catch (error) {
          return semanticError(error);
        }
      },
    )
    .get(
      '/v1/rating-question-presentations/:id/revisions/:revision',
      {
        params: t.Object({ id: groupUuid, revision: groupUuid }),
        query: t.Object({ actingSubject: t.Optional(readId) }, { additionalProperties: false }),
        response: { 200: read, ...authorizedReadProblems },
      },
      async ({ request, params, query }) => {
        try {
          return await readRoute(
            request,
            query.actingSubject,
            `https://rezics.com/id/${params.id}`,
            `https://rezics.com/id/${params.revision}`,
          );
        } catch (error) {
          return semanticError(error);
        }
      },
    );
}
