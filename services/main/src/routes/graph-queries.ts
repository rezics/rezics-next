import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import {
  canReadSemantic,
  referenceReader,
  SEMANTIC_READ_SCOPE,
} from '../modules/semantic/admitted.ts';
import {
  GraphQueryBudgetExceeded,
  GraphQueryNotFound,
  GraphQueryUnavailable,
  GraphQueryContinuationStale,
  queryRelationGraph,
} from '../modules/graph-query/query.ts';
import { queryStatementGraph } from '../modules/graph-query/statements.ts';
import { checkedRelationGraphQuery, checkedStatementGraphQuery, InvalidGraphQuery } from '../modules/graph-query/schema.ts';
import { requireSelectedPlatformCapability } from '../modules/access/exposure.ts';
import type { PrivateContextSelections } from '../modules/context/private-selection.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { boundedReadingPositionRead } from '../modules/reading-position/read.ts';
import { revealedGraphRecords } from '../modules/graph/reading.ts';
import { readingPositionQuery } from '../modules/reading-position/contract.ts';
import { workReadError } from './work-reads.ts';
import {
  WorkReadInvalid,
  WorkReadMissing,
  WorkReadMoved,
  WorkReadUnavailable,
} from '../modules/work/read-session.ts';
import type { AccessAdmissionRegistry } from '../modules/access/admission.ts';

