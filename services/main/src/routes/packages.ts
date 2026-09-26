import { Elysia, t } from 'elysia';
import { npmRequestSchema, npmResolutionSchema, npmResolutionWriteSchema }
  from '../modules/package/npm-schema.ts';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

const goModuleRequirement = t.Object({ path: t.String({ minLength: 3, maxLength: 200 }),
  version: t.String({ minLength: 6, maxLength: 96 }) }, { additionalProperties: false });

const goMvsCommon = {
  mainModule: t.String({ minLength: 3, maxLength: 200 }), goDirective: t.Literal('1.16'),
  coverage: t.Object({ complete: t.Boolean(),
    unsupportedClauses: t.Array(t.String({ minLength: 1, maxLength: 200 }),
      { maxItems: 16 }) }, { additionalProperties: false }),
  roots: t.Array(goModuleRequirement, { maxItems: 128 }),
};

const goMvsV1Request = t.Object({ profile: t.Literal('go-mvs-stable-unpruned-v1'),
  ...goMvsCommon,
  releases: t.Array(t.Object({ path: goModuleRequirement.properties.path,
    version: goModuleRequirement.properties.version,
    requirements: t.Array(goModuleRequirement, { maxItems: 64 }),
  }, { additionalProperties: false }), { maxItems: 256 }),
}, { additionalProperties: false });

const goMvsV2Request = t.Object({
  profile: t.Literal('go-mvs-stable-unpruned-main-directives-v2'), ...goMvsCommon,
  releases: t.Array(t.Object({ path: goModuleRequirement.properties.path,
    version: goModuleRequirement.properties.version,
    requirements: t.Array(goModuleRequirement, { maxItems: 64 }),
    declaredModule: t.Optional(t.String({ minLength: 3, maxLength: 200 })),
    retractions: t.Optional(t.Array(t.Object({
      lower: goModuleRequirement.properties.version,
      upper: goModuleRequirement.properties.version,
      rationale: t.String({ minLength: 1, maxLength: 200 }),
    }, { additionalProperties: false }), { maxItems: 16 })),
  }, { additionalProperties: false }), { maxItems: 256 }),
  mainDirectives: t.Object({ exclusions: t.Array(goModuleRequirement,
    { maxItems: 64 }), replacements: t.Array(t.Object({
    original: t.Object({ path: goModuleRequirement.properties.path,
      version: t.Optional(goModuleRequirement.properties.version) },
    { additionalProperties: false }), source: goModuleRequirement,
  }, { additionalProperties: false }), { maxItems: 32 }) },
  { additionalProperties: false }),
}, { additionalProperties: false });

const goMvsRequest = t.Union([goMvsV1Request, goMvsV2Request]);

const goMvsV3Request = t.Object({ profile: t.Literal('go-mvs-captured-unpruned-v3'),
  ...goMvsCommon,
  releases: goMvsV1Request.properties.releases,
  mainManifest: t.Optional(t.Object({ text: t.String({ maxLength: 65_536 }),
    rawSha256: t.String({ pattern: '^[0-9a-f]{64}$' }) },
  { additionalProperties: false })),
  captureEvidence: t.Array(t.Object({ captureId: groupUuid,
    path: goModuleRequirement.properties.path,
    version: goModuleRequirement.properties.version,
    listSha256: t.Optional(t.String()),
    selection: t.Optional(t.Literal('exact-pseudo-version')),
    infoSha256: t.String(), modSha256: t.String(),
  }, { additionalProperties: false }), { maxItems: 128 }),
}, { additionalProperties: false });

const goLocalSource = t.Object({ identity: t.String({ minLength: 3, maxLength: 200 }),
  text: t.String({ maxLength: 65_536 }),
  rawSha256: t.String({ pattern: '^[0-9a-f]{64}$' }) },
{ additionalProperties: false });

const goLocalReplacement = t.Object({ original: t.Object({
  path: goModuleRequirement.properties.path,
  version: t.Optional(goModuleRequirement.properties.version) },
{ additionalProperties: false }), sourceIdentity: t.String({ minLength: 3, maxLength: 200 }) },
{ additionalProperties: false });

