import { Elysia, t } from 'elysia';
import { writeProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import { generation, RealmAdminDenied, RealmAdminInvalid, RealmAdminStale, RealmAdminConflict,
  RealmAdminLimit, RealmAdminUnavailable } from '../modules/realm-admin/contract.ts';
import { invitationCommand, invitationResponse, invitationPage, invitationResult, selfJoinCommand,
  joinResult, joinPolicy } from '../modules/access/realm-management-joining-contract.ts';
import { AccountAssertionDenied } from '../modules/account/verify-assertion.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export const openApiOperations = {
  '/v1/me/managed-realms': { get: { exposure: 'public', bearer: true } },
  '/v1/me/realm-invitations': { get: { exposure: 'public', bearer: true } },
  '/v1/realms/{realm}/joining': { get: { exposure: 'public', bearer: true } },
  '/v1/realms/{realm}/join': { post: { exposure: 'public', bearer: true,idempotencyKey: true } },
  '/v1/realms/{realm}/invitations': { post: { exposure: 'public', bearer: true,idempotencyKey: true } },
  '/v1/realms/{realm}/invitations/{invitation}/response': { post: { exposure: 'public', bearer: true,idempotencyKey: true } },
  '/v1/realms/{realm}/invitations/{invitation}/revoke': { post: { exposure: 'public', bearer: true,idempotencyKey: true } },
  '/v1/realms/{realm}/roster': { get: { exposure: 'public', bearer: false } },
  '/v1/realms/{realm}/roster/listing': { put: { exposure: 'public', bearer: true } },
  '/v1/realms/{realm}/roster/featured': { put: { exposure: 'public', bearer: true } },
} as const;
const params = t.Object({ realm: readUuid });
const actor = t.Object({ actingSubject: readId },{ additionalProperties: false });
const page = { after: t.Optional(readId),limit: t.Optional(t.Integer({ minimum: 1,maximum: 50 })) };
const count = t.Object({ value: t.Integer(),kind: t.Union([t.Literal('exact'),t.Literal('lower-bound')]) });
const managedPage = t.Object({ items: t.Array(t.Object({ realm: readId,permissions: t.Array(t.String()),
  openCount: count,escalatedCount: count,latestActivity: t.Nullable(t.String()) }),{ maxItems: 20 }),
  nextCursor: t.Nullable(readId),complete: t.Boolean() });
const rosterPage = t.Object({ items: t.Array(t.Object({ agent: readId,displayName: t.Nullable(t.String()),featured: t.Boolean() }),{ maxItems: 50 }),
  nextCursor: t.Nullable(readId) });
const headers = { 'cache-control': 'private, no-store' };
const problems = { ...writeProblems,422: problemResult(422) };
const realmId = (realm: string) => `https://rezics.com/id/${realm}`;
const key = (request: Request) => request.headers.get('idempotency-key') ?? '';
export function realmOperationError(error: unknown) {
  if (error instanceof RealmAdminDenied) return problem(403,'realm_operation_denied',error.message);
  if (error instanceof RealmAdminInvalid) return problem(400,'invalid_realm_request',error.message);
  if (error instanceof RealmAdminStale) return problem(409,'stale_realm_basis',error.message);
  if (error instanceof RealmAdminConflict) return problem(409,'idempotency_conflict',error.message);
  if (error instanceof RealmAdminLimit) return problem(422,'realm_budget_exceeded',error.message);
  if (error instanceof RealmAdminUnavailable) return problem(503,'realm_unavailable',error.message);
  return commandError(error);
}

