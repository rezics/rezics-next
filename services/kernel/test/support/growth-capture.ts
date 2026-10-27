import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg, { type Pool, type PoolClient } from 'pg';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { costOf, type Capture } from './growth-cost.ts';

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
  attributedStatements: Array<{ statement: string; attribution: 'operation' | 'workflow' | 'background' }>;
  attributedPlans: Array<{ plan: unknown; attribution: 'operation' | 'workflow' | 'background' }>;
  pending: Set<Promise<void>>;
  error?: Error;
};
type Attribution = {
  readonly capture: ActiveCapture;
  readonly background: boolean;
  readonly workflow?: boolean;
  readonly parent?: Attribution;
};
type CaptureState = {
  active: ActiveCapture | undefined;
  setupError?: Error;
  setupTasks: Set<Promise<void>>;
  captureSequence: number;
};

const states = new WeakMap<GrowthDatabase, CaptureState>();
const growing = new AsyncLocalStorage<Attribution>();
const clientAttribution = new WeakMap<PoolClient, Attribution>();

function isAttribution(value: Attribution | undefined): value is Attribution {
  return typeof value === 'object' && value !== null && 'capture' in value && 'background' in value;
}

function currentAttribution(state: CaptureState): Attribution | undefined {
  for (let current = growing.getStore(); isAttribution(current); current = current.parent)
    if (current.capture === state.active)
      return DBOS.workflowID === undefined ? current : { ...current, workflow: true };
  // DBOS executes queued workflows in its runner's async context, after the initiating operation has returned
  // control to the queue. The SDK singleton is shared by kernel and auth workspaces in this test process.
  if (state.active && DBOS.workflowID !== undefined)
    return { capture: state.active, background: false, workflow: true };
  return undefined;
}

function attributionKind(attribution: Attribution): 'operation' | 'workflow' | 'background' {
  if (attribution.background) return 'background';
  return attribution.workflow ? 'workflow' : 'operation';
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

function planEntries(documents: readonly unknown[]): Array<{ queryText?: string; plan: Record<string, unknown> }> {
  const entries: Array<{ queryText?: string; plan: Record<string, unknown> }> = [];
  const add = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) add(entry);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (typeof record['Node Type'] === 'string') {
      entries.push({ plan: record });
      return;
    }
    if (typeof record.Plan === 'object' && record.Plan !== null && !Array.isArray(record.Plan)) {
      entries.push({
        ...(typeof record['Query Text'] === 'string' ? { queryText: record['Query Text'] } : {}),
        plan: record.Plan as Record<string, unknown>,
      });
    }
  };
  documents.forEach(add);
  return entries;
}

function planNodeRows(root: Record<string, unknown>): unknown[] {
  const rows: unknown[] = [];
  const visit = (node: Record<string, unknown>): void => {
    rows.push({
      node: node['Node Type'],
      ...(typeof node.Schema === 'string' ? { schema: node.Schema } : {}),
      ...(typeof node['Relation Name'] === 'string' ? { relation: node['Relation Name'] } : {}),
      actualRows: node['Actual Rows'],
      actualLoops: node['Actual Loops'],
      rowsRemovedByFilter: node['Rows Removed by Filter'],
      rowsRemovedByIndexRecheck: node['Rows Removed by Index Recheck'],
    });
    if (Array.isArray(node.Plans))
      for (const child of node.Plans)
        if (typeof child === 'object' && child !== null && !Array.isArray(child))
          visit(child as Record<string, unknown>);
  };
  visit(root);
  return rows;
}

