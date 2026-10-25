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

type ActiveCapture = { statements: string[]; plans: unknown[]; error?: Error };
type CaptureState = { active: ActiveCapture | undefined; setupError?: Error; setupTasks: Set<Promise<void>> };

const states = new WeakMap<GrowthDatabase, CaptureState>();

// PostgreSQL 19 omits foreign-key existence probes; derivations account for their bounded unique-index lookups.
const setupStatements = [
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

function instrument(client: PoolClient, state: CaptureState): void {
  const query = client.query.bind(client) as PoolClient['query'];
  client.on('notice', (notice) => {
    const active = state.active;
    const message = notice.message;
    const marker = 'plan:\n';
    if (!active || typeof message !== 'string' || !message.startsWith('duration:') || !message.includes(marker)) return;

    try {
      active.plans.push(JSON.parse(message.slice(message.indexOf(marker) + marker.length)) as unknown);
    } catch (error) {
      active.error ??= asError(error);
    }
  });

  const setupQueries = setupStatements.map((statement) => query(statement));
  const setupTask = Promise.allSettled(setupQueries).then((results) => {
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') state.setupError ??= asError(failed.reason);
  });
  state.setupTasks.add(setupTask);
  void setupTask.then(() => state.setupTasks.delete(setupTask));

  client.query = ((...args: Parameters<PoolClient['query']>) => {
    const text = statementText(args[0]);
    if (text !== undefined) state.active?.statements.push(text);
    return query(...args);
  }) as PoolClient['query'];
}

function instrumentPool(pool: Pool, state: CaptureState): void {
  pool.on('connect', (client) => instrument(client, state));
}

export async function openGrowthDatabase(url = process.env.DATABASE_URL): Promise<GrowthDatabase> {
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');

  const pool = createPool(url);
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

  const active: ActiveCapture = { statements: [], plans: [] };
  state.active = active;
  try {
    const value = await operation();
    await Promise.all([...state.setupTasks]);
    if (state.setupError) throw state.setupError;
    if (active.error) throw active.error;
    return { value, capture: { statements: active.statements, plans: active.plans } };
  } finally {
    state.active = undefined;
  }
}
