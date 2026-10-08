import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { admittedPresentationChange } from '../modules/lexicon/admitted.ts';
import { readPresentationCurrent, readPresentationRevision } from '../modules/lexicon/change.ts';
import { renderRelation, type RelationRendering } from '../modules/lexicon/render.ts';
import { listDefinitions, DEFINITION_LIST_LIMIT } from '../modules/lexicon/catalog.ts';
import { editorRecording } from '../modules/lexicon/editor-recording.ts';
import { LEXICON_LIMITS, PRESENTATION_PROFILE, type PresentationState } from '../modules/lexicon/schema.ts';
import { definitionViewingRole, namedMeaning, PUBLIC_DEFINITION_KINDS } from '../modules/lexicon/property-name.ts';
import { readerLanguages } from '../modules/display-language/select.ts';
import { readDefinitionByKey, readExactDefinition } from '../modules/relation/change.ts';
import { readCurrentComponent } from '../modules/semantic/change.ts';
import { SEMANTIC_READ_SCOPE } from '../modules/semantic/admitted.ts';
import { referenceDisclosure } from '../modules/target/disclosed-references.ts';
import { SemanticChangeRejected, SemanticTargetUnavailable } from '../modules/semantic/command.ts';
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
export const relationStar = t.Object({ leaf: t.String(), hub: t.String() });
const creditedName = t.Object({ lexical: t.String(), language: t.String() });
const binding = t.Object({
  role: t.String(),
  participant: t.Unknown(),
  position: t.Optional(t.Integer()),
  creditedName: t.Optional(creditedName),
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
        members: t.Optional(t.Array(native)),
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
          creditedName: t.Optional(creditedName),
        }),
      ),
    }),
  ),
});

export const openApiOperations = {
  '/v1/lexicon/definitions': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/lexicon/definitions/{key}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/lexicon/presentations': {
    get: { exposure: 'public', rateLimitFamily: 'read', bearer: false },
    post: { exposure: 'platform:platform-admin', rateLimitFamily: 'write', bearer: true, idempotencyKey: true },
  },
  '/v1/lexicon/presentations/{id}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/lexicon/presentations/{id}/revisions/{revision}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
} as const;

