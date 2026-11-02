import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg, { type Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { GrowthCaptureBudget, parseNativePlanNotice, type GrowthCaptureBudgetLimits } from './growth-capture-budget.ts';
import { walkPlanTree } from './growth-plan-walk.ts';
import type { Capture } from './growth-cost.ts';
import { drainCaptureWork } from './growth-capture-drain.ts';
import { collectModifyTargets } from './growth-plan-walk.ts';
import { classifyGrowthSql } from './growth-sql-kind.ts';

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

type CloseablePool = { end(): Promise<void> };

export function createGrowthDatabaseLifecycle() {
  const resources = new Map<CloseablePool, string>();
  let closing: Promise<void> | undefined;
  const assertOpen = () => {
    if (closing) throw new Error('Growth database is closed');
  };
  const acquire = <T extends CloseablePool>(name: string, create: () => T): T => {
    assertOpen();
    const resource = create();
    resources.set(resource, name);
    return resource;
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = Promise.allSettled(
      Array.from(resources, async ([resource, name]) => {
        try {
          await resource.end();
        } catch (error) {
          throw new Error(`${name} failed to close: ${asError(error).message}`, { cause: error });
        }
      }),
    ).then((results) => {
      const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      if (failures.length)
        throw new AggregateError(
          failures,
          `Could not close growth database resources: ${failures.map((error) => asError(error).message).join('; ')}`,
        );
    });
    return closing;
  };
  const setup = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (primary) {
      try {
        await close();
      } catch (cleanup) {
        const failures = cleanup instanceof AggregateError ? cleanup.errors : [cleanup];
        throw new AggregateError(
          [primary, ...failures],
          `Growth database setup failed: ${asError(primary).message}; cleanup failed: ${failures.map((error) => asError(error).message).join('; ')}`,
          { cause: primary },
        );
      }
      throw primary;
    }
  };
  return { acquire, assertOpen, close, setup };
}

export type SeedingCount = { statements: number; rowsWritten: number };

type ActiveCapture = {
  readonly id: number;
  readonly budget: GrowthCaptureBudget;
  readonly mode: 'measured' | 'warmup';
  readonly database: GrowthDatabase;
  readonly run: RunCapture | undefined;
  statementRecords: StatementRecord[];
  foregroundStatementCount: number;
  backgroundStatementCount: number;
  plans: unknown[];
  planDatabases: string[];
  planStatements: (number | undefined)[];
  readonly includeBackends: boolean;
  planBackends: (number | undefined)[];
  backgroundPlans: unknown[];
  backgroundPlanDatabases: string[];
  backgroundPlanStatements: (number | undefined)[];
  backgroundPlanBackends: (number | undefined)[];
  readonly transactions: Map<GrowthDatabase, Map<number, number>>;
  pending: Set<Promise<void>>;
  error?: Error;
};
type StatementRecord = {
  text: string;
  readonly background: boolean;
  readonly backend: number | undefined;
  readonly index: number;
  requestBytes: number;
  responseBytes: number;
  errorCode: string | null;
  errorMessage: string | null;
  requiresNativePlan: boolean;
};
type WireStatement = {
  readonly record: StatementRecord | undefined;
  readonly attribution: Attribution | undefined;
  parsed: boolean;
  bound: boolean;
  queued: boolean;
  queueNode: WireStatementNode | undefined;
};
type WireStatementNode = {
  readonly statement: WireStatement;
  previous: WireStatementNode | undefined;
  next: WireStatementNode | undefined;
};
type WireStatementQueue = {
  head: WireStatementNode | undefined;
  tail: WireStatementNode | undefined;
};
type Attribution = {
  readonly capture: ActiveCapture;
  readonly background: boolean;
  readonly parent?: Attribution;
};
type CaptureState = {
  lifecycle: ReturnType<typeof createGrowthDatabaseLifecycle>;
  active: ActiveCapture | undefined;
  growthCheckActive: boolean;
  seeding: SeedingCount | undefined;
  seedingPending: Set<Promise<void>>;
  setupError?: Error;
  setupTasks: Set<Promise<void>>;
  relatedDatabases: Map<string, GrowthDatabase>;
  activeTransactions: Map<number, number>;
  nextTransactionToken: number;
};

const states = new WeakMap<GrowthDatabase, CaptureState>();
const databasesByAdmin = new WeakMap<pg.Pool, GrowthDatabase>();
const growing = new AsyncLocalStorage<Attribution | pg.Pool>();
const liveCaptures = new Set<ActiveCapture>();
const workflowAttributions = new Map<string, Attribution>();

export async function withGrowthCheck<T>(database: GrowthDatabase, operation: () => Promise<T>): Promise<T> {
  const state = states.get(database);
  if (!state) throw new Error('Growth database was not opened by openGrowthDatabase');
  state.lifecycle.assertOpen();
  if (state.growthCheckActive) throw new Error('A growth check is already active for this database');
  state.growthCheckActive = true;
  try {
    return await operation();
  } finally {
    state.growthCheckActive = false;
  }
}

type BackendSet = Set<number> & { readonly transactions: Map<GrowthDatabase, Map<number, number>> };
type RunCapture = Map<GrowthDatabase, Set<string>> & {
  readonly databases: Set<GrowthDatabase>;
  readonly backends: BackendSet;
};
const measuredRun = new AsyncLocalStorage<RunCapture>();
// pg can submit the next queued query before the previous query's promise settles.
const clientWireQueue = new WeakMap<PoolClient, WireStatementQueue>();
const clientWireStatement = new WeakMap<PoolClient, WireStatement | undefined>();
const clientExecutingStatement = new WeakMap<PoolClient, WireStatement | undefined>();
let nextCaptureId = 1;
const clientRowDescription = new WeakMap<PoolClient, readonly { readonly dataTypeID: number }[]>();
const nativePlanCommands = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);

function isAttribution(value: Attribution | pg.Pool | undefined): value is Attribution {
  return typeof value === 'object' && value !== null && 'capture' in value && 'background' in value;
}

function currentAttribution(state: CaptureState): Attribution | undefined {
  for (let current = growing.getStore(); isAttribution(current); current = current.parent)
    if (current.capture === state.active) return current;
  const workflowID = DBOS.workflowID;
  if (state.active && workflowID !== undefined) {
    const associated = workflowAttribution(workflowID);
    for (let current = associated; current; current = current.parent)
      if (current.capture === state.active) return current;
    return { capture: state.active, background: true };
  }
  return undefined;
}

function hasLiveCapture(attribution: Attribution): boolean {
  for (let current: Attribution | undefined = attribution; current; current = current.parent)
    if (liveCaptures.has(current.capture)) return true;
  return false;
}

