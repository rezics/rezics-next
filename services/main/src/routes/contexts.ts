import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../modules/access/admission.ts';
import { ContextCommandUnavailable, InvalidContextCommand, PendingContextCommand, StaleContextCommand,
  runAdmittedCommand, type ContextCommandReceipt } from '../modules/context/command.ts';
import { createContext, createContextRequest, reviseContext, reviseContextRequest, selectRealmContext,
  selectRealmContextRequest, CONTEXT_FAMILIES } from '../modules/context/graph.ts';
import { resolveInterpretation, type Interpretation,
  type InterpretationSpeaker } from '../modules/context/interpretation.ts';
import { PrivateContextSelections, PrivateSelectionConflict, PrivateSelectionDenied, PrivateSelectionInvalid,
  PrivateSelectionStale, PrivateSelectionUnavailable } from '../modules/context/private-selection.ts';
import { ContextNotFound, readContextRevision } from '../modules/context/read.ts';
import { InvalidContextSchemaInput, type ContextSelectionScope } from '../modules/context/schema.ts';
import { recordStatement, recordStatementRequest, setStatementDecision, statementDecisionRequest,
  statementInterpretation, STATEMENT_FAMILIES, type RecordStatementInput } from '../modules/statement/graph.ts';
import { StatementNotFound, readStatement, resolveStatementAcceptance } from '../modules/statement/read.ts';
import { InvalidStatementSchemaInput } from '../modules/statement/schema.ts';
import { GRAPHS, RV, iri } from '../modules/work/activate.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

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

