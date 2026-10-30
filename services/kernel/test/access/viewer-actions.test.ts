import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { decodeJwt, importJWK, SignJWT } from 'jose';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { fixedGlobalViewerResource } from '../../src/access/fixed-global-viewer-resource.ts';
import { mintReadTime, releaseOperationalTime } from '../../src/command/command.ts';
import type { AccessClient } from '../../src/request/access.ts';
import { compileViewerActionBindings } from '../../src/access/viewer-actions.ts';
import { createPool } from '../../src/database/pool.ts';
import type { MountedRoute } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { ContextNotFoundError, editorialContextAnchor } from '../../src/semantic/context.ts';
import { testKernel } from '../support/test-kernel.ts';
import { issuer, nativeFixture, scopes } from './native-account-bindings-fixture.ts';

const reference = { type: 'semantic.context', id: PLATFORM_RESOURCE.id };
const detail = {
  operationId: 'exposure.open',
  'x-action': 'exposure:open',
  'x-exposure': 'public',
  'x-authority-resource-types': [reference.type],
  'x-authority-resource-id': reference.id,
};
const route = (metadata: Record<string, unknown>): MountedRoute => ({
  method: 'POST',
  path: '/v1/platform/exposure/:group:open',
  hooks: { detail: metadata },
});

test('fixed Global metadata compiles only a genuine resource authority on the canonical Context', () => {
  expect(compileViewerActionBindings([route(detail)]).get(reference.type)).toEqual([
    {
      action: 'exposure:open',
      operationId: 'exposure.open',
      exposure: { kind: 'public' },
      authority: 'resource',
      fixedResourceId: reference.id,
    },
  ]);
  for (const invalid of [
    { 'x-authority-resource-id': null },
    { 'x-authority-resource-id': newId(0) },
    { 'x-authority-resource-id': `${reference.id}\n` },
    { 'x-authority-resource-id': { id: reference.id } },
    { 'x-authority-resource-types': undefined },
    { 'x-authority-resource-types': undefined, 'x-resource-types': [reference.type] },
    { 'x-authority-resource-types': ['access.account'] },
    { 'x-authority-resource-types': [reference.type, 'access.account'] },
    { 'x-authority-resource-types': [reference.type, reference.type] },
    { 'x-authority-anchor': 'own-account' },
    { 'x-account-authority': 'self' },
  ])
    expect(() => compileViewerActionBindings([route({ ...detail, ...invalid })])).toThrow();
  const unrestricted = { ...detail, 'x-authority-resource-id': undefined };
  expect(compileViewerActionBindings([route(unrestricted)]).get(reference.type)?.[0]?.fixedResourceId).toBeUndefined();
});

