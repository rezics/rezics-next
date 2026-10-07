import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Elysia } from 'elysia';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessPlatformAdministrators } from '../../../services/main/src/modules/access/platform-administrator.ts';
import { AccessGrants } from '../../../services/main/src/modules/access/grants.ts';
import { PlatformGrantDenied } from '../../../services/main/src/modules/access/platform-grants.ts';
import {
  assertPlatformGovernance,
  PLATFORM_GOVERNANCE_COST,
} from '../../../services/main/src/modules/access/platform-governance.ts';
import { healthRoutes } from '../../../services/main/src/routes/health.ts';
import { accessAuthorityRoutes } from '../../../services/main/src/routes/access-authority.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import type { PlatformGrantResult } from '../../../services/main/src/modules/access/platform-grants.ts';
import { mainSchemaReady } from '../../../services/main/src/schema-ready.ts';
import { checkPlatformGovernance } from '../platform-governance.ts';
import { schemaFiles } from '../../qa/schema-files.ts';
import {
  migrateContentFromArtifact,
  migrateTracked,
  migrationDirectories,
  repositoryRoot,
} from '../migrate.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const receipt = () => ({ idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()) });

test('first governance designation is atomic, ordinary grants add backups and opening requires a permanent holder while Main stays ready', async () => {
  const state = join(repositoryRoot, '.temp', `platform-governance-${randomUUID()}`);
  const data = join(state, 'pgdata');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  let started = false;
  let pool: Pool | undefined;
  const envNames = [
    'NODE_ENV',
    'ACCESS_DATABASE_URL',
    'CONTENT_DATABASE_URL',
    'MAIN_RELAY_DATABASE_URL',
  ] as const;
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  try {
    execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], {
      cwd: state,
      stdio: 'pipe',
    });
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string')
          return reject(new Error('No PostgreSQL test port'));
        server.close(() => resolve(address.port));
      });
    });
    execFileSync(
      'pg_ctl',
      [
        '-D',
        data,
        '-l',
        join(state, 'postgres.log'),
        '-o',
        `-h 127.0.0.1 -p ${port} -k /tmp`,
        '-w',
        'start',
      ],
      { cwd: state, stdio: 'pipe' },
    );
    started = true;
    const url = (database: string) =>
      `postgres://127.0.0.1:${port}/${database}?user=${encodeURIComponent(process.env.USER!)}`;
    pool = new Pool({ connectionString: url('postgres'), max: 4, statement_timeout: 5000 });
    for (const database of ['content', 'relay']) await pool.query(`CREATE DATABASE ${database}`);
    await migrateTracked(url('postgres'), repositoryRoot, migrationDirectories.access);
    await migrateTracked(url('relay'), repositoryRoot, migrationDirectories.relay);
    await migrateContentFromArtifact(url('content'), repositoryRoot);
    const owner = pool;
    const principal = async (active = true) => {
      const id = randomUUID(),
        actor = `https://rezics.com/id/${randomUUID()}`;
      const identity = {
        issuer: 'https://accounts.platform.test',
        subject: randomUUID(),
        emailVerified: true,
      };
      await owner.query(
        'INSERT INTO access.principal(id,account_issuer,account_subject,active) VALUES ($1,$2,$3,$4)',
        [id, identity.issuer, identity.subject, active],
      );
      await owner.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [
        actor,
      ]);
      await owner.query(
        "INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,'agent.control','infinity')",
        [randomUUID(), id, actor],
      );
      return { id, actor, identity };
    };
    const first = await principal(),
      second = await principal(),
      inactive = await principal(false);
    const designation = new AccessPlatformAdministrators(owner);
    const logs: string[] = [];
    expect(await designation.designateFirst(first.identity.issuer, undefined)).toEqual({
      status: 'unconfigured',
    });
    for (const subject of ['unknown', inactive.identity.subject]) {
      await expect(designation.designateFirst(first.identity.issuer, subject)).rejects.toThrow(
        'existing active',
      );
      expect((await owner.query('SELECT id FROM access.platform_grant_episode')).rows).toEqual([]);
    }
    Object.assign(process.env, {
      NODE_ENV: 'production',
      ACCESS_DATABASE_URL: url('postgres'),
      CONTENT_DATABASE_URL: url('content'),
      MAIN_RELAY_DATABASE_URL: url('relay'),
    });
    await expect(checkPlatformGovernance(url('postgres'))).rejects.toThrow(
      'permanent platform:grant',
    );
    await expect(mainSchemaReady()).resolves.toBeUndefined();
    class ReadyGraph extends FusekiClient {
      override async query() {
        return { boolean: true };
      }
    }
    const app = healthRoutes(new ReadyGraph('http://unused.invalid'));
    expect((await app.handle(new Request('http://main.test/health/live'))).status).toBe(200);
    expect((await app.handle(new Request('http://main.test/health/ready'))).status).toBe(200);

    // Simulate failure on the first audit write: no seed grant may escape rollback.
    await owner.query(`CREATE FUNCTION access.reject_seed_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER reject_seed_audit BEFORE INSERT ON access.platform_grant_episode
        FOR EACH ROW EXECUTE FUNCTION access.reject_seed_audit()`);
    await expect(
      designation.designateFirst(first.identity.issuer, first.identity.subject),
    ).rejects.toThrow('audit unavailable');
    expect(
      (
        await owner.query(
          "SELECT id FROM access.principal_permission_grant WHERE action LIKE 'platform:%'",
        )
      ).rows,
    ).toEqual([]);
    await owner.query(
      'DROP TRIGGER reject_seed_audit ON access.platform_grant_episode; DROP FUNCTION access.reject_seed_audit()',
    );
    const attempts = await Promise.all(
      [first, second].map((person) =>
        designation.designateFirst(person.identity.issuer, person.identity.subject, (message) =>
          logs.push(message),
        ),
      ),
    );
    expect(attempts.map((result) => result.status).sort()).toEqual(['granted', 'ignored']);
    const administrator = attempts[0]!.status === 'granted' ? first : second;
    const backup = administrator === first ? second : first;
    const seeded = (
      await owner.query<{ action: string; receipt: string; permanent: boolean }>(
        `SELECT g.action,e.receipt,g.valid_until = 'infinity' AS permanent
      FROM access.principal_permission_grant g JOIN access.platform_grant_episode e ON e.principal_grant_id = g.id
      WHERE g.principal_id = $1`,
        [administrator.id],
      )
    ).rows;
    expect(seeded).toHaveLength(23);
    expect(seeded.every((grant) => grant.permanent)).toBe(true);
    expect(seeded.map((grant) => grant.action)).toContain('platform:grant');
    expect(seeded.map((grant) => grant.action)).toContain('platform:use:platform-admin');
    expect(seeded.filter((grant) => grant.action.startsWith('platform:resource:'))).toHaveLength(
      21,
    );
    expect(new Set(seeded.map((grant) => grant.receipt)).size).toBe(1);
    expect(logs.some((message) => message.includes('audit receipt'))).toBe(true);
    expect(logs.some((message) => message.includes('ignored'))).toBe(true);
    const warnings: string[] = [];
    expect(
      await checkPlatformGovernance(url('postgres'), (message) => warnings.push(message)),
    ).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('second holder');
    await mainSchemaReady();
    expect((await app.handle(new Request('http://main.test/health/ready'))).status).toBe(200);
    const envFile = join(state, 'production.env');
    writeFileSync(envFile, `ACCESS_DATABASE_URL=${url('postgres')}\n`);
    const command = Bun.spawnSync(['task', 'ops:platform-governance', '--', envFile], {
      cwd: repositoryRoot,
      env: process.env,
    });
    expect(command.exitCode).toBe(0);
    expect(command.stderr.toString()).toContain('Only one');

    // A replay must not restore a revoked resource, or add new ceilings.
    await owner.query(
      "UPDATE access.principal_permission_grant SET active = false WHERE principal_id = $1 AND action = 'platform:resource:zone.edit'",
      [administrator.id],
    );
    await owner.query(
      "UPDATE access.permission_grant SET active = false WHERE recipient_subject = $1 AND action = 'access.grant.assign.zone.edit'",
      [administrator.actor],
    );
    const beforeReplay = (
      await owner.query('SELECT id,active FROM access.principal_permission_grant ORDER BY id')
    ).rows;
    for (const subject of [
      administrator.identity.subject,
      backup.identity.subject,
      inactive.identity.subject,
      'invalid subject',
    ]) {
      expect(
        (
          await designation.designateFirst(administrator.identity.issuer, subject, (message) =>
            logs.push(message),
          )
        ).status,
      ).toBe('ignored');
    }
    expect(
      (await owner.query('SELECT id,active FROM access.principal_permission_grant ORDER BY id'))
        .rows,
    ).toEqual(beforeReplay);
    expect(
      (await owner.query('SELECT DISTINCT receipt FROM access.platform_grant_episode')).rows,
    ).toHaveLength(1);

    const grants = new AccessGrants(owner).platform;
    const context = async (person = administrator) => ({
      principal: person.identity,
      issuerSubject: person.actor,
      expectedAuthorityEpoch: (
        await owner.query(
          "SELECT authority_epoch FROM access.scope_gate WHERE id = 'platform:access'",
        )
      ).rows[0].authority_epoch as string,
    });
    await expect(
      grants.create(
        await context(backup),
        randomUUID(),
        'platform:grant',
        { principalId: backup.id },
        null,
        receipt(),
      ),
    ).rejects.toBeInstanceOf(PlatformGrantDenied);
    // Finite holders and duplicate grants never supply a permanent backup.
    const leased = await principal();
    const third = await principal();
    await grants.create(
      await context(),
      randomUUID(),
      'platform:grant',
      { principalId: leased.id },
      new Date(Date.now() + 60_000),
      receipt(),
    );
    await grants.create(
      await context(),
      randomUUID(),
      'platform:grant',
      { principalId: administrator.id },
      null,
      receipt(),
    );
    expect(await assertPlatformGovernance(owner)).toBe(1);
    const holders = new Map([
      ['admin', administrator],
      ['backup', backup],
      ['leased', leased],
    ]);
    const grantApp = new Elysia().use(
      accessAuthorityRoutes({
        grants: new AccessGrants(owner),
        account: {
          verify: async (request: Request) =>
            holders.get(request.headers.get('authorization') ?? 'admin')?.identity ??
            administrator.identity,
        },
      } as unknown as MainWorkDependencies),
    );
    const change = (
      token: string,
      body: Record<string, unknown>,
    ) => {
      const issuer = holders.get(token)!;
      return grantApp.handle(
        new Request('http://main.test/v1/access/grant-changes', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
            authorization: token,
          },
          body: JSON.stringify({
            profile: 'platform-grant-change-v1',
            issuerSubject: issuer.actor,
            ...body,
          }),
        }),
      );
    };
    const issued = await change('admin', {
      action: 'create',
      expectedAuthorityEpoch: (await context()).expectedAuthorityEpoch,
      grantId: randomUUID(),
      permission: 'platform:grant',
      scopeId: 'platform:access',
      recipient: { principalId: backup.id },
      validUntil: null,
    });
    expect(issued.status).toBe(200);
    const permanent = (await issued.json()) as PlatformGrantResult;
    warnings.length = 0;
    expect(
      await checkPlatformGovernance(url('postgres'), (message) => warnings.push(message)),
    ).toBe(2);
    expect(warnings).toEqual([]);
    const delegated = await change('backup', {
      action: 'create',
      expectedAuthorityEpoch: (await context(backup)).expectedAuthorityEpoch,
      grantId: randomUUID(),
      permission: 'platform:use:saved-views',
      scopeId: 'platform:access',
      recipient: { principalId: third.id },
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(delegated.status).toBe(200);
    const delegatedGrant = (await delegated.json()) as PlatformGrantResult;
    const beyond = await change('leased', {
      action: 'create',
      expectedAuthorityEpoch: (await context(leased)).expectedAuthorityEpoch,
      grantId: randomUUID(),
      permission: 'platform:use:saved-views',
      scopeId: 'platform:access',
      recipient: { principalId: third.id },
      validUntil: null,
    });
    expect(beyond.status).toBe(403);
    expect(await beyond.json()).toMatchObject({ code: 'grant_denied' });
    await owner.query('UPDATE access.principal SET active = false WHERE id = $1', [
      administrator.id,
    ]);
    expect(await assertPlatformGovernance(owner)).toBe(1);
    await expect(
      grants.revoke(
        await context(backup),
        permanent.grant.id,
        permanent.grant.generation,
        receipt(),
      ),
    ).rejects.toThrow('continuity');
    await expect(
      owner.query('UPDATE access.principal SET active = false WHERE id = $1', [backup.id]),
    ).rejects.toThrow('last permanent');
    expect(
      (
        await designation.designateFirst(
          administrator.identity.issuer,
          administrator.identity.subject,
          () => undefined,
        )
      ).status,
    ).toBe('ignored');
    expect(
      (await owner.query('SELECT active FROM access.principal WHERE id = $1', [administrator.id]))
        .rows[0].active,
    ).toBe(false);
    await owner.query('UPDATE access.principal SET active = true WHERE id = $1', [administrator.id]);
    const removed = await change('admin', {
      action: 'revoke',
      expectedAuthorityEpoch: (await context()).expectedAuthorityEpoch,
      grantId: permanent.grant.id,
      expectedObjectGeneration: permanent.grant.generation,
    });
    expect(removed.status).toBe(200);
    const ended = await change('backup', {
      action: 'create',
      expectedAuthorityEpoch: (await context(backup)).expectedAuthorityEpoch,
      grantId: randomUUID(),
      permission: 'platform:use:saved-views',
      scopeId: 'platform:access',
      recipient: { principalId: third.id },
      validUntil: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(ended.status).toBe(403);
    expect(
      (
        await owner.query('SELECT active FROM access.principal_permission_grant WHERE id = $1', [
          delegatedGrant.grant.id,
        ])
      ).rows[0].active,
    ).toBe(true);
    expect(
      (
        await owner.query(
          `SELECT g.active FROM access.platform_assignment_ceiling c
          JOIN access.permission_grant g ON g.id = c.ceiling_id WHERE c.grant_id = $1`,
          [permanent.grant.id],
        )
      ).rows[0].active,
    ).toBe(false);

    let statements = 0;
    const measured = {
      query: async (sql: string, values: unknown[]) => {
        statements++;
        expect(sql).toContain('LIMIT $2');
        expect(values[1]).toBe(PLATFORM_GOVERNANCE_COST.holders);
        const result = await owner.query(sql, values);
        expect(result.rows.length).toBeLessThanOrEqual(PLATFORM_GOVERNANCE_COST.holders);
        return result;
      },
    } as unknown as Pool;
    expect(await assertPlatformGovernance(measured)).toBe(1);
    expect(statements).toBe(PLATFORM_GOVERNANCE_COST.statements);
  } finally {
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await pool?.end();
    if (started)
      execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], {
        cwd: state,
        stdio: 'pipe',
      });
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);

test('revoking the designated holder ends the seeded assignment ceiling', async () => {
  const state = join(repositoryRoot, '.temp', `platform-governance-${randomUUID()}`);
  const data = join(state, 'pgdata');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  let started = false;
  let pool: Pool | undefined;
  try {
    execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], {
      cwd: state,
      stdio: 'pipe',
    });
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string')
          return reject(new Error('No PostgreSQL test port'));
        server.close(() => resolve(address.port));
      });
    });
    execFileSync(
      'pg_ctl',
      [
        '-D',
        data,
        '-l',
        join(state, 'postgres.log'),
        '-o',
        `-h 127.0.0.1 -p ${port} -k /tmp`,
        '-w',
        'start',
      ],
      { cwd: state, stdio: 'pipe' },
    );
    started = true;
    const url = `postgres://127.0.0.1:${port}/postgres?user=${encodeURIComponent(process.env.USER!)}`;
    pool = new Pool({ connectionString: url, max: 4 });
    const owner = pool;
    for (const file of schemaFiles(repositoryRoot, 'access')) {
      if (file === '1298_platform_grant_seed_ceiling.sql') continue;
      await owner.query(
        readFileSync(join(repositoryRoot, 'services/main/migrations/access', file), 'utf8'),
      );
    }
    const principal = async () => {
      const id = randomUUID(),
        actor = `https://rezics.com/id/${randomUUID()}`;
      const identity = {
        issuer: 'https://accounts.platform.test',
        subject: randomUUID(),
        emailVerified: true,
      };
      await owner.query(
        'INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
        [id, identity.issuer, identity.subject],
      );
      await owner.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [
        actor,
      ]);
      await owner.query(
        "INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,'agent.control','infinity')",
        [randomUUID(), id, actor],
      );
      return { id, actor, identity };
    };
    const first = await principal(),
      second = await principal(),
      third = await principal();
    expect(
      (
        await new AccessPlatformAdministrators(owner).designateFirst(
          first.identity.issuer,
          first.identity.subject,
          () => undefined,
        )
      ).status,
    ).toBe('granted');
    const seeded = (
      await owner.query<{ id: string; generation: string }>(
        `SELECT g.id, g.generation FROM access.principal_permission_grant g
        JOIN access.platform_grant_episode e ON e.principal_grant_id = g.id
        WHERE g.principal_id = $1 AND g.action = 'platform:grant'
        ORDER BY e.created_at, e.id LIMIT 1`,
        [first.id],
      )
    ).rows[0]!;
    const ceiling = async () =>
      (
        await owner.query<{ active: boolean }>(
          `SELECT g.active FROM access.platform_assignment_ceiling c
          JOIN access.permission_grant g ON g.id = c.ceiling_id WHERE c.grant_id = $1`,
          [seeded.id],
        )
      ).rows;
    expect(
      (
        await owner.query(
          `SELECT id FROM access.permission_grant
          WHERE recipient_subject = $1 AND action = 'access.grant.assign.platform'`,
          [first.actor],
        )
      ).rows,
    ).toHaveLength(1);
    expect(await ceiling()).toEqual([]);
    await owner.query(
      readFileSync(
        join(
          repositoryRoot,
          'services/main/migrations/access/1298_platform_grant_seed_ceiling.sql',
        ),
        'utf8',
      ),
    );
    expect(await ceiling()).toEqual([{ active: true }]);
    await owner.query('SELECT access.link_seeded_platform_assignment_ceiling($1)', [first.id]);
    expect(await ceiling()).toEqual([{ active: true }]);
    expect(
      (
        await new AccessPlatformAdministrators(owner).designateFirst(
          first.identity.issuer,
          first.identity.subject,
          () => undefined,
        )
      ).status,
    ).toBe('ignored');
    expect(
      (
        await owner.query(
          `SELECT id FROM access.permission_grant
          WHERE recipient_subject = $1 AND action = 'access.grant.assign.platform'`,
          [first.actor],
        )
      ).rows,
    ).toHaveLength(1);
    const holders = new Map([
      ['first', first],
      ['second', second],
    ]);
    const grantApp = new Elysia().use(
      accessAuthorityRoutes({
        grants: new AccessGrants(owner),
        account: {
          verify: async (request: Request) => holders.get(request.headers.get('authorization')!)!.identity,
        },
      } as unknown as MainWorkDependencies),
    );
    const epoch = async () =>
      (
        await owner.query<{ authority_epoch: string }>(
          "SELECT authority_epoch FROM access.scope_gate WHERE id = 'platform:access'",
        )
      ).rows[0]!.authority_epoch;
    const change = (token: 'first' | 'second', body: Record<string, unknown>) =>
      grantApp.handle(
        new Request('http://main.test/v1/access/grant-changes', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
            authorization: token,
          },
          body: JSON.stringify({
            profile: 'platform-grant-change-v1',
            issuerSubject: holders.get(token)!.actor,
            expectedAuthorityEpoch: body.expectedAuthorityEpoch,
            ...body,
          }),
        }),
      );
    const appointed = await change('first', {
      action: 'create',
      expectedAuthorityEpoch: await epoch(),
      grantId: randomUUID(),
      permission: 'platform:grant',
      scopeId: 'platform:access',
      recipient: { principalId: second.id },
      validUntil: null,
    });
    expect(appointed.status).toBe(200);
    const removed = await change('second', {
      action: 'revoke',
      expectedAuthorityEpoch: await epoch(),
      grantId: seeded.id,
      expectedObjectGeneration: seeded.generation,
    });
    expect(removed.status).toBe(200);
    expect(await ceiling()).toEqual([{ active: false }]);
    await owner.query('SELECT access.link_seeded_platform_assignment_ceiling($1)', [first.id]);
    expect(await ceiling()).toEqual([{ active: false }]);
    const denied = await change('first', {
      action: 'create',
      expectedAuthorityEpoch: await epoch(),
      grantId: randomUUID(),
      permission: 'platform:use:saved-views',
      scopeId: 'platform:access',
      recipient: { principalId: third.id },
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(denied.status).toBe(403);
    const continued = await change('second', {
      action: 'create',
      expectedAuthorityEpoch: await epoch(),
      grantId: randomUUID(),
      permission: 'platform:use:saved-views',
      scopeId: 'platform:access',
      recipient: { principalId: third.id },
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(continued.status).toBe(200);
  } finally {
    await pool?.end();
    if (started)
      execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], {
        cwd: state,
        stdio: 'pipe',
      });
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
