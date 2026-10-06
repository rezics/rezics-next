import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { AdmissionDenied } from '../modules/access/admission.ts';
import { PackageInstallRequestInvalid, PackageInstallRequestUnavailable, resolveMainVersionInstallRequest,
  type PackageInstallEnvironment } from '../modules/package/install-request.ts';
import { PackageRecommendationConflict, PackageRecommendationInvalid, PackageRecommendationStale,
  PackageRecommendationUnavailable, readMainPackageRecommendations, setAdmittedMainPackageRecommendations,
  type PackageReleaseRecommendation } from '../modules/package/release-recommendation.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupUuid } from './shared.ts';

const nativeId = (label: string) => t.String({ pattern: `^https://rezics\\.com/id/[0-9a-f-]{36}$`, description: label });
const sha256 = t.String({ pattern: '^[0-9a-f]{64}$' });
const recommendation = t.Object({ ecosystem: t.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' }),
  packageName: t.String({ minLength: 1, maxLength: 256, pattern: '^[^\\u0000-\\u0020]+$' }),
  selector: t.Object({ kind: t.Union([t.Literal('version-constraint'), t.Literal('exact-release')]),
    value: t.String({ minLength: 1, maxLength: 256, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }) },
  { additionalProperties: false }) }, { additionalProperties: false });
const recommendationSet = t.Object({ profile: t.Literal('main-package-release-recommendation-v1'),
  work: nativeId('Work'), mainVersion: nativeId('Main Version'), revision: t.Nullable(nativeId('revision')),
  recommendations: t.Array(recommendation, { maxItems: 16 }),
  sourcePosition: t.Optional(t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() })) });
const recommendationWrite = t.Object({ ...recommendationSet.properties,
  receipt: t.String(), replayed: t.Boolean() });
const environment = t.Object({ os: t.Union([t.Literal('linux'), t.Literal('win32')]),
  cpu: t.Union([t.Literal('x64'), t.Literal('arm64')]), nodeVersion: t.String({ minLength: 1, maxLength: 64 }),
  cargoHost: t.Union([t.Literal('x86_64-unknown-linux-gnu'), t.Literal('x86_64-pc-windows-msvc')]),
  cargoTarget: t.Union([t.Literal('x86_64-unknown-linux-gnu'), t.Literal('x86_64-pc-windows-msvc')]) },
{ additionalProperties: false });
const installResult = t.Object({ profile: t.Literal('main-version-package-install-request-v1'),
  status: t.Union([t.Literal('resolved'), t.Literal('refused')]),
  reason: t.Optional(t.Union(['unsupported-ecosystem', 'unsupported-selector', 'no-eligible-release',
    'artifact-unverified', 'source-incomplete', 'budget-exhausted'].map(value => t.Literal(value)))),
  recommendationRevision: nativeId('recommendation revision'),
  resolutions: t.Array(t.Object({ ecosystem: t.Union([t.Literal('npm'), t.Literal('cargo')]),
    resolution: nativeId('resolution'), profile: t.String() })), lock: t.Nullable(nativeId('lock')),
  lockSha256: t.Nullable(sha256), environment, replayed: t.Boolean() });
const installRequest = t.Object({ profile: t.Literal('main-version-package-install-request-v1'),
  mainVersion: nativeId('Main Version'), recommendationRevision: nativeId('recommendation revision'),
  actingSubject: groupAgent, environment,
  cargoIndexFiles: t.Optional(t.Array(t.Object({ name: t.String({ minLength: 1, maxLength: 64 }),
    bytesBase64: t.String({ maxLength: 87_384 }), sha256 }, { additionalProperties: false }), { maxItems: 32 })),
  cargoArtifacts: t.Optional(t.Array(t.Object({ name: t.String({ minLength: 1, maxLength: 64 }),
    version: t.String({ minLength: 1, maxLength: 64 }),
    bytesBase64: t.String({ maxLength: 44_739_246 }) }, { additionalProperties: false }), { maxItems: 129 })) },
{ additionalProperties: false });

export const openApiOperations = {
  '/v1/main-versions/{mainVersion}/package-release-recommendations': {
    get: { exposure: 'platform:developer-extras', bearer: true }, post: { exposure: 'platform:developer-extras', bearer: true, idempotencyKey: true },
  },
  '/v1/main-versions/{mainVersion}/package-release-recommendations/{revision}': { get: { exposure: 'platform:developer-extras', bearer: true } },
  '/v1/package-install-requests': { post: { exposure: 'platform:developer-extras', bearer: true, idempotencyKey: true } },
} as const;

const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'cache-control': 'no-store' },
});
const missingKey = () => problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
const idempotencyKey = (request: Request) => {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
};
const resource = (uuid: string) => `https://rezics.com/id/${uuid}`;

