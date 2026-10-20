import { transportResponses } from '../transport-responses.ts';
import { Elysia, t } from 'elysia';
import { documentSnapshotSchema } from '../api-document.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { createAdmittedMetadataWork } from '../modules/work/create-admitted.ts';
import { candidateText, declaredGrain, grainOwner, CatalogueInvalid, CataloguePendingLimit, CatalogueUnavailable } from '../modules/catalogue-intake/schema.ts';
import { readTranslationLinks } from '../modules/work/translation-links.ts';
import { readWorkDerivations } from '../modules/work/derivations.ts';
import { createAdmittedFixedRelease, readFixedRelease, type FixedRelease } from '../modules/work/fixed-release.ts';
import { readExactMainRevision, readExactWorkRevision, RevisionCorrupt }
  from '../modules/work/history.ts';
import { sameScalar, scalarExport, scalarFromBinding, SCALAR_PREDICATE }
  from '../modules/work/scalar-value.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { iri, InvalidWorkSemanticTypes, InvalidWorkTitleLanguage, MAX_WORK_SEMANTIC_TYPES } from '../modules/work/activate.ts';
import { registryWorkType } from '../modules/types/contract.ts';
import { exactMainRevision, exactWorkRevision, pendingOperation, problemResult, workResult,
  workScalarRead } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';
import { workRead } from '../modules/work/read-session.ts';
import { readWorkHeader } from '../modules/work/read-header.ts';
import { readPost } from '../modules/post/read.ts';
import { wikiDisplayObligations } from '../modules/work/read-contract.ts';
import { operationPolicies } from './operation-policies.ts';
import { workScalarModels, workScalarOperation } from './work-scalar.contract.ts';
import { workScalarHandler } from './work-scalar.handler.ts';

const translationLinkRef = t.Object({ link: t.String(), targetWork: t.String(),
  targetMainVersion: t.String(), targetMainRevision: t.String(),
  sourceWork: t.String(), sourceMainVersion: t.String(), sourceMainRevision: t.Nullable(t.String()),
  sourceVersionStatus: t.Union([t.Literal('exact'), t.Literal('unresolved')]),
  status: t.Union([t.Literal('official'), t.Literal('third-party')]),
  contentLanguage: t.String(), translator: t.String(), publisher: t.String(),
  evidence: t.String(), authorizingParty: t.Nullable(t.String()),
  authorizationScope: t.Nullable(t.String()), authorizationEpoch: t.Nullable(t.String()) });

const workDerivationRef = t.Object({ derivation: t.String(), targetWork: t.String(),
  targetMainVersion: t.String(), targetMainRevision: t.String(),
  sourceWork: t.String(), sourceMainVersion: t.Nullable(t.String()),
  sourceMainRevision: t.Nullable(t.String()),
  sourceVersionStatus: t.Union([t.Literal('exact'), t.Literal('unresolved')]),
  kind: t.Union([t.Literal('adaptation'), t.Literal('new-recording'),
    t.Literal('software-fork')]), evidence: t.String(), linkedBy: t.String(),
  corrects: t.Nullable(t.String()), supersededBy: t.Nullable(t.String()),
  status: t.Union([t.Literal('effective'), t.Literal('superseded')]) });

const fixedReleaseRead = t.Object({ profile: t.Literal('fixed-native-text-release-v1'),
  release: t.String(), work: t.String(), mainVersion: t.String(), mainRevision: t.String(),
  selection: t.String(), contribution: t.String(), publicationDecision: t.String(),
  selectedDraft: t.String(), language: t.String(), bodyDigest: t.String(), body: t.String(),
  document: t.Optional(documentSnapshotSchema),
  externalReleases: t.Array(t.Object({ run: t.String(), release: t.String(),
    sourceClaim: t.String(), expectedPosition: t.Object({ dataEpoch: t.String(), sequence: t.String() }),
    observation: t.String(), captureDigest: t.String() })),
  sealedBy: t.String(), sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }) });

