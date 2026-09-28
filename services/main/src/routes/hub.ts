import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { HubDraftDenied, HubDraftStale, HubDraftUnavailable } from '../modules/hub/admitted.ts';
import { HubConflict, HubInvalid, HubUnavailable } from '../modules/hub/store.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';
import { readHubWorkPage } from '../modules/hub/work-page.ts';
import { workRead } from '../modules/work/read-session.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

export const openApiOperations = {
  '/v1/hub/works/{id}': { get: { bearer: false } },
  '/v1/hub/imports': { post: { bearer: true, idempotencyKey: true } },
  '/v1/hub/imports/{import}': { get: { bearer: true } },
  '/v1/prompts/revisions': { post: { bearer: true, idempotencyKey: true } },
  '/v1/prompts/revisions/{revision}': { get: { bearer: true } },
} as const;

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const variant = t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const language = t.Object({ kind: t.Literal('tag'), tag: t.String({ minLength: 2, maxLength: 35 }),
  originalTag: t.String({ minLength: 2, maxLength: 35 }) }, { additionalProperties: false });
const identity = { resourceId: native, variantId: variant, language,
  direction: t.Union([t.Literal('ltr'), t.Literal('rtl'), t.Literal('none')]),
  expectedHead: t.Nullable(groupUuid), actingSubject: native };
const importView = t.Object({ import: groupUuid, revision: groupUuid, variant,
  contentOperation: t.String(), contentEpoch: groupUuid, sourceTreeSha256: digest,
  name: t.String(), description: t.String(),
  files: t.Array(t.Object({ path: t.String(), file: groupUuid, sha256: digest, role: t.String(),
    executable: t.Boolean(), bytesBase64: t.String() })),
  missingRequirements: t.Array(t.String()), requirements: t.Array(t.Object({ ordinal: t.Integer(),
    ecosystem: t.String(), nativeSelector: t.String(), target: t.Record(t.String(), t.Unknown()),
    strength: t.Union([t.Literal('required'), t.Literal('optional')]),
    declaration: t.Union([t.Literal('declared'), t.Literal('missing'), t.Literal('unsupported')]),
    sourcePath: t.String(), sourcePointer: t.String() })), residuals: t.Array(t.String()), createdAt: t.String() });
const promptView = t.Object({ revision: groupUuid, variant, predecessor: t.Nullable(groupUuid),
  contentEpoch: groupUuid, content: t.String(), parameterSchema: t.Record(t.String(), t.Unknown()),
  examples: t.Array(t.Object({ parameters: t.Record(t.String(), t.Unknown()), output: t.String() })),
  applicability: t.Object({ models: t.Array(t.String()), tools: t.Array(t.String()) }),
  schemaSha256: digest, createdAt: t.String() });
const json = (value: unknown, status = 200) => Response.json(value,
  { status, headers: { 'cache-control': 'private, no-store' } });

function hubError(error: unknown): Response {
  if (error instanceof HubInvalid) return problem(422, 'hub_invalid', error.message);
  if (error instanceof HubConflict) return problem(409, 'hub_conflict', error.message);
  if (error instanceof HubDraftStale) return problem(409, 'stale_hub_head', error.message);
  if (error instanceof HubDraftDenied) return problem(403, 'hub_authority_denied', error.message);
  if (error instanceof HubUnavailable || error instanceof HubDraftUnavailable) {
    return problem(503, 'hub_unavailable', error.message);
  }
  return commandError(error);
}

