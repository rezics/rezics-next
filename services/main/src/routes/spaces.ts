import { direction } from '../modules/display-language/select.ts';
import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { iri } from '../modules/work/activate.ts';
import { createAdmittedRealmSpace } from '../modules/space/create-admitted.ts';
import { COMMUNITY_HANDLE, COMMUNITY_HANDLE_READ_COST } from '../modules/space/create.ts';
import { pendingOperation } from '../api-contract.ts';
import { readProblems, spaceReadResult, spaceWriteResult, writeProblems }
  from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export const openApiOperations = {
  '/v1/spaces': { post: { bearer: true, idempotencyKey: true } },
  '/v1/realms/by-handle/{handle}': { get: { bearer: false } },
} as const;

const spaceCreateFields = {
  name: t.String({ minLength: 1, maxLength: 120,
    pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
  language: t.Optional(t.String({ minLength: 2, maxLength: 35, pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$' })),
  capabilities: t.Tuple([t.Literal('realm')]),
  actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
};

export function spaceRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/spaces', {
      body: t.Union([
        t.Object({ profile: t.Literal('space-realm-v1'), ...spaceCreateFields },
          { additionalProperties: false }),
        t.Object({ profile: t.Union([t.Literal('space-realm-v2'), t.Literal('space-realm-v3')]), ...spaceCreateFields,
        handle: t.Optional(t.String({ pattern: '^[a-z][a-z0-9-]{2,29}$' })),
        topics: t.Optional(t.Array(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
          { maxItems: 3, uniqueItems: true })),
        }, { additionalProperties: false }),
      ]),
      response: { 200: spaceWriteResult, 201: spaceWriteResult, 202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedRealmSpace(work.environment, work.account, work.access,
          request, { name: body.name, language: body.language,
            handle: body.profile !== 'space-realm-v1' ? body.handle : undefined,
            topics: body.profile !== 'space-realm-v1' ? body.topics : undefined,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ space: receipt.space, realm: receipt.realm,
          spaceRevision: receipt.spaceRevision, realmRevision: receipt.realmRevision,
          owner: receipt.owner, capabilities: ['realm'],
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/realms/by-handle/:handle', {
      params: t.Object({ handle: t.String({ pattern: COMMUNITY_HANDLE.source }) }),
      response: { 200: t.Object({ realm: t.String(), handle: t.String() }), ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const rows = (await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?realm WHERE { GRAPH <urn:rezics:graph:current> {
            ?realm a rv:Realm ; rv:realmState rv:Active ; rv:communityHandle "${params.handle}" .
          } } LIMIT ${COMMUNITY_HANDLE_READ_COST.resultRows}`,
        COMMUNITY_HANDLE_READ_COST.queryBytes)).results?.bindings ?? [];
        if (!rows.length) return problem(404, 'realm_unavailable', 'Realm is unavailable');
        if (rows.length !== 1 || !rows[0]?.realm) return problem(503, 'realm_unavailable', 'Realm is unavailable');
        return Response.json({ realm: rows[0].realm.value, handle: params.handle },
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/spaces/:space', {
      params: t.Object({ space: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: spaceReadResult, ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const space = `https://rezics.com/id/${params.space}`;
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
      } catch (error) { return commandError(error); }
    });
}
