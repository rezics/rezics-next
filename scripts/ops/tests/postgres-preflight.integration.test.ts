import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { checkPostgresOwners, postgresPreflightConfig } from '../postgres-preflight.ts';
import { migrateOwners, repositoryRoot } from '../migrate.ts';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';

test('administrator provisioning is idempotent, requires restart and restores inherited owner diagnostics without data grants', async () => {
  const cluster = await startPostgresCluster({
    role: 'postgres',
    serverSettings: 'max_prepared_transactions = 4',
  });
  let admin: Pool | undefined;
  try {
    const url = (owner: string) => `postgres://${owner}@127.0.0.1:${cluster.port}/postgres`;
    const connectAdmin = () =>
      new Pool({
        ...cluster.connection,
        max: 1,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 5_000,
      });
    admin = connectAdmin();
    await admin.query(
      'CREATE ROLE account LOGIN; CREATE ROLE access LOGIN NOINHERIT; CREATE ROLE content LOGIN; CREATE ROLE relay LOGIN',
    );
    const env = {
      ACCOUNT_DATABASE_URL: url('account'),
      ACCESS_DATABASE_URL: url('access'),
      CONTENT_DATABASE_URL: url('content'),
      MAIN_RELAY_DATABASE_URL: url('relay'),
    };
    const provision = () =>
      execFileSync(
        'psql',
        [
          '-X',
          '-h',
          '127.0.0.1',
          '-p',
          String(cluster.port),
          '-U',
          'postgres',
          '-d',
          'postgres',
          '--set=ON_ERROR_STOP=1',
          '--file=infra/release/postgres-provision.sql',
        ],
        { cwd: repositoryRoot, stdio: 'pipe', timeout: 15_000 },
      );
    provision();
    provision();
    await admin.query('SELECT pg_reload_conf()');
    await expect(checkPostgresOwners(env)).rejects.toThrow('active max_prepared_transactions=0');
    await expect(migrateOwners({ ...env, NODE_ENV: 'production' })).rejects.toThrow(
      'active max_prepared_transactions=0',
    );
    expect(
      (await admin.query("SELECT to_regclass('public.rezics_local_migration') AS relation")).rows[0]
        .relation,
    ).toBeNull();
    await admin.end();
    admin = undefined;
    cluster.stop('fast');
    cluster.start();
    admin = connectAdmin();
    await expect(checkPostgresOwners(env)).resolves.toBeUndefined();
    const privileges = (
      await admin.query(`SELECT rolname, rolsuper,
      pg_has_role(rolname, 'pg_read_all_stats', 'USAGE') AS diagnostics,
      pg_has_role(rolname, 'pg_read_all_data', 'MEMBER') AS all_data,
      pg_has_role(rolname, 'pg_monitor', 'MEMBER') AS monitor
      FROM pg_roles WHERE rolname IN ('account','access','content','relay') ORDER BY rolname`)
    ).rows;
    expect(privileges).toEqual(
      ['access', 'account', 'content', 'relay'].map((role) => ({
        rolname: role,
        rolsuper: false,
        diagnostics: ['access', 'content'].includes(role),
        all_data: false,
        monitor: false,
      })),
    );
    for (const owner of ['access', 'content']) {
      await admin.query(`GRANT pg_read_all_stats TO ${owner} WITH INHERIT FALSE`);
      expect(
        (
          await admin.query(
            `SELECT pg_has_role('${owner}', 'pg_read_all_stats', 'MEMBER') AS member`,
          )
        ).rows[0].member,
      ).toBe(true);
      await expect(checkPostgresOwners(env)).rejects.toThrow(
        `(${owner}): requires inherited pg_read_all_stats`,
      );
      provision();
      await expect(checkPostgresOwners(env)).resolves.toBeUndefined();
      await admin.query(`REVOKE pg_read_all_stats FROM ${owner}`);
      await expect(checkPostgresOwners(env)).rejects.toThrow(
        `(${owner}): requires inherited pg_read_all_stats`,
      );
      provision();
    }
    await expect(
      checkPostgresOwners({ ...env, CONTENT_DATABASE_URL: url('access') }),
    ).rejects.toThrow('(content): connect using the matching owner role');
    await admin.query('ALTER ROLE content SUPERUSER');
    await expect(checkPostgresOwners(env)).rejects.toThrow(
      '(content): owner role must not be superuser',
    );
    await admin.query('ALTER ROLE content NOSUPERUSER');
    const bounded = new Client(
      postgresPreflightConfig(
        `${url('access')}?options=-c%20default_transaction_read_only%3Doff&statement_timeout=0&lock_timeout=0&query_timeout=0`,
      ),
    );
    try {
      await bounded.connect();
      expect(
        (await bounded.query('SHOW default_transaction_read_only')).rows[0]
          .default_transaction_read_only,
      ).toBe('on');
      expect((await bounded.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('5s');
      expect((await bounded.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('1s');
      await expect(bounded.query('CREATE TABLE forbidden_write(id integer)')).rejects.toThrow(
        'read-only',
      );
      await expect(bounded.query('SELECT pg_sleep(30)')).rejects.toThrow('statement timeout');
    } finally {
      await bounded.end();
    }
    const envFile = join(cluster.directory, 'production.env');
    writeFileSync(
      envFile,
      Object.entries(env)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n'),
    );
    const accepted = Bun.spawn(['task', 'ops:postgres-preflight', '--', envFile], {
      cwd: repositoryRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [acceptedCode, acceptedOutput] = await Promise.all([
      accepted.exited,
      new Response(accepted.stdout).text(),
    ]);
    expect(acceptedCode).toBe(0);
    expect(acceptedOutput).toContain('PostgreSQL owner diagnostics verified');
    writeFileSync(
      envFile,
      Object.entries({ ...env, ACCOUNT_DATABASE_URL: url('secret-role') })
        .map(([name, value]) => `${name}=${value}`)
        .join('\n'),
    );
    const rejected = Bun.spawn(['task', 'ops:postgres-preflight', '--', envFile], {
      cwd: repositoryRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [rejectedCode, stdout, stderr] = await Promise.all([
      rejected.exited,
      new Response(rejected.stdout).text(),
      new Response(rejected.stderr).text(),
    ]);
    expect(rejectedCode).not.toBe(0);
    expect(stderr).toContain('(account): connection or diagnostic query failed');
    expect(stdout + stderr).not.toMatch(/secret-role|postgres:\/\/|FATAL/);
    await expect(checkPostgresOwners(env)).resolves.toBeUndefined();
  } finally {
    await admin?.end();
    cluster.remove();
  }
}, 90_000);
