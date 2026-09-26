import { Elysia, t } from 'elysia';
import { SourceIntakeConflict } from '../modules/source/intake.ts';
import { checkedOpenLibraryWorkId, fetchOpenLibraryWork } from '../modules/source/open-library.ts';
import { compareSourceChildren } from '../modules/source/child-correspondence.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupUuid, sourceRightsEvidence } from './shared.ts';

const sourceCoverage = t.Object({ scope: t.String({ minLength: 1, maxLength: 200 }),
  complete: t.Boolean(), omittedFields: t.Array(t.String({ minLength: 1, maxLength: 100 }),
    { maxItems: 64, uniqueItems: true }) }, { additionalProperties: false });

const sourceIntakeBody = t.Object({ profile: t.Literal('source-manual-intake-v1'),
  provider: t.String({ minLength: 1, maxLength: 100 }),
  namespace: t.String({ minLength: 1, maxLength: 100 }),
  externalId: t.String({ minLength: 1, maxLength: 500 }),
  sourceRevision: t.Nullable(t.String({ minLength: 1, maxLength: 200 })),
  mediaType: t.String({ minLength: 1, maxLength: 100 }),
  retention: t.Union([t.Literal('retained'), t.Literal('not-retained')]),
  rawBytesBase64: t.Optional(t.String({ maxLength: 87384 })),
  coverage: sourceCoverage, rightsEvidence: sourceRightsEvidence,
}, { additionalProperties: false });

const sourceObservationResult = t.Object({ profile: t.Union([
  t.Literal('source-manual-intake-v1'), t.Literal('source-acquisition-v1') ]),
  state: t.Literal('staged'), record: t.String(), observation: t.String(),
  provider: t.String(), namespace: t.String(), externalId: t.String(),
  sourceRevision: t.Nullable(t.String()), mediaType: t.String(),
  retention: t.Union([t.Literal('retained'), t.Literal('not-retained')]),
  byteDigest: t.Nullable(t.String()), byteLength: t.Nullable(t.Number()),
  rawBytesBase64: t.Optional(t.String()), coverage: sourceCoverage,
  rightsEvidence: sourceRightsEvidence, submittedAt: t.String(),
  capture: t.Optional(t.Object({ profile: t.Literal('open-library-work-acquisition-v1'),
    url: t.String(), status: t.Literal(200), etag: t.Nullable(t.String()),
    lastModified: t.Nullable(t.String()), fetchedAt: t.String() })),
});

const sourceIntakeResult = t.Object({ observation: sourceObservationResult,
  replayed: t.Boolean() });

const openLibraryWorkAcquisitionBody = t.Object({
  profile: t.Literal('open-library-work-acquisition-v1'),
  workId: t.String({ pattern: '^OL[1-9][0-9]{0,11}W$' }),
}, { additionalProperties: false });

const sourceDisposition = t.Union([
  t.Literal('source-identity'), t.Literal('candidate-fact'),
  t.Literal('source-expression'), t.Literal('source-reference'),
  t.Literal('source-terms'), t.Literal('source-metadata'),
  t.Literal('retained-only'), t.Literal('unmapped-retained') ]);

const sourceConversionResult = t.Object({ profile: t.Literal('open-library-work-source-conversion-v1'),
  state: t.Literal('staged'), conversion: t.String(), observation: t.String(),
  mappingRevision: t.Literal('open-library-work-map-v1'), sourceDigest: t.String(),
  projection: t.Object({ sourceKey: t.String(), title: t.String(),
    description: t.Nullable(t.String()),
    authorRefs: t.Nullable(t.Array(t.Object({ sourceKey: t.String(),
      roleKey: t.Nullable(t.String()) }))),
    subjects: t.Nullable(t.Array(t.String())) }),
  fieldInventory: t.Array(t.Object({ field: t.String(), disposition: sourceDisposition })),
  createdAt: t.String(),
});

const sourceConversionWriteResult = t.Object({ conversion: sourceConversionResult,
  replayed: t.Boolean() });

const sourceDriftResult = t.Object({ profile: t.Literal('open-library-work-source-drift-v1'),
  state: t.Literal('staged'), record: t.String(),
  baseConversion: t.String(), candidateConversion: t.String(),
  baseObservation: t.String(), candidateObservation: t.String(),
  baseSourceRevision: t.Nullable(t.String()), candidateSourceRevision: t.Nullable(t.String()),
  representationChanged: t.Boolean(),
  fields: t.Array(t.Object({ field: t.String(), status: t.Union([
    t.Literal('added'), t.Literal('removed'), t.Literal('changed'), t.Literal('unchanged') ]),
    baseDisposition: t.Nullable(sourceDisposition),
    candidateDisposition: t.Nullable(sourceDisposition),
  })) });