const goMvsV4Request = t.Object({ profile: t.Literal('go-mvs-local-unpruned-v4'),
  ...goMvsCommon, releases: goMvsV1Request.properties.releases,
  mainManifest: t.Object({ text: t.String({ maxLength: 65_536 }),
    rawSha256: t.String({ pattern: '^[0-9a-f]{64}$' }) }, { additionalProperties: false }),
  captureEvidence: goMvsV3Request.properties.captureEvidence,
  localReplacements: t.Array(goLocalReplacement, { maxItems: 32 }),
  localSources: t.Array(goLocalSource, { maxItems: 32 }),
}, { additionalProperties: false });

const goMvsCapturedV1Request = t.Object({ profile: t.Literal('go-mvs-from-captures-v1'),
  mainModule: goMvsCommon.mainModule,
  roots: goMvsCommon.roots,
  captures: t.Array(groupUuid, { maxItems: 128 }),
}, { additionalProperties: false });

const goMvsCapturedV2Request = t.Object({
  profile: t.Literal('go-mvs-from-main-captures-v2'),
  mainManifestBase64: t.String({ maxLength: 87_384 }),
  captures: t.Array(groupUuid, { maxItems: 128 }),
}, { additionalProperties: false });

const goMvsCapturedV3Request = t.Object({
  profile: t.Literal('go-mvs-from-main-local-captures-v3'),
  mainManifestBase64: t.String({ maxLength: 87_384 }),
  captures: t.Array(groupUuid, { maxItems: 128 }),
  localSources: t.Array(t.Object({ identity: t.String({ minLength: 3, maxLength: 200 }),
    goModBase64: t.String({ maxLength: 87_384 }),
    rawSha256: t.String({ pattern: '^[0-9a-f]{64}$' }) },
  { additionalProperties: false }), { maxItems: 32 }),
}, { additionalProperties: false });

const goMvsCapturedV4Request = t.Object({
  profile: t.Literal('go-mvs-from-main-pruned-captures-v4'),
  mainManifestBase64: t.String({ maxLength: 87_384 }),
  captures: t.Array(groupUuid, { maxItems: 128 }),
}, { additionalProperties: false });

const goMvsCapturedV5Request = t.Object({
  ...goMvsCapturedV4Request.properties,
  profile: t.Literal('go-mvs-from-main-pruned-directives-captures-v5'),
}, { additionalProperties: false });

const goMvsCapturedRequest = t.Union([goMvsCapturedV1Request,
  goMvsCapturedV2Request, goMvsCapturedV3Request, goMvsCapturedV4Request,
  goMvsCapturedV5Request]);

const goMvsV5Request = t.Object({ profile: t.Literal('go-mvs-captured-pruned-v5'),
  mainModule: goMvsCommon.mainModule,
  goDirective: t.String({ minLength: 4, maxLength: 32 }),
  coverage: goMvsCommon.coverage, roots: goMvsCommon.roots,
  releases: t.Array(t.Object({ path: goModuleRequirement.properties.path,
    version: goModuleRequirement.properties.version,
    requirements: t.Array(goModuleRequirement, { maxItems: 64 }),
    goDirective: t.Union([t.String({ maxLength: 32 }), t.Null()]),
    unsupportedClauses: t.Array(t.String({ minLength: 1, maxLength: 200 }),
      { maxItems: 16 }),
  }, { additionalProperties: false }), { maxItems: 256 }),
  mainManifest: t.Object({ text: t.String({ maxLength: 65_536 }),
    rawSha256: t.String({ pattern: '^[0-9a-f]{64}$' }) },
  { additionalProperties: false }),
  captureEvidence: goMvsV3Request.properties.captureEvidence,
}, { additionalProperties: false });

const goMvsV6Request = t.Object({ ...goMvsV5Request.properties,
  profile: t.Literal('go-mvs-captured-pruned-main-directives-v6'),
  mainDirectives: goMvsV2Request.properties.mainDirectives,
  releases: t.Array(t.Object({ ...goMvsV5Request.properties.releases.items.properties,
    declaredModule: t.Optional(goMvsCommon.mainModule),
    manifestText: t.String({ maxLength: 65_536 }),
  }, { additionalProperties: false }), { maxItems: 128 }),
}, { additionalProperties: false });

