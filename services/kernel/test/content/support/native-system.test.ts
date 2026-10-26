import { expect, test } from 'bun:test';
import { decodeJwt, importJWK, jwtVerify } from 'jose';
import { Pool } from 'pg';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { readAccount } from '../../../src/access/account-data.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { actionCatalogue } from '../../../src/http/request.ts';
import { routeOf } from '../../../src/route/route.ts';
import { createNativeContentSystem } from './native-system.ts';
import { dropTestDatabase } from '../../support/drop-test-database.ts';

const databaseUrl = process.env.DATABASE_URL!;
if (!databaseUrl) throw new Error('DATABASE_URL must name a migrated application template');

test('native public grant commands can use the actual mounted kernel action catalogue', async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const kernel = createKernel({ pool, routeKey: crypto.getRandomValues(new Uint8Array(32)) });
    // The bootstrap role alone cannot authorize a subsequent grant when its
    // management action is absent from the installed production catalogue.
    expect([...actionCatalogue(kernel).keys()]).toContain('access:grant');
  } finally {
    await pool.end();
  }
});

test('actual ordinary lifecycle provisioning, Auth JWKS, Access and bootstrap compose on the exact fixture pool', async () => {
  const system = await createNativeContentSystem({ databaseUrl });
  try {
    expect(system.actions).toEqual(actionCatalogue(system.kernel));
    expect(Object.keys(system.actors).sort()).toEqual(['anonymous', 'author', 'moderator', 'other', 'suspended']);
    expect(Object.keys(system.auth).sort()).toEqual(['issue', 'ordinaryClient', 'refresh']);
    expect(system.actors.anonymous).toBeNull();
    const { author } = system.actors;
    const route = routeOf(author.actor.accountId);
    expect(route).not.toBeNull();
    expect(await readAccount(system.database.pool, route!, author.actor.accountId)).toMatchObject({
      state: 'active',
      kind: 'actor',
      operatorAccountId: null,
    });
    const claims = decodeJwt(author.bearer);
    const jwks = await system.nativeAuth.handler(new Request(`${claims.iss}/.well-known/jwks.json`));
    expect(jwks.status).toBe(200);
    const { keys } = (await jwks.json()) as { keys: import('jose').JWK[] };
    expect(keys).toHaveLength(1);
    await expect(jwtVerify(author.bearer, await importJWK(keys[0]!, 'ES256'))).resolves.toBeDefined();
    const authenticated = await system.access.authenticate(author.bearer, {
      pool: system.database.pool,
      deadline: Date.now() + 10000,
    });
    expect(authenticated).toEqual(author.actor);
    const request = new Request('https://content.test/health', {
      headers: { authorization: `Bearer ${author.bearer}` },
    });
    const captured = await system.transport.capture(request);
    expect(captured.request).toBe(request);
    expect(captured.response).toBeInstanceOf(Response);
    expect(captured.response.status).toBe(200);
    expect(await captured.response.json()).toEqual({ status: 'ok' });
    const marker = await system.database.pool.query(
      'SELECT account_id FROM access.governance_bootstrap WHERE route=$1 AND resource_id=$2',
      [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id],
    );
    expect(marker.rows).toHaveLength(1);
    const accountId = marker.rows[0].account_id as string;
    expect(await readAccount(system.database.pool, routeOf(accountId)!, accountId)).toMatchObject({
      state: 'active',
      kind: 'actor',
      operatorAccountId: null,
    });
    expect(await bootstrapGovernance(system.database.pool, accountId)).toMatchObject({
      accountId,
      resource: PLATFORM_RESOURCE,
      replayed: true,
    });
  } finally {
    await system.close();
  }
});

test('real human credentials and issue preserve registered ordinary client scopes; suspension retains its issued JWT', async () => {
  const system = await createNativeContentSystem({ databaseUrl });
  try {
    const identities = [];
    for (const name of ['author', 'other', 'moderator', 'suspended'] as const) {
      const credential = system.actors[name];
      identities.push(credential.actor.accountId);
      expect(routeOf(credential.actor.accountId)).not.toBeNull();
      expect(credential.actor.clientId).toBe(system.auth.ordinaryClient.id);
      expect(credential.actor.scopes).not.toContain('media:complete');
      for (const scope of credential.actor.scopes) expect(system.actions.has(scope)).toBe(true);
      expect(decodeJwt(credential.bearer)).toMatchObject({
        sub: credential.actor.accountId,
        client_id: credential.actor.clientId,
      });
      if (name === 'suspended') continue;
      const issued = await system.auth.issue({
        accountId: credential.actor.accountId,
        clientId: credential.actor.clientId,
        scopes: credential.actor.scopes,
      });
      expect(issued.actor).toEqual(credential.actor);
      expect(
        await system.access.authenticate(issued.bearer, {
          pool: system.database.pool,
          deadline: Date.now() + 10000,
        }),
      ).toEqual(credential.actor);
    }
    expect(new Set(identities).size).toBe(4);
    const suspended = system.actors.suspended;
    expect(decodeJwt(suspended.bearer).exp! * 1000).toBeGreaterThan(Date.now());
    expect(
      await readAccount(system.database.pool, routeOf(suspended.actor.accountId)!, suspended.actor.accountId),
    ).toMatchObject({ state: 'suspended', kind: 'actor', operatorAccountId: null });
    const denied = await system.transport.capture(
      new Request('https://content.test/health', {
        headers: { authorization: `Bearer ${suspended.bearer}` },
      }),
    );
    expect(denied.response.status).toBe(401);
    await expect(
      system.auth.issue({
        accountId: system.actors.author.actor.accountId,
        clientId: system.auth.ordinaryClient.id,
        scopes: ['media:complete'],
      }),
    ).rejects.toThrow();
    await expect(system.auth.refresh({ refreshToken: 'unissued-session-secret' })).rejects.toThrow();
  } finally {
    await system.close();
  }
});

test('complete native cleanup releases isolated databases and leaves the original template available', async () => {
  const system = await createNativeContentSystem({ databaseUrl });
  const admin = new Pool({ connectionString: databaseUrl });
  try {
    const app = (await system.database.pool.query('SELECT current_database() AS name')).rows[0].name as string;
    const auth = (await system.database.authPool.query('SELECT current_database() AS name')).rows[0].name as string;
    const template = (await admin.query('SELECT current_database() AS name')).rows[0].name as string;
    expect(app).not.toBe(template);
    expect(auth).not.toBe(template);
    expect(app).not.toBe(auth);
    await system.close();
    await system.close();
    expect(
      (await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])', [[app, auth]])).rows,
    ).toEqual([]);
    expect((await admin.query('SELECT current_database() AS name')).rows[0].name).toBe(template);
  } finally {
    await system.close();
    await admin.end();
  }
});

test('partial native construction cleans up when the caller template lacks application migrations', async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const name = `native_empty_${crypto.randomUUID().replaceAll('-', '')}`;
  const source = new URL(databaseUrl);
  source.pathname = `/${name}`;
  let created = false;
  try {
    // Namespace setup only: never install account, grant or lifecycle outcomes.
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
    created = true;
    const before = await admin.query('SELECT datname FROM pg_database ORDER BY datname');
    let failure: unknown;
    try {
      const unexpected = await createNativeContentSystem({ databaseUrl: source.href });
      await unexpected.close();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).not.toBe('NativeContentSystemUnfinishedError');
    expect((await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows).toEqual(before.rows);
    expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows).toEqual([
      { datname: name },
    ]);
  } finally {
    if (created) await dropTestDatabase(admin, name);
    await admin.end();
  }
});
