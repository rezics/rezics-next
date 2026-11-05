import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import { initializeResourceGrants } from '../../src/access/resource-initialization.ts';
import { parentCreationAuthorization } from '../../src/access/parent-creation.ts';
import {
  assertDeclaredResourceTypes,
  explainUnresolvedResourceType,
  installResourceRoleCatalogue,
  resolveResourceRoles,
} from '../../src/access/resource-roles.ts';
import { runCommand } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { createApp } from '../../src/http/app.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { problemResponse } from '../../src/http/problem.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import * as permission from '../../src/access/permission.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf } from '../../src/route/route.ts';

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const routeKey = new Uint8Array(32);

function pool(): Pool {
  return createPool('postgres://kernel.invalid/resource-types');
}

function declaredRoute(action: string, types?: readonly string[]) {
  return {
    operationId: action.replace(':', '.'),
    'x-exposure': 'public',
    'x-action': action,
    security: [{ bearerAuth: [] }],
    ...(types === undefined ? {} : { 'x-resource-types': [...types] }),
  };
}

function declaredTypes(app: Parameters<typeof actionCatalogue>[0]): string[] {
  const types = new Set<string>();
  for (const metadata of actionCatalogue(app).values()) {
    for (const type of metadata['x-resource-types'] ?? []) types.add(type);
  }
  return [...types].sort();
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

/** Resource type names passed to production initializers, ignoring event names. */
function initializedResourceTypes(): Set<string> {
  const types = new Set<string>();
  for (const file of walk(sourceRoot)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('initializeResourceGrants')) continue;
    for (const match of source.matchAll(/type:\s*'([^']+)'/g)) {
      const type = match[1]!;
      if (!type.includes('.') || type.startsWith('com.rezics.') || type.startsWith('schema:')) continue;
      types.add(type);
    }
  }
  return types;
}

test('a mounted command that declares an unresolved resource type is refused', async () => {
  const database = pool();
  try {
    const app = createApp({ pool: database }).post(
      '/fixture/collections',
      { detail: declaredRoute('collection:create', ['library.collection']) },
      () => null,
    );
    expect(() => assertDeclaredResourceTypes(app, undefined, actionCatalogue(app))).toThrow(Error);
    try {
      assertDeclaredResourceTypes(app, undefined, actionCatalogue(app));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).toContain('library.collection');
      expect(message).toContain('library.collection.owner');
      expect(message).toContain('collection:read');
      expect(message).toContain('collection:update');
      expect(message).toContain('collection:delete');
    }
  } finally {
    await database.end();
  }
});

test('a declared resource type that resolves builds', async () => {
  const database = pool();
  try {
    const app = createApp({ pool: database }).post(
      '/fixture/resource-type',
      { detail: declaredRoute('fixture:declare', ['content.report']) },
      () => null,
    );
    expect(() => assertDeclaredResourceTypes(app, undefined, actionCatalogue(app))).not.toThrow();
    expect(actionCatalogue(app).get('fixture:declare')?.['x-resource-types']).toEqual(['content.report']);
    expect(explainUnresolvedResourceType(actionCatalogue(app), 'content.report')).toBeUndefined();
  } finally {
    await database.end();
  }
});

test('a resource type no mounted command declares may stay unresolved', async () => {
  const database = pool();
  try {
    const app = createApp({ pool: database }).post(
      '/fixture/resource-type',
      { detail: declaredRoute('fixture:declare', ['content.report']) },
      () => null,
    );
    expect(() => assertDeclaredResourceTypes(app, undefined, actionCatalogue(app))).not.toThrow();
    const actions = actionCatalogue(app);
    expect(declaredTypes(app)).not.toContain('library.collection');
    const unresolved = explainUnresolvedResourceType(actions, 'library.collection');
    expect(unresolved?.missingRoles).toEqual(['library.collection.owner']);
    expect(unresolved?.unmountedActions).toEqual(['collection:delete', 'collection:read', 'collection:update']);
  } finally {
    await database.end();
  }
});

