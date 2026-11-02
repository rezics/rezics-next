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
  seeding: SeedingCount | undefined;
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
 * client's own queue and never counted. A rollback, including one to a savepoint, or a failed statement can undo it,
 * so queued statements reassert it; a statement that ends a transaction sends none, since a failed transaction can
 * refuse it.
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
    void task.then(() => state.setupTasks.delete(task));
  };

  const interceptedQuery = ((...args: Parameters<PoolClient['query']>) => {
    const applicationQuery = !suppressAttribution;
    const name = preparedStatementName(args[0]);
    const text = statementText(args[0]) ?? (name === undefined ? undefined : preparedStatementText(client, name));
    let attribution = suppressAttribution ? undefined : currentAttribution(state);
    if (!suppressAttribution && !attribution && state.active) attribution = { capture: state.active, background: true };
    let record: StatementRecord | undefined;
    if (explain && !suppressAttribution && (text !== undefined || name !== undefined) && attribution) {
      const capture = attribution.capture;
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
    }
    if (state.seeding && !suppressAttribution) state.seeding.statements++;
    if (explain && !suppressAttribution) {
      if (text === undefined || !MAY_RESET_SETTING.test(text)) {
        const wanted = state.active !== undefined;
        // A pg client queues concurrent queries. A preceding queued query may fail or roll back the transaction after
        // this call observes `explaining`, so reassert the setting between queued statements as well as on transitions.
        if (explaining !== wanted || pendingQueries > 0) switchTo(wanted);
      }
      // COMMIT can roll back an already-failed transaction, which also rolls back SET changes. Treat every end as
      // unknown and reassert on the next query; a successful commit simply repeats the harmless session setting.
      if (text !== undefined && MAY_RESET_SETTING.test(text)) explaining = undefined;
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
          record.errorMessage = error instanceof Error ? error.message : String(error);
        }
      }
      if (!failed) countWrites(state.seeding, result);
      else if (explain) explaining = undefined;
      if (applicationQuery) pendingQueries--;
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
  client.query = interceptedQuery;

  return queryWithoutAttribution;
}

