import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { writeProblems, authorizedReadProblems } from '../api-responses.ts';
import { ConnectedAppConflict, ConnectedAppDenied, ConnectedAppInvalid, ConnectedAppStale,
  ConnectedAppUnavailable, connectedAppRequestDigest, isDefiniteMcpProtocolFailure,
  invocationProtocolError, isMcpToolError, validMcpToolResult } from '../modules/connected-apps/store.ts';
import { McpCancelled, McpHttpError, McpProtocolError, validateEndpoint } from '../modules/connected-apps/protocol.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from '../modules/account/verify-assertion.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

export const openApiOperations = {
  '/v1/connected-apps/observations': { post: { exposure: 'platform:agent-mode', bearer: true, idempotencyKey: true } },
  '/v1/connected-apps/consent-ceilings': { post: { exposure: 'platform:agent-mode', bearer: true, idempotencyKey: true } },
  '/v1/connected-apps/invocations': { post: { exposure: 'platform:agent-mode', bearer: true, idempotencyKey: true } },
  '/v1/connected-apps/invocations/{invocation}': { get: { exposure: 'platform:agent-mode', bearer: true } },
} as const;

const sha = t.String({ pattern: '^[0-9a-f]{64}$' });
const timestamp = t.String({ format: 'date-time' });
const jsonObject = t.Record(t.String(), t.Unknown());
const observationView = t.Object({
  observation: groupUuid, endpoint: t.String(), protocolVersion: t.String(), serverInfo: jsonObject,
  capabilities: jsonObject, snapshotSha256: sha, pageCount: t.Integer(), toolCount: t.Integer(),
  predecessor: t.Nullable(groupUuid), drift: t.Union([t.Literal('initial'), t.Literal('unchanged'), t.Literal('changed')]),
  observedAt: timestamp, tools: t.Array(t.Object({ name: t.String(), definition: jsonObject,
    definitionSha256: sha, schemaValidation: t.Union([t.Literal('valid'), t.Literal('invalid'),
      t.Literal('unsupported')]), pageNumber: t.Integer() })) });
const ceilingView = t.Object({ ceiling: groupUuid, observation: groupUuid, endpoint: t.String(), resource: t.String(),
  consentId: t.String(), consentGeneration: groupUuid, tools: t.Array(t.Object({ name: t.String(), definitionSha256: sha })),
  createdAt: timestamp });
const invocationView = t.Object({ invocation: groupUuid, ceiling: groupUuid, observation: groupUuid,
  toolName: t.String(), definitionSha256: sha, argumentsSha256: sha,
  state: t.Union(['admitted', 'sent', 'completed', 'tool-error', 'protocol-error', 'cancel-requested',
    'cancelled', 'uncertain'].map(value => t.Literal(value))), resultSha256: t.Nullable(sha),
  protocolError: t.Nullable(jsonObject), createdAt: timestamp, updatedAt: timestamp, replayed: t.Boolean(),
  result: t.Optional(t.Nullable(jsonObject)) });

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get('idempotency-key');
  return value && /^[A-Za-z0-9:_./-]{1,128}$/.test(value) ? value : null;
}

function currentConsent(verified: Awaited<ReturnType<MainWorkDependencies['account']['verify']>>) {
  if (verified.accountAuthMode !== 'consent' || !verified.accountClientId || !verified.accountConsentId
    || !verified.accountConsentGeneration) {
    throw new ConnectedAppDenied('A current explicit Account consent is required');
  }
  return { clientId: verified.accountClientId, consentId: verified.accountConsentId,
    generation: verified.accountConsentGeneration, audiences: verified.accountAudiences ?? [],
    scopes: verified.accountScopes ?? [] };
}

function bearerFor(request: Request, audiences: readonly string[], resource: string): string | undefined {
  if (!audiences.includes(resource)) return undefined;
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
  return match?.[1];
}

