import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg, { type Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { configureTestReceiptKeys } from './receipt-keys.ts';
import {
  MAX_GROWTH_CAPTURE_BYTES,
  MAX_GROWTH_CAPTURE_ENTRIES,
  MAX_GROWTH_NATIVE_NOTICE_BYTES,
  GrowthCaptureBudget,
  parseNativePlanNotice,
  type GrowthCaptureBudgetLimits,
  type GrowthCaptureEvidenceSide,
  type GrowthNativeNoticeReservation,
} from './growth-capture-budget.ts';
import { walkPlanTree } from './growth-plan-walk.ts';
import type { Capture } from './growth-cost.ts';
import { GrowthCostFolder, type CostFoldedCapture, type FoldedStatementInput } from './growth-cost-fold.ts';
import { drainCaptureWork } from './growth-capture-drain.ts';
import {
  GROWTH_FAILURE_CAUSE_LIMIT,
  describeGrowthFailure,
  growthFailureContextBytes,
  growthFailureEvidence,
  recordGrowthFailureEvidence,
} from './growth-failure-evidence.ts';
import { collectModifyTargets } from './growth-plan-walk.ts';
import { classifyGrowthSql } from './growth-sql-kind.ts';
import {
  addRelationIdentity,
  quotedRelationIdentity,
  relationIdentityFromQualifiedName,
  relationIdentityLabel,
  type RelationIdentity,
} from './growth-relation-identity.ts';

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
  let admittedChecks = Promise.resolve();
  const assertOpen = () => {
    if (closing) throw new Error('Growth database is closed');
  };
  const acquire = <T extends CloseablePool>(name: string, create: () => T): T => {
    assertOpen();
    const resource = create();
    resources.set(resource, name);
    return resource;
  };
  const runExclusiveCheck = <T>(operation: () => Promise<T>): Promise<T> => {
    assertOpen();
    const previous = admittedChecks;
    let release!: () => void;
    admittedChecks = new Promise<void>((resolve) => (release = resolve));
    return (async () => {
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    })();
  };
  const closeResources = async (): Promise<void> => {
    const results = await Promise.allSettled(
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
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = admittedChecks.then(closeResources);
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
  return { acquire, assertOpen, close, runExclusiveCheck, setup };
}

export type SeedingCount = { statements: number; rowsWritten: number };

type CaptureTaskTracker = {
  pending: number;
  errors: unknown[];
  omittedErrors: number;
  idle: Promise<void> | undefined;
  resolveIdle: (() => void) | undefined;
};

function captureTaskTracker(): CaptureTaskTracker {
  return { pending: 0, errors: [], omittedErrors: 0, idle: undefined, resolveIdle: undefined };
}

type ActiveCapture = {
  readonly id: number;
  readonly budget: GrowthCaptureBudget;
  readonly costFolder: GrowthCostFolder | undefined;
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
  readonly transactionHistory: Array<
    Readonly<{ database: string; backend: number; token: number; state: 'open' | 'closed' }>
  >;
  pending: Set<Promise<void>>;
  error?: Error;
  readonly writeTargets: Map<string, RelationIdentity>;
  omittedStatements: number;
  omittedStatementErrors: number;
  omittedPlans: number;
  omittedWriteTargets: number;
  omittedTransactions: number;
  missingPlanCount?: number;
  missingPlanOccurrences?: Array<Readonly<{ side: GrowthCaptureEvidenceSide; index: number; text: string }>>;
  omittedMissingPlanDetails: number;
  readonly nestedCaptureWork: CaptureTaskTracker;
};
type StatementRecord = {
  text: string;
  readonly background: boolean;
  readonly backend: number | undefined;
  readonly index: number;
  readonly database: string;
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
  topLevelPlanSeen: boolean;
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
  setupError: unknown;
  setupFailed: boolean;
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
  return state.lifecycle.runExclusiveCheck(async () => {
    state.growthCheckActive = true;
    try {
      return await operation();
    } finally {
      state.growthCheckActive = false;
    }
  });
}

type BackendSet = Set<number> & { readonly transactions: Map<GrowthDatabase, Map<number, number>> };
type WriteTargets = Map<string, RelationIdentity>;
type RunNativeCapture = Readonly<Record<string, unknown>>;
type RunCapture = Map<GrowthDatabase, WriteTargets> & {
  readonly databases: Set<GrowthDatabase>;
  readonly backends: BackendSet;
  readonly nativeCaptures: RunNativeCapture[];
  nativeCaptureEntries: number;
  nativeCaptureBytes: number;
  omittedNativeCaptures: number;
  failureContextAccounted: boolean;
  readonly captureWork: CaptureTaskTracker;
};
const MAX_GROWTH_RUN_NATIVE_CAPTURES = 128;
const RUN_NATIVE_CAPTURE_DESCRIPTOR_BYTES = 4 * 1024;
const RUN_FAILURE_CONTEXT_ENTRIES = 512;
const RUN_FAILURE_CONTEXT_BYTES = 32 * 1024;
const measuredRun = new AsyncLocalStorage<RunCapture>();
// pg can submit the next queued query before the previous query's promise settles.
const clientWireQueue = new WeakMap<PoolClient, WireStatementQueue>();
const clientWireStatement = new WeakMap<PoolClient, WireStatement | undefined>();
const clientExecutingStatement = new WeakMap<PoolClient, WireStatement | undefined>();
// An extended-protocol SELECT keeps its executor until the unnamed portal is dropped. In an explicit
// transaction that can happen during the next Bind or COMMIT, after its own ReadyForQuery.
const clientPendingPortalPlan = new WeakMap<PoolClient, WireStatement>();
let nextCaptureId = 1;
const clientRowDescription = new WeakMap<PoolClient, readonly { readonly dataTypeID: number }[]>();
const nativePlanCommands = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);

function isAttribution(value: Attribution | pg.Pool | undefined): value is Attribution {
  return typeof value === 'object' && value !== null && 'capture' in value && 'background' in value;
}

function addCaptureTask(tracker: CaptureTaskTracker, task: Promise<unknown>): void {
  if (tracker.pending === 0) {
    tracker.idle = new Promise<void>((resolve) => {
      tracker.resolveIdle = resolve;
    });
  }
  tracker.pending++;
  void task
    .then(
      () => undefined,
      (error: unknown) => {
        if (tracker.errors.length < GROWTH_FAILURE_CAUSE_LIMIT) tracker.errors.push(error);
        else tracker.omittedErrors++;
      },
    )
    .then(() => {
      tracker.pending--;
      if (tracker.pending === 0) {
        const resolve = tracker.resolveIdle;
        tracker.idle = undefined;
        tracker.resolveIdle = undefined;
        resolve?.();
      }
    });
}

async function drainCaptureTasks(
  tracker: CaptureTaskTracker,
): Promise<{ errors: readonly unknown[]; omittedErrors: number }> {
  while (tracker.pending > 0) await tracker.idle;
  const errors = tracker.errors.splice(0);
  const omittedErrors = tracker.omittedErrors;
  tracker.omittedErrors = 0;
  return { errors, omittedErrors };
}

function trackCaptureTask<T>(task: Promise<T>): Promise<T> {
  const parent = growing.getStore();
  if (isAttribution(parent)) addCaptureTask(parent.capture.nestedCaptureWork, task);
  const run = measuredRun.getStore();
  if (run) addCaptureTask(run.captureWork, task);
  return task;
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
  try {
    if (error instanceof Error) {
      const summary = describeGrowthFailure(error, 'capture-context');
      return new Error(summary.message, { cause: error });
    }
  } catch {
    // A hostile proxy can make even `instanceof` throw. The shared descriptor below is safe.
  }
  return new Error(describeGrowthFailure(error, 'capture-context').message, { cause: error });
}

function recordSetupFailure(state: CaptureState, error: unknown): void {
  if (state.setupFailed) return;
  state.setupFailed = true;
  state.setupError = error;
}

function captureFailureContext(error: unknown, detail: string): Error {
  const summary = describeGrowthFailure(error, 'capture-context');
  return new Error(`${summary.message || 'Capture instrumentation failed'}; ${detail}`, { cause: error });
}

function occurrenceFailureContext(
  side: GrowthCaptureEvidenceSide,
  index: number | undefined,
  text: string | undefined,
  noticeBytes?: number,
): string {
  const statement =
    text === undefined
      ? 'SQL unavailable'
      : `SQL ${JSON.stringify(text.slice(0, 180))} (${Buffer.byteLength(text, 'utf8')} UTF-8 bytes)`;
  const notice = noticeBytes === undefined ? '' : `, native notice ${noticeBytes} UTF-8 bytes`;
  return `${side} statement occurrence ${index ?? 'unowned'} ${statement}${notice}`;
}

function retainCapturePlanWrites(
  capture: ActiveCapture,
  plan: unknown,
  database: string,
  location: string,
  side: GrowthCaptureEvidenceSide,
): void {
  const physical = database || databaseName(capture.database);
  const discovered = new Map<string, RelationIdentity>();
  collectModifyTargets(plan, discovered, location);
  for (const identity of discovered.values()) {
    const withDatabase = { ...identity, database: physical };
    const key = JSON.stringify([physical, identity.schema, identity.name]);
    if (!capture.writeTargets.has(key)) {
      if (capture.writeTargets.size >= 128) capture.omittedWriteTargets++;
      else {
        try {
          const bytes = Buffer.byteLength(JSON.stringify(withDatabase), 'utf8');
          capture.budget.retainFoldedSummary(side, 'diagnostic write target', 1, bytes);
          capture.writeTargets.set(key, withDatabase);
        } catch (error) {
          capture.omittedWriteTargets++;
          capture.error ??= captureFailureContext(
            error,
            `${physical}.${identity.schema}.${identity.name} write target`,
          );
        }
      }
    }
  }
  const run = capture.run;
  if (!run) return;
  const target = databaseForName(capture.database, physical);
  run.databases.add(target);
  const relations = run.get(target) ?? new Map<string, RelationIdentity>();
  for (const identity of discovered.values()) addRelationIdentity(relations, { ...identity, database: physical });
  if (relations.size > 0) run.set(target, relations);
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
    const wireStatement = clientWireStatement.get(client);
    clientExecutingStatement.set(client, wireStatement);
    const result = execute(config, more);
    // Finish a fully consumed unnamed portal before Sync. Otherwise a following ROLLBACK destroys its executor
    // without an auto_explain notice, even though SELECT succeeded. Close adds no SQL or query execution and leaves
    // transaction locks and writes intact. Suspended and named portals retain their caller's lifetime.
    if (config && wireStatement?.record && !config.portal && !config.rows)
      connection.close({ type: 'P', name: '' }, more);
    return result;
  }) as typeof connection.execute;

  // Clear the dispatch owner before pg submits the next queued query. A SELECT's pending portal keeps its
  // separate cleanup owner when an explicit transaction outlives ReadyForQuery.
  connection.prependListener('readyForQuery', (message: { readonly status?: string }) => {
    const wireStatement = clientExecutingStatement.get(client) ?? clientWireStatement.get(client);
    const attribution = wireStatement?.attribution;
    const backend = backendPid(client);
    if (message.status === 'T' || message.status === 'E') {
      if (!transaction.active) transaction.token = ++state.nextTransactionToken;
      transaction.active = true;
      if (backend !== undefined) {
        state.activeTransactions.set(backend, transaction.token);
        if (attribution) {
          const database = databaseForName(
            attribution.capture.database,
            connectedDatabase(client) ?? databaseName(attribution.capture.database),
          );
          let captureTransactions = attribution.capture.transactions.get(database);
          if (!captureTransactions) {
            captureTransactions = new Map();
            attribution.capture.transactions.set(database, captureTransactions);
          }
          if (captureTransactions.get(backend) !== transaction.token) {
            try {
              const physical = databaseName(database);
              attribution.capture.budget.retainFoldedSummary(
                attribution.background ? 'background' : 'foreground',
                'transaction state',
                1,
                Buffer.byteLength(physical, 'utf8') + 24,
              );
              captureTransactions.set(backend, transaction.token);
              if (attribution.capture.transactionHistory.length < 128)
                attribution.capture.transactionHistory.push({
                  database: physical,
                  backend,
                  token: transaction.token,
                  state: 'open',
                });
              else attribution.capture.omittedTransactions++;
            } catch (error) {
              attribution.capture.omittedTransactions++;
              attribution.capture.error ??= captureFailureContext(error, `backend ${backend} transaction state`);
            }
          }
          let runTransactions: Map<number, number> | undefined;
          if (!attribution.background) {
            runTransactions = attribution.capture.run?.backends.transactions.get(database);
            if (attribution.capture.run && !runTransactions) {
              runTransactions = new Map();
              attribution.capture.run.backends.transactions.set(database, runTransactions);
            }
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
          const history = attribution.capture.transactionHistory.find(
            (entry) =>
              entry.database === databaseName(database) && entry.backend === backend && entry.token === completedToken,
          );
          if (history) (history as { state: 'open' | 'closed' }).state = 'closed';
          if (!attribution.background) {
            const runTransactions = attribution.capture.run?.backends.transactions.get(database);
            if (runTransactions?.get(backend) === completedToken) runTransactions.delete(backend);
          }
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
      const wireStatement = clientWireStatement.get(client) ?? clientExecutingStatement.get(client);
      if (tag === 'SELECT' && record && wireStatement?.bound && !wireStatement.topLevelPlanSeen)
        clientPendingPortalPlan.set(client, wireStatement);
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
        if ((error as { code?: unknown } | null)?.code !== IN_FAILED_TRANSACTION) recordSetupFailure(state, error);
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
    if (explain && !suppressAttribution && (text !== undefined || name !== undefined) && attribution) {
      const capture = attribution.capture;
      const side = attribution.background ? 'background' : 'foreground';
      const occurrenceIndex = attribution.background
        ? capture.backgroundStatementCount
        : capture.foregroundStatementCount;
      if (capture.error) capture.omittedStatements++;
      else {
        try {
          capture.budget.retainStatementText(side, Buffer.byteLength(text ?? '', 'utf8'));
          const index = attribution.background
            ? capture.backgroundStatementCount++
            : capture.foregroundStatementCount++;
          const database = connectedDatabase(client) ?? databaseName(capture.database);
          record = {
            text: text ?? '',
            background: attribution.background,
            backend: backendPid(client),
            index,
            database,
            requestBytes: 0,
            responseBytes: 0,
            errorCode: null,
            errorMessage: null,
            requiresNativePlan: false,
          };
          capture.statementRecords.push(record);
          capture.costFolder?.registerStatement(side, index);
        } catch (error) {
          capture.omittedStatements++;
          capture.error ??= captureFailureContext(error, occurrenceFailureContext(side, occurrenceIndex, text ?? ''));
        }
      }
    }
    if (state.seeding && !suppressAttribution) state.seeding.statements++;
    if (explain && !suppressAttribution) {
      const resetsSetting = mayResetCaptureSetting(text);
      if (!resetsSetting) {
        const wanted = state.active !== undefined;
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
      topLevelPlanSeen: false,
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
              attribution.capture.costFolder?.retainStatementError(record.background ? 'background' : 'foreground');
              record.errorMessage = errorMessage;
            } catch (budgetError) {
              attribution.capture.omittedStatementErrors++;
              attribution.capture.error ??= captureFailureContext(
                budgetError,
                occurrenceFailureContext(record.background ? 'background' : 'foreground', record.index, record.text),
              );
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
    const message = notice.message;
    const marker = 'plan:\n';
    if (typeof message !== 'string' || !message.startsWith('duration:') || !message.includes(marker)) return;
    // Portal cleanup precedes the next statement's execution. Preserve that occurrence across wire dispatch;
    // never find an owner by SQL text, which would conflate retries and identical queued statements.
    const pendingPortal = notice.where ? undefined : clientPendingPortalPlan.get(client);
    if (pendingPortal) clientPendingPortalPlan.delete(client);
    const wireStatement = pendingPortal ?? clientExecutingStatement.get(client);
    const attribution = wireStatement?.attribution;
    if (!attribution) return;
    if (attribution.capture.error) {
      attribution.capture.omittedPlans++;
      return;
    }
    // PostgreSQL supplies an error context for nested SPI/trigger plans. Data-modifying SELECT CTEs finish
    // their top-level executor before CommandComplete, so they must not leave a pending cleanup owner.
    if (!notice.where && wireStatement) wireStatement.topLevelPlanSeen = true;

    const capture = attribution.capture;
    const side = attribution.background ? 'background' : 'foreground';
    // Unmeasured warmup/prepare only needs top-level ModifyTable identities for settle.
    if (capture.mode === 'warmup' && notice.where) return;
    const noticeBytes = Buffer.byteLength(message, 'utf8');
    const owner = wireStatement?.record?.index;
    let plan: unknown;
    let reservation: GrowthNativeNoticeReservation | undefined;
    try {
      if (capture.costFolder) {
        // Folded captures keep cost summaries; per-node entries are raw-plan retention.
        reservation = capture.budget.retainNativeNotice(noticeBytes, side);
        plan = JSON.parse(message.slice(message.indexOf(marker) + marker.length));
      } else {
        plan = parseNativePlanNotice(capture.budget, message, side, () =>
          JSON.parse(message.slice(message.indexOf(marker) + marker.length)),
        );
        retainNativePlanNodes(plan, capture, side);
      }
      if (capture.costFolder) {
        const database = connectedDatabase(client) ?? '';
        const planIndex = capture.costFolder.addNotice(plan, {
          side,
          owner,
          backend: backendPid(client),
          database,
        });
        retainCapturePlanWrites(
          capture,
          plan,
          database,
          `${side === 'background' ? 'backgroundPlans' : 'plans'}[${planIndex}]`,
          side,
        );
      } else {
        (attribution.background ? capture.backgroundPlans : capture.plans).push(plan);
        (attribution.background ? capture.backgroundPlanDatabases : capture.planDatabases).push(
          connectedDatabase(client) ?? '',
        );
        (attribution.background ? capture.backgroundPlanStatements : capture.planStatements).push(owner);
        (attribution.background ? capture.backgroundPlanBackends : capture.planBackends).push(backendPid(client));
        retainCapturePlanWrites(
          capture,
          plan,
          connectedDatabase(client) ?? '',
          `${side === 'background' ? 'backgroundPlans' : 'plans'}[${(attribution.background ? capture.backgroundPlans : capture.plans).length - 1}]`,
          side,
        );
      }
    } catch (error) {
      capture.omittedPlans++;
      capture.error ??= captureFailureContext(
        error,
        occurrenceFailureContext(side, owner, wireStatement?.record?.text, noticeBytes),
      );
    } finally {
      if (capture.costFolder) {
        plan = undefined;
        reservation?.release();
      }
    }
  });

  const queryWithoutAttribution = intercept(client, state, true);
  const setupQueries = setupStatements.map((statement) => queryWithoutAttribution(statement));
  const setupTask = Promise.allSettled(setupQueries).then((results) => {
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') recordSetupFailure(state, failed.reason);
  });
  state.setupTasks.add(setupTask);
  const removeSetupTask = () => {
    state.setupTasks.delete(setupTask);
  };
  void setupTask.then(removeSetupTask, (error: unknown) => {
    recordSetupFailure(state, error);
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
    configureTestReceiptKeys(pool);
    const admin = lifecycle.acquire('admin pool', () => new pg.Pool({ connectionString: url, max: 2 }));
    const state: CaptureState = {
      lifecycle,
      active: undefined,
      growthCheckActive: false,
      seeding: undefined,
      seedingPending: new Set(),
      setupError: undefined,
      setupFailed: false,
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
        configureTestReceiptKeys(libraryPool);
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
  return trackCaptureTask(captureInternal(database, operation, options, false, 'raw'));
}

export type GrowthCaptureOptions = {
  readonly includeBackends?: boolean;
  /** A capture may use tighter telemetry limits for a focused check, but cannot raise the documented hard caps. */
  readonly telemetryLimits?: Partial<GrowthCaptureBudgetLimits>;
};

/** Internal entry point used by the public cost-folded capture facade. */
export function captureCostFoldedInternal<T>(
  database: GrowthDatabase,
  operation: () => Promise<T>,
  options: GrowthCaptureOptions = {},
  explicitWarmup = false,
): Promise<{ value: T; capture: CostFoldedCapture }> {
  return trackCaptureTask(captureInternal(database, operation, options, explicitWarmup, 'cost-folded'));
}

function foldedInputFor(active: ActiveCapture, elapsedMs: number) {
  return {
    elapsedMs,
    statements: active.statementRecords.filter(({ background }) => !background) as FoldedStatementInput[],
    backgroundStatements: active.statementRecords.filter(({ background }) => background) as FoldedStatementInput[],
    includeBackends: active.includeBackends,
  };
}

function captureRunSummary(run: RunCapture | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!run) return undefined;
  const writes: RelationIdentity[] = [];
  let omittedWrites = false;
  for (const relations of run.values()) {
    for (const identity of relations.values()) {
      if (writes.length === 128) {
        omittedWrites = true;
        break;
      }
      writes.push(identity);
    }
    if (omittedWrites) break;
  }
  const transactions: Array<Readonly<{ database: string; backend: number; token: number }>> = [];
  let omittedTransactions = false;
  for (const [database, backends] of run.backends.transactions) {
    for (const [backend, token] of backends) {
      if (transactions.length === 128) {
        omittedTransactions = true;
        break;
      }
      transactions.push({ database: databaseName(database), backend, token });
    }
    if (omittedTransactions) break;
  }
  const backends: number[] = [];
  for (const backend of run.backends) {
    if (backends.length === 128) break;
    backends.push(backend);
  }
  return {
    nativeCaptures: run.nativeCaptures.slice(),
    writes,
    transactions,
    backends,
    omissions: {
      writes: omittedWrites ? 'additional run writes omitted after 128' : 0,
      transactions: omittedTransactions ? 'additional open transactions omitted after 128' : 0,
      nativeCaptures: run.omittedNativeCaptures,
      ...(run.backends.size <= backends.length ? {} : { backends: 'additional run backends omitted after 128' }),
    },
  };
}

function accountRunFailureContext(run: RunCapture): void {
  if (run.failureContextAccounted) return;
  run.nativeCaptureEntries += RUN_FAILURE_CONTEXT_ENTRIES;
  run.nativeCaptureBytes += RUN_FAILURE_CONTEXT_BYTES;
  run.failureContextAccounted = true;
}

function captureBudgetLimits(
  options: GrowthCaptureOptions,
  run: RunCapture | undefined,
): Partial<GrowthCaptureBudgetLimits> {
  if (!run) return options.telemetryLimits ?? {};
  const requested = options.telemetryLimits ?? {};
  if (
    (requested.entries !== undefined &&
      (!Number.isSafeInteger(requested.entries) ||
        requested.entries < 0 ||
        requested.entries > MAX_GROWTH_CAPTURE_ENTRIES)) ||
    (requested.bytes !== undefined &&
      (!Number.isSafeInteger(requested.bytes) || requested.bytes < 0 || requested.bytes > MAX_GROWTH_CAPTURE_BYTES)) ||
    (requested.nativeNoticeBytes !== undefined &&
      (!Number.isSafeInteger(requested.nativeNoticeBytes) ||
        requested.nativeNoticeBytes < 0 ||
        requested.nativeNoticeBytes > MAX_GROWTH_NATIVE_NOTICE_BYTES))
  )
    return requested;
  const entries = Math.max(
    0,
    MAX_GROWTH_CAPTURE_ENTRIES -
      MAX_GROWTH_RUN_NATIVE_CAPTURES -
      RUN_FAILURE_CONTEXT_ENTRIES -
      run.nativeCaptureEntries,
  );
  const bytes = Math.max(
    0,
    MAX_GROWTH_CAPTURE_BYTES -
      MAX_GROWTH_RUN_NATIVE_CAPTURES * RUN_NATIVE_CAPTURE_DESCRIPTOR_BYTES -
      RUN_FAILURE_CONTEXT_BYTES -
      run.nativeCaptureBytes,
  );
  return {
    entries: Math.min(requested.entries ?? MAX_GROWTH_CAPTURE_ENTRIES, entries),
    bytes: Math.min(requested.bytes ?? MAX_GROWTH_CAPTURE_BYTES, bytes),
    nativeNoticeBytes: requested.nativeNoticeBytes ?? MAX_GROWTH_NATIVE_NOTICE_BYTES,
  };
}

function collectMissingPlans(active: ActiveCapture): number {
  if (active.missingPlanCount !== undefined) return active.missingPlanCount;
  const missing: Array<Readonly<{ side: GrowthCaptureEvidenceSide; index: number; text: string }>> = [];
  let count = 0;
  let omittedDetails = 0;
  for (const record of active.statementRecords) {
    if (!record.requiresNativePlan || record.errorCode !== null) continue;
    const side = record.background ? 'background' : 'foreground';
    const hasPlan = active.costFolder
      ? active.costFolder.hasNativePlan(side, record.index)
      : (record.background ? active.backgroundPlanStatements : active.planStatements).includes(record.index);
    if (hasPlan) continue;
    count++;
    if (missing.length >= 32) {
      omittedDetails++;
      continue;
    }
    const text = record.text.slice(0, 180);
    try {
      active.budget.retainFoldedSummary(side, 'missing native plan detail', 0, Buffer.byteLength(text, 'utf8') + 32);
      missing.push({ side, index: record.index, text });
    } catch {
      omittedDetails++;
    }
  }
  active.missingPlanCount = count;
  active.missingPlanOccurrences = missing;
  active.omittedMissingPlanDetails = omittedDetails;
  return count;
}

function makeCaptureFailureDiagnostic(
  active: ActiveCapture,
  elapsedMs: number,
  primary: unknown,
  secondary: readonly Readonly<{ phase: string; value: unknown }>[],
  omittedDrainErrors: number,
): Readonly<{ native: unknown; omissions: Readonly<Record<string, number | string>> }> {
  collectMissingPlans(active);
  let foldedCapture: CostFoldedCapture | undefined;
  let foldedCostOmission: string | undefined;
  if (active.costFolder) {
    try {
      foldedCapture = active.costFolder.finish(foldedInputFor(active, elapsedMs));
    } catch (error) {
      foldedCostOmission =
        describeGrowthFailure(error, 'folded-cost').message.slice(0, 512) ||
        'folded cost result exceeded capture capacity';
    }
  }
  const transactions: Array<Readonly<{ database: string; backend: number; token: number }>> = [];
  let omittedTransactions = active.omittedTransactions;
  for (const [database, entries] of active.transactions) {
    for (const [backend, token] of entries) {
      if (transactions.length >= 128) {
        omittedTransactions++;
        continue;
      }
      transactions.push({ database: databaseName(database), backend, token });
    }
  }
  const omissions = {
    statements: active.omittedStatements,
    statementErrors: active.omittedStatementErrors,
    plans: active.omittedPlans,
    writeTargets: active.omittedWriteTargets,
    transactions: omittedTransactions,
    missingPlans: active.missingPlanCount ?? 0,
    missingPlanDetails: active.missingPlanOccurrences?.length ?? 0,
    missingPlanDetailsOmitted: active.omittedMissingPlanDetails,
    pendingCauses: omittedDrainErrors,
    ...(foldedCostOmission === undefined ? {} : { foldedCost: foldedCostOmission }),
  };
  const causes = [primary, ...secondary.map(({ value }) => value)];
  const runEvidence = captureRunSummary(active.run);
  const contextBytes =
    768 +
    (runEvidence === undefined
      ? 0
      : 512 +
        active.run!.nativeCaptures.length * 8 +
        (runEvidence.writes as readonly unknown[]).length * 24 +
        (runEvidence.transactions as readonly unknown[]).length * 32 +
        (runEvidence.backends as readonly unknown[]).length * 8) +
    causes.reduce<number>((total, cause) => {
      const text = describeGrowthFailure(cause, 'capture-context').message;
      return total + growthFailureContextBytes(text.slice(0, 1_024));
    }, 0);
  try {
    active.budget.retainFailureContext(contextBytes);
  } catch {
    Object.assign(omissions, { failureContext: 'capture capacity had no diagnostic context space' });
  }
  const native = {
    mode: active.costFolder ? 'cost-folded' : 'raw',
    statements: active.statementRecords,
    foregroundPlans: active.plans,
    foregroundPlanStatements: active.planStatements,
    foregroundPlanBackends: active.planBackends,
    foregroundPlanDatabases: active.planDatabases,
    backgroundPlans: active.backgroundPlans,
    backgroundPlanStatements: active.backgroundPlanStatements,
    backgroundPlanBackends: active.backgroundPlanBackends,
    backgroundPlanDatabases: active.backgroundPlanDatabases,
    writes: [...active.writeTargets.values()],
    transactions,
    transactionStates: active.transactionHistory,
    ...(active.missingPlanOccurrences === undefined ? {} : { missingPlanOccurrences: active.missingPlanOccurrences }),
    ...(foldedCapture === undefined ? {} : { foldedCapture }),
    ...(runEvidence === undefined ? {} : { run: runEvidence }),
    ...(active.costFolder === undefined
      ? { costAvailability: 'native plan documents retained' }
      : { costAvailability: foldedCapture ? 'partial folded costs available' : 'folded cost output omitted' }),
  };
  return { native, omissions };
}

/** Retains a bounded view of every completed capture for failures raised after capture returns. */
function retainRunNativeCapture(active: ActiveCapture, capture: Capture | CostFoldedCapture): void {
  const run = active.run;
  if (!run) return;
  const entryCost = Math.max(1, active.budget.entriesUsed);
  const byteCost = Math.max(256, active.budget.chargedBytes);
  const withinRunBudget =
    run.nativeCaptures.length < MAX_GROWTH_RUN_NATIVE_CAPTURES &&
    run.nativeCaptureEntries + entryCost + 1 <=
      MAX_GROWTH_CAPTURE_ENTRIES - MAX_GROWTH_RUN_NATIVE_CAPTURES - RUN_FAILURE_CONTEXT_ENTRIES &&
    run.nativeCaptureBytes + byteCost + RUN_NATIVE_CAPTURE_DESCRIPTOR_BYTES <=
      MAX_GROWTH_CAPTURE_BYTES -
        MAX_GROWTH_RUN_NATIVE_CAPTURES * RUN_NATIVE_CAPTURE_DESCRIPTOR_BYTES -
        RUN_FAILURE_CONTEXT_BYTES;
  if (withinRunBudget) {
    try {
      // Account the run envelope from headroom reserved by the same per-capture budget.
      active.budget.retainFailureContext(RUN_NATIVE_CAPTURE_DESCRIPTOR_BYTES);
      run.nativeCaptures.push({
        status: 'complete',
        mode: active.costFolder ? 'cost-folded' : 'raw',
        database: databaseName(active.database),
        statements: active.statementRecords,
        foregroundPlans: active.plans,
        foregroundPlanStatements: active.planStatements,
        foregroundPlanBackends: active.planBackends,
        foregroundPlanDatabases: active.planDatabases,
        backgroundPlans: active.backgroundPlans,
        backgroundPlanStatements: active.backgroundPlanStatements,
        backgroundPlanBackends: active.backgroundPlanBackends,
        backgroundPlanDatabases: active.backgroundPlanDatabases,
        writes: [...active.writeTargets.values()],
        transactionStates: active.transactionHistory,
        capture,
        omissions: {
          statements: active.omittedStatements,
          statementErrors: active.omittedStatementErrors,
          plans: active.omittedPlans,
          writeTargets: active.omittedWriteTargets,
          transactions: active.omittedTransactions,
        },
      });
      run.nativeCaptureEntries += entryCost + 1;
      run.nativeCaptureBytes += byteCost + RUN_NATIVE_CAPTURE_DESCRIPTOR_BYTES;
      return;
    } catch {
      // A capture that consumed all available failure headroom still returns successfully; the run records why
      // the later-stage diagnostic cannot include its full native evidence.
    }
  }
  run.omittedNativeCaptures++;
  if (run.nativeCaptures.length < MAX_GROWTH_RUN_NATIVE_CAPTURES)
    run.nativeCaptures.push({
      status: 'omitted',
      mode: active.costFolder ? 'cost-folded' : 'raw',
      database: databaseName(active.database),
      statementCount: active.statementRecords.length,
      planCount: active.plans.length + active.backgroundPlans.length,
      reason: 'shared run capture evidence capacity was exhausted',
    });
}

function captureInternal<T>(
  database: GrowthDatabase,
  operation: () => Promise<T>,
  options: GrowthCaptureOptions,
  explicitWarmup: boolean,
  retentionMode: 'raw',
): Promise<{ value: T; capture: Capture }>;
function captureInternal<T>(
  database: GrowthDatabase,
  operation: () => Promise<T>,
  options: GrowthCaptureOptions,
  explicitWarmup: boolean,
  retentionMode: 'cost-folded',
): Promise<{ value: T; capture: CostFoldedCapture }>;

async function captureInternal<T>(
  database: GrowthDatabase,
  operation: () => Promise<T>,
  options: GrowthCaptureOptions,
  explicitWarmup: boolean,
  retentionMode: 'raw' | 'cost-folded',
): Promise<{ value: T; capture: Capture | CostFoldedCapture }> {
  const state = states.get(database);
  if (!state) throw new Error('Growth database was not opened by openGrowthDatabase');
  state.lifecycle.assertOpen();
  const parentActive = state.active;
  const ownsParent = parentActive !== undefined && currentAttribution(state)?.capture === parentActive;
  if (parentActive && !(parentActive.mode === 'warmup' && ownsParent))
    throw new Error('A growth capture is already active for this database');
  const mode = explicitWarmup || (parentActive?.mode === 'warmup' && ownsParent) ? 'warmup' : 'measured';
  if (state.setupFailed) {
    recordGrowthFailureEvidence(state.setupError, {
      phase: 'capture-setup',
      native: { mode: retentionMode, database: databaseName(database), costAvailability: 'capture did not start' },
    });
    throw state.setupError;
  }
  const id = nextCaptureId++;
  const run = measuredRun.getStore();
  let budget: GrowthCaptureBudget;
  try {
    budget = new GrowthCaptureBudget(id, captureBudgetLimits(options, run));
  } catch (error) {
    recordGrowthFailureEvidence(error, {
      phase: 'capture-setup',
      native: {
        mode: retentionMode,
        database: databaseName(database),
        costAvailability: 'capture budget was not created',
      },
    });
    throw error;
  }
  let costFolder: GrowthCostFolder | undefined;
  if (retentionMode === 'cost-folded') {
    try {
      costFolder = new GrowthCostFolder(budget);
    } catch (error) {
      recordGrowthFailureEvidence(error, {
        phase: 'capture-setup',
        native: {
          mode: retentionMode,
          database: databaseName(database),
          costAvailability: 'folded capture setup failed',
        },
        omissions: { captureBudget: 1 },
      });
      throw error;
    }
  }
  const active: ActiveCapture = {
    id,
    budget,
    costFolder,
    mode,
    database,
    run,
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
    transactionHistory: [],
    pending: new Set(),
    writeTargets: new Map(),
    omittedStatements: 0,
    omittedStatementErrors: 0,
    omittedPlans: 0,
    omittedWriteTargets: 0,
    omittedTransactions: 0,
    omittedMissingPlanDetails: 0,
    nestedCaptureWork: captureTaskTracker(),
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
    let drained = { errors: [] as readonly unknown[], omittedErrors: 0 };
    let drainFailure: unknown;
    try {
      drained = await drainCaptureWork(active.pending, state.setupTasks);
    } catch (error) {
      drainFailure = error;
    }
    let nestedDrained = { errors: [] as readonly unknown[], omittedErrors: 0 };
    let nestedDrainFailure: unknown;
    try {
      nestedDrained = await drainCaptureTasks(active.nestedCaptureWork);
    } catch (error) {
      nestedDrainFailure = error;
    }
    const elapsedMs = performance.now() - operationStartedAt;
    const failures: Readonly<{ phase: string; value: unknown }>[] = [];
    const addFailure = (phase: string, error: unknown): void => {
      if (!failures.some(({ value }) => Object.is(value, error))) failures.push({ phase, value: error });
    };
    if (operationFailed) addFailure('operation', operationError);
    if (state.setupFailed) addFailure('capture-setup', state.setupError);
    if (active.error) {
      const cause = (active.error as Error & { readonly cause?: unknown }).cause;
      if (cause === undefined) addFailure('capture-retention', active.error);
      else {
        addFailure('capture-retention', cause);
        addFailure('capture-context', active.error);
      }
    }
    for (const error of drained.errors) addFailure('pending-drain', error);
    if (drainFailure !== undefined) addFailure('pending-drain', drainFailure);
    for (const error of nestedDrained.errors) addFailure('nested-capture', error);
    if (nestedDrainFailure !== undefined) addFailure('nested-capture-drain', nestedDrainFailure);
    if (failures.length > 0) {
      const [first, ...allSecondary] = failures;
      const secondary = allSecondary.slice(0, GROWTH_FAILURE_CAUSE_LIMIT);
      const omittedCauses = Math.max(0, allSecondary.length - secondary.length);
      const { native, omissions } = makeCaptureFailureDiagnostic(
        active,
        elapsedMs,
        first!.value,
        secondary,
        drained.omittedErrors + nestedDrained.omittedErrors + omittedCauses,
      );
      recordGrowthFailureEvidence(first!.value, {
        phase: first!.phase,
        secondary,
        native,
        omissions,
      });
      throw first!.value;
    }
    if (collectMissingPlans(active) > 0) {
      const record = active.statementRecords.find(
        (statement) =>
          statement.requiresNativePlan &&
          statement.errorCode === null &&
          !(active.costFolder
            ? active.costFolder.hasNativePlan(statement.background ? 'background' : 'foreground', statement.index)
            : (statement.background ? active.backgroundPlanStatements : active.planStatements).includes(
                statement.index,
              )),
      )!;
      const error = new Error(
        `Successful ${record.background ? 'background ' : ''}${record.text.split(/\s+/, 1)[0]} occurrence ${record.index} has no native plan: ${record.text.slice(0, 600)}; preceding occurrences: ${JSON.stringify(
          active.statementRecords
            .filter((statement) => statement.background === record.background && statement.index <= record.index)
            .slice(-8)
            .map((statement) => ({ index: statement.index, text: statement.text.slice(0, 180) })),
        )}`,
      );
      const { native, omissions } = makeCaptureFailureDiagnostic(active, elapsedMs, error, [], 0);
      recordGrowthFailureEvidence(error, { phase: 'capture-validation', native, omissions });
      throw error;
    }
    const run = measuredRun.getStore();
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
    if (active.costFolder) {
      const capture = active.costFolder.finish(foldedInputFor(active, elapsedMs));
      retainRunNativeCapture(active, capture);
      active.budget.releaseFailureContextReserve();
      return { value, capture };
    }
    const capture: Capture = {
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
    };
    retainRunNativeCapture(active, capture);
    active.budget.releaseFailureContextReserve();
    return {
      value,
      capture,
    };
  } catch (error) {
    let diagnostic = growthFailureEvidence(error);
    if (!diagnostic) {
      const elapsedMs = 0;
      const { native, omissions } = makeCaptureFailureDiagnostic(active, elapsedMs, error, [], 0);
      diagnostic = recordGrowthFailureEvidence(error, { phase: 'capture-finalization', native, omissions });
    }
    retainRunFailedCapture(active, diagnostic.phase, diagnostic.native, diagnostic.omissions);
    throw error;
  } finally {
    state.active = parentActive;
    liveCaptures.delete(active);
    pruneWorkflowAttributions();
  }
}

/** Keeps failed nested capture evidence available to the enclosing operation under the run cap. */
function retainRunFailedCapture(
  active: ActiveCapture,
  phase: string,
  native: unknown,
  omissions: Readonly<Record<string, number | string>> | undefined,
): void {
  const run = active.run;
  if (!run) return;
  const entryCost = Math.max(1, active.budget.entriesUsed);
  const byteCost = Math.max(256, active.budget.chargedBytes);
  const withinRunBudget =
    run.nativeCaptures.length < MAX_GROWTH_RUN_NATIVE_CAPTURES &&
    run.nativeCaptureEntries + entryCost + 1 <=
      MAX_GROWTH_CAPTURE_ENTRIES - MAX_GROWTH_RUN_NATIVE_CAPTURES - RUN_FAILURE_CONTEXT_ENTRIES &&
    run.nativeCaptureBytes + byteCost + RUN_NATIVE_CAPTURE_DESCRIPTOR_BYTES <=
      MAX_GROWTH_CAPTURE_BYTES -
        MAX_GROWTH_RUN_NATIVE_CAPTURES * RUN_NATIVE_CAPTURE_DESCRIPTOR_BYTES -
        RUN_FAILURE_CONTEXT_BYTES;
  if (!withinRunBudget) {
    run.omittedNativeCaptures++;
    return;
  }
  try {
    active.budget.retainFailureContext(RUN_NATIVE_CAPTURE_DESCRIPTOR_BYTES);
    run.nativeCaptures.push({
      status: 'failed',
      phase,
      mode: active.costFolder ? 'cost-folded' : 'raw',
      database: databaseName(active.database),
      native,
      omissions: omissions ?? {},
    });
    run.nativeCaptureEntries += entryCost + 1;
    run.nativeCaptureBytes += byteCost + RUN_NATIVE_CAPTURE_DESCRIPTOR_BYTES;
  } catch {
    run.omittedNativeCaptures++;
  }
}

/** Runs an explicitly owned unmeasured capture; nested captures inherit that custody. Used for warm-up and prepare. */
export function captureWarmup<T>(database: GrowthDatabase, operation: () => Promise<T>) {
  return trackCaptureTask(captureInternal(database, operation, { includeBackends: true }, true, 'raw'));
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
  nativeCaptures: readonly RunNativeCapture[];
  omittedNativeCaptures: number;
}> {
  const writes = new Map() as RunCapture;
  Object.defineProperty(writes, 'databases', { value: new Set<GrowthDatabase>() });
  const backends = new Set<number>() as BackendSet;
  Object.defineProperty(backends, 'transactions', { value: new Map<GrowthDatabase, Map<number, number>>() });
  Object.defineProperty(writes, 'backends', { value: backends });
  Object.defineProperties(writes, {
    nativeCaptures: { value: [] as RunNativeCapture[] },
    nativeCaptureEntries: { value: 0, writable: true },
    nativeCaptureBytes: { value: 0, writable: true },
    omittedNativeCaptures: { value: 0, writable: true },
    failureContextAccounted: { value: false, writable: true },
    captureWork: { value: captureTaskTracker() },
  });
  return measuredRun.run(writes, async () => {
    let value!: T;
    let operationError: unknown;
    let operationFailed = false;
    try {
      value = await operation();
    } catch (error) {
      operationError = error;
      operationFailed = true;
    }
    let drained = { errors: [] as readonly unknown[], omittedErrors: 0 };
    let drainFailure: unknown;
    try {
      drained = await drainCaptureTasks(writes.captureWork);
    } catch (error) {
      drainFailure = error;
    }
    accountRunFailureContext(writes);
    const failures: Array<Readonly<{ phase: string; value: unknown }>> = [];
    const addFailure = (phase: string, error: unknown): void => {
      if (!failures.some(({ value }) => Object.is(value, error))) failures.push({ phase, value: error });
    };
    if (operationFailed) addFailure(growthFailureEvidence(operationError)?.phase ?? 'measured-run', operationError);
    for (const error of drained.errors) addFailure('pending-capture', error);
    if (drainFailure !== undefined) addFailure('pending-capture-drain', drainFailure);
    if (failures.length > 0) {
      const [first, ...allSecondary] = failures;
      const secondary = allSecondary.slice(0, GROWTH_FAILURE_CAUSE_LIMIT);
      const previous = growthFailureEvidence(first!.value);
      recordGrowthFailureEvidence(first!.value, {
        phase: first!.phase,
        secondary,
        native: {
          mode: 'measured-run',
          ...(previous?.native === undefined ? {} : { failedCapture: previous.native }),
          ...captureRunSummary(writes),
        },
        omissions: {
          pendingCaptures: drained.omittedErrors + Math.max(0, allSecondary.length - secondary.length),
          nativeCaptures: writes.omittedNativeCaptures,
        },
      });
      throw first!.value;
    }
    return {
      value,
      writes,
      databases: writes.databases,
      backends: writes.backends,
      transactions: writes.backends.transactions,
      nativeCaptures: writes.nativeCaptures,
      omittedNativeCaptures: writes.omittedNativeCaptures,
    };
  });
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

export type MaintenanceTarget = string | RelationIdentity;

function maintenanceIdentity(target: MaintenanceTarget): RelationIdentity {
  const identity = typeof target === 'string' ? relationIdentityFromQualifiedName(target) : target;
  if (identity.kind !== 'relation')
    throw new TypeError(`Expected a relation maintenance target: ${relationIdentityLabel(identity)}`);
  if (identity.schema === undefined) throw new TypeError(`Expected schema-qualified relation: ${identity.name}`);
  return identity;
}

function maintenanceIdentities(relations: readonly MaintenanceTarget[]): RelationIdentity[] {
  const unique = new Map<string, RelationIdentity>();
  for (const target of relations) addRelationIdentity(unique, maintenanceIdentity(target));
  return [...unique.values()];
}

type RelationMaintenance = {
  schema: string;
  name: string;
  kind: string;
  options: string[] | null;
  toast_disabled: boolean;
};

async function relationMaintenance(
  relations: readonly RelationIdentity[] | undefined,
  lease: SettleClient,
  deadline: SettleDeadline,
): Promise<RelationMaintenance[]> {
  if (relations && relations.length === 0) return [];
  const wanted = relations?.map((identity) => {
    if (identity.schema === undefined) throw new TypeError(`Expected schema-qualified relation: ${identity.name}`);
    return { schema: identity.schema, name: identity.name };
  });
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

async function disableAutovacuum(database: GrowthDatabase, relations?: readonly RelationIdentity[]): Promise<void> {
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
      `ALTER TABLE ${quotedRelationIdentity({ kind: 'relation', schema, name })} SET (autovacuum_enabled = false, toast.autovacuum_enabled = false)`,
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
    readonly relations?: readonly MaintenanceTarget[];
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
    for (const relation of options.relations) maintenanceIdentity(relation);
  }
  if (
    options.operationBackends !== undefined &&
    (typeof options.operationBackends.has !== 'function' ||
      typeof options.operationBackends[Symbol.iterator] !== 'function')
  )
    throw new TypeError('Settle operationBackends must be a set');

  const started = performance.now();
  const deadline = makeSettleDeadline(timeoutMs);
  const backend = measuredTransactionBackend(database, options.operationBackends);
  const requested = options.relations === undefined ? undefined : maintenanceIdentities(options.relations);
  const needsMaintenance = requested === undefined || requested.length > 0;
  if (!needsMaintenance && backend === undefined) return performance.now() - started;

  const lease = await checkoutSettleClient(database, deadline);
  const physicalName = connectedDatabase(lease.client) ?? poolDatabaseName(database.admin) ?? databaseName(database);
  let primary: unknown;
  try {
    if (backend !== undefined) await assertMeasuredTransactionOnClient(backend, lease, deadline);
    const metadata = needsMaintenance ? await relationMaintenance(requested, lease, deadline) : [];
    await disableAutovacuumOn(metadata, lease, deadline);
    const targets = requested ?? metadata.map(({ schema, name }) => ({ kind: 'relation' as const, schema, name }));
    for (const relation of targets) {
      const sql = [
        'VACUUM (INDEX_CLEANUP ON',
        options.analyze ? ', ANALYZE' : '',
        ') ',
        quotedRelationIdentity(relation),
      ].join('');
      try {
        await querySettleClient(lease, deadline, sql, undefined, `VACUUM relation ${quotedRelationIdentity(relation)}`);
      } catch (error) {
        throw new GrowthSettleInfrastructureError(
          `Could not settle database ${physicalName} relation ${relation.schema}.${relation.name}: ${error instanceof Error ? error.message : String(error)}`,
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
    let drained = { errors: [] as readonly unknown[], omittedErrors: 0 };
    let drainFailure: unknown;
    try {
      drained = await drainCaptureWork(state.seedingPending, state.setupTasks);
    } catch (error) {
      drainFailure = error;
    }
    const failures: Array<Readonly<{ phase: string; value: unknown }>> = [];
    const addFailure = (phase: string, error: unknown): void => {
      if (!failures.some(({ value }) => Object.is(value, error))) failures.push({ phase, value: error });
    };
    if (growFailed) addFailure('grow', growError);
    if (state.setupFailed) addFailure('growth-setup', state.setupError);
    for (const error of drained.errors) addFailure('pending-drain', error);
    if (drainFailure !== undefined) addFailure('pending-drain', drainFailure);
    const counted = { statements: seeding.statements, rowsWritten: seeding.rowsWritten };
    if (failures.length > 0) {
      const [first, ...secondary] = failures;
      recordGrowthFailureEvidence(first!.value, {
        phase: first!.phase,
        secondary: secondary.slice(0, GROWTH_FAILURE_CAUSE_LIMIT),
        native: {
          mode: 'growth-seeding',
          database: databaseName(database),
          observed: counted,
          costAvailability: 'grow-phase accounting retains statement and written-row counts without native plans',
        },
        omissions: {
          pendingCauses: drained.omittedErrors + Math.max(0, secondary.length - GROWTH_FAILURE_CAUSE_LIMIT),
          seedingStatements: seeding.statements,
          rowsWritten: seeding.rowsWritten,
        },
      });
      throw first!.value;
    }
    return { value, seeding: counted };
  } finally {
    state.seeding = undefined;
  }
}

/** Whether `admin` belongs to a database whose checkGrowth is inside `grow`, and settles when `grow` returns. */
export function vacuumFollows(admin: pg.Pool): boolean {
  return growing.getStore() === admin;
}
