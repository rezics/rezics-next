import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { fencedGraphQuery, noteGraphReadVersion } from './graph-read-fence.ts';

export type FusekiReadCallFamily = 'health' | 'delta-proof' | 'query' | 'template-query';
export type FusekiReadPhase = 'read' | 'writer-wait';
export type FusekiReadCallStatus = 'complete' | 'failed' | 'aborted' | 'active';

export interface FusekiReadCallDiagnostic {
  family: FusekiReadCallFamily;
  /** Native directory entries visited, including rejected entries; never an estimated population. */
  examined?: number;
  durationMs: number;
  attempt: number;
  phase: FusekiReadPhase;
  status: FusekiReadCallStatus;
}

interface ActiveFusekiReadCall extends Omit<FusekiReadCallDiagnostic, 'durationMs' | 'status'> {
  startedAt: number;
}

export interface FusekiReadDiagnosticSnapshot {
  history: FusekiReadCallDiagnostic[];
  active: FusekiReadCallDiagnostic[];
  omitted: number;
}

export interface FusekiReadDiagnostics {
  history: FusekiReadCallDiagnostic[];
  active: Map<number, ActiveFusekiReadCall>;
  omitted: number;
  nextId: number;
  closed: boolean;
}

type NativeReadMethod = 'query' | 'templateQuery' | 'commandHealth' | 'searchDeltaSince'
  | 'alsoEnjoyedCandidates' | 'prefixWalk' | 'templateIndex' | 'membershipPreparationStatus'
  | 'membershipPrepare' | 'prepareWorkScopeDirectory' | 'command';

export interface FusekiReadAllocationObservation {
  readonly owner: number;
  readonly caller: string;
  readonly callsLeft: number;
  readonly bytesLeft: number;
  readonly deadline: number | null;
  readonly aborted: boolean;
  readonly attempt: number;
  readonly phase: FusekiReadPhase;
  readonly readPhase: string | null;
}

/** Private, detached values only: no Request, signal, budget, body or query text. */
export interface FusekiReadObservation {
  readonly call: number;
  readonly stage: 'before-debit' | 'after-debit' | 'refused-debit' | 'complete';
  readonly debit: Readonly<{ counter: 'callsLeft' | 'bytesLeft'; amount: number }> | null;
  readonly nativeMethod: NativeReadMethod;
  readonly httpMethod: 'GET' | 'POST';
  readonly endpoint: 'query' | 'command';
  readonly queryHash: string | null;
  readonly caller: string;
  readonly status: 'active' | 'complete' | 'failed' | 'aborted' | 'refused';
  readonly httpStatus: number | null;
  /** Delivered body bytes, including a chunk whose debit was refused. */
  readonly actualBytes: number;
  readonly aborted: boolean;
  readonly cause: 'deadline' | 'cancelled' | 'call-budget' | 'byte-budget' | 'response-limit' | 'failure' | null;
  /** Innermost first; counters use the same effective allowance as the debit. */
  readonly allocations: readonly FusekiReadAllocationObservation[];
}
export type FusekiReadObserver = (event: FusekiReadObservation) => void | Promise<void>;

interface ReadObservationState {
  observer?: FusekiReadObserver;
  nextCall: number;
  nextOwner: number;
  owners: WeakMap<FusekiReadBudget, number>;
}
interface ObservedReadCall {
  state: ReadObservationState;
  call: number;
  nativeMethod: NativeReadMethod;
  caller: string;
  queryHash: string | null;
  signal?: AbortSignal;
  httpStatus: number | null;
  actualBytes: number;
  cause: FusekiReadObservation['cause'];
}

/** One operation shares a wall deadline and Fuseki call/response budget. */
export interface FusekiReadBudget {
  signal: AbortSignal;
  callsLeft: number;
  bytesLeft: number;
  /** Monotonic absolute deadline shared by all calls in the request. */
  deadline?: number;
  attempt?: number;
  phase?: FusekiReadPhase;
  diagnostics?: FusekiReadDiagnostics;
  readPhase?: string;
}

interface ReadScope {
  parent?: FusekiReadBudget;
  controller: AbortController;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  request?: { root: FusekiReadBudget; limits: ReadLimits; claimed: boolean };
  observation?: ReadObservationState;
  caller?: string;
}
interface ReadLimits { calls: number; bytes: number; deadlineMs: number }
const readScopes = new WeakMap<FusekiReadBudget, ReadScope>();

/** Existing owners may supply plain counters or setters which already debit
 * their parent. Preserve both APIs, including their mutable diagnostics. */
