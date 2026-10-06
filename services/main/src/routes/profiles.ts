import { Elysia, t } from 'elysia';
import { workRead, WorkReadLimit } from '../modules/work/read-session.ts';
import { pendingOperation } from '../api-contract.ts';
import { pageFields, pageQuery, readId, readPosition, readQuery, readUuid } from '../modules/work/read-contract.ts';
import { agentProfile, creditedWork, creditRole, libraryContribution, libraryRating,
  PROFILE_READ_COST, profileHandle, shelfCollection } from '../modules/profiles/read-contract.ts';
import { readAgent, readAgentCollections, readAgentWorks, readHandle } from '../modules/profiles/read.ts';
import { readMyContributions, readMyRatings } from '../modules/profiles/library.ts';
import { createNativeCredit, readNativeCredits } from '../modules/profiles/credits.ts';
import { ControlDenied, ControlUnavailable } from '../modules/access/topology-control.ts';
import { InvalidLibraryVisibility, LibraryVisibilityConflict, LibraryVisibilityDenied,
  LibraryVisibilityUnavailable, StaleLibraryVisibility } from '../modules/profiles/visibility.ts';
import { RevisionReadBudgetExceeded } from '../modules/work/history.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { resourceListing } from '../modules/realm-admin/contract.ts';
import { pageDiscovery } from '../modules/realm-reads/read-contract.ts';
import { pageDiscoveryHeaders } from '../modules/space/visibility.ts';
import { AgentListingConflict, AgentListingDenied, AgentListingUnavailable, InvalidAgentListing,
  StaleAgentListing } from '../modules/profiles/listing.ts';

const params = t.Object({ id: readUuid });
const detail: { security: Record<string, string[]>[] } = { security: [{}, { bearerAuth: [] }] };
const headers = { 'cache-control': 'private, no-store' };
const visibility = t.Union([t.Literal('public'), t.Literal('followers'), t.Literal('private')]);
const visibilityState = t.Object({ visibility, version: t.Integer({ minimum: 0 }),
  changedAt: t.Nullable(t.String()), replayed: t.Optional(t.Boolean()) });