const sourceChildOccurrence = t.Object({ occurrence: t.String(), ordinal: t.Number(),
  sourceKey: t.String(), roleKey: t.Nullable(t.String()),
  status: t.Union([t.Literal('matched'), t.Literal('changed'), t.Literal('added'),
    t.Literal('removed'), t.Literal('ambiguous'), t.Literal('unresolved')]),
  correspondence: t.Nullable(t.String()) });

const sourceChildCorrespondenceResult = t.Object({
  profile: t.Literal('open-library-work-child-correspondence-v1'),
  state: t.Literal('assessed'), record: t.String(),
  baseConversion: t.String(), candidateConversion: t.String(),
  fields: t.Array(t.Object({ field: t.Union([t.Literal('authors'),
    t.Literal('subjects')]), coverage: t.Union([t.Literal('complete'),
      t.Literal('unavailable')]), base: t.Array(sourceChildOccurrence),
    candidate: t.Array(sourceChildOccurrence) })) });

const recordedSourceChildCorrespondenceResult = t.Object({
  profile: t.Literal('source-child-correspondence-v1'),
  state: t.Literal('recorded'), correspondence: t.String(), record: t.String(),
  baseConversion: t.String(), candidateConversion: t.String(),
  field: t.Union([t.Literal('authors'), t.Literal('subjects')]),
  baseOccurrence: t.String(), candidateOccurrence: t.String(),
  baseOrdinal: t.Number(), candidateOrdinal: t.Number(),
  sourceKey: t.String(), createdAt: t.String(),
});

const recordedSourceChildCorrespondenceWriteResult = t.Object({
  correspondence: recordedSourceChildCorrespondenceResult, replayed: t.Boolean() });

const sourceGraphResult = t.Object({ profile: t.Literal('open-library-work-source-graph-v1'),
  state: t.Literal('staged'), record: t.String(), observation: t.String(),
  conversion: t.String(), sourceDigest: t.String(),
  projection: sourceConversionResult.properties.projection, receipt: t.String(),
  sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }) });

const sourceProposalResult = t.Object({
  profile: t.Literal('open-library-native-work-proposal-v1'),
  state: t.Literal('proposed'), proposal: t.String(),
  target: t.Literal('new-native-work'), record: t.String(),
  observation: t.String(), conversion: t.String(), sourceDigest: t.String(),
  candidateTitle: t.String(), semanticTypes: t.Array(t.String(), { maxItems: 0 }),
  sourceOnlyFields: t.Tuple([t.Literal('description'), t.Literal('authors'),
    t.Literal('subjects')]), rightsEvidence: sourceRightsEvidence,
  rightsStatus: t.Literal('undetermined'), graphReceipt: t.String(),
  graphPosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }), createdAt: t.String(),
});

const sourceProposalWriteResult = t.Object({ proposal: sourceProposalResult,
  replayed: t.Boolean() });

const sourceAdoptionResult = t.Object({
  profile: t.Literal('source-native-work-adoption-v1'), state: t.Literal('adopted'),
  binding: t.String(), proposal: t.String(), sourceRecord: t.String(),
  sourceConversion: t.String(), adoptedFields: t.Tuple([t.Literal('title')]),
  title: t.String(), titleLanguage: t.Literal('en'),
  rightsStatus: t.Literal('undetermined'), work: t.String(),
  mainVersion: t.String(), workRevision: t.String(), mainRevision: t.String(),
  receipt: t.String(), sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }), createdAt: t.String(),
});

const sourceAdoptionWriteResult = t.Object({ adoption: sourceAdoptionResult,
  replayed: t.Boolean() });