const goMvsOutcome = t.Object({ status: t.Union([t.Literal('solved'),
  t.Literal('incomplete-source-data'), t.Literal('unsupported-semantics'),
  t.Literal('budget-exhausted')]),
  buildList: t.Array(goModuleRequirement), missing: t.Array(goModuleRequirement),
  unsupportedClauses: t.Array(t.String()), loadedManifestCount: t.Number(),
  requirementCount: t.Number(),
  selectedSources: t.Optional(t.Array(t.Object({ original: goModuleRequirement,
    source: goModuleRequirement }))),
  selectedSourceEvidence: t.Optional(t.Array(t.Object({ original: goModuleRequirement,
    source: goModuleRequirement, expanded: t.Boolean(),
    capture: t.Union([goMvsV3Request.properties.captureEvidence.items, t.Null()]),
  }, { additionalProperties: false }))),
  selectedLocalSources: t.Optional(t.Array(t.Object({ original: goModuleRequirement,
    sourceIdentity: t.String(), declaredModule: t.String(), rawSha256: t.String() }))),
  missingLocalSources: t.Optional(t.Array(t.String())),
  retractedSelected: t.Optional(t.Array(t.Object({ selected: goModuleRequirement,
    announcedBy: goModuleRequirement, rationale: t.String() }))) });

const goMvsResolution = t.Object({
  profile: t.Union([t.Literal('go-mvs-stable-unpruned-resolution-v1'),
    t.Literal('go-mvs-stable-unpruned-main-directives-resolution-v2'),
    t.Literal('go-mvs-captured-unpruned-resolution-v3'),
    t.Literal('go-mvs-local-unpruned-resolution-v4'),
    t.Literal('go-mvs-captured-pruned-resolution-v5'),
    t.Literal('go-mvs-captured-pruned-main-directives-resolution-v6')]),
  resolution: t.String(), requestDigest: t.String(),
  request: t.Union([goMvsV1Request, goMvsV2Request, goMvsV3Request,
    goMvsV4Request, goMvsV5Request, goMvsV6Request]),
  outcome: goMvsOutcome, createdAt: t.String() });

const goMvsResolutionWrite = t.Object({ resolution: goMvsResolution,
  replayed: t.Boolean() });

const cargoIndexFile = t.Object({ name: t.String({ minLength: 1, maxLength: 64 }),
  bytesBase64: t.String({ maxLength: 87_384 }),
  sha256: t.String({ pattern: '^[0-9a-f]{64}$' }) }, { additionalProperties: false });

const cargoTriple = t.Union([t.Literal('x86_64-unknown-linux-gnu'),
  t.Literal('x86_64-pc-windows-msvc')]);

const cargoRequestV1 = t.Object({ profile: t.Literal('cargo-index-exact-resolver2-v1'),
  registryIndexUrl: t.String({ minLength: 10, maxLength: 300 }),
  manifestBase64: t.String({ maxLength: 87_384 }),
  manifestSha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
  indexFiles: t.Array(cargoIndexFile, { maxItems: 32 }),
  host: cargoTriple, target: cargoTriple,
  features: t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
  defaultFeatures: t.Boolean(),
}, { additionalProperties: false });

const cargoRequestV2 = t.Object({ ...cargoRequestV1.properties,
  profile: t.Literal('cargo-index-exact-resolver2-v2') }, { additionalProperties: false });

const cargoRequestV3 = t.Object({ ...cargoRequestV1.properties,
  profile: t.Literal('cargo-index-exact-resolver2-v3'),
  existingLock: t.Nullable(t.Object({ bytesBase64: t.String({ maxLength: 87_384 }),
    sha256: t.String({ pattern: '^[0-9a-f]{64}$' }) }, { additionalProperties: false })),
}, { additionalProperties: false });

const cargoRequest = t.Union([cargoRequestV1, cargoRequestV2, cargoRequestV3]);

const cargoSelected = t.Object({ id: t.String(), source: t.String(),
  name: t.String(), version: t.String() });

const cargoInstance = t.Object({ ...cargoSelected.properties,
  role: t.Union([t.Literal('host'), t.Literal('target')]),
  features: t.Array(t.String()) });

const cargoEdge = t.Object({ from: t.String(), to: t.String(),
  kind: t.Union([t.Literal('normal'), t.Literal('build')]),
  target: t.Nullable(t.String()), requestedFeatures: t.Array(t.String()),
  defaultFeatures: t.Boolean() });

