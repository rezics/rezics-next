import { expect, test } from 'bun:test';
import { decodeJwt } from 'jose';
import { Pool } from 'pg';
import { readAccount } from '../../../src/access/account-data.ts';
import { routeOf } from '../../../src/route/route.ts';
import { createContentSystem } from './system.ts';

const databaseUrl = process.env.DATABASE_URL!;
if (!databaseUrl) throw new Error('DATABASE_URL must name a migrated application template');

function adminConnection(url: string): string {
  const admin = new URL(url);
  admin.pathname = '/postgres';
  return admin.href;
}

test('the isolated content system uses real ordinary and website identities through Auth, JWKS and Access', async () => {
  const system = await createContentSystem({ databaseUrl });
  const admin = new Pool({ connectionString: adminConnection(databaseUrl) });
  let appName = '';
  let authName = '';
  try {
    appName = (await system.database.pool.query('SELECT current_database() AS name')).rows[0]!.name as string;
    authName = (await system.database.authPool.query('SELECT current_database() AS name')).rows[0]!.name as string;
    const templateName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    expect(appName).not.toBe(templateName);
    expect(authName).not.toBe(templateName);
    expect(appName).not.toBe(authName);

    expect(system.actions.size).toBeGreaterThan(0);
    expect(system.actors.anonymous).toBeNull();
    expect(system.auth.ordinaryClient).toMatchObject({ kind: 'first-party' });
    expect(system.auth.websiteClient).toEqual({ id: 'rezics-website', kind: 'confidential' });

    for (const name of ['author', 'other', 'moderator', 'suspended'] as const) {
      const credential = system.actors[name];
      expect(credential.actor.clientId).toBe(system.auth.ordinaryClient.id);
      expect(credential.actor.scopes).not.toContain('media:complete');
      for (const scope of credential.actor.scopes) expect(system.actions.has(scope)).toBe(true);
      expect(decodeJwt(credential.bearer)).toMatchObject({
        sub: credential.actor.accountId,
        client_id: system.auth.ordinaryClient.id,
      });
      if (name === 'suspended') {
        expect(decodeJwt(credential.bearer).exp! * 1000).toBeGreaterThan(Date.now());
        const response = await system.transport.capture(
          new Request('https://content.test/health', {
            headers: { authorization: `Bearer ${credential.bearer}` },
          }),
        );
        expect(response.response.status).toBe(401);
        const route = routeOf(credential.actor.accountId);
        expect(route).not.toBeNull();
        expect(await readAccount(system.database.pool, route!, credential.actor.accountId)).toMatchObject({
          state: 'suspended',
          kind: 'actor',
          operatorAccountId: null,
        });
        continue;
      }
      expect(
        await system.access.authenticate(credential.bearer, {
          pool: system.database.pool,
          deadline: Date.now() + 10000,
        }),
      ).toEqual(credential.actor);
    }

    for (const name of ['worker', 'otherWorker'] as const) {
      const credential = system.actors[name];
      expect(credential.actor.clientId).toBe(system.auth.websiteClient.id);
      expect(credential.actor.kind).toBe('account');
      expect(credential.actor.scopes).toContain('media:complete');
      for (const scope of system.actions.keys()) expect(credential.actor.scopes).toContain(scope);
      expect(decodeJwt(credential.bearer)).toMatchObject({
        sub: credential.actor.accountId,
        client_id: system.auth.websiteClient.id,
      });
      expect(
        await system.access.authenticate(credential.bearer, {
          pool: system.database.pool,
          deadline: Date.now() + 10000,
        }),
      ).toEqual(credential.actor);
      const route = routeOf(credential.actor.accountId);
      expect(route).not.toBeNull();
      expect(await readAccount(system.database.pool, route!, credential.actor.accountId)).toMatchObject({
        state: 'active',
        kind: 'actor',
        operatorAccountId: null,
      });
    }

    // Website uploaders are ordinary accounts that authenticated through the
    // registered confidential website client, never a privileged Worker actor.
    expect(system.actors.worker.actor.accountId).toBe(system.actors.author.actor.accountId);
    expect(system.actors.otherWorker.actor.accountId).toBe(system.actors.other.actor.accountId);
    expect(system.actors.worker.actor.accountId).not.toBe(system.actors.otherWorker.actor.accountId);

    const request = new Request('https://content.test/health', {
      headers: { authorization: `Bearer ${system.actors.worker.bearer}` },
    });
    const captured = await system.transport.capture(request);
    expect(captured.request).toBe(request);
    expect(captured.response.status).toBe(200);
    expect(await captured.response.json()).toEqual({ status: 'ok' });

    const reissued = await system.auth.issue({
      accountId: system.actors.worker.actor.accountId,
      clientId: system.auth.websiteClient.id,
      scopes: system.actors.worker.actor.scopes,
    });
    expect(reissued.actor.accountId).toBe(system.actors.worker.actor.accountId);
    expect(reissued.actor.clientId).toBe(system.auth.websiteClient.id);
    expect(reissued.actor.scopes).toEqual(system.actors.worker.actor.scopes);
    await expect(system.auth.refresh({ refreshToken: 'unknown-website-refresh-token' })).rejects.toThrow();
  } finally {
    await system.close();
    expect(
      (await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])', [[appName, authName]])).rows,
    ).toEqual([]);
    await admin.end();
  }
});