function contextError(error: unknown): Response {
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
    return privateReader(await work.account.verify(request, ['work:read']), actingSubject);
  };
  const speakerFor = (input: RecordStatementInput, principal: VerifiedPrincipal): InterpretationSpeaker =>
    input.speaker.kind === 'realm' ? { kind: 'realm', realm: input.speaker.realm }
      : { kind: 'personal', canReadPrivate: privateReader(principal, input.actingSubject),
        ...(selections ? { privateCandidates: (scopes: ContextSelectionScope[]) =>
          selections.candidates(principal, scopes) } : {}) };
  const interpretationBody = (interpretation: Interpretation) => interpretation.state === 'unavailable'
    ? { state: 'unavailable' } : interpretation;

  return new Elysia()
    .post('/v1/contexts', {
      body: t.Object({ profile: t.Literal('context-v1'), role: t.Union([t.Literal('global'), t.Literal('shared')]),
        disclosure: t.Union([t.Literal('public'), t.Literal('private')]), base: t.Nullable(native),
        entries: t.Array(entry, { maxItems: 256 }), actingSubject: native }, { additionalProperties: false }),
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { role: body.role, disclosure: body.disclosure, base: body.base, entries: body.entries,
          actingSubject: body.actingSubject };
        const plan = createContextRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: CONTEXT_FAMILIES.create, oauthScope: 'classification:define', scope: plan.scope, action: plan.action,
          actingSubject: body.actingSubject, digest: plan.digest, input, idempotencyKey: key,
          execute: admission => createContext(env, admission, input) });
        return written(receipt, { profile: 'context-v1', context: receipt.component, semanticRevision: receipt.revision });
      } catch (error) { return contextError(error); }
    })
    .post('/v1/contexts/:id/semantic-revisions', {
      params: t.Object({ id: t.String({ pattern: '^([0-9a-f-]{36}|global)$' }) }),
      body: t.Object({ profile: t.Literal('context-v1'), expectedSemanticHead: native, base: t.Nullable(native),
        entries: t.Array(entry, { maxItems: 256 }), actingSubject: native }, { additionalProperties: false }),
    }, async ({ request, params, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { context: params.id === 'global' ? 'urn:rezics:semantic-context:global'
          : `https://rezics.com/id/${params.id}`, expectedSemanticHead: body.expectedSemanticHead,
        base: body.base, entries: body.entries, actingSubject: body.actingSubject };
        const plan = reviseContextRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: CONTEXT_FAMILIES.revise, oauthScope: 'classification:define', scope: plan.scope, action: plan.action,
          actingSubject: body.actingSubject, digest: plan.digest, input, idempotencyKey: key,
          execute: admission => reviseContext(env, admission, input) });
        return written(receipt, { profile: 'context-v1', context: receipt.component, semanticRevision: receipt.revision });
      } catch (error) { return contextError(error); }
    })
    .get('/v1/contexts/:id', {
      params: t.Object({ id: t.String({ pattern: '^([0-9a-f-]{36}|global)$' }) }),
      query: t.Object({ actingSubject: t.Optional(native), revision: t.Optional(native) }),
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
    }, async ({ request, params, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { realm: `https://rezics.com/id/${params.realm}`, scope: body.scope as ContextSelectionScope,
          selection: body.selection, expectedHead: body.expectedHead, actingSubject: body.actingSubject };
        const plan = selectRealmContextRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: CONTEXT_FAMILIES.realmSelect, oauthScope: 'realm:classify', scope: plan.scope, action: plan.action,
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
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      if (!selections) return problem(503, 'selection_unavailable', 'Private selection store is not configured');
      try {
        const principal = await work.account.verify(request, ['classification:define']);
        const selection = body.selection;
        const result = await selections.set(principal, { scope: body.scope as ContextSelectionScope, selection,
          expectedRevision: body.expectedRevision, idempotencyKey: key }, async () => {
          await assertGraphAdmissionOpen(fuseki, env.lineage);
          const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?disclosure WHERE {
            GRAPH ${iri(GRAPHS.current)} { ${iri(selection!.context)} a rv:SemanticContext ;
              rv:contextState rv:Active ; rv:disclosure ?disclosure . }
            GRAPH ${iri(GRAPHS.revisions)} { ${iri(selection!.semanticRevision)} a rv:ContextSemanticRevision ;
              rv:component ${iri(selection!.context)} . } }`)).results?.bindings ?? [];
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
    }, async ({ request, query }) => {
      if (!selections) return problem(503, 'selection_unavailable', 'Private selection store is not configured');
      try {
        const principal = await work.account.verify(request, ['classification:define']);
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
    }, async ({ request, body }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, env.lineage);
        const principal = await work.account.verify(request, ['work:read']);
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
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      const seen: { interpretation?: Interpretation } = {};
      try {
        const input = { ...body } as unknown as RecordStatementInput;
        const plan = recordStatementRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: STATEMENT_FAMILIES.record, oauthScope: 'classification:define', scope: plan.scope, action: plan.action,
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
      query: t.Object({ actingSubject: t.Optional(native) }),
    }, async ({ request, params, query }) => {
      try {
        return Response.json(await readStatement(env, `https://rezics.com/id/${params.id}`,
          await reader(request, query.actingSubject)), { headers: noStore });
      } catch (error) { return readError(error); }
    })
    .post('/v1/statement-decisions', {
      body: t.Object({ profile: t.Literal('statement-decision-v1'), target, acceptance,
        expectedDecisionHead: t.Nullable(native),
        outcome: t.Union([t.Literal('accepted'), t.Literal('rejected'), t.Literal('withdrawn')]),
        actingSubject: native }, { additionalProperties: false }),
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (key instanceof Response) return key;
      try {
        const input = { target: body.target, acceptance: body.acceptance, expectedDecisionHead: body.expectedDecisionHead,
          outcome: body.outcome, actingSubject: body.actingSubject };
        const plan = statementDecisionRequest(input);
        const receipt = await runAdmittedCommand(env, work.account, work.access, request, {
          family: STATEMENT_FAMILIES.decide, oauthScope: 'classification:decide', scope: plan.scope, action: plan.action,
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
    }, async ({ body }) => {
      try {
        return Response.json(await resolveStatementAcceptance(env, body.target, body.acceptance), { headers: noStore });
      } catch (error) { return readError(error); }
    });
}