test('Existing exact exposure actions are advertised only for actual fixed Global resource under current native viewerActions formula and current exposure data is never inferred from admission', async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  const pool = createPool(url);
  let auth: Awaited<ReturnType<typeof nativeFixture>> | undefined;
  try {
    scopes.push('context:read', 'context:create', 'exposure:open', 'exposure:close', 'gate:any');
    await bootstrapRelease(pool, bundledRelease);
    auth = await nativeFixture(pool);
    const kernel = testKernel({
      pool,
      viewerActionResources: new Map([
        [
          reference.type,
          {
            readAction: 'context:read',
            async read(client, ids, at, time) {
              if (!time) throw new TypeError('Context fixture requires the live viewer read time');
              const present: Record<string, boolean> = {};
              for (const id of ids) {
                try {
                  if (await editorialContextAnchor(id).validate(client, time)) present[id] = true;
                } catch (error) {
                  if (!(error instanceof ContextNotFoundError)) throw error;
                }
              }
              return present;
            },
          },
        ],
      ]),
      auth: {
        issuer,
        audience: 'https://ordinary.api.test',
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: async () => auth!.host.service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
      },
    });
    const person = await auth.person('fixed-global-actions');
    async function grant(action: string, id: string = reference.id) {
      await pool.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
         VALUES ($1,$2,$3,$4,'(,)',$2)`,
        [routeOf(id), id, person.accountId, action],
      );
    }
    async function read(ids: string[], bearer = person.bearer) {
      const response = await kernel.handle(
        new Request('https://kernel.test/v1/viewerActions', {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify({ resources: ids.map((id) => ({ type: reference.type, id })) }),
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      return (await response.json()) as {
        resources: {
          type: string;
          id: string;
          viewerActions?: { action: string; operations: string[] }[];
          error?: string;
        }[];
      };
    }
    const exposure = (result: Awaited<ReturnType<typeof read>>, id: string) =>
      result.resources
        .find((item) => item.id === id)
        ?.viewerActions?.filter((entry) => entry.action.startsWith('exposure:'));
    const mounted = compileViewerActionBindings(kernel.routes).get(reference.type)!;
    for (const operation of ['open', 'close'])
      expect(mounted.find((binding) => binding.operationId === `exposure.${operation}`)).toMatchObject({
        action: `exposure:${operation}`,
        fixedResourceId: reference.id,
        authority: 'resource',
      });
    await grant('context:read');
    await grant('gate:any');
    expect(exposure(await read([reference.id]), reference.id)).toEqual([]);
    for (const action of ['exposure:open', 'exposure:close', 'context:create']) await grant(action);
    const positive = await read([reference.id]);
    expect(exposure(positive, reference.id)).toEqual([
      { action: 'exposure:close', operations: ['exposure.close'] },
      { action: 'exposure:open', operations: ['exposure.open'] },
    ]);
    // Neither admission nor viewerActions reports the current public opening.
    expect(Object.keys(positive)).toEqual(['resources']);
    expect(Object.keys(positive.resources[0]!).sort()).toEqual(['id', 'type', 'viewerActions']);
    const created = await kernel.handle(
      new Request('https://kernel.test/v1/contexts', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${person.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify({ labels: { en: 'Other Context' } }),
      }),
    );
    expect(created.status).toBe(201);
    const other: string = (await created.json()).context.id;
    for (const action of ['context:read', 'exposure:open', 'exposure:close']) await grant(action, other);
    expect(exposure(await read([other]), other)).toEqual([]);
    const mixed = await read([reference.id, other]);
    expect(exposure(mixed, reference.id)).toEqual(exposure(positive, reference.id));
    expect(exposure(mixed, other)).toEqual([]);
    const limited = await new SignJWT({
      ...decodeJwt<Record<string, unknown>>(person.bearer),
      scope: 'context:read gate:any exposure:close',
    })
      .setProtectedHeader({ alg: 'ES256', kid: auth.privateKey.kid, typ: 'at+jwt' })
      .sign(await importJWK(auth.privateKey, 'ES256'));
    expect(exposure(await read([reference.id], limited), reference.id)).toEqual([
      { action: 'exposure:close', operations: ['exposure.close'] },
    ]);
    await pool.query(
      `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
       VALUES (0,$1,$2,'exposure:open','resource','(,)',$1)`,
      [reference.id, person.accountId],
    );
    expect(exposure(await read([reference.id]), reference.id)).toEqual([
      { action: 'exposure:close', operations: ['exposure.close'] },
    ]);
    const missing = newId(0);
    expect((await read([missing])).resources).toEqual([{ type: reference.type, id: missing, error: 'not_found' }]);
  } finally {
    await auth?.close();
    await pool.end();
  }
});

test('fixed Global existence borrows the genuine live viewer time and supports no other Context', async () => {
  const at = '2026-10-31T00:00:00.123456Z';
  // Local time-query fixture mints the real opaque token; it never casts or reconstructs T.
  const client: AccessClient = {
    query: (async () => ({
      rows: [{ at }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    })) as AccessClient['query'],
  };
  const time = await mintReadTime(client);
  let reads = 0;
  let exists = true;
  const owner = fixedGlobalViewerResource({
    resource: PLATFORM_RESOURCE,
    async validate(checkout, observed) {
      expect(checkout).toBe(client);
      expect(observed).toBe(time);
      reads++;
      return exists;
    },
  });
  try {
    expect(owner.readAction).toBe('context:read');
    await expect(owner.read(client, [reference.id], at)).rejects.toThrow('live viewer read time');
    await expect(owner.read(client, [reference.id], '2026-10-31T00:00:01Z', time)).rejects.toThrow();
    expect(reads).toBe(0);
    expect(await owner.read(client, [newId(0)], at, time)).toEqual({});
    expect(reads).toBe(0);
    expect(await owner.read(client, [reference.id, newId(0)], at, time)).toEqual({ [reference.id]: true });
    expect(reads).toBe(1);
    exists = false;
    expect(await owner.read(client, [reference.id], at, time)).toEqual({});
  } finally {
    releaseOperationalTime(time);
  }
  await expect(owner.read(client, [reference.id], at, time)).rejects.toThrow();
  expect(reads).toBe(2);
  for (const resource of [
    { route: 1, id: reference.id },
    { route: 0, id: newId(0) },
  ])
    expect(() => fixedGlobalViewerResource({ resource, validate: async () => true })).toThrow('canonical Global');
});
