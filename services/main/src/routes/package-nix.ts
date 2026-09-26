import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { NixResolutionConflict, NixResolutionInvalid, NixResolutionUnavailable }
  from '../modules/package/nix-graph.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

const requestSchema = t.Object({
  profile: t.Literal('nix-flake-native-v1'),
  system: t.Literal('x86_64-linux'),
  package: t.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_-]*$' }),
  flakeNix: t.String({ maxLength: 65_536 }),
  flakeLock: t.String({ maxLength: 65_536 }),
  files: t.Array(t.Object({ path: t.String({ minLength: 1, maxLength: 160 }),
    text: t.String({ maxLength: 65_536 }) }, { additionalProperties: false }),
  { maxItems: 16 }),
  runtime: t.Union([t.Literal('observe'), t.Literal('unobserved')]),
}, { additionalProperties: false });
const inputNode = t.Object({ id: t.String(),
  original: t.Nullable(t.Object({}, { additionalProperties: true })),
  locked: t.Nullable(t.Object({}, { additionalProperties: true })),
  sourceHash: t.Nullable(t.String()) });
const inputEdge = t.Object({ from: t.String(), name: t.String(),
  to: t.Union([t.String(), t.Array(t.String())]) });
const inputGraph = t.Object({ root: t.String(), nodes: t.Array(inputNode),
  edges: t.Array(inputEdge) });
const derivationNode = t.Object({ drvPath: t.String(), system: t.String(),
  outputs: t.Array(t.Object({ name: t.String(), path: t.String() })),
  sourcePaths: t.Array(t.String()) });
const derivationEdge = t.Object({ from: t.String(), to: t.String(),
  outputs: t.Array(t.String()) });
const derivationGraph = t.Object({ selectedDrvPath: t.String(),
  nodes: t.Array(derivationNode), edges: t.Array(derivationEdge) });
const runtimeClosure = t.Object({
  status: t.Union([t.Literal('observed'), t.Literal('unobserved')]),
  outputPath: t.Nullable(t.String()),
  paths: t.Array(t.Object({ path: t.String(), narHash: t.String(),
    references: t.Array(t.String()) })),
});
const outcomeSchema = t.Object({
  status: t.Union([t.Literal('observed'), t.Literal('derivation-only'),
    t.Literal('evaluation-failed'), t.Literal('build-failed'),
    t.Literal('closure-unavailable'), t.Literal('source-hash-unobserved'),
    t.Literal('budget-exhausted')]),
  failure: t.Nullable(t.Union([t.Literal('stale-lock'), t.Literal('source-hash-mismatch'),
    t.Literal('native-error'), t.Literal('timeout')])),
  evaluator: t.Object({ version: t.String(), image: t.String(),
    system: t.Literal('x86_64-linux'), network: t.Literal('none') }),
  inputGraph, derivationGraph: t.Nullable(derivationGraph), runtimeClosure,
  work: t.Object({ inputNodes: t.Number(), inputEdges: t.Number(),
    derivations: t.Number(), buildEdges: t.Number(), closurePaths: t.Number(),
    nativeRuns: t.Number() }),
});
const resolutionSchema = t.Object({ profile: t.Literal('nix-flake-native-receipt-v1'),
  resolution: t.String(), requestDigest: t.String(), request: requestSchema,
  outcome: outcomeSchema, createdAt: t.String() });
const writeSchema = t.Object({ resolution: resolutionSchema, replayed: t.Boolean() });

export const openApiOperations = {
  '/v1/package-resolutions/nix': { post: { bearer: true, idempotencyKey: true } },
  '/v1/package-resolutions/nix/{resolution}': { get: { bearer: true } },
};

function nixError(error: unknown): Response {
  if (error instanceof NixResolutionInvalid) return problem(422, 'nix_resolution_invalid', error.message);
  if (error instanceof NixResolutionConflict) return problem(409, 'nix_resolution_conflict',
    'Nix key binds another request');
  if (error instanceof NixResolutionUnavailable) return problem(503, 'nix_resolution_unavailable',
    'Nix resolution evidence is unavailable');
  return commandError(error);
}

export function packageNixRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/package-resolutions/nix', {
      body: requestSchema,
      response: { 200: writeSchema, 201: writeSchema, ...writeProblems,
        422: problemResult(422) },
    }, async ({ request, body }) => {
      try {
        if (!work.packageNixResolutions) return problem(503, 'nix_resolution_unavailable',
          'Nix resolution owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['package:resolve']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageNixResolutions.resolve(principalId, key, body);
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return nixError(error); }
    })
    .get('/v1/package-resolutions/nix/:resolution', {
      params: t.Object({ resolution: groupUuid }),
      response: { 200: resolutionSchema, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.packageNixResolutions) return problem(503, 'nix_resolution_unavailable',
          'Nix resolution owner is unavailable');
        const principal = await work.account.verify(request, ['package:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageNixResolutions.read(principalId, params.resolution);
        if (!result) return problem(404, 'nix_resolution_unavailable',
          'Nix resolution is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return nixError(error); }
    });
}
