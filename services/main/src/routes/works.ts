import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { createAdmittedMetadataWork } from '../modules/work/create-admitted.ts';
import { createAdmittedTranslationLink, readTranslationLinks, validateTranslationLink }
  from '../modules/work/translation-links.ts';
import { createAdmittedWorkDerivation, readWorkDerivations, validateWorkDerivation }
  from '../modules/work/derivations.ts';
import { createAdmittedFixedRelease, readFixedRelease } from '../modules/work/fixed-release.ts';
import { setAdmittedWorkScalar } from '../modules/work/edit-admitted.ts';
import { readExactMainRevision, readExactWorkRevision, RevisionCorrupt }
  from '../modules/work/history.ts';
import { sameScalar, scalarExport, scalarFromBinding, SCALAR_PREDICATE }
  from '../modules/work/scalar-value.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { iri } from '../modules/work/activate.ts';
import { exactMainRevision, exactWorkRevision, pendingOperation, problemResult, workResult,
  workScalarRead, workScalarValue, workScalarWrite } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

const translationLinkRef = t.Object({ link: t.String(), targetWork: t.String(),
  targetMainVersion: t.String(), targetMainRevision: t.String(),
  sourceWork: t.String(), sourceMainVersion: t.String(), sourceMainRevision: t.Nullable(t.String()),
  sourceVersionStatus: t.Union([t.Literal('exact'), t.Literal('unresolved')]),
  status: t.Union([t.Literal('official'), t.Literal('third-party')]),
  contentLanguage: t.String(), translator: t.String(), publisher: t.String(),
  evidence: t.String(), authorizingParty: t.Nullable(t.String()),
  authorizationScope: t.Nullable(t.String()), authorizationEpoch: t.Nullable(t.String()) });

const translationLinkWrite = t.Object({ profile: t.Literal('translation-link-v1'),
  ...translationLinkRef.properties, receipt: t.String(), sourcePosition: t.Object({
    datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() }),
  replayed: t.Boolean() });

const workDerivationRef = t.Object({ derivation: t.String(), targetWork: t.String(),
  targetMainVersion: t.String(), targetMainRevision: t.String(),
  sourceWork: t.String(), sourceMainVersion: t.String(), sourceMainRevision: t.String(),
  kind: t.Union([t.Literal('adaptation'), t.Literal('new-recording'),
    t.Literal('software-fork')]), evidence: t.String(), linkedBy: t.String() });

const workDerivationWrite = t.Object({ profile: t.Literal('work-derivation-v1'),
  ...workDerivationRef.properties, receipt: t.String(), sourcePosition: t.Object({
    datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() }),
  replayed: t.Boolean() });

const fixedReleaseRead = t.Object({ profile: t.Literal('fixed-native-text-release-v1'),
  release: t.String(), work: t.String(), mainVersion: t.String(), mainRevision: t.String(),
  selection: t.String(), contribution: t.String(), publicationDecision: t.String(),
  selectedDraft: t.String(), language: t.String(), bodyDigest: t.String(), body: t.String(),
  sealedBy: t.String(), sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }) });

const fixedReleaseWrite = t.Object({ ...fixedReleaseRead.properties,
  receipt: t.String(), replayed: t.Boolean() });

