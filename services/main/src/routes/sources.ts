import { OPEN_LIBRARY_RATE } from '../modules/source/open-library.ts';
import { transportResponses } from '../transport-responses.ts';
import { Elysia, t } from 'elysia';
import { SourceIntakeConflict, SourceIntakeInvalid, MAX_RETAINED_SOURCE_BYTES } from '../modules/source/intake.ts';
import { SOURCE_ARCHIVE_LIMITS, SourceArchiveInvalid, SourceArchiveConflict, SourceArchiveUnavailable }
  from '../modules/source/archive-evidence.ts';
import { authorNameProvenance } from '../modules/source/author-name.ts';
import { checkedOpenLibraryWorkId, fetchOpenLibraryWork } from '../modules/source/open-library.ts';
import { compareSourceChildren } from '../modules/source/child-correspondence.ts';
import { ProviderIdentityConflict, ProviderIdentityInvalid, ProviderIdentityUnavailable }
  from '../modules/source/provider-identity.ts';
import { SourceScoreConflict, SourceScoreInvalid, SourceScoreUnavailable }
  from '../modules/source/score.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupUuid, sourceRightsEvidence } from './shared.ts';
import { requireSourceImportAuthority } from './source-runs.ts';
import { retainedConversionRequest, retainedConversionResult } from '../modules/source/retained-record-schema.ts';

