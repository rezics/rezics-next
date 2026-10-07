import { languageTagSchema } from '../modules/display-language/schema.ts';
import { direction } from '../modules/display-language/select.ts';
import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { iri } from '../modules/work/activate.ts';
import { createAdmittedRealmSpace, createAdmittedZoneSpace } from '../modules/space/create-admitted.ts';
import { addressError } from './addresses.ts';
import { pendingOperation } from '../api-contract.ts';
import { readProblems, spaceReadResult, spaceWriteResult, writeProblems }
  from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { realmSettings, RealmAdminConflict, RealmAdminDenied, RealmAdminInvalid,
  RealmAdminStale, RealmAdminUnavailable } from '../modules/realm-admin/contract.ts';

export function spaceCreationError(error: unknown): Response {
  if (error instanceof RealmAdminInvalid) return problem(400, 'invalid_realm_management_request', error.message);
  if (error instanceof RealmAdminDenied) return problem(403, 'realm_management_denied', error.message);
  if (error instanceof RealmAdminConflict) return problem(409, 'idempotency_conflict', error.message);
  if (error instanceof RealmAdminStale) return problem(409, 'stale_realm_management_basis', error.message);
  if (error instanceof RealmAdminUnavailable) return problem(503, 'realm_management_unavailable', error.message);
  return addressError(error);
}

export const openApiOperations = {
  '/v1/spaces': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/spaces/{space}': { get: { exposure: 'public', rateLimitFamily: 'read' } },
} as const;

const spaceCreateFields = {
  name: t.String({ minLength: 1, maxLength: 120,
    pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
  language: t.Optional(languageTagSchema(35)),
  capabilities: t.Tuple([t.Literal('realm')]),
  actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
};
const ref = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const visibility = t.Union([t.Literal('public'), t.Literal('private')]);
const listing = t.Union([t.Literal('listed'), t.Literal('unlisted')]);
const zoneSpaceWrite = t.Object({ space: ref, zone: ref, spaceRevision: ref, zoneRevision: ref,
  navigation: ref, navigationRevision: ref, owner: ref, capabilities: t.Tuple([t.Literal('zone')]),
  sourcePosition: t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() }),
  replayed: t.Boolean() });
const zoneSpaceRead = t.Object({ space: ref, zone: ref, owner: ref, name: t.String(),
  language: t.String(), direction: t.Union([t.Literal('ltr'), t.Literal('rtl')]),
  capabilities: t.Tuple([t.Literal('zone')]), state: t.Literal('active'),
  spaceRevision: ref, zoneRevision: ref, visibility, listing });

