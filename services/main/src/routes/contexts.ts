import { Elysia, t } from 'elysia';
import { pendingOperation, problemResult, sourcePosition } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../modules/access/admission.ts';
import { ContextCommandUnavailable, InvalidContextCommand, PendingContextCommand, StaleContextCommand,
  runAdmittedCommand, type ContextCommandReceipt } from '../modules/context/command.ts';
import { DEFINITION_STATE_FAMILY, activeDefinitionDependenciesGuard, definitionStateRequest, readDefinitionState,
  setDefinitionState } from '../modules/context/definition-state.ts';
import { createContext, createContextRequest, reviseContext, reviseContextRequest, selectRealmContext,
  selectRealmContextRequest, setContextState, setContextStateRequest, CONTEXT_FAMILIES } from '../modules/context/graph.ts';
import { resolveInterpretation, type Interpretation,
  type InterpretationSpeaker } from '../modules/context/interpretation.ts';
import { PrivateContextSelections, PrivateSelectionConflict, PrivateSelectionDenied, PrivateSelectionInvalid,
  PrivateSelectionStale, PrivateSelectionUnavailable } from '../modules/context/private-selection.ts';
import { ContextNotFound, readContextRevision } from '../modules/context/read.ts';
import { CONTEXT_EQUIVALENCE_FAMILY, compareStatementMeanings, equivalenceRequest,
  readDefinitionEquivalence, reviewDefinitionEquivalence } from '../modules/context/equivalence.ts';
import { CONTEXT_PREFERENCE_FAMILY, contextPreferencesRequest, contextSkos,
  readContextPreferences, setContextPreferences } from '../modules/context/preferences.ts';
import { InvalidContextSchemaInput, type ContextSelectionScope } from '../modules/context/schema.ts';
import { CONTEXT_RULE_DEPENDENCY_FAMILY, CONTEXT_RULE_FAMILY, changeContextRule,
  contextRuleRequest, dependencyRequest, planContextRules, readContextRule,
  registerRuleDependencies, ruleContextBasis, staleRuleDependencies } from '../modules/context/rule.ts';
import { FiniteRuleRejected } from '../modules/semantic/finite-rule.ts';
import { ReasoningInputRejected, ReasoningProfileRejected } from '../modules/semantic/reasoning.ts';
import { recordStatement, recordStatementRequest, setStatementDecision, statementDecisionRequest,
  withdrawStatement, withdrawStatementRequest,
  statementInterpretation, STATEMENT_FAMILIES, type RecordStatementInput } from '../modules/statement/graph.ts';
import { targetSummaries } from '../modules/target/resolve.ts';
import { StatementNotFound, readStatement, resolveStatementAcceptance } from '../modules/statement/read.ts';
import { CUTOVER_FAMILY, MIGRATION_FAMILY, cutoverRequest, cutoverV1Decisions,
  migrateV1Decision, migrationRequest } from '../modules/statement/migrate-v1.ts';
import { InvalidStatementSchemaInput } from '../modules/statement/schema.ts';
import { GRAPHS, RV, iri } from '../modules/work/activate.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { readingPositionRead } from '../modules/reading-position/read.ts';
import { readingPositionQuery } from './reading-positions.ts';
import { workReadError } from './work-reads.ts';
import { WorkReadInvalid, WorkReadMissing, WorkReadMoved, WorkReadUnavailable } from '../modules/work/read-session.ts';

export const openApiOperations = {
  '/v1/contexts': { post: { bearer: true, idempotencyKey: true } },
  '/v1/contexts/{id}/semantic-revisions': { post: { bearer: true, idempotencyKey: true } },
  '/v1/contexts/{id}/state-transitions': { post: { bearer: true, idempotencyKey: true } },
  '/v1/contexts/{id}/preferences': { post: { bearer: true, idempotencyKey: true }, get: {} },
  '/v1/contexts/{id}/skos': { get: {} },
  '/v1/context-definition-states': { post: { bearer: true, idempotencyKey: true }, get: { bearer: true } },
  '/v1/context-definition-equivalences': { post: { bearer: true, idempotencyKey: true }, get: {} },
  '/v1/context-meaning-comparisons': { post: {} },
  '/v1/contexts/{id}': { get: {} },
  '/v1/realms/{realm}/context-selections': { post: { bearer: true, idempotencyKey: true } },
  '/v1/me/context-selections': { put: { bearer: true, idempotencyKey: true }, get: { bearer: true } },
  '/v1/context-interpretations': { post: { bearer: true } },
  '/v1/context-rules': { post: { bearer: true, idempotencyKey: true }, get: { bearer: true } },
  '/v1/context-rule-plans': { post: { bearer: true } },
  '/v1/context-rule-dependencies': { post: { bearer: true, idempotencyKey: true }, get: { bearer: true } },
  '/v1/statements': { post: { bearer: true, idempotencyKey: true } },
  '/v1/statements/{id}': { get: {} },
  '/v1/statements/{id}/withdrawals': { post: { bearer: true, idempotencyKey: true } },
  '/v1/statement-decisions': { post: { bearer: true, idempotencyKey: true } },
  '/v1/statement-resolutions': { post: {} },
  '/v1/statement-migrations/v1/pending': { get: { bearer: true } },
  '/v1/statement-migrations/v1/{id}': { post: { bearer: true, idempotencyKey: true } },
  '/v1/statement-migrations/v1/cutover': { post: { bearer: true, idempotencyKey: true } },
} as const;

/** Main wiring supplies the Access-backed private selection store beside the shared dependencies. */
export interface ContextRouteDependencies { contextSelections?: PrivateContextSelections }

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const contextId = t.Union([native, t.Literal('urn:rezics:semantic-context:global')]);
const reference = t.String({ pattern: '^https?://[^\\s<>"{}|\\\\^`]{1,2040}$' });
const scope = t.Union([
  t.Object({ kind: t.Literal('default') }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('object'), object: native }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('object-relation'), object: native, relation: reference }, { additionalProperties: false }),
]);
const entry = t.Object({ target: reference, relation: t.Nullable(reference),
  state: t.Union([t.Literal('defined'), t.Literal('unresolved'), t.Literal('disabled')]),
  definition: t.Nullable(reference), applicability: t.Array(reference, { maxItems: 8 }) },
{ additionalProperties: false });
const value = t.Union([
  t.Object({ kind: t.Literal('resource'), iri: reference }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('literal'), lexical: t.String({ maxLength: 4096 }), datatype: reference,
    language: t.Nullable(t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$' })) }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('some-value') }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('no-value') }, { additionalProperties: false }),
]);
const acceptance = t.Union([
  t.Object({ kind: t.Literal('global') }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('realm'), realm: native }, { additionalProperties: false }),
]);
const target = t.Union([
  t.Object({ kind: t.Literal('statement'), statement: native }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('qualified-fact'), meaningKey: t.String({ pattern: '^urn:rezics:meaning:[0-9a-f]{64}$' }),
    support: t.Array(native, { minItems: 1, maxItems: 32 }) }, { additionalProperties: false }),
]);
const noStore = { 'cache-control': 'no-store' };
const ref = t.String();
const nullableRef = t.Nullable(ref);
const source = sourcePosition;
const writtenFields = { component: ref, revision: ref, expectedHead: nullableRef,
  sourcePosition: source, replayed: t.Boolean() };
