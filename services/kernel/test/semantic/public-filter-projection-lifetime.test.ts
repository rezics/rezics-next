import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { retainedPublicFilterProjectionDependenciesCurrent } from '../../src/semantic/public-filter-projection.ts';
import type { PublicFilterProjectionPage } from '../../src/semantic/public-filter-source-contract.ts';

const routes = [0x0101, 0x1212, 0x2323] as const;
const [subject, terminal, foreign] = routes.map(newId);
const homes = routes.map(partitionOf);
const page: Extract<PublicFilterProjectionPage, { status: 'progress' | 'complete' }> = {
  status: 'progress',
  source: {
    partition: homes[0]!,
    epoch: 7,
    position: 13n,
    subject: subject!,
    terminal: terminal!,
    revision: 4,
    securityRevision: 'security-4',
    currentRelease: 'release-4',
  },
  records: [],
  repairLocators: [
    {
      subject: subject!,
      slot: newId(routes[0]),
      candidate: newId(routes[0]),
      property: 'schema:author',
      dependencies: [
        { kind: 'subject', route: routes[0], subject: subject! },
        { kind: 'subject', route: routes[2], subject: foreign! },
        { kind: 'subject', route: routes[2], subject: foreign! },
      ],
    },
  ],
  frontier: { build: newId(routes[0]), generation: 2n, continuation: 'original' },
  cost: {
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  },
};
const request = { page, meaning: { digest: 'meaning-4', type: 'schema:Book' } };
const buildRow = {
  build_id: page.frontier.build,
  generation: String(page.frontier.generation),
  route: routes[0],
  owner_epoch: page.source.epoch,
  source_position: String(page.source.position),
  privacy_position: '11',
  terminal_id: page.source.terminal,
  subject_revision: page.source.revision,
  security_revision: page.source.securityRevision,
  current_release: page.source.currentRelease,
};
const headRow = { owner_epoch: 7, position: '11', epoch: 7, write_state: 'active', current_position: '11' };

function result(rows: Record<string, unknown>[] = []) {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fakeClient(
  query: (sql: string, values: readonly unknown[]) => ReturnType<typeof result> | Promise<ReturnType<typeof result>>,
  release: (error?: Error | boolean) => void = () => {},
): PoolClient {
  return {
    query(input: QueryConfig | string, values?: unknown[]) {
      const sql = typeof input === 'string' ? input : input.text;
      const operands = typeof input === 'string' ? (values ?? []) : (input.values ?? []);
      return Promise.resolve().then(() => query(sql, operands));
    },
    release,
  } as unknown as PoolClient;
}

function fakePool(connect: () => Promise<PoolClient>): Pool {
  return {
    connect,
    query() {
      throw new Error('Retained reads escaped the admitted client');
    },
  } as unknown as Pool;
}

const isBuild = (sql: string) => sql.includes('FROM semantic.public_filter_projection_build');
const isHead = (sql: string) => sql.includes('FROM semantic.public_filter_projection_head e');
const partitionArgument = (values: readonly unknown[]) => values.find((value): value is number => typeof value === 'number');
const read = (pool: Pool, deadline = Date.now() + 500) =>
  retainedPublicFilterProjectionDependenciesCurrent(pool, request, { deadline });

test('retained build and unique original heads share one bounded snapshot', async () => {
  const submitted: { sql: string; values: readonly unknown[] }[] = [];
  let checkouts = 0;
  let releases = 0;
  const pool = fakePool(async () => {
    checkouts++;
    return fakeClient(
      (sql, values) => {
        submitted.push({ sql, values });
        return result(isBuild(sql) ? [buildRow] : isHead(sql) ? [headRow] : []);
      },
      () => releases++,
    );
  });

  expect(new Set(homes).size).toBe(3);
  expect(await read(pool)).toBe(true);
  expect(checkouts).toBe(1);
  expect(releases).toBe(1);
  expect(submitted).toHaveLength(7);
  expect(submitted[0]?.sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(submitted[1]?.sql.startsWith('SET LOCAL statement_timeout')).toBe(true);
  expect(submitted.at(-1)?.sql).toBe('COMMIT');
  expect(submitted.filter(({ sql }) => isBuild(sql))).toHaveLength(1);
  const heads = submitted.filter(({ sql }) => isHead(sql));
  expect(heads).toHaveLength(3);
  expect(heads.map(({ values }) => partitionArgument(values)).sort()).toEqual([...homes].sort());
  expect(heads.every(({ values }) => values.includes(page.frontier.build))).toBe(true);
});

test('changed retained head cannot validate the original page', async () => {
  let released = false;
  const pool = fakePool(async () =>
    fakeClient(
      (sql, values) =>
        result(
          isBuild(sql)
            ? [buildRow]
            : isHead(sql)
              ? [{ ...headRow, current_position: partitionArgument(values) === homes[2] ? '12' : '11' }]
              : [],
        ),
      () => { released = true; },
    ),
  );
  expect(await read(pool)).toBe(false);
  expect(released).toBe(true);
});

test('queued expiry releases a late checkout without SQL and a later retained read succeeds', async () => {
  const checkout = deferred<PoolClient>();
  const released = deferred<Error | boolean | undefined>();
  const lateSql: string[] = [];
  let checkouts = 0;
  const pool = fakePool(async () => {
    checkouts++;
    if (checkouts === 1) return checkout.promise;
    return fakeClient((sql) => result(isBuild(sql) ? [buildRow] : isHead(sql) ? [headRow] : []));
  });

  await expect(read(pool, Date.now() + 40)).rejects.toBeInstanceOf(AccessUnavailableError);
  checkout.resolve(fakeClient((sql) => { lateSql.push(sql); return result(); }, (error) => released.resolve(error)));
  expect(await released.promise).toBeUndefined();
  expect(lateSql).toEqual([]);
  expect(await read(pool)).toBe(true);
  expect(checkouts).toBe(2);
});

test('settled native failure keeps its cause when rollback expires and the next request succeeds', async () => {
  const failure = Object.assign(new Error('retained build read failed'), { code: '23505', severity: 'ERROR' });
  const released = deferred<Error | boolean | undefined>();
  const never = new Promise<ReturnType<typeof result>>(() => {});
  let checkouts = 0;
  const pool = fakePool(async () => {
    checkouts++;
    if (checkouts === 1)
      return fakeClient(
        (sql) => isBuild(sql) ? Promise.reject(failure) : sql === 'ROLLBACK' ? never : result(),
        (error) => released.resolve(error),
      );
    return fakeClient((sql) => result(isBuild(sql) ? [buildRow] : isHead(sql) ? [headRow] : []));
  });

  expect(await read(pool, Date.now() + 200).catch((error: unknown) => error)).toBe(failure);
  expect(await released.promise).toBeInstanceOf(Error);
  expect(await read(pool)).toBe(true);
  expect(checkouts).toBe(2);
});