function response(value: unknown, status = 200) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > PROFILE_READ_COST.responseBytes) throw new WorkReadLimit('Profile response exceeds budget');
  const discovery = (value && typeof value === 'object' && 'discovery' in value
    ? value.discovery as Parameters<typeof pageDiscoveryHeaders>[0] : null);
  return new Response(body, { status, headers: { ...headers, 'content-type': 'application/json',
    ...(discovery ? pageDiscoveryHeaders(discovery) : {}) } });
}
function readError(error: unknown) {
  if (error instanceof RevisionReadBudgetExceeded) error = new WorkReadLimit('Rating manifest read exceeds budget');
  const result = error instanceof ControlDenied ? problem(403, 'library_denied', 'Library authority is unavailable')
    : error instanceof LibraryVisibilityDenied || error instanceof AgentListingDenied ? problem(404, 'agent_unavailable', 'Agent unavailable')
    : error instanceof ControlUnavailable || error instanceof LibraryVisibilityUnavailable || error instanceof AgentListingUnavailable
      ? problem(503, 'profile_owner_unavailable', 'Profile owner is unavailable')
    : workReadError(error);
  result.headers.set('cache-control', 'private, no-store');
  return result;
}
export const openApiOperations = {
  '/v1/agents/{id}/listing': { get: { exposure: 'public', bearer: true }, put: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/agents/{id}': { get: { exposure: 'public', bearer: false } },
  '/v1/handles/{handle}': { get: { exposure: 'public', bearer: false } },
  '/v1/agents/{id}/works': { get: { exposure: 'public', bearer: false } },
  '/v1/agents/{id}/collections': { get: { exposure: 'public', bearer: false } },
  '/v1/agents/{id}/library-visibility': { get: { exposure: 'public', bearer: true },
    put: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/me/contributions': { get: { exposure: 'public', bearer: true } },
  '/v1/me/ratings': { get: { exposure: 'public', bearer: true } },
  '/v1/works/{id}/agent-credits': { get: { exposure: 'public', bearer: false }, post: { exposure: 'public', bearer: true, idempotencyKey: true } },
} as const;

export function profileRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/agents/:id/listing', { params,
      response: { 200: listingState, ...workReadProblems },
    }, async ({ request, params: path }) => {
      if (!work.profiles) return problem(503, 'profile_owner_unavailable', 'Profile owner unavailable');
      try {
        const principal = await work.account.verify(request, ['agent:create']);
        return response(await work.profiles.listing.readForOwner(principal, `https://rezics.com/id/${path.id}`));
      } catch (error) { return listingError(error); }
    })
    .put('/v1/agents/:id/listing', { params,
      body: t.Object({ listing: resourceListing, expectedVersion: t.Integer({ minimum: 0 }) }, { additionalProperties: false }),
      response: { 200: listingState, ...workReadProblems },
    }, async ({ request, params: path, body }) => {
      if (!work.profiles) return problem(503, 'profile_owner_unavailable', 'Profile owner unavailable');
      try {
        const principal = await work.account.verify(request, ['agent:create']);
        return response(await work.profiles.listing.write(principal, `https://rezics.com/id/${path.id}`,
          body.listing, body.expectedVersion, request.headers.get('idempotency-key') ?? ''));
      } catch (error) { return listingError(error); }
    })
    .get('/v1/agents/:id', { params, detail,
      query: t.Object(readQuery, { additionalProperties: false }),
      response: { 200: agentProfile, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return response(await workRead(work, request, query, s => readAgent(s, `https://rezics.com/id/${path.id}`))); }
      catch (error) { return readError(error); }
    })
    .get('/v1/handles/:handle', { params: t.Object({ handle: t.String({ minLength: 1, maxLength: 64 }) }), detail,
      query: t.Object(readQuery, { additionalProperties: false }),
      response: { 200: agentProfile, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return response(await workRead(work, request, query, s => readHandle(s, path.handle))); }
      catch (error) { return readError(error); }
    })
    .get('/v1/agents/:id/works', { params, detail, query: t.Object({ ...pageQuery,
      context: t.Optional(readId) }, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(creditedWork, { maxItems: 20 }),
        listing: resourceListing, discovery: pageDiscovery, ...pageFields }), ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return response(await workRead(work, request, query,
        s => readAgentWorks(s, `https://rezics.com/id/${path.id}`, query.context))); }
      catch (error) { return readError(error); }
    })
    .get('/v1/agents/:id/collections', { params, detail, query: t.Object(pageQuery, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(shelfCollection, { maxItems: 20 }),
        listing: resourceListing, discovery: pageDiscovery, ...pageFields }), ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return response(await workRead(work, request, query,
        s => readAgentCollections(s, `https://rezics.com/id/${path.id}`))); }
      catch (error) { return readError(error); }
    })
    .get('/v1/agents/:id/library-visibility', { params,
      response: { 200: visibilityState, ...workReadProblems },
    }, async ({ request, params: path }) => {
      if (!work.profiles) return problem(503, 'profile_owner_unavailable', 'Profile owner unavailable');
      const agent = `https://rezics.com/id/${path.id}`;
      try {
        const principal = await work.account.verify(request, ['agent:create']);
        return response(await work.profiles.visibility.readForOwner(principal, agent));
      } catch (error) { return visibilityError(error); }
    })
    .put('/v1/agents/:id/library-visibility', { params,
      body: t.Object({ visibility, expectedVersion: t.Integer({ minimum: 0 }) },
        { additionalProperties: false }),
      response: { 200: visibilityState, ...workReadProblems },
    }, async ({ request, params: path, body }) => {
      if (!work.profiles) return problem(503, 'profile_owner_unavailable', 'Profile owner unavailable');
      try {
        const principal = await work.account.verify(request, ['agent:create']);
        const result = await work.profiles.visibility.write(principal,
          `https://rezics.com/id/${path.id}`, body.visibility, body.expectedVersion,
          request.headers.get('idempotency-key') ?? '');
        return response(result);
      } catch (error) { return visibilityError(error); }
    })
    .get('/v1/me/contributions', { query: t.Object(pageQuery, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(libraryContribution, { maxItems: 20 }),
        listing: resourceListing, discovery: pageDiscovery, ...pageFields }), ...workReadProblems },
    }, async ({ request, query }) => {
      try { return response(await workRead(work, request, query, readMyContributions)); }
      catch (error) { return readError(error); }
    })
    .get('/v1/me/ratings', { query: t.Object({ ...pageQuery, scope: t.Optional(t.Literal('global')) }, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(libraryRating, { maxItems: 20 }),
        listing: resourceListing, discovery: pageDiscovery, ...pageFields }), ...workReadProblems },
    }, async ({ request, query }) => {
      try { return response(await workRead(work, request, query, readMyRatings)); }
      catch (error) { return readError(error); }
    })
    .get('/v1/works/:id/agent-credits', { params, detail, query: t.Object(pageQuery, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(t.Object({ id: readId, role: creditRole,
        agent: readId, displayName: t.String(), handle: profileHandle,
        address: agentProfile.properties.address }), { maxItems: 20 }), ...pageFields }), ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try { return response(await workRead(work, request, query, s => readNativeCredits(s, `https://rezics.com/id/${path.id}`))); }
      catch (error) { return readError(error); }
    })
    .post('/v1/works/:id/agent-credits', { params,
      body: t.Object({ profile: t.Literal('native-agent-credit-v1'), credit: readId, agent: readId,
        role: creditRole, expectedWorkHead: readId, actingSubject: readId }, { additionalProperties: false }),
      response: { 200: creditResult, 201: creditResult, 202: pendingOperation, ...workReadProblems },
    }, async ({ request, params: path, body }) => {
      try {
        const result = await createNativeCredit(work, request, { ...body, work: `https://rezics.com/id/${path.id}` },
          request.headers.get('idempotency-key') ?? '');
        return response(result, result.replayed ? 200 : 201);
      } catch (error) { return readError(error); }
    });
}
const creditResult = t.Object({ profile: t.Literal('native-agent-credit-v1'), credit: readId,
  revision: readId, work: readId, agent: readId, role: creditRole, replayed: t.Boolean(), sourcePosition: readPosition });