export function hubRoutes(work: MainWorkDependencies) {
  const owner = () => work.hub ?? null;
  const unavailable = () => problem(503, 'hub_unavailable', 'Hub owner is unavailable');
  const key = (request: Request) => {
    const value = request.headers.get('idempotency-key');
    return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
  };
  return new Elysia()
    .get('/v1/hub/works/:id', { params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: t.Optional(native) }, { additionalProperties: false }),
      detail: { security: [{}, { bearerAuth: [] }] },
      response: { 200: t.Nullable(t.Object({ profile: t.Literal('hub-work-page-v1'),
        kind: t.Union([t.Literal('prompt'), t.Literal('skill')]), revision: groupUuid,
        content: t.String({ maxLength: 65_536 }), parameterSchema: t.Record(t.String(), t.Unknown()),
        examples: t.Array(t.Object({ parameters: t.Record(t.String(), t.Unknown()), output: t.String() })),
        declaredModels: t.Array(t.String()), testedModels: t.Array(t.String()),
        versions: t.Array(t.Object({ revision: groupUuid, createdAt: t.Nullable(t.String()) })),
        moreVersions: t.Boolean(), createdAt: t.String() })), ...workReadProblems } },
    async ({ request, params, query }) => {
      try {
        return Response.json(await workRead(work, request, { actingSubject: query.actingSubject },
          session => readHubWorkPage(session, `https://rezics.com/id/${params.id}`)),
        { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) { return workReadError(error); }
    })
    .post('/v1/hub/imports', { body: t.Object({ ...identity,
      profile: t.Literal('agent-skills-directory-import-v1'),
      sourceFormat: t.Literal('agent-skills-directory-v1'),
      sourceLocator: t.Object({ label: t.String({ minLength: 1, maxLength: 256 }) },
        { additionalProperties: false }),
      files: t.Array(t.Object({ path: t.String({ minLength: 1, maxLength: 1024 }),
        bytesBase64: t.String({ maxLength: 1_398_104 }), executable: t.Boolean() },
      { additionalProperties: false }), { minItems: 1, maxItems: 128 }),
    }, { additionalProperties: false }),
    response: { 200: importView, 201: importView, ...writeProblems, 422: problemResult(422) } },
    async ({ request, body }) => {
      try {
        const store = owner();
        if (!store) return unavailable();
        const idempotency = key(request);
        if (!idempotency) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
        const principal = await work.account.verify(request, ['work:edit']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'hub_authority_denied', 'Principal is inactive');
        const result = await store.importSkill(principal, principalId, idempotency, body);
        return json(result.value, result.replayed ? 200 : 201);
      } catch (error) { return hubError(error); }
    })
    .get('/v1/hub/imports/:import', { params: t.Object({ import: groupUuid }),
      query: t.Object({ actingSubject: native }, { additionalProperties: false }),
      response: { 200: importView, ...authorizedReadProblems } }, async ({ request, params, query }) => {
      try {
        const store = owner();
        if (!store) return unavailable();
        const principal = await work.account.verify(request, ['work:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'hub_authority_denied', 'Principal is inactive');
        const resource = await store.importResource(principalId, params.import);
        if (!resource || !await work.access.canReadWork(principal, query.actingSubject, resource)) {
          return problem(404, 'hub_import_unavailable', 'Skill import is unavailable');
        }
        const result = await store.readImport(principalId, params.import);
        return result ? json(result) : problem(404, 'hub_import_unavailable', 'Skill import is unavailable');
      } catch (error) { return hubError(error); }
    })
    .post('/v1/prompts/revisions', { body: t.Object({ ...identity,
      profile: t.Literal('rezics-prompt-revision-v1'),
      content: t.String({ minLength: 1, maxLength: 65_536 }),
      parameterSchema: t.Record(t.String(), t.Unknown()),
      examples: t.Array(t.Object({ parameters: t.Record(t.String(), t.Unknown()),
        output: t.String({ maxLength: 16_384 }) }, { additionalProperties: false }), { maxItems: 32 }),
      applicability: t.Object({ models: t.Array(t.String({ minLength: 1, maxLength: 200 }),
        { maxItems: 64 }), tools: t.Array(t.String({ minLength: 1, maxLength: 200 }), { maxItems: 64 }) },
      { additionalProperties: false }),
    }, { additionalProperties: false }),
    response: { 200: promptView, 201: promptView, ...writeProblems, 422: problemResult(422) } },
    async ({ request, body }) => {
      try {
        const store = owner();
        if (!store) return unavailable();
        const idempotency = key(request);
        if (!idempotency) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
        const principal = await work.account.verify(request, ['work:edit']);
        if (!await work.access.activePrincipalId(principal)) {
          return problem(403, 'hub_authority_denied', 'Principal is inactive');
        }
        const result = await store.revisePrompt(principal, idempotency, body);
        return json(result.value, result.replayed ? 200 : 201);
      } catch (error) { return hubError(error); }
    })
    .get('/v1/prompts/revisions/:revision', { params: t.Object({ revision: groupUuid }),
      query: t.Object({ actingSubject: native }, { additionalProperties: false }),
      response: { 200: promptView, ...authorizedReadProblems } }, async ({ request, params, query }) => {
      try {
        const store = owner();
        if (!store) return unavailable();
        const principal = await work.account.verify(request, ['work:read']);
        const resource = await store.promptResource(params.revision);
        if (!resource || !await work.access.canReadWork(principal, query.actingSubject, resource)) {
          return problem(404, 'hub_prompt_unavailable', 'Prompt revision is unavailable');
        }
        const result = await store.readPrompt(params.revision);
        return result ? json(result) : problem(404, 'hub_prompt_unavailable', 'Prompt revision is unavailable');
      } catch (error) { return hubError(error); }
    });
}
