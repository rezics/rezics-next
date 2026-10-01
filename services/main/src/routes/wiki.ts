import { Elysia, t, ValidationError } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { FusekiReadBudgetExceeded, FusekiQueryResponseTooLarge } from '../infrastructure/fuseki.ts';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError } from './work-reads.ts';
import { WikiCandidatesSchema, WikiExtractionSchema, WikiNativeResourceSchema,
  WikiEntitySchema, WikiClaimSchema, WikiUnitSchema } from '../modules/wiki/protocol.ts';
import { wikiCandidates } from '../modules/wiki/candidates.ts';
import { checkWikiExtraction, validateWikiExtraction } from '../modules/wiki/validate.ts';
import { wikiRead } from '../modules/wiki/read.ts';
import { WikiRejected } from '../modules/wiki/errors.ts';

export const openApiOperations = {
  '/v1/wiki/candidates': { post: { bearer: true } },
  '/v1/wiki/validations': { post: { bearer: true } },
} as const;
export const capabilities = {
  '/v1/wiki/candidates': { post: { disposition: 'supported', mcp: { tool: 'wiki_candidates',
    scopes: ['wiki:propose'],
    title: 'Match extracted wiki names', description: 'Find exact name and alias candidates in a Work’s wiki collections.' } } },
  '/v1/wiki/validations': { post: { disposition: 'supported', mcp: { tool: 'wiki_validate',
    scopes: ['wiki:propose'],
    title: 'Validate a wiki extraction', description: 'Preview entities, facts, alignment and quotation use before submitting an extraction.' } } },
} as const;
const closed = { additionalProperties: false };
const candidatesRequest = t.Object({ ...WikiCandidatesSchema.properties, actingSubject: WikiNativeResourceSchema,
  target: WikiNativeResourceSchema, zone: WikiNativeResourceSchema }, closed);
const validationRequest = t.Object({ actingSubject: WikiNativeResourceSchema, bundle: WikiExtractionSchema }, closed);
const problems = { ...authorizedReadProblems, 409: problemResult(409), 422: problemResult(422) };
const candidateResult = t.Object({ profile: t.Literal('wiki-candidates-v1'),
  items: t.Array(t.Object({ index: t.Integer({ minimum: 0, maximum: 63 }),
    status: t.Union([t.Literal('matched'), t.Literal('new'), t.Literal('ambiguous'), t.Literal('unavailable')]),
    candidates: t.Array(WikiNativeResourceSchema, { maxItems: 16 }) }, closed), { maxItems: 64 }) }, closed);
const quoteUse = t.Object({ representationSha256: t.String({ maxLength: 64 }),
  locatorDigest: t.String({ maxLength: 64 }), quoteDigest: t.String({ maxLength: 64 }), codePoints: t.Integer() }, closed);
const preview = t.Object({ profile: t.Literal('wiki-validation-v1'), status: t.Literal('acceptable'),
  target: t.Object({ resource: WikiNativeResourceSchema, base: t.Literal('work'), work: WikiNativeResourceSchema,
    revision: WikiNativeResourceSchema, types: t.Array(t.String({ maxLength: 2048 }), { maxItems: 64 }),
    disclosure: t.Union([t.Literal('public'), t.Literal('restricted')]) }, closed),
  sourcePosition: t.Object({ dataEpoch: t.String(), sequence: t.String() }, closed),
  entities: t.Array(t.Object({ ...WikiEntitySchema.properties, action: t.Union([t.Literal('create'), t.Literal('reuse')]),
    revision: t.Union([WikiNativeResourceSchema, t.Null()]) }, closed), { maxItems: 128 }),
  claims: t.Array(WikiClaimSchema, { maxItems: 256 }), relations: t.Array(WikiClaimSchema, { maxItems: 256 }),
  alignment: t.Array(t.Object({ ...WikiUnitSchema.properties,
    status: t.Union([t.Literal('aligned'), t.Literal('unaligned')]) }, closed), { maxItems: 256 }),
  quotations: t.Object({ policy: t.Object({ version: t.Literal(1), passageCodePoints: t.Literal(200),
    workCodePoints: t.Literal(10000) }, closed), appliedCodePoints: t.Integer(), addedCodePoints: t.Integer(),
    projectedCodePoints: t.Integer(), uses: t.Array(quoteUse, { maxItems: 28672 }) }, closed) }, closed);
export function wikiError(error: unknown): Response {
  if (error instanceof WikiRejected) return problem(error.status, error.code, 'Wiki extraction intake did not accept this request');
  if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge) {
    return problem(422, 'wiki_query_budget', 'Wiki intake exceeds its complete-result budget');
  }
  return workReadError(error);
}
/** Main's first error hook preserves wiki policy outcomes when framework body
 * validation runs before the domain handler. No other route's errors change. */
export function wikiSchemaError(error: unknown, request: Request): Response | undefined {
  if (!(error instanceof ValidationError) || new URL(request.url).pathname !== '/v1/wiki/validations'
    || error.type !== 'body') return;
  if (error.value && typeof error.value === 'object' && 'bundle' in error.value) {
    try { checkWikiExtraction(error.value.bundle); }
    catch (failure) { return wikiError(failure); }
  }
  return problem(400, 'invalid_wiki_extraction', 'Request does not match the wiki extraction contract');
}
export function wikiRoutes(_fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .error(({ error, request }) => {
      const policyProblem = wikiSchemaError(error, request);
      if (policyProblem) return policyProblem;
      if (!(error instanceof ValidationError)) return;
      return problem(400, 'invalid_request', 'Request does not match the wiki intake contract');
    })
    .post('/v1/wiki/candidates', { body: candidatesRequest, response: { 200: candidateResult, ...problems } },
      async ({ request, body }) => {
        try {
          const principal = await work.account.verify(request, ['wiki:propose']);
          const { actingSubject, ...input } = body;
          return Response.json(await wikiRead(work, principal, actingSubject, read => wikiCandidates(read, input)),
            { headers: { 'cache-control': 'no-store' } });
        } catch (error) { return wikiError(error); }
      })
    .post('/v1/wiki/validations', { body: validationRequest, response: { 200: preview, ...problems } },
      async ({ request, body }) => {
        try {
          const principal = await work.account.verify(request, ['wiki:propose']);
          if (!work.wikiQuotations) throw new WikiRejected('wiki_quotation_unavailable', 503);
          return Response.json(await wikiRead(work, principal, body.actingSubject,
            read => validateWikiExtraction(read, work.wikiQuotations!, body.bundle)),
          { headers: { 'cache-control': 'no-store' } });
        } catch (error) { return wikiError(error); }
      });
}