const cargoOutcome = t.Object({ status: t.Union([t.Literal('solved'),
  t.Literal('unsupported-semantics'), t.Literal('incomplete-source-data'),
  t.Literal('budget-exhausted')]),
  selected: t.Array(cargoSelected), instances: t.Array(cargoInstance),
  edges: t.Array(cargoEdge), missing: t.Array(t.String()),
  unsupportedClauses: t.Array(t.String()), releaseCount: t.Number(),
  edgeCount: t.Number(), featureActivationCount: t.Number() });

const cargoLinksConflict = t.Object({ kind: t.Literal('native-links'),
  links: t.String({ minLength: 1, maxLength: 64 }),
  packages: t.Array(t.Object({ ...cargoSelected.properties,
    roles: t.Array(cargoInstance.properties.role, { maxItems: 2 }) }),
  { minItems: 2, maxItems: 128 }) });

const cargoOutcomeV2 = t.Union([
  t.Object({ ...cargoOutcome.properties,
    linksConflicts: t.Array(cargoLinksConflict, { maxItems: 0 }) }),
  t.Object({ ...cargoOutcome.properties, status: t.Literal('unsatisfiable'),
    selected: t.Array(cargoSelected, { maxItems: 0 }),
    instances: t.Array(cargoInstance, { maxItems: 0 }),
    edges: t.Array(cargoEdge, { maxItems: 0 }),
    missing: t.Array(t.String(), { maxItems: 0 }),
    unsupportedClauses: t.Array(t.String(), { maxItems: 0 }),
    linksConflicts: t.Array(cargoLinksConflict, { minItems: 1, maxItems: 64 }) }),
]);

const cargoYankedReuse = t.Object({ ...cargoSelected.properties,
  lockSource: t.String(), lockChecksum: t.Nullable(t.String()), indexChecksum: t.String() });

const cargoYankedConflict = t.Object({ ...cargoSelected.properties,
  kind: t.Literal('yanked-not-locked'), lockSource: t.String(), indexChecksum: t.String() });

const cargoChecksumConflict = t.Object({ ...cargoYankedReuse.properties,
  kind: t.Literal('lock-checksum'), lockChecksum: t.String() });

const cargoOutcomeV3Fields = {
  ...cargoOutcome.properties,
  lockEvidence: t.Nullable(t.Object({ provenance: t.Literal('caller-supplied'),
    sha256: t.String(), version: t.Literal(4), packageCount: t.Number(),
    registryPackageCount: t.Number() })),
  reusedYanked: t.Array(cargoYankedReuse, { maxItems: 0 }),
  yankedConflicts: t.Array(cargoYankedConflict, { maxItems: 0 }),
  checksumConflicts: t.Array(cargoChecksumConflict, { maxItems: 0 }),
  linksConflicts: t.Array(cargoLinksConflict, { maxItems: 0 }),
};

const cargoFailedV3Fields = { ...cargoOutcomeV3Fields,
  selected: t.Array(cargoSelected, { maxItems: 0 }),
  instances: t.Array(cargoInstance, { maxItems: 0 }),
  edges: t.Array(cargoEdge, { maxItems: 0 }) };

const cargoConflictV3Fields = { ...cargoFailedV3Fields,
  missing: t.Array(t.String(), { maxItems: 0 }),
  unsupportedClauses: t.Array(t.String(), { maxItems: 0 }) };

const cargoOutcomeV3 = t.Union([
  t.Object({ ...cargoOutcomeV3Fields, status: t.Literal('solved'),
    reusedYanked: t.Array(cargoYankedReuse, { maxItems: 128 }) }),
  t.Object({ ...cargoFailedV3Fields, status: t.Union([t.Literal('unsupported-semantics'),
    t.Literal('incomplete-source-data'), t.Literal('budget-exhausted')]) }),
  t.Object({ ...cargoConflictV3Fields, status: t.Literal('unsatisfiable'),
    yankedConflicts: t.Array(cargoYankedConflict, { minItems: 1, maxItems: 128 }) }),
  t.Object({ ...cargoConflictV3Fields, status: t.Literal('unsatisfiable'),
    linksConflicts: t.Array(cargoLinksConflict, { minItems: 1, maxItems: 64 }) }),
  t.Object({ ...cargoConflictV3Fields, status: t.Literal('inconsistent-source-data'),
    checksumConflicts: t.Array(cargoChecksumConflict, { minItems: 1, maxItems: 128 }) }),
]);