const contextWriteResponse = t.Object({ profile: t.Literal('context-v1'), context: ref,
  semanticRevision: ref, ...writtenFields });
const equivalenceUse = t.Object({ target: reference, definition: reference }, { additionalProperties: false });
const equivalenceWriteResponse = t.Object({ profile: t.Literal('context-definition-equivalence-v1'),
  mapping: ref, ...writtenFields });
const equivalenceReadResponse = t.Object({ profile: t.Literal('context-definition-equivalence-v1'),
  mapping: ref, revision: ref, context: ref, semanticRevision: ref, relation: ref,
  left: equivalenceUse, right: equivalenceUse, reviewedBy: ref, sourcePosition: source });
const meaningComparisonResponse = t.Union([
  t.Object({ profile: t.Literal('context-meaning-comparison-v1'), state: t.Literal('unavailable') }),
  t.Object({ profile: t.Literal('context-meaning-comparison-v1'), state: t.Literal('distinct'),
    left: ref, right: ref, mapping: t.Null() }),
  t.Object({ profile: t.Literal('context-meaning-comparison-v1'), state: t.Literal('equivalent'),
    basis: t.Union([t.Literal('exact'), t.Literal('reviewed-mapping')]),
    left: ref, right: ref, mapping: nullableRef }),
]);
const labelPreference = t.Object({ target: reference,
  language: t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$' }),
  label: t.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false });
const preferenceWriteResponse = t.Object({ profile: t.Literal('context-preference-v1'),
  context: ref, preferenceRevision: ref, ...writtenFields });
const preferenceReadResponse = t.Object({ profile: t.Literal('context-preference-v1'),
  context: ref, head: ref, revision: ref, predecessor: nullableRef,
  labels: t.Array(labelPreference), sourcePosition: source });
const skosNode = t.Object({ '@id': ref, '@type': t.Literal('skos:Concept'),
  'rv:interprets': t.Object({ '@id': ref }),
  'rv:semanticRevision': t.Object({ '@id': ref }),
  'rv:preferenceRevision': t.Object({ '@id': ref }),
  'skos:prefLabel': t.Object({ '@value': ref, '@language': ref }) });
const skosReadResponse = t.Object({ '@context': t.Object({ skos: ref, rv: ref,
  context: t.Object({ '@id': ref, '@type': t.Literal('@id') }),
  semanticRevision: t.Object({ '@id': ref, '@type': t.Literal('@id') }),
  preferenceRevision: t.Object({ '@id': ref, '@type': t.Literal('@id') }) }),
  '@graph': t.Array(skosNode), context: ref, semanticRevision: ref, preferenceRevision: ref });
const definitionStateWriteResponse = t.Object({ profile: t.Literal('context-definition-state-v1'),
  definition: ref, state: t.Union([t.Literal('active'), t.Literal('retired')]), ...writtenFields });
const definitionStateReadResponse = t.Object({ profile: t.Literal('context-definition-state-v1'),
  definition: ref, component: ref, state: t.Union([t.Literal('active'), t.Literal('retired')]),
  head: ref, revision: ref, revisionState: t.Union([t.Literal('active'), t.Literal('retired')]),
  predecessor: nullableRef });
const selectionWriteResponse = t.Object({ profile: t.Literal('context-selection-v1'),
  selection: ref, selectionRevision: ref, state: t.Union([t.Literal('selected'), t.Literal('cleared')]),
  ...writtenFields });
const contextReadResponse = t.Object({ profile: t.Literal('context-v1'), context: ref,
  role: t.Union([t.Literal('global-interpretation'), t.Literal('shared-interpretation')]),
  state: t.Union([t.Literal('active'), t.Literal('retired')]),
  disclosure: t.Union([t.Literal('public'), t.Literal('private')]),
  semanticHead: ref, revision: ref, predecessor: nullableRef, base: nullableRef,
  inheritanceDepth: t.Integer(), entries: t.Array(entry), authoredBy: ref, sourcePosition: source });
const privateSelectionFields = { profile: t.Literal('context-private-selection-v1'), scope,
  state: t.Union([t.Literal('selected'), t.Literal('cleared')]), context: nullableRef,
  semanticRevision: nullableRef, revision: ref, generation: t.String() };
const privateSelectionReadResponse = t.Object(privateSelectionFields);
const privateSelectionWriteResponse = t.Object({ ...privateSelectionFields, replayed: t.Boolean() });
const basis = t.Union([t.Literal('explicit'), t.Literal('speaker-object-relation'),
  t.Literal('speaker-object'), t.Literal('speaker-default'), t.Literal('global'), t.Literal('none')]);
const interpretationResponse = t.Union([
  t.Object({ profile: t.Literal('context-interpretation-v1'), state: t.Literal('unavailable') }),
  t.Object({ profile: t.Literal('context-interpretation-v1'), state: t.Literal('resolved'), basis,
    context: nullableRef, semanticRevision: nullableRef, definition: nullableRef,
    entryRevision: nullableRef, selectionRevision: nullableRef }),
  t.Object({ profile: t.Literal('context-interpretation-v1'), state: t.Literal('ambiguous'), basis,
    context: ref, semanticRevision: ref, selectionRevision: nullableRef,
    candidates: t.Array(t.Object({ relation: ref, definition: ref, entryRevision: ref }), { maxItems: 26 }) }),
  t.Object({ profile: t.Literal('context-interpretation-v1'),
    state: t.Union([t.Literal('unresolved'), t.Literal('disabled')]), basis,
    context: ref, semanticRevision: ref, entryRevision: ref, selectionRevision: nullableRef }),
]);
const ruleAtom = t.Object({ subject: t.String(), predicate: reference, object: t.String() },
{ additionalProperties: false });
const finiteRule = t.Object({ profile: t.Literal('finite-positive-rule-v1'),
  inputPredicates: t.Array(reference, { minItems: 1, maxItems: 4 }), outputPredicate: reference,
  body: t.Array(ruleAtom, { minItems: 1, maxItems: 4 }),
  head: t.Object({ subject: t.String(), object: t.String() }, { additionalProperties: false }),
  budget: t.Object({ rounds: t.Integer({ minimum: 1, maximum: 8 }),
    inferences: t.Integer({ minimum: 1, maximum: 2048 }),
    inspections: t.Integer({ minimum: 1, maximum: 50_000 }) }, { additionalProperties: false }),
}, { additionalProperties: false });
const ruleWriteResponse = t.Object({ profile: t.Literal('context-rule-v1'), slot: ref,
  generation: ref, ...writtenFields });