export function workRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/works', {
      body: t.Object({
        profile: t.Literal('metadata-only-v1'),
        authorityPath: t.Optional(t.Union([
          t.Literal('represented-agent'), t.Literal('direct-principal')])),
        title: t.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
        semanticTypes: t.Optional(t.Array(t.Union([
          t.Literal('https://schema.org/Book'),
          t.Literal('https://schema.org/DigitalDocument'),
        ]), { maxItems: 2, uniqueItems: true })),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: workResult, 201: workResult, 202: pendingOperation,
        400: problemResult(400), 401: problemResult(401),
        403: problemResult(403), 409: problemResult(409),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedMetadataWork(work.environment, work.account, work.access,
          request, { title: body.title, semanticTypes: body.semanticTypes,
            actingSubject: body.actingSubject,
            authorityPath: body.authorityPath, idempotencyKey });
        return Response.json({ work: receipt.work, mainVersion: receipt.mainVersion,
          workRevision: receipt.workRevision, mainRevision: receipt.mainRevision,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
          replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        return commandError(error);
      }
    })
    .post('/v1/translation-links', {
      body: t.Object({ profile: t.Literal('translation-link-v1'),
        targetWork: t.String(), targetMainVersion: t.String(), targetMainRevision: t.String(),
        sourceWork: t.String(), sourceMainVersion: t.String(), sourceMainRevision: t.Nullable(t.String()),
        status: t.Union([t.Literal('official'), t.Literal('third-party')]),
        contentLanguage: t.String(), translator: t.String(), publisher: t.String(),
        evidence: t.String(), actingSubject: t.String(),
      }, { additionalProperties: false }),
      response: { 200: translationLinkWrite, 201: translationLinkWrite, 202: pendingOperation,
        400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
        404: problemResult(404), 409: problemResult(409),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      if (!work) return problem(503, 'dependency_unavailable', 'Work service is unavailable');
      try {
        const input = { targetWork: body.targetWork, targetMainVersion: body.targetMainVersion,
          targetMainRevision: body.targetMainRevision, sourceWork: body.sourceWork,
          sourceMainVersion: body.sourceMainVersion, sourceMainRevision: body.sourceMainRevision,
          status: body.status, contentLanguage: body.contentLanguage,
          translator: body.translator, publisher: body.publisher, evidence: body.evidence,
          actingSubject: body.actingSubject, idempotencyKey };
        validateTranslationLink(input);
        const receipt = await createAdmittedTranslationLink(work.environment, work.account,
          work.access, request, input);
        const links = await readTranslationLinks(work.environment,
          input.targetMainVersion, input.targetMainRevision);
        const linked = links.find(item => item.link === receipt.link);
        if (!linked) return problem(503, 'dependency_unavailable', 'Committed translation link is unavailable');
        return Response.json({ profile: 'translation-link-v1', ...linked,
          receipt: receipt.receipt, sourcePosition: { datasetId: 'product',
            dataEpoch: receipt.dataEpoch, sequence: receipt.sequence }, replayed: receipt.replayed },
        { status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/main-versions/:mainVersion/revisions/:revision/translation-links', {
      params: t.Object({ mainVersion: t.String(), revision: t.String() }),
      response: { 200: t.Object({ profile: t.Literal('translation-links-v1'),
        mainVersion: t.String(), revision: t.String(), complete: t.Literal(true),
        links: t.Array(translationLinkRef) }),
      400: problemResult(400), 404: problemResult(404), 409: problemResult(409), 500: problemResult(500),
      503: problemResult(503) },
    }, async ({ params }) => {
      if (!work) return problem(503, 'dependency_unavailable', 'Work service is unavailable');
      try {
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const revision = `https://rezics.com/id/${params.revision}`;
        const links = await readTranslationLinks(work.environment, mainVersion, revision);
        return Response.json({ profile: 'translation-links-v1', mainVersion, revision,
          complete: true, links }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/work-derivations', {
      body: t.Object({ profile: t.Literal('work-derivation-v1'),
        targetWork: t.String(), targetMainVersion: t.String(), expectedTargetHead: t.String(),
        sourceWork: t.String(), sourceMainVersion: t.String(), sourceMainRevision: t.String(),
        kind: t.Union([t.Literal('adaptation'), t.Literal('new-recording'),
          t.Literal('software-fork')]), evidence: t.String(), actingSubject: t.String(),
      }, { additionalProperties: false }),
      response: { 200: workDerivationWrite, 201: workDerivationWrite, 202: pendingOperation,
        400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
        404: problemResult(404), 409: problemResult(409),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      if (!work) return problem(503, 'dependency_unavailable', 'Work service is unavailable');
      try {
        const input = { targetWork: body.targetWork, targetMainVersion: body.targetMainVersion,
          expectedTargetHead: body.expectedTargetHead, sourceWork: body.sourceWork,
          sourceMainVersion: body.sourceMainVersion, sourceMainRevision: body.sourceMainRevision,
          kind: body.kind, evidence: body.evidence, actingSubject: body.actingSubject,
          idempotencyKey };
        validateWorkDerivation(input);
        const receipt = await createAdmittedWorkDerivation(work.environment, work.account,
          work.access, request, input);
        const relations = await readWorkDerivations(work.environment,
          input.targetMainVersion, input.expectedTargetHead);
        const relation = relations.find(item => item.derivation === receipt.derivation);
        if (!relation) return problem(503, 'dependency_unavailable', 'Committed derivation is unavailable');
        return Response.json({ profile: 'work-derivation-v1', ...relation,
          receipt: receipt.receipt, sourcePosition: { datasetId: 'product',
            dataEpoch: receipt.dataEpoch, sequence: receipt.sequence }, replayed: receipt.replayed },
        { status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/main-versions/:mainVersion/revisions/:revision/work-derivations', {
      params: t.Object({ mainVersion: t.String(), revision: t.String() }),
      response: { 200: t.Object({ profile: t.Literal('work-derivations-v1'),
        mainVersion: t.String(), revision: t.String(), complete: t.Literal(true),
        derivations: t.Array(workDerivationRef) }),
      400: problemResult(400), 404: problemResult(404), 409: problemResult(409),
      500: problemResult(500), 503: problemResult(503) },
    }, async ({ params }) => {
      if (!work) return problem(503, 'dependency_unavailable', 'Work service is unavailable');
      try {
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const revision = `https://rezics.com/id/${params.revision}`;
        const derivations = await readWorkDerivations(work.environment, mainVersion, revision);
        return Response.json({ profile: 'work-derivations-v1', mainVersion, revision,
          complete: true, derivations }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/fixed-releases', {
      body: t.Object({ profile: t.Literal('fixed-native-text-release-v1'),
        work: t.String(), mainVersion: t.String(), expectedMainRevision: t.String(),
        expectedSelection: t.String(), actingSubject: t.String(),
      }, { additionalProperties: false }),
      response: { 200: fixedReleaseWrite, 201: fixedReleaseWrite, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) },
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
            idempotencyKey });
        const exact = await readFixedRelease(work.environment, receipt.release, async () => true);
        return Response.json({ profile: 'fixed-native-text-release-v1', ...exact,
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
      response: { 200: fixedReleaseRead, ...authorizedReadProblems },
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
        return Response.json({ profile: 'fixed-native-text-release-v1', ...exact },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/works/:id/scalar-value', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ profile: t.Literal('work-scalar-state-v1'),
        expectedHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        scalarValue: t.Optional(workScalarValue),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: workScalarWrite, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const value = body.scalarValue;
        const receipt = await setAdmittedWorkScalar(work.environment, work.account, work.access,
          request, { work: `https://rezics.com/id/${params.id}`, expectedHead: body.expectedHead,
            ...(value === undefined ? {} : { scalarValue: value }),
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ profile: 'work-scalar-state-v1', work: receipt.work,
          revision: receipt.revision, predecessor: receipt.predecessor,
          ...(value === undefined ? {} : { scalarValue: value }),
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/works/:id/scalar-value', {
      params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: { 200: workScalarRead, ...authorizedReadProblems },
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
      response: { 200: workScalarRead, ...authorizedReadProblems },
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
      response: { 200: exactMainRevision, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const exact = await readExactMainRevision(work.environment,
          `https://rezics.com/id/${params.mainVersion}`,
          `https://rezics.com/id/${params.revision}`,
          workId => work.access.canReadWork(principal, query.actingSubject, workId));
        return Response.json(exact, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/revisions/:revision', {
      params: t.Object({ revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
      response: { 200: exactWorkRevision, 400: problemResult(400),
        401: problemResult(401), 403: problemResult(403),
        404: problemResult(404), 500: problemResult(500),
        503: problemResult(503) },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const revision = await readExactWorkRevision(work.environment,
          `https://rezics.com/id/${params.revision}`, async workId => {
            if (!await work.access.canReadWork(principal, query.actingSubject, workId)) return false;
            const current = await fuseki.query(`PREFIX schema: <https://schema.org/>
              ASK { GRAPH <urn:rezics:graph:current> { ${iri(workId)} a schema:CreativeWork } }`);
            return current.boolean === true;
          });
        return Response.json(revision, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return commandError(error);
      }
    });
}
