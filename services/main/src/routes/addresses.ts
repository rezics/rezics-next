import { Elysia, t } from 'elysia';
import { readProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { NAME_COST, NATIVE_ADDRESS_HOLDER,NameInvalid, NameDenied, NameConflict, NameUnavailable, type NameScope, type NameWrite } from '../modules/address/registry.ts';
import { InvalidAddressName } from '@rezics/model/address/names';
import { resolveAddresses,type AddressScope,type AddressLookup } from '../modules/address/resolution.ts';
import { writeName } from '../modules/address/write.ts';
import { canonicalAddress } from '../modules/address/schema.ts';
import { mergedIdentity } from '../modules/identity-merge/resolution.ts';
import { MediaUnavailable } from '../modules/media/store.ts';

const scope = t.String({ pattern: '^(agent|space|work|zone:https://rezics\\.com/id/[0-9a-f-]{36})$' });
const readScope = t.String({ pattern: '^(agent|space|work|resource|concept|zone:https://rezics\\.com/id/[0-9a-f-]{36})$' });
const holder = t.String({ pattern: NATIVE_ADDRESS_HOLDER.source });
const revision = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const lookup = t.Object({ scope: readScope,key: t.String({ minLength: 1,maxLength: 512 }),
  route: t.Optional(t.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',maxLength: 64 })) }, { additionalProperties: false });
const state = t.Union([t.Literal('current'),t.Literal('redirect'),t.Literal('retired')]);
const resolved = t.Union([
  t.Object({ scope: readScope,key: t.String(),status: t.Literal('unavailable') }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('address-resolution-v1'),scope: readScope,key: t.String(),
    status: t.Union([t.Literal('resolved'),t.Literal('retired')]),holder,state,canonical: canonicalAddress,
    revision: t.Optional(revision),resolution: t.Optional(mergedIdentity),
    capabilities: t.Optional(t.Object({ realm: t.Optional(holder),zone: t.Optional(holder) }, { additionalProperties: false })) }, { additionalProperties: false }),
]);
const writeFields = { profile: t.Literal('name-write-v1'),scope,holder,actingSubject: holder };
const name = t.String({ minLength: 1,maxLength: 512 });
const writeBody = t.Union([
  t.Object({ ...writeFields,operation: t.Literal('claim'),name,expectedRevision: t.Null() }, { additionalProperties: false }),
  t.Object({ ...writeFields,operation: t.Literal('rename'),name,expectedRevision: revision }, { additionalProperties: false }),
  t.Object({ ...writeFields,operation: t.Literal('release'),expectedRevision: revision }, { additionalProperties: false }),
  t.Object({ ...writeFields,operation: t.Literal('merge'),expectedRevision: revision,successor: holder }, { additionalProperties: false }),
]);
const receipt = t.Object({ profile: t.Literal('name-write-v1'),scope,holder,key: t.String(),display: t.String(),state,revision,
  previousKey: t.Nullable(t.String()),changedAt: t.String(),successor: t.Optional(holder),replayed: t.Boolean() });

export const openApiOperations = {
  '/v1/addresses/claims': { post: { bearer: true,idempotencyKey: true } },
  '/v1/addresses/renames': { post: { bearer: true,idempotencyKey: true } },
  '/v1/addresses/dispositions': { post: { bearer: true,idempotencyKey: true } },
  '/v1/addresses/resolve': { get: { bearer: false } },
  '/v1/addresses/resolutions': { post: { bearer: false } },
  '/v1/addresses/availability': { get: { bearer: false } },
  '/v1/addresses/revisions/{revision}': { get: { bearer: false } },
} as const;

export function addressError(error: unknown): Response {
  if (error instanceof NameInvalid || error instanceof InvalidAddressName) return problem(400,'invalid_name',error.message);
  if (error instanceof NameDenied) return problem(403,'name_denied',error.message);
  if (error instanceof NameConflict) return problem(409,'name_conflict',error.message);
  if (error instanceof NameUnavailable || error instanceof MediaUnavailable) return problem(503,'name_unavailable',error.message);
  return commandError(error);
}

export function addressRoutes(work: MainWorkDependencies) {
  const write = async (request: Request,body: Omit<NameWrite,'idempotencyKey'>) => {
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) return problem(400,'invalid_idempotency_key','A valid Idempotency-Key is required');
    try {
      const result = await writeName(work,request,{ ...body,idempotencyKey: key });
      return Response.json(result,{ status: result.replayed ? 200 : 201,headers: { 'cache-control': 'no-store' } });
    } catch (error) { return addressError(error); }
  };
  const responses = { 200: receipt,201: receipt,...writeProblems };
  return new Elysia()
    .post('/v1/addresses/claims', { body: writeBody.anyOf[0],response: responses }, ({ request,body }) => write(request,body as Omit<NameWrite,'idempotencyKey'>))
    .post('/v1/addresses/renames', { body: writeBody.anyOf[1],response: responses }, ({ request,body }) => write(request,body as Omit<NameWrite,'idempotencyKey'>))
    .post('/v1/addresses/dispositions', { body: t.Union([writeBody.anyOf[2],writeBody.anyOf[3]]),response: responses }, ({ request,body }) => write(request,body as Omit<NameWrite,'idempotencyKey'>))
    .get('/v1/addresses/resolve', { query: lookup,response: { 200: resolved,410: resolved,...readProblems } }, async ({ request,query }) => {
      try {
        const result = (await resolveAddresses(work,request,[{ ...query,scope: query.scope as AddressScope }]))[0]!;
        if (result.status === 'unavailable') return problem(404,'address_not_found','Address is unavailable');
        return Response.json(result,{ status: result.status === 'retired' ? 410 : 200,headers: { 'cache-control': 'no-store' } });
      } catch (error) { return addressError(error); }
    })
    .post('/v1/addresses/resolutions', { body: t.Object({ lookups: t.Array(lookup,{ minItems: 1,maxItems: NAME_COST.batch }) }, { additionalProperties: false }),
      response: { 200: t.Object({ results: t.Array(resolved) }),...readProblems } }, async ({ request,body }) => {
      try { return Response.json({ results: await resolveAddresses(work,request,body.lookups as AddressLookup[]) }, { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return addressError(error); }
    })
    .get('/v1/addresses/availability', { query: t.Object({ scope,name }),response: { 200: t.Object({ available: t.Boolean(),reason: t.String() }),...readProblems } }, async ({ query }) => {
      try {
        if (!work.environment.addresses) throw new NameUnavailable('Name registry is unavailable');
        const registry = work.environment.addresses;
        return Response.json(await registry.withRead(() => registry.availability(query.scope as NameScope,query.name)), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return addressError(error); }
    })
    .get('/v1/addresses/revisions/:revision', { params: t.Object({ revision }),query: lookup,
      response: { 200: t.Object({}, { additionalProperties: true }),...readProblems } }, async ({ request,query,params }) => {
      try {
        const current = (await resolveAddresses(work,request,[query as AddressLookup]))[0]!;
        if (current.status === 'unavailable') return problem(404,'address_not_found','Address is unavailable');
        const exact = await work.environment.addresses!.exact(query.scope as NameScope,
          current.key,params.revision);
        if (!exact) return problem(404,'name_revision_not_found','Name revision is unavailable');
        return Response.json({ ...exact,...'resolution' in current && current.resolution ? { resolution: current.resolution } : {} }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return addressError(error); }
    });
}