const ruleReadResponse = t.Object({ profile: t.Literal('context-rule-v1'), slot: ref,
  revision: ref, predecessor: nullableRef, context: ref, semanticRevision: ref, realm: ref,
  generation: ref, modelGeneration: ref, currentHead: ref, rule: finiteRule });
const ruleSelection = t.Object({ slot: ref, revision: native, context: contextId,
  semanticRevision: native, realm: native }, { additionalProperties: false });
const ruleFact = t.Object({ id: t.String({ minLength: 1, maxLength: 512 }),
  subject: reference, predicate: reference, object: reference, definition: reference,
  context: contextId, contextRevision: native, realm: native }, { additionalProperties: false });
const derivedFact = t.Object({ subject: ref, predicate: ref, object: ref, context: ref,
  contextRevision: ref, realm: ref, ruleRevision: ref, inputIds: t.Array(ref),
  definitions: t.Array(ref) });
const rulePlanResponse = t.Union([
  t.Object({ profile: t.Literal('context-rule-plan-v1'), state: t.Literal('rejected'),
    reason: t.Literal('conflicting-rules'), conflictingRevisions: t.Array(ref),
    inferences: t.Array(derivedFact, { maxItems: 0 }), accepted: t.Literal(false),
    authorizes: t.Literal(false) }),
  t.Object({ profile: t.Literal('context-rule-plan-v1'),
    state: t.Union([t.Literal('complete'), t.Literal('partial')]),
    inferences: t.Array(derivedFact), exactCount: t.Nullable(t.Integer()),
    accepted: t.Literal(false), authorizes: t.Literal(false), modelGeneration: ref,
    inspected: t.Integer(), generations: t.Array(ref), projectionKey: ref }),
]);
const dependencyWriteResponse = t.Object({ profile: t.Literal('context-rule-dependency-v1'),
  slot: ref, generation: ref, ...writtenFields });
const invalidationResponse = t.Object({ profile: t.Literal('context-rule-invalidation-v1'),
  slot: ref, currentGeneration: ref,
  items: t.Array(t.Object({ dependency: ref, target: ref, previousGeneration: ref })),
  next: nullableRef });
const meaningBasis = t.Union([t.Object({ state: t.Literal('none') }),
  t.Object({ state: t.Literal('unavailable') }),
  t.Object({ state: t.Literal('readable'), context: ref, semanticRevision: ref,
    interpretationDefinitions: t.Array(ref) })]);
const statementWriteResponse = t.Object({ profile: t.Literal('statement-v1'), statement: ref,
  meaningKey: ref, meaningBasis, interpretationBasis: t.Optional(basis), ...writtenFields });
const statementWithdrawalResponse = t.Object({ profile: t.Literal('statement-v1'), statement: ref,
  state: t.Literal('withdrawn'), ...writtenFields });
const statementReadResponse = t.Object({ profile: t.Literal('statement-v1'), statement: ref,
  subject: ref, predicate: ref, relationDefinition: ref, value,
  applicability: t.Array(ref), speaker: ref, meaningKey: ref,
  state: t.Union([t.Literal('active'), t.Literal('withdrawn')]), revision: ref,
  meaningBasis, export: t.Record(t.String(), t.Unknown()), sourcePosition: source });
const decisionWriteResponse = t.Object({ profile: t.Literal('statement-decision-v1'),
  slot: ref, decision: ref, outcome: t.Union([t.Literal('accepted'), t.Literal('rejected'),
    t.Literal('withdrawn')]), ...writtenFields });
const migrationWriteResponse = t.Object({ profile: t.Literal('statement-migration-v1'),
  application: ref, slot: ref, decision: ref, ...writtenFields });
const cutoverWriteResponse = t.Object({ profile: t.Literal('statement-cutover-v1'), ...writtenFields });
const pendingMigrationResponse = t.Object({ profile: t.Literal('statement-migration-v1'),
  pending: t.Array(t.Object({ application: ref, decision: ref })), complete: t.Boolean() });
const decisionTarget = t.Union([t.Object({ kind: t.Literal('statement'), statement: ref }),
  t.Object({ kind: t.Literal('qualified-fact'), meaningKey: ref })]);
const acceptanceResult = t.Union([
  t.Object({ state: t.Union([t.Literal('accepted'), t.Literal('rejected')]),
    source: t.Union([t.Literal('local'), t.Literal('inherited-global'), t.Literal('global')]),
    slot: ref, decision: ref }),
  t.Object({ state: t.Literal('absent'), source: t.Literal('none') }),
  t.Object({ state: t.Literal('unavailable') }),
]);
const statementResolutionResponse = t.Object({ profile: t.Literal('statement-resolution-v1'),
  target: decisionTarget, acceptance, acceptanceContext: ref, policy: ref,
  result: acceptanceResult, sourcePosition: source });
const graphWriteResponses = { 202: pendingOperation, ...writeProblems };
const graphReadResponses = { ...authorizedReadProblems, 409: problemResult(409) };
const interpretationProblem = t.Object({ type: ref, status: t.Literal(409),
  code: t.Literal('interpretation_unresolved'), title: ref,
  interpretation: t.Union([t.Object({ state: t.Literal('unavailable') }),
    t.Object({ state: t.Literal('ambiguous'), basis, context: ref, semanticRevision: ref,
      selectionRevision: nullableRef,
      candidates: t.Array(t.Object({ relation: ref, definition: ref, entryRevision: ref }), { maxItems: 26 }) }),
    t.Object({ state: t.Union([t.Literal('unresolved'), t.Literal('disabled')]), basis,
      context: ref, semanticRevision: ref, entryRevision: ref, selectionRevision: nullableRef })]) });

