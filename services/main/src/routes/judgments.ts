import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import { JudgmentConflict, JudgmentDenied, JudgmentStale, JudgmentUnavailable }
  from '../modules/judgment/access.ts';
import { ConceptHintConflict, ConceptHintDenied, ConceptHintStale, ConceptHintUnavailable }
  from '../modules/judgment/hint.ts';
import { judgmentDigest, type JudgmentContext } from '../modules/judgment/schema.ts';
import { summarizeJudgments } from '../modules/judgment/policy.ts';
import { readStatement, resolveStatementAcceptance, StatementNotFound }
  from '../modules/statement/read.ts';
import { CLASSIFIED_AS } from '../modules/statement/schema.ts';
import { ContextCommandUnavailable } from '../modules/context/command.ts';
import { ID } from '../modules/work/activate.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const context = t.Union([t.Object({ kind: t.Literal('global') }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('realm'), realm: native }, { additionalProperties: false })]);
const dimension = t.Union([t.Literal('fit'), t.Literal('spoiler')]);
const revision = t.String({ pattern: '^(0|[1-9][0-9]*)$' });
const writeResult = t.Object({ profile: t.Literal('statement-judgment-v1'), receipt: t.String(),
  statement: native, context, dimension, value: t.Nullable(t.Integer({ minimum: -1, maximum: 2 })),
  revision, replayed: t.Boolean() });
const hintResult = t.Object({ profile: t.Literal('concept-spoiler-hint-v1'), concept: native,
  context, hint: t.Union([t.Literal('not-spoiler'), t.Literal('minor'), t.Literal('major')]),
  generation: revision, receipt: t.String(), replayed: t.Boolean() });
const interval = t.Nullable(t.Object({ lower: t.Number(), upper: t.Number() }));
const readResult = t.Object({ profile: t.Literal('statement-judgment-summary-v1'),
  statement: native, context, statementRevision: native, generation: revision,
  conceptHintGeneration: revision, badgeSourceEvent: t.Nullable(t.String()),
  policy: t.Object({ generation: t.Literal('wilson-v1'), z: t.Literal(1.96),
    defaultConceptHint: t.Literal('unknown') }),
  conceptHint: t.Union([t.Literal('unknown'), t.Literal('not-spoiler'),
    t.Literal('minor'), t.Literal('major')]),
  fit: t.Object({ status: t.Union([t.Literal('unknown'), t.Literal('fits'),
    t.Literal('does-not-fit'), t.Literal('disputed')]),
    distribution: t.Object({ negative: t.Integer(), positive: t.Integer() }),
    sampleSize: t.Integer(), confidence: t.Union([t.Literal('high'), t.Literal('low')]),
    bounds: t.Object({ positive: interval, negative: interval }) }),
  spoiler: t.Object({ protection: t.Union([t.Literal('hide-major'), t.Literal('hide-any'),
    t.Literal('show-all')]), status: t.Union([t.Literal('unknown'), t.Literal('major'),
      t.Literal('minor'), t.Literal('not-spoiler'), t.Literal('disputed')]),
    distribution: t.Object({ notSpoiler: t.Integer(), minorSpoiler: t.Integer(),
      majorSpoiler: t.Integer() }), sampleSize: t.Integer(),
    confidence: t.Union([t.Literal('high'), t.Literal('low')]),
    bounds: t.Object({ major: interval, any: interval, none: interval }) }),
  viewer: t.Nullable(t.Object({ fit: t.Nullable(t.Integer()), fitRevision: revision,
    spoiler: t.Nullable(t.Integer()), spoilerRevision: revision })) });
const noStore = { 'cache-control': 'no-store' };

export const openApiOperations = {
  '/v1/statements/{id}/judgments': {
    post: { exposure: 'public', bearer: true, idempotencyKey: true }, get: { exposure: 'public', bearer: true },
  },
  '/v1/concepts/{id}/spoiler-hints': { post: { exposure: 'public', bearer: true, idempotencyKey: true } },
} as const;

function judgmentError(error: unknown): Response {
  if (error instanceof JudgmentStale) return problem(409, 'stale_judgment_dimension', 'Judgment dimension changed');
  if (error instanceof ConceptHintStale) return problem(409, 'stale_concept_hint', 'Concept hint changed');
  if (error instanceof JudgmentConflict) return problem(409, 'idempotency_conflict', 'Key binds another intent');
  if (error instanceof ConceptHintConflict) return problem(409, 'idempotency_conflict', 'Key binds another intent');
  if (error instanceof JudgmentDenied) return problem(403, 'judgment_denied', 'Judgment is not eligible');
  if (error instanceof ConceptHintDenied) return problem(403, 'concept_hint_denied', 'Curator authority is required');
  if (error instanceof StatementNotFound) return problem(404, 'statement_unavailable', 'Statement is unavailable');
  if (error instanceof JudgmentUnavailable || error instanceof ConceptHintUnavailable
    || error instanceof ContextCommandUnavailable) {
    return problem(503, 'judgment_owner_unavailable', 'Judgment owner is unavailable');
  }
  return commandError(error);
}

