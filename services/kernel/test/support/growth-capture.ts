import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg, { type Pool, type PoolClient } from 'pg';
import { createPool, withConnection } from '../../src/database/pool.ts';
import type { Capture } from './growth-cost.ts';

export type GrowthDatabase = {
  readonly url: string;
  /** createPool(url) from src/database/pool.ts with every connection instrumented; pass it to the code under test. */
  readonly pool: Pool;
  /** A plain pg.Pool (max 2), not instrumented, for seeding, VACUUM/ANALYZE and assertions. */
  readonly admin: pg.Pool;
  /** A plain pg.Pool for a library that takes its own pool; instrumented like `pool` and recorded in the same captures. */
  openPool(config?: Omit<pg.PoolConfig, 'connectionString'>): pg.Pool;
  close(): Promise<void>;
};

type ActiveCapture = {
  statements: string[];
  plans: unknown[];
  backgroundStatements: string[];
  backgroundPlans: unknown[];
  pending: Set<Promise<void>>;
  error?: Error;
};
type Attribution = {
  readonly capture: ActiveCapture;
  readonly background: boolean;
  readonly parent?: Attribution;
};
type CaptureState = { active: ActiveCapture | undefined; setupError?: Error; setupTasks: Set<Promise<void>> };

const states = new WeakMap<GrowthDatabase, CaptureState>();
const growing = new AsyncLocalStorage<Attribution>();
const clientAttribution = new WeakMap<PoolClient, Attribution>();

function isAttribution(value: Attribution | undefined): value is Attribution {
  return typeof value === 'object' && value !== null && 'capture' in value && 'background' in value;
}

function currentAttribution(state: CaptureState): Attribution | undefined {
  for (let current = growing.getStore(); isAttribution(current); current = current.parent)
    if (current.capture === state.active) return current;
  // DBOS executes queued workflows in its runner's async context, after the initiating operation has returned
  // control to the queue. The SDK singleton is shared by kernel and auth workspaces in this test process.
  if (state.active && DBOS.workflowID !== undefined) return { capture: state.active, background: false };
  return undefined;
}

// PostgreSQL 19 omits foreign-key existence probes; derivations account for their bounded unique-index lookups.
const setupStatements = [
  'SET max_parallel_workers_per_gather = 0',
  'SET jit = off',
  "SET work_mem = '4MB'",
  'SET random_page_cost = 4',
  "SET effective_cache_size = '4GB'",
  'SET effective_io_concurrency = 16',
  'SET default_statistics_target = 100',
  "LOAD 'auto_explain'",
  'SET auto_explain.log_min_duration = 0',
  'SET auto_explain.log_analyze = on',
  'SET auto_explain.log_buffers = on',
  'SET auto_explain.log_timing = off',
  'SET auto_explain.log_triggers = off',
  'SET auto_explain.log_verbose = on',
  'SET auto_explain.log_nested_statements = on',
  "SET auto_explain.log_format = 'json'",
  "SET auto_explain.log_level = 'notice'",
  'SET auto_explain.sample_rate = 1',
  'SET client_min_messages = notice',
];

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function statementText(query: unknown): string | undefined {
  if (typeof query === 'string') return query;
  if (typeof query !== 'object' || query === null || !('text' in query)) return undefined;
  return typeof query.text === 'string' ? query.text : undefined;
}

function intercept(client: PoolClient, state: CaptureState): void {
  const query = client.query.bind(client) as PoolClient['query'];
  const pending: Attribution[] = [];
  let inFlight: Attribution | undefined;

  client.query = ((...args: Parameters<PoolClient['query']>) => {
    const text = statementText(args[0]);
    let attribution = currentAttribution(state);
    if (!attribution && state.active) attribution = { capture: state.active, background: true };
    if (text !== undefined && attribution) {
      (attribution.background ? attribution.capture.backgroundStatements : attribution.capture.statements).push(text);
    }
    if (attribution) {
      pending.push(attribution);
      inFlight ??= attribution;
      clientAttribution.set(client, inFlight);
    }

    const done = (): void => {
      if (!attribution) return;
      pending.shift();
      inFlight = pending[0];
      if (inFlight) clientAttribution.set(client, inFlight);
      else clientAttribution.delete(client);
    };
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      let finishBackground: (() => void) | undefined;
      if (attribution?.background) {
        const task = new Promise<void>((resolve) => (finishBackground = resolve));
        attribution.capture.pending.add(task);
        void task.then(() => attribution!.capture.pending.delete(task));
      }
      const wrapped = (error: unknown, result?: unknown, ...rest: unknown[]): unknown => {
        done();
        finishBackground?.();
        return (callback as (...values: unknown[]) => unknown)(error, result, ...rest);
      };
      return (query as (...values: unknown[]) => unknown)(...args.slice(0, -1), wrapped);
    }

    const outcome = (query as (...values: unknown[]) => unknown)(...args);
    if (outcome instanceof Promise) {
      if (attribution?.background) {
        const task = Promise.resolve(outcome).then(
          () => {},
          () => {},
        );
        attribution.capture.pending.add(task);
        void task.then(() => attribution!.capture.pending.delete(task));
      }
      outcome.then(done, done);
    }
    return outcome;
  }) as PoolClient['query'];
}