export const openApiOperations = {
  '/v1/sources/open-library/authors/{author}/name': {
    get: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read', bearer: true }, post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/sources/identity-changes': { post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write', bearer: true } },
  '/v1/sources/identity-changes/{change}': { get: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read', bearer: true } },
  '/v1/sources/identity-corrections': { post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/sources/identity-corrections/{proposal}': { get: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read', bearer: true } },
  '/v1/sources/statistics': { post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/sources/statistics/{statistic}': { get: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read', bearer: true } },
  '/v1/sources/observations/{observation}': { get: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read' } },
  '/v1/sources/intakes': { post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write' } },
  '/v1/sources/archives': { post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/sources/archives/{archive}/image-witness': { post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read', bearer: true } },
  '/v1/sources/acquisitions/open-library/works': { post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write' } },
  '/v1/sources/proposals/{proposal}/adoption/native-work': { get: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read' }, post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write' } },
  '/v1/sources/proposals/{proposal}': { get: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read' } },
  '/v1/sources/conversions/{conversion}/proposals/native-work': { post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write' } },
  '/v1/sources/conversions/{conversion}/source-graph': { get: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read' }, post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write' } },
  '/v1/sources/correspondences/{correspondence}': { get: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read' } },
  '/v1/sources/correspondences': { post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write' } },
  '/v1/sources/conversions/{base}/child-correspondences/{candidate}': { get: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read' } },
  '/v1/sources/conversions/{base}/drift/{candidate}': { get: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read' } },
  '/v1/sources/conversions/{conversion}': { get: { exposure: 'platform:catalogue-import', rateLimitFamily: 'read' } },
  '/v1/sources/observations/{observation}/conversions': { post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write' } },
  '/v1/sources/observations/{observation}/conversions/open-library-work': { post: { exposure: 'platform:catalogue-import', rateLimitFamily: 'write' } },
} as const;

const providerIdentityChange = t.Object({ profile: t.Literal('source-record-identity-change-v1'),
  state: t.Literal('recorded'), change: t.String(), kind: t.Union([t.Literal('redirect'), t.Literal('merge')]),
  fromRecord: t.String(), toRecord: t.String(), observation: t.String(), evidencePointer: t.String(),
  provider: t.String(), namespace: t.String(), fromExternalId: t.String(), toExternalId: t.String(),
  nativeEffect: t.Literal('none'), createdAt: t.String() });
const providerIdentityCorrection = t.Object({ profile: t.Literal('source-identity-correction-proposal-v1'),
  state: t.Literal('proposed'), proposal: t.String(), change: t.String(),
  fromTarget: t.String(), toTarget: t.String(), effect: t.Literal('proposal-only'), createdAt: t.String() });
const sourceStatistic = t.Object({ profile: t.Literal('source-statistic-v1'), state: t.Literal('recorded'),
  statistic: t.String(), record: t.String(), observation: t.String(),
  kind: t.Union([t.Literal('aggregate-score'), t.Literal('provider-user-score')]),
  scorePointer: t.String(), userPointer: t.Nullable(t.String()), providerUserKey: t.Nullable(t.String()),
  score: t.String(), sourceScore: t.String(),
  valuePrecision: t.Union([t.Literal('exact'), t.Literal('rounded-to-six-decimals')]),
  observationDigest: t.String(), nativeEffect: t.Literal('none'), createdAt: t.String() });

function providerIdentityError(error: unknown): Response {
  if (error instanceof ProviderIdentityInvalid) return problem(400, 'invalid_source_identity', 'Source identity request is invalid');
  if (error instanceof ProviderIdentityConflict) return problem(409, 'source_identity_conflict', 'Source identity decision conflicts');
  if (error instanceof ProviderIdentityUnavailable) return problem(503, 'source_identity_unavailable', 'Source identity evidence is unavailable');
  return commandError(error);
}

function sourceStatisticError(error: unknown): Response {
  if (error instanceof SourceScoreInvalid) return problem(400, 'invalid_source_statistic', 'Source statistic is invalid');
  if (error instanceof SourceScoreConflict) return problem(409, 'source_statistic_conflict', 'Source statistic conflicts');
  if (error instanceof SourceScoreUnavailable) return problem(503, 'source_statistic_unavailable', 'Source statistic evidence is unavailable');
  return commandError(error);
}

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
  rawBytesBase64: t.Optional(t.String({ maxLength: Math.ceil(MAX_RETAINED_SOURCE_BYTES / 3) * 4 })),
  coverage: sourceCoverage, rightsEvidence: sourceRightsEvidence,
}, { additionalProperties: false });
const SOURCE_INTAKE_MAX_BYTES = 65_536;
const binaryArchiveMediaTypes = ['application/octet-stream','application/x-tar','application/zstd'];
const archiveDigest = t.String({ pattern: '^[0-9a-f]{64}$' });
const archiveReference = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const archiveManifest = {
  profile: t.Literal('source-retained-archive-v1'), record: archiveReference, observation: archiveReference,
  observationDigest: archiveDigest, archiveDigest, byteLength: t.Integer({ minimum: 1,maximum: SOURCE_ARCHIVE_LIMITS.bytes }),
  mediaType: t.Union([t.Literal('application/x-tar'),t.Literal('application/zstd')]),
  parts: t.Array(t.Object({ index: t.Integer({ minimum: 0,maximum: SOURCE_ARCHIVE_LIMITS.parts-1 }),
    record: archiveReference,observation: archiveReference,byteDigest: archiveDigest },{ additionalProperties: false }),
    { minItems: 1,maxItems: SOURCE_ARCHIVE_LIMITS.parts }),
};
const archiveAdmission = t.Object({ ...archiveManifest,admission: archiveReference,receipt: archiveReference },{ additionalProperties: false });
const archiveCoordinate = {
  table: t.Union((['vn','chars','vn_screenshots','releases_images','vn_image_votes'] as const).map(value => t.Literal(value))),
  rowOrdinal: t.Integer({ minimum: 0,maximum: SOURCE_ARCHIVE_LIMITS.rows-1 }),rowDigest: archiveDigest,
  fieldLocator: t.String({ minLength: 1,maxLength: 100 }),imageId: t.String({ pattern: '^(cv|ch|sf)[0-9]+$' }),
  namespace: t.Union([t.Literal('vn'),t.Literal('character'),t.Literal('release')]),
  externalId: t.String({ pattern: '^[vcr][0-9]+$' }),
  role: t.Union([t.Literal('cover'),t.Literal('portrait'),t.Literal('screenshot')]),
};
const archiveWitness = t.Object({ profile: t.Literal('source-archive-image-witness-v1'),archive: archiveAdmission,
  source: t.Object({ record: archiveReference,observation: archiveReference,observationDigest: archiveDigest,
    provider: t.String(),namespace: t.String(),externalId: t.String(),sourceRevision: t.Nullable(t.String()),
    captureUrl: t.Nullable(t.String()) },{ additionalProperties: false }),
  row: t.Object({ ...archiveCoordinate,profile: t.Literal('source-vndb-copy-row-v1'),
    decodedRow: t.Record(t.String(),t.Nullable(t.String())),decodedBytesBase64: t.String(),imageUrl: t.String() },{ additionalProperties: false }),
},{ additionalProperties: false });

function archiveError(error: unknown): Response {
  if (error instanceof SourceArchiveInvalid) return problem(422,'source_archive_invalid','Source archive coordinate or manifest is invalid');
  if (error instanceof SourceArchiveConflict) return problem(409,'source_archive_changed','Source archive evidence changed');
  if (error instanceof SourceArchiveUnavailable) return problem(503,'source_archive_unavailable','Source archive evidence is unavailable');
  return commandError(error);
}

const sourceObservationResult = t.Object({ profile: t.Union([
  t.Literal('source-manual-intake-v1'), t.Literal('source-acquisition-v1') ]),
  state: t.Literal('staged'), record: t.String(), observation: t.String(),
  provider: t.String(), namespace: t.String(), externalId: t.String(),
  sourceRevision: t.Nullable(t.String()), mediaType: t.String(),
  retention: t.Union([t.Literal('retained'), t.Literal('not-retained')]),
  byteDigest: t.Nullable(t.String()), byteLength: t.Nullable(t.Number()),
  rawBytesBase64: t.Optional(t.String()), coverage: sourceCoverage,
  rightsEvidence: sourceRightsEvidence, submittedAt: t.String(),
  capture: t.Optional(t.Object({ profile: t.Union([t.Literal('open-library-work-acquisition-v1'),
    t.Literal('open-library-author-acquisition-v1')]),
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

const mappedSourceValue = t.Object({ grain: t.String(), field: t.String(), pointer: t.String(),
  slot: t.String(), value: t.Unknown() });
const mappedSourceValues = t.Object({ title: t.Object({ ...mappedSourceValue.properties, value: t.String() }),
  semanticTypes: t.Array(t.String()), fields: t.Array(mappedSourceValue),
  children: t.Array(t.Object({ field: t.String(), grain: t.String(), slot: t.Nullable(t.String()),
    values: t.Nullable(t.Array(t.Object({ sourceKey: t.String(), roleKey: t.Nullable(t.String()),
      pointer: t.String(), value: t.Unknown() }))) })), sourceOnlyFields: t.Array(t.String()) });
const mappedConversionResult = t.Object({ profile: t.Literal('source-mapped-conversion-v1'), state: t.Literal('staged'),
  conversion: t.String(), observation: t.String(), mappingRevision: t.String(), sourceDigest: t.String(),
  projection: mappedSourceValues, fieldInventory: t.Array(t.Object({ grain: t.String(), field: t.String(),
    disposition: t.String(), reason: t.Optional(t.String()) })), createdAt: t.String() });

const sourceConversionWriteResult = t.Object({ conversion: sourceConversionResult,
  replayed: t.Boolean() });

const sourceDriftResult = t.Object({ profile: t.Union([t.Literal('open-library-work-source-drift-v1'), t.Literal('source-mapped-drift-v1')]),
  state: t.Literal('staged'), record: t.String(),
  baseConversion: t.String(), candidateConversion: t.String(),
  baseObservation: t.String(), candidateObservation: t.String(),
  baseSourceRevision: t.Nullable(t.String()), candidateSourceRevision: t.Nullable(t.String()),
  representationChanged: t.Boolean(),
  fields: t.Array(t.Object({ field: t.String(), status: t.Union([
    t.Literal('added'), t.Literal('removed'), t.Literal('changed'), t.Literal('unchanged') ]),
    baseDisposition: t.Nullable(t.String()),
    candidateDisposition: t.Nullable(t.String()),
  })) });

const sourceChildOccurrence = t.Object({ occurrence: t.String(), ordinal: t.Number(),
  sourceKey: t.String(), roleKey: t.Nullable(t.String()),
  status: t.Union([t.Literal('matched'), t.Literal('changed'), t.Literal('added'),
    t.Literal('removed'), t.Literal('ambiguous'), t.Literal('unresolved')]),
  correspondence: t.Nullable(t.String()) });

const sourceChildCorrespondenceResult = t.Object({
  profile: t.Union([t.Literal('open-library-work-child-correspondence-v1'), t.Literal('source-mapped-child-correspondence-v1')]),
  state: t.Literal('assessed'), record: t.String(),
  baseConversion: t.String(), candidateConversion: t.String(),
  fields: t.Array(t.Object({ field: t.String({ pattern: '^[A-Za-z][A-Za-z0-9:_.-]{0,99}$' }), coverage: t.Union([t.Literal('complete'),
      t.Literal('unavailable')]), base: t.Array(sourceChildOccurrence),
    candidate: t.Array(sourceChildOccurrence) })) });

const recordedSourceChildCorrespondenceResult = t.Object({
  profile: t.Literal('source-child-correspondence-v1'),
  state: t.Literal('recorded'), correspondence: t.String(), record: t.String(),
  baseConversion: t.String(), candidateConversion: t.String(),
  field: t.String({ pattern: '^[A-Za-z][A-Za-z0-9:_.-]{0,99}$' }),
  baseOccurrence: t.String(), candidateOccurrence: t.String(),
  baseOrdinal: t.Number(), candidateOrdinal: t.Number(),
  sourceKey: t.String(), createdAt: t.String(),
});

const recordedSourceChildCorrespondenceWriteResult = t.Object({
  correspondence: recordedSourceChildCorrespondenceResult, replayed: t.Boolean() });

const sourceGraphResult = t.Object({ profile: t.Union([t.Literal('open-library-work-source-graph-v1'), t.Literal('source-mapped-graph-v1')]),
  state: t.Literal('staged'), record: t.String(), observation: t.String(),
  conversion: t.String(), sourceDigest: t.String(),
  projection: t.Union([sourceConversionResult.properties.projection, mappedSourceValues]), receipt: t.String(),
  sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }) });

const sourceProposalResult = t.Object({
  profile: t.Union([t.Literal('open-library-native-work-proposal-v1'), t.Literal('source-native-work-proposal-v1')]),
  state: t.Literal('proposed'), proposal: t.String(),
  target: t.Literal('new-native-work'), record: t.String(),
  observation: t.String(), conversion: t.String(), sourceDigest: t.String(),
  candidateTitle: t.String(), semanticTypes: t.Array(t.String()),
  semanticTypeBasis: t.Literal('source-record-type'),
  sourceOnlyFields: t.Array(t.String()), mappingRevision: t.String(), rightsEvidence: sourceRightsEvidence,
  rightsStatus: t.Literal('undetermined'), graphReceipt: t.String(),
  graphPosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }), createdAt: t.String(),
});

const sourceProposalWriteResult = t.Object({ proposal: sourceProposalResult,
  replayed: t.Boolean() });

const sourceAuthorNameResult = t.Object({ revision: groupUuid, authorKey: t.String(),
  state: t.Union([t.Literal('available'), t.Literal('removed')]),
  name: t.Nullable(t.Object({ displayName: t.String({ minLength: 1, maxLength: 200 }),
    nameSource: authorNameProvenance })) });

const sourceAdoptionResult = t.Object({
  profile: t.Literal('source-native-work-adoption-v1'), state: t.Literal('adopted'),
  binding: t.String(), proposal: t.String(), sourceRecord: t.String(),
  sourceConversion: t.String(), adoptedFields: t.Union([
    t.Tuple([t.Literal('title')]), t.Tuple([t.Literal('title'), t.Literal('semanticTypes')])]),
  semanticTypes: t.Array(t.String()),
  semanticTypeBasis: t.Nullable(t.Literal('source-record-type')),
  title: t.String(), titleLanguage: t.String(), titleLanguageAtActivation: t.String(),
  titleLanguageBasis: t.Union([t.Literal('explicit'), t.Literal('work'),
    t.Literal('edition'), t.Literal('inferred')]),
  titleLanguageObservation: t.Nullable(t.String()),
  rightsStatus: t.Literal('undetermined'), work: t.String(),
  mainVersion: t.String(), workRevision: t.String(), mainRevision: t.String(),
  receipt: t.String(), sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }), createdAt: t.String(),
});

const sourceAdoptionWriteResult = t.Object({ adoption: sourceAdoptionResult,
  replayed: t.Boolean() });

export function sourceRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/sources/open-library/authors/:author/name', {
      params: t.Object({ author: t.String({ pattern: '^OL[1-9][0-9]{0,11}A$' }) }),
      response: transportResponses(openApiOperations["/v1/sources/open-library/authors/{author}/name"].get, { 200: sourceAuthorNameResult, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }) => {
      try {
        if (!work.sourceAuthorNames) return problem(503, 'source_names_unavailable', 'Source names are unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        if (!await work.access.activePrincipalId(principal)) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAuthorNames.read(`/authors/${params.author}`);
        if (!result) return problem(404, 'source_name_unavailable', 'Source name is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/sources/open-library/authors/:author/name', {
      params: t.Object({ author: t.String({ pattern: '^OL[1-9][0-9]{0,11}A$' }) }),
      body: t.Union([
        t.Object({ action: t.Literal('refresh'), expectedRevision: t.Nullable(groupUuid) }, { additionalProperties: false }),
        t.Object({ action: t.Literal('remove'), expectedRevision: groupUuid,
          reason: t.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
      ]),
      response: transportResponses(openApiOperations["/v1/sources/open-library/authors/{author}/name"].post, { 200: t.Object({ ...sourceAuthorNameResult.properties, replayed: t.Boolean() }), ...writeProblems }, 'POST'),
    }, async ({ request, params, body }) => {
      try {
        if (!work.sourceAuthorNames) return problem(503, 'source_names_unavailable', 'Source names are unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:acquire']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        await requireSourceImportAuthority(work, principal);
        return Response.json(await work.sourceAuthorNames.command(principalId, key, `/authors/${params.author}`, body),
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/sources/statistics', {
      body: t.Object({ profile: t.Literal('source-statistic-v1'), observation: groupAgent,
        kind: t.Union([t.Literal('aggregate-score'), t.Literal('provider-user-score')]),
        scorePointer: t.String({ minLength: 1, maxLength: 200 }),
        userPointer: t.Nullable(t.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/sources/statistics"].post, { 200: t.Object({ statistic: sourceStatistic, replayed: t.Boolean() }),
        201: t.Object({ statistic: sourceStatistic, replayed: t.Boolean() }),
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, body }) => {
      try {
        if (!work.sourceScores) return problem(503, 'source_statistic_unavailable', 'Source statistic owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:convert']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceScores.record(principalId, key, body);
        if (!result) return problem(404, 'source_observation_unavailable', 'Source observation is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return sourceStatisticError(error); }
    })
    .get('/v1/sources/statistics/:statistic', {
      params: t.Object({ statistic: groupUuid }), response: transportResponses(openApiOperations["/v1/sources/statistics/{statistic}"].get, { 200: sourceStatistic, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }) => {
      try {
        if (!work.sourceScores) return problem(503, 'source_statistic_unavailable', 'Source statistic owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceScores.read(principalId, params.statistic);
        if (!result) return problem(404, 'source_statistic_unavailable', 'Source statistic is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return sourceStatisticError(error); }
    })
    .post('/v1/sources/identity-changes', {
      body: t.Object({ profile: t.Literal('source-record-identity-change-v1'),
        kind: t.Union([t.Literal('redirect'), t.Literal('merge')]),
        fromRecord: groupAgent, toRecord: groupAgent, observation: groupAgent,
        evidencePointer: t.String({ minLength: 1, maxLength: 200 }) },
      { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/sources/identity-changes"].post, { 200: t.Object({ change: providerIdentityChange, replayed: t.Boolean() }),
        201: t.Object({ change: providerIdentityChange, replayed: t.Boolean() }),
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, body }) => {
      try {
        if (!work.sourceProviderIdentity) return problem(503, 'source_identity_unavailable', 'Source identity owner is unavailable');
        const principal = await work.account.verify(request, ['source:correspond']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceProviderIdentity.record(principalId, body);
        if (!result) return problem(404, 'source_observation_unavailable', 'Source observation is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return providerIdentityError(error); }
    })
    .get('/v1/sources/identity-changes/:change', {
      params: t.Object({ change: groupUuid }),
      response: transportResponses(openApiOperations["/v1/sources/identity-changes/{change}"].get, { 200: providerIdentityChange, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }) => {
      try {
        if (!work.sourceProviderIdentity) return problem(503, 'source_identity_unavailable', 'Source identity owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceProviderIdentity.read(principalId, params.change);
        if (!result) return problem(404, 'source_identity_unavailable', 'Source identity change is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return providerIdentityError(error); }
    })
    .post('/v1/sources/identity-corrections', {
      body: t.Object({ profile: t.Literal('source-identity-correction-proposal-v1'),
        change: groupAgent, fromTarget: groupAgent, toTarget: groupAgent },
      { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/sources/identity-corrections"].post, { 200: t.Object({ proposal: providerIdentityCorrection, replayed: t.Boolean() }),
        201: t.Object({ proposal: providerIdentityCorrection, replayed: t.Boolean() }),
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, body }) => {
      try {
        if (!work.sourceProviderIdentity) return problem(503, 'source_identity_unavailable', 'Source identity owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:correspond']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceProviderIdentity.propose(principalId, key, body);
        if (!result) return problem(404, 'source_identity_unavailable', 'Source identity change is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return providerIdentityError(error); }
    })
    .get('/v1/sources/identity-corrections/:proposal', {
      params: t.Object({ proposal: groupUuid }),
      response: transportResponses(openApiOperations["/v1/sources/identity-corrections/{proposal}"].get, { 200: providerIdentityCorrection, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }) => {
      try {
        if (!work.sourceProviderIdentity) return problem(503, 'source_identity_unavailable', 'Source identity owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceProviderIdentity.readProposal(principalId, params.proposal);
        if (!result) return problem(404, 'source_identity_unavailable', 'Source identity correction is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return providerIdentityError(error); }
    })
    .post('/v1/sources/observations/:observation/conversions', {
      params: t.Object({ observation: groupUuid }),
      body: t.Union([retainedConversionRequest,
        t.Object({ profile: t.String({ pattern: '^[a-z0-9][a-z0-9-]{0,94}-v[1-9][0-9]{0,2}$' }) },
          { additionalProperties: false })]),
      response: transportResponses(openApiOperations["/v1/sources/observations/{observation}/conversions"].post,
        { 200: t.Object({ conversion: t.Union([mappedConversionResult, retainedConversionResult]), replayed: t.Boolean() }),
          201: t.Object({ conversion: t.Union([mappedConversionResult, retainedConversionResult]), replayed: t.Boolean() }),
          ...writeProblems, 404: problemResult(404), 422: problemResult(422) }, 'POST'),
    }, async ({ request, params, body }) => {
      try {
        if (!work.sourceConversions) return problem(503, 'source_conversion_unavailable', 'Source conversion owner is unavailable');
        const principal = await work.account.verify(request, ['source:convert']);
        if ('retained' in body) await requireSourceImportAuthority(work, principal);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = 'retained' in body
          ? await work.sourceConversions.retained.convert(principalId, params.observation, body)
          : await work.sourceConversions.convertMapped(principalId, params.observation, body.profile);
        if (!result) return problem(404, 'source_observation_unavailable', 'Source observation is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/sources/observations/:observation/conversions/open-library-work', {
      params: t.Object({ observation: groupUuid }),
      body: t.Object({ profile: t.Literal('open-library-work-map-v1') },
        { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/sources/observations/{observation}/conversions/open-library-work"].post, { 200: sourceConversionWriteResult, 201: sourceConversionWriteResult,
        ...writeProblems, 404: problemResult(404), 422: problemResult(422) }, 'POST'),
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
      response: transportResponses(openApiOperations["/v1/sources/conversions/{conversion}"].get, { 200: t.Union([sourceConversionResult, mappedConversionResult, retainedConversionResult]), ...authorizedReadProblems,
        422: problemResult(422) }, 'GET'),
    }, async ({ request, params }) => {
      try {
        if (!work.sourceConversions) {
          return problem(503, 'source_conversion_unavailable', 'Source conversion owner is unavailable');
        }
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const retained = await work.sourceConversions.retained.read(principalId, params.conversion);
        if (retained) return Response.json(retained, { headers: { 'cache-control': 'no-store' } });
        const evidence = await work.sourceConversions.mappedRead(principalId, params.conversion);
        const result = evidence?.legacy ?? evidence?.conversion;
        if (!result) return problem(404, 'source_conversion_unavailable',
          'Source conversion is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/sources/conversions/:base/drift/:candidate', {
      params: t.Object({ base: groupUuid, candidate: groupUuid }),
      response: transportResponses(openApiOperations["/v1/sources/conversions/{base}/drift/{candidate}"].get, { 200: sourceDriftResult, ...authorizedReadProblems,
        422: problemResult(422) }, 'GET'),
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
      response: transportResponses(openApiOperations["/v1/sources/conversions/{base}/child-correspondences/{candidate}"].get, { 200: sourceChildCorrespondenceResult, ...authorizedReadProblems,
        422: problemResult(422) }, 'GET'),
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
        field: t.String({ pattern: '^[A-Za-z][A-Za-z0-9:_.-]{0,99}$' }),
        baseOccurrence: t.String({ pattern: '^urn:rezics:source-occurrence:[0-9a-f]{64}$' }),
        candidateOccurrence: t.String({ pattern: '^urn:rezics:source-occurrence:[0-9a-f]{64}$' }),
        confirmedSameSourceChild: t.Literal(true),
      }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/sources/correspondences"].post, { 200: recordedSourceChildCorrespondenceWriteResult,
        201: recordedSourceChildCorrespondenceWriteResult,
        ...writeProblems, 404: problemResult(404), 422: problemResult(422) }, 'POST'),
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
      response: transportResponses(openApiOperations["/v1/sources/correspondences/{correspondence}"].get, { 200: recordedSourceChildCorrespondenceResult,
        ...authorizedReadProblems }, 'GET'),
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
      body: t.Object({ profile: t.Union([t.Literal('source-open-library-work-v1'), t.Literal('source-mapped-values-v1')]) },
        { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/sources/conversions/{conversion}/source-graph"].post, { 200: sourceGraphResult, ...writeProblems,
        404: problemResult(404), 422: problemResult(422) }, 'POST'),
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
      response: transportResponses(openApiOperations["/v1/sources/conversions/{conversion}/source-graph"].get, { 200: sourceGraphResult, ...authorizedReadProblems,
        422: problemResult(422) }, 'GET'),
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
      body: t.Object({ profile: t.Union([t.Literal('open-library-native-work-proposal-v1'), t.Literal('source-native-work-proposal-v1')]) },
        { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/sources/conversions/{conversion}/proposals/native-work"].post, { 200: sourceProposalWriteResult, 201: sourceProposalWriteResult,
        ...writeProblems, 404: problemResult(404), 409: problemResult(409),
        422: problemResult(422) }, 'POST'),
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
      response: transportResponses(openApiOperations["/v1/sources/proposals/{proposal}"].get, { 200: sourceProposalResult, ...authorizedReadProblems,
        422: problemResult(422) }, 'GET'),
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
        titleLanguage: t.Optional(t.String({ minLength: 2, maxLength: 35,
          pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' })),
      }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/sources/proposals/{proposal}/adoption/native-work"].post, { 200: sourceAdoptionWriteResult, 201: sourceAdoptionWriteResult,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) }, 'POST'),
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
      response: transportResponses(openApiOperations["/v1/sources/proposals/{proposal}/adoption/native-work"].get, { 200: sourceAdoptionResult, ...authorizedReadProblems }, 'GET'),
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
      response: transportResponses(openApiOperations["/v1/sources/acquisitions/open-library/works"].post, { 200: sourceIntakeResult, 201: sourceIntakeResult,
        ...writeProblems, 404: problemResult(404), 429: problemResult(429) }, 'POST'),
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
        await requireSourceImportAuthority(work, principal);
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
        await work.sourceIntake.reserveProviderSlot(OPEN_LIBRARY_RATE);
        const captured = await fetchOpenLibraryWork(workId, work.openLibraryFetch ?? fetch);
        const result = await work.sourceIntake.submit(principalId, key,
          captured.input, captured.capture);
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/sources/intakes', {
      body: sourceIntakeBody,
      detail: { description: 'Retained binary archive parts accept up to 262,144 decoded bytes; other manual sources accept up to 65,536 decoded bytes.' },
      response: transportResponses(openApiOperations["/v1/sources/intakes"].post, { 200: sourceIntakeResult, 201: sourceIntakeResult, ...writeProblems }, 'POST'),
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
        await requireSourceImportAuthority(work, principal);
        if (body.retention === 'retained' && body.rawBytesBase64
          && Buffer.from(body.rawBytesBase64, 'base64').byteLength > (binaryArchiveMediaTypes.includes(body.mediaType)
            ? MAX_RETAINED_SOURCE_BYTES : SOURCE_INTAKE_MAX_BYTES)) {
          throw new SourceIntakeInvalid('manual source exceeds its media byte limit');
        }
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
    .post('/v1/sources/archives', {
      body: t.Object({ ...archiveManifest,actingSubject: archiveReference },{ additionalProperties: false }),
      response: transportResponses(openApiOperations['/v1/sources/archives'].post,
        { 200: t.Object({ admission: archiveAdmission,replayed: t.Boolean() }),
          201: t.Object({ admission: archiveAdmission,replayed: t.Boolean() }),422: problemResult(422),...writeProblems },'POST'),
    },async ({ request,body }) => {
      try {
        if (!work.sourceArchives) return problem(503,'source_archive_unavailable','Source archive owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400,'invalid_idempotency_key','Idempotency-Key is required');
        const principal = await work.account.verify(request,['source:intake']);
        await requireSourceImportAuthority(work,principal);
        const { actingSubject,...manifest } = body;
        const result = await work.sourceArchives.admit(principal,actingSubject,key,manifest);
        return Response.json(result,{ status: result.replayed ? 200 : 201,headers: { 'cache-control': 'no-store' } });
      } catch (error) { return archiveError(error); }
    })
    .post('/v1/sources/archives/:archive/image-witness', {
      params: t.Object({ archive: groupUuid }),body: t.Object(archiveCoordinate,{ additionalProperties: false }),
      response: transportResponses(openApiOperations['/v1/sources/archives/{archive}/image-witness'].post,
        { 200: archiveWitness,409: problemResult(409),422: problemResult(422),...authorizedReadProblems },'POST'),
    },async ({ request,params,body }) => {
      try {
        if (!work.sourceArchives) return problem(503,'source_archive_unavailable','Source archive owner is unavailable');
        const principal = await work.account.verify(request,['source:read']);
        const witness = await work.sourceArchives.verify(principal,`https://rezics.com/id/${params.archive}`,body);
        const { decodedBytes,...row } = witness.row;
        return Response.json({ ...witness,row: { ...row,decodedBytesBase64: Buffer.from(decodedBytes).toString('base64') } },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return archiveError(error); }
    })
    .get('/v1/sources/observations/:observation', {
      params: t.Object({ observation: groupUuid }),
      response: transportResponses(openApiOperations["/v1/sources/observations/{observation}"].get, { 200: sourceObservationResult, ...authorizedReadProblems }, 'GET'),
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
