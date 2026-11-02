import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { GrowthSettleInfrastructureError, settle, settleAdmin, type GrowthDatabase } from './growth-capture.ts';
import { quotedRelationIdentity } from './growth-relation-identity.ts';

function vacuumAdmin(options: {
  readonly vacuumError: Error;
  readonly metadataError?: Error;
  readonly releaseError?: Error;
  readonly url?: string;
  readonly connectionDatabase?: string;
}) {
  const poolQueries: string[] = [];
  const releases: unknown[] = [];
  let held = false;
  const url = options.url ?? 'postgres://localhost/from-url';
  const client = {
    connectionParameters:
      options.connectionDatabase === undefined ? undefined : { database: options.connectionDatabase },
    async query(sql: string) {
      if (sql.startsWith('VACUUM')) throw options.vacuumError;
      return { rows: [] };
    },
    release(discard?: unknown) {
      held = false;
      releases.push(discard);
      if (options.releaseError) throw options.releaseError;
    },
  };
  const admin = {
    options: { connectionString: url },
    async query(sql: string) {
      if (held) throw new Error('admin pool checkout while the VACUUM client is held');
      poolQueries.push(sql);
      if (sql.includes('current_database')) {
        throw options.metadataError ?? new Error('diagnostic current_database query must not run');
      }
      return { rows: [] };
    },
    async connect() {
      if (held) throw new Error('admin pool checkout while the VACUUM client is held');
      held = true;
      return client;
    },
  } as unknown as Pool;
  const database: GrowthDatabase = {
    url,
    pool: admin,
    admin,
    openPool: () => {
      throw new Error('test admin cannot open instrumented pools');
    },
    close: async () => {},
  };
  return { admin, database, poolQueries, releases };
}

test('settle quotes identity components and refuses ambiguous qualified strings', async () => {
  const vacuum: string[] = [];
  const client = {
    connectionParameters: { database: 'app' },
    async query(sql: string) {
      if (sql.startsWith('VACUUM')) vacuum.push(sql);
      return { rows: [] };
    },
    release() {},
  };
  const admin = {
    options: { connectionString: 'postgres://localhost/app' },
    async query() {
      return { rows: [] };
    },
    async connect() {
      return client;
    },
  } as unknown as Pool;
  const database: GrowthDatabase = {
    url: 'postgres://localhost/app',
    pool: admin,
    admin,
    openPool: () => {
      throw new Error('test admin cannot open instrumented pools');
    },
    close: async () => {},
  };
  const identity = { kind: 'relation' as const, schema: 'sales.region', name: 'items.v1' };
  await settle(database, { relations: [identity, 'public.rows', identity] });
  expect(vacuum).toEqual([
    `VACUUM (INDEX_CLEANUP ON) ${quotedRelationIdentity(identity)}`,
    'VACUUM (INDEX_CLEANUP ON) "public"."rows"',
  ]);
  await expect(settle(database, { relations: ['sales.region.items'] })).rejects.toThrow(
    /Ambiguous legacy relation sales.region.items/,
  );
});

test('a failing VACUUM on a single-client admin pool reports the original failure without another checkout', async () => {
  const vacuumError = new Error('relation "public.missing" does not exist');
  const fixture = vacuumAdmin({ vacuumError, connectionDatabase: 'physical' });
  await expect(settle(fixture.database, { relations: ['public.missing'] })).rejects.toMatchObject({
    name: 'GrowthSettleInfrastructureError',
    message: 'Could not settle database physical relation public.missing: relation "public.missing" does not exist',
    cause: vacuumError,
  });
  expect(fixture.poolQueries.some((sql) => sql.includes('current_database'))).toBe(false);
  expect(fixture.releases).toEqual([undefined]);
});

test('a broken connection cannot mask a VACUUM failure with a diagnostic query', async () => {
  const vacuumError = Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });
  const fixture = vacuumAdmin({
    vacuumError,
    metadataError: new Error('could not read current_database'),
  });
  const failure = await settleAdmin(fixture.admin, { relations: ['public.rows'] }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(GrowthSettleInfrastructureError);
  expect(failure).toMatchObject({
    message: 'Could not settle database from-url relation public.rows: Connection terminated unexpectedly',
    cause: vacuumError,
  });
  expect(fixture.poolQueries.some((sql) => sql.includes('current_database'))).toBe(false);
  expect(fixture.releases).toEqual([true]);
});

test('a later client release failure stays subordinate to the VACUUM failure', async () => {
  const vacuumError = new Error('vacuum failed');
  const fixture = vacuumAdmin({
    vacuumError,
    releaseError: new Error('release failed'),
    connectionDatabase: 'app',
  });
  const failure = await settle(fixture.database, { relations: ['public.rows'] }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(GrowthSettleInfrastructureError);
  expect((failure as Error).message).toBe(
    'Could not settle database app relation public.rows: vacuum failed; cleanup failed: release failed',
  );
  const primary = (failure as Error).cause;
  expect(primary).toBeInstanceOf(GrowthSettleInfrastructureError);
  expect((primary as Error).cause).toBe(vacuumError);
});