export function managedRealmRoutes(work: MainWorkDependencies) {
  const joining = () => { if (!work.realmJoining) throw new RealmAdminUnavailable('Joining owner is unavailable'); return work.realmJoining; };
  const roster = () => { if (!work.realmRoster) throw new RealmAdminUnavailable('Roster owner is unavailable'); return work.realmRoster; };
  return new Elysia()
    .get('/v1/me/managed-realms',{ query: t.Object({ ...page,actingSubject: readId,
      limit: t.Optional(t.Integer({ minimum: 1,maximum: 20 })) },{ additionalProperties: false }),
    response: { 200: managedPage,...problems } },async ({ request,query }) => {
      try {
        // An app may be consented to just one family. Counts and permissions for
        // the other family remain undisclosed even when the Agent holds them.
        let governance = true;
        let principal;
        try { principal = await work.account.verify(request,['governance:decide']); }
        catch (error) { if (!(error instanceof AccountAssertionDenied)) throw error; governance = false; }
        let review = false;
        try { const reviewer = await work.account.verify(request,['realm:adopt']);
          review = !principal || principal.issuer === reviewer.issuer && principal.subject === reviewer.subject;
          principal ??= reviewer;
        } catch (error) { if (!(error instanceof AccountAssertionDenied)) throw error; }
        if (!principal) throw new AccountAssertionDenied('Management consent is required');
        if (!work.managedRealms) throw new RealmAdminUnavailable('Managed Realm owner is unavailable');
        const page = await work.managedRealms.read(principal,query.actingSubject,query,{ governance,review });
        return Response.json({ ...page,complete: page.nextCursor === null },{ headers });
      } catch (error) { return realmOperationError(error); }
    })
    .get('/v1/me/realm-invitations',{ query: t.Object({ actingSubject: readId,after: t.Optional(readUuid),
      limit: page.limit },{ additionalProperties: false }),response: { 200: invitationPage,...problems } },async ({ request,query }) => {
      try { const principal = await work.account.verify(request,['access:membership-consent']);
        return Response.json(await joining().inbox(principal,query.actingSubject,query.after,query.limit),{ headers });
      } catch (error) { return realmOperationError(error); }
    })
    .get('/v1/realms/:realm/joining',{ params,query: actor,response: { 200: joinPolicy,...problems } },async ({ request,params: path,query }) => {
      try { const principal = await work.account.verify(request,['access:membership-consent']);
        return Response.json(await joining().policyFor(principal,realmId(path.realm),query.actingSubject),{ headers });
      } catch (error) { return realmOperationError(error); }
    })
    .post('/v1/realms/:realm/join',{ params,body: selfJoinCommand,response: { 200: joinResult,...problems } },async ({ request,params: path,body }) => {
      try { const principal = await work.account.verify(request,['access:membership-consent']);
        return Response.json(await joining().selfJoin(principal,realmId(path.realm),body,key(request)),{ headers });
      } catch (error) { return realmOperationError(error); }
    })
    .post('/v1/realms/:realm/invitations',{ params,body: invitationCommand,response: { 200: invitationResult,...problems } },async ({ request,params: path,body }) => {
      try { const principal = await work.account.verify(request,['governance:decide']);
        return Response.json(await joining().invite(principal,realmId(path.realm),body,key(request)),{ headers });
      } catch (error) { return realmOperationError(error); }
    })
    .post('/v1/realms/:realm/invitations/:invitation/response',{ params: t.Object({ realm: readUuid,invitation: readUuid }),
      body: invitationResponse,response: { 200: invitationResult,...problems } },async ({ request,params: path,body }) => {
      try { const principal = await work.account.verify(request,['access:membership-consent']);
        return Response.json(await joining().respond(principal,realmId(path.realm),path.invitation,body,key(request)),{ headers });
      } catch (error) { return realmOperationError(error); }
    })
    .post('/v1/realms/:realm/invitations/:invitation/revoke',{ params: t.Object({ realm: readUuid,invitation: readUuid }),
      body: actor,response: { 200: invitationResult,...problems } },async ({ request,params: path,body }) => {
      try { const principal = await work.account.verify(request,['governance:decide']);
        return Response.json(await joining().revoke(principal,realmId(path.realm),path.invitation,body.actingSubject,key(request)),{ headers });
      } catch (error) { return realmOperationError(error); }
    })
    .get('/v1/realms/:realm/roster',{ params,query: t.Object({ ...page,featured: t.Optional(t.Boolean()) },{ additionalProperties: false }),
      response: { 200: rosterPage,...problems } },async ({ params: path,query }) => {
      try { return Response.json(await roster().read(realmId(path.realm),query),{ headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return realmOperationError(error); }
    })
    .put('/v1/realms/:realm/roster/listing',{ params,body: t.Object({ actingSubject: readId,
      expectedMembershipGeneration: generation,listed: t.Boolean() },{ additionalProperties: false }),
      response: { 200: t.Object({ member: readId,membershipGeneration: generation,listed: t.Boolean() }),...problems } },async ({ request,params: path,body }) => {
      try { const principal = await work.account.verify(request,['access:membership-consent']);
        return Response.json(await roster().listing(principal,realmId(path.realm),body.actingSubject,body.expectedMembershipGeneration,body.listed),{ headers });
      } catch (error) { return realmOperationError(error); }
    })
    .put('/v1/realms/:realm/roster/featured',{ params,body: t.Object({ actingSubject: readId,member: readId,
      expectedMembershipGeneration: generation,featured: t.Boolean() },{ additionalProperties: false }),
      response: { 200: t.Object({ member: readId,membershipGeneration: generation,featured: t.Boolean() }),...problems } },async ({ request,params: path,body }) => {
      try { const principal = await work.account.verify(request,['governance:decide']);
        return Response.json(await roster().feature(principal,realmId(path.realm),body.actingSubject,body.member,body.expectedMembershipGeneration,body.featured),{ headers });
      } catch (error) { return realmOperationError(error); }
    });
}
