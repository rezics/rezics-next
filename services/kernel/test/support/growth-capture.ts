import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg, { type Pool, type PoolClient } from 'pg';
import { createPool, withConnection } from '../../src/database/pool.ts';
import type { Capture } from './growth-cost.ts';

export type GrowthDatabase = {
  readonly url: string;
  /** createPool(url) from src/database/pool.ts with every connection instrumented; pass it to the code under test. */
  readonly pool: Pool;
  /** A plain pg.Pool (max 2), never explained, for seeding, VACUUM/ANALYZE and assertions. */
  readonly admin: pg.Pool;
  /** A plain pg.Pool for a library that takes its own pool; instrumented like `pool` and recorded in the same captures. */
  openPool(config?: Omit<pg.PoolConfig, 'connectionString'>): pg.Pool;
  close(): Promise<void>;
};

export type SeedingCount = { statements: number; rowsWritten: number };

type ActiveCapture = {
  statementRecords: StatementRecord[];
  plans: unknown[];
  readonly includeBackends: boolean;
  planBackends: (number | undefined)[];
  backgroundPlans: unknown[];
  backgroundPlanBackends: (number | undefined)[];
  pending: Set<Promise<void>>;
  error?: Error;
};
type StatementRecord = {
  readonly text: string;
  readonly background: boolean;
  readonly backend: number | undefined;
  failed: boolean;
  errorCode: string | null;
  planCount: number;
};
type Attribution = {
  readonly capture: ActiveCapture;
  readonly background: boolean;
  readonly parent?: Attribution;
};
type CaptureState = {
  active: ActiveCapture | undefined;
  seeding: SeedingCount | undefined;
  setupError?: Error;
  setupTasks: Set<Promise<void>>;
};

const states = new WeakMap<GrowthDatabase, CaptureState>();
const growing = new AsyncLocalStorage<Attribution | pg.Pool>();
const clientAttribution = new WeakMap<PoolClient, Attribution>();
const clientStatement = new WeakMap<PoolClient, StatementRecord | undefined>();
const scheduledWorkflowID = /^sched-.+-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?:-\d+)*$/;

function isAttribution(value: Attribution | pg.Pool | undefined): value is Attribution {
  return typeof value === 'object' && value !== null && 'capture' in value && 'background' in value;
}

function currentAttribution(state: CaptureState): Attribution | undefined {
  for (let current = growing.getStore(); isAttribution(current); current = current.parent)
    if (current.capture === state.active) return current;
  // DBOS executes queued workflows in its runner's async context, after the initiating operation has returned
  // control to the queue. Scheduled workflow IDs use `sched-${scheduleName}-${date.toISOString()}`; `startWorkflow`
  // derives child IDs by appending their function ID, so the same format identifies every scheduled descendant.
  // The SDK singleton is shared by kernel and auth workspaces in this test process.
  if (state.active && DBOS.workflowID !== undefined)
    return { capture: state.active, background: scheduledWorkflowID.test(DBOS.workflowID) };
  return undefined;
}