export function lexiconRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const authenticate = async (request: Request, actingSubject?: string) => {
    await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
    if (!request.headers.has('authorization')) return null;
    if (!actingSubject) throw new SemanticChangeRejected('invalid', 'actingSubject is required for authenticated reads');
    return work.account.verify(request, [SEMANTIC_READ_SCOPE]);
  };
  const readable = (principal: VerifiedPrincipal | null, actor: string | undefined,
    definition: string, revision?: string) => work.access.canReadSemanticResource?.(
      principal, principal ? actor! : null, definition, revision, fuseki) ?? Promise.resolve(false);
  // Role members and participants are typed coordinates (Concepts), disclosed by the target reader first.
  const disclosure = (principal: VerifiedPrincipal | null, actor: string | undefined,
    canRead: (ref: string) => Promise<boolean>) => referenceDisclosure(work.environment,
    { access: work.access, principal, ...(principal && actor ? { actingSubject: actor } : {}) }, canRead);
  // Drafts retain explicit authority; a public vocabulary decision alone cannot disclose them.
  const draftReadable = async (principal: VerifiedPrincipal | null, actor: string | undefined,
    definition: string) => {
    if (!principal || !actor || !work.mediaAccess) return false;
    const disclosure = await work.mediaAccess.canReadSemantics(principal, actor, [definition], fuseki);
    if (!('granted' in disclosure)) return false;
    if (disclosure.granted.has(definition)) return true;
    // Public vocabulary is left out of granted. A draft still needs the explicit read grant.
    if (!disclosure.public.has(definition)) return false;
    return (await work.mediaAccess.explicitSemanticRead?.(principal, actor, definition)) ?? false;
  };
  const readableState = (principal: VerifiedPrincipal | null, actor: string | undefined, state: PresentationState) =>
    state.reviewStatus === 'reviewed'
      ? readable(principal, actor, state.definition, state.meaningRevision)
      : draftReadable(principal, actor, state.definition);
  // Check committed graph anchors before resolving any private or corrupt object bytes.
  const allowedPresentation = async (
    principal: VerifiedPrincipal | null,
    actingSubject: string | undefined,
    component: string,
    revision?: string,
  ) => {
    const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?definition ?meaning ?review WHERE {
      ${revision ? `BIND(${iri(revision)} AS ?head)` :
        `GRAPH ${iri(GRAPHS.current)} { ${iri(component)} a rv:DefinitionPresentation ; rv:presentationHead ?head }`}
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:PresentationRevision, rv:RevisionAnchor ;
        rv:component ${iri(component)} ; rv:presentationDefinition ?definition ;
        rv:meaningRevision ?meaning ; rv:reviewStatus ?review ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ?head a rv:ErasedRevision } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(component)} rv:protectionHead ?protection } }
    } LIMIT 2`);
    const rows = result.results?.bindings ?? [];
    if (rows.length !== 1) return false;
    const row = rows[0]!;
    return row.review!.value === `${RV}Reviewed`
      ? readable(principal, actingSubject, row.definition!.value, row.meaning!.value)
      : draftReadable(principal, actingSubject, row.definition!.value);
  };
  return new Elysia()
    .get('/v1/lexicon/definitions', {
      query: t.Object({
        recordable: t.Optional(t.Union([t.Literal('true'), t.Literal('false')])),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: DEFINITION_LIST_LIMIT })),
        cursor: t.Optional(t.String({ maxLength: 2048 })),
        languages: t.Optional(t.String({ maxLength: 8192 })),
      }, { additionalProperties: false }),
      response: { 200: t.Object({ profile: t.Literal('relation-definition-list-v1'),
        items: t.Array(t.Object({ key: t.String(), definition: native, revision: native,
          lifecycle: t.Literal('active'), editorRecordable: t.Boolean(),
          writePath: t.Nullable(t.Union([t.Literal('derivation'), t.Literal('relation')])),
          workSubjectRole: t.Nullable(t.String()),
          roles: relationRenderingSchema.properties.meaning.properties.roles,
          rendering: relationRenderingSchema })),
        next: t.Nullable(t.String({ description: 'Continue even after a short or empty page; null ends the live catalog.' })),
      }), ...authorizedReadProblems },
    }, async ({ request, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        // Discovery always lists the public catalog, including for authenticated editors.
        const publicRead = (definition: string, revision?: string) => readable(null, undefined, definition, revision);
        const languages = readerLanguages(query.languages, request.headers.get('accept-language'));
        const disclose = disclosure(null, undefined, publicRead);
        const page = await listDefinitions(work.environment, {
          limit: query.limit ?? DEFINITION_LIST_LIMIT,
          ...(query.recordable === undefined ? {} : { recordable: query.recordable === 'true' }),
          cursor: query.cursor, languages,
        }, publicRead, disclose);
        const items = [];
        for (const meaning of page.items) {
          const rendering = await renderRelation(work.environment, { meaning, bindings: [] },
            meaning.workSubjectRole ?? Object.values(meaning.roleKeys)[0]!, languages, publicRead, false, disclose);
          if (!await publicRead(meaning.definition, meaning.revision)) continue;
          items.push({ key: meaning.notation!, definition: meaning.definition, revision: meaning.revision,
            lifecycle: 'active' as const, ...editorRecording(meaning),
            workSubjectRole: meaning.workSubjectRole ?? null, roles: rendering.meaning.roles, rendering });
        }
        return Response.json({ profile: 'relation-definition-list-v1', items, next: page.next },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    })
    .get('/v1/lexicon/definitions/:key', {
      params: t.Object({ key: t.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }) }),
      query: t.Object({
        actingSubject: t.Optional(native),
        languages: t.Optional(t.String({ maxLength: 8192 })),
      }, { additionalProperties: false }),
      response: { 200: t.Object({ profile: t.Literal('relation-definition-key-v1'), key: t.String(),
        kind: t.Union([t.Literal('relation'), t.Literal('property')]),
        definition: native, revision: native, lifecycle: t.String(), roles: t.Array(t.Unknown()),
        workSubjectRole: t.Nullable(t.String()), star: t.Nullable(relationStar), editorRecordable: t.Boolean(),
        writePath: t.Nullable(t.Union([t.Literal('derivation'), t.Literal('relation')])),
        rendering: relationRenderingSchema }), ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await authenticate(request, query.actingSubject);
        const canRead = (ref: string) => readable(principal, query.actingSubject, ref);
        const disclose = disclosure(principal, query.actingSubject, canRead);
        const meaning = await readDefinitionByKey(work.environment, params.key, disclose,
          definition => canRead(definition), PUBLIC_DEFINITION_KINDS);
        if (!meaning || !await readable(principal, query.actingSubject, meaning.definition, meaning.revision)) {
          return problem(404, 'definition_unavailable', 'Definition is unavailable');
        }
        const named = namedMeaning(meaning);
        const viewingRole = definitionViewingRole(meaning);
        if (!viewingRole) throw new SemanticChangeRejected('invalid', 'viewing role is unknown');
        // One meaning's language inventory, the same bound as a relation rendering.
        const rendering = await renderRelation(work.environment, { meaning: named, bindings: [] }, viewingRole,
          readerLanguages(query.languages, request.headers.get('accept-language')), canRead,
          await draftReadable(principal, query.actingSubject, meaning.definition), disclose);
        return Response.json({ profile: 'relation-definition-key-v1', key: params.key,
          kind: meaning.kind ?? 'relation',
          definition: meaning.definition, revision: meaning.revision, lifecycle: meaning.lifecycle,
          roles: meaning.roles.map(role => ({ ...role, key: meaning.roleKeys[role.role] })),
          workSubjectRole: meaning.workSubjectRole ?? null, star: meaning.star ?? null,
          ...editorRecording(meaning), rendering }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    })
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
            actingSubject: t.Optional(native),
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
          const principal = await authenticate(request, query.actingSubject);
          const canRead = (ref: string) => readable(principal, query.actingSubject, ref);
          const disclose = disclosure(principal, query.actingSubject, canRead);
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
            if (!(await readable(principal, query.actingSubject, definition))) {
              items.push({ definition, status: 'unavailable', renderings: [] });
              continue;
            }
            const revision =
              revisions?.[index] ??
              (await readCurrentComponent(work.environment, definition, 'definition'))?.head;
            if (!revision || !await readable(principal, query.actingSubject, definition, revision)) {
              items.push({ definition, status: 'unavailable', renderings: [] });
              continue;
            }
            const meaning = await readExactDefinition(work.environment, revision, disclose, undefined, PUBLIC_DEFINITION_KINDS);
            if (!meaning || meaning.definition !== definition) {
              items.push({ definition, status: 'unavailable', renderings: [] });
              continue;
            }
            const named = namedMeaning(meaning);
            const roles = query.viewingRole ? [query.viewingRole] : Object.values(named.roleKeys);
            const renderings: RelationRendering[] = [];
            const includeDrafts = await draftReadable(principal, query.actingSubject, definition);
            for (const viewingRole of roles)
              renderings.push(
                await renderRelation(
                  work.environment,
                  { meaning: named, bindings: [] },
                  viewingRole,
                  languages,
                  canRead,
                  includeDrafts,
                  disclose,
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
        query: t.Object({ actingSubject: t.Optional(native) }, { additionalProperties: false }),
        response: { 200: read, ...authorizedReadProblems },
      },
      async ({ request, params, query }) => {
        try {
          const principal = await authenticate(request, query.actingSubject);
          const component = `https://rezics.com/id/${params.id}`;
          if (!(await allowedPresentation(principal, query.actingSubject, component))) {
            throw new SemanticTargetUnavailable('presentation is unavailable');
          }
          const result = await readPresentationCurrent(work.environment, component);
          if (!result || !await readableState(principal, query.actingSubject, result.state))
            throw new SemanticTargetUnavailable('presentation is unavailable');
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
        query: t.Object({ actingSubject: t.Optional(native) }, { additionalProperties: false }),
        response: { 200: read, ...authorizedReadProblems },
      },
      async ({ request, params, query }) => {
        try {
          const principal = await authenticate(request, query.actingSubject);
          const component = `https://rezics.com/id/${params.id}`,
            revision = `https://rezics.com/id/${params.revision}`;
          if (!(await allowedPresentation(principal, query.actingSubject, component, revision))) {
            throw new SemanticTargetUnavailable('presentation is unavailable');
          }
          const result = await readPresentationRevision(work.environment, component, revision);
          if (!result || !await readableState(principal, query.actingSubject, result.state))
            throw new SemanticTargetUnavailable('presentation is unavailable');
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
