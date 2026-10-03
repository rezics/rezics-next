import { Elysia, t } from 'elysia';
import { readProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import {
  ALIAS_COST,
  NATIVE_ADDRESS_HOLDER,
  AliasInvalid,
  AliasDenied,
  AliasConflict,
  AliasCooldown,
  AliasUnavailable,
  type AliasScope,
  type AliasWrite,
} from '../modules/address/registry.ts';
import { InvalidAddressAlias } from '@rezics/model/address/aliases';
import { normalizeAddressAlias } from '@rezics/model/address/aliases';
import {
  resolveAddresses,
  type AddressScope,
  type AddressLookup,
} from '../modules/address/resolution.ts';
import {
  writeAlias,
  withAliasAuthority,
  withAliasAvailabilityAuthority,
} from '../modules/address/write.ts';
import { canonicalAddress } from '../modules/address/schema.ts';
import { mergedIdentity } from '../modules/identity-merge/resolution.ts';
import { MediaUnavailable } from '../modules/media/store.ts';

const scope = t.String({
  pattern: '^(agent|space|work|zone:https://rezics\\.com/id/[0-9a-f-]{36})$',
});
const readScope = t.String({
  pattern: '^(agent|space|work|resource|concept|zone:https://rezics\\.com/id/[0-9a-f-]{36})$',
});
const holder = t.String({ pattern: NATIVE_ADDRESS_HOLDER.source });
const revision = t.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const lookup = t.Object(
  {
    scope: readScope,
    key: t.String({ minLength: 1, maxLength: 512 }),
    route: t.Optional(t.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 64 })),
  },
  { additionalProperties: false },
);
const viewerLookup = t.Object(
  { ...lookup.properties, actingSubject: t.Optional(holder) },
  { additionalProperties: false },
);
const state = t.Union([t.Literal('current'), t.Literal('redirect'), t.Literal('retired')]);
const resolved = t.Union([
  t.Object(
    { scope: readScope, key: t.String(), status: t.Literal('unavailable') },
    { additionalProperties: false },
  ),
  t.Object(
    {
      profile: t.Literal('address-resolution-v1'),
      scope: readScope,
      key: t.String(),
      status: t.Union([t.Literal('resolved'), t.Literal('retired')]),
      holder,
      state,
      canonical: canonicalAddress,
      revision: t.Optional(revision),
      resolution: t.Optional(mergedIdentity),
      capabilities: t.Optional(
        t.Object(
          { realm: t.Optional(holder), zone: t.Optional(holder) },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
]);
const writeFields = { profile: t.Literal('alias-write-v1'), scope, holder, actingSubject: holder };
const alias = t.String({ minLength: 1, maxLength: 512 });
const writeBody = t.Union([
  t.Object(
    { ...writeFields, operation: t.Literal('claim'), alias, expectedRevision: t.Null() },
    { additionalProperties: false },
  ),
  t.Object(
    { ...writeFields, operation: t.Literal('rename'), alias, expectedRevision: revision },
    { additionalProperties: false },
  ),
  t.Object(
    { ...writeFields, operation: t.Literal('release'), expectedRevision: revision },
    { additionalProperties: false },
  ),
  t.Object(
    {
      ...writeFields,
      operation: t.Literal('merge'),
      expectedRevision: revision,
      successor: holder,
    },
    { additionalProperties: false },
  ),
]);
const receipt = t.Object({
  profile: t.Literal('alias-write-v1'),
  scope,
  holder,
  key: t.String(),
  state,
  revision,
  previousKey: t.Nullable(t.String()),
  changedAt: t.String(),
  successor: t.Optional(holder),
  replayed: t.Boolean(),
});

export const openApiOperations = {
  '/v1/addresses/current': { get: { bearer: true } },
  '/v1/addresses/claims': { post: { bearer: true, idempotencyKey: true } },
  '/v1/addresses/renames': { post: { bearer: true, idempotencyKey: true } },
  '/v1/addresses/dispositions': { post: { bearer: true, idempotencyKey: true } },
  '/v1/addresses/resolve': { get: { bearer: false } },
  '/v1/addresses/resolutions': { post: { bearer: false } },
  '/v1/addresses/availability': { get: { bearer: false } },
  '/v1/addresses/revisions/{revision}': { get: { bearer: false } },
} as const;

export function addressError(error: unknown): Response {
  if (error instanceof AliasCooldown) return problem(409, 'alias_cooldown', error.message);
  if (error instanceof AliasInvalid || error instanceof InvalidAddressAlias)
    return problem(400, 'invalid_alias', error.message);
  if (error instanceof AliasDenied) return problem(403, 'alias_denied', error.message);
  if (error instanceof AliasConflict) return problem(409, 'alias_conflict', error.message);
  if (error instanceof AliasUnavailable || error instanceof MediaUnavailable)
    return problem(503, 'alias_unavailable', error.message);
  return commandError(error);
}

export function addressRoutes(work: MainWorkDependencies) {
  const write = async (request: Request, body: Omit<AliasWrite, 'idempotencyKey'>) => {
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key))
      return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
    try {
      const result = await writeAlias(work, request, { ...body, idempotencyKey: key });
      return Response.json(result, {
        status: result.replayed ? 200 : 201,
        headers: { 'cache-control': 'no-store' },
      });
    } catch (error) {
      return addressError(error);
    }
  };
  const responses = { 200: receipt, 201: receipt, ...writeProblems };
  return new Elysia()
    .get(
      '/v1/addresses/current',
      {
        query: t.Object({ scope, holder, actingSubject: holder }, { additionalProperties: false }),
        response: {
          200: t.Union([t.Null(), t.Object({ scope, holder, key: t.String(), revision })]),
          ...readProblems,
        },
      },
      async ({ request, query }) => {
        try {
          const current = await withAliasAuthority(
            work,
            request,
            { ...query, scope: query.scope as AliasScope, operation: 'rename' },
            async (client) => {
              return (
                (
                  await client.query(
                    `SELECT scope,holder,key,revision FROM access.alias_registry
            WHERE scope = $1 AND holder = $2 AND state = 'current'`,
                    [query.scope, query.holder],
                  )
                ).rows[0] ?? null
              );
            },
          );
          return Response.json(current, { headers: { 'cache-control': 'no-store' } });
        } catch (error) {
          return addressError(error);
        }
      },
    )
    .post(
      '/v1/addresses/claims',
      { body: writeBody.anyOf[0], response: responses },
      ({ request, body }) => write(request, body as Omit<AliasWrite, 'idempotencyKey'>),
    )
    .post(
      '/v1/addresses/renames',
      { body: writeBody.anyOf[1], response: responses },
      ({ request, body }) => write(request, body as Omit<AliasWrite, 'idempotencyKey'>),
    )
    .post(
      '/v1/addresses/dispositions',
      { body: t.Union([writeBody.anyOf[2], writeBody.anyOf[3]]), response: responses },
      ({ request, body }) => write(request, body as Omit<AliasWrite, 'idempotencyKey'>),
    )
    .get(
      '/v1/addresses/resolve',
      { query: viewerLookup, response: { 200: resolved, 410: resolved, ...readProblems } },
      async ({ request, query }) => {
        try {
          const result = (
            await resolveAddresses(
              work,
              request,
              [{ ...query, scope: query.scope as AddressScope }],
              query.actingSubject,
            )
          )[0]!;
          if (result.status === 'unavailable')
            return problem(404, 'address_not_found', 'Address is unavailable');
          if (
            result.status === 'resolved' &&
            !request.headers.has('authorization') &&
            !query.actingSubject
          ) {
            // A lookup revision alone misses renames of its canonical successor
            // and language-dependent suffixes. Include the admitted representation.
            const body = JSON.stringify(result);
            const digest = new Bun.CryptoHasher('sha256').update(body).digest('hex');
            const etag = `"address-${result.revision ?? 'identity'}-${digest}"`;
            const headers = {
              'cache-control': 'public, max-age=30, must-revalidate',
              vary: 'Authorization, Accept-Language, X-Rezics-Display-Languages',
              etag,
            };
            // RFC 9110 §13.1.2: GET validators use weak comparison, including
            // a list of tags; visibility is checked before any 304 is returned.
            const condition = request.headers.get('if-none-match');
            if (
              condition?.trim() === '*' ||
              condition?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)
            )
              return new Response(null, { status: 304, headers });
            return new Response(body, {
              headers: { ...headers, 'content-type': 'application/json' },
            });
          }
          return Response.json(result, {
            status: result.status === 'retired' ? 410 : 200,
            headers: { 'cache-control': 'no-store' },
          });
        } catch (error) {
          return addressError(error);
        }
      },
    )
    .post(
      '/v1/addresses/resolutions',
      {
        body: t.Object(
          {
            lookups: t.Array(lookup, { minItems: 1, maxItems: ALIAS_COST.batch }),
            actingSubject: t.Optional(holder),
          },
          { additionalProperties: false },
        ),
        response: { 200: t.Object({ results: t.Array(resolved) }), ...readProblems },
      },
      async ({ request, body }) => {
        try {
          return Response.json(
            {
              results: await resolveAddresses(
                work,
                request,
                body.lookups as AddressLookup[],
                body.actingSubject,
              ),
            },
            { headers: { 'cache-control': 'no-store' } },
          );
        } catch (error) {
          return addressError(error);
        }
      },
    )
    .get(
      '/v1/addresses/availability',
      {
        query: t.Object({ scope, alias, actingSubject: t.Optional(holder) }),
        response: {
          200: t.Object({ available: t.Boolean(), reason: t.String() }),
          ...readProblems,
        },
      },
      async ({ request, query }) => {
        try {
          if (!work.environment.addresses)
            throw new AliasUnavailable('Alias registry is unavailable');
          const registry = work.environment.addresses;
          return Response.json(
            await withAliasAvailabilityAuthority(
              work,
              request,
              query.scope,
              query.actingSubject,
              () =>
                registry.withRead(() =>
                  registry.availability(query.scope as AliasScope, query.alias),
                ),
            ),
            { headers: { 'cache-control': 'no-store' } },
          );
        } catch (error) {
          return addressError(error);
        }
      },
    )
    .get(
      '/v1/addresses/revisions/:revision',
      {
        params: t.Object({ revision }),
        query: viewerLookup,
        response: { 200: t.Object({}, { additionalProperties: true }), ...readProblems },
      },
      async ({ request, query, params }) => {
        try {
          const current = (
            await resolveAddresses(work, request, [query as AddressLookup], query.actingSubject)
          )[0]!;
          if (current.status === 'unavailable')
            return problem(404, 'address_not_found', 'Address is unavailable');
          const registry = work.environment.addresses!;
          const normalizedKey = normalizeAddressAlias(
            query.key,
            registry.policy(query.scope).characters,
          ).key;
          const exact = await registry.exact(
            query.scope as AliasScope,
            normalizedKey,
            params.revision,
          );
          if (!exact)
            return problem(404, 'alias_revision_not_found', 'Alias revision is unavailable');
          return Response.json(
            {
              ...exact,
              ...('resolution' in current && current.resolution
                ? { resolution: current.resolution }
                : {}),
            },
            { headers: { 'cache-control': 'no-store' } },
          );
        } catch (error) {
          return addressError(error);
        }
      },
    );
}