test('failed full fixture construction removes only the partial isolated databases', async () => {
  const admin = new Pool({ connectionString: adminConnection(databaseUrl) });
  const unrelatedAdmin = new Pool({ connectionString: adminConnection(databaseUrl) });
  const name = `content_partial_${crypto.randomUUID().replaceAll('-', '')}`;
  const namespace = `content_${crypto.randomUUID().replaceAll('-', '')}`;
  const appName = `${namespace}_app`;
  const authName = `${namespace}_auth`;
  const unrelatedName = `content_unrelated_${crypto.randomUUID().replaceAll('-', '')}`;
  const source = new URL(databaseUrl);
  source.pathname = `/${name}`;
  let created = false;
  let unrelatedCreated = false;
  let unrelatedDropped = false;
  try {
    const templateName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    const quotedTemplate = `"${templateName.replaceAll('"', '""')}"`;
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE ${quotedTemplate}`);
    created = true;
    const malformedTemplate = new Pool({ connectionString: source.href });
    try {
      // Keep the migration probe intact, then fail at the real governance
      // bootstrap after both isolated fixture databases and Auth have started.
      await malformedTemplate.query('DROP TABLE access.governance_bootstrap');
    } finally {
      await malformedTemplate.end();
    }
    await Promise.all([
      expect(createContentSystem({ databaseUrl: source.href, namespace })).rejects.toThrow(
        'Operator governance bootstrap is unavailable',
      ),
      (async () => {
        await unrelatedAdmin.query(`CREATE DATABASE "${unrelatedName}"`);
        unrelatedCreated = true;
        await unrelatedAdmin.query(`DROP DATABASE "${unrelatedName}"`);
        unrelatedDropped = true;
      })(),
    ]);
    expect(unrelatedCreated).toBe(true);
    expect(unrelatedDropped).toBe(true);
    expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [unrelatedName])).rows).toEqual([]);
    expect(
      (await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])', [[appName, authName]])).rows,
    ).toEqual([]);
    expect(
      (await admin.query('SELECT datname FROM pg_database WHERE left(datname, length($1))=$1', [namespace])).rows,
    ).toEqual([]);
    expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rows).toEqual([
      { datname: name },
    ]);
  } finally {
    if (unrelatedCreated && !unrelatedDropped) {
      await unrelatedAdmin.query(`DROP DATABASE "${unrelatedName}"`);
      unrelatedDropped = true;
    }
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await unrelatedAdmin.end();
    await admin.end();
  }
});