function contextError(error: unknown): Response {
  if (error instanceof FiniteRuleRejected || error instanceof ReasoningInputRejected
    || error instanceof ReasoningProfileRejected) {
    return problem(422, 'rule_profile_rejected', 'Selected rule or fact is outside the admitted profile');
  }
  if (error instanceof InvalidContextCommand || error instanceof InvalidContextSchemaInput
    || error instanceof InvalidStatementSchemaInput || error instanceof PrivateSelectionInvalid) {
    return problem(400, 'invalid_request', 'Request fields are invalid');
  }
  if (error instanceof StaleContextCommand || error instanceof PrivateSelectionStale) {
    return problem(409, 'stale_head', 'Expected head is stale');
  }
  if (error instanceof ContextCommandUnavailable) {
    return problem(409, 'target_unavailable', 'Context, Statement or acceptance target is unavailable');
  }
  if (error instanceof PrivateSelectionDenied) return problem(403, 'authority_denied', 'Principal is not admitted');
  if (error instanceof PrivateSelectionConflict) {
    return problem(409, 'idempotency_conflict', 'Idempotency key conflicts with an earlier request');
  }
  if (error instanceof PrivateSelectionUnavailable) return problem(503, 'selection_unavailable', 'Selection store is busy');
  if (error instanceof ContextNotFound || error instanceof StatementNotFound) {
    return problem(404, 'not_found', 'No readable resource');
  }
  if (error instanceof PendingContextCommand) {
    return Response.json({ operationId: error.operationId, status: 'reconciling', phase: error.family,
      result: null, retry: { allowed: true, afterMs: 1000 } }, { status: 202, headers: { ...noStore, 'retry-after': '1' } });
  }
  return commandError(error);
}

function readError(error: unknown): Response {
  if (error instanceof WorkReadInvalid || error instanceof WorkReadMissing || error instanceof WorkReadMoved
    || error instanceof WorkReadUnavailable) return workReadError(error);
  if (error instanceof ContextCommandUnavailable) {
    return problem(503, 'context_unavailable', 'Required state is unavailable');
  }
  return contextError(error);
}

function idempotencyKey(request: Request): string | Response {
  const key = request.headers.get('idempotency-key');
  return key && /^[A-Za-z0-9:_./-]{1,128}$/.test(key) ? key
    : problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
}

function written(receipt: ContextCommandReceipt & { replayed: boolean }, body: Record<string, unknown>): Response {
  return Response.json({ ...body, component: receipt.component, revision: receipt.revision,
    expectedHead: receipt.expectedHead ?? null, sourcePosition: { datasetId: 'product',
      dataEpoch: receipt.dataEpoch, sequence: receipt.sequence }, replayed: receipt.replayed },
  { status: receipt.replayed ? 200 : 201, headers: noStore });
}