test('createKernel runs the declared resource type check after exposure', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/http/kernel.ts', import.meta.url)), 'utf8');
  const body = source.slice(source.indexOf('export function createKernel'));
  const exposure = body.indexOf('parseExposure(');
  const check = body.indexOf('assertDeclaredResourceTypes(collections)');
  expect(source).toContain("import { assertDeclaredResourceTypes } from '../access/resource-roles.ts';");
  expect(exposure).toBeGreaterThan(0);
  expect(check).toBeGreaterThan(exposure);
  expect(body.indexOf('assertDeclaredResourceTypes(', check + 1)).toBe(-1);
});

test('initializing a resource type the command did not declare is a programming error and writes nothing', async () => {
  const route = 0x2345;
  const actor: AccountActor = {
    kind: 'account',
    accountId: newId(route),
    clientId: 'fixture',
    scopes: ['subject:create'],
    requestedBy: null,
    authnEpoch: 1,
  };
  const parent = { route, id: newId(route) };
  const child = { route, id: newId(route) };
  const actions = new Map([['subject:create', { anonymous: false, 'x-resource-types': ['content.board'] as const }]]);
  const access = {
    authenticate: async () => {
      throw new Error('unused');
    },
    prepare: async () => ({}),
    authorize: async () => true,
  } as Access;
  installResourceRoleCatalogue(access, resolveResourceRoles(actions));
  const queries: string[] = [];
  const client = {
    query(queryOrConfig: unknown) {
      const text =
        typeof queryOrConfig === 'string' ? queryOrConfig : ((queryOrConfig as { text?: string }).text ?? '');
      queries.push(text);
      return { rows: [{ at: '2026-01-01T00:00:00.000Z' }], rowCount: 1 };
    },
    release() {},
  };
  const database = { connect: async () => client, query: client.query.bind(client) } as unknown as Pool;
  let validated = false;
  const deadline = spyOn(permission, 'permissionEvidenceDeadline').mockReturnValue(Date.now() + 60_000);
  try {
    const response = problemResponse(new TypeError('Resource type content.post is not declared by subject:create'), {
      method: 'POST',
      id: 'resource-type',
    });
    expect(response.status).toBe(500);
    await expect(
      runCommand(
        database,
        {
          partition: partitionOf(route),
          deadline: Date.now() + 5_000,
          clock: () => new Date('2026-01-01T00:00:00.000Z'),
          basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: null },
          authorization: parentCreationAuthorization({
            access,
            actor,
            action: 'subject:create',
            parent: { resource: parent, validate: async () => true },
            context: {
              pool: database,
              deadline: Date.now() + 5_000,
              resource: child,
              creation: {
                validate: async () => {
                  validated = true;
                  return true;
                },
              },
            },
          }),
        },
        async (tx) => {
          await initializeResourceGrants(tx, { resource: child, type: 'content.post', creator: actor.accountId });
          return { value: child, events: [{ type: 'com.rezics.fixture.created.v1', data: {} }] };
        },
      ),
    ).rejects.toThrow(TypeError);
    expect(validated).toBe(false);
    expect(
      queries.some((query) => query.includes('resource_initialization') || query.includes('resource_role_grant')),
    ).toBe(false);
  } finally {
    deadline.mockRestore();
  }
});

test('every production initializer type is declared on its route and resolves', async () => {
  const database = pool();
  try {
    const app = createKernel({ pool: database, routeKey });
    const actions = actionCatalogue(app);
    const scanned = initializedResourceTypes();
    const required = new Set(scanned);
    if (!actions.has('collection:create')) required.delete('library.collection');
    expect(declaredTypes(app)).toEqual([...required].sort());
    expect(scanned.has('library.collection')).toBe(true);
    for (const type of required) expect(explainUnresolvedResourceType(actions, type)).toBeUndefined();
  } finally {
    await database.end();
  }
});
