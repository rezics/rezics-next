import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { PackageInstallConflict, PackageInstallDenied, PackageInstallInvalid, PackageInstallStale,
  PackageInstallUnavailable, type PackageInstallationStore } from '../modules/package/install.ts';
import { PackageArtifactConflict, PackageArtifactInvalid, PackageArtifactUnavailable }
  from '../modules/package/lock-artifacts.ts';
import { PackageLockConflict, PackageLockInvalid, PackageLockUnavailable, type PackageLockStore }
  from '../modules/package/lock.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

declare module './dependencies.ts' {
  interface MainWorkDependencies {
    /** Exact package locks, replays and the artifact store (`modules/package/lock.ts`). */
    packageLocks?: PackageLockStore;
    /** Controlled local installations (`modules/package/install.ts`). */
    packageInstallations?: PackageInstallationStore;
  }
}

const sha256 = t.String({ pattern: '^[0-9a-f]{64}$' });
const lockRequest = t.Object({ profile: t.Literal('rezics-package-lock-v1'),
  segments: t.Array(t.Object({ ecosystem: t.Literal('npm'), resolution: groupUuid,
    scope: t.Object({ kind: t.Union([t.Literal('process'), t.Literal('path'), t.Literal('abi')]),
      label: t.String({ pattern: '^[A-Za-z0-9:_./-]{1,128}$' }) }, { additionalProperties: false }) },
  { additionalProperties: false }), { minItems: 1, maxItems: 16 }) }, { additionalProperties: false });
const lockView = t.Object({ lock: t.String(), contractVersion: t.Literal('rezics-package-lock-v1'),
  lockSha256: sha256, manifest: t.Record(t.String(), t.Unknown()), createdAt: t.String() });
const replayView = t.Object({ replay: t.String(), lock: t.String(), lockSha256: sha256,
  policy: t.Literal('exact-artifact-replay-v1'),
  outcome: t.Union([t.Literal('verified'), t.Literal('unavailable')]),
  artifacts: t.Array(t.Object({ ordinal: t.Number(), instanceKey: t.String(), locator: t.String(),
    mutableReference: t.Nullable(t.String()),
    result: t.Union(['verified', 'digest-mismatch', 'unavailable', 'revoked', 'unverifiable']
      .map(value => t.Literal(value))),
    observedSha256: t.Nullable(sha256), observedByteLength: t.Nullable(t.Number()),
    artifact: t.Nullable(t.String()) })), createdAt: t.String() });
const installationView = t.Object({ installation: t.String(), target: t.String(),
  environment: t.Record(t.String(), t.Unknown()), state: t.Union([t.Literal('present'), t.Literal('removed')]),
  headEpoch: t.Number(), activeGeneration: t.Nullable(t.String()), generationsTruncated: t.Boolean(),
  claims: t.Array(t.Object({ path: t.String(), ownership: t.String() })),
  generations: t.Array(t.Object({ generation: t.String(), number: t.Number(), operation: t.String(),
    state: t.String(), terminalReason: t.Nullable(t.String()) })) });
const generationView = t.Object({ generation: t.String(), installation: t.String(), number: t.Number(),
  operation: t.String(), state: t.String(), terminalReason: t.Nullable(t.String()), lock: t.Nullable(t.String()),
  expectedGeneration: t.Nullable(t.String()), rollbackOf: t.Nullable(t.String()), planSha256: sha256,
  steps: t.Array(t.Object({ ordinal: t.Number(), action: t.String(), stepKey: t.String(),
    instanceKey: t.Nullable(t.String()), executesCode: t.Boolean(), idempotent: t.Boolean(),
    approved: t.Boolean(), lastEvent: t.Nullable(t.String()) })),
  paths: t.Array(t.Object({ path: t.String(), kind: t.String(), ownership: t.String() })),
  createdAt: t.String(), updatedAt: t.String() });
const write = (result: ReturnType<typeof t.Object>) => ({ 200: result, 201: result, ...writeProblems,
  404: problemResult(404), 422: problemResult(422) });
const confined = t.String({ minLength: 1, maxLength: 1024 });