export function contextRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const selections = (work as MainWorkDependencies & ContextRouteDependencies).contextSelections;
  const env = work.environment;
  const privateReader = (principal: VerifiedPrincipal | null, actingSubject: string | null) =>
    async (context: string) => !!principal && !!actingSubject && !!selections
      && selections.canReadPrivate(principal, actingSubject, context);
  /** Optional authentication for reads: anonymous callers see only Public bases. */
  const reader = async (request: Request, actingSubject?: string) => {
    if (!request.headers.get('authorization') || !actingSubject) return privateReader(null, null);
    return privateReader(await work.account.verify(request, ['context:read']), actingSubject);
  };
  const speakerFor = (input: RecordStatementInput, principal: VerifiedPrincipal): InterpretationSpeaker =>
    input.speaker.kind === 'realm' ? { kind: 'realm', realm: input.speaker.realm }
      : { kind: 'personal', canReadPrivate: privateReader(principal, input.actingSubject),
        ...(selections ? { privateCandidates: (scopes: ContextSelectionScope[]) =>
          selections.candidates(principal, scopes) } : {}) };
  const interpretationBody = (interpretation: Interpretation) => interpretation.state === 'unavailable'
    ? { state: 'unavailable' } : interpretation;

  return new Elysia()
    .post('/v1/context-rules', {
      body: t.Object({ profile: t.Literal('context-rule-v1'), context: contextId,
        semanticRevision: native, realm: native, expectedHead: t.Nullable(native),
        rule: finiteRule, actingSubject: native }, { additionalProperties: false }),
      response: { 200: ruleWriteResponse, 201: ruleWriteResponse, ...graphWriteResponses,
        422: problemResult(422) },
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { context: body.context, semanticRevision: body.semanticRevision,
          realm: body.realm, expectedHead: body.expectedHead, rule: body.rule,
          actingSubject: body.actingSubject };
        const plan = contextRuleRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: CONTEXT_RULE_FAMILY, oauthScope: 'context:write', scope: plan.scope,
          action: plan.action, actingSubject: body.actingSubject, digest: plan.digest,
          input, idempotencyKey: key, execute: admission => changeContextRule(env, admission, input) });
        const rule = await readContextRule(env, plan.slot, receipt.revision!);
        return written(receipt, { profile: 'context-rule-v1', slot: plan.slot, generation: rule.generation });
      } catch (error) { return contextError(error); }
    })
    .get('/v1/context-rules', {
      query: t.Object({ slot: ref, revision: t.Optional(native), actingSubject: native },
        { additionalProperties: false }),
      response: { 200: ruleReadResponse, ...graphReadResponses },
    }, async ({ request, query }) => {
      try {
        await work.account.verify(request, ['context:read']);
        const basis = await ruleContextBasis(env, query.slot);
        await readContextRevision(env, basis.context, basis.semanticRevision,
          await reader(request, query.actingSubject));
        const rule = await readContextRule(env, query.slot, query.revision ?? null);
        return Response.json({ profile: 'context-rule-v1', ...rule }, { headers: noStore });
      } catch (error) { return readError(error); }
    })
    .post('/v1/context-rule-plans', {
      body: t.Object({ profile: t.Literal('context-rule-plan-v1'),
        selections: t.Array(ruleSelection, { minItems: 1, maxItems: 16 }),
        facts: t.Array(ruleFact, { maxItems: 10_000 }), actingSubject: native },
      { additionalProperties: false }),
      response: { 200: rulePlanResponse, ...graphReadResponses, 422: problemResult(422) },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['context:read']);
        const facts = body.facts.map(fact => ({ ...fact,
          scope: { kind: 'realm' as const, id: fact.realm } }));
        const plan = await planContextRules(env, body.selections, facts,
          await reader(request, body.actingSubject), `${principal.issuer}:${principal.subject}`);
        return Response.json({ profile: 'context-rule-plan-v1', ...plan }, { headers: noStore });
      } catch (error) { return readError(error); }
    })
    .post('/v1/context-rule-dependencies', {
      body: t.Object({ profile: t.Literal('context-rule-dependency-v1'), slot: ref,
        expectedGeneration: ref, targets: t.Array(native, { minItems: 1, maxItems: 64 }),
        actingSubject: native }, { additionalProperties: false }),
      response: { 200: dependencyWriteResponse, 201: dependencyWriteResponse,
        ...graphWriteResponses },
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { slot: body.slot, expectedGeneration: body.expectedGeneration,
          targets: body.targets, actingSubject: body.actingSubject };
        const plan = dependencyRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: CONTEXT_RULE_DEPENDENCY_FAMILY, oauthScope: 'context:write', scope: plan.scope,
          action: plan.action, actingSubject: body.actingSubject, digest: plan.digest,
          input, idempotencyKey: key,
          execute: admission => registerRuleDependencies(env, admission, input) });
        return written(receipt, { profile: 'context-rule-dependency-v1', slot: input.slot,
          generation: input.expectedGeneration });
      } catch (error) { return contextError(error); }
    })
    .get('/v1/context-rule-dependencies', {
      query: t.Object({ slot: ref, expectedGeneration: ref, after: t.Optional(ref), limit: t.Optional(t.Integer()),
        actingSubject: native }, { additionalProperties: false }),
      response: { 200: invalidationResponse, ...graphReadResponses },
    }, async ({ request, query }) => {
      try {
        await work.account.verify(request, ['context:read']);
        const basis = await ruleContextBasis(env, query.slot);
        await readContextRevision(env, basis.context, basis.semanticRevision,
          await reader(request, query.actingSubject));
        return Response.json(await staleRuleDependencies(env, query.slot, query.expectedGeneration,
          query.after ?? null, query.limit ?? 32), { headers: noStore });
      } catch (error) { return readError(error); }
    })
    .post('/v1/contexts', {
      body: t.Object({ profile: t.Literal('context-v1'), role: t.Union([t.Literal('global'), t.Literal('shared')]),
        disclosure: t.Union([t.Literal('public'), t.Literal('private')]), base: t.Nullable(native),
        entries: t.Array(entry, { maxItems: 256 }), actingSubject: native }, { additionalProperties: false }),
      response: { 200: contextWriteResponse, 201: contextWriteResponse, ...graphWriteResponses },
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { role: body.role, disclosure: body.disclosure, base: body.base, entries: body.entries,
          actingSubject: body.actingSubject };
        const plan = createContextRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: CONTEXT_FAMILIES.create, oauthScope: 'context:write', scope: plan.scope, action: plan.action,
          actingSubject: body.actingSubject, digest: plan.digest, input, idempotencyKey: key,
          execute: admission => createContext(env, admission, input) });
        return written(receipt, { profile: 'context-v1', context: receipt.component, semanticRevision: receipt.revision });
      } catch (error) { return contextError(error); }
    })
    .post('/v1/contexts/:id/semantic-revisions', {
      params: t.Object({ id: t.String({ pattern: '^([0-9a-f-]{36}|global)$' }) }),
      body: t.Object({ profile: t.Literal('context-v1'), expectedSemanticHead: native, base: t.Nullable(native),
        entries: t.Array(entry, { maxItems: 256 }), actingSubject: native }, { additionalProperties: false }),
      response: { 200: contextWriteResponse, 201: contextWriteResponse, ...graphWriteResponses },
    }, async ({ request, params, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { context: params.id === 'global' ? 'urn:rezics:semantic-context:global'
          : `https://rezics.com/id/${params.id}`, expectedSemanticHead: body.expectedSemanticHead,
        base: body.base, entries: body.entries, actingSubject: body.actingSubject };
        const plan = reviseContextRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: CONTEXT_FAMILIES.revise, oauthScope: 'context:write', scope: plan.scope, action: plan.action,
          actingSubject: body.actingSubject, digest: plan.digest, input, idempotencyKey: key,
          execute: admission => reviseContext(env, admission, input) });
        return written(receipt, { profile: 'context-v1', context: receipt.component, semanticRevision: receipt.revision });
      } catch (error) { return contextError(error); }
    })
    .post('/v1/contexts/:id/state-transitions', {
      params: t.Object({ id: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      body: t.Object({ profile: t.Literal('context-v1'), expectedSemanticHead: native,
        state: t.Union([t.Literal('active'), t.Literal('retired')]), actingSubject: native },
      { additionalProperties: false }),
      response: { 200: contextWriteResponse, 201: contextWriteResponse, ...graphWriteResponses },
    }, async ({ request, params, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { context: `https://rezics.com/id/${params.id}`,
          expectedSemanticHead: body.expectedSemanticHead, state: body.state,
          actingSubject: body.actingSubject };
        const plan = setContextStateRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: CONTEXT_FAMILIES.state, oauthScope: 'context:write', scope: plan.scope,
          action: plan.action, actingSubject: body.actingSubject, digest: plan.digest,
          input, idempotencyKey: key, execute: admission => setContextState(env, admission, input) });
        return written(receipt, { profile: 'context-v1', context: receipt.component,
          semanticRevision: receipt.revision });
      } catch (error) { return contextError(error); }
    })
    .post('/v1/contexts/:id/preferences', {
      params: t.Object({ id: t.String({ pattern: '^([0-9a-f-]{36}|global)$' }) }),
      body: t.Object({ profile: t.Literal('context-preference-v1'),
        expectedPreferenceHead: t.Nullable(native), labels: t.Array(labelPreference, { maxItems: 256 }),
        actingSubject: native }, { additionalProperties: false }),
      response: { 200: preferenceWriteResponse, 201: preferenceWriteResponse, ...graphWriteResponses },
    }, async ({ request, params, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { context: params.id === 'global' ? 'urn:rezics:semantic-context:global'
          : `https://rezics.com/id/${params.id}`, expectedPreferenceHead: body.expectedPreferenceHead,
          labels: body.labels, actingSubject: body.actingSubject };
        const plan = contextPreferencesRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: CONTEXT_PREFERENCE_FAMILY, oauthScope: 'context:write', scope: plan.scope,
          action: plan.action, actingSubject: body.actingSubject, digest: plan.digest, input,
          idempotencyKey: key, execute: admission => setContextPreferences(env, admission, input) });
        return written(receipt, { profile: 'context-preference-v1', context: input.context,
          preferenceRevision: receipt.revision });
      } catch (error) { return contextError(error); }
    })
    .get('/v1/contexts/:id/preferences', {
      params: t.Object({ id: t.String({ pattern: '^([0-9a-f-]{36}|global)$' }) }),
      query: t.Object({ actingSubject: t.Optional(native), revision: t.Optional(native) }),
      response: { 200: preferenceReadResponse, ...graphReadResponses },
    }, async ({ request, params, query }) => {
      try {
        const context = params.id === 'global' ? 'urn:rezics:semantic-context:global'
          : `https://rezics.com/id/${params.id}`;
        return Response.json(await readContextPreferences(env, context, query.revision ?? null,
          await reader(request, query.actingSubject)), { headers: noStore });
      } catch (error) { return readError(error); }
    })
    .get('/v1/contexts/:id/skos', {
      params: t.Object({ id: t.String({ pattern: '^([0-9a-f-]{36}|global)$' }) }),
      query: t.Object({ actingSubject: t.Optional(native), semanticRevision: t.Optional(native),
        preferenceRevision: t.Optional(native) }),
      response: { 200: skosReadResponse, ...graphReadResponses },
    }, async ({ request, params, query }) => {
      try {
        const context = params.id === 'global' ? 'urn:rezics:semantic-context:global'
          : `https://rezics.com/id/${params.id}`;
        return Response.json(await contextSkos(env, context, query.semanticRevision ?? null,
          query.preferenceRevision ?? null, await reader(request, query.actingSubject)), { headers: noStore });
      } catch (error) { return readError(error); }
    })
    .post('/v1/context-definition-equivalences', {
      body: t.Object({ profile: t.Literal('context-definition-equivalence-v1'), context: contextId,
        semanticRevision: native, relation: reference, left: equivalenceUse, right: equivalenceUse,
        actingSubject: native }, { additionalProperties: false }),
      response: { 200: equivalenceWriteResponse, 201: equivalenceWriteResponse, ...graphWriteResponses },
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { context: body.context, semanticRevision: body.semanticRevision,
          relation: body.relation, left: body.left, right: body.right, actingSubject: body.actingSubject };
        const plan = equivalenceRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: CONTEXT_EQUIVALENCE_FAMILY, oauthScope: 'context:write', scope: plan.scope,
          action: plan.action, actingSubject: body.actingSubject, digest: plan.digest, input,
          idempotencyKey: key, execute: admission => reviewDefinitionEquivalence(env, admission, input) });
        return written(receipt, { profile: 'context-definition-equivalence-v1', mapping: receipt.component });
      } catch (error) { return contextError(error); }
    })
    .get('/v1/context-definition-equivalences', {
      query: t.Object({ mapping: t.String({ pattern: '^urn:rezics:context-equivalence:[0-9a-f]{64}$' }),
        actingSubject: t.Optional(native) }),
      response: { 200: equivalenceReadResponse, ...graphReadResponses },
    }, async ({ request, query }) => {
      try {
        return Response.json(await readDefinitionEquivalence(env, query.mapping,
          await reader(request, query.actingSubject)), { headers: noStore });
      } catch (error) { return readError(error); }
    })
    .post('/v1/context-meaning-comparisons', {
      body: t.Object({ profile: t.Literal('context-meaning-comparison-v1'),
        left: native, right: native,
        mapping: t.Nullable(t.String({ pattern: '^urn:rezics:context-equivalence:[0-9a-f]{64}$' })),
        actingSubject: t.Optional(native) }, { additionalProperties: false }),
      response: { 200: meaningComparisonResponse, ...graphReadResponses },
    }, async ({ request, body }) => {
      try {
        return Response.json(await compareStatementMeanings(env, body.left, body.right,
          body.mapping, await reader(request, body.actingSubject)), { headers: noStore });
      } catch (error) { return readError(error); }
    })
    .post('/v1/context-definition-states', {
      body: t.Object({ profile: t.Literal('context-definition-state-v1'), definition: reference,
        expectedHead: t.Nullable(native), state: t.Union([t.Literal('active'), t.Literal('retired')]),
        actingSubject: native }, { additionalProperties: false }),
      response: { 200: definitionStateWriteResponse, 201: definitionStateWriteResponse, ...graphWriteResponses },
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { definition: body.definition, expectedHead: body.expectedHead,
          state: body.state, actingSubject: body.actingSubject };
        const plan = definitionStateRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: DEFINITION_STATE_FAMILY, oauthScope: 'context:write', scope: plan.scope,
          action: plan.action, actingSubject: body.actingSubject, digest: plan.digest,
          input, idempotencyKey: key, execute: admission => setDefinitionState(env, admission, input) });
        return written(receipt, { profile: 'context-definition-state-v1', definition: body.definition,
          state: body.state });
      } catch (error) { return contextError(error); }
    })
    .get('/v1/context-definition-states', {
      query: t.Object({ definition: reference, revision: t.Optional(native) }),
      response: { 200: definitionStateReadResponse, ...graphReadResponses },
    }, async ({ request, query }) => {
      try {
        await work.account.verify(request, ['context:read']);
        const state = await readDefinitionState(env, query.definition, query.revision ?? null);
        return state ? Response.json(state, { headers: noStore }) : problem(404, 'not_found', 'No definition state');
      } catch (error) { return readError(error); }
    })
    .get('/v1/contexts/:id', {
      params: t.Object({ id: t.String({ pattern: '^([0-9a-f-]{36}|global)$' }) }),
      query: t.Object({ actingSubject: t.Optional(native), revision: t.Optional(native) }),
      response: { 200: contextReadResponse, ...graphReadResponses },
    }, async ({ request, params, query }) => {
      try {
        const context = params.id === 'global' ? 'urn:rezics:semantic-context:global' : `https://rezics.com/id/${params.id}`;
        return Response.json(await readContextRevision(env, context, query.revision ?? null,
          await reader(request, query.actingSubject)), { headers: noStore });
      } catch (error) { return readError(error); }
    })
    .post('/v1/realms/:realm/context-selections', {
      params: t.Object({ realm: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      body: t.Object({ profile: t.Literal('context-selection-v1'), scope,
        selection: t.Nullable(t.Object({ context: contextId, semanticRevision: native }, { additionalProperties: false })),
        expectedHead: t.Nullable(native), actingSubject: native }, { additionalProperties: false }),
      response: { 200: selectionWriteResponse, 201: selectionWriteResponse, ...graphWriteResponses },
    }, async ({ request, params, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { realm: `https://rezics.com/id/${params.realm}`, scope: body.scope as ContextSelectionScope,
          selection: body.selection, expectedHead: body.expectedHead, actingSubject: body.actingSubject };
        const plan = selectRealmContextRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: CONTEXT_FAMILIES.realmSelect, oauthScope: 'context:select', scope: plan.scope, action: plan.action,
          actingSubject: body.actingSubject, digest: plan.digest, input, idempotencyKey: key,
          execute: admission => selectRealmContext(env, admission, input) });
        return written(receipt, { profile: 'context-selection-v1', selection: receipt.component,
          selectionRevision: receipt.revision, state: body.selection ? 'selected' : 'cleared' });
      } catch (error) { return contextError(error); }
    })
    .put('/v1/me/context-selections', {
      body: t.Object({ profile: t.Literal('context-private-selection-v1'), scope,
        selection: t.Nullable(t.Object({ context: contextId, semanticRevision: native }, { additionalProperties: false })),
        expectedRevision: t.Nullable(t.String({ pattern: '^[0-9a-f-]{36}$' })),
        actingSubject: t.Optional(native) }, { additionalProperties: false }),
      response: { 200: privateSelectionWriteResponse, 201: privateSelectionWriteResponse, ...writeProblems },
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      if (!selections) return problem(503, 'selection_unavailable', 'Private selection store is not configured');
      try {
        const principal = await work.account.verify(request, ['context:select']);
        const selection = body.selection;
        const result = await selections.set(principal, { scope: body.scope as ContextSelectionScope, selection,
          expectedRevision: body.expectedRevision, idempotencyKey: key }, async () => {
          await assertGraphAdmissionOpen(fuseki, env.lineage);
          const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?disclosure WHERE {
            GRAPH ${iri(GRAPHS.current)} { ${iri(selection!.context)} a rv:SemanticContext ;
              rv:contextState rv:Active ; rv:disclosure ?disclosure . }
            GRAPH ${iri(GRAPHS.revisions)} { ${iri(selection!.semanticRevision)} a rv:ContextSemanticRevision ;
              rv:component ${iri(selection!.context)} . }
            ${activeDefinitionDependenciesGuard(selection!.semanticRevision)} }`)).results?.bindings ?? [];
          const readable = rows.length === 1 && (rows[0]?.disclosure?.value === `${RV}Public`
            || (rows[0]?.disclosure?.value === `${RV}Private` && !!body.actingSubject
              && await selections.canReadPrivate(principal, body.actingSubject, selection!.context)));
          // An unreadable Context is indistinguishable from a missing one.
          if (!readable) throw new ContextCommandUnavailable('selected Context revision is unavailable');
        });
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: noStore });
      } catch (error) { return contextError(error); }
    })
    .get('/v1/me/context-selections', {
      query: t.Object({ kind: t.Union([t.Literal('default'), t.Literal('object'), t.Literal('object-relation')]),
        object: t.Optional(native), relation: t.Optional(reference) }),
      response: { 200: privateSelectionReadResponse, ...graphReadResponses },
    }, async ({ request, query }) => {
      if (!selections) return problem(503, 'selection_unavailable', 'Private selection store is not configured');
      try {
        const principal = await work.account.verify(request, ['context:select']);
        const selected = (query.kind === 'default' ? { kind: 'default' }
          : query.kind === 'object' ? { kind: 'object', object: query.object ?? '' }
            : { kind: 'object-relation', object: query.object ?? '', relation: query.relation ?? '' }) as ContextSelectionScope;
        const found = await selections.read(principal, selected);
        return found ? Response.json(found, { headers: noStore }) : problem(404, 'not_found', 'No selection');
      } catch (error) { return contextError(error); }
    })
    .post('/v1/context-interpretations', {
      body: t.Object({ profile: t.Literal('context-interpretation-v1'),
        speaker: t.Union([t.Object({ kind: t.Literal('personal') }, { additionalProperties: false }),
          t.Object({ kind: t.Literal('realm'), realm: native }, { additionalProperties: false })]),
        object: reference, relation: t.Nullable(reference),
        explicit: t.Nullable(t.Object({ context: contextId, semanticRevision: native }, { additionalProperties: false })),
        actingSubject: native }, { additionalProperties: false }),
      response: { 200: interpretationResponse, ...graphReadResponses },
    }, async ({ request, body }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, env.lineage);
        const principal = await work.account.verify(request, ['context:read']);
        const input = { speaker: body.speaker, actingSubject: body.actingSubject } as RecordStatementInput;
        const interpretation = await resolveInterpretation(env, { object: body.object, relation: body.relation,
          explicit: body.explicit, speaker: speakerFor(input, principal) });
        return Response.json({ profile: 'context-interpretation-v1', ...interpretationBody(interpretation) },
          { headers: noStore });
      } catch (error) { return readError(error); }
    })
    .post('/v1/statements', {
      body: t.Object({ profile: t.Literal('statement-v1'),
        speaker: t.Union([t.Object({ kind: t.Literal('personal') }, { additionalProperties: false }),
          t.Object({ kind: t.Literal('realm'), realm: native }, { additionalProperties: false })]),
        subject: native, predicate: reference, relationDefinition: reference, value,
        applicability: t.Array(reference, { maxItems: 8 }),
        interpretation: t.Union([t.Object({ kind: t.Literal('selected') }, { additionalProperties: false }),
          t.Object({ kind: t.Literal('explicit'), context: contextId, semanticRevision: native },
            { additionalProperties: false })]),
        expectedInterpretation: t.Optional(t.Object({ semanticRevision: t.Nullable(native),
          definition: t.Nullable(reference) }, { additionalProperties: false })),
        evidence: t.Array(reference, { maxItems: 16 }), actingSubject: native }, { additionalProperties: false }),
      response: { 200: statementWriteResponse, 201: statementWriteResponse, ...graphWriteResponses,
        409: t.Union([problemResult(409), interpretationProblem]) },
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      const seen: { interpretation?: Interpretation } = {};
      try {
        const input = { ...body } as unknown as RecordStatementInput;
        const plan = recordStatementRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: STATEMENT_FAMILIES.record, oauthScope: 'statement:write', scope: plan.scope, action: plan.action,
          actingSubject: body.actingSubject, digest: plan.digest, input, idempotencyKey: key,
          execute: async (admission, principal) => {
            const speaker = speakerFor(input, principal);
            const interpretation = seen.interpretation = await statementInterpretation(env, input, speaker);
            // Sealed as unavailable: the same key cannot later commit a different meaning.
            if (interpretation.state !== 'resolved') throw new ContextCommandUnavailable('interpretation is not resolved');
            return recordStatement(env, admission, input, speaker);
          } });
        const read = await readStatement(env, receipt.component!, async () => true);
        return written(receipt, { profile: 'statement-v1', statement: receipt.component,
          meaningKey: read.meaningKey, meaningBasis: read.meaningBasis,
          ...(seen.interpretation?.state === 'resolved' ? { interpretationBasis: seen.interpretation.basis } : {}) });
      } catch (error) {
        const interpretation = seen.interpretation;
        if (error instanceof ContextCommandUnavailable && interpretation && interpretation.state !== 'resolved') {
          return Response.json({ type: 'https://rezics.com/problems/interpretation_unresolved', status: 409,
            code: 'interpretation_unresolved', title: 'Interpretation is not resolved',
            interpretation: interpretationBody(interpretation) },
          { status: 409, headers: { 'content-type': 'application/problem+json', ...noStore } });
        }
        return contextError(error);
      }
    })
    .get('/v1/statements/:id', {
      params: t.Object({ id: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.Optional(native), position: readingPositionQuery }),
      response: { 200: statementReadResponse, ...graphReadResponses },
    }, async ({ request, params, query }) => {
      try {
        const principal = request.headers.get('authorization') && query.actingSubject
          ? await work.account.verify(request, ['context:read']) : null;
        const read = await readingPositionRead(work, request, principal, query.actingSubject, async boundary => {
          const statement = await readStatement(env, `https://rezics.com/id/${params.id}`,
            privateReader(principal, query.actingSubject ?? null));
          const records = [statement.statement, statement.subject, ...statement.applicability,
            ...(statement.value.kind === 'resource' ? [statement.value.iri] : [])];
          const visible = await boundary.visible(records);
          if (records.some(record => !visible.has(record))) throw new StatementNotFound('Statement is unavailable');
          if (boundary.requiresPosition(statement.statement)) {
            const subjects = await targetSummaries(boundary.session,[statement.subject,
              ...(statement.value.kind === 'resource' ? [statement.value.iri] : [])]);
            if (subjects.summaries.some(subject => subject.status !== 'available')) {
              throw new StatementNotFound('Statement is unavailable');
            }
          }
          return statement;
        });
        return Response.json(read, { headers: noStore });
      } catch (error) { return readError(error); }
    })
    .post('/v1/statements/:id/withdrawals', {
      params: t.Object({ id: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      body: t.Object({ profile: t.Literal('statement-v1'), speaker: t.Union([
        t.Object({ kind: t.Literal('personal') }, { additionalProperties: false }),
        t.Object({ kind: t.Literal('realm'), realm: native }, { additionalProperties: false }),
      ]), expectedHead: native, actingSubject: native }, { additionalProperties: false }),
      response: { 200: statementWithdrawalResponse, 201: statementWithdrawalResponse, ...graphWriteResponses },
    }, async ({ request, params, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { statement: `https://rezics.com/id/${params.id}`, speaker: body.speaker,
          expectedHead: body.expectedHead, actingSubject: body.actingSubject };
        const plan = withdrawStatementRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: STATEMENT_FAMILIES.withdraw, oauthScope: 'statement:write', scope: plan.scope,
          action: plan.action, actingSubject: body.actingSubject, digest: plan.digest, input,
          idempotencyKey: key, execute: admission => withdrawStatement(env, admission, input) });
        return written(receipt, { profile: 'statement-v1', statement: input.statement,
          state: 'withdrawn' });
      } catch (error) { return contextError(error); }
    })
    .get('/v1/statement-migrations/v1/pending', {
      response: { 200: pendingMigrationResponse, ...graphReadResponses },
    }, async ({ request }) => {
      try {
        await work.account.verify(request, ['statement:decide']);
        await assertGraphAdmissionOpen(fuseki, env.lineage);
        const rows = (await fuseki.query(`PREFIX rv: <${RV}>
          SELECT ?application ?decision WHERE { GRAPH ${iri(GRAPHS.current)} {
            ?application a rv:ClassificationApplication ; rv:decisionHead ?decision .
            FILTER NOT EXISTS { ?statement a <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> ;
              rv:migratedFrom ?application ; rv:meaningKey ?key .
              ?slot a rv:DecisionSlot ; rv:decisionTarget ?key .
              GRAPH ${iri(GRAPHS.revisions)} { ?converted a rv:StatementDecision ;
                rv:component ?slot ; rv:convertedFrom ?decision ; rv:support ?statement . } }
          } } ORDER BY ?application LIMIT 101`)).results?.bindings ?? [];
        return Response.json({ profile: 'statement-migration-v1',
          pending: rows.slice(0, 100).map(row => ({ application: row.application!.value,
            decision: row.decision!.value })), complete: rows.length === 0 }, { headers: noStore });
      } catch (error) { return readError(error); }
    })
    .post('/v1/statement-migrations/v1/cutover', {
      body: t.Object({ profile: t.Literal('statement-cutover-v1'), actingSubject: native },
        { additionalProperties: false }),
      response: { 200: cutoverWriteResponse, 201: cutoverWriteResponse, ...graphWriteResponses },
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const plan = cutoverRequest(body.actingSubject);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: CUTOVER_FAMILY, oauthScope: 'statement:decide', scope: plan.scope,
          action: plan.action, actingSubject: body.actingSubject, digest: plan.digest,
          input: body, idempotencyKey: key,
          execute: admission => cutoverV1Decisions(env, admission, body.actingSubject) });
        return written(receipt, { profile: 'statement-cutover-v1' });
      } catch (error) { return contextError(error); }
    })
    .post('/v1/statement-migrations/v1/:id', {
      params: t.Object({ id: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      body: t.Object({ profile: t.Literal('statement-migration-v1'),
        expectedDecision: native, actingSubject: native }, { additionalProperties: false }),
      response: { 200: migrationWriteResponse, 201: migrationWriteResponse, ...graphWriteResponses },
    }, async ({ request, params, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const application = `https://rezics.com/id/${params.id}`;
        const input = { application, expectedDecision: body.expectedDecision, actingSubject: body.actingSubject };
        const plan = migrationRequest(application, body.expectedDecision, body.actingSubject);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: MIGRATION_FAMILY, oauthScope: 'statement:decide', scope: plan.scope,
          action: plan.action, actingSubject: body.actingSubject, digest: plan.digest,
          input, idempotencyKey: key, execute: admission => migrateV1Decision(env, admission, input) });
        return written(receipt, { profile: 'statement-migration-v1', application,
          slot: receipt.component, decision: receipt.revision });
      } catch (error) { return contextError(error); }
    })
    .post('/v1/statement-decisions', {
      body: t.Object({ profile: t.Literal('statement-decision-v1'), target, acceptance,
        expectedDecisionHead: t.Nullable(native),
        outcome: t.Union([t.Literal('accepted'), t.Literal('rejected'), t.Literal('withdrawn')]),
        actingSubject: native }, { additionalProperties: false }),
      response: { 200: decisionWriteResponse, 201: decisionWriteResponse, ...graphWriteResponses },
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { target: body.target, acceptance: body.acceptance, expectedDecisionHead: body.expectedDecisionHead,
          outcome: body.outcome, actingSubject: body.actingSubject };
        const plan = statementDecisionRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: STATEMENT_FAMILIES.decide, oauthScope: 'statement:decide', scope: plan.scope, action: plan.action,
          actingSubject: body.actingSubject, digest: plan.digest, input, idempotencyKey: key,
          execute: admission => setStatementDecision(env, admission, input) });
        return written(receipt, { profile: 'statement-decision-v1', slot: receipt.component,
          decision: receipt.revision, outcome: body.outcome });
      } catch (error) { return contextError(error); }
    })
    .post('/v1/statement-resolutions', {
      body: t.Object({ profile: t.Literal('statement-resolution-v1'), target: t.Union([
        t.Object({ kind: t.Literal('statement'), statement: native }, { additionalProperties: false }),
        t.Object({ kind: t.Literal('qualified-fact'), meaningKey: t.String({ pattern: '^urn:rezics:meaning:[0-9a-f]{64}$' }) },
          { additionalProperties: false })]), acceptance }, { additionalProperties: false }),
      response: { 200: statementResolutionResponse, ...graphReadResponses },
    }, async ({ body }) => {
      try {
        return Response.json(await resolveStatementAcceptance(env, body.target, body.acceptance), { headers: noStore });
      } catch (error) { return readError(error); }
    });
}