const cargoResolutionV1 = t.Object({ profile: t.Literal('cargo-index-exact-resolution-v1'),
  resolution: t.String(), requestDigest: t.String(), request: cargoRequestV1,
  outcome: cargoOutcome, createdAt: t.String() });

const cargoResolutionV2 = t.Object({ ...cargoResolutionV1.properties,
  profile: t.Literal('cargo-index-exact-resolution-v2'), request: cargoRequestV2,
  outcome: cargoOutcomeV2 });

const cargoResolutionV3 = t.Object({ ...cargoResolutionV1.properties,
  profile: t.Literal('cargo-index-exact-resolution-v3'), request: cargoRequestV3,
  outcome: cargoOutcomeV3 });

const cargoResolution = t.Union([cargoResolutionV1, cargoResolutionV2, cargoResolutionV3]);

const cargoResolutionWrite = t.Object({ resolution: cargoResolution, replayed: t.Boolean() });

const goProxyCaptureV1Request = t.Object({ profile: t.Literal('go-module-proxy-capture-v1'),
  path: goModuleRequirement.properties.path,
  version: t.String({ minLength: 6, maxLength: 32,
    pattern: '^v(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$' }) },
  { additionalProperties: false });

const goProxyCaptureV2Request = t.Object({ profile: t.Literal('go-module-proxy-capture-v2'),
  path: goModuleRequirement.properties.path,
  version: goModuleRequirement.properties.version }, { additionalProperties: false });

const goProxyCaptureRequest = t.Union([goProxyCaptureV1Request, goProxyCaptureV2Request]);

const goProxyCaptureResult = t.Object({
  profile: t.Union([t.Literal('go-module-proxy-capture-v1'),
    t.Literal('go-module-proxy-capture-v2')]), capture: t.String(),
  provider: t.Literal('proxy.golang.org'), path: t.String(), version: t.String(),
  requestDigest: t.String(), fetchedAt: t.String(),
  versionList: t.Nullable(t.Object({ url: t.String(), rawSha256: t.String(), byteLength: t.Number(),
    stableVersions: t.Array(t.String()), omittedTagCount: t.Number() })),
  info: t.Object({ url: t.String(), rawSha256: t.String(), byteLength: t.Number(),
    time: t.String() }),
  manifest: t.Object({ url: t.String(), rawSha256: t.String(), goModH1: t.String(),
    byteLength: t.Number(),
    text: t.String(), parsed: t.Object({
      profile: t.Literal('go-mod-requirements-v1'),
      status: t.Union([t.Literal('parsed'), t.Literal('unsupported-syntax')]),
      declaredModule: t.Nullable(t.String()), goDirective: t.Nullable(t.String()),
      requirements: t.Array(goModuleRequirement), unsupportedClauses: t.Array(t.String()),
      compatibleWithUnprunedGo116: t.Boolean(),
    }) }), createdAt: t.String(),
});

const goProxyCaptureWrite = t.Object({ capture: goProxyCaptureResult,
  replayed: t.Boolean() });

const goSumdbTree = t.Object({ server: t.Literal('sum.golang.org'),
  size: t.Number(), rootHash: t.String(), noteSha256: t.String() });

const goSumdbVerificationResult = t.Object({
  profile: t.Literal('go-sumdb-capture-verification-v1'),
  verification: t.String(), capture: t.String(), path: t.String(),
  version: t.String(), manifestSha256: t.String(), goModH1: t.String(),
  recordIndex: t.Number(), recordSha256: t.String(),
  includedTree: goSumdbTree, trustedTree: goSumdbTree,
  createdAt: t.String(),
});

const goSumdbVerificationWrite = t.Object({
  verification: goSumdbVerificationResult, replayed: t.Boolean() });