function workflowAttribution(workflowID: string): Attribution | undefined {
  const attribution = workflowAttributions.get(workflowID);
  if (attribution && !hasLiveCapture(attribution)) workflowAttributions.delete(workflowID);
  return attribution && hasLiveCapture(attribution) ? attribution : undefined;
}

function pruneWorkflowAttributions(): void {
  for (const [workflowID, attribution] of workflowAttributions)
    if (!hasLiveCapture(attribution)) workflowAttributions.delete(workflowID);
}

function currentWorkflowAttribution(): Attribution | undefined {
  const current = growing.getStore();
  if (isAttribution(current) && hasLiveCapture(current)) return current;
  const workflowID = DBOS.workflowID;
  return workflowID === undefined ? undefined : workflowAttribution(workflowID);
}

function instrumentWorkflowInvocation(invocation: Function, workflowID: string | undefined): Function {
  return new Proxy(invocation, {
    apply(target, thisArg, args: unknown[]) {
      const attribution = currentWorkflowAttribution();
      const previous = workflowID === undefined ? undefined : workflowAttributions.get(workflowID);
      if (attribution && workflowID !== undefined) workflowAttributions.set(workflowID, attribution);

      let result: unknown;
      try {
        result = Reflect.apply(target, thisArg, args);
      } catch (error) {
        if (workflowID !== undefined && workflowAttributions.get(workflowID) === attribution)
          previous ? workflowAttributions.set(workflowID, previous) : workflowAttributions.delete(workflowID);
        throw error;
      }

      if (!attribution) return result;
      return Promise.resolve(result).then(
        (handle: unknown) => {
          const id =
            typeof handle === 'object' &&
            handle !== null &&
            'workflowID' in handle &&
            typeof handle.workflowID === 'string'
              ? handle.workflowID
              : workflowID;
          if (id !== undefined && hasLiveCapture(attribution)) workflowAttributions.set(id, attribution);
          return handle;
        },
        (error: unknown) => {
          if (workflowID !== undefined && workflowAttributions.get(workflowID) === attribution)
            previous ? workflowAttributions.set(workflowID, previous) : workflowAttributions.delete(workflowID);
          throw error;
        },
      );
    },
  });
}

function instrumentWorkflowLauncher(launcher: unknown, workflowID: string | undefined): unknown {
  if (typeof launcher === 'function')
    return new Proxy(launcher, {
      apply(target, thisArg, args: unknown[]) {
        return Reflect.apply(instrumentWorkflowInvocation(target, workflowID), thisArg, args);
      },
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver) as unknown;
        return typeof member === 'function' ? instrumentWorkflowInvocation(member, workflowID) : member;
      },
    });
  if (typeof launcher === 'object' && launcher !== null)
    return new Proxy(launcher, {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver) as unknown;
        return typeof member === 'function' ? instrumentWorkflowInvocation(member, workflowID) : member;
      },
    });
  return launcher;
}

function installWorkflowAttribution(): void {
  const original = DBOS.startWorkflow.bind(DBOS);
  const wrapped = ((...args: unknown[]) => {
    const params = args[1];
    const workflowID =
      typeof params === 'object' && params !== null && 'workflowID' in params && typeof params.workflowID === 'string'
        ? params.workflowID
        : undefined;
    return instrumentWorkflowLauncher(Reflect.apply(original, DBOS, args), workflowID);
  }) as typeof DBOS.startWorkflow;
  (DBOS as unknown as { startWorkflow: typeof DBOS.startWorkflow }).startWorkflow = wrapped;
}

installWorkflowAttribution();

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

function preparedStatementName(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null || !('name' in query)) return undefined;
  return typeof query.name === 'string' && query.name.length > 0 ? query.name : undefined;
}

function preparedStatementText(client: PoolClient, name: string): string | undefined {
  // pg records successful ParseComplete names here and uses this same registry to skip Parse on named reuse.
  // This is protocol identity by prepared name, not a search for a plan with matching SQL.
  const connection = client.connection as typeof client.connection & {
    readonly parsedStatements: Readonly<Record<string, string | undefined>>;
  };
  const text = connection.parsedStatements[name];
  return typeof text === 'string' ? text : undefined;
}

function nextWireStatement(client: PoolClient): WireStatement | undefined {
  const queue = clientWireQueue.get(client);
  const node = queue?.head;
  if (!node) {
    clientWireStatement.set(client, undefined);
    return undefined;
  }
  const statement = node.statement;
  detachWireStatement(client, statement);
  clientWireStatement.set(client, statement);
  return statement;
}

function queueWireStatement(client: PoolClient, statement: WireStatement): void {
  let queue = clientWireQueue.get(client);
  if (!queue) {
    queue = { head: undefined, tail: undefined };
    clientWireQueue.set(client, queue);
  }
  const node: WireStatementNode = { statement, previous: queue.tail, next: undefined };
  if (queue.tail) queue.tail.next = node;
  else queue.head = node;
  queue.tail = node;
  statement.queueNode = node;
  statement.queued = true;
}

function detachWireStatement(client: PoolClient, statement: WireStatement): void {
  if (!statement.queued) return;
  statement.queued = false;
  const queue = clientWireQueue.get(client);
  const node = statement.queueNode;
  statement.queueNode = undefined;
  if (!queue || !node) return;
  if (node.previous) node.previous.next = node.next;
  else queue.head = node.next;
  if (node.next) node.next.previous = node.previous;
  else queue.tail = node.previous;
  if (!queue.head) clientWireQueue.delete(client);
}

function backendPid(client: PoolClient): number | undefined {
  const processID = (client as PoolClient & { readonly processID?: unknown }).processID;
  return typeof processID === 'number' && Number.isSafeInteger(processID) ? processID : undefined;
}

function connectedDatabase(client: PoolClient): string | undefined {
  const value = (client as PoolClient & { readonly connectionParameters?: { readonly database?: unknown } })
    .connectionParameters?.database;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const WRITE_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY']);
const IN_FAILED_TRANSACTION = '25P02';

function mayResetCaptureSetting(text: string | undefined): boolean {
  if (text === undefined) return false;
  try {
    const kind = classifyGrowthSql(text);
    return kind === 'commit' || kind === 'rollback' || kind === 'rollback-to';
  } catch {
    return false;
  }
}

function countWrites(counter: SeedingCount | undefined, result: unknown): void {
  if (!counter) return;
  for (const item of Array.isArray(result) ? result : [result]) {
    if (typeof item !== 'object' || item === null || !('command' in item) || !('rowCount' in item)) continue;
    if (typeof item.command === 'string' && WRITE_COMMANDS.has(item.command) && typeof item.rowCount === 'number')
      counter.rowsWritten += item.rowCount;
  }
}

function parameterBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  return 0;
}

