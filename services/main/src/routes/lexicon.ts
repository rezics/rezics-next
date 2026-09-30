import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { admittedPresentationChange } from '../modules/lexicon/admitted.ts';
import { readPresentationCurrent, readPresentationRevision } from '../modules/lexicon/change.ts';
import { renderRelation, type RelationRendering } from '../modules/lexicon/render.ts';
import { LEXICON_LIMITS, PRESENTATION_PROFILE } from '../modules/lexicon/schema.ts';
import { readerLanguages } from '../modules/display-language/select.ts';
import { readExactDefinition } from '../modules/relation/change.ts';
import { readCurrentComponent } from '../modules/semantic/change.ts';
import {
  canReadSemantic,
  referenceReader,
  SEMANTIC_READ_SCOPE,
} from '../modules/semantic/admitted.ts';
import { SemanticTargetUnavailable } from '../modules/semantic/command.ts';
import { checkedNativeIri } from '../modules/semantic/schema.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { GRAPHS, RV, iri } from '../modules/work/activate.ts';
import type { VerifiedPrincipal } from '../modules/access/admission.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { semanticError } from './semantic.ts';
import { groupUuid } from './shared.ts';

const native = t.String({
  pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const position = t.Object({
  datasetId: t.Literal('product'),
  dataEpoch: t.String(),
  sequence: t.String(),
});
const grammar = t.Object(
  {
    case: t.Optional(t.String()),
    number: t.Optional(t.String()),
    gender: t.Optional(t.String()),
    value: t.String(),
  },
  { additionalProperties: false },
);
const labels = {
  noun: t.String(),
  heading: t.String(),
  plurals: t.Object(
    {
      zero: t.Optional(t.String()),
      one: t.Optional(t.String()),
      two: t.Optional(t.String()),
      few: t.Optional(t.String()),
      many: t.Optional(t.String()),
      other: t.String(),
    },
    { additionalProperties: false },
  ),
  grammaticalForms: t.Array(grammar),
};
const state = t.Object(
  {
    definition: native,
    meaningRevision: native,
    fromRole: t.String(),
    toRole: t.String(),
    language: t.String(),
    ...labels,
    grammaticalForms: t.Optional(t.Array(grammar)),
    source: t.String(),
    licence: t.String(),
    reviewStatus: t.Union([t.Literal('draft'), t.Literal('reviewed')]),
  },
  { additionalProperties: false },
);
const write = t.Object({
  profile: t.Literal(PRESENTATION_PROFILE),
  component: native,
  revision: native,
  predecessor: t.Nullable(native),
  receipt: t.String(),
  sourcePosition: position,
  replayed: t.Boolean(),
});
const read = t.Object({
  profile: t.Literal(PRESENTATION_PROFILE),
  component: native,
  revision: native,
  predecessor: t.Nullable(native),
  state,
  modelGeneration: t.String(),
  sourcePosition: position,
});
const binding = t.Object({
  role: t.String(),
  participant: t.Unknown(),
  position: t.Optional(t.Integer()),
});
export const relationRenderingSchema = t.Object({
  profile: t.Literal('relation-rendering-v1'),
  meaning: t.Object({
    definition: native,
    revision: native,
    lifecycle: t.String(),
    roles: t.Array(
      t.Object({
        role: t.String(),
        key: t.String(),
        minParticipants: t.Integer(),
        maxParticipants: t.Integer(),
        ordered: t.Boolean(),
      }),
    ),
  }),
  occurrence: t.Nullable(t.Object({ component: native, revision: native })),
  viewingRole: t.String(),
  bindings: t.Array(binding),
  projections: t.Array(
    t.Object({
      fromRole: t.String(),
      toRole: t.String(),
      presentation: t.Nullable(t.Object({ component: native, revision: native })),
      labels: t.Nullable(t.Object(labels)),
      language: t.Nullable(t.String()),
      script: t.Nullable(t.String()),
      direction: t.Nullable(t.Union([t.Literal('ltr'), t.Literal('rtl')])),
      reviewStatus: t.Nullable(t.Union([t.Literal('draft'), t.Literal('reviewed')])),
      source: t.Nullable(t.String()),
      licence: t.Nullable(t.String()),
      fallback: t.Nullable(
        t.Object({
          reason: t.Union([
            t.Literal('language-fallback'),
            t.Literal('script-fallback'),
            t.Literal('missing-direction'),
          ]),
          requestedLanguages: t.Array(t.String()),
          usedLanguage: t.Nullable(t.String()),
          requestedScript: t.Nullable(t.String()),
          usedScript: t.Nullable(t.String()),
          crossedScript: t.Boolean(),
          conversion: t.Null(),
        }),
      ),
      arguments: t.Array(
        t.Object({
          role: t.String(),
          type: t.String(),
          value: t.Unknown(),
          position: t.Optional(t.Integer()),
        }),
      ),
    }),
  ),
});

export const openApiOperations = {
  '/v1/lexicon/presentations': {
    get: { bearer: true },
    post: { bearer: true, idempotencyKey: true },
  },
  '/v1/lexicon/presentations/{id}': { get: { bearer: true } },
  '/v1/lexicon/presentations/{id}/revisions/{revision}': { get: { bearer: true } },
} as const;

export function lexiconRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const authenticate = async (request: Request) => {
    await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
    return work.account.verify(request, [SEMANTIC_READ_SCOPE]);
  };
  // Check authority using the graph anchor before resolving any private or corrupt object bytes.
  const allowedPresentation = async (
    principal: VerifiedPrincipal,
    actingSubject: string,
    component: string,
    revision?: string,
  ) => {
    const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?definition WHERE {
      ${
        revision
          ? `GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:PresentationRevision ;
        rv:component ${iri(component)} ; rv:presentationDefinition ?definition }`
          : `GRAPH ${iri(GRAPHS.current)} { ${iri(component)} a rv:DefinitionPresentation ; rv:presentationDefinition ?definition }`
      }
    } LIMIT 2`);
    const rows = result.results?.bindings ?? [];
    return (
      rows.length === 1 &&
      (await canReadSemantic(work.access, principal, actingSubject, rows[0]!.definition!.value))
    );
  };
  return new Elysia()
    .post(
      '/v1/lexicon/presentations',
      {
        body: t.Object(
          {
            profile: t.Literal(PRESENTATION_PROFILE),
            target: t.Optional(native),
            expectedHead: t.Nullable(native),
            state,
            actingSubject: native,
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
        const idempotencyKey = request.headers.get('idempotency-key');
        if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
          return problem(
            400,
            'invalid_idempotency_key',
            'A valid Idempotency-Key header is required',
          );
        }
        try {
          const result = await admittedPresentationChange(
            work.environment,
            work.account,
            work.access,
            request,
            { ...body, idempotencyKey },
          );
          return Response.json(
            {
              profile: PRESENTATION_PROFILE,
              component: result.component,
              revision: result.revision,
              predecessor: result.predecessor,
              receipt: result.receipt,
              sourcePosition: {
                datasetId: 'product',
                dataEpoch: result.dataEpoch,
                sequence: result.sequence,
              },
              replayed: result.replayed,
            },
            { status: body.target ? 200 : 201, headers: { 'cache-control': 'no-store' } },
          );
        } catch (error) {
          return semanticError(error);
        }
      },
    )
    .get(
      '/v1/lexicon/presentations',
      {
        query: t.Object(
          {
            actingSubject: native,
            definitions: t.String({ maxLength: 8192 }),
            revisions: t.Optional(t.String({ maxLength: 8192 })),
            viewingRole: t.Optional(t.String({ maxLength: 32 })),
            languages: t.Optional(t.String({ maxLength: 8192 })),
          },
          { additionalProperties: false },
        ),
        response: {
          200: t.Object({
            profile: t.Literal('relation-rendering-batch-v1'),
            items: t.Array(
              t.Object({
                definition: native,
                status: t.Union([t.Literal('available'), t.Literal('unavailable')]),
                renderings: t.Array(relationRenderingSchema),
              }),
            ),
          }),
          ...authorizedReadProblems,
        },
      },
      async ({ request, query }) => {
        const definitions = query.definitions.split(','),
          revisions = query.revisions?.split(',');
        try {
          definitions.forEach(checkedNativeIri);
          revisions?.forEach(checkedNativeIri);
        } catch {
          return problem(
            400,
            'invalid_definition_batch',
            'Definitions and revisions must be native references',
          );
        }
        if (
          !definitions.length ||
          definitions.length > LEXICON_LIMITS.definitionsPerBatch ||
          (revisions && revisions.length !== definitions.length)
        ) {
          return problem(
            400,
            'invalid_definition_batch',
            'A batch accepts 1–64 definitions and matching revisions',
          );
        }
        try {
          const principal = await authenticate(request);
          const canRead = referenceReader(work.access, principal, query.actingSubject);
          const languages = readerLanguages(
            query.languages,
            request.headers.get('accept-language'),
          );
          const items: {
            definition: string;
            status: 'available' | 'unavailable';
            renderings: RelationRendering[];
          }[] = [];
          for (const [index, definition] of definitions.entries()) {
            if (!(await canReadSemantic(work.access, principal, query.actingSubject, definition))) {
              items.push({ definition, status: 'unavailable', renderings: [] });
              continue;
            }
            const revision =
              revisions?.[index] ??
              (await readCurrentComponent(work.environment, definition, 'definition'))?.head;
            const meaning = revision ? await readExactDefinition(work.environment, revision) : null;
            if (!meaning || meaning.definition !== definition) {
              items.push({ definition, status: 'unavailable', renderings: [] });
              continue;
            }
            const roles = query.viewingRole ? [query.viewingRole] : Object.values(meaning.roleKeys);
            const renderings: RelationRendering[] = [];
            for (const viewingRole of roles)
              renderings.push(
                await renderRelation(
                  work.environment,
                  { meaning, bindings: [] },
                  viewingRole,
                  languages,
                  canRead,
                ),
              );
            items.push({ definition, status: 'available', renderings });
          }
          return Response.json(
            { profile: 'relation-rendering-batch-v1', items },
            { headers: { 'cache-control': 'no-store' } },
          );
        } catch (error) {
          return semanticError(error);
        }
      },
    )
    .get(
      '/v1/lexicon/presentations/:id',
      {
        params: t.Object({ id: groupUuid }),
        query: t.Object({ actingSubject: native }, { additionalProperties: false }),
        response: { 200: read, ...authorizedReadProblems },
      },
      async ({ request, params, query }) => {
        try {
          const principal = await authenticate(request);
          const component = `https://rezics.com/id/${params.id}`;
          if (!(await allowedPresentation(principal, query.actingSubject, component))) {
            throw new SemanticTargetUnavailable('presentation is unavailable');
          }
          const result = await readPresentationCurrent(work.environment, component);
          if (!result) throw new SemanticTargetUnavailable('presentation is unavailable');
          return Response.json(
            { profile: PRESENTATION_PROFILE, ...result },
            { headers: { 'cache-control': 'no-store' } },
          );
        } catch (error) {
          return semanticError(error);
        }
      },
    )
    .get(
      '/v1/lexicon/presentations/:id/revisions/:revision',
      {
        params: t.Object({ id: groupUuid, revision: groupUuid }),
        query: t.Object({ actingSubject: native }, { additionalProperties: false }),
        response: { 200: read, ...authorizedReadProblems },
      },
      async ({ request, params, query }) => {
        try {
          const principal = await authenticate(request);
          const component = `https://rezics.com/id/${params.id}`,
            revision = `https://rezics.com/id/${params.revision}`;
          if (!(await allowedPresentation(principal, query.actingSubject, component, revision))) {
            throw new SemanticTargetUnavailable('presentation is unavailable');
          }
          const result = await readPresentationRevision(work.environment, component, revision);
          if (!result) throw new SemanticTargetUnavailable('presentation is unavailable');
          return Response.json(
            { profile: PRESENTATION_PROFILE, ...result },
            { headers: { 'cache-control': 'no-store' } },
          );
        } catch (error) {
          return semanticError(error);
        }
      },
    );
}