function instrument(client: PoolClient, state: CaptureState): void {
  const query = client.query.bind(client) as PoolClient['query'];
  client.on('notice', (notice) => {
    const attribution = clientAttribution.get(client);
    const message = notice.message;
    const marker = 'plan:\n';
    if (!attribution || typeof message !== 'string' || !message.startsWith('duration:') || !message.includes(marker))
      return;

    try {
      (attribution.background ? attribution.capture.backgroundPlans : attribution.capture.plans).push(
        JSON.parse(message.slice(message.indexOf(marker) + marker.length)) as unknown,
      );
    } catch (error) {
      attribution.capture.error ??= asError(error);
    }
  });

  const setupQueries = setupStatements.map((statement) => query(statement));
  const setupTask = Promise.allSettled(setupQueries).then((results) => {
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') state.setupError ??= asError(failed.reason);
  });
  state.setupTasks.add(setupTask);
  void setupTask.then(() => state.setupTasks.delete(setupTask));

  intercept(client, state);
}

function instrumentPool(pool: Pool, state: CaptureState): void {
  pool.on('connect', (client) => instrument(client, state));
  const query = pool.query.bind(pool) as Pool['query'];
  (pool as Pool & { query: Pool['query'] }).query = ((...args: Parameters<Pool['query']>) => {
    const attribution =
      currentAttribution(state) ?? (state.active ? { capture: state.active, background: true } : undefined);
    return attribution ? growing.run(attribution, () => query(...args)) : query(...args);
  }) as Pool['query'];

  const connect = pool.connect.bind(pool) as Pool['connect'];
  (pool as Pool & { connect: Pool['connect'] }).connect = ((callback?: Parameters<Pool['connect']>[0]) => {
    const attribution =
      currentAttribution(state) ?? (state.active ? { capture: state.active, background: true } : undefined);
    const bind = <T extends (...args: never[]) => unknown>(fn: T): T => {
      const resource = new AsyncResource('growth-pool-checkout');
      return resource.bind((...args: Parameters<T>) =>
        attribution ? growing.run(attribution, () => fn(...args)) : fn(...args),
      ) as T;
    };
    if (callback) return connect(bind(callback));
    return new Promise((resolve, reject) => {
      connect((error, client) => {
        if (error) reject(error);
        else resolve(client);
      });
    }) as unknown as ReturnType<Pool['connect']>;
  }) as unknown as Pool['connect'];
}

export async function openGrowthDatabase(url = process.env.DATABASE_URL): Promise<GrowthDatabase> {
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');

  const pool = createPool(url, { connectionTimeoutMillis: 10_000 });
  const admin = new pg.Pool({ connectionString: url, max: 2 });
  const libraryPools = new Set<pg.Pool>();
  const state: CaptureState = { active: undefined, setupTasks: new Set() };
  const database: GrowthDatabase = {
    url,
    pool,
    admin,
    openPool: (config = {}) => {
      const libraryPool = new pg.Pool({ ...config, connectionString: url });
      instrumentPool(libraryPool, state);
      libraryPools.add(libraryPool);
      return libraryPool;
    },
    close: async () => {
      await Promise.all([pool.end(), admin.end(), ...Array.from(libraryPools, (libraryPool) => libraryPool.end())]);
    },
  };
  states.set(database, state);
  instrumentPool(pool, state);

  try {
    const result = await capture(database, () => withConnection(pool, (client) => client.query('SELECT 1')));
    if (result.capture.statements.length !== 1 || result.capture.plans.length !== 1)
      throw new Error('The auto_explain probe did not produce exactly one statement and one plan');
  } catch (error) {
    await Promise.allSettled([pool.end(), admin.end()]);
    throw new Error('auto_explain plans were not reported; growth checks need a superuser test database', {
      cause: error,
    });
  }

  return database;
}

export async function capture<T>(
  database: GrowthDatabase,
  operation: () => Promise<T>,
): Promise<{ value: T; capture: Capture }> {
  const state = states.get(database);
  if (!state) throw new Error('Growth database was not opened by openGrowthDatabase');
  if (state.active) throw new Error('A growth capture is already active for this database');
  if (state.setupError) throw state.setupError;

  const active: ActiveCapture = {
    statements: [],
    plans: [],
    backgroundStatements: [],
    backgroundPlans: [],
    pending: new Set(),
  };
  state.active = active;
  try {
    // Captures for separate databases can nest in one operation, such as Kernel calling Auth.
    const parent = growing.getStore();
    const value = await growing.run(
      { capture: active, background: false, ...(isAttribution(parent) ? { parent } : {}) },
      operation,
    );
    state.active = undefined;
    await Promise.all([...active.pending]);
    await Promise.all([...state.setupTasks]);
    if (state.setupError) throw state.setupError;
    if (active.error) throw active.error;
    return {
      value,
      capture: {
        statements: active.statements,
        plans: active.plans,
        backgroundStatements: active.backgroundStatements,
        backgroundPlans: active.backgroundPlans,
      },
    };
  } finally {
    state.active = undefined;
  }
}