class FusekiReadBudgets extends AsyncLocalStorage<FusekiReadBudget | undefined> {
  override run<R, Args extends unknown[]>(store: FusekiReadBudget | undefined, callback: (...args: Args) => R, ...args: Args): R {
    // exit() delegates to run(undefined); detached work must not claim or join
    // the caller's allocation, even when it inherited an active request.
    if (store === undefined) return super.run(store, callback, ...args);
    const parent = this.getStore();
    if (parent === store) return super.run(store, callback, ...args);
    const request = readScopes.get(parent!)?.request ?? readScopes.get(store)?.request;
    if (parent && request && !request.claimed) {
      // The first declared owner selects the allocation once. Preflight has
      // already spent from it; sibling owners and retries cannot replenish it.
      const calls = store.callsLeft, bytes = store.bytesLeft;
      request.root.callsLeft = calls - (Number.MAX_SAFE_INTEGER - request.root.callsLeft);
      request.root.bytesLeft = bytes - (Number.MAX_SAFE_INTEGER - request.root.bytesLeft);
      request.claimed = true;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([store.signal, controller.signal, ...(parent ? [parent.signal] : [])]);
    const scope = new Proxy(store, {
      get(target, key) {
        if (key === 'signal') return signal;
        if (key === 'deadline') return target.deadline === undefined && parent?.deadline === undefined ? undefined
          : Math.min(target.deadline ?? Infinity, parent?.deadline ?? Infinity);
        if (key === 'diagnostics') return target.diagnostics ?? parent?.diagnostics;
        if (key === 'readPhase') return target.readPhase ?? parent?.readPhase;
        return Reflect.get(target, key, target) as unknown;
      },
      set: (target, key, value) => Reflect.set(target, key, value, target),
    });
    const observation = readScopes.get(store)?.observation;
    readScopes.set(scope, { parent, controller, request, observation,
      caller: observation?.observer || currentReadObservation()?.observer ? readCaller() : undefined });
    return super.run(scope, callback, ...args);
  }
}
export const fusekiReadBudget = new FusekiReadBudgets();

function shortenReadDeadline(budget: FusekiReadBudget, deadline: number): void {
  budget.deadline = Math.min(budget.deadline ?? Infinity, deadline);
  const scope = readScopes.get(budget)!;
  clearTimeout(scope.deadlineTimer);
  scope.deadlineTimer = setTimeout(
    () => scope.controller.abort(new FusekiReadDeadlineExceeded('Fuseki request deadline exceeded')),
    Math.max(0, budget.deadline - performance.now()));
}

/** Enter before admission/readiness. Owners keep their published allocations;
 * an operation without an explicit owner uses the bounded fallback. The optional
 * private sink observes this request until exit and is never awaited. */
export async function withFusekiReadRequest<T>(request: Request, limits: ReadLimits,
  read: () => T | Promise<T>, observer?: FusekiReadObserver): Promise<T> {
  // Web forwards a positive safe-integer Unix timestamp. Convert its remaining
  // duration once; later reads and retries stay on the monotonic clock.
  const forwarded = Number(request.headers.get('x-rezics-server-deadline'));
  const validDeadline = Number.isSafeInteger(forwarded) && forwarded > 0;
  const deadline = performance.now() + Math.min(limits.deadlineMs,
    validDeadline ? forwarded - Date.now() : Infinity);
  const parent = fusekiReadBudget.getStore();
  if (parent) {
    assertFusekiReadActive();
    if (validDeadline) {
      // Shorten the existing operation, including already running transports;
      // a nested owner cannot restart the duration or allocation.
      shortenReadDeadline(readScopes.get(parent)?.request?.root ?? parent,
        Math.min(deadline, parent.deadline ?? Infinity));
      assertFusekiReadActive();
    }
    if (!observer) return read();
    // Attach to the existing owner, including when an outer owner selected its
    // allocation already. This is observation, not a new budget or transport.
    const scope = readScopes.get(parent)!;
    const previous = scope.observation;
    const previousCaller = scope.caller;
    const observation: ReadObservationState = { observer, nextCall: 0, nextOwner: 0, owners: new WeakMap() };
    scope.observation = observation;
    scope.caller ??= readCaller();
    try { return await read(); }
    finally { observation.observer = undefined; scope.observation = previous; scope.caller = previousCaller; }
  }
  const controller = new AbortController();
  const budget: FusekiReadBudget = {
    signal: AbortSignal.any([request.signal, controller.signal]),
    deadline,
    callsLeft: Number.MAX_SAFE_INTEGER, bytesLeft: Number.MAX_SAFE_INTEGER,
    diagnostics: createFusekiReadDiagnostics(), readPhase: 'preflight',
  };
  const observation: ReadObservationState | undefined = observer
    ? { observer, nextCall: 0, nextOwner: 0, owners: new WeakMap() } : undefined;
  readScopes.set(budget, { controller, request: { root: budget, limits, claimed: false }, observation });
  shortenReadDeadline(budget, deadline);
  try {
    return await fusekiReadBudget.run(budget, async () => {
      assertFusekiReadActive();
      const result = await read();
      assertFusekiReadActive();
      return result;
    });
  } finally {
    if (observation) observation.observer = undefined;
    clearTimeout(readScopes.get(budget)!.deadlineTimer);
    // Close escaped async continuations too; returning HTTP must not give them
    // a fresh allocation or leave a transport running under an idle request.
    controller.abort();
  }
}

/** Join external work with the existing operation boundary. Shared work may
 * retain its own lifetime; this waiter and any caller-owned transport cannot. */
export async function withFusekiReadWait<T>(caller: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  assertFusekiReadActive();
  const budget = fusekiReadBudget.getStore();
  if (budget?.deadline !== undefined && Number.isFinite(budget.deadline)) {
    // Plain/nested owners also publish monotonic deadlines. Arm the existing
    // operation controller, rather than allowing a remote default to renew it.
    shortenReadDeadline(readScopes.get(budget)?.request?.root ?? budget, budget.deadline);
  }
  const signal = budget ? AbortSignal.any([caller, budget.signal]) : caller;
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([stopped, Promise.resolve().then(() => {
      assertFusekiReadActive();
      signal.throwIfAborted();
      return read(signal);
    })]);
    assertFusekiReadActive();
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function budgetChain(): FusekiReadBudget[] {
  const chain: FusekiReadBudget[] = [];
  for (let budget = fusekiReadBudget.getStore(); budget; budget = readScopes.get(budget)?.parent) chain.push(budget);
  return chain;
}

function currentReadObservation(): ReadObservationState | undefined {
  for (const budget of budgetChain()) {
    const observation = readScopes.get(budget)?.observation;
    if (observation) return observation;
  }
  return undefined;
}

function readCaller(): string {
  return (new Error().stack ?? '').split('\n').slice(1)
    .filter(line => !line.includes('/infrastructure/fuseki.ts:')).slice(0, 8).join('\n');
}

function beginReadObservation(nativeMethod: NativeReadMethod, signal?: AbortSignal,
  query?: string): ObservedReadCall | undefined {
  const state = currentReadObservation();
  if (!state?.observer) return undefined;
  return { state, call: ++state.nextCall, nativeMethod, signal, caller: readCaller(),
    queryHash: query === undefined ? null : createHash('sha256').update(query).digest('hex'),
    httpStatus: null, actualBytes: 0, cause: null };
}

function readObservationCause(error: unknown, counter?: 'callsLeft' | 'bytesLeft',
  signal?: AbortSignal): FusekiReadObservation['cause'] {
  if (error instanceof FusekiReadDeadlineExceeded
    || error instanceof DOMException && error.name === 'TimeoutError') return 'deadline';
  if (error instanceof FusekiReadBudgetExceeded) return counter === 'bytesLeft' ? 'byte-budget' : 'call-budget';
  if (error instanceof FusekiQueryResponseTooLarge) return 'response-limit';
  return signal?.aborted || fusekiReadBudget.getStore()?.signal.aborted ? 'cancelled' : 'failure';
}

function emitReadObservation(call: ObservedReadCall | undefined, stage: FusekiReadObservation['stage'],
  status: FusekiReadObservation['status'], debit: FusekiReadObservation['debit'] = null): void {
  const observer = call?.state.observer;
  if (!call || !observer) return;
  const allocations = budgetChain().map(budget => {
    let owner = call.state.owners.get(budget);
    if (owner === undefined) { owner = ++call.state.nextOwner; call.state.owners.set(budget, owner); }
    return Object.freeze({ owner, caller: readScopes.get(budget)?.caller ?? '',
      callsLeft: readCostLeft(budget, 'callsLeft'), bytesLeft: readCostLeft(budget, 'bytesLeft'),
      deadline: budget.deadline ?? null, aborted: budget.signal.aborted,
      attempt: budget.attempt ?? 1, phase: budget.phase ?? 'read', readPhase: budget.readPhase ?? null });
  });
  const event: FusekiReadObservation = Object.freeze({ call: call.call, stage,
    debit: debit && Object.freeze({ ...debit }), nativeMethod: call.nativeMethod,
    httpMethod: call.nativeMethod === 'commandHealth' || call.nativeMethod === 'searchDeltaSince' ? 'GET' : 'POST',
    endpoint: call.nativeMethod === 'query' ? 'query' : 'command', queryHash: call.queryHash,
    caller: call.caller, status, httpStatus: stage === 'refused-debit' ? null : call.httpStatus, actualBytes: call.actualBytes,
    aborted: call.signal?.aborted ?? allocations.some(allocation => allocation.aborted),
    cause: call.cause, allocations: Object.freeze(allocations) });
  try {
    // Diagnostics cannot gain the allocation or retain its async context. A
    // broken sink, including an async rejection, must not affect the read.
    fusekiReadBudget.exit(() => {
      const result = observer(event);
      if (result) void Promise.resolve(result).catch(() => {});
    });
  } catch { /* The private diagnostic sink has no effect on request behavior. */ }
}

function withReadCall<T>(nativeMethod: NativeReadMethod, signal: AbortSignal,
  read: (call?: ObservedReadCall) => Promise<T>, query?: string): Promise<T> {
  const call = beginReadObservation(nativeMethod, signal, query);
  if (!call) { takeReadCall(); return read(); }
  return finishObservedRead(call, () => {
    takeReadCost('callsLeft', 1, call);
    return read(call);
  });
}

async function finishObservedRead<T>(call: ObservedReadCall, read: () => Promise<T>): Promise<T> {
  let status: FusekiReadObservation['status'] = 'failed';
  try {
    const result = await read();
    status = 'complete';
    return result;
  } catch (error) {
    call.cause ??= readObservationCause(error, undefined, call.signal);
    status = call.cause === 'call-budget' || call.cause === 'byte-budget' ? 'refused'
      : call.cause === 'deadline' || call.cause === 'cancelled' || call.signal?.aborted ? 'aborted' : 'failed';
    throw error;
  } finally { emitReadObservation(call, 'complete', status); }
}

function noteReadResponse(call: ObservedReadCall | undefined, response: Response): void {
  if (call) call.httpStatus = response.status;
}

export class FusekiReadDeadlineExceeded extends Error {}

export function assertFusekiReadActive(): void {
  const chain = budgetChain();
  for (const budget of chain) {
    budget.signal.throwIfAborted();
    if (budget.deadline !== undefined && performance.now() >= budget.deadline) {
      const error = new FusekiReadDeadlineExceeded('Fuseki request deadline exceeded');
      readScopes.get(budget)?.controller.abort(error);
      throw error;
    }
    if (budget.callsLeft < 0 || budget.bytesLeft < 0) {
      const error = new FusekiReadBudgetExceeded('Fuseki preflight exceeded the selected read allocation');
      for (const owner of chain) readScopes.get(owner)?.controller.abort(error);
      throw error;
    }
  }
}

const MAX_FUSEKI_DIAGNOSTIC_HISTORY = 8;
const MAX_FUSEKI_DIAGNOSTIC_ACTIVE = 8;

export function createFusekiReadDiagnostics(): FusekiReadDiagnostics {
  return { history: [], active: new Map(), omitted: 0, nextId: 0, closed: false };
}

export function snapshotFusekiReadDiagnostics(budget?: FusekiReadBudget): FusekiReadDiagnosticSnapshot | undefined {
  const diagnostics = budget?.diagnostics;
  if (!diagnostics) return undefined;
  const now = performance.now();
  return {
    history: diagnostics.history.map(item => ({ ...item })),
    active: [...diagnostics.active.values()].map(({ family, startedAt, attempt, phase }) => ({
      family, durationMs: Math.max(0, Math.round(now - startedAt)), attempt, phase, status: 'active',
    })),
    omitted: diagnostics.omitted,
  };
}

export function clearFusekiReadDiagnostics(budget: FusekiReadBudget): void {
  const diagnostics = budget.diagnostics;
  if (!diagnostics) return;
  diagnostics.closed = true;
  diagnostics.active.clear();
  diagnostics.history.length = 0;
}

function beginReadCall(family: FusekiReadCallFamily): number | undefined {
  const budget = fusekiReadBudget.getStore();
  const diagnostics = budget?.diagnostics;
  if (!budget || !diagnostics || diagnostics.closed) return undefined;
  const id = ++diagnostics.nextId;
  if (diagnostics.active.size >= MAX_FUSEKI_DIAGNOSTIC_ACTIVE) {
    const oldestId = diagnostics.active.keys().next().value;
    if (oldestId !== undefined) diagnostics.active.delete(oldestId);
    diagnostics.omitted++;
  }
  diagnostics.active.set(id, {
    family, startedAt: performance.now(), attempt: budget.attempt ?? 1, phase: budget.phase ?? 'read',
  });
  return id;
}

function finishReadCall(id: number | undefined, status: Exclude<FusekiReadCallStatus, 'active'>,
  examined?: number): void {
  if (id === undefined) return;
  const diagnostics = fusekiReadBudget.getStore()?.diagnostics;
  const active = diagnostics?.active.get(id);
  if (!diagnostics || !active || diagnostics.closed) return;
  diagnostics.active.delete(id);
  if (diagnostics.history.length >= MAX_FUSEKI_DIAGNOSTIC_HISTORY) {
    diagnostics.history.shift();
    diagnostics.omitted++;
  }
  diagnostics.history.push({
    family: active.family,
    durationMs: Math.max(0, Math.round(performance.now() - active.startedAt)),
    attempt: active.attempt,
    phase: active.phase,
    status,
    ...(examined === undefined ? {} : { examined }),
  });
}

function readBudgetHeaders(): Record<string, string> {
  assertFusekiReadActive();
  const budget = fusekiReadBudget.getStore();
  if (!budget) return {};
  const remainingMs = Math.min(10_000, Math.max(1, Math.ceil((budget.deadline ?? performance.now() + 10_000) - performance.now())));
  return { 'x-rezics-read-budget-ms': String(remainingMs),
    ...(budget.diagnostics && !budget.diagnostics.closed
      ? { 'x-rezics-search-budget-ms': String(Math.min(1_500, remainingMs)) } : {}) };
}

export class FusekiReadBudgetExceeded extends Error {}
export class FusekiPrefixWalkUnavailable extends Error {}
export class FusekiPrefixWalkRestart extends Error {}

function takeReadCall(): void {
  takeReadCost('callsLeft', 1);
}

function takeReadBytes(bytes: number, call?: ObservedReadCall): void {
  takeReadCost('bytesLeft', bytes, call);
}

function readCostLeft(budget: FusekiReadBudget, key: 'callsLeft' | 'bytesLeft'): number {
  const request = readScopes.get(budget)?.request;
  return request && !request.claimed
    ? (key === 'callsLeft' ? request.limits.calls : request.limits.bytes)
      - (Number.MAX_SAFE_INTEGER - request.root[key]) : budget[key];
}

function takeReadCost(key: 'callsLeft' | 'bytesLeft', amount: number, call?: ObservedReadCall): void {
  const debit = { counter: key, amount };
  emitReadObservation(call, 'before-debit', 'active', debit);
  try {
    assertFusekiReadActive();
    const chain = budgetChain();
    const before = chain.map(budget => budget[key]);
    for (const budget of chain) {
      const left = readCostLeft(budget, key);
      if (left < amount) {
        const error = new FusekiReadBudgetExceeded(`Fuseki read ${key === 'callsLeft' ? 'call' : 'byte'} budget exceeded`);
        for (const owner of chain) readScopes.get(owner)?.controller.abort(error);
        throw error;
      }
    }
    // An accessor owner may have debited its parent already. Fill only the
    // missing debit, so plain scopes cannot reset a budget and linked ones do
    // not pay twice. This is synchronous, including under parallel readers.
    chain.forEach((budget, index) => {
      const missing = amount - (before[index]! - budget[key]);
      if (missing > 0) budget[key] -= missing;
    });
  } catch (error) {
    if (call) call.cause = readObservationCause(error, key, call.signal);
    emitReadObservation(call, 'refused-debit', call?.cause === 'deadline' || call?.cause === 'cancelled'
      ? 'aborted' : 'refused', debit);
    throw error;
  }
  emitReadObservation(call, 'after-debit', 'active', debit);
}

function readSignal(preparationSignal?: AbortSignal): AbortSignal {
  assertFusekiReadActive();
  const request = fusekiReadBudget.getStore()?.signal;
  // Offline preparation shares one caller-owned finite deadline across all reads.
  // A configured client inside HTTP still obeys the tighter interactive budget.
  if (!request && preparationSignal) return preparationSignal;
  const upstream = AbortSignal.timeout(10_000);
  return AbortSignal.any([upstream, ...(request ? [request] : []),
    ...(preparationSignal ? [preparationSignal] : [])]);
}

export interface SparqlResult {
  boolean?: boolean;
  results?: { bindings: Record<string, { type: string; value: string;
    datatype?: string; 'xml:lang'?: string }>[] };
}

/** Input RDF terms retain their identity; no SPARQL literal escaping at callers. */
export type TemplateTerm = { type: 'uri'; value: string }
  | { type: 'literal'; value: string; datatype?: string; language?: string };
export interface TemplateQueryEnvelope {
  /** Only authored, reviewed template text; never a public request field. */
  query: string;
  bindings: Record<string, TemplateTerm>;
  /** Server-owned tuples replace matching empty VALUES blocks in the parsed query. */
  tables: { columns: string[]; rows: TemplateTerm[][] }[];
  /** Point qualifications bind candidate/head terms before native planning. */
  candidates?: Record<string,TemplateTerm>[];
  /** One page plus its lookahead row. Physical candidate work is qualified separately. */
  limit: number;
}

export interface CommandValidation {
  profile: string;
  sha256: string;
  shape: string;
  focus: string[];
  graphs: string[];
  binding?: Record<string, string>;
}

export interface CommandEnvelope {
  receipt: string;
  digest: string;
  update: string;
  validations: CommandValidation[];
  deadlineMs: number;
  titleAdmission?: { payload: string; signature: string };
  titleCandidate?: never;
}

/** Private retained title acceptance; it never dispatches the ordinary SPARQL command. */
export type TitleCandidateCommandEnvelope = Omit<CommandEnvelope,
  'update' | 'validations' | 'deadlineMs' | 'titleAdmission' | 'titleCandidate'> & {
  update: '';
  validations: [];
  deadlineMs: 10000;
  titleAdmission: { payload: string; signature: string };
  titleCandidate: { frame: string; custodySha256: string; mode: 'accept' | 'lookup' };
};
export type InternalCommandEnvelope = CommandEnvelope | TitleCandidateCommandEnvelope;
export type TitleCandidateResult =
  | { status: 'accepted' | 'historical'; receipt: string; digest: string; record: string }
  | { status: 'terminal'; receipt: string; digest: string; outcome: 'succeeded' | 'cancelled' }
  | { status: 'conflict'; reason?: string }
  | { status: 'deadline' };

export interface CommandPosition { datasetId: string; dataEpoch: string; sequence: string }
export interface TemplateIndexKey { graph: string; predicate: string; anchor: string; type: string }
/** Private fixed source-page continuation. Physical order is not delivery order. */
export interface StatementPublicationNativeCursor { storage: string; phase: 0 | 1 | 2; key: string; seal: string }
export interface LibraryCollectionNativeRequest {
  operation: 'library-export-page'; agent: string; phase: 4 | 5; after: string; limit: number;
}
export interface LibraryCollectionNativeResult {
  rows: Array<{ key: string; kind: 'skip' | 'shelf' | 'member'; collection?: string;
    name?: string; disclosure?: 'public' | 'private'; work?: string; placement?: string }>;
  examined: number; position: { dataEpoch: string; sequence: string };
}
export interface StatementPublicationNativeRequest {
  operation: 'statement-publication-page'; dataEpoch: string; routingEpoch: string;
  subject: string; membershipHead: string | null;
  after: 'basis' | StatementPublicationNativeCursor | null;
}
export interface StatementPublicationNativeResult {
  basis: { dataEpoch: string; routingEpoch: string; subject: string; membershipHead: string | null; storage: string };
  after: StatementPublicationNativeCursor | null; complete: boolean; examined: number; witnessTuples: number;
  references: { subject: string; predicate: string; meaningKey: string; statementId: string; head: string;
    source: string | null; hasEvidence: boolean; applicability: string[] }[];
}
export interface TemplateIndexDelta {
  position: { dataEpoch: string; sequence: string };
  entities?: { graph: string; id: string; terms: Record<string,string[]> }[];
  bases: (TemplateIndexKey & { sequence: string;previous?:string })[];
  next?: string;
}
export interface CatalogueBulkEnvelope extends CommandEnvelope {
  /** A normal guarded cancellation, sharing the item's receipt identity. */
  cancellation: string;
}
export type CommandResult =
  | { status: 'committed'; position: CommandPosition; templateIndex?: TemplateIndexDelta }
  | { status: 'guard-unmatched' | 'conflict' | 'unknown-profile' | 'deadline' }
  | { status: 'invalid'; report?: unknown };
export interface MembershipPreparationInput {
  dataEpoch: string;
  routingEpoch: string;
  /** Exact request identity survives a lost acknowledgment. */
  requestId: string;
  /** Absolute wall deadline, shared by every preparation turn and retry. */
  deadline: number;
}
export type MembershipPreparationResult =
  | { status: 'committed'; complete: boolean; placements: number; receipts: string[];
      examined: number; phase: number; after: string; restarted: boolean }
  | Exclude<CommandResult, { status: 'committed' }>;
/** One native Work-name directory page. The command keeps its own page size and ten-second budget. */
export interface WorkScopeDirectoryPage {
  status: 'prepared' | 'deadline';
  phase: 'absent' | 'owners' | 'complete';
  more: boolean;
}
/** Typed refusal when this stack's writer is not the exclusive directory writer. */
export interface WorkScopeDirectoryRefusal {
  status: 'unavailable';
  reason: 'writer-not-exclusive';
}
export interface CommandHealth { moduleVersion: string; instanceId: string;
  publicSearchWriteEpoch: string; publicSearchWriteActive: boolean;
  privateSearchWriteEpoch?: string; privateSearchWriteActive?: boolean;
  publicSearchDeltaAvailable?: boolean;
  /** Absent on older native modules; commandHealth exposes that as false. */
  prefixWalkAvailable?: boolean;
  /** Native build capabilities; generation admission and delivery authority remain separate. */
  consistentCaptureAvailable?: boolean;
  exactUnitProbeAvailable?: boolean;
  profiles: Record<string, string> }

export interface SearchDeltaProof {
  available: boolean;
  ordinal?: string; dataEpoch?: string; sequence?: string; generation?: string;
  writeEpoch?: string; luceneGeneration?: string;
  /** Startup/rebuild qualification maintained by the native delta writer. */
  qualifiedPopulation?: string;
  deltas?: { ordinal: string; dataEpoch: string; sequence: string; generation: string;
    writeEpoch: string; changes: { unit: string; before: boolean; after: boolean }[] }[];
}

export class CommandOutcomeUnknown extends Error {}
export class CommandForbidden extends Error {}
export interface SourceAuthorNamesRequest {
  target: string;
  sourceKey: string;
  credits: string[];
  names: { sourceKey: string; displayName: string; language: string | null }[];
  sourcePosition: string;
  idempotencyKey: string;
}
export interface SourceAuthorNamesResponse {
  target: string; work: string; mainVersion: string | null;
  sourceKey: string; sourcePosition: string; names: number; examined: number; replayed: boolean;
}
export class FusekiQueryResponseTooLarge extends Error {}

/** Retain HTTP evidence without making callers parse diagnostic messages. */
export class FusekiHttpError extends Error {
  constructor(message: string, readonly status: number, readonly statusText: string) {
    super(message);
  }
}

async function boundedJson<T>(response: Response, maxResponseBytes?: number, signal?: AbortSignal,
  call?: ObservedReadCall): Promise<T> {
  if (!call) {
    // Command receipt bodies already debit this owner too. Observe those bytes
    // without adding a call charge or changing the command transport.
    const observation = beginReadObservation('command', signal);
    if (observation) {
      noteReadResponse(observation, response);
      return finishObservedRead(observation, () => boundedJson<T>(response, maxResponseBytes, signal, observation));
    }
  }
  if (signal?.aborted) await response.body?.cancel(signal.reason);
  signal?.throwIfAborted();
  if (!signal && maxResponseBytes === undefined && !fusekiReadBudget.getStore()) return response.json() as Promise<T>;
  const limit = maxResponseBytes ?? (fusekiReadBudget.getStore() ? 1_048_576 : Infinity);
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) {
    await response.body?.cancel();
    throw new FusekiQueryResponseTooLarge('Fuseki response exceeds byte budget');
  }
  if (!response.body) throw new Error('Fuseki response body is missing');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (call && !next.done) call.actualBytes += next.value.byteLength;
      signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      takeReadBytes(next.value.byteLength, call);
      if (bytes > limit) throw new FusekiQueryResponseTooLarge('Fuseki response exceeds byte budget');
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  signal?.throwIfAborted();
  assertFusekiReadActive();
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}
export class CommandRejected extends Error {
  constructor(readonly result: Exclude<CommandResult, { status: 'committed' }>) {
    super(`Fuseki command ${result.status}`);
  }
}

const RECEIPTS = 'urn:rezics:graph:receipts';
const RV = 'https://rezics.com/vocab/';
const MAINTENANCE_RECEIPTS = [
  'urn:rezics:name-migration:',
  'urn:rezics:receipt:bootstrap:', 'urn:rezics:receipt:restore-cutover:',
  'urn:rezics:receipt:restore-release:', 'urn:rezics:receipt:retained-zero:',
  'urn:rezics:receipt:content-rebuild:', 'urn:rezics:receipt:chapter-search-index:',
  'urn:rezics:receipt:catalogue-search-index:',
] as const;

function workScopeDirectoryPage(value: unknown): WorkScopeDirectoryPage {
  if (!value || typeof value !== 'object') throw new Error('Malformed work name scope preparation');
  const page = value as WorkScopeDirectoryPage;
  const keys = Object.keys(page);
  if (keys.length !== 3 || !keys.includes('status') || !keys.includes('phase') || !keys.includes('more')
    || (page.status !== 'prepared' && page.status !== 'deadline')
    || (page.phase !== 'absent' && page.phase !== 'owners' && page.phase !== 'complete')
    || typeof page.more !== 'boolean') throw new Error('Malformed work name scope preparation');
  if (page.status === 'deadline') {
    if (page.phase !== 'absent' || page.more !== true) throw new Error('Malformed work name scope preparation');
    return page;
  }
  if (page.phase === 'complete' && page.more === false) return page;
  if (page.phase === 'owners' && page.more === true) return page;
  throw new Error('Malformed work name scope preparation');
}

function workScopeDirectoryRefusal(value: unknown): WorkScopeDirectoryRefusal {
  if (!value || typeof value !== 'object') throw new Error('Malformed work name scope preparation');
  const page = value as WorkScopeDirectoryRefusal;
  const keys = Object.keys(page);
  if (keys.length !== 2 || !keys.includes('status') || !keys.includes('reason')
    || page.status !== 'unavailable' || page.reason !== 'writer-not-exclusive') {
    throw new Error('Malformed work name scope preparation');
  }
  return page;
}

function safeIri(value: string): string {
  if (!/^(https?:\/\/[^<>\s"{}|\\^`]+|urn:[A-Za-z0-9][A-Za-z0-9:._-]+)$/.test(value)) {
    throw new Error('invalid command receipt IRI');
  }
  return `<${value}>`;
}

export class FusekiClient {
  /** Existing also-enjoyed owner's physical page. No writes or lazy rebuilds. */
  async alsoEnjoyedCandidates(input: { source: string; types: string[]; language: string | null;
    realm: string | null; limit: number }): Promise<{ works: string[]; examined: number }> {
    if (!this.commandCapability?.match(/^[0-9a-f]{64}$/u)) throw new Error('Candidate directory capability is required');
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    return withReadCall('alsoEnjoyedCandidates', signal, async observation => {
      const diagnostic = beginReadCall('query');
      let status: Exclude<FusekiReadCallStatus, 'active'> = 'failed';
      let examined: number | undefined;
      try {
        const response = await fetch(new URL('command', this.baseUrl), {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.commandCapability}`, ...readBudgetHeaders() },
          body: JSON.stringify({ alsoEnjoyedCandidates: input }), signal,
        });
        noteReadResponse(observation, response);
        if (!response.ok) throw new Error(`Candidate directory returned ${response.status}`);
        const result = await boundedJson<{ works: string[]; examined: number }>(response, 65_536, signal, observation);
        if (!Array.isArray(result.works) || result.works.length > input.limit
          || result.works.some((work, index) => !/^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(work)
            || work === input.source || index > 0 && result.works[index - 1]! >= work)
          || new Set(result.works).size !== result.works.length || !Number.isSafeInteger(result.examined)
          || result.examined < 0 || result.examined > 3 * 65 * 32 * 16)
          throw new Error('Malformed candidate directory page');
        examined = result.examined; status = 'complete'; return result;
      } catch (error) { if (signal.aborted) status = 'aborted'; throw error; }
      finally { finishReadCall(diagnostic, status, examined); }
    });
  }
  /** Effect-free native directory read; shares the public search call, byte and wall budget. */
  async prefixWalk(input: { prefix: string; language: string | null; pageSize: number;
    cursor: string | null }): Promise<unknown> {
    if (!this.commandCapability?.match(/^[0-9a-f]{64}$/u)) {
      throw new FusekiPrefixWalkUnavailable('Prefix directory capability is unavailable');
    }
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    return withReadCall('prefixWalk', signal, async observation => {
      const diagnostic = beginReadCall('query');
      let status: Exclude<FusekiReadCallStatus, 'active'> = 'failed';
      let examined: number | undefined;
      try {
        const response = await fetch(new URL('command', this.baseUrl), {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json',
            authorization: `Bearer ${this.commandCapability}`, ...readBudgetHeaders() },
          body: JSON.stringify({ prefixWalk: input }), signal,
        });
        noteReadResponse(observation, response);
        if (response.status === 409) throw new FusekiPrefixWalkRestart('Prefix directory generation changed');
        if (!response.ok) throw new FusekiPrefixWalkUnavailable(`Prefix directory returned ${response.status}`);
        const result = await boundedJson<unknown>(response, 65_536, signal, observation);
        if (result && typeof result === 'object' && 'examined' in result
          && typeof result.examined === 'number' && Number.isSafeInteger(result.examined)
          && result.examined >= 0 && result.examined <= input.pageSize) examined = result.examined;
        status = 'complete';
        return result;
      } catch (error) {
        if (signal.aborted) status = 'aborted';
        throw error;
      } finally { finishReadCall(diagnostic, status, examined); }
    });
  }
  async sourceAuthorNames(request: SourceAuthorNamesRequest): Promise<SourceAuthorNamesResponse> {
    const id = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
    if (!id.test(request.target) || !/^\/authors\/OL[1-9][0-9]{0,11}A$/u.test(request.sourceKey)
      || !/^(0|[1-9][0-9]{0,63})$/u.test(request.sourcePosition)
      || !/^[A-Za-z0-9:_./-]{1,128}$/u.test(request.idempotencyKey)
      || request.credits.length > 128 || request.credits.some(credit => !id.test(credit))
      || request.names.length > 192 || request.names.some(name => name.sourceKey !== request.sourceKey
        || !name.displayName.trim() || name.displayName.length > 200
        || /[\u0000-\u001f\u007f]/u.test(name.displayName)
        || (name.language !== null && typeof name.language !== 'string'))) {
      throw new Error('invalid source author name publication');
    }
    if (!this.commandCapability?.match(/^[0-9a-f]{64}$/u)) throw new CommandForbidden('Fuseki admitted command capability is required');
    const body = JSON.stringify({ sourceAuthorNames: request });
    if (Buffer.byteLength(body) > 131_072) throw new Error('source author names exceed request budget');
    const signal = this.preparationSignal ? AbortSignal.any([this.preparationSignal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000);
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(new URL('command', this.baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json',
          authorization: `Bearer ${this.commandCapability}` }, body,
        signal,
      });
    } catch (error) { throw new CommandOutcomeUnknown('Source author publication outcome unknown', { cause: error }); }
    if (response.status === 403) throw new CommandForbidden('Source author publication capability rejected');
    if (!response.ok) throw new Error(`Source author publication returned ${response.status}`);
    const result = await boundedJson<SourceAuthorNamesResponse>(response, 4096, signal);
    if (result.target !== request.target || !id.test(result.work)
      || (result.mainVersion !== null && !id.test(result.mainVersion))
      || (result.work !== request.target && result.mainVersion !== request.target)
      || result.sourceKey !== request.sourceKey || result.sourcePosition !== request.sourcePosition || !Number.isSafeInteger(result.names)
      || result.names !== request.names.length || !Number.isSafeInteger(result.examined)
      || result.examined < 0 || result.examined > 64 * (192 * 128 + 192) + 192 + 128
      || typeof result.replayed !== 'boolean') {
      throw new CommandOutcomeUnknown('Malformed source author publication response');
    }
    return result;
  }
  private templateIndexWriter?: (delta: TemplateIndexDelta) => Promise<void>;
  attachTemplateIndexWriter(writer: (delta: TemplateIndexDelta) => Promise<void>): void {
    this.templateIndexWriter = writer;
  }
  private readonly baseUrl: URL;
  private readonly maintenanceCapability: string | undefined;

  constructor(baseUrl: string, maintenanceCapability = process.env.FUSEKI_MAINTENANCE_TOKEN,
    private readonly commandCapability = process.env.FUSEKI_COMMAND_TOKEN,
    private readonly preparationSignal?: AbortSignal) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Fuseki URL must be HTTP(S)');
    }
    parsed.pathname = parsed.pathname.replace(/\/*$/, '/');
    this.baseUrl = parsed;
    this.maintenanceCapability = maintenanceCapability;
  }

  async query(sparql: string, maxResponseBytes?: number,
    nativePhase?: 'occurrence-discovery'): Promise<SparqlResult> {
    if (maxResponseBytes !== undefined
      && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1)) {
      throw new Error('invalid Fuseki query response budget');
    }
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    return nativePhase ? this.queryLive(sparql, maxResponseBytes, signal, nativePhase)
      : fencedGraphQuery(this, sparql, maxResponseBytes, () => this.queryLive(sparql, maxResponseBytes, signal));
  }

  private async queryLive(sparql: string, maxResponseBytes: number | undefined, signal: AbortSignal,
    nativePhase?: 'occurrence-discovery'): Promise<SparqlResult> {
    return withReadCall('query', signal, async observation => {
      const diagnostic = beginReadCall('query');
      let status: Exclude<FusekiReadCallStatus, 'active'> = 'failed';
      try {
        const response = await fetch(new URL('query', this.baseUrl), {
          method: 'POST',
          headers: {
            'content-type': 'application/sparql-query',
            accept: 'application/sparql-results+json',
            ...readBudgetHeaders(),
            ...(nativePhase === 'occurrence-discovery'
              ? { 'x-rezics-native-phase': 'occurrence-discovery' } : {}),
          },
          body: sparql,
          signal,
        });
        noteReadResponse(observation, response);
        if (!response.ok) throw new FusekiHttpError(`Fuseki query returned ${response.status}`,
          response.status, response.statusText);
        const result = await boundedJson<SparqlResult>(response, maxResponseBytes, signal, observation);
        const graphVersion = response.headers.get('x-rezics-graph-version');
        if (graphVersion && /^[0-9a-f-]{36}:[0-9a-f-]{36}:(0|[1-9][0-9]*)$/.test(graphVersion)) {
          noteGraphReadVersion(result, graphVersion);
        }
        status = 'complete';
        return result;
      } catch (error) {
        if (signal.aborted) status = 'aborted';
        throw error;
      } finally { finishReadCall(diagnostic, status); }
    }, sparql);
  }

  async templateQuery(envelope: TemplateQueryEnvelope, maxResponseBytes = 512 * 1024): Promise<SparqlResult> {
    if (!Number.isSafeInteger(envelope.limit) || envelope.limit < 1 || envelope.limit > 256
      || Object.keys(envelope.bindings).length > 64 || envelope.tables.length > 4
      || envelope.tables.reduce((total, table) => total + table.rows.length, 0) > 256
      || (envelope.candidates?.length ?? 0)>256
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 512 * 1024) {
      throw new Error('invalid template query budget');
    }
    if (!this.commandCapability?.match(/^[0-9a-f]{64}$/)) {
      throw new Error('Fuseki template query capability is required');
    }
    const body = JSON.stringify({ templateQuery: envelope });
    if (Buffer.byteLength(body) > 512 * 1024) throw new Error('template query exceeds request byte budget');
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    return withReadCall('templateQuery', signal, async observation => {
      const diagnostic = beginReadCall('template-query');
      let status: Exclude<FusekiReadCallStatus, 'active'> = 'failed';
      try {
        const response = await fetch(new URL('command', this.baseUrl), {
          method: 'POST', headers: { 'content-type': 'application/json',
            accept: 'application/sparql-results+json', authorization: `Bearer ${this.commandCapability}`,
            ...readBudgetHeaders() },
          body, signal,
        });
        noteReadResponse(observation, response);
        if (response.status === 403) throw new CommandForbidden('Fuseki template query capability rejected');
        if (!response.ok) throw new Error(`Fuseki template query returned ${response.status}`);
        const result = await boundedJson<SparqlResult>(response, maxResponseBytes, signal, observation);
        status = 'complete';
        return result;
      } catch (error) {
        if (signal.aborted) status = 'aborted';
        throw error;
      } finally { finishReadCall(diagnostic, status); }
    }, envelope.query);
  }

  async templateIndex(input: StatementPublicationNativeRequest): Promise<StatementPublicationNativeResult>;
  async templateIndex(input: LibraryCollectionNativeRequest): Promise<LibraryCollectionNativeResult>;
  async templateIndex(input: { operation: 'basis'; keys: TemplateIndexKey[] }
    | { operation: 'backfill'; phase: number; after: string }): Promise<TemplateIndexDelta>;
  async templateIndex(input: LibraryCollectionNativeRequest | StatementPublicationNativeRequest | { operation: 'basis'; keys: TemplateIndexKey[] }
    | { operation: 'backfill'; phase: number; after: string }): Promise<TemplateIndexDelta | StatementPublicationNativeResult | LibraryCollectionNativeResult> {
    if (!this.commandCapability?.match(/^[0-9a-f]{64}$/)) throw new Error('Template index capability is required');
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    return withReadCall('templateIndex', signal, async observation => {
      const response = await fetch(new URL('command',this.baseUrl), {
        method: 'POST', headers: { 'content-type':'application/json', authorization:`Bearer ${this.commandCapability}`, ...readBudgetHeaders() },
        body: JSON.stringify({ templateIndex: input }), signal,
      });
      noteReadResponse(observation, response);
      if (!response.ok) throw new Error(`Template index returned ${response.status}`);
      return boundedJson<TemplateIndexDelta | StatementPublicationNativeResult | LibraryCollectionNativeResult>(response,1024*1024, signal, observation);
    });
  }

  async membershipPreparationStatus(): Promise<{ needsPreparation: boolean }> {
    if (!this.commandCapability?.match(/^[0-9a-f]{64}$/)) throw new Error('Membership preparation capability is required');
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    return withReadCall('membershipPreparationStatus', signal, async observation => {
      const response = await fetch(new URL('command', this.baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.commandCapability}`, ...readBudgetHeaders() },
        body: JSON.stringify({ templateIndex: { operation: 'membership-status' } }), signal,
      });
      noteReadResponse(observation, response);
      if (response.status === 403) throw new CommandForbidden('Membership preparation capability rejected');
      if (!response.ok) throw new Error(`Membership preparation status returned ${response.status}`);
      const result = await boundedJson<{ needsPreparation: boolean }>(response, 4096, signal, observation);
      if (typeof result?.needsPreparation !== 'boolean') throw new Error('Malformed membership preparation status');
      return result;
    });
  }

  async membershipPrepare(input: MembershipPreparationInput, signal?: AbortSignal): Promise<MembershipPreparationResult> {
    if (!this.commandCapability?.match(/^[0-9a-f]{64}$/)) throw new Error('Membership preparation capability is required');
    if (!input.dataEpoch || !input.routingEpoch || !input.requestId
      || !Number.isSafeInteger(input.deadline) || input.deadline < 1) throw new Error('Invalid membership preparation input');
    const remaining = Math.max(0, input.deadline - Date.now());
    const deadlineSignal = AbortSignal.timeout(remaining);
    const requestSignal = AbortSignal.any([deadlineSignal, ...(signal ? [signal] : []),
      ...(this.preparationSignal || fusekiReadBudget.getStore() ? [readSignal(this.preparationSignal)] : [])]);
    const body = JSON.stringify({ templateIndex: { operation: 'membership-prepare', ...input } });
    for (let attempt = 0; attempt < 2; attempt++) {
      requestSignal.throwIfAborted();
      try {
        return await withReadCall('membershipPrepare', requestSignal, async observation => {
          let response: Response;
          try {
            response = await fetch(new URL('command', this.baseUrl), {
              method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.commandCapability}` },
              body, signal: requestSignal,
            });
            noteReadResponse(observation, response);
          } catch (error) {
            requestSignal.throwIfAborted();
            throw new CommandOutcomeUnknown('Membership preparation transport outcome unknown', { cause: error });
          }
          if (response.status === 403) throw new CommandForbidden('Membership preparation capability rejected');
          if (response.status >= 500) {
            await response.body?.cancel();
            throw new CommandOutcomeUnknown(`Membership preparation returned ${response.status}`);
          }
          if (!response.ok && response.status !== 409 && response.status !== 422) {
            await response.body?.cancel();
            throw new Error(`Membership preparation returned ${response.status}`);
          }
          let result: MembershipPreparationResult;
          try { result = await boundedJson<MembershipPreparationResult>(response, 65_536, requestSignal, observation); }
          catch (error) {
            requestSignal.throwIfAborted();
            if (error instanceof FusekiQueryResponseTooLarge || error instanceof FusekiReadBudgetExceeded) throw error;
            throw new CommandOutcomeUnknown('Membership preparation response incomplete', { cause: error });
          }
          if (!result || !['committed', 'guard-unmatched', 'conflict', 'invalid', 'unknown-profile', 'deadline'].includes(result.status)) {
            throw new Error('Malformed membership preparation result');
          }
          if (result.status === 'committed' && (typeof result.complete !== 'boolean'
            || !Number.isInteger(result.placements) || result.placements < 0 || result.placements > 24
            || !Number.isInteger(result.examined) || result.examined < 0 || result.examined > 256
            || !Array.isArray(result.receipts) || result.receipts.length !== (result.placements > 0 ? 1 : 0)
            || result.receipts.some(receipt => typeof receipt !== 'string')
            || !Number.isInteger(result.phase) || result.phase < 0 || result.phase > 4
            || result.complete !== (result.phase === 4) || result.examined < result.placements
            || typeof result.after !== 'string' || !/^(?:[0-9a-f]{64})?$/.test(result.after)
            || typeof result.restarted !== 'boolean')) throw new Error('Malformed membership preparation bounds');
          return result;
        });
      } catch (error) {
        if (!(error instanceof CommandOutcomeUnknown) || attempt !== 0) throw error;
      }
    }
    throw new CommandOutcomeUnknown('Membership preparation outcome unknown');
  }

  /** One bounded Work-name directory page. The maintenance capability is required; the body carries no cursor or budget. */
  async prepareWorkScopeDirectory(signal?: AbortSignal): Promise<WorkScopeDirectoryPage | WorkScopeDirectoryRefusal> {
    if (!this.maintenanceCapability?.match(/^[0-9a-f]{64}$/)) {
      throw new Error('Fuseki maintenance capability is required');
    }
    const budget = fusekiReadBudget.getStore();
    // Twelve seconds lets the fixed ten-second native budget return its deadline page.
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(12_000),
      ...(signal ? [signal] : []),
      ...(this.preparationSignal ? [this.preparationSignal] : []),
      ...(budget?.signal ? [budget.signal] : []),
    ]);
    requestSignal.throwIfAborted();
    return withReadCall('prepareWorkScopeDirectory', requestSignal, async observation => {
      let response: Response;
      try {
        response = await fetch(new URL('command', this.baseUrl), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${this.maintenanceCapability}`,
          },
          body: JSON.stringify({ workScopeDirectory: {} }),
          signal: requestSignal,
        });
        noteReadResponse(observation, response);
      } catch (error) {
        requestSignal.throwIfAborted();
        throw new CommandOutcomeUnknown('Work name scope transport outcome unknown', { cause: error });
      }
      if (response.status === 403) throw new CommandForbidden('Work name scope capability rejected');
      if (response.status === 409) {
        let refused: unknown;
        try { refused = await boundedJson<unknown>(response, 4096, requestSignal, observation); }
        catch (error) {
          requestSignal.throwIfAborted();
          if (error instanceof FusekiQueryResponseTooLarge || error instanceof FusekiReadBudgetExceeded) throw error;
          throw new CommandOutcomeUnknown('Work name scope response incomplete', { cause: error });
        }
        return workScopeDirectoryRefusal(refused);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Work name scope preparation returned ${response.status}`);
      }
      let result: unknown;
      try { result = await boundedJson<unknown>(response, 4096, requestSignal, observation); }
      catch (error) {
        requestSignal.throwIfAborted();
        if (error instanceof FusekiQueryResponseTooLarge || error instanceof FusekiReadBudgetExceeded) throw error;
        throw new CommandOutcomeUnknown('Work name scope response incomplete', { cause: error });
      }
      return workScopeDirectoryPage(result);
    });
  }

  /** Legacy write surface; remaining domain and recovery adapters must migrate before P0.2 exit. */
  async update(sparql: string): Promise<void> {
    const response = await fetch(new URL('update', this.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/sparql-update' },
      body: sparql, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      let detail = '';
      try {
        detail = new TextDecoder().decode((await response.arrayBuffer()).slice(0, 2048))
          .replace(/\s+/g, ' ').trim();
      } catch { detail = ''; }
      throw new FusekiHttpError(`Fuseki update returned ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status, response.statusText);
    }
  }

  /** Empties every graph, including the work-scope proof graph. Only the maintenance capability is admitted. */
  async resetDataset(): Promise<void> {
    if (!this.maintenanceCapability?.match(/^[0-9a-f]{64}$/)) {
      throw new Error('Fuseki maintenance capability is required');
    }
    let response: Response;
    try {
      response = await fetch(new URL('command', this.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.maintenanceCapability}`,
        },
        body: JSON.stringify({ datasetReset: {} }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new CommandOutcomeUnknown('Fuseki dataset reset outcome unknown', { cause: error });
    }
    if (response.status === 403) throw new CommandForbidden('Fuseki dataset reset capability rejected');
    if (!response.ok) {
      let detail = '';
      try {
        detail = new TextDecoder().decode((await response.arrayBuffer()).slice(0, 2048))
          .replace(/\s+/g, ' ').trim();
      } catch { detail = ''; }
      throw new Error(`Fuseki dataset reset returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const result = await response.json() as { status?: string };
    if (result?.status !== 'reset') throw new Error('Fuseki dataset reset response malformed');
  }

  async commandHealth(): Promise<CommandHealth> {
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    return withReadCall('commandHealth', signal, async observation => {
      const diagnostic = beginReadCall('health');
      let status: Exclude<FusekiReadCallStatus, 'active'> = 'failed';
      try {
        const response = await fetch(new URL('command', this.baseUrl), {
          headers: { accept: 'application/json', ...readBudgetHeaders() }, signal,
        });
        noteReadResponse(observation, response);
        if (!response.ok) throw new Error(`Fuseki command health returned ${response.status}`);
        const value = await boundedJson<CommandHealth>(response, 65_536, signal, observation);
        if (!value || typeof value.moduleVersion !== 'string'
          || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.instanceId)
          || !/^(0|[1-9][0-9]*)$/.test(value.publicSearchWriteEpoch)
          || typeof value.publicSearchWriteActive !== 'boolean'
          || value.publicSearchWriteActive !== (BigInt(value.publicSearchWriteEpoch) % 2n === 1n)
          || (value.publicSearchDeltaAvailable !== undefined
            && typeof value.publicSearchDeltaAvailable !== 'boolean')
          || (value.prefixWalkAvailable !== undefined && typeof value.prefixWalkAvailable !== 'boolean')
          || (value.consistentCaptureAvailable !== undefined && typeof value.consistentCaptureAvailable !== 'boolean')
          || (value.exactUnitProbeAvailable !== undefined && typeof value.exactUnitProbeAvailable !== 'boolean')
          || !value.profiles
          || typeof value.profiles !== 'object') throw new Error('malformed Fuseki command health');
        status = 'complete';
        return { ...value, prefixWalkAvailable: value.prefixWalkAvailable ?? false,
          consistentCaptureAvailable: value.consistentCaptureAvailable ?? false,
          exactUnitProbeAvailable: value.exactUnitProbeAvailable ?? false };
      } catch (error) {
        if (signal.aborted) status = 'aborted';
        throw error;
      } finally { finishReadCall(diagnostic, status); }
    });
  }

  async searchDeltaSince(ordinal: string): Promise<SearchDeltaProof> {
    if (!/^-1$|^(0|[1-9][0-9]*)$/.test(ordinal)) throw new Error('invalid search delta ordinal');
    const signal = readSignal(this.preparationSignal);
    signal.throwIfAborted();
    return withReadCall('searchDeltaSince', signal, async observation => {
      const diagnostic = beginReadCall('delta-proof');
      let status: Exclude<FusekiReadCallStatus, 'active'> = 'failed';
      try {
        const url = new URL('command', this.baseUrl);
        url.searchParams.set('deltaSince', ordinal);
        const response = await fetch(url, {
          headers: { accept: 'application/json', ...readBudgetHeaders() }, signal,
        });
        noteReadResponse(observation, response);
        if (!response.ok) throw new Error(`Fuseki search delta returned ${response.status}`);
        const proof = await boundedJson<SearchDeltaProof>(response, 65_536, signal, observation);
        if (!proof || typeof proof.available !== 'boolean') throw new Error('malformed search delta proof');
        status = 'complete';
        return proof;
      } catch (error) {
        if (signal.aborted) status = 'aborted';
        throw error;
      } finally { finishReadCall(diagnostic, status); }
    });
  }

  async command(envelope: CommandEnvelope): Promise<CommandResult> {
    safeIri(envelope.receipt);
    if (!envelope.digest || !envelope.update || !Number.isSafeInteger(envelope.deadlineMs)
      || envelope.deadlineMs < 1 || envelope.deadlineMs > 60_000) {
      throw new Error('invalid Fuseki command envelope');
    }
    const maintenance = MAINTENANCE_RECEIPTS.some(prefix => envelope.receipt.startsWith(prefix));
    if (maintenance && !this.maintenanceCapability?.match(/^[0-9a-f]{64}$/)) {
      throw new Error('Fuseki maintenance capability is required');
    }
    const capability = maintenance ? this.maintenanceCapability : this.commandCapability;
    if (capability && !/^[0-9a-f]{64}$/.test(capability)) {
      throw new Error('invalid Fuseki command capability');
    }
    let response: Response;
    try {
      response = await fetch(new URL('command', this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json',
          ...(capability ? { authorization: `Bearer ${capability}` } : {}) },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(envelope.deadlineMs + 2_000),
      });
    } catch (error) {
      throw new CommandOutcomeUnknown('Fuseki command transport outcome unknown', { cause: error });
    }
    if (response.status === 403) throw new CommandForbidden('Fuseki command capability rejected');
    if (response.status >= 500) throw new CommandOutcomeUnknown(`Fuseki command returned ${response.status}`);
    if (response.status === 400) {
      const rejected = await boundedJson<{ message?: string }>(response, 4096);
      throw new Error(`Fuseki command rejected: ${rejected.message ?? 'bad request'}`);
    }
    let result: CommandResult;
    try { result = await response.json() as CommandResult; }
    catch (error) { throw new CommandOutcomeUnknown('Fuseki command response incomplete', { cause: error }); }
    if (!result || !['committed', 'guard-unmatched', 'conflict', 'invalid', 'unknown-profile', 'deadline'].includes(result.status)) {
      throw new CommandOutcomeUnknown('Fuseki command response malformed');
    }
    if (result.status === 'committed' && (!result.position || typeof result.position.datasetId !== 'string'
      || typeof result.position.dataEpoch !== 'string' || !/^\d+$/.test(result.position.sequence))) {
      throw new CommandOutcomeUnknown('Fuseki command position missing');
    }
    if (!response.ok && response.status !== 409 && response.status !== 422) {
      throw new CommandOutcomeUnknown(`Fuseki command returned ${response.status}`);
    }
    if (result.status === 'committed' && result.templateIndex && this.templateIndexWriter) {
      try { await this.templateIndexWriter(result.templateIndex); }
      catch (error) { throw new CommandOutcomeUnknown('Graph committed; template index needs receipt replay', { cause:error }); }
    }
    return result;
  }

  /** Resolve a lost acceptance reply against its exact retained record, never terminal absence. */
  async commandTitleCandidate(envelope: TitleCandidateCommandEnvelope): Promise<TitleCandidateResult> {
    try { return await this.dispatchTitleCandidate(envelope); }
    catch (error) {
      if (!(error instanceof CommandOutcomeUnknown)) throw error;
      return this.dispatchTitleCandidate({ ...envelope,
        titleCandidate: { ...envelope.titleCandidate, mode: 'lookup' } });
    }
  }

  private async dispatchTitleCandidate(envelope: TitleCandidateCommandEnvelope): Promise<TitleCandidateResult> {
    safeIri(envelope.receipt);
    const candidate = envelope.titleCandidate, proof = envelope.titleAdmission;
    const hasKeys = (value: object, keys: readonly string[]): boolean =>
      Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    if (!hasKeys(envelope, ['receipt', 'digest', 'update', 'validations', 'deadlineMs', 'titleCandidate', 'titleAdmission'])
      || envelope.update !== '' || !Array.isArray(envelope.validations) || envelope.validations.length !== 0
      || envelope.deadlineMs !== 10000 || !/^[0-9a-f]{64}$/.test(envelope.digest)
      || !candidate || !hasKeys(candidate, ['frame', 'custodySha256', 'mode'])
      || typeof candidate.frame !== 'string' || Buffer.byteLength(candidate.frame) > 32768
      || !/^[0-9a-f]{64}$/.test(candidate.custodySha256) || !['accept', 'lookup'].includes(candidate.mode)
      || !proof || !hasKeys(proof, ['payload', 'signature']) || typeof proof.payload !== 'string'
      || Buffer.byteLength(proof.payload) > 8192 || !/^[0-9a-f]{64}$/.test(proof.signature)) {
      throw new Error('invalid Fuseki title candidate envelope');
    }
    if (!this.commandCapability?.match(/^[0-9a-f]{64}$/)) {
      throw new Error('Fuseki admitted command capability is required');
    }
    let response: Response;
    try {
      response = await fetch(new URL('command', this.baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json',
          authorization: `Bearer ${this.commandCapability}` },
        body: JSON.stringify(envelope), signal: AbortSignal.timeout(envelope.deadlineMs + 2_000),
      });
    } catch (error) {
      throw new CommandOutcomeUnknown('Fuseki title acceptance transport outcome unknown', { cause: error });
    }
    if (response.status === 403) throw new CommandForbidden('Fuseki title acceptance capability rejected');
    if (response.status === 400) {
      const rejected = await boundedJson<{ message?: string }>(response, 4096);
      throw new Error(`Fuseki title acceptance rejected: ${rejected.message ?? 'bad request'}`);
    }
    if (!response.ok) throw new CommandOutcomeUnknown(`Fuseki title acceptance returned ${response.status}`);
    let result: TitleCandidateResult;
    try { result = await boundedJson<TitleCandidateResult>(response, 262144); }
    catch (error) {
      throw new CommandOutcomeUnknown('Fuseki title acceptance response incomplete', { cause: error });
    }
    if (!result || typeof result !== 'object' || Object.hasOwn(result, 'changed')) {
      throw new CommandOutcomeUnknown('Fuseki title acceptance response malformed');
    }
    switch (result.status) {
      case 'accepted':
      case 'historical':
        if (!hasKeys(result, ['status', 'receipt', 'digest', 'record']) || result.receipt !== envelope.receipt
          || result.digest !== envelope.digest || typeof result.record !== 'string'
          || result.record.length > 98304 || Buffer.byteLength(result.record) > 196608) {
          throw new CommandOutcomeUnknown('Fuseki retained title acceptance differs');
        }
        break;
      case 'terminal':
        if (!hasKeys(result, ['status', 'receipt', 'digest', 'outcome']) || result.receipt !== envelope.receipt
          || result.digest !== envelope.digest || !['succeeded', 'cancelled'].includes(result.outcome)) {
          throw new CommandOutcomeUnknown('Fuseki title terminal receipt differs');
        }
        break;
      case 'conflict':
        if ((!hasKeys(result, ['status']) && !hasKeys(result, ['status', 'reason']))
          || (result.reason !== undefined && typeof result.reason !== 'string')) {
          throw new CommandOutcomeUnknown('Fuseki title acceptance conflict malformed');
        }
        break;
      case 'deadline':
        if (!hasKeys(result, ['status'])) throw new CommandOutcomeUnknown('Fuseki title acceptance deadline malformed');
        break;
      default:
        throw new CommandOutcomeUnknown('Fuseki title acceptance status malformed');
    }
    return result;
  }

  /** Catalogue items have independent receipts and savepoints inside one native
   * durable transaction. A lost batch response must be reconciled per receipt. */
  async catalogueBatch(items: readonly CatalogueBulkEnvelope[]): Promise<CommandResult[]> {
    if (items.length < 1 || items.length > 128 || new Set(items.map(item => item.receipt)).size !== items.length)
      throw new Error('Invalid catalogue batch');
    const body = JSON.stringify({ items });
    if (Buffer.byteLength(body) > 16_000_000) throw new Error('Catalogue batch exceeds native byte bound');
    const response = await fetch(new URL('command', this.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json',
        ...(this.commandCapability ? { authorization: `Bearer ${this.commandCapability}` } : {}) },
      body, signal: AbortSignal.timeout(35_000),
    });
    if (response.status === 403) throw new CommandForbidden('Fuseki command capability rejected');
    if (!response.ok) throw new CommandOutcomeUnknown(`Fuseki catalogue batch returned ${response.status}`);
    const result = await boundedJson<{ items: CommandResult[] }>(response, 65_536);
    if (!Array.isArray(result.items) || result.items.length !== items.length
      || result.items.some(item => !['committed', 'invalid', 'guard-unmatched', 'conflict', 'deadline', 'unknown-profile'].includes(item.status)))
      throw new CommandOutcomeUnknown('Malformed catalogue batch result');
    if (this.templateIndexWriter) for (const item of result.items) {
      if (item.status === 'committed' && item.templateIndex) await this.templateIndexWriter(item.templateIndex);
    }
    return result.items;
  }

  /** Resolve this command's receipt, never the dataset head, after an uncertain response. */
  async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    let result: CommandResult | undefined;
    let commandFailure: CommandOutcomeUnknown | undefined;
    try { result = await this.command(envelope); }
    catch (error) {
      if (!(error instanceof CommandOutcomeUnknown)) throw error;
      commandFailure = error;
    }
    if (result?.status === 'committed' || result?.status === 'invalid'
      || result?.status === 'unknown-profile') return result;
    const receipt = await this.query(`PREFIX rv: <${RV}> SELECT ?digest ?dataset ?epoch ?sequence WHERE {
      GRAPH <${RECEIPTS}> { ${safeIri(envelope.receipt)} rv:requestDigest ?digest ;
        rv:datasetId ?dataset ; rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
    }`);
    const rows = receipt.results?.bindings ?? [];
    if (rows.length > 1) throw new Error('command receipt cardinality violation',
      commandFailure ? { cause: commandFailure } : undefined);
    if (rows.length === 1) {
      const row = rows[0]!;
      if (row.digest?.value !== envelope.digest) return { status: 'conflict' };
      if (!row.dataset || !row.epoch || !row.sequence) throw new Error('incomplete command receipt',
        commandFailure ? { cause: commandFailure } : undefined);
      if (this.templateIndexWriter) return this.command(envelope);
      return { status: 'committed', position: {
        datasetId: row.dataset.value, dataEpoch: row.epoch.value, sequence: row.sequence.value,
      } };
    }
    if (result?.status === 'deadline') {
      throw new CommandOutcomeUnknown('Fuseki command deadline; receipt absent',
        commandFailure ? { cause: commandFailure } : undefined);
    }
    if (result) return result;
    throw new CommandOutcomeUnknown('Fuseki command outcome unknown; receipt absent',
      commandFailure ? { cause: commandFailure } : undefined);
  }
}