function connectedAppError(error: unknown): Response {
  if (error instanceof AccountAssertionDenied) return problem(401, 'invalid_account_assertion', 'Account assertion is invalid');
  if (error instanceof AccountAssertionUnavailable) return problem(503, 'account_unavailable', 'Account enforcement is unavailable');
  if (error instanceof ConnectedAppInvalid) return problem(422, 'connected_app_request_invalid', error.message);
  if (error instanceof ConnectedAppDenied) return problem(403, 'connected_app_authority_denied', error.message);
  if (error instanceof ConnectedAppStale) return problem(409, 'connected_app_stale', error.message);
  if (error instanceof ConnectedAppConflict) return problem(409, 'connected_app_conflict', error.message);
  if (error instanceof ConnectedAppUnavailable) return problem(503, 'connected_app_unavailable', error.message,
    { 'retry-after': '1' });
  if (error instanceof McpHttpError) return error.status >= 500
    ? problem(503, 'connected_app_unavailable', 'MCP server is unavailable', { 'retry-after': '1' })
    : problem(502, 'connected_app_protocol_error', 'MCP server rejected or malformed the request');
  if (error instanceof McpProtocolError) {
    return problem(502, 'connected_app_protocol_error', 'MCP server response is invalid');
  }
  if (error instanceof McpCancelled) return problem(503, 'connected_app_unavailable', 'MCP request was cancelled');
  return commandError(error);
}