export function spaceRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/spaces', {
      body: t.Union([
        t.Object({ profile: t.Literal('space-zone-v1'), ...spaceCreateFields,
          capabilities: t.Tuple([t.Literal('zone')]),
          handle: t.Optional(t.String({ pattern: '^[A-Za-z0-9](?:[A-Za-z0-9_-]{1,28})[A-Za-z0-9]$' })),
          visibility: t.Optional(visibility), listing: t.Optional(listing),
        }, { additionalProperties: false }),
        t.Object({ profile: t.Literal('space-realm-v1'), ...spaceCreateFields,
          initialSettings: t.Optional(realmSettings) },
          { additionalProperties: false }),
        t.Object({ profile: t.Literal('space-realm-v2'), ...spaceCreateFields,
        handle: t.Optional(t.String({ pattern: '^[A-Za-z0-9](?:[A-Za-z0-9_-]{1,28})[A-Za-z0-9]$' })),
        topics: t.Optional(t.Array(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
          { maxItems: 3, uniqueItems: true })),
        initialSettings: t.Optional(realmSettings),
        }, { additionalProperties: false }),
      ]),
      response: { 200: t.Union([spaceWriteResult, zoneSpaceWrite]),
        201: t.Union([spaceWriteResult, zoneSpaceWrite]), 202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        if (body.profile === 'space-zone-v1') {
          const receipt = await createAdmittedZoneSpace(work.environment, work.account, work.access,
            request, { name: body.name, language: body.language, handle: body.handle,
              actingSubject: body.actingSubject, visibility: body.visibility, listing: body.listing,
              idempotencyKey });
          return Response.json({ space: receipt.space, zone: receipt.zone,
            spaceRevision: receipt.spaceRevision, zoneRevision: receipt.zoneRevision,
            navigation: receipt.navigation, navigationRevision: receipt.navigationRevision,
            owner: receipt.owner, capabilities: ['zone'],
            sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
            replayed: receipt.replayed }, {
            status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
          });
        }
        const receipt = await createAdmittedRealmSpace(work.environment, work.account, work.access,
          request, { name: body.name, language: body.language,
            handle: body.profile !== 'space-realm-v1' ? body.handle : undefined,
            topics: body.profile !== 'space-realm-v1' ? body.topics : undefined,
            actingSubject: body.actingSubject, initialSettings: body.initialSettings, idempotencyKey }, work.realmAdmin);
        return Response.json({ space: receipt.space, realm: receipt.realm,
          spaceRevision: receipt.spaceRevision, realmRevision: receipt.realmRevision,
          owner: receipt.owner, capabilities: ['realm'],
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return spaceCreationError(error); }
    })
    .get('/v1/spaces/:space', {
      params: t.Object({ space: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: t.Union([spaceReadResult, zoneSpaceRead]), ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const space = `https://rezics.com/id/${params.space}`;
        const zoneRows = (await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
          SELECT ?zone ?owner ?name ?spaceRevision ?zoneRevision ?listing WHERE {
            GRAPH <urn:rezics:graph:current> {
              ${iri(space)} a rv:Space ; rv:disclosure rv:Public ; rv:zoneCapability ?zone ;
                rv:owner ?owner ; rdfs:label ?name ; rv:head ?spaceRevision ; rv:listing ?listing .
              FILTER NOT EXISTS { ${iri(space)} rv:realmCapability ?realm }
              ?zone a rv:Zone ; rv:space ${iri(space)} ; rv:zoneState rv:Active ;
                rv:disclosure rv:Public ; rv:zoneHead ?zoneRevision .
            }
          } LIMIT 2`, 4096)).results?.bindings ?? [];
        if (zoneRows.length === 1) {
          const row = zoneRows[0]!;
          if (!row.zone || !row.owner || !row.name || !row.spaceRevision || !row.zoneRevision
            || !['listed','unlisted'].includes(row.listing?.value ?? '')) {
            return problem(404, 'space_unavailable', 'Space is unavailable');
          }
          return Response.json({ space, zone: row.zone.value, owner: row.owner.value,
            name: row.name.value, language: row.name['xml:lang'] ?? 'und',
            direction: direction(row.name['xml:lang'] ?? 'und'), capabilities: ['zone'], state: 'active',
            spaceRevision: row.spaceRevision.value, zoneRevision: row.zoneRevision.value,
            visibility: 'public', listing: row.listing!.value }, { headers: { 'cache-control': 'no-store' } });
        }
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
          SELECT ?realm ?owner ?name ?spaceRevision ?realmRevision
            ?selectionPolicy ?membershipPolicy ?reviewPolicy WHERE {
            GRAPH <urn:rezics:graph:current> {
              ${iri(space)} a rv:Space ; rv:disclosure rv:Public ; rv:realmCapability ?realm ;
                rv:owner ?owner ; rdfs:label ?name ; rv:head ?spaceRevision .
              ?realm a rv:Realm ; rv:space ${iri(space)} ; rv:realmState rv:Active ;
                rv:head ?realmRevision ; rv:selectionPolicy ?selectionPolicy ;
                rv:membershipPolicy ?membershipPolicy ; rv:reviewPolicy ?reviewPolicy .
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.realm || !rows[0]?.owner || !rows[0]?.name
          || !rows[0]?.spaceRevision || !rows[0]?.realmRevision || !rows[0]?.selectionPolicy
          || !rows[0]?.membershipPolicy || !rows[0]?.reviewPolicy) {
          return problem(404, 'space_unavailable', 'Space is unavailable');
        }
        const row = rows[0]!;
        return Response.json({ space, realm: row.realm!.value, owner: row.owner!.value,
          name: row.name!.value, language: row.name!['xml:lang'] ?? 'und',
          direction: direction(row.name!['xml:lang'] ?? 'und'), capabilities: ['realm'], state: 'active',
          spaceRevision: row.spaceRevision!.value, realmRevision: row.realmRevision!.value,
          selectionPolicy: row.selectionPolicy!.value,
          membershipPolicy: row.membershipPolicy!.value,
          reviewPolicy: row.reviewPolicy!.value }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return addressError(error); }
    });
}
