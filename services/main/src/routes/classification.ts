import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { readComponentState } from '../modules/work/history.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { iri } from '../modules/work/activate.ts';
import { createAdmittedClassificationContext } from '../modules/classification/context-admitted.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_INHERIT_POLICY,
  CLASSIFICATION_ISOLATE_POLICY } from '../modules/classification/context.ts';
import { createAdmittedClassificationProposition }
  from '../modules/classification/proposition-admitted.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../modules/classification/proposition.ts';
import { setAdmittedClassificationDecision } from '../modules/classification/decision-admitted.ts';
import { statementCutoverActive } from '../modules/statement/migrate-v1.ts';
import { resolveClassification } from '../modules/classification/resolve.ts';
import { pendingOperation } from '../api-contract.ts';
import { classificationContextReadResult, classificationContextWriteResult,
  classificationDecisionWriteResult, classificationPropositionReadResult,
  classificationPropositionWriteResult, classificationResolutionResult, readProblems,
  writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { ContextCommandUnavailable, InvalidContextCommand, PendingContextCommand,
  StaleContextCommand, runAdmittedCommand } from '../modules/context/command.ts';
import { ConceptSearchInvalid } from '../modules/semantic/concept-search.ts';
import { readStatement } from '../modules/statement/read.ts';
import { tagProposalInput, tagProposalResult, tagProposalRequest, recordTagProposal,
  tagProposalBudget } from '../modules/classification/tag-proposal.ts';

export const openApiOperations = {
  '/v1/tag-proposals': { post: { bearer: true, idempotencyKey: true } },
} as const;

export function classificationRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/tag-proposals', { body: tagProposalInput,
      response: { 200: tagProposalResult, 201: tagProposalResult, 202: pendingOperation, ...writeProblems } },
    async ({ request, body }) => {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        return await tagProposalBudget(async () => {
          const plan = tagProposalRequest(body);
          const receipt = await runAdmittedCommand(work.environment, work.account, work.access, request,
            { ...plan, oauthScope: 'statement:write', actingSubject: body.actingSubject,
              input: body, idempotencyKey: key,
              execute: admission => recordTagProposal(work.environment, admission, body) });
          const statement = await readStatement(work.environment, receipt.component!, async () => false);
          if (statement.value.kind !== 'resource') throw new ContextCommandUnavailable('Tag proposal is unavailable');
          return Response.json({ statement: statement.statement, revision: receipt.revision,
            concept: statement.value.iri, meaningKey: statement.meaningKey, acceptance: body.acceptance,
            state: 'proposed', replayed: receipt.replayed,
            sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence } },
          { status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
        });
      } catch (error) {
        if (error instanceof ConceptSearchInvalid || error instanceof InvalidContextCommand) {
          return problem(400, 'invalid_tag_proposal', error.message);
        }
        if (error instanceof ContextCommandUnavailable || error instanceof StaleContextCommand) {
          return problem(409, 'tag_target_unavailable', error.message);
        }
        if (error instanceof PendingContextCommand) return problem(503, 'tag_proposal_pending', error.message);
        return commandError(error);
      }
    })
    .post('/v1/classification-resolutions', {
      body: t.Object({ profile: t.Literal('classification-resolution-v1'),
        context: t.Union([
          t.Object({ kind: t.Literal('global') }, { additionalProperties: false }),
          t.Object({ kind: t.Literal('realm-classification'),
            id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
          }, { additionalProperties: false }),
        ]),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: classificationResolutionResult, ...readProblems },
    }, async ({ body }) => {
      try {
        const result = await resolveClassification(work.environment,
          { context: body.context, work: body.work,
            mainVersion: body.mainVersion, sense: body.sense });
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/classification-decisions', {
      body: t.Object({ profile: t.Literal('classification-direct-decision-v1'),
        context: t.Union([
          t.Object({ kind: t.Literal('global') }, { additionalProperties: false }),
          t.Object({ kind: t.Literal('realm-classification'),
            id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
          }, { additionalProperties: false }),
        ]),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedDecisionHead: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        outcome: t.Union([t.Literal('accepted'), t.Literal('rejected')]),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: classificationDecisionWriteResult,
        201: classificationDecisionWriteResult, 202: pendingOperation,
        410: t.Object({ type: t.String(), status: t.Literal(410), code: t.String(), title: t.String() }),
        ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        if (await statementCutoverActive(work.environment)) {
          return problem(410, 'classification_decision_retired', 'Use Statement decisions');
        }
        const receipt = await setAdmittedClassificationDecision(work.environment,
          work.account, work.access, request, { context: body.context,
            work: body.work, mainVersion: body.mainVersion, sense: body.sense,
            expectedDecisionHead: body.expectedDecisionHead, outcome: body.outcome,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ application: receipt.application, decision: receipt.decision,
          decisionOutcome: receipt.decisionOutcome, context: receipt.context,
          realm: receipt.realm ?? null, contextRevision: receipt.contextRevision ?? null,
          work: receipt.work, mainVersion: receipt.mainVersion, sense: receipt.sense,
          expectedDecisionHead: receipt.expectedHead, profile: 'classification-direct-decision-v1',
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/classification-propositions', {
      body: t.Object({ profile: t.Literal('classification-proposition-v1'),
        label: t.String({ minLength: 1, maxLength: 120 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: classificationPropositionWriteResult,
        201: classificationPropositionWriteResult, 202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedClassificationProposition(work.environment,
          work.account, work.access, request, { label: body.label,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ ...receipt.definitions, definitionRevision: receipt.revision,
          profile: 'classification-proposition-v1',
          interpretationScope: GLOBAL_CLASSIFICATION_CONTEXT,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/classification-propositions/:sense', {
      params: t.Object({ sense: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: classificationPropositionReadResult, ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const sense = `https://rezics.com/id/${params.sense}`;
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
          SELECT ?scheme ?concept ?path ?expression ?label ?revision ?manifest WHERE {
            GRAPH <urn:rezics:graph:current> {
              ${iri(sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
                rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
                rv:path ?path ; rv:expression ?expression ; rv:head ?revision .
              ?expression a rv:ClassificationExpression ; rv:path ?path ;
                rv:assertedConcept ?concept ; rv:propositionKind rv:ConceptAssertion ;
                rv:expressionState rv:Active .
              ?path a rv:ConceptPath ; rv:pathKind rv:SingleConcept ;
                rv:pathLength 1 ; rv:terminalConcept ?concept ; rv:pathState rv:Active .
              ?concept a skos:Concept ; skos:inScheme ?scheme ; skos:prefLabel ?label ;
                rv:conceptState rv:Active .
              ?scheme a skos:ConceptScheme ; rv:schemeState rv:Active .
            }
            GRAPH <urn:rezics:graph:revisions> { ?revision a rv:RevisionAnchor ;
              rv:component ${iri(sense)} ;
              rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
              rv:manifest ?manifest . }
            FILTER(LANG(?label) = "en")
          }`);
        const rows = result.results?.bindings ?? [];
        const row = rows[0];
        if (rows.length !== 1 || !row?.scheme || !row.concept || !row.path
          || !row.expression || !row.label || row.label['xml:lang'] !== 'en'
          || !row.revision || !row.manifest) {
          return problem(404, 'classification_proposition_unavailable',
            'Classification proposition is unavailable');
        }
        const definitions = { scheme: row.scheme.value, concept: row.concept.value,
          path: row.path.value, expression: row.expression.value, sense };
        const state = readComponentState(work.environment.objectDirectory,
          row.manifest.value, sense, CLASSIFICATION_PROPOSITION_PROFILE);
        if (Object.entries(definitions).some(([key, id]) => state[key] !== id)
          || state.label !== row.label.value || state.language !== 'en'
          || state.scope !== GLOBAL_CLASSIFICATION_CONTEXT) {
          return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
        }
        return Response.json({ ...definitions, label: row.label.value, language: 'en',
          definitionRevision: row.revision.value, profile: 'classification-proposition-v1',
          interpretationScope: GLOBAL_CLASSIFICATION_CONTEXT },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/classification-contexts', {
      body: t.Object({ profile: t.Literal('classification-context-v1'),
        realm: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: classificationContextWriteResult, 201: classificationContextWriteResult,
        202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedClassificationContext(work.environment,
          work.account, work.access, request, { realm: body.realm,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ realm: receipt.realm, context: receipt.context,
          contextRevision: receipt.revision, role: 'realm-classification',
          fallbackContext: GLOBAL_CLASSIFICATION_CONTEXT,
          inheritancePolicy: CLASSIFICATION_INHERIT_POLICY,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/realms/:realm/classification-context', {
      params: t.Object({ realm: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: classificationContextReadResult, ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const realm = `https://rezics.com/id/${params.realm}`;
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?context ?revision ?fallback ?policy WHERE {
            GRAPH <urn:rezics:graph:current> {
              ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
              ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
                rv:classificationContext ?context .
              ?context a rv:ClassificationContext ; rv:realm ${iri(realm)} ;
                rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ;
                rv:fallbackContext ?fallback ; rv:inheritancePolicy ?policy ; rv:head ?revision .
              ?fallback a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ;
                rv:contextState rv:Active ;
                rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
              FILTER NOT EXISTS { ?fallback rv:fallbackContext ?other }
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.context || !rows[0]?.revision
          || rows[0].fallback?.value !== GLOBAL_CLASSIFICATION_CONTEXT
          || rows[0].policy?.value !== CLASSIFICATION_INHERIT_POLICY) {
          return problem(404, 'classification_context_unavailable',
            'Realm classification context is unavailable');
        }
        return Response.json({ realm, context: rows[0].context.value,
          contextRevision: rows[0].revision.value, role: 'realm-classification',
          fallbackContext: GLOBAL_CLASSIFICATION_CONTEXT,
          inheritancePolicy: CLASSIFICATION_INHERIT_POLICY },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}