export function packageRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/package-sources/go', {
      body: goProxyCaptureRequest,
      response: { 200: goProxyCaptureWrite, 201: goProxyCaptureWrite,
        ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, body }) => {
      try {
        if (!work.packageCaptures) return problem(503, 'go_capture_unavailable',
          'Go proxy capture owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['package:capture']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageCaptures.capture(principalId, key, body);
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/package-sources/go/:capture', {
      params: t.Object({ capture: groupUuid }),
      response: { 200: goProxyCaptureResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.packageCaptures) return problem(503, 'go_capture_unavailable',
          'Go proxy capture owner is unavailable');
        const principal = await work.account.verify(request, ['package:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageCaptures.read(principalId, params.capture);
        if (!result) return problem(404, 'go_capture_missing', 'Go capture is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/package-sources/go/:capture/verify', {
      params: t.Object({ capture: groupUuid }),
      response: { 200: goSumdbVerificationWrite, 201: goSumdbVerificationWrite,
        ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, params }) => {
      try {
        if (!work.packageVerifications) return problem(503,
          'go_sumdb_verification_unavailable', 'Go checksum verifier is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['package:verify']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageVerifications.verify(principalId,
          key, params.capture);
        if (!result) return problem(404, 'go_capture_missing',
          'Go capture is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/package-sources/go-verifications/:verification', {
      params: t.Object({ verification: groupUuid }),
      response: { 200: goSumdbVerificationResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.packageVerifications) return problem(503,
          'go_sumdb_verification_unavailable', 'Go checksum verifier is unavailable');
        const principal = await work.account.verify(request, ['package:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageVerifications.read(principalId,
          params.verification);
        if (!result) return problem(404, 'go_sumdb_verification_missing',
          'Go checksum verification is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/package-resolutions/from-captures', {
      body: goMvsCapturedRequest,
      response: { 200: goMvsResolutionWrite, 201: goMvsResolutionWrite,
        ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, body }) => {
      try {
        if (!work.packageResolutions) return problem(503, 'go_resolution_unavailable',
          'Package resolution owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['package:resolve']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageResolutions.resolveFromCaptures(principalId, key, body);
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/package-resolutions', {
      body: goMvsRequest,
      response: { 200: goMvsResolutionWrite, 201: goMvsResolutionWrite,
        ...writeProblems, 422: problemResult(422) },
    }, async ({ request, body }) => {
      try {
        if (!work.packageResolutions) return problem(503, 'go_resolution_unavailable',
          'Package resolution owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['package:resolve']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageResolutions.resolve(principalId, key, body);
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/package-resolutions/:resolution', {
      params: t.Object({ resolution: groupUuid }),
      response: { 200: goMvsResolution, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.packageResolutions) return problem(503, 'go_resolution_unavailable',
          'Package resolution owner is unavailable');
        const principal = await work.account.verify(request, ['package:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageResolutions.read(principalId, params.resolution);
        if (!result) return problem(404, 'go_resolution_unavailable',
          'Package resolution is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/package-resolutions/cargo', {
      body: cargoRequest,
      response: { 200: cargoResolutionWrite, 201: cargoResolutionWrite,
        ...writeProblems, 422: problemResult(422) },
    }, async ({ request, body }) => {
      try {
        if (!work.packageCargoResolutions) return problem(503,
          'cargo_resolution_unavailable', 'Cargo resolution owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['package:resolve']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageCargoResolutions.resolve(principalId, key, body);
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/package-resolutions/cargo/:resolution', {
      params: t.Object({ resolution: groupUuid }),
      response: { 200: cargoResolution, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.packageCargoResolutions) return problem(503,
          'cargo_resolution_unavailable', 'Cargo resolution owner is unavailable');
        const principal = await work.account.verify(request, ['package:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageCargoResolutions.read(principalId, params.resolution);
        if (!result) return problem(404, 'cargo_resolution_unavailable',
          'Cargo resolution is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/package-resolutions/npm', {
      body: npmRequestSchema,
      response: { 200: npmResolutionWriteSchema, 201: npmResolutionWriteSchema,
        ...writeProblems, 422: problemResult(422) },
    }, async ({ request, body }) => {
      try {
        if (!work.packageNpmResolutions) return problem(503,
          'npm_resolution_unavailable', 'npm resolution owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['package:resolve']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageNpmResolutions.resolve(principalId, key, body);
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/package-resolutions/npm/:resolution', {
      params: t.Object({ resolution: groupUuid }),
      response: { 200: npmResolutionSchema, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.packageNpmResolutions) return problem(503,
          'npm_resolution_unavailable', 'npm resolution owner is unavailable');
        const principal = await work.account.verify(request, ['package:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageNpmResolutions.read(principalId, params.resolution);
        if (!result) return problem(404, 'npm_resolution_unavailable', 'npm resolution is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}