// PostgreSQL 19 omits foreign-key existence probes; derivations account for their bounded unique-index lookups.
// A connection starts with explaining off; it is switched on for the statements of a capture.
const setupStatements = [
  'SET max_parallel_workers_per_gather = 0',
  'SET jit = off',
  "SET work_mem = '4MB'",
  'SET random_page_cost = 4',
  "SET effective_cache_size = '4GB'",
  'SET effective_io_concurrency = 16',
  'SET default_statistics_target = 100',
  "LOAD 'auto_explain'",
  'SET auto_explain.log_min_duration = -1',
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

function planQueryTexts(document: unknown): string[] {
  const roots = Array.isArray(document) ? document : [document];
  return roots.flatMap((root) =>
    typeof root === 'object' && root !== null && 'Query Text' in root && typeof root['Query Text'] === 'string'
      ? [root['Query Text']]
      : [],
  );
}

function normalizedStatement(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

function backendPid(client: PoolClient): number | undefined {
  const processID = (client as PoolClient & { readonly processID?: unknown }).processID;
  return typeof processID === 'number' && Number.isSafeInteger(processID) ? processID : undefined;
}

const WRITE_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY']);
const MAY_RESET_SETTING = /^\s*(?:ROLLBACK|ABORT|COMMIT|END)\b/i;
const IN_FAILED_TRANSACTION = '25P02';

function countWrites(counter: SeedingCount | undefined, result: unknown): void {
  if (!counter) return;
  for (const item of Array.isArray(result) ? result : [result]) {
    if (typeof item !== 'object' || item === null || !('command' in item) || !('rowCount' in item)) continue;
    if (typeof item.command === 'string' && WRITE_COMMANDS.has(item.command) && typeof item.rowCount === 'number')
      counter.rowsWritten += item.rowCount;
  }
}

/**
 * Records the client's statements and the rows they write, and, when `explain` is set, turns auto_explain on for the
 * statements of a capture and off otherwise. Statements in the operation's async scope and statements issued inside
 * a DBOS workflow while a capture runs belong to the operation, even when the queue runner executes that workflow.
 * An unrelated workflow running during a capture is therefore counted as the operation's; that can only make a bound
 * stricter, never hide cost. If a spurious failure traces to one, switch to lineage tracking. Other work is background.
 * The switch is an ordinary SET sent ahead of the statement on the
 * client's own queue and never counted. A rollback, including one to a savepoint, or a failed statement can undo it,
 * so queued statements reassert it; a statement that ends a transaction sends none, since a failed transaction can
 * refuse it.
 */
function intercept(client: PoolClient, state: CaptureState, explain: boolean): (statement: string) => unknown {
  const query = client.query.bind(client) as PoolClient['query'];
  const pending: Array<Attribution | undefined> = [];
  const pendingStatements: Array<StatementRecord | undefined> = [];
  let suppressAttribution = false;
  // Whether auto_explain is on for this connection; undefined when a rollback or a failure may have undone it.
  let explaining: boolean | undefined = false;

  const refreshAttribution = (): void => {
    const attribution = pending[0];
    if (attribution) clientAttribution.set(client, attribution);
    else clientAttribution.delete(client);
    clientStatement.set(client, pendingStatements[0]);
  };

  const queryWithoutAttribution = (statement: string): unknown => {
    suppressAttribution = true;
    try {
      return client.query(statement);
    } finally {
      suppressAttribution = false;
    }
  };

  const switchTo = (wanted: boolean): void => {
    explaining = wanted;
    const task = Promise.resolve(
      queryWithoutAttribution(`SET auto_explain.log_min_duration = ${wanted ? 0 : -1}`),
    ).then(
      () => {},
      (error: unknown) => {
        explaining = undefined;
        if ((error as { code?: unknown } | null)?.code !== IN_FAILED_TRANSACTION) state.setupError ??= asError(error);
      },
    );
    state.setupTasks.add(task);
    void task.then(() => state.setupTasks.delete(task));
  };

  client.query = ((...args: Parameters<PoolClient['query']>) => {
    const text = statementText(args[0]);
    let attribution = suppressAttribution ? undefined : currentAttribution(state);
    if (!suppressAttribution && !attribution && state.active) attribution = { capture: state.active, background: true };
    let record: StatementRecord | undefined;
    if (explain && !suppressAttribution && text !== undefined && attribution) {
      const capture = attribution.capture;
      record = {
        text,
        background: attribution.background,
        backend: capture.includeBackends ? backendPid(client) : undefined,
        failed: false,
        errorCode: null,
        planCount: 0,
      };
      capture.statementRecords.push(record);
    }
    if (state.seeding && !suppressAttribution) state.seeding.statements++;
    if (explain && !suppressAttribution) {
      if (text === undefined || !MAY_RESET_SETTING.test(text)) {
        const wanted = state.active !== undefined;
        // A pg client queues concurrent queries. A preceding queued query may fail or roll back the transaction after
        // this call observes `explaining`, so reassert the setting between queued statements as well as on transitions.
        if (explaining !== wanted || pending.length > 0) switchTo(wanted);
      }
      // COMMIT can roll back an already-failed transaction, which also rolls back SET changes. Treat every end as
      // unknown and reassert on the next query; a successful commit simply repeats the harmless session setting.
      if (text !== undefined && MAY_RESET_SETTING.test(text)) explaining = undefined;
    }
    pending.push(attribution);
    pendingStatements.push(record);
    refreshAttribution();

    let completed = false;
    const done = (failed: boolean, result?: unknown, error?: unknown): void => {
      if (completed) return;
      completed = true;
      if (record) {
        record.failed = failed;
        if (failed) {
          const code = (error as { code?: unknown } | null)?.code;
          record.errorCode = typeof code === 'string' && code.length > 0 ? code : 'unknown';
        }
      }
      if (!failed) countWrites(state.seeding, result);
      else if (explain) explaining = undefined;
      pending.shift();
      pendingStatements.shift();
      refreshAttribution();
    };
    const callback = args.at(-1);
    const track = (task: Promise<void>): void => {
      if (!attribution) return;
      const capture = attribution.capture;
      capture.pending.add(task);
      void task.then(() => capture.pending.delete(task));
    };

    if (typeof callback === 'function') {
      let finishCapture: (() => void) | undefined;
      if (attribution) track(new Promise<void>((resolve) => (finishCapture = resolve)));
      const wrapped = (error: unknown, result?: unknown, ...rest: unknown[]): unknown => {
        done(Boolean(error), result, error);
        try {
          return (callback as (...values: unknown[]) => unknown)(error, result, ...rest);
        } finally {
          finishCapture?.();
        }
      };
      try {
        return (query as (...values: unknown[]) => unknown)(...args.slice(0, -1), wrapped);
      } catch (error) {
        done(true, undefined, error);
        finishCapture?.();
        throw error;
      }
    }
    let outcome: unknown;
    try {
      outcome = (query as (...values: unknown[]) => unknown)(...args);
    } catch (error) {
      done(true, undefined, error);
      throw error;
    }
    if (outcome instanceof Promise) {
      track(
        Promise.resolve(outcome).then(
          (result) => done(false, result),
          (error: unknown) => done(true, undefined, error),
        ),
      );
    } else if (typeof outcome === 'object' && outcome !== null && 'once' in outcome) {
      const stream = outcome as { once?: (event: string, listener: () => void) => unknown };
      if (typeof stream.once === 'function') {
        track(
          new Promise<void>((resolve) => {
            stream.once!('end', () => {
              done(false);
              resolve();
            });
            stream.once!('error', (...errors: unknown[]) => {
              const error = errors[0];
              done(true, undefined, error);
              resolve();
            });
          }),
        );
      } else done(false);
    } else {
      done(false);
    }
    return outcome;
  }) as PoolClient['query'];

  return queryWithoutAttribution;
}

function instrument(client: PoolClient, state: CaptureState): void {
  client.on('notice', (notice) => {
    const attribution = clientAttribution.get(client);
    const message = notice.message;
    const marker = 'plan:\n';
    if (!attribution || typeof message !== 'string' || !message.startsWith('duration:') || !message.includes(marker))
      return;

    try {
      const plan = JSON.parse(message.slice(message.indexOf(marker) + marker.length)) as unknown;
      const capture = attribution.capture;
      const statement = clientStatement.get(client);
      if (
        statement &&
        planQueryTexts(plan).some((text) => normalizedStatement(text) === normalizedStatement(statement.text))
      )
        statement.planCount++;
      (attribution.background ? capture.backgroundPlans : capture.plans).push(plan);
      if (capture.includeBackends)
        (attribution.background ? capture.backgroundPlanBackends : capture.planBackends).push(backendPid(client));
    } catch (error) {
      attribution.capture.error ??= asError(error);
    }
  });

  const queryWithoutAttribution = intercept(client, state, true);
  const setupQueries = setupStatements.map((statement) => queryWithoutAttribution(statement));
  const setupTask = Promise.allSettled(setupQueries).then((results) => {
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') state.setupError ??= asError(failed.reason);
  });
  state.setupTasks.add(setupTask);
  void setupTask.then(() => state.setupTasks.delete(setupTask));
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
  const state: CaptureState = { active: undefined, seeding: undefined, setupTasks: new Set() };
  admin.on('connect', (client) => intercept(client, state, false));
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
  options: { readonly includeBackends?: boolean } = {},
): Promise<{ value: T; capture: Capture }> {
  const state = states.get(database);
  if (!state) throw new Error('Growth database was not opened by openGrowthDatabase');
  if (state.active) throw new Error('A growth capture is already active for this database');
  if (state.setupError) throw state.setupError;

  const active: ActiveCapture = {
    statementRecords: [],
    plans: [],
    includeBackends: options.includeBackends === true,
    planBackends: [],
    backgroundPlans: [],
    backgroundPlanBackends: [],
    pending: new Set(),
  };
  state.active = active;
  try {
    // Captures for separate databases can nest in one operation, such as Kernel calling Auth.
    const parent = growing.getStore();
    let value!: T;
    let operationError: unknown;
    let operationFailed = false;
    try {
      value = await growing.run(
        { capture: active, background: false, ...(isAttribution(parent) ? { parent } : {}) },
        operation,
      );
    } catch (error) {
      operationError = error;
      operationFailed = true;
    }
    // node-postgres delivers a query's notices before its completion. Await every tracked query so its plan has been
    // recorded before returning, including queries the operation queued without awaiting itself.
    while (active.pending.size > 0 || state.setupTasks.size > 0) {
      const pending = [...active.pending, ...state.setupTasks];
      if (pending.length > 0) await Promise.all(pending);
    }
    if (operationFailed) throw operationError;
    if (state.setupError) throw state.setupError;
    if (active.error) throw active.error;
    const foreground = active.statementRecords.filter(({ background }) => !background);
    const background = active.statementRecords.filter(({ background }) => background);
    return {
      value,
      capture: {
        statements: foreground.map(({ text }) => text),
        plans: active.plans,
        statementErrors: foreground.map(({ errorCode }) => errorCode),
        ...(active.includeBackends
          ? { statementBackends: foreground.map(({ backend }) => backend), planBackends: active.planBackends }
          : {}),
        backgroundStatements: background.map(({ text }) => text),
        backgroundPlans: active.backgroundPlans,
        backgroundStatementErrors: background.map(({ errorCode }) => errorCode),
        ...(active.includeBackends
          ? {
              backgroundStatementBackends: background.map(({ backend }) => backend),
              backgroundPlanBackends: active.backgroundPlanBackends,
            }
          : {}),
      },
    };
  } finally {
    state.active = undefined;
  }
}

/**
 * Runs `grow` for checkGrowth: counts the statements and written rows of every pool the database hands out, and lets
 * `seed` see that its caller vacuums afterwards.
 */
export async function trackGrow<T>(
  database: GrowthDatabase,
  grow: () => Promise<T>,
): Promise<{ value: T; seeding: SeedingCount }> {
  const state = states.get(database);
  if (!state) throw new Error('Growth database was not opened by openGrowthDatabase');
  if (state.seeding) throw new Error('A growth is already running for this database');

  const seeding: SeedingCount = { statements: 0, rowsWritten: 0 };
  state.seeding = seeding;
  try {
    const value = await growing.run(database.admin, grow);
    return { value, seeding: { ...seeding } };
  } finally {
    state.seeding = undefined;
  }
}

/** Whether `admin` belongs to a database whose checkGrowth is inside `grow`, and vacuums when `grow` returns. */
export function vacuumFollows(admin: pg.Pool): boolean {
  return growing.getStore() === admin;
}