function byteaPayloadLength(value: string | Buffer): number {
  if (Buffer.isBuffer(value)) return value.length;
  if (value.startsWith('\\x') && (value.length - 2) % 2 === 0 && /^[0-9a-f]*$/i.test(value.slice(2)))
    return (value.length - 2) / 2;

  let length = 0;
  for (let index = 0; index < value.length;) {
    if (value[index] !== '\\') {
      length++;
      index++;
    } else if (/^[0-7]{3}$/.test(value.slice(index + 1, index + 4))) {
      length++;
      index += 4;
    } else if (value[index + 1] === '\\') {
      length++;
      index += 2;
    } else {
      // A valid escape-format bytea output never has an unpaired backslash, but count malformed text as one byte.
      length++;
      index++;
    }
  }
  return length;
}

function instrumentBytes(client: PoolClient, state: CaptureState): void {
  const connection = client.connection;
  const transaction = { active: false, token: 0 };
  const query = connection.query.bind(connection);
  connection.query = ((text: string) => {
    const wireStatement = nextWireStatement(client);
    clientExecutingStatement.set(client, wireStatement);
    const result = query(text);
    if (wireStatement?.record) wireStatement.record.requestBytes += Buffer.byteLength(text, 'utf8');
    return result;
  }) as typeof connection.query;

  const parse = connection.parse.bind(connection);
  connection.parse = ((statement, more) => {
    const wireStatement = nextWireStatement(client);
    if (wireStatement) wireStatement.parsed = true;
    const record = wireStatement?.record;
    const result = parse(statement, more);
    if (record && typeof statement.text === 'string') record.requestBytes += Buffer.byteLength(statement.text, 'utf8');
    return result;
  }) as typeof connection.parse;

  const bind = connection.bind.bind(connection);
  connection.bind = ((config, more) => {
    let wireStatement = clientWireStatement.get(client);
    if (!wireStatement?.parsed || wireStatement.bound) wireStatement = nextWireStatement(client);
    if (wireStatement) wireStatement.bound = true;
    const record = wireStatement?.record;
    // A name-only request can be queued before its predecessor's ParseComplete. Resolve its text at Bind, when pg
    // has selected the actual prepared statement, without changing the occurrence reserved when it was enqueued.
    if (record && record.text.length === 0 && config?.statement) {
      const text = preparedStatementText(client, config.statement);
      if (text !== undefined) record.text = text;
    }
    if (config?.values && config.valueMapper) {
      const valueMapper = config.valueMapper;
      let requestBytes = 0;
      const result = bind(
        {
          ...config,
          valueMapper: (value, index) => {
            const prepared = valueMapper(value, index);
            requestBytes += parameterBytes(prepared);
            return prepared;
          },
        },
        more,
      );
      if (record) record.requestBytes += requestBytes;
      return result;
    }
    return bind(config, more);
  }) as typeof connection.bind;

  const execute = connection.execute.bind(connection);
  connection.execute = ((config, more) => {
    clientExecutingStatement.set(client, clientWireStatement.get(client));
    return execute(config, more);
  }) as typeof connection.execute;

  // pg emits ReadyForQuery after a query's notices and before it dispatches the next queued query. Clear the prior
  // owner first, so the next query's connection.query/execute hook can install its own wire occurrence.
  connection.prependListener('readyForQuery', (message: { readonly status?: string }) => {
    const wireStatement = clientExecutingStatement.get(client) ?? clientWireStatement.get(client);
    const attribution = wireStatement?.attribution;
    const backend = backendPid(client);
    if (message.status === 'T' || message.status === 'E') {
      if (!transaction.active) transaction.token = ++state.nextTransactionToken;
      transaction.active = true;
      if (backend !== undefined) {
        state.activeTransactions.set(backend, transaction.token);
        if (attribution && !attribution.background) {
          const database = databaseForName(
            attribution.capture.database,
            connectedDatabase(client) ?? databaseName(attribution.capture.database),
          );
          let captureTransactions = attribution.capture.transactions.get(database);
          if (!captureTransactions) {
            captureTransactions = new Map();
            attribution.capture.transactions.set(database, captureTransactions);
          }
          captureTransactions.set(backend, transaction.token);
          let runTransactions = attribution.capture.run?.backends.transactions.get(database);
          if (attribution.capture.run && !runTransactions) {
            runTransactions = new Map();
            attribution.capture.run.backends.transactions.set(database, runTransactions);
          }
          runTransactions?.set(backend, transaction.token);
        }
      }
    } else if (message.status === 'I') {
      const completedToken = transaction.active ? transaction.token : undefined;
      transaction.active = false;
      if (backend !== undefined && state.activeTransactions.get(backend) === completedToken)
        state.activeTransactions.delete(backend);
      if (backend !== undefined && completedToken !== undefined) {
        if (attribution) {
          const database = databaseForName(
            attribution.capture.database,
            connectedDatabase(client) ?? databaseName(attribution.capture.database),
          );
          const captureTransactions = attribution.capture.transactions.get(database);
          if (captureTransactions?.get(backend) === completedToken) captureTransactions.delete(backend);
          const runTransactions = attribution.capture.run?.backends.transactions.get(database);
          if (runTransactions?.get(backend) === completedToken) runTransactions.delete(backend);
        }
      }
    }
    clientExecutingStatement.delete(client);
    clientWireStatement.delete(client);
    clientRowDescription.delete(client);
  });

  client.once('end', () => {
    const backend = backendPid(client);
    if (backend !== undefined && state.activeTransactions.get(backend) === transaction.token)
      state.activeTransactions.delete(backend);
  });

  connection.on('message', (message) => {
    const protocolMessage = message as {
      readonly name?: string;
      readonly text?: string;
      readonly fields?: readonly ({ readonly dataTypeID: number } | string | null | Buffer)[];
    };
    if (protocolMessage.name === 'commandComplete') {
      const tag = protocolMessage.text?.split(' ', 1)[0];
      const record = clientWireStatement.get(client)?.record ?? clientExecutingStatement.get(client)?.record;
      if (tag && nativePlanCommands.has(tag) && record) record.requiresNativePlan = true;
      return;
    }
    if (protocolMessage.name === 'rowDescription') {
      clientRowDescription.set(client, (protocolMessage.fields ?? []) as readonly { readonly dataTypeID: number }[]);
      return;
    }
    if (protocolMessage.name !== 'dataRow') return;
    const record = clientWireStatement.get(client)?.record;
    if (!record) return;
    const fields = protocolMessage.fields as readonly (string | null | Buffer)[] | undefined;
    if (!fields) return;
    const descriptions = clientRowDescription.get(client) ?? [];
    for (let index = 0; index < fields.length; index++) {
      const value = fields[index];
      if (value === null || value === undefined) continue;
      const typeID = descriptions[index]?.dataTypeID;
      if (typeID === 17) record.responseBytes += byteaPayloadLength(value);
      else if (Buffer.isBuffer(value)) record.responseBytes += value.length;
      else record.responseBytes += Buffer.byteLength(value, 'utf8');
    }
  });
}