/** MCP tool observations, immutable Account ceilings and bounded local/remote tool calls. */
export function connectedAppRoutes(work: MainWorkDependencies) {
  const account = work.account;
  const access = work.access;
  const store = work.connectedApps;
  const unavailable = () => problem(503, 'connected_app_owner_unavailable', 'Connected-app owner is unavailable');
  const missingKey = () => problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
  const principal = async (request: Request, scope: string) => {
    const verified = await account.verify(request, [scope]);
    const id = await access.activePrincipalId(verified);
    if (!id) throw new ConnectedAppDenied('Connected-app principal is inactive');
    return { verified, id };
  };
  return new Elysia()
    .post('/v1/connected-apps/observations', {
      body: t.Object({ profile: t.Literal('connected-app-observation-v1'), endpoint: t.String({ minLength: 1, maxLength: 2048 }) },
        { additionalProperties: false }),
      response: { 200: t.Object({ ...observationView.properties, replayed: t.Boolean() }),
        201: t.Object({ ...observationView.properties, replayed: t.Boolean() }), ...writeProblems,
        404: problemResult(404), 422: problemResult(422), 502: problemResult(502) },
    }, async ({ request, body }) => {
      try {
        if (!store) return unavailable();
        const key = idempotencyKey(request);
        if (!key) return missingKey();
        const caller = await principal(request, 'connected-app:observe');
        const endpoint = validateEndpoint(body.endpoint);
        const credential = bearerFor(request, caller.verified.accountAudiences ?? [], endpoint.origin);
        const result = await store.observe(caller.id, key, endpoint.toString(), credential, request.signal);
        return json({ ...result.value, replayed: result.replayed }, result.replayed || result.value.drift === 'unchanged' ? 200 : 201);
      } catch (error) { return connectedAppError(error); }
    })
    .post('/v1/connected-apps/consent-ceilings', {
      body: t.Object({ profile: t.Literal('connected-app-consent-ceiling-v1'), observation: groupUuid,
        resource: t.String({ minLength: 1, maxLength: 2048 }),
        tools: t.Array(t.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 1024 }) },
      { additionalProperties: false }),
      response: { 200: t.Object({ ...ceilingView.properties, replayed: t.Boolean() }),
        201: t.Object({ ...ceilingView.properties, replayed: t.Boolean() }), ...writeProblems,
        404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, body }) => {
      try {
        if (!store) return unavailable();
        const key = idempotencyKey(request);
        if (!key) return missingKey();
        const caller = await principal(request, 'connected-app:consent');
        const basis = currentConsent(caller.verified);
        const result = await store.createCeiling(caller.id, key, body, basis);
        return json({ ...result.value, replayed: result.replayed }, result.replayed ? 200 : 201);
      } catch (error) { return connectedAppError(error); }
    })
    .post('/v1/connected-apps/invocations', {
      body: t.Object({ profile: t.Literal('connected-app-invocation-v1'), ceiling: groupUuid,
        toolName: t.String({ pattern: '^[A-Za-z0-9_.-]{1,128}$' }), arguments: jsonObject },
      { additionalProperties: false }),
      response: { 200: invocationView, 201: invocationView, 202: invocationView,
        502: t.Union([invocationView, problemResult(502)]), ...writeProblems,
        404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, body }) => {
      try {
        if (!store) return unavailable();
        const key = idempotencyKey(request);
        if (!key) return missingKey();
        const caller = await principal(request, 'connected-app:invoke');
        const basis = currentConsent(caller.verified);
        const intent = { ceiling: body.ceiling, toolName: body.toolName, arguments: body.arguments };
        const requestDigest = connectedAppRequestDigest(intent);
        const prior = await store.readInvocationByKey(caller.id, key, requestDigest, basis);
        if (prior && prior.state !== 'admitted') {
          return json({ ...prior, result: null }, prior.state === 'sent' || prior.state === 'cancel-requested' ? 202 : 200);
        }
        const ceiling = await store.getInvocationCeiling(caller.id, body.ceiling, basis);
        if (!ceiling) return problem(404, 'connected_app_ceiling_unavailable', 'MCP consent ceiling is unavailable');
        const token = bearerFor(request, basis.audiences, ceiling.resource);
        if (!token) throw new ConnectedAppDenied('Account token is not intended for this MCP resource');
        // Serialize observations, consent checks and dispatch for this endpoint.
        // A drift recorded while one invocation is in flight applies to the next one.
        return await store.withEndpointLock(caller.id, ceiling.endpoint, async lock => {
          const refreshed = await account.verify(request, ['connected-app:invoke']);
          const refreshedBasis = currentConsent(refreshed);
          if (refreshedBasis.clientId !== basis.clientId || refreshedBasis.consentId !== basis.consentId
            || refreshedBasis.generation !== basis.generation || !refreshedBasis.audiences.includes(ceiling.resource)
            || refreshedBasis.generation !== ceiling.consentGeneration
            || refreshedBasis.consentId !== ceiling.consentId) {
            throw new ConnectedAppStale('Account consent changed before MCP dispatch');
          }
          const auth = bearerFor(request, refreshedBasis.audiences, ceiling.resource);
          const observed = await store.observe(caller.id, `preflight-${crypto.randomUUID()}`,
            ceiling.endpoint, auth, request.signal, lock);
          if (observed.value.drift === 'changed') {
            throw new ConnectedAppStale('MCP tool schema or capabilities changed; renewed Account consent is required');
          }
          const admitted = await store.beginInvocation(caller.id, key, intent, refreshedBasis);
          if (admitted.value.state !== 'admitted') return json({ ...admitted.value, result: null }, 200);
          if (!await store.claimDispatch(admitted.value.invocation)) {
            const current = await store.readInvocation(caller.id, admitted.value.invocation);
            return json({ ...current!, result: null }, 200);
          }
          try {
            const outcome = await store.invoke(ceiling.endpoint, token, body.toolName, body.arguments,
              request.signal, () => store.markCancelRequested(admitted.value.invocation));
            if (!validMcpToolResult(outcome.result)) {
              const protocolError = { code: -32603, message: 'MCP tool result is malformed' };
              const receipt = await store.finishInvocation(admitted.value.invocation,
                { state: 'protocol-error', protocolError });
              return json({ ...receipt, result: null }, 502);
            }
            const state = isMcpToolError(outcome.result) ? 'tool-error' : 'completed';
            const receipt = await store.finishInvocation(admitted.value.invocation,
              { state, resultSha256: outcome.responseSha256 });
            return json({ ...receipt, result: outcome.result }, 201);
          } catch (error) {
            if (error instanceof McpCancelled) {
              const receipt = await store.finishInvocation(admitted.value.invocation, { state: 'uncertain' });
              return json({ ...receipt, result: null }, 202);
            }
            if (isDefiniteMcpProtocolFailure(error)) {
              const protocolError = invocationProtocolError(error);
              const receipt = await store.finishInvocation(admitted.value.invocation,
                { state: 'protocol-error', protocolError });
              return json({ ...receipt, result: null }, 502);
            }
            const receipt = await store.finishInvocation(admitted.value.invocation, { state: 'uncertain' });
            return json({ ...receipt, result: null }, 202);
          }
        });
      } catch (error) { return connectedAppError(error); }
    })
    .get('/v1/connected-apps/invocations/:invocation', {
      params: t.Object({ invocation: groupUuid }),
      response: { 200: invocationView, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!store) return unavailable();
        const caller = await principal(request, 'connected-app:read');
        const result = await store.readInvocation(caller.id, params.invocation);
        return result ? json({ ...result, result: null })
          : problem(404, 'connected_app_invocation_unavailable', 'MCP invocation is unavailable');
      } catch (error) { return connectedAppError(error); }
    });
}