function packageError(error: unknown): Response {
  if (error instanceof PackageLockInvalid || error instanceof PackageInstallInvalid
    || error instanceof PackageArtifactInvalid) return problem(422, 'package_request_invalid', error.message);
  if (error instanceof PackageLockConflict || error instanceof PackageInstallConflict
    || error instanceof PackageArtifactConflict) return problem(409, 'package_conflict', error.message);
  if (error instanceof PackageInstallStale) return problem(409, 'stale_generation', error.message);
  if (error instanceof PackageLockUnavailable || error instanceof PackageInstallUnavailable) {
    return problem(404, 'package_unavailable', error.message);
  }
  if (error instanceof PackageArtifactUnavailable) return problem(503, 'artifact_unavailable', error.message);
  if (error instanceof PackageInstallDenied) return problem(403, 'authority_denied', error.message);
  return commandError(error);
}

const json = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { 'cache-control': 'no-store' } });

/**
 * Exact locks, replays, artifact revocation and controlled installations.
 * Every operation requires an active Access principal; another principal's
 * lock, replay or installation is 404.
 */
export function packageLockRoutes(work: MainWorkDependencies) {
  const principal = async (request: Request, scope: string) => {
    const verified = await work.account.verify(request, [scope]);
    return { verified, id: await work.access.activePrincipalId(verified) };
  };
  const key = (request: Request) => {
    const value = request.headers.get('idempotency-key');
    return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
  };
  const locks = () => work.packageLocks ?? null;
  const installs = () => work.packageInstallations ?? null;
  const unavailable = () => problem(503, 'package_owner_unavailable', 'Package lock owner is unavailable');
  const inactive = () => problem(403, 'authority_denied', 'Package principal is inactive');
  const missingKey = () => problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
  return new Elysia()
    .post('/v1/package-locks', { body: lockRequest, response: write(lockView) }, async ({ request, body }) => {
      try {
        const store = locks();
        if (!store) return unavailable();
        const idempotency = key(request);
        if (!idempotency) return missingKey();
        const caller = await principal(request, 'package:resolve');
        if (!caller.id) return inactive();
        const result = await store.create(caller.id, idempotency, body);
        return json(result.lock, result.replayed ? 200 : 201);
      } catch (error) { return packageError(error); }
    })
    .get('/v1/package-locks/:lock', { params: t.Object({ lock: groupUuid }),
      response: { 200: lockView, ...authorizedReadProblems } }, async ({ request, params }) => {
      try {
        const store = locks();
        if (!store) return unavailable();
        const caller = await principal(request, 'package:read');
        if (!caller.id) return inactive();
        const result = await store.read(caller.id, params.lock);
        return result ? json(result) : problem(404, 'package_unavailable', 'Lock is unavailable');
      } catch (error) { return packageError(error); }
    })
    .post('/v1/package-locks/:lock/replays', { params: t.Object({ lock: groupUuid }),
      response: write(replayView) }, async ({ request, params }) => {
      try {
        const store = locks();
        if (!store) return unavailable();
        const idempotency = key(request);
        if (!idempotency) return missingKey();
        const caller = await principal(request, 'package:verify');
        if (!caller.id) return inactive();
        const result = await store.replay(caller.id, idempotency, params.lock);
        return json(result.replay, result.replayed ? 200 : 201);
      } catch (error) { return packageError(error); }
    })
    .get('/v1/package-lock-replays/:replay', { params: t.Object({ replay: groupUuid }),
      response: { 200: replayView, ...authorizedReadProblems } }, async ({ request, params }) => {
      try {
        const store = locks();
        if (!store) return unavailable();
        const caller = await principal(request, 'package:read');
        if (!caller.id) return inactive();
        const result = await store.readReplay(caller.id, params.replay);
        return result ? json(result) : problem(404, 'package_unavailable', 'Replay is unavailable');
      } catch (error) { return packageError(error); }
    })
    .post('/v1/package-artifacts/revocations', {
      body: t.Object({ sha256, reason: t.Union(['malicious', 'integrity', 'rights', 'provider-withdrawn',
        'policy'].map(value => t.Literal(value))) as never,
      basis: t.Record(t.String(), t.Unknown()) }, { additionalProperties: false }),
      response: write(t.Object({ revocation: t.String(), sha256, reason: t.String(),
        basis: t.Record(t.String(), t.Unknown()), createdAt: t.String() })),
    }, async ({ request, body }) => {
      try {
        const store = locks();
        if (!store) return unavailable();
        const idempotency = key(request);
        if (!idempotency) return missingKey();
        const caller = await principal(request, 'package:revoke');
        if (!caller.id) return inactive();
        const result = await store.artifacts.revoke(caller.id, idempotency, body as never);
        return json(result.revocation, result.replayed ? 200 : 201);
      } catch (error) { return packageError(error); }
    })
    .post('/v1/package-installations', {
      body: t.Object({ profile: t.Literal('rezics-controlled-install-v1'),
        target: t.String({ pattern: '^[A-Za-z0-9:_./-]{1,256}$' }),
        environment: t.Object({ os: t.Literal('linux'), cpu: t.Union([t.Literal('x64'), t.Literal('arm64')]) },
          { additionalProperties: false }) }, { additionalProperties: false }),
      response: write(installationView),
    }, async ({ request, body }) => {
      try {
        const store = installs();
        if (!store) return unavailable();
        const idempotency = key(request);
        if (!idempotency) return missingKey();
        const caller = await principal(request, 'package:install');
        if (!caller.id) return inactive();
        const result = await store.createInstallation(caller.id, idempotency, body);
        return json(result.installation, result.replayed ? 200 : 201);
      } catch (error) { return packageError(error); }
    })
    .get('/v1/package-installations/:installation', { params: t.Object({ installation: groupUuid }),
      response: { 200: installationView, ...authorizedReadProblems } }, async ({ request, params }) => {
      try {
        const store = installs();
        if (!store) return unavailable();
        const caller = await principal(request, 'package:read');
        if (!caller.id) return inactive();
        const result = await store.read(caller.id, params.installation);
        return result ? json(result) : problem(404, 'package_unavailable', 'Installation is unavailable');
      } catch (error) { return packageError(error); }
    })
    .post('/v1/package-installations/:installation/generations', {
      params: t.Object({ installation: groupUuid }),
      body: t.Object({ operation: t.Union([t.Literal('install'), t.Literal('update'), t.Literal('rollback'),
        t.Literal('remove')]), lock: t.Nullable(groupUuid), rollbackOf: t.Nullable(groupUuid),
      expectedGeneration: t.Nullable(groupUuid),
      userData: t.Array(t.Object({ path: confined, kind: t.Union([t.Literal('file'), t.Literal('directory')]) },
        { additionalProperties: false }), { maxItems: 64 }),
      approveHooks: t.Array(t.String({ minLength: 1, maxLength: 1024 }), { maxItems: 256 }) },
      { additionalProperties: false }),
      response: write(t.Object({ generation: generationView, violations: t.Array(t.Record(t.String(),
        t.Unknown())) })),
    }, async ({ request, params, body }) => {
      try {
        const store = installs();
        if (!store) return unavailable();
        const idempotency = key(request);
        if (!idempotency) return missingKey();
        const caller = await principal(request, 'package:install');
        if (!caller.id) return inactive();
        const result = await store.plan(caller.id, params.installation, idempotency, body);
        return json({ generation: result.generation, violations: result.violations },
          result.replayed ? 200 : 201);
      } catch (error) { return packageError(error); }
    })
    .get('/v1/package-installations/:installation/generations/:generation', {
      params: t.Object({ installation: groupUuid, generation: groupUuid }),
      response: { 200: generationView, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        const store = installs();
        if (!store) return unavailable();
        const caller = await principal(request, 'package:read');
        if (!caller.id) return inactive();
        const result = await store.readGeneration(caller.id, params.installation, params.generation);
        return result ? json(result) : problem(404, 'package_unavailable', 'Generation is unavailable');
      } catch (error) { return packageError(error); }
    })
    .post('/v1/package-installations/:installation/generations/:generation/apply', {
      params: t.Object({ installation: groupUuid, generation: groupUuid }),
      response: { 200: generationView, ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, params }) => {
      try {
        const store = installs();
        if (!store) return unavailable();
        const caller = await principal(request, 'package:install');
        if (!caller.id) return inactive();
        // Authority is re-checked immediately before the visible switch.
        const fence = async () => (await work.access.activePrincipalId(caller.verified)) === caller.id;
        const result = await store.apply(caller.id, params.installation, params.generation, fence);
        return json(result.generation);
      } catch (error) { return packageError(error); }
    });
}