const listingState = t.Object({ listing: resourceListing, version: t.Integer({ minimum: 0 }),
  changedAt: t.Nullable(t.String()), replayed: t.Optional(t.Boolean()) });
function listingError(error: unknown): Response {
  if (error instanceof InvalidAgentListing) return problem(400, 'invalid_agent_listing', error.message);
  if (error instanceof AgentListingConflict) return problem(409, 'idempotency_conflict', error.message);
  if (error instanceof StaleAgentListing) return problem(409, 'stale_agent_listing', error.message);
  if (error instanceof AgentListingDenied || error instanceof ControlDenied) return problem(403, 'agent_listing_denied', 'Agent control unavailable');
  if (error instanceof AgentListingUnavailable || error instanceof ControlUnavailable) return problem(503, 'agent_listing_unavailable', 'Profile owner unavailable');
  return readError(error);
}

function visibilityError(error: unknown): Response {
  if (error instanceof InvalidLibraryVisibility) return problem(400, 'invalid_library_visibility', error.message);
  if (error instanceof LibraryVisibilityConflict) return problem(409, 'library_visibility_conflict', error.message);
  if (error instanceof StaleLibraryVisibility) return problem(409, 'stale_library_visibility', error.message);
  if (error instanceof LibraryVisibilityDenied || error instanceof ControlDenied) {
    return problem(403, 'library_visibility_denied', 'Agent control unavailable');
  }
  if (error instanceof LibraryVisibilityUnavailable || error instanceof ControlUnavailable) {
    return problem(503, 'library_visibility_unavailable', 'Profile owner unavailable');
  }
  return readError(error);
}