function instrument(client: PoolClient, state: CaptureState): void {
  instrumentBytes(client, state);

  client.on('notice', (notice) => {
    const wireStatement = clientExecutingStatement.get(client);
    const attribution = wireStatement?.attribution;
    const message = notice.message;
    const marker = 'plan:\n';
    if (!attribution || typeof message !== 'string' || !message.startsWith('duration:') || !message.includes(marker))
      return;

    try {
      const plan = JSON.parse(message.slice(message.indexOf(marker) + marker.length)) as unknown;
      const capture = attribution.capture;
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

  const lifecycle = createGrowthDatabaseLifecycle();
  return lifecycle.setup(async () => {
    const pool = lifecycle.acquire('instrumented pool', () => createPool(url, { connectionTimeoutMillis: 10_000 }));
    const admin = lifecycle.acquire('admin pool', () => new pg.Pool({ connectionString: url, max: 2 }));
    const state: CaptureState = {
      lifecycle,
      active: undefined,
      seeding: undefined,
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
    await disableAutovacuum(database);
    return database;
  });
}

export async function capture<T>(
  database: GrowthDatabase,
  operation: () => Promise<T>,
  options: { readonly includeBackends?: boolean } = {},
): Promise<{ value: T; capture: Capture }> {
  return captureInternal(database, operation, options, false);
}

async function captureInternal<T>(
  database: GrowthDatabase,
  operation: () => Promise<T>,
  options: { readonly includeBackends?: boolean },
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
  const active: ActiveCapture = {
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
      for (const [plans, databaseNames] of [
        [active.plans, active.planDatabases],
        [active.backgroundPlans, active.backgroundPlanDatabases],
      ] as const) {
        for (let index = 0; index < plans.length; index++) {
          const target = databaseForName(database, databaseNames[index] || databaseName(database));
          const relations = run.get(target) ?? new Set<string>();
          run.databases.add(target);
          collectModifyTargets(plans[index], relations);
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
        requestBytes: foreground.map(({ requestBytes }) => requestBytes),
        responseBytes: foreground.map(({ responseBytes }) => responseBytes),
        plans: active.plans,
        planStatements: active.planStatements,
        statementErrors: foreground.map(({ errorCode }) => errorCode),
        statementErrorMessages: foreground.map(({ errorMessage }) => errorMessage),
        ...(active.includeBackends
          ? { statementBackends: foreground.map(({ backend }) => backend), planBackends: active.planBackends }
          : {}),
        backgroundStatements: background.map(({ text }) => text),
        backgroundRequestBytes: background.map(({ requestBytes }) => requestBytes),
        backgroundResponseBytes: background.map(({ responseBytes }) => responseBytes),
        backgroundPlans: active.backgroundPlans,
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

/** Runs an explicitly owned warm-up capture; nested captures inherit warm-up custody. */
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

function collectModifyTargets(document: unknown, output: Set<string>): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (record['Node Type'] === 'ModifyTable' && typeof record['Relation Name'] === 'string') {
      const schema = typeof record['Schema'] === 'string' ? record['Schema'] : 'public';
      output.add(`${schema}.${record['Relation Name']}`);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(document);
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

export class GrowthSettleInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrowthSettleInfrastructureError';
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function qualifiedIdentifier(value: string): string {
  const split = value.indexOf('.');
  if (split < 1) throw new TypeError(`Expected schema-qualified relation: ${value}`);
  return `${quoteIdentifier(value.slice(0, split))}.${quoteIdentifier(value.slice(split + 1))}`;
}

async function tableNames(
  database: GrowthDatabase,
): Promise<{ schema: string; name: string; kind: string; options: string[] | null; toast_disabled: boolean }[]> {
  const result = await database.admin.query<{
    schema: string;
    name: string;
    kind: string;
    options: string[] | null;
    toast_disabled: boolean;
  }>(
    `SELECT n.nspname AS schema, c.relname AS name,c.relkind AS kind,c.reloptions AS options,
            c.reltoastrelid=0 OR COALESCE(t.reloptions @> ARRAY['autovacuum_enabled=false'],false) AS toast_disabled
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_class t ON t.oid=c.reltoastrelid
      WHERE c.relkind IN ('r','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
      ORDER BY n.nspname,c.relname`,
  );
  return result.rows;
}

async function disableAutovacuum(database: GrowthDatabase): Promise<void> {
  for (const { schema, name, kind, options, toast_disabled } of await tableNames(database)) {
    if (kind !== 'r') continue;
    if (options?.includes('autovacuum_enabled=false') && toast_disabled) continue;
    await database.admin.query(
      `ALTER TABLE ${qualifiedIdentifier(`${schema}.${name}`)} SET (autovacuum_enabled = false, toast.autovacuum_enabled = false)`,
    );
  }
}

type SettleHolder = {
  pid: number;
  backend_type: string;
  application_name: string;
  state: string;
  xact_start: Date | null;
  query: string;
};

async function horizonHolders(database: GrowthDatabase, horizon: string): Promise<SettleHolder[]> {
  const result = await database.admin.query<SettleHolder>(
    `WITH current_xid AS (
       SELECT pg_current_xact_id()::text::numeric AS xid
     ), xid_parts AS (
       SELECT xid - mod(xid, 4294967296) AS epoch, mod(xid, 4294967296) AS low FROM current_xid
     )
     SELECT a.pid,a.backend_type,a.application_name,a.state,a.xact_start,split_part(a.query,E'\\n',1) AS query
       FROM pg_stat_activity a CROSS JOIN xid_parts c
      CROSS JOIN LATERAL (
        SELECT CASE WHEN a.backend_xid IS NULL THEN NULL::numeric
                    ELSE c.epoch + a.backend_xid::text::numeric
                      - CASE WHEN a.backend_xid::text::numeric > c.low THEN 4294967296 ELSE 0 END END AS xid,
               CASE WHEN a.backend_xmin IS NULL THEN NULL::numeric
                    ELSE c.epoch + a.backend_xmin::text::numeric
                      - CASE WHEN a.backend_xmin::text::numeric > c.low THEN 4294967296 ELSE 0 END END AS xmin
      ) full_xid
      WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()
        AND ((full_xid.xid IS NOT NULL AND full_xid.xid < $1::numeric)
          OR (full_xid.xmin IS NOT NULL AND full_xid.xmin < $1::numeric))
      ORDER BY a.pid`,
    [horizon],
  );
  return result.rows;
}

async function waitForHorizon(
  database: GrowthDatabase,
  horizon: string,
  deadline: number,
  pollMs: number,
  operationBackends: ReadonlySet<number> = new Set(),
) {
  while (true) {
    const holders = await horizonHolders(database, horizon);
    if (holders.length === 0) return;
    const state = states.get(database);
    const operationTransactions = (
      operationBackends as ReadonlySet<number> & {
        readonly transactions?: ReadonlyMap<GrowthDatabase, ReadonlyMap<number, number>>;
      }
    ).transactions;
    const operationHolder = holders.find(({ pid }) => {
      const transaction = operationTransactions?.get(database)?.get(pid);
      return (
        operationBackends.has(pid) && transaction !== undefined && state?.activeTransactions.get(pid) === transaction
      );
    });
    if (operationHolder)
      throw new GrowthSettleInfrastructureError(
        `Backend ${operationHolder.pid} from the measured operation keeps a transaction open across repetitions; each repetition must commit. Holding backend: ${JSON.stringify(operationHolder)}`,
      );
    if (Date.now() >= deadline)
      throw new GrowthSettleInfrastructureError(
        `Could not reach a clean transaction horizon; holding backends: ${JSON.stringify(holders)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function visibilityDetails(database: GrowthDatabase, relations: readonly string[]) {
  const details: Record<string, unknown> = {};
  const extension = await database.admin.query<{ installed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_visibility') AS installed`,
  );
  if (!extension.rows[0]?.installed) {
    try {
      await database.admin.query('CREATE EXTENSION pg_visibility');
    } catch {
      // The remaining server and ownership details still identify inaccessible visibility diagnostics.
      details.pgVisibility = 'unavailable to the growth database role';
    }
  }
  const installed = await database.admin.query<{ installed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_visibility') AS installed`,
  );
  if (installed.rows[0]?.installed) {
    for (const relation of relations) {
      const blocks = await database.admin.query(
        `SELECT blkno,all_visible,all_frozen,pd_all_visible FROM pg_visibility($1::regclass) WHERE NOT all_visible ORDER BY blkno`,
        [relation],
      );
      const check = await database.admin.query(`SELECT * FROM pg_check_visible($1::regclass)`, [relation]);
      details[relation] = { notAllVisibleBlocks: blocks.rows, pgCheckVisible: check.rows };
    }
  }
  const [prepared, slots, owners] = await Promise.all([
    database.admin.query(
      `SELECT gid,prepared,owner,database FROM pg_prepared_xacts WHERE database=current_database() ORDER BY gid`,
    ),
    database.admin.query(
      `SELECT slot_name,slot_type,database,xmin::text AS xmin,catalog_xmin::text AS catalog_xmin
         FROM pg_replication_slots WHERE database=current_database() OR xmin IS NOT NULL OR catalog_xmin IS NOT NULL
        ORDER BY slot_name`,
    ),
    database.admin.query(
      `SELECT n.nspname || '.' || c.relname AS relation,pg_get_userbyid(c.relowner) AS owner,current_user AS settle_role
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE (n.nspname || '.' || c.relname)=ANY($1::text[]) ORDER BY relation`,
      [relations],
    ),
  ]);
  details.preparedTransactions = prepared.rows;
  details.replicationSlots = slots.rows;
  details.owners = owners.rows;
  return details;
}

type RelationCounters = {
  relation: string;
  n_tup_ins: string;
  n_tup_upd: string;
  n_tup_del: string;
  n_dead_tup: string;
};

async function settleCounters(database: GrowthDatabase, relations: readonly string[]): Promise<RelationCounters[]> {
  // PostgreSQL backends publish cumulative statistics asynchronously. Give them a flush window before reading.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await database.admin.query('SELECT pg_stat_clear_snapshot()');
  const result = await database.admin.query<RelationCounters>(
    `SELECT s.schemaname || '.' || s.relname AS relation,s.n_tup_ins::text,s.n_tup_upd::text,
            s.n_tup_del::text,s.n_dead_tup::text
       FROM pg_stat_user_tables s WHERE s.schemaname || '.' || s.relname=ANY($1::text[]) ORDER BY relation`,
    [relations],
  );
  return result.rows;
}

function countersChanged(before: RelationCounters[], after: RelationCounters[]): boolean {
  const previous = new Map(before.map((row) => [row.relation, row]));
  return after.some((row) => {
    const old = previous.get(row.relation);
    return (
      old !== undefined &&
      (old.n_tup_ins !== row.n_tup_ins || old.n_tup_upd !== row.n_tup_upd || old.n_tup_del !== row.n_tup_del)
    );
  });
}

async function tupleDetails(
  database: GrowthDatabase,
  relation: string,
  blocks: readonly { blkno: number | string }[],
  horizon: string,
) {
  const columns = await database.admin.query<{
    name: string;
    is_primary: boolean;
    is_text: boolean;
    has_workflow_uuid: boolean;
  }>(
    `SELECT a.attname AS name,
            EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS is_primary,
            a.atttypid='text'::regtype AS is_text,
            EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid=c.oid AND x.attname='workflow_uuid' AND NOT x.attisdropped) AS has_workflow_uuid
       FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE c.oid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [relation],
  );
  const primary = columns.rows.filter((column) => column.is_primary).map(({ name }) => name);
  const text = columns.rows.filter((column) => column.is_text).map(({ name }) => name);
  const hasWorkflow = columns.rows[0]?.has_workflow_uuid ?? false;
  const [schema] = relation.split('.', 2);
  const qualified = qualifiedIdentifier(relation);
  const workflowTable = qualifiedIdentifier(`${schema}.workflow_status`);
  const workflowExists =
    hasWorkflow &&
    (
      await database.admin.query<{ exists: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS exists`, [
        `${schema}.workflow_status`,
      ])
    ).rows[0]?.exists;
  const found: Record<string, unknown>[] = [];
  for (const { blkno } of blocks) {
    const result = await database.admin.query<{
      ctid: string;
      xmin: string;
      xmax: string;
      at_or_after_horizon: boolean;
      primary_key: Record<string, unknown>;
      text_columns: Record<string, unknown>;
      workflow: Record<string, unknown> | null;
    }>(
      `SELECT t.ctid::text,t.xmin::text,t.xmax::text,(t.xmin::text::bigint >= $2::bigint) AS at_or_after_horizon,
              (SELECT jsonb_object_agg(k,v) FROM (SELECT key AS k,value AS v FROM jsonb_each(to_jsonb(t)) WHERE key=ANY($3::text[])) p) AS primary_key,
              (SELECT jsonb_object_agg(k,left(v,120)) FROM (SELECT key AS k,value AS v FROM jsonb_each_text(to_jsonb(t)) WHERE key=ANY($4::text[])) p) AS text_columns,
              ${
                workflowExists
                  ? `(SELECT jsonb_build_object('name',ws.name,'status',ws.status,'queue_name',ws.queue_name,'created_at',ws.created_at)
                  FROM ${workflowTable} ws WHERE to_jsonb(ws)->>'workflow_uuid'=to_jsonb(t)->>'workflow_uuid' LIMIT 1)`
                  : 'NULL::jsonb'
              } AS workflow
         FROM ${qualified} t
        WHERE t.ctid >= format('(%s,1)',$1::integer)::tid AND t.ctid < format('(%s,1)',$1::integer+1)::tid
        ORDER BY t.xmin::text::bigint DESC,t.ctid LIMIT 16`,
      [Number(blkno), horizon, primary, text],
    );
    found.push(...result.rows);
  }
  found.sort((left, right) => Number(right.xmin) - Number(left.xmin));
  return found.slice(0, 16);
}

export async function settle(
  database: GrowthDatabase,
  options: {
    readonly relations?: readonly string[];
    readonly analyze?: boolean;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
    /** Backends observed in the preceding measured run. */
    readonly operationBackends?: ReadonlySet<number>;
  } = {},
): Promise<number> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  const horizonResult = await database.admin.query<{ horizon: string }>(
    `SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS horizon`,
  );
  const horizon = horizonResult.rows[0]!.horizon;
  await disableAutovacuum(database);
  const names = options.relations ?? (await tableNames(database)).map(({ schema, name }) => `${schema}.${name}`);
  const vacuum = async (
    relations: readonly string[],
    vacuumOptions: {
      readonly disablePageSkipping?: boolean;
      readonly freeze?: boolean;
      readonly verbose?: boolean;
    } = {},
  ) => {
    const notices: string[] = [];
    if (relations.length === 0) return notices;
    const client = await database.admin.connect();
    const captureNotice = (notice: unknown) => {
      if (typeof notice !== 'object' || notice === null) return;
      const message = 'message' in notice && typeof notice.message === 'string' ? notice.message : undefined;
      const severity = 'severity' in notice && typeof notice.severity === 'string' ? notice.severity : 'NOTICE';
      if (message) notices.push(`${severity}: ${message}`);
    };
    client.on('notice', captureNotice);
    try {
      for (const relation of relations) {
        const sql = `VACUUM (${vacuumOptions.verbose ? 'VERBOSE, ' : ''}${vacuumOptions.freeze ? 'FREEZE, ' : ''}INDEX_CLEANUP ON${vacuumOptions.disablePageSkipping ? ', DISABLE_PAGE_SKIPPING' : ''}${options.analyze ? ', ANALYZE' : ''}) ${qualifiedIdentifier(relation)}`;
        try {
          await client.query(sql);
        } catch (error) {
          const current = await database.admin.query<{ name: string }>('SELECT current_database() AS name');
          throw new GrowthSettleInfrastructureError(
            `Could not settle database ${current.rows[0]!.name} relation ${relation}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      client.removeListener('notice', captureNotice);
      client.release();
    }
    return notices;
  };
  const verify = async () => {
    if (names.length === 0) return [];
    const result = await database.admin.query<{ relation: string; pages: number; visible: number }>(
      `SELECT n.nspname || '.' || c.relname AS relation,c.relpages AS pages,c.relallvisible AS visible
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind IN ('r','m') AND c.relpages > 0 AND (n.nspname || '.' || c.relname)=ANY($1::text[])
          AND c.relallvisible <> c.relpages`,
      [names],
    );
    return result.rows;
  };
  let dirty: Awaited<ReturnType<typeof verify>> = [];
  let lastNotices: string[] = [];
  const counterSamples: RelationCounters[][] = [];
  for (let round = 0; round < 3; round++) {
    await waitForHorizon(database, horizon, deadline, pollMs, options.operationBackends);
    const targets = round === 0 ? names : dirty.length > 0 ? dirty.map(({ relation }) => relation) : names;
    lastNotices = await vacuum(targets, {
      disablePageSkipping: round > 0,
      freeze: round > 0,
      verbose: round === 2,
    });
    dirty = await verify();
    if (dirty.length === 0) break;
    if (round < 2)
      counterSamples.push(
        await settleCounters(
          database,
          dirty.map(({ relation }) => relation),
        ),
      );
    if (round < 2) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (dirty.length > 0) {
    const waiting = await database.admin.query(
      `SELECT pid,backend_type,application_name,state,xact_start,backend_xmin::text,backend_xid::text
         FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() ORDER BY pid`,
    );
    const moving = counterSamples.some(
      (sample, index) => index > 0 && countersChanged(counterSamples[index - 1]!, sample),
    );
    const staticCounters = counterSamples.length > 0 && !moving;
    const heldSnapshot =
      staticCounters &&
      waiting.rows.some(
        (backend) => typeof backend.backend_xmin === 'string' && Number(backend.backend_xmin) >= Number(horizon),
      );
    const cause = moving ? 'concurrent writer' : heldSnapshot ? 'snapshot held during VACUUM' : 'unclassified';
    const blocks = await visibilityDetails(
      database,
      dirty.map(({ relation }) => relation),
    );
    const tupleRows: Record<string, unknown> = {};
    for (const { relation } of dirty) {
      const detail = blocks[relation] as { notAllVisibleBlocks?: { blkno: number }[] } | undefined;
      if (detail?.notAllVisibleBlocks)
        tupleRows[relation] = await tupleDetails(database, relation, detail.notAllVisibleBlocks, horizon);
    }
    const attribution = { ...blocks, tuples: tupleRows };
    throw new GrowthSettleInfrastructureError(
      `VACUUM did not make every page all-visible after three rounds; settle cause: ${cause}; starting horizon: ${horizon}; relation statistics by round: ${JSON.stringify(counterSamples)}; relations: ${JSON.stringify(dirty)}; backends: ${JSON.stringify(waiting.rows)}; vacuum notices: ${JSON.stringify(lastNotices)}; attribution: ${JSON.stringify(attribution)}`,
    );
  }
  return performance.now() - started;
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
 * Runs `grow` for checkGrowth: counts the statements and written rows of every pool the database hands out, and lets
 * `seed` see that its caller settles afterwards.
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

/** Whether `admin` belongs to a database whose checkGrowth is inside `grow`, and settles when `grow` returns. */
export function vacuumFollows(admin: pg.Pool): boolean {
  return growing.getStore() === admin;
}