function recommendationError(error: unknown): Response {
  if (error instanceof PackageRecommendationInvalid || error instanceof PackageInstallRequestInvalid) {
    return problem(422, 'package_recommendation_invalid', error.message);
  }
  if (error instanceof PackageRecommendationStale || error instanceof PackageRecommendationConflict) {
    return problem(409, 'package_recommendation_conflict', error.message);
  }
  if (error instanceof PackageRecommendationUnavailable || error instanceof PackageInstallRequestUnavailable) {
    return problem(503, 'package_recommendation_unavailable', error.message);
  }
  if (error instanceof AdmissionDenied) return problem(403, 'authority_denied', error.message);
  return commandError(error);
}

/** Main Version recommendation edits and resolution-backed package install requests. */
export function packageInstallRequestRoutes(work: MainWorkDependencies) {
  const recommendationPath = '/v1/main-versions/:mainVersion/package-release-recommendations';
  const principal = async (request: Request, scopes: readonly string[]) => {
    const verified = await work.account.verify(request, scopes);
    return { verified, id: await work.access.activePrincipalId(verified) };
  };
  const readableRecommendations = async (request: Request, mainVersion: string,
    revision?: string, actingSubject?: string) => {
    const caller = await principal(request, ['work:read']);
    if (!caller.id || !actingSubject) return null;
    const state = await readMainPackageRecommendations(work.environment, mainVersion,
      revision === undefined ? undefined : resource(revision));
    if (!await work.access.canReadWork(caller.verified, actingSubject, state.work)) return null;
    return state;
  };
  const readResponse = (state: Awaited<ReturnType<typeof readMainPackageRecommendations>>) => ({
    profile: 'main-package-release-recommendation-v1' as const,
    ...state,
  });
  const query = t.Object({ actingSubject: groupAgent }, { additionalProperties: false });
  return new Elysia()
    .post(recommendationPath, {
      params: t.Object({ mainVersion: groupUuid }),
      body: t.Object({ profile: t.Literal('main-package-release-recommendation-v1'),
        work: nativeId('Work'), expectedRevision: t.Nullable(nativeId('expected revision')),
        recommendations: t.Array(recommendation, { maxItems: 16 }), actingSubject: groupAgent },
      { additionalProperties: false }),
      response: { 200: recommendationWrite, 201: recommendationWrite, 202: problemResult(202),
        ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, params, body }) => {
      const key = idempotencyKey(request);
      if (!key) return missingKey();
      try {
        const result = await setAdmittedMainPackageRecommendations(work.environment, work.account,
          work.access, request, { work: body.work, mainVersion: resource(params.mainVersion),
            expectedRevision: body.expectedRevision, recommendations: body.recommendations as PackageReleaseRecommendation[],
            actingSubject: body.actingSubject, idempotencyKey: key });
        const state = readResponse(await readMainPackageRecommendations(work.environment,
          result.mainVersion, result.revision ?? undefined));
        return json({ ...state, receipt: result.receipt,
          replayed: result.replayed }, result.replayed ? 200 : 201);
      } catch (error) { return recommendationError(error); }
    })
    .get(recommendationPath, {
      params: t.Object({ mainVersion: groupUuid }), query,
      response: { 200: recommendationSet, ...authorizedReadProblems },
    }, async ({ request, params, query: filter }) => {
      try {
        const state = await readableRecommendations(request, resource(params.mainVersion), undefined, filter.actingSubject);
        return state ? json(readResponse(state)) : problem(404, 'work_unavailable', 'Work is unavailable');
      } catch (error) { return recommendationError(error); }
    })
    .get(`${recommendationPath}/:revision`, {
      params: t.Object({ mainVersion: groupUuid, revision: groupUuid }), query,
      response: { 200: recommendationSet, ...authorizedReadProblems },
    }, async ({ request, params, query: filter }) => {
      try {
        const state = await readableRecommendations(request, resource(params.mainVersion),
          params.revision, filter.actingSubject);
        return state ? json(readResponse(state)) : problem(404, 'revision_unavailable', 'Revision is unavailable');
      } catch (error) { return recommendationError(error); }
    })
    .post('/v1/package-install-requests', {
      body: installRequest,
      response: { 200: installResult, 201: installResult, 202: problemResult(202),
        ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (!key) return missingKey();
      try {
        const caller = await principal(request, ['package:resolve', 'work:read']);
        if (!caller.id) return problem(403, 'authority_denied', 'Package principal is inactive');
        const state = await readMainPackageRecommendations(work.environment, body.mainVersion,
          body.recommendationRevision);
        if (!await work.access.canReadWork(caller.verified, body.actingSubject, state.work)) {
          return problem(404, 'work_unavailable', 'Main Version is unavailable');
        }
        const result = await resolveMainVersionInstallRequest(work, caller.id, key, {
          mainVersion: body.mainVersion, recommendationRevision: body.recommendationRevision,
          environment: body.environment as PackageInstallEnvironment,
          ...(body.cargoIndexFiles ? { cargoIndexFiles: body.cargoIndexFiles } : {}),
          ...(body.cargoArtifacts ? { cargoArtifacts: body.cargoArtifacts } : {}),
        });
        return json(result, result.status === 'resolved' ? (result.replayed ? 200 : 201) : 200);
      } catch (error) { return recommendationError(error); }
    });
}