const native = t.String({
  pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const anchor = t.Union([
  t.Object({ kind: t.Literal('resource'), id: native }, { additionalProperties: false }),
  t.Object(
    {
      kind: t.Literal('phrase'),
      phrase: t.String({ minLength: 2, maxLength: 80 }),
      language: t.Union([t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null()]),
    },
    { additionalProperties: false },
  ),
]);
const roleBinding = t.Object(
  { role: t.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,31}$' }), participant: native },
  { additionalProperties: false },
);
const graphPosition = t.Object(
  {
    datasetId: t.Literal('product'),
    dataEpoch: t.String(),
    sequence: t.String({ pattern: '^(0|[1-9][0-9]*)$' }),
  },
  { additionalProperties: false },
);
const continuation = t.Object(
  {
    queryDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
    sourcePosition: graphPosition,
    after: t.Object(
      { occurrence: native, revision: native, from: native, to: native },
      { additionalProperties: false },
    ),
    expiresAt: t.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const statementContinuation = t.Object(
  {
    queryDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
    sourcePosition: graphPosition,
    after: native,
    expiresAt: t.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const relationRequest = t.Object(
  {
    profile: t.Literal('relation-graph-v1'),
    actingSubject: native,
    anchor,
    definition: native,
    fromRole: t.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,31}$' }),
    toRole: t.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,31}$' }),
    direction: t.Union([t.Literal('outgoing'), t.Literal('incoming')]),
    roleBindings: t.Array(roleBinding, { maxItems: 8 }),
    continuation: t.Optional(continuation),
  },
  { additionalProperties: false },
);
const statementRequest = t.Object(
  {
    profile: t.Literal('statement-graph-v1'),
    actingSubject: native,
    anchor: native,
    direction: t.Union([t.Literal('outgoing'), t.Literal('incoming')]),
    predicate: t.Optional(t.String({ pattern: '^https?://[^\\s<>"{}|\\\\^`]{1,2040}$' })),
    continuation: t.Optional(statementContinuation),
    position: readingPositionQuery,
  },
  { additionalProperties: false },
);
const request = t.Union([relationRequest, statementRequest]);
const edge = t.Object(
  {
    occurrence: native,
    revision: native,
    definition: native,
    from: native,
    fromRole: t.String(),
    to: native,
    toRole: t.String(),
    applicability: t.Array(t.String()),
    matchReason: t.Union([
      t.Object({ kind: t.Literal('anchor'), participant: native }, { additionalProperties: false }),
      t.Object(
        {
          kind: t.Literal('phrase'),
          phrase: t.String(),
          matchUnit: t.Union([t.String(), t.Null()]),
          score: t.Union([t.Number(), t.Null()]),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
const response = t.Object(
  {
    profile: t.Literal('relation-graph-v1'),
    complete: t.Boolean(),
    frontier: t.Union([t.Literal('complete'), t.Literal('more'), t.Literal('bounded')]),
    countPrecision: t.Union([t.Literal('exact'), t.Literal('lower-bound')]),
    total: t.Integer(),
    edges: t.Array(edge),
    continuation: t.Union([continuation, t.Null()]),
    sourcePosition: graphPosition,
  },
  { additionalProperties: false },
);
const meaningBasis = t.Union([
  t.Object({ state: t.Literal('none') }, { additionalProperties: false }),
  t.Object({ state: t.Literal('unavailable') }, { additionalProperties: false }),
  t.Object(
    {
      state: t.Literal('readable'),
      context: t.String(),
      semanticRevision: native,
      interpretationDefinitions: t.Array(t.String()),
    },
    { additionalProperties: false },
  ),
]);
const decision = t.Object(
  {
    targetKind: t.String(),
    acceptanceContext: t.String(),
    revision: native,
    outcome: t.String(),
    basis: t.String(),
    contextRevision: t.Union([native, t.Null()]),
  },
  { additionalProperties: false },
);
const claim = t.Object(
  {
    statement: native,
    revision: native,
    subject: t.String(),
    predicate: t.String(),
    value: t.Object(
      { kind: t.Literal('resource'), iri: t.String() },
      { additionalProperties: false },
    ),
    relationDefinition: t.String(),
    speaker: native,
    meaningKey: t.String(),
    applicability: t.Array(t.String()),
    meaningBasis,
    evidence: t.Array(t.String()),
    decisions: t.Array(decision),
  },
  { additionalProperties: false },
);
const statementResponse = t.Object(
  {
    profile: t.Literal('statement-graph-v1'),
    complete: t.Boolean(),
    frontier: t.Union([t.Literal('complete'), t.Literal('more'), t.Literal('bounded')]),
    total: t.Integer(),
    claims: t.Array(claim),
    continuation: t.Union([statementContinuation, t.Null()]),
    sourcePosition: t.Object({
      datasetId: t.Literal('product'),
      dataEpoch: t.String(),
      sequence: t.String(),
    }),
  },
  { additionalProperties: false },
);

export const openApiOperations = {
  '/v1/graph/queries': { post: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
} as const;

function graphQueryError(error: unknown): Response {
  if (error instanceof InvalidGraphQuery)
    return problem(400, 'invalid_graph_query', 'Graph query is invalid');
  if (error instanceof GraphQueryNotFound)
    return problem(404, 'graph_anchor_unavailable', 'Graph anchor is unavailable');
  if (error instanceof GraphQueryBudgetExceeded)
    return problem(422, 'graph_query_budget_exceeded', 'Graph query exceeds its admitted bound');
  if (error instanceof GraphQueryContinuationStale) {
    return problem(
      409,
      'graph_continuation_restart',
      'Graph query source changed; restart at the first page',
    );
  }
  if (error instanceof GraphQueryUnavailable)
    return problem(503, 'graph_query_unavailable', 'Graph query state is unavailable');
  if (
    error instanceof WorkReadInvalid ||
    error instanceof WorkReadMissing ||
    error instanceof WorkReadMoved ||
    error instanceof WorkReadUnavailable
  )
    return workReadError(error);
  return commandError(error);
}

interface GraphRouteDependencies {
  contextSelections?: Pick<PrivateContextSelections, 'canReadPrivate'>;
}
interface GraphQueryRouteDependencies extends MainWorkDependencies {
  access: MainWorkDependencies['access'] &
    Partial<Pick<AccessAdmissionRegistry, 'canReadReferences'>>;
}

/** Bounded one-hop relation query; ARQ binds all requested roles to one occurrence revision. */
export function graphQueryRoutes(work: GraphQueryRouteDependencies) {
  return new Elysia().post(
    '/v1/graph/queries',
    {
      body: request,
      response: {
        200: t.Union([response, statementResponse]),
        400: problemResult(400),
        401: problemResult(401),
        403: problemResult(403),
        404: problemResult(404),
        409: problemResult(409),
        422: problemResult(422),
        503: problemResult(503),
      },
    },
    async ({ request: webRequest, body }) => {
      try {
        const principal = await work.account.verify(webRequest, [SEMANTIC_READ_SCOPE]);
        const selected = body.profile === 'relation-graph-v1'
          ? checkedRelationGraphQuery(body) : checkedStatementGraphQuery(body);
        // Both admitted profiles traverse one hop. No generic SPARQL or multi-hop
        // profile is currently admitted by this owner's request schema.
        await requireSelectedPlatformCapability(work.platformAccess, principal,
          { exposure: selected.profile === 'relation-graph-v1' || selected.profile === 'statement-graph-v1'
            ? 'public' : 'platform:sparql', operationId: 'postV1GraphQueries' });
        if (!work.access.canReadSemanticResource) {
          return problem(503, 'graph_query_unavailable', 'Graph read authority is unavailable');
        }
        const canRead = referenceReader(work.access, principal, selected.actingSubject);
        if (selected.profile === 'relation-graph-v1') {
          const readReferences = work.access.canReadReferences?.bind(work.access);
          if (!readReferences) {
            return problem(503, 'graph_query_unavailable', 'Graph read authority is unavailable');
          }
          const result = await queryRelationGraph(
            work.environment,
            {
              canReadResource: canRead,
              canReadResources: (resources) =>
                readReferences(principal, selected.actingSubject, resources),
            },
            selected,
          );
          return Response.json(result, { headers: { 'cache-control': 'no-store' } });
        }
        if (
          !(await canReadSemantic(work.access, principal, selected.actingSubject, selected.anchor)) &&
          !(await work.access.canReadWork(principal, selected.actingSubject, selected.anchor))
        ) {
          return problem(404, 'graph_anchor_unavailable', 'Graph anchor is unavailable');
        }
        const selections = (work as MainWorkDependencies & GraphRouteDependencies)
          .contextSelections;
        let contextPrincipal:
          | Promise<Awaited<ReturnType<typeof work.account.verify>> | null>
          | undefined;
        const positionUrl = new URL(webRequest.url);
        // POST selection comes from the body; ignore a competing URL query value.
        positionUrl.searchParams.set('position', selected.position ?? 'mine');
        const positionRequest = new Request(positionUrl, {
          headers: webRequest.headers,
          signal: webRequest.signal,
        });
        const result = await boundedReadingPositionRead(
          work,
          positionRequest,
          principal,
          selected.actingSubject,
          async (boundary) =>
            queryStatementGraph(
              work.environment,
              {
                canReadResource: canRead,
                readingBinding: await boundary.binding(),
                visibleRecords: (records) => revealedGraphRecords(boundary, records),
                canReadPrivateContext: async (context) => {
                  if (!selections) return false;
                  contextPrincipal ??= work.account
                    .verify(webRequest, ['context:read'])
                    .catch(() => null);
                  const verified = await contextPrincipal;
                  return (
                    !!verified && selections.canReadPrivate(verified, selected.actingSubject, context)
                  );
                },
              },
              selected,
            ),
        );
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return graphQueryError(error);
      }
    },
  );
}