/**
 * Records the client's statements and the rows they write, and, when `explain` is set, turns auto_explain on for the
 * statements of a capture and off otherwise. Statements in the operation's async scope and statements issued inside
 * a DBOS workflow while a capture runs belong to the operation, even when the queue runner executes that workflow.
 * An unrelated workflow running during a capture is therefore counted as the operation's; that can only make a bound
 * stricter, never hide cost. If a spurious failure traces to one, switch to lineage tracking. Other work is background.
 * The switch is an ordinary SET sent ahead of the statement on the
 * client's own queue and never counted. A rollback, including one to a savepoint, a commit of a failed transaction,
 * or a failed statement can undo it, so queued statements reassert it; a statement that ends a transaction sends none,
 * since a failed transaction can refuse it. Ending kinds follow classifyGrowthSql, including leading comments.
 * Unknown prepared text waits until that existing resolution boundary.
 */
function intercept(client: PoolClient, state: CaptureState, explain: boolean): (statement: string) => unknown {
  const query = client.query.bind(client) as PoolClient['query'];
  // This count controls only setting reassertion. Native plan custody is attached at the pg wire dispatch boundary.
  let pendingQueries = 0;
  let suppressAttribution = false;
  // Whether auto_explain is on for this connection; undefined when a rollback or a failure may have undone it.
  let explaining: boolean | undefined = false;

  const queryWithoutAttribution = (statement: string): unknown => {
    suppressAttribution = true;
    try {
      // Controls need their own neutral wire occurrence so dispatch cannot consume an application's owner.
      // Keep this entry point stable when a later application observer wraps client.query.
      return interceptedQuery(statement);
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
    const remove = () => {
      state.setupTasks.delete(task);
    };
    void task.then(remove, remove);
  };

  const interceptedQuery = ((...args: Parameters<PoolClient['query']>) => {
    const applicationQuery = !suppressAttribution;
    const name = preparedStatementName(args[0]);
    const text = statementText(args[0]) ?? (name === undefined ? undefined : preparedStatementText(client, name));
    let attribution = suppressAttribution ? undefined : currentAttribution(state);
    if (!suppressAttribution && !attribution && state.active) attribution = { capture: state.active, background: true };
    let record: StatementRecord | undefined;
    if (
      explain &&
      !suppressAttribution &&
      (text !== undefined || name !== undefined) &&
      attribution &&
      !attribution.capture.error
    ) {
      const capture = attribution.capture;
      const side = attribution.background ? 'background' : 'foreground';
      try {
        capture.budget.retainStatementText(side, Buffer.byteLength(text ?? '', 'utf8'));
        const index = attribution.background ? capture.backgroundStatementCount++ : capture.foregroundStatementCount++;
        record = {
          text: text ?? '',
          background: attribution.background,
          backend: capture.includeBackends ? backendPid(client) : undefined,
          index,
          requestBytes: 0,
          responseBytes: 0,
          errorCode: null,
          errorMessage: null,
          requiresNativePlan: false,
        };
        capture.statementRecords.push(record);
      } catch (error) {
        capture.error ??= asError(error);
      }
    }
    if (state.seeding && !suppressAttribution) state.seeding.statements++;
    if (explain && !suppressAttribution) {
      const resetsSetting = mayResetCaptureSetting(text);
      if (!resetsSetting) {
        const wanted = state.active !== undefined;
        // A pg client queues concurrent queries. A preceding queued query may fail or roll back the transaction after
        // this call observes `explaining`, so reassert the setting between queued statements as well as on transitions.
        if (explaining !== wanted || pendingQueries > 0) switchTo(wanted);
      }
      // COMMIT can roll back an already-failed transaction, which also rolls back SET changes. Treat every end as
      // unknown and reassert on the next query; a successful commit simply repeats the harmless session setting.
      if (resetsSetting) explaining = undefined;
    }
    const wireStatement: WireStatement = {
      record,
      attribution,
      parsed: false,
      bound: false,
      queued: false,
      queueNode: undefined,
    };
    queueWireStatement(client, wireStatement);
    if (applicationQuery) pendingQueries++;

    let completed = false;
    const done = (failed: boolean, result?: unknown, error?: unknown): void => {
      if (completed) return;
      completed = true;
      detachWireStatement(client, wireStatement);
      if (record) {
        if (failed) {
          const code = (error as { code?: unknown } | null)?.code;
          record.errorCode = typeof code === 'string' && code.length > 0 ? code : 'unknown';
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (attribution && !attribution.capture.error) {
            try {
              attribution.capture.budget.retainStatementError(
                record.background ? 'background' : 'foreground',
                Buffer.byteLength(errorMessage, 'utf8'),
              );
              record.errorMessage = errorMessage;
            } catch (budgetError) {
              attribution.capture.error ??= asError(budgetError);
            }
          }
        }
      }
      if (!failed) countWrites(state.seeding, result);
      else if (explain) explaining = undefined;
      if (applicationQuery) pendingQueries--;
    };
    const callback = args.at(-1);
    const register = (work: Set<Promise<void>>, task: Promise<void>): void => {
      work.add(task);
      // Keep rejected work registered until the boundary drain can report it alongside the initiating failure.
      void task.then(
        () => {
          work.delete(task);
        },
        () => {},
      );
    };
    const track = (task: Promise<void>): void => {
      if (attribution) register(attribution.capture.pending, task);
      if (state.seeding) register(state.seedingPending, task);
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
  client.query = interceptedQuery;

  return queryWithoutAttribution;
}

function retainNativePlanNodes(plan: unknown, capture: ActiveCapture, side: 'foreground' | 'background'): void {
  const roots = Array.isArray(plan) ? plan : [plan];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (typeof root !== 'object' || root === null || Array.isArray(root) || !('Plan' in root)) continue;
    for (const entry of walkPlanTree(root.Plan, `native notice[${index}].Plan`)) {
      void entry;
      capture.budget.retainNativePlanNode(side);
    }
  }
}

function instrument(client: PoolClient, state: CaptureState): void {
  instrumentBytes(client, state);

  client.on('notice', (notice) => {
    const wireStatement = clientExecutingStatement.get(client);
    const attribution = wireStatement?.attribution;
    const message = notice.message;
    const marker = 'plan:\n';
    if (
      !attribution ||
      attribution.capture.error ||
      typeof message !== 'string' ||
      !message.startsWith('duration:') ||
      !message.includes(marker)
    )
      return;

    try {
      const capture = attribution.capture;
      const side = attribution.background ? 'background' : 'foreground';
      const plan = parseNativePlanNotice(capture.budget, message, side, () =>
        JSON.parse(message.slice(message.indexOf(marker) + marker.length)),
      ) as unknown;
      retainNativePlanNodes(plan, capture, side);
      (attribution.background ? capture.backgroundPlans : capture.plans).push(plan);
      (attribution.background ? capture.backgroundPlanDatabases : capture.planDatabases).push(
        connectedDatabase(client) ?? '',
      );
      (attribution.background ? capture.backgroundPlanStatements : capture.planStatements).push(
        wireStatement?.record?.index,
      );
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
  const removeSetupTask = () => {
    state.setupTasks.delete(setupTask);
  };
  void setupTask.then(removeSetupTask, (error: unknown) => {
    state.setupError ??= asError(error);
    removeSetupTask();
  });
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

  const lifecycle = createGrowthDatabaseLifecycle();
  return lifecycle.setup(async () => {
    const pool = lifecycle.acquire('instrumented pool', () => createPool(url, { connectionTimeoutMillis: 10_000 }));
    const admin = lifecycle.acquire('admin pool', () => new pg.Pool({ connectionString: url, max: 2 }));
    const state: CaptureState = {
      lifecycle,
      active: undefined,
      growthCheckActive: false,
      seeding: undefined,
      seedingPending: new Set(),
      setupTasks: new Set(),
      relatedDatabases: new Map(),
      activeTransactions: new Map(),
      nextTransactionToken: 0,
    };
    admin.on('connect', (client) => intercept(client, state, false));
    const database: GrowthDatabase = {
      url,
      pool,
      admin,
      openPool: (config = {}) => {
        const libraryPool = lifecycle.acquire('library pool', () => new pg.Pool({ ...config, connectionString: url }));
        instrumentPool(libraryPool, state);
        return libraryPool;
      },
      close: lifecycle.close,
    };
    states.set(database, state);
    databasesByAdmin.set(admin, database);
    instrumentPool(pool, state);

    try {
      const result = await capture(database, () => withConnection(pool, (client) => client.query('SELECT 1')));
      if (result.capture.statements.length !== 1 || result.capture.plans.length !== 1)
        throw new Error('The auto_explain probe did not produce exactly one statement and one plan');
    } catch (error) {
      throw new Error('auto_explain plans were not reported; growth checks need a superuser test database', {
        cause: error,
      });
    }
    await settle(database, { relations: [] });
    return database;
  });
}

export async function capture<T>(
  database: GrowthDatabase,
  operation: () => Promise<T>,
  options: GrowthCaptureOptions = {},
): Promise<{ value: T; capture: Capture }> {
  return captureInternal(database, operation, options, false);
}

export type GrowthCaptureOptions = {
  readonly includeBackends?: boolean;
  /** A capture may use tighter telemetry limits for a focused check, but cannot raise the documented hard caps. */
  readonly telemetryLimits?: Partial<GrowthCaptureBudgetLimits>;
};

async function captureInternal<T>(
  database: GrowthDatabase,
  operation: () => Promise<T>,
  options: GrowthCaptureOptions,
  explicitWarmup: boolean,
): Promise<{ value: T; capture: Capture }> {
  const state = states.get(database);
  if (!state) throw new Error('Growth database was not opened by openGrowthDatabase');
  state.lifecycle.assertOpen();
  const parentActive = state.active;
  const ownsParent = parentActive !== undefined && currentAttribution(state)?.capture === parentActive;
  if (parentActive && !(parentActive.mode === 'warmup' && ownsParent))
    throw new Error('A growth capture is already active for this database');
  if (state.setupError) throw state.setupError;

  const mode = explicitWarmup || (parentActive?.mode === 'warmup' && ownsParent) ? 'warmup' : 'measured';
  const id = nextCaptureId++;
  const active: ActiveCapture = {
    id,
    budget: new GrowthCaptureBudget(id, options.telemetryLimits),
    mode,
    database,
    run: measuredRun.getStore(),
    statementRecords: [],
    foregroundStatementCount: 0,
    backgroundStatementCount: 0,
    plans: [],
    planDatabases: [],
    planStatements: [],
    includeBackends: options.includeBackends === true || mode === 'warmup',
    planBackends: [],
    backgroundPlans: [],
    backgroundPlanDatabases: [],
    backgroundPlanStatements: [],
    backgroundPlanBackends: [],
    transactions: new Map(),
    pending: new Set(),
  };
  state.active = active;
  liveCaptures.add(active);
  try {
    // Captures for separate databases can nest in one operation, such as Kernel calling Auth.
    const parent = growing.getStore();
    let value!: T;
    let operationError: unknown;
    let operationFailed = false;
    const operationStartedAt = performance.now();
    try {
      value = await growing.run(
        { capture: active, background: false, ...(isAttribution(parent) ? { parent } : {}) },
        operation,
      );
    } catch (error) {
      operationError = error;
      operationFailed = true;
    }
    // Wait through failures too: queued queries and setup work must settle before attribution is restored.
    const cleanupErrors = await drainCaptureWork(active.pending, state.setupTasks);
    const elapsedMs = performance.now() - operationStartedAt;
    const failures: unknown[] = [];
    const addFailure = (error: unknown): void => {
      if (!failures.includes(error)) failures.push(error);
    };
    if (operationFailed) addFailure(operationError);
    if (state.setupError) addFailure(state.setupError);
    if (active.error) addFailure(active.error);
    for (const error of cleanupErrors) addFailure(error);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'Growth capture failed while pending work was settling', {
        cause: failures[0],
      });
    const foregroundPlanOwners = new Set(active.planStatements);
    const backgroundPlanOwners = new Set(active.backgroundPlanStatements);
    for (const record of active.statementRecords) {
      if (!record.requiresNativePlan || record.errorCode !== null) continue;
      const owners = record.background ? backgroundPlanOwners : foregroundPlanOwners;
      if (!owners.has(record.index))
        throw new Error(`Successful ${record.text.split(/\s+/, 1)[0]} occurrence ${record.index} has no native plan`);
    }
    const run = measuredRun.getStore();
    if (run) {
      for (const [plans, databaseNames, collection] of [
        [active.plans, active.planDatabases, 'plans'],
        [active.backgroundPlans, active.backgroundPlanDatabases, 'backgroundPlans'],
      ] as const) {
        for (let index = 0; index < plans.length; index++) {
          const target = databaseForName(database, databaseNames[index] || databaseName(database));
          const relations = run.get(target) ?? new Set<string>();
          run.databases.add(target);
          collectModifyTargets(plans[index], relations, `${collection}[${index}]`);
          if (relations.size > 0) run.set(target, relations);
        }
      }
    }
    const foreground = active.statementRecords.filter(({ background }) => !background);
    const background = active.statementRecords.filter(({ background }) => background);
    if (run)
      for (const { backend } of foreground) {
        if (backend !== undefined) run.backends.add(backend);
      }
    if (run)
      for (const [target, transactions] of active.transactions) {
        const runTransactions = run.backends.transactions.get(target) ?? new Map<number, number>();
        for (const [backend, token] of transactions) runTransactions.set(backend, token);
        run.backends.transactions.set(target, runTransactions);
      }
    return {
      value,
      capture: {
        statements: foreground.map(({ text }) => text),
        elapsedMs,
        requestBytes: foreground.map(({ requestBytes }) => requestBytes),
        responseBytes: foreground.map(({ responseBytes }) => responseBytes),
        plans: active.plans,
        planStatements: active.planStatements,
        statementErrors: foreground.map(({ errorCode }) => errorCode),
        statementErrorMessages: foreground.map(({ errorMessage }) => errorMessage),
        planDatabases: active.planDatabases,
        ...(active.includeBackends
          ? { statementBackends: foreground.map(({ backend }) => backend), planBackends: active.planBackends }
          : {}),
        backgroundStatements: background.map(({ text }) => text),
        backgroundRequestBytes: background.map(({ requestBytes }) => requestBytes),
        backgroundResponseBytes: background.map(({ responseBytes }) => responseBytes),
        backgroundPlans: active.backgroundPlans,
        backgroundPlanDatabases: active.backgroundPlanDatabases,
        backgroundPlanStatements: active.backgroundPlanStatements,
        backgroundStatementErrors: background.map(({ errorCode }) => errorCode),
        backgroundStatementErrorMessages: background.map(({ errorMessage }) => errorMessage),
        ...(active.includeBackends
          ? {
              backgroundStatementBackends: background.map(({ backend }) => backend),
              backgroundPlanBackends: active.backgroundPlanBackends,
            }
          : {}),
      },
    };
  } finally {
    state.active = parentActive;
    liveCaptures.delete(active);
    pruneWorkflowAttributions();
  }
}

/** Runs an explicitly owned unmeasured capture; nested captures inherit that custody. Used for warm-up and prepare. */
export function captureWarmup<T>(database: GrowthDatabase, operation: () => Promise<T>) {
  return captureInternal(database, operation, { includeBackends: true }, true);
}

function databaseName(database: GrowthDatabase): string {
  return new URL(database.url).pathname.slice(1);
}

function databaseForName(database: GrowthDatabase, name: string): GrowthDatabase {
  const state = states.get(database)!;
  state.lifecycle.assertOpen();
  const ownName = databaseName(database);
  if (name === ownName) return database;
  let related = state.relatedDatabases.get(name);
  if (related) return related;
  const url = new URL(database.url);
  url.pathname = `/${name}`;
  const admin = state.lifecycle.acquire(
    `related database ${name} admin pool`,
    () => new pg.Pool({ connectionString: url.toString(), max: 2 }),
  );
  admin.on('connect', (client) => intercept(client, state, false));
  related = {
    url: url.toString(),
    pool: admin,
    admin,
    openPool: () => {
      throw new Error('A related growth database cannot open instrumented pools');
    },
    close: state.lifecycle.close,
  };
  state.relatedDatabases.set(name, related);
  states.set(related, state);
  databasesByAdmin.set(admin, related);
  return related;
}

export function captureMeasuredRun<T>(operation: () => Promise<T>): Promise<{
  value: T;
  writes: RunCapture;
  databases: ReadonlySet<GrowthDatabase>;
  backends: ReadonlySet<number>;
  transactions: ReadonlyMap<GrowthDatabase, ReadonlyMap<number, number>>;
}> {
  const writes = new Map() as RunCapture;
  Object.defineProperty(writes, 'databases', { value: new Set<GrowthDatabase>() });
  const backends = new Set<number>() as BackendSet;
  Object.defineProperty(backends, 'transactions', { value: new Map<GrowthDatabase, Map<number, number>>() });
  Object.defineProperty(writes, 'backends', { value: backends });
  return measuredRun.run(writes, async () => ({
    value: await operation(),
    writes,
    databases: writes.databases,
    backends: writes.backends,
    transactions: writes.backends.transactions,
  }));
}

type GrowthSettleErrorOptions = ErrorOptions & {
  readonly kind?: 'infrastructure' | 'measured-transaction';
};

export class GrowthSettleInfrastructureError extends Error {
  readonly kind: 'infrastructure' | 'measured-transaction';
  readonly cleanupErrors: unknown[] = [];

  constructor(message: string, options?: GrowthSettleErrorOptions) {
    super(message, options);
    this.name = 'GrowthSettleInfrastructureError';
    this.kind = options?.kind ?? 'infrastructure';
  }
}

const DEFAULT_SETTLE_TIMEOUT_MS = 30_000;

type SettleDeadline = { readonly expiresAt: number; readonly timeoutMs: number };
type SettleClient = {
  readonly client: PoolClient;
  release(destroy?: boolean): unknown;
};

function makeSettleDeadline(timeoutMs: number): SettleDeadline {
  return { expiresAt: performance.now() + timeoutMs, timeoutMs };
}

function deadlineFailure(
  deadline: SettleDeadline,
  operation: string,
  kind: GrowthSettleInfrastructureError['kind'] = 'infrastructure',
): GrowthSettleInfrastructureError {
  return new GrowthSettleInfrastructureError(
    `Growth settle exceeded its ${deadline.timeoutMs}ms infrastructure deadline during ${operation}`,
    { kind },
  );
}

function preserveCleanupFailure(primary: unknown, cleanup: unknown): void {
  if (primary instanceof GrowthSettleInfrastructureError) {
    primary.cleanupErrors.push(cleanup);
  } else if (primary instanceof Error) {
    const custody = primary as Error & { cleanupErrors?: unknown[] };
    (custody.cleanupErrors ??= []).push(cleanup);
  }
}

function ownedClient(client: PoolClient): SettleClient {
  let released = false;
  return {
    client,
    release(destroy = false) {
      if (released) return;
      released = true;
      try {
        client.release(destroy);
      } catch (error) {
        return error;
      }
    },
  };
}

function releaseClient(lease: SettleClient, destroy = false, primary?: unknown): void {
  const cleanup = lease.release(destroy);
  if (cleanup === undefined) return;
  if (primary !== undefined) {
    preserveCleanupFailure(primary, cleanup);
    return;
  }
  throw new GrowthSettleInfrastructureError('Could not release the owned growth settle connection', {
    cause: cleanup,
  });
}

function waitUntilDeadline<T>(
  pending: Promise<T>,
  deadline: SettleDeadline,
  operation: string,
  onTimeout: (error: GrowthSettleInfrastructureError) => void,
  kind: GrowthSettleInfrastructureError['kind'] = 'infrastructure',
): Promise<T> {
  const remaining = deadline.expiresAt - performance.now();
  if (remaining <= 0) {
    const error = deadlineFailure(deadline, operation, kind);
    onTimeout(error);
    void pending.catch(() => undefined);
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = deadlineFailure(deadline, operation, kind);
      onTimeout(error);
      reject(error);
    }, remaining);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function checkoutSettleClient(
  database: GrowthDatabase,
  deadline: SettleDeadline,
  kind: GrowthSettleInfrastructureError['kind'] = 'infrastructure',
): Promise<SettleClient> {
  let expired: GrowthSettleInfrastructureError | undefined;
  let timedOut = false;
  const pending = database.admin.connect().then((client) => {
    if (timedOut) {
      try {
        client.release(true);
      } catch (cleanup) {
        if (expired) preserveCleanupFailure(expired, cleanup);
      }
      return undefined;
    }
    return ownedClient(client);
  });
  const lease = await waitUntilDeadline(
    pending,
    deadline,
    'admin pool checkout',
    (error) => {
      timedOut = true;
      expired = error;
    },
    kind,
  );
  if (!lease) throw deadlineFailure(deadline, 'admin pool checkout', kind);
  return lease;
}

function querySettleClient<T extends QueryResultRow = QueryResultRow>(
  lease: SettleClient,
  deadline: SettleDeadline,
  sql: string,
  values: unknown[] | undefined,
  operation: string,
  kind: GrowthSettleInfrastructureError['kind'] = 'infrastructure',
): Promise<QueryResult<T>> {
  if (deadline.expiresAt <= performance.now()) {
    const error = deadlineFailure(deadline, operation, kind);
    releaseClient(lease, true, error);
    return Promise.reject(error);
  }
  let pending: Promise<QueryResult<T>>;
  try {
    pending = lease.client.query<T>(sql, values);
  } catch (error) {
    return Promise.reject(error);
  }
  return waitUntilDeadline(pending, deadline, operation, (error) => releaseClient(lease, true, error), kind);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function qualifiedIdentifier(value: string): string {
  const { schema, name } = qualifiedName(value);
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

type RelationMaintenance = {
  schema: string;
  name: string;
  kind: string;
  options: string[] | null;
  toast_disabled: boolean;
};

function qualifiedName(value: string): { schema: string; name: string } {
  const split = value.indexOf('.');
  if (split < 1) throw new TypeError(`Expected schema-qualified relation: ${value}`);
  return { schema: value.slice(0, split), name: value.slice(split + 1) };
}

async function relationMaintenance(
  relations?: readonly string[],
  lease?: SettleClient,
  deadline?: SettleDeadline,
): Promise<RelationMaintenance[]> {
  if (relations && relations.length === 0) return [];
  if (!lease || !deadline) throw new Error('Relation maintenance requires an owned settle connection and deadline');
  const wanted = relations?.map(qualifiedName);
  const from = `SELECT n.nspname AS schema, c.relname AS name,c.relkind AS kind,c.reloptions AS options,
            c.reltoastrelid=0 OR COALESCE(t.reloptions @> ARRAY['autovacuum_enabled=false'],false) AS toast_disabled
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_class t ON t.oid=c.reltoastrelid`;
  const catalog = `c.relkind IN ('r','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'`;
  const result = wanted
    ? await querySettleClient<RelationMaintenance>(
        lease,
        deadline,
        `${from}
       JOIN unnest($1::text[], $2::text[]) AS wanted(schema, name)
         ON n.nspname=wanted.schema AND c.relname=wanted.name
      WHERE ${catalog}
      ORDER BY n.nspname,c.relname`,
        [wanted.map((row) => row.schema), wanted.map((row) => row.name)],
        'scoped relation maintenance metadata',
      )
    : await querySettleClient<RelationMaintenance>(
        lease,
        deadline,
        `${from}
      WHERE ${catalog}
      ORDER BY n.nspname,c.relname`,
        undefined,
        'relation maintenance metadata',
      );
  return result.rows;
}

async function disableAutovacuum(database: GrowthDatabase, relations?: readonly string[]): Promise<void> {
  const deadline = makeSettleDeadline(DEFAULT_SETTLE_TIMEOUT_MS);
  const lease = await checkoutSettleClient(database, deadline);
  let primary: unknown;
  try {
    const metadata = await relationMaintenance(relations, lease, deadline);
    await disableAutovacuumOn(metadata, lease, deadline);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const cause = primary instanceof GrowthSettleInfrastructureError ? primary.cause : primary;
    releaseClient(lease, cause !== undefined && retireHeldClient(cause), primary);
  }
}

async function disableAutovacuumOn(
  relations: readonly RelationMaintenance[],
  lease: SettleClient,
  deadline: SettleDeadline,
): Promise<void> {
  for (const { schema, name, kind, options, toast_disabled } of relations) {
    if (kind !== 'r') continue;
    if (options?.includes('autovacuum_enabled=false') && toast_disabled) continue;
    await querySettleClient(
      lease,
      deadline,
      `ALTER TABLE ${qualifiedIdentifier(`${schema}.${name}`)} SET (autovacuum_enabled = false, toast.autovacuum_enabled = false)`,
      undefined,
      `autovacuum settings for ${schema}.${name}`,
    );
  }
}

function measuredTransactionBackend(
  database: GrowthDatabase,
  operationBackends: ReadonlySet<number> | undefined,
): number | undefined {
  if (!operationBackends) return;
  const transactions = (
    operationBackends as ReadonlySet<number> & {
      readonly transactions?: ReadonlyMap<GrowthDatabase, ReadonlyMap<number, number>>;
    }
  ).transactions?.get(database);
  const activeTransactions = states.get(database)?.activeTransactions;
  const backend = [...(transactions ?? [])].find(
    ([pid, token]) => operationBackends.has(pid) && activeTransactions?.get(pid) === token,
  )?.[0];
  return backend;
}

async function assertMeasuredTransactionOnClient(
  backend: number,
  lease: SettleClient,
  deadline: SettleDeadline,
): Promise<void> {
  const result = await querySettleClient<{
    pid: number;
    backend_type: string;
    application_name: string;
    state: string;
    xact_start: Date | null;
    query: string;
  }>(
    lease,
    deadline,
    `SELECT pid,backend_type,application_name,state,xact_start,split_part(query,E'\\n',1) AS query
       FROM pg_stat_activity WHERE pid=$1`,
    [backend],
    `measured transaction metadata for backend ${backend}`,
    'measured-transaction',
  );
  throw new GrowthSettleInfrastructureError(
    `Backend ${backend} from the measured operation keeps a transaction open; each warmup and measured sample must end its own transaction. Holding backend: ${JSON.stringify(result.rows[0] ?? { pid: backend })}`,
    { kind: 'measured-transaction' },
  );
}

export async function assertMeasuredTransactionsSettled(
  database: GrowthDatabase,
  operationBackends: ReadonlySet<number> | undefined,
): Promise<void> {
  const backend = measuredTransactionBackend(database, operationBackends);
  if (backend === undefined) return;
  const deadline = makeSettleDeadline(DEFAULT_SETTLE_TIMEOUT_MS);
  const lease = await checkoutSettleClient(database, deadline, 'measured-transaction');
  let primary: unknown;
  try {
    await assertMeasuredTransactionOnClient(backend, lease, deadline);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const cause = primary instanceof GrowthSettleInfrastructureError ? primary.cause : primary;
    releaseClient(lease, cause !== undefined && retireHeldClient(cause), primary);
  }
}

export async function settle(
  database: GrowthDatabase,
  options: {
    readonly relations?: readonly string[];
    readonly analyze?: boolean;
    readonly timeoutMs?: number;
    /** Backends observed in the preceding measured run. */
    readonly operationBackends?: ReadonlySet<number>;
  } = {},
): Promise<number> {
  if (options === null || typeof options !== 'object') throw new TypeError('Settle options must be an object');
  if ('pollMs' in options) throw new TypeError('settle does not poll; remove pollMs and configure timeoutMs');
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_SETTLE_TIMEOUT_MS : options.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError('Settle timeoutMs must be a positive safe integer');
  if (options.analyze !== undefined && typeof options.analyze !== 'boolean')
    throw new TypeError('Settle analyze must be a boolean');
  if (options.relations !== undefined) {
    if (!Array.isArray(options.relations)) throw new TypeError('Settle relations must be an array');
    for (const relation of options.relations) qualifiedName(relation);
  }
  if (
    options.operationBackends !== undefined &&
    (typeof options.operationBackends.has !== 'function' || typeof options.operationBackends[Symbol.iterator] !== 'function')
  )
    throw new TypeError('Settle operationBackends must be a set');

  const started = performance.now();
  const deadline = makeSettleDeadline(timeoutMs);
  const backend = measuredTransactionBackend(database, options.operationBackends);
  const needsMaintenance = options.relations === undefined || options.relations.length > 0;
  if (!needsMaintenance && backend === undefined) return performance.now() - started;

  const lease = await checkoutSettleClient(database, deadline);
  const physicalName = connectedDatabase(lease.client) ?? poolDatabaseName(database.admin) ?? databaseName(database);
  let primary: unknown;
  try {
    if (backend !== undefined) await assertMeasuredTransactionOnClient(backend, lease, deadline);
    const metadata = needsMaintenance ? await relationMaintenance(options.relations, lease, deadline) : [];
    await disableAutovacuumOn(metadata, lease, deadline);
    const names = options.relations ?? metadata.map(({ schema, name }) => `${schema}.${name}`);
    for (const relation of names) {
        const sql = [
          'VACUUM (INDEX_CLEANUP ON',
          options.analyze ? ', ANALYZE' : '',
          ') ',
          qualifiedIdentifier(relation),
        ].join('');
        try {
          await querySettleClient(lease, deadline, sql, undefined, `VACUUM relation ${relation}`);
        } catch (error) {
          throw new GrowthSettleInfrastructureError(
            `Could not settle database ${physicalName} relation ${relation}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
    }
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const cause = primary instanceof GrowthSettleInfrastructureError ? primary.cause : primary;
    releaseClient(lease, cause !== undefined && retireHeldClient(cause), primary);
  }
  return performance.now() - started;
}

function retireHeldClient(cause: unknown): boolean {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  if (typeof code === 'string' && (code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03'))
    return true;
  const message = cause instanceof Error ? cause.message : String(cause);
  return /connection (terminated|ended|closed)|not queryable/i.test(message);
}

export function settleAdmin(admin: pg.Pool, options: Parameters<typeof settle>[1] = {}): Promise<number> {
  const database = databasesByAdmin.get(admin);
  if (database) return settle(databaseForName(database, poolDatabaseName(admin) ?? databaseName(database)), options);
  const connectionString = (admin as pg.Pool & { options?: { connectionString?: string } }).options?.connectionString;
  if (!connectionString) throw new Error('Growth admin pool must have a connection string');
  const target: GrowthDatabase = {
    url: connectionString,
    pool: admin,
    admin,
    openPool: () => {
      throw new Error('An external growth admin pool cannot open instrumented pools');
    },
    close: async () => {},
  };
  return settle(target, options);
}

function poolDatabaseName(pool: pg.Pool): string | undefined {
  const connectionString = (pool as pg.Pool & { options?: { connectionString?: string } }).options?.connectionString;
  if (connectionString) return new URL(connectionString).pathname.slice(1);
  const database = (pool as pg.Pool & { options?: { database?: unknown } }).options?.database;
  return typeof database === 'string' ? database : undefined;
}

/**
 * Runs `grow` for checkGrowth: counts the statements and written rows of every pool the database hands out, waits for
 * work already submitted on those pools (and connection setup) before closing the counts, and lets `seed` see that its
 * caller settles afterwards.
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
    let value!: T;
    let growError: unknown;
    let growFailed = false;
    try {
      value = await growing.run(database.admin, grow);
    } catch (error) {
      growError = error;
      growFailed = true;
    }
    const cleanupErrors = await drainCaptureWork(state.seedingPending, state.setupTasks);
    const failures: unknown[] = [];
    const addFailure = (error: unknown): void => {
      if (!failures.includes(error)) failures.push(error);
    };
    if (growFailed) addFailure(growError);
    if (state.setupError) addFailure(state.setupError);
    for (const error of cleanupErrors) addFailure(error);
    const counted = { statements: seeding.statements, rowsWritten: seeding.rowsWritten };
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'Growth seeding failed while pending work was settling', {
        cause: failures[0],
      });
    return { value, seeding: counted };
  } finally {
    state.seeding = undefined;
  }
}

/** Whether `admin` belongs to a database whose checkGrowth is inside `grow`, and settles when `grow` returns. */
export function vacuumFollows(admin: pg.Pool): boolean {
  return growing.getStore() === admin;
}