function logCaptureEvidence(
  sequence: number,
  capture: Capture & {
    readonly attributedStatements: ActiveCapture['attributedStatements'];
    readonly attributedPlans: ActiveCapture['attributedPlans'];
  },
): void {
  const entries = planEntries(capture.plans);
  const backgroundEntries = planEntries(capture.backgroundPlans ?? []);
  const summarize = (statements: readonly string[], plans: typeof entries, attribution: 'operation' | 'background') => {
    const texts = [...new Set(statements)];
    return {
      attribution,
      cost: costOf({
        statements,
        plans: attribution === 'operation' ? capture.plans : [],
        ...(attribution === 'background'
          ? { backgroundStatements: statements, backgroundPlans: capture.backgroundPlans ?? [] }
          : {}),
      }),
      statements: texts.map((statement) => {
        const matching = plans.filter((entry) => entry.queryText === statement);
        const statementCapture = {
          statements: Array(statements.filter((text) => text === statement).length).fill(statement),
          plans: matching.map(({ plan }) => ({ Plan: plan, 'Query Text': statement })),
        };
        return {
          statement,
          count: statements.filter((text) => text === statement).length,
          cost: costOf(statementCapture),
          plans: matching.map((entry) => ({ queryText: entry.queryText, nodes: planNodeRows(entry.plan) })),
        };
      }),
      plansWithoutMatchingStatement: plans
        .filter((entry) => !statements.includes(entry.queryText ?? ''))
        .map((entry) => ({
          queryText: entry.queryText,
          nodes: planNodeRows(entry.plan),
        })),
    };
  };
  console.info(
    `growth capture evidence ${JSON.stringify({
      sequence,
      statementAttribution: capture.attributedStatements,
      planAttribution: capture.attributedPlans.map(({ plan, attribution }) => ({
        attribution,
        plans: planEntries([plan]).map((entry) => ({ queryText: entry.queryText, nodes: planNodeRows(entry.plan) })),
      })),
      operation: summarize(capture.statements, entries, 'operation'),
      background: summarize(capture.backgroundStatements ?? [], backgroundEntries, 'background'),
    })}`,
  );
}

function statementText(query: unknown): string | undefined {
  if (typeof query === 'string') return query;
  if (typeof query !== 'object' || query === null || !('text' in query)) return undefined;
  return typeof query.text === 'string' ? query.text : undefined;
}

function intercept(client: PoolClient, state: CaptureState): (statement: string) => unknown {
  const query = client.query.bind(client) as PoolClient['query'];
  const pending: Array<Attribution | undefined> = [];
  let suppressAttribution = false;
  const refreshAttribution = (): void => {
    const inFlight = pending[0];
    if (inFlight) clientAttribution.set(client, inFlight);
    else clientAttribution.delete(client);
  };

  client.query = ((...args: Parameters<PoolClient['query']>) => {
    const text = statementText(args[0]);
    let attribution = suppressAttribution ? undefined : currentAttribution(state);
    if (!suppressAttribution && !attribution && state.active) attribution = { capture: state.active, background: true };
    if (text !== undefined && attribution) {
      (attribution.background ? attribution.capture.backgroundStatements : attribution.capture.statements).push(text);
      attribution.capture.attributedStatements.push({ statement: text, attribution: attributionKind(attribution) });
    }
    pending.push(attribution);
    refreshAttribution();

    const done = (): void => {
      pending.shift();
      refreshAttribution();
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
      try {
        return (query as (...values: unknown[]) => unknown)(...args.slice(0, -1), wrapped);
      } catch (error) {
        done();
        finishBackground?.();
        throw error;
      }
    }

    let outcome: unknown;
    try {
      outcome = (query as (...values: unknown[]) => unknown)(...args);
    } catch (error) {
      done();
      throw error;
    }
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
    } else if (typeof outcome === 'object' && outcome !== null && 'once' in outcome) {
      const stream = outcome as { once?: (event: string, listener: () => void) => unknown };
      if (typeof stream.once === 'function') {
        stream.once('end', done);
        stream.once('error', done);
      } else done();
    } else {
      done();
    }
    return outcome;
  }) as PoolClient['query'];

  return (statement) => {
    suppressAttribution = true;
    try {
      return client.query(statement);
    } finally {
      suppressAttribution = false;
    }
  };
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
      (attribution.background ? attribution.capture.backgroundPlans : attribution.capture.plans).push(plan);
      attribution.capture.attributedPlans.push({ plan, attribution: attributionKind(attribution) });
    } catch (error) {
      attribution.capture.error ??= asError(error);
    }
  });

  const queryWithoutAttribution = intercept(client, state);
  const setupQueries = setupStatements.map(queryWithoutAttribution);
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
  const state: CaptureState = { active: undefined, setupTasks: new Set(), captureSequence: 0 };
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
  const sequence = ++state.captureSequence;

  const active: ActiveCapture = {
    statements: [],
    plans: [],
    backgroundStatements: [],
    backgroundPlans: [],
    attributedStatements: [],
    attributedPlans: [],
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
    const result = {
      value,
      capture: {
        statements: active.statements,
        plans: active.plans,
        backgroundStatements: active.backgroundStatements,
        backgroundPlans: active.backgroundPlans,
      },
    };
    if (process.env.GROWTH_CAPTURE_TRACE === '1')
      logCaptureEvidence(sequence, {
        ...result.capture,
        attributedStatements: active.attributedStatements,
        attributedPlans: active.attributedPlans,
      });
    return result;
  } finally {
    state.active = undefined;
  }
}