export function sourceRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/sources/observations/:observation/conversions/open-library-work', {
      params: t.Object({ observation: groupUuid }),
      body: t.Object({ profile: t.Literal('open-library-work-map-v1') },
        { additionalProperties: false }),
      response: { 200: sourceConversionWriteResult, 201: sourceConversionWriteResult,
        ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceConversions) {
          return problem(503, 'source_conversion_unavailable', 'Source conversion owner is unavailable');
        }
        const principal = await work.account.verify(request, ['source:convert']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceConversions.convert(principalId, params.observation);
        if (!result) return problem(404, 'source_observation_unavailable',
          'Source observation is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/sources/conversions/:conversion', {
      params: t.Object({ conversion: groupUuid }),
      response: { 200: sourceConversionResult, ...authorizedReadProblems,
        422: problemResult(422) },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceConversions) {
          return problem(503, 'source_conversion_unavailable', 'Source conversion owner is unavailable');
        }
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceConversions.read(principalId, params.conversion);
        if (!result) return problem(404, 'source_conversion_unavailable',
          'Source conversion is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/sources/conversions/:base/drift/:candidate', {
      params: t.Object({ base: groupUuid, candidate: groupUuid }),
      response: { 200: sourceDriftResult, ...authorizedReadProblems,
        422: problemResult(422) },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceConversions) {
          return problem(503, 'source_conversion_unavailable', 'Source conversion owner is unavailable');
        }
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceConversions.compare(principalId, params.base, params.candidate);
        if (!result) return problem(404, 'source_conversion_unavailable',
          'Source conversion is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/sources/conversions/:base/child-correspondences/:candidate', {
      params: t.Object({ base: groupUuid, candidate: groupUuid }),
      response: { 200: sourceChildCorrespondenceResult, ...authorizedReadProblems,
        422: problemResult(422) },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceConversions) return problem(503, 'source_conversion_unavailable',
          'Source conversion owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await compareSourceChildren(work.sourceConversions,
          principalId, params.base, params.candidate);
        if (!result) return problem(404, 'source_conversion_unavailable',
          'Source conversion is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/sources/correspondences', {
      body: t.Object({ profile: t.Literal('source-child-correspondence-v1'),
        baseConversion: groupUuid, candidateConversion: groupUuid,
        field: t.Union([t.Literal('authors'), t.Literal('subjects')]),
        baseOccurrence: t.String({ pattern: '^urn:rezics:source-occurrence:[0-9a-f]{64}$' }),
        candidateOccurrence: t.String({ pattern: '^urn:rezics:source-occurrence:[0-9a-f]{64}$' }),
        confirmedSameSourceChild: t.Literal(true),
      }, { additionalProperties: false }),
      response: { 200: recordedSourceChildCorrespondenceWriteResult,
        201: recordedSourceChildCorrespondenceWriteResult,
        ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, body }) => {
      try {
        if (!work.sourceCorrespondences) return problem(503, 'source_correspondence_unavailable',
          'Source child correspondence owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:correspond']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceCorrespondences.record(principalId, key, body);
        if (!result) return problem(404, 'source_conversion_unavailable',
          'Source conversion is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/sources/correspondences/:correspondence', {
      params: t.Object({ correspondence: groupUuid }),
      response: { 200: recordedSourceChildCorrespondenceResult,
        ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceCorrespondences) return problem(503, 'source_correspondence_unavailable',
          'Source child correspondence owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceCorrespondences.read(principalId,
          params.correspondence);
        if (!result) return problem(404, 'source_correspondence_unavailable',
          'Source child correspondence is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/sources/conversions/:conversion/source-graph', {
      params: t.Object({ conversion: groupUuid }),
      body: t.Object({ profile: t.Literal('source-open-library-work-v1') },
        { additionalProperties: false }),
      response: { 200: sourceGraphResult, ...writeProblems,
        404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceGraph) return problem(503, 'source_graph_unavailable',
          'Source graph owner is unavailable');
        const principal = await work.account.verify(request, ['source:convert']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceGraph.project(principalId, params.conversion);
        if (!result) return problem(404, 'source_conversion_unavailable',
          'Source conversion is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/sources/conversions/:conversion/source-graph', {
      params: t.Object({ conversion: groupUuid }),
      response: { 200: sourceGraphResult, ...authorizedReadProblems,
        422: problemResult(422) },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceGraph) return problem(503, 'source_graph_unavailable',
          'Source graph owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceGraph.read(principalId, params.conversion);
        if (!result) return problem(404, 'source_graph_unavailable',
          'Source graph projection is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/sources/conversions/:conversion/proposals/native-work', {
      params: t.Object({ conversion: groupUuid }),
      body: t.Object({ profile: t.Literal('open-library-native-work-proposal-v1') },
        { additionalProperties: false }),
      response: { 200: sourceProposalWriteResult, 201: sourceProposalWriteResult,
        ...writeProblems, 404: problemResult(404), 409: problemResult(409),
        422: problemResult(422) },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceProposals) return problem(503, 'source_proposal_unavailable',
          'Source proposal owner is unavailable');
        const principal = await work.account.verify(request, ['source:propose']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceProposals.propose(principalId, params.conversion);
        if (!result) return problem(404, 'source_conversion_unavailable',
          'Source conversion is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/sources/proposals/:proposal', {
      params: t.Object({ proposal: groupUuid }),
      response: { 200: sourceProposalResult, ...authorizedReadProblems,
        422: problemResult(422) },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceProposals) return problem(503, 'source_proposal_unavailable',
          'Source proposal owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceProposals.read(principalId, params.proposal);
        if (!result) return problem(404, 'source_proposal_unavailable',
          'Source proposal is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/sources/proposals/:proposal/adoption/native-work', {
      params: t.Object({ proposal: groupUuid }),
      body: t.Object({ profile: t.Literal('source-native-work-adoption-v1'),
        actingSubject: groupAgent,
        authorityPath: t.Optional(t.Union([
          t.Literal('represented-agent'), t.Literal('direct-principal') ])),
        confirmedTitle: t.String({ minLength: 1, maxLength: 200 }),
        titleLanguage: t.Literal('en'),
      }, { additionalProperties: false }),
      response: { 200: sourceAdoptionWriteResult, 201: sourceAdoptionWriteResult,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      try {
        if (!work.sourceAdoptions) return problem(503, 'source_adoption_unavailable',
          'Source adoption owner is unavailable');
        const principal = await work.account.verify(request, ['source:adopt', 'work:create']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAdoptions.adopt(principalId, request, params.proposal,
          { actingSubject: body.actingSubject,
            authorityPath: body.authorityPath ?? 'represented-agent',
            confirmedTitle: body.confirmedTitle, titleLanguage: body.titleLanguage });
        if (!result) return problem(404, 'source_proposal_unavailable',
          'Source proposal is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/sources/proposals/:proposal/adoption/native-work', {
      params: t.Object({ proposal: groupUuid }),
      response: { 200: sourceAdoptionResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceAdoptions) return problem(503, 'source_adoption_unavailable',
          'Source adoption owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAdoptions.read(principalId, params.proposal);
        if (!result) return problem(404, 'source_adoption_unavailable',
          'Source adoption is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/sources/acquisitions/open-library/works', {
      body: openLibraryWorkAcquisitionBody,
      response: { 200: sourceIntakeResult, 201: sourceIntakeResult,
        ...writeProblems, 404: problemResult(404), 429: problemResult(429) },
    }, async ({ request, body }) => {
      try {
        if (!work.sourceIntake) {
          return problem(503, 'source_intake_unavailable', 'Source intake owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const workId = checkedOpenLibraryWorkId(body.workId);
        const principal = await work.account.verify(request, ['source:acquire']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const prior = await work.sourceIntake.replay(principalId, key);
        if (prior) {
          if (prior.capture?.profile !== 'open-library-work-acquisition-v1'
            || prior.provider !== 'open-library' || prior.namespace !== 'work'
            || prior.externalId !== workId) {
            throw new SourceIntakeConflict('source acquisition key changed intent');
          }
          return Response.json({ observation: prior, replayed: true },
            { headers: { 'cache-control': 'no-store' } });
        }
        await work.sourceIntake.reserveOpenLibrarySlot();
        const captured = await fetchOpenLibraryWork(workId, work.openLibraryFetch ?? fetch);
        const result = await work.sourceIntake.submit(principalId, key,
          captured.input, captured.capture);
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/sources/intakes', {
      body: sourceIntakeBody,
      response: { 200: sourceIntakeResult, 201: sourceIntakeResult, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        if (!work.sourceIntake) {
          return problem(503, 'source_intake_unavailable', 'Source intake owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:intake']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source intake principal is inactive');
        const result = await work.sourceIntake.submit(principalId, key, {
          provider: body.provider, namespace: body.namespace, externalId: body.externalId,
          sourceRevision: body.sourceRevision, mediaType: body.mediaType,
          retention: body.retention, rawBytesBase64: body.rawBytesBase64,
          coverage: body.coverage, rightsEvidence: body.rightsEvidence,
        });
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/sources/observations/:observation', {
      params: t.Object({ observation: groupUuid }),
      response: { 200: sourceObservationResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceIntake) {
          return problem(503, 'source_intake_unavailable', 'Source intake owner is unavailable');
        }
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const observation = await work.sourceIntake.read(principalId, params.observation);
        if (!observation) return problem(404, 'source_observation_unavailable',
          'Source observation is unavailable');
        return Response.json(observation, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}