async function admittedStatement(work: MainWorkDependencies, statement: string,
  selected: JudgmentContext) {
  const read = await readStatement(work.environment, statement, async () => false);
  if (read.state !== 'active' || read.meaningBasis.state === 'unavailable') {
    throw new JudgmentDenied('Statement is not readable and active');
  }
  const acceptance = await resolveStatementAcceptance(work.environment,
    { kind: 'statement', statement }, selected);
  if (acceptance.result.state !== 'accepted') throw new JudgmentDenied('Statement is not admitted in this scope');
  return read;
}

/** Account assertion → exact Statement admission in Jena → Access judgment owner. */
export function judgmentRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/concepts/:id/spoiler-hints', {
      params: t.Object({ id: uuid }),
      body: t.Object({ profile: t.Literal('concept-spoiler-hint-v1'), context,
        hint: t.Union([t.Literal('not-spoiler'), t.Literal('minor'), t.Literal('major')]),
        expectedGeneration: revision, actingSubject: native }, { additionalProperties: false }),
      response: { 200: hintResult, 201: hintResult, ...writeProblems },
    }, async ({ request, params, body }) => {
      if (!work.judgments) return problem(503, 'judgment_owner_unavailable', 'Judgment owner is unavailable');
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      }
      const concept = ID + params.id;
      const input = { concept, context: body.context, hint: body.hint,
        expectedGeneration: body.expectedGeneration, actingSubject: body.actingSubject,
        idempotencyKey: key, requestDigest: judgmentDigest({ concept, ...body }) };
      try {
        const principal = await work.account.verify(request, ['statement:decide']);
        const result = await work.judgments.declareHint(principal, input);
        return Response.json({ profile: 'concept-spoiler-hint-v1', ...result },
          { status: result.replayed ? 200 : 201, headers: noStore });
      } catch (error) { return judgmentError(error); }
    })
    .post('/v1/statements/:id/judgments', {
      params: t.Object({ id: uuid }),
      body: t.Object({ profile: t.Literal('statement-judgment-v1'), context, dimension,
        value: t.Nullable(t.Integer({ minimum: -1, maximum: 2 })), expectedRevision: revision },
      { additionalProperties: false }),
      response: { 200: writeResult, 201: writeResult, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      if (!work.judgments) return problem(503, 'judgment_owner_unavailable', 'Judgment owner is unavailable');
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      }
      const statement = ID + params.id;
      const input = { statement, context: body.context, dimension: body.dimension,
        value: body.value, expectedRevision: body.expectedRevision, idempotencyKey: key,
        requestDigest: judgmentDigest({ statement, context: body.context,
          dimension: body.dimension, value: body.value, expectedRevision: body.expectedRevision }) };
      try {
        const principal = await work.account.verify(request, ['judgment:write']);
        const prior = await work.judgments.replay(principal, input);
        if (prior) return Response.json({ profile: 'statement-judgment-v1', ...prior },
          { status: 200, headers: noStore });
        await admittedStatement(work, statement, body.context);
        const result = await work.judgments.write(principal, input);
        return Response.json({ profile: 'statement-judgment-v1', ...result },
          { status: result.replayed ? 200 : 201, headers: noStore });
      } catch (error) { return judgmentError(error); }
    })
    .get('/v1/statements/:id/judgments', {
      params: t.Object({ id: uuid }),
      query: t.Object({ realm: t.Optional(native) }),
      response: { 200: readResult, ...authorizedReadProblems, 409: problemResult(409) },
    }, async ({ request, params, query }) => {
      if (!work.judgments) return problem(503, 'judgment_owner_unavailable', 'Judgment owner is unavailable');
      const statement = ID + params.id;
      const selected: JudgmentContext = query.realm ? { kind: 'realm', realm: query.realm }
        : { kind: 'global' };
      try {
        const principal = await work.account.verify(request, ['judgment:read']);
        const target = await admittedStatement(work, statement, selected);
        const concept = target.predicate === CLASSIFIED_AS && target.value.kind === 'resource'
          ? target.value.iri : null;
        const badge = await work.judgments.protectionCheck(statement, selected, concept);
        const { counts, viewer, generation, hintGeneration } = await work.judgments.read(
          principal, statement, selected, concept);
        if (generation !== badge.generation || hintGeneration !== badge.conceptHintGeneration) {
          throw new JudgmentUnavailable('judgment summary moved');
        }
        return Response.json({ profile: 'statement-judgment-summary-v1', statement,
          context: selected, statementRevision: target.revision, generation,
          conceptHintGeneration: badge.conceptHintGeneration, badgeSourceEvent: badge.sourceEvent,
          ...summarizeJudgments(counts, badge.conceptHint), viewer }, { headers: noStore });
      } catch (error) { return judgmentError(error); }
    });
}