const fixedReleaseWrite = t.Object({ ...fixedReleaseRead.properties,
  receipt: t.String(), replayed: t.Boolean() });

function publicFixedRelease(exact: FixedRelease) {
  return { ...exact, externalReleases: exact.externalReleases.map(({ sourcePrincipalId: _owner, ...link }) => link) };
}

export function workRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const createBody = t.Object({
    profile: t.Literal('metadata-only-v1'),
    grain: t.Optional(declaredGrain),
    candidateReceipt: t.Optional(t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' })),
    aliases: t.Optional(t.Array(candidateText, { maxItems: 8 })),
    romanizations: t.Optional(t.Array(candidateText, { maxItems: 8 })),
    parentComposition: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
    authorityPath: t.Optional(t.Union([
      t.Literal('represented-agent'), t.Literal('direct-principal')])),
    title: t.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
    language: t.Optional(t.String({ minLength: 2, maxLength: 35,
      pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$' })),
    localizedTitle: t.Optional(t.Object({ value: t.String({ minLength: 1, maxLength: 500 }),
      language: t.String({ minLength: 2, maxLength: 35 }) }, { additionalProperties: false })),
    description: t.Optional(t.Object({ value: t.String({ minLength: 1, maxLength: 4000 }),
      language: t.String({ minLength: 2, maxLength: 35 }) }, { additionalProperties: false })),
    authoring: t.Optional(t.Literal('own-work')),
    semanticTypes: t.Optional(t.Array(registryWorkType,
      { maxItems: MAX_WORK_SEMANTIC_TYPES, uniqueItems: true })),
    actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
  }, { additionalProperties: false });
  return new Elysia()
    .use(operationPolicies(work))
    .model(workScalarModels)
    .post('/v1/works', {
      body: t.Union([
        t.Object({ ...createBody.properties, authoring: t.Literal('own-work') }, { additionalProperties: false }),
        t.Object({ ...createBody.properties, authoring: t.Optional(t.Literal('catalogue')),
          grain: declaredGrain, candidateReceipt: t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }) },
        { additionalProperties: false }),
      ]),
      response: transportResponses(openApiOperations["/v1/works"].post, { 200: t.Union([workResult, t.Object({ outcome: t.Literal('use-owner-api'),
        grain: declaredGrain, ownerApi: t.Object({ method: t.String(), path: t.String() }) })]),
        201: workResult, 202: pendingOperation,
        400: problemResult(400), 401: problemResult(401),
        403: problemResult(403), 409: problemResult(409),
        429: problemResult(429), 500: problemResult(500), 503: problemResult(503) }, 'POST'),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)
        || idempotencyKey.startsWith('source-adopt-')) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const ownWork = body.authoring === 'own-work';
        if (ownWork && body.grain && body.grain !== 'new-creative-scope') {
          return problem(400, 'invalid_authoring_grain', 'Own-work authoring creates a new creative scope');
        }
        const ownerApi = grainOwner(body.grain ?? 'new-creative-scope');
        if (ownerApi) {
          await work.account.verify(request, ['work:create']);
          return Response.json({ outcome: 'use-owner-api', grain: body.grain, ownerApi },
            { headers: { 'cache-control': 'no-store' } });
        }
        if (!ownWork && !work.catalogueIntake) return problem(503, 'catalogue_unavailable', 'Catalogue intake is unavailable');
        const receipt = await createAdmittedMetadataWork(work.environment, work.account, work.access,
          request, { title: body.title, language: body.language ?? 'und',
            localizedTitle: body.localizedTitle, description: body.description,
            semanticTypes: body.semanticTypes,
            actingSubject: body.actingSubject,
            authorAgent: body.authoring === 'own-work' ? body.actingSubject : undefined,
            authorityPath: body.authorityPath, idempotencyKey,
            catalogue: ownWork ? undefined : { candidateReceipt: body.candidateReceipt!, grain: 'new-creative-scope',
              aliases: body.aliases, romanizations: body.romanizations,
              ...(body.parentComposition ? { parentComposition: body.parentComposition } : {}) } }, work.catalogueIntake);
        return Response.json({ work: receipt.work, mainVersion: receipt.mainVersion,
          workRevision: receipt.workRevision, mainRevision: receipt.mainRevision, admissionId: receipt.admissionId,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
          replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        if (error instanceof CataloguePendingLimit) {
          const response = problem(429, 'pending_creation_limit', 'Three creations await verification; retry after one is reviewed');
          response.headers.set('retry-after', '60');
          return response;
        }
        if (error instanceof CatalogueInvalid) return problem(400, 'invalid_catalogue_intake', error.message);
        if (error instanceof CatalogueUnavailable) return problem(503, 'catalogue_unavailable', error.message);
        if (error instanceof InvalidWorkTitleLanguage) {
          return problem(400, 'invalid_title_language', error.message);
        }
        if (error instanceof InvalidWorkSemanticTypes) {
          return problem(400, 'invalid_work_semantic_types', 'Work types conflict');
        }
        return commandError(error);
      }
    })
    .get('/v1/main-versions/:mainVersion/revisions/:revision/translation-links', {
      params: t.Object({ mainVersion: t.String(), revision: t.String() }),
      response: transportResponses(openApiOperations["/v1/main-versions/{mainVersion}/revisions/{revision}/translation-links"].get, { 200: t.Object({ profile: t.Literal('translation-links-v1'),
        mainVersion: t.String(), revision: t.String(), complete: t.Literal(true),
        links: t.Array(translationLinkRef) }),
      400: problemResult(400), 404: problemResult(404), 409: problemResult(409), 500: problemResult(500),
      503: problemResult(503) }, 'GET'),
    }, async ({ params }) => {
      if (!work) return problem(503, 'dependency_unavailable', 'Work service is unavailable');
      try {
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const revision = `https://rezics.com/id/${params.revision}`;
        const links = await readTranslationLinks(work.environment, mainVersion, revision, true);
        return Response.json({ profile: 'translation-links-v1', mainVersion, revision,
          complete: true, links }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/main-versions/:mainVersion/revisions/:revision/work-derivations', {
      params: t.Object({ mainVersion: t.String(), revision: t.String() }),
      response: transportResponses(openApiOperations["/v1/main-versions/{mainVersion}/revisions/{revision}/work-derivations"].get, { 200: t.Object({ profile: t.Literal('work-derivations-v1'),
        mainVersion: t.String(), revision: t.String(), complete: t.Literal(true),
        derivations: t.Array(workDerivationRef) }),
      400: problemResult(400), 404: problemResult(404), 409: problemResult(409),
      500: problemResult(500), 503: problemResult(503) }, 'GET'),
    }, async ({ params }) => {
      if (!work) return problem(503, 'dependency_unavailable', 'Work service is unavailable');
      try {
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const revision = `https://rezics.com/id/${params.revision}`;
        const derivations = await readWorkDerivations(work.environment, mainVersion, revision, false, true);
        return Response.json({ profile: 'work-derivations-v1', mainVersion, revision,
          complete: true, derivations }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/fixed-releases', {
      body: t.Object({ profile: t.Literal('fixed-native-text-release-v1'),
        work: t.String(), mainVersion: t.String(), expectedMainRevision: t.String(),
        expectedSelection: t.String(), actingSubject: t.String(),
        externalReleases: t.Optional(t.Array(t.Object({ run: t.String(), release: t.String(),
          sourceClaim: t.String(), expectedPosition: t.Object({
            dataEpoch: t.String(), sequence: t.String() }) }), { maxItems: 16 })),
      }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/fixed-releases"].post, { 200: fixedReleaseWrite, 201: fixedReleaseWrite, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      if (!work) return problem(503, 'dependency_unavailable', 'Work service is unavailable');
      try {
        const receipt = await createAdmittedFixedRelease(work.environment, work.account,
          work.access, request, { work: body.work, mainVersion: body.mainVersion,
            expectedMainRevision: body.expectedMainRevision,
            expectedSelection: body.expectedSelection, actingSubject: body.actingSubject,
            idempotencyKey, ...(body.externalReleases !== undefined
              ? { externalReleases: body.externalReleases } : {}) },
          work.sourceAcquisitions ? { runs: work.sourceAcquisitions.runs } : undefined);
        const exact = await readFixedRelease(work.environment, receipt.release, async () => true);
        return Response.json({ profile: 'fixed-native-text-release-v1', ...publicFixedRelease(exact),
          receipt: receipt.receipt, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/fixed-releases/:release', {
      params: t.Object({ release: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/fixed-releases/{release}"].get, { 200: fixedReleaseRead, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      if (!work) return problem(503, 'dependency_unavailable', 'Work service is unavailable');
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const exact = await readFixedRelease(work.environment,
          `https://rezics.com/id/${params.release}`, async workId => {
            if (!await work.access.canReadWork(principal, query.actingSubject, workId)) return false;
            const current = await fuseki.query(`PREFIX schema: <https://schema.org/> ASK {
              GRAPH <urn:rezics:graph:current> { ${iri(workId)} a schema:CreativeWork }
            }`);
            return current.boolean === true;
          });
        return Response.json({ profile: 'fixed-native-text-release-v1', ...publicFixedRelease(exact) },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    [workScalarOperation.method](workScalarOperation.path, workScalarOperation.options, workScalarHandler(work))
    .get('/v1/works/:id/scalar-value', {
      params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/works/{id}/scalar-value"].get, { 200: workScalarRead, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const target = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        if (!await work.access.canReadWork(principal, query.actingSubject, target)) {
          return problem(404, 'work_unavailable', 'Work is unavailable');
        }
        const graph = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          PREFIX schema: <https://schema.org/>
          SELECT ?head ?scalar WHERE { GRAPH <urn:rezics:graph:current> {
            ${iri(target)} a schema:CreativeWork ; rv:head ?head .
            OPTIONAL { ${iri(target)} <${SCALAR_PREDICATE}> ?scalar }
          } } LIMIT 2`);
        const rows = graph.results?.bindings ?? [];
        if (!rows.length) return problem(404, 'work_unavailable', 'Work is unavailable');
        if (rows.length !== 1 || !rows[0]?.head) throw new RevisionCorrupt('Work scalar graph is ambiguous');
        let graphValue;
        try { graphValue = scalarFromBinding(rows[0].scalar); }
        catch { throw new RevisionCorrupt('Work scalar graph term is invalid'); }
        const exact = await readExactWorkRevision(work.environment, rows[0].head.value,
          async owner => owner === target);
        if (!sameScalar(graphValue, exact.scalarValue)) {
          throw new RevisionCorrupt('Work scalar graph differs from exact revision');
        }
        return Response.json({ profile: 'work-scalar-state-v1', work: target,
          revision: exact.revision,
          ...(exact.scalarValue === undefined ? {} : { scalarValue: exact.scalarValue }),
          export: scalarExport(target, exact.scalarValue), sourcePosition: exact.sourcePosition },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/works/:id/scalar-value/revisions/:revision', {
      params: t.Object({ id: groupUuid, revision: groupUuid }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/works/{id}/scalar-value/revisions/{revision}"].get, { 200: workScalarRead, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const target = `https://rezics.com/id/${params.id}`;
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        if (!await work.access.canReadWork(principal, query.actingSubject, target)) {
          return problem(404, 'revision_unavailable', 'Revision is unavailable');
        }
        const current = await fuseki.query(`PREFIX schema: <https://schema.org/>
          ASK { GRAPH <urn:rezics:graph:current> { ${iri(target)} a schema:CreativeWork } }`);
        if (current.boolean !== true) return problem(404, 'revision_unavailable', 'Revision is unavailable');
        const exact = await readExactWorkRevision(work.environment,
          `https://rezics.com/id/${params.revision}`, async owner => owner === target);
        return Response.json({ profile: 'work-scalar-state-v1', work: target,
          revision: exact.revision,
          ...(exact.scalarValue === undefined ? {} : { scalarValue: exact.scalarValue }),
          export: scalarExport(target, exact.scalarValue), sourcePosition: exact.sourcePosition },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/main-versions/:mainVersion/revisions/:revision', {
      params: t.Object({
        mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        revision: t.String({ pattern: '^[0-9a-f-]{36}$' }),
      }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/main-versions/{mainVersion}/revisions/{revision}"].get, { 200: exactMainRevision, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const exact = await readExactMainRevision(work.environment,
          `https://rezics.com/id/${params.mainVersion}`,
          `https://rezics.com/id/${params.revision}`,
          workId => work.access.canReadWork(principal, query.actingSubject, workId), { resolveMerges: true });
        return Response.json(exact, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/revisions/:revision', {
      params: t.Object({ revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/revisions/{revision}"].get, { 200: t.Union([
        t.Object({ ...exactWorkRevision.properties,
          factObligations: t.Optional(wikiDisplayObligations), descriptionObligations: t.Optional(wikiDisplayObligations) }),
        t.Object({ ...t.Pick(exactWorkRevision, ['resolution', 'revision', 'work', 'predecessor', 'operation',
          'title', 'language', 'sourcePosition']).properties,
          profile: t.Literal('post-v1'), publisher: t.String(),
          labels: t.Array(t.Object({ value: t.String(), language: t.String() }), { minItems: 1, maxItems: 24 }) }),
      ]), 400: problemResult(400),
        401: problemResult(401), 403: problemResult(403),
        404: problemResult(404), 500: problemResult(500),
        503: problemResult(503) }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const delivered = await workRead(work, request, { actingSubject: query.actingSubject }, async session => {
          const read = () => readExactWorkRevision(work.environment,
            `https://rezics.com/id/${params.revision}`, workId =>
              work.access.canReadWork(principal, query.actingSubject, workId), { resolveMerges: true });
          const revision = await read();
          session.observeDependency(`exact-work-revision:${revision.revision}`, revision, read);
          if (revision.profile === 'post-v1') {
            const header = await readPost(session, revision.work);
            if (header.publisher !== revision.publisher) throw new RevisionCorrupt('Post publisher differs from retained custody');
            return revision;
          }
          const header = await readWorkHeader(session, revision.work);
          const synopsis = (await session.disclosure([{ owner: 'graph', resource: revision.work, component: 'synopsis' }]))[0];
          return { ...revision, ...(synopsis === 'visible' ? {} : { description: undefined }),
            factObligations: header.factObligations ?? { status: 'unassessed' as const },
            descriptionObligations: header.descriptionObligations };
        });
        return Response.json(delivered, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return commandError(error);
      }
    });
}

export const openApiOperations = {
  '/v1/revisions/{revision}': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/v1/main-versions/{mainVersion}/revisions/{revision}': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/v1/works/{id}/scalar-value/revisions/{revision}': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/v1/works/{id}/scalar-value': { get: { exposure: 'public', rateLimitFamily: 'read' }, post: workScalarOperation.policy },
  '/v1/fixed-releases/{release}': { get: { exposure: 'platform:commerce', rateLimitFamily: 'read' } },
  '/v1/fixed-releases': { post: { exposure: 'platform:commerce', rateLimitFamily: 'write' } },
  '/v1/main-versions/{mainVersion}/revisions/{revision}/work-derivations': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/v1/main-versions/{mainVersion}/revisions/{revision}/translation-links': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/v1/works': { post: { exposure: 'public', rateLimitFamily: 'write' } },
} as const;
