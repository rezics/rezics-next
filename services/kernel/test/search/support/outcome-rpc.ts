import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import type { WorkerStats } from './outcome-worker.ts';
import { systemClock, type KernelClock } from '../../../src/clock.ts';

export const OUTCOME_WORKER_READY_MESSAGE = 'rezics.search.outcome-worker.ready';

/** Private child custody, never fixture credentials or business authority. */
export interface OutcomeClockState {
  lifecycle: string;
  instant?: number;
}

export function outcomeClockInstant(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime()))
    throw new Error('Worker clock instant must be a valid safe integer timestamp');
  return value;
}

function clockState(value: unknown, requireInstant: boolean): OutcomeClockState {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'lifecycle' && key !== 'instant') ||
    !('lifecycle' in value) ||
    typeof value.lifecycle !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.lifecycle)
  )
    throw new Error('Worker clock requires its private lifecycle');
  const instant = 'instant' in value ? outcomeClockInstant(value.instant) : undefined;
  if (requireInstant && instant === undefined) throw new Error('Worker clock transition requires an instant');
  return { lifecycle: value.lifecycle, ...(instant === undefined ? {} : { instant }) };
}

/** Replicates explicit fixture instants only. The supplied instrumentation function retains its identity. */
export function createOutcomeWorkerClock(supplied?: KernelClock) {
  let lifecycle: string | undefined;
  let instant: number | undefined;
  const clock: KernelClock = supplied ?? (() => (instant === undefined ? systemClock() : new Date(instant)));
  return {
    clock,
    initialize(value: unknown) {
      if (supplied) throw new Error('Instrumented worker retains the supplied clock');
      if (lifecycle !== undefined) throw new Error('Worker clock lifecycle already initialized');
      const state = clockState(value, false);
      lifecycle = state.lifecycle;
      instant = state.instant;
    },
    change(value: unknown): OutcomeClockState {
      if (supplied) throw new Error('Instrumented worker retains the supplied clock');
      const state = clockState(value, true);
      if (lifecycle === undefined || state.lifecycle !== lifecycle) throw new Error('Foreign worker clock lifecycle');
      if (instant !== undefined && state.instant! < instant) throw new Error('Worker clock cannot move backwards');
      instant = state.instant!;
      return { lifecycle, instant };
    },
  };
}

/** Owns only the existing native worker executable; it never provisions fixture state. */
export function startOutcomeWorkerProcess(
  env: Record<string, string | undefined>,
  options: { frozenInstant?: number; searchDisabled?: boolean } = {},
) {
  const lifecycle = randomUUID();
  const initialClock: OutcomeClockState = {
    lifecycle,
    ...(options.frozenInstant === undefined ? {} : { instant: outcomeClockInstant(options.frozenInstant) }),
  };
  const child = fork(`${import.meta.dir}/outcome-worker.ts`, [], {
    execPath: process.execPath,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => /^(PATH|HOME|TMPDIR|TEMP|LANG|TZ|BUN_.+)$/.test(key)),
      ),
      // Database imports execute before init. They must already address this exact world.
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  let outputRemainder = '';
  let exited = false;
  let custodyFailure: Error | undefined;
  const append = (chunk: unknown) => {
    const text = String(chunk);
    output = (output + text).slice(-65_536);
    const lines = `${outputRemainder}${text}`.split(/\r?\n/);
    outputRemainder = lines.pop() ?? '';
    for (const line of lines) if (line.includes('outcome-worker phase=')) process.stderr.write(`${line}\n`);
  };
  child.stdout!.on('data', append);
  child.stderr!.on('data', append);
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once('close', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    }),
  );
  let settleIpcReady!: () => void;
  let rejectIpcReady!: (error: Error) => void;
  let ipcReadySettled = false;
  const ipcReady = new Promise<void>((resolve, reject) => {
    settleIpcReady = resolve;
    rejectIpcReady = reject;
  });
  const finishIpcReady = () => {
    if (ipcReadySettled) return;
    ipcReadySettled = true;
    child.off('message', onIpcMessage);
    child.off('error', failIpcReady);
    child.off('disconnect', onIpcDisconnect);
    settleIpcReady();
  };
  const failIpcReady = (error: Error) => {
    if (ipcReadySettled) return;
    ipcReadySettled = true;
    child.off('message', onIpcMessage);
    child.off('error', failIpcReady);
    child.off('disconnect', onIpcDisconnect);
    rejectIpcReady(error);
  };
  const onIpcMessage = (packet: unknown) => {
    if (
      typeof packet === 'object' &&
      packet !== null &&
      !Array.isArray(packet) &&
      'type' in packet &&
      packet.type === OUTCOME_WORKER_READY_MESSAGE
    ) {
      finishIpcReady();
    }
  };
  const onIpcDisconnect = () => failIpcReady(new Error(`Worker IPC disconnected before ready: ${output}`));
  child.on('message', onIpcMessage);
  child.once('error', failIpcReady);
  child.once('disconnect', onIpcDisconnect);
  void exit.then(({ code, signal }) => {
    failIpcReady(new Error(`Worker exited before IPC ready: ${JSON.stringify({ code, signal })}: ${output}`));
  });
  const rpc = createOutcomeRpc(
    {
      send: (packet) =>
        new Promise<void>((resolve, reject) => {
          child.send(packet as object, (error) => {
            if (error) {
              custodyFailure ??= error;
              reject(error);
            } else resolve();
          });
        }),
      subscribe(message, failure) {
        const failed = (error: Error) => {
          custodyFailure ??= error;
          failure(error);
        };
        const disconnected = () => failed(new Error(`Worker IPC disconnected: ${output}`));
        const stopped = () => failed(new Error(`Worker exited: ${output}`));
        child.on('message', message);
        child.on('error', failed);
        child.on('disconnect', disconnected);
        child.on('exit', stopped);
        return () => {
          child.off('message', message);
          child.off('error', failed);
          child.off('disconnect', disconnected);
          child.off('exit', stopped);
        };
      },
    },
    {
      onRequest() {
        throw new Error('Worker cannot control released fixture');
      },
      timeoutMs: 90_000,
    },
  );
  // The initial explicit instant is installed before startWorker can register or launch work.
  // Child startup imports the production composition before installing the RPC listener.
  // Do not start the init deadline until that listener confirms it can receive requests.
  const ready = ipcReady.then(() =>
    rpc.request<WorkerStats>('init', {
      env,
      clock: initialClock,
      ...(options.searchDisabled ? { searchDisabled: true } : {}),
    }),
  );
  let readyFailure: unknown;
  void ready.catch((error) => {
    readyFailure = error;
  });
  let closing: Promise<void> | undefined;
  let crashing: Promise<{ code: number | null; signal: string | null }> | undefined;
  const assertClockCustody = () => {
    if (custodyFailure) throw custodyFailure;
    if (closing || crashing || exited || !child.connected) throw new Error('Worker clock custody is unavailable');
  };
  return {
    rpc,
    ready,
    get exited() {
      return exited;
    },
    assertClockCustody,
    async setClock(value: number): Promise<void> {
      const instant = outcomeClockInstant(value);
      assertClockCustody();
      await ready;
      assertClockCustody();
      const acknowledged = await rpc.request<OutcomeClockState>('clock', { lifecycle, instant });
      assertClockCustody();
      if (acknowledged.lifecycle !== lifecycle || acknowledged.instant !== instant)
        throw new Error('Worker clock acknowledgment does not match the transition');
    },
    crash() {
      if (closing) return Promise.reject(new Error('Worker is already closing'));
      return (crashing ??= (async () => {
        await ready;
        if (exited || !child.kill('SIGKILL')) throw new Error(`Owned worker could not be killed: ${output}`);
        const result = await exit;
        rpc.close();
        if (result.signal !== 'SIGKILL')
          throw new Error(`Owned worker did not exit from SIGKILL: ${JSON.stringify(result)}: ${output}`);
        return result;
      })());
    },
    close() {
      return (closing ??= (async () => {
        if (crashing) {
          await crashing;
          return;
        }
        const failures: unknown[] = [];
        const timer = setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, 90_000);
        try {
          try {
            // Close is an independent lifecycle control. Awaiting the init promise first
            // makes a stuck startup impossible to cancel through the same child RPC.
            if (!exited) {
              await ipcReady;
              if (!exited) await rpc.request<WorkerStats>('close', undefined, 60_000);
            }
          } catch (error) {
            const phases = output
              .split(/\r?\n/)
              .filter((line) => line.includes('outcome-worker phase='))
              .join(' | ');
            const init = readyFailure instanceof Error ? readyFailure.message : 'init pending';
            const close = error instanceof Error ? error.message : String(error);
            failures.push(new Error(`Owned worker close failed: ${close}; init=${init}; phases=${phases || 'none'}`));
          }
          if (child.connected) child.disconnect();
          const result = await exit;
          if (result.code !== 0 || result.signal !== null)
            failures.push(new Error(`Worker did not drain: ${JSON.stringify(result)}: ${output}`));
        } finally {
          clearTimeout(timer);
          rpc.close();
        }
        if (failures.length) throw new AggregateError(failures, 'Owned released worker cleanup failed');
      })());
    },
  };
}

/**
 * Test-only bidirectional request/response peer for plain-data IPC between a fixture supervisor and a worker
 * child. The transport adapter owns the real channel (send, message, exit, disconnect); the peer owns request
 * correlation, bounded pending state and result/error envelopes. A completed `send` is never a response.
 */

export interface OutcomeRpcTransport {
  send(packet: unknown): void | Promise<void>;
  subscribe(onMessage: (packet: unknown) => void, onFailure: (error: Error) => void): () => void;
}

export interface OutcomeRpcOptions {
  onRequest(method: string, params: unknown): unknown | Promise<unknown>;
  /** Default deadline for one request, in milliseconds. */
  timeoutMs?: number;
  /** Bound on outstanding outgoing requests and, separately, on running incoming handlers. */
  maxPending?: number;
}

export interface OutcomeRpc {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  close(error?: Error): void;
}

export type OutcomeRpcErrorCode = 'closed' | 'timeout' | 'overflow' | 'protocol' | 'invalid';

export class OutcomeRpcError extends Error {
  override readonly name = 'OutcomeRpcError';
  constructor(
    readonly code: OutcomeRpcErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const PROTOCOL = 'rezics.outcome-rpc';
const VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING = 64;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_TEXT = 256;
const MAX_PLAIN_DEPTH = 64;
const MAX_DETAIL_DEPTH = 6;
const MAX_DETAIL_ENTRIES = 50;
const MAX_CHAIN_DEPTH = 8;
const MAX_CHAIN_FANOUT = 16;
const MAX_CHAIN_ERRORS = 64;
const RESERVED = new Set(['name', 'message', 'stack', 'cause', 'errors']);

type SerializedCause = { error: SerializedError } | { value: unknown };

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  details?: Record<string, unknown>;
  cause?: SerializedCause;
  errors?: SerializedCause[];
}

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ => typeof value === 'object' && value !== null;
const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  isRecord(value) && typeof value.then === 'function';

function positive(name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new OutcomeRpcError('invalid', `${name} must be a finite positive number`);
  }
  return value;
}

/** Throws unless the value is JSON-compatible plain data: no functions, prototypes, cycles or non-finite numbers. */
function assertPlain(value: unknown, path = 'value', ancestors: object[] = []): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new OutcomeRpcError('invalid', `${path} is a non-finite number`);
    return;
  }
  if (typeof value !== 'object') throw new OutcomeRpcError('invalid', `${path} is not plain data (${typeof value})`);
  if (ancestors.includes(value)) throw new OutcomeRpcError('invalid', `${path} is a cycle`);
  if (ancestors.length >= MAX_PLAIN_DEPTH) throw new OutcomeRpcError('invalid', `${path} is nested too deeply`);
  ancestors.push(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item === undefined) throw new OutcomeRpcError('invalid', `${path}[${index}] is undefined`);
      assertPlain(item, `${path}[${index}]`, ancestors);
    });
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OutcomeRpcError('invalid', `${path} is not a plain object`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) assertPlain(item, `${path}.${key}`, ancestors);
    }
  }
  ancestors.pop();
}

/** Best-effort plain copy of an arbitrary failure detail; never throws and never loops. */
function plainDetail(value: unknown, seen: Set<object>, depth: number): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DETAIL_DEPTH) return '[Truncated]';
  seen.add(value);
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (Array.isArray(value)) {
      return value.slice(0, MAX_DETAIL_ENTRIES).map((item) => plainDetail(item, seen, depth + 1) ?? null);
    }
    const copy: Record_ = {};
    for (const key of Object.keys(value).slice(0, MAX_DETAIL_ENTRIES)) {
      const item = plainDetail((value as Record_)[key], seen, depth + 1);
      if (item !== undefined)
        Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
    }
    return copy;
  } catch {
    return '[Unreadable]';
  } finally {
    seen.delete(value);
  }
}

interface ChainState {
  seen: Set<object>;
  budget: number;
}

function serializeCause(value: unknown, state: ChainState, depth: number): SerializedCause {
  if (!(value instanceof Error)) return { value: plainDetail(value, new Set(), 0) ?? null };
  if (state.seen.has(value)) return { value: '[Circular]' };
  if (depth >= MAX_CHAIN_DEPTH || state.budget <= 0) return { value: '[Truncated]' };
  state.seen.add(value);
  state.budget -= 1;
  const out: SerializedError = { name: 'Error', message: '' };
  try {
    out.name = String(value.name);
    out.message = String(value.message);
    if (typeof value.stack === 'string') out.stack = value.stack;
    const details: Record_ = {};
    const detailSeen = new Set<object>([value]);
    for (const key of Object.keys(value).slice(0, MAX_DETAIL_ENTRIES)) {
      if (RESERVED.has(key)) continue;
      const detail = plainDetail((value as unknown as Record_)[key], detailSeen, 1);
      if (detail !== undefined)
        Object.defineProperty(details, key, { value: detail, enumerable: true, writable: true, configurable: true });
    }
    if (Object.keys(details).length > 0) out.details = details;
    if ('cause' in value && value.cause !== undefined) out.cause = serializeCause(value.cause, state, depth + 1);
    if (value instanceof AggregateError) {
      out.errors = Array.from(value.errors)
        .slice(0, MAX_CHAIN_FANOUT)
        .map((item) => serializeCause(item, state, depth + 1));
    }
  } catch {
    // A hostile getter must not turn an operation error into a thrown event callback.
  }
  return { error: out };
}

const serializeThrown = (value: unknown): SerializedCause =>
  serializeCause(value, { seen: new Set(), budget: MAX_CHAIN_ERRORS }, 0);

function defineHidden(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
}

function protocolFailure(message: string): OutcomeRpcError {
  return new OutcomeRpcError('protocol', message);
}

function reviveCause(cause: unknown, depth = 0): unknown {
  if (!isRecord(cause) || depth > MAX_CHAIN_DEPTH + 1) throw protocolFailure('malformed error cause');
  if (!('error' in cause)) {
    if (!('value' in cause)) throw protocolFailure('malformed error cause');
    assertPlain(cause.value, 'cause value');
    return cause.value;
  }
  const serialized = cause.error;
  if (!isRecord(serialized) || typeof serialized.name !== 'string' || typeof serialized.message !== 'string') {
    throw protocolFailure('malformed serialized error');
  }
  let error: Error;
  if (serialized.errors !== undefined) {
    if (!Array.isArray(serialized.errors)) throw protocolFailure('malformed aggregate errors');
    error = new AggregateError(
      serialized.errors.map((item) => reviveCause(item, depth + 1)),
      serialized.message,
    );
  } else {
    error = new Error(serialized.message);
  }
  defineHidden(error, 'name', serialized.name);
  if (typeof serialized.stack === 'string') defineHidden(error, 'stack', serialized.stack);
  if (serialized.cause !== undefined) defineHidden(error, 'cause', reviveCause(serialized.cause, depth + 1));
  if (serialized.details !== undefined) {
    if (!isRecord(serialized.details)) throw protocolFailure('malformed error details');
    for (const [key, value] of Object.entries(serialized.details)) {
      if (RESERVED.has(key)) continue;
      Object.defineProperty(error, key, { value, writable: true, configurable: true, enumerable: true });
    }
  }
  return error;
}

interface Pending {
  method: string;
  resolve(value: never): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createOutcomeRpc(transport: OutcomeRpcTransport, options: OutcomeRpcOptions): OutcomeRpc {
  const defaultTimeout = positive('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxPending = positive('maxPending', options.maxPending ?? DEFAULT_MAX_PENDING);
  const prefix = randomUUID();
  const pending = new Map<string, Pending>();
  let handling = 0;
  let counter = 0;
  let closed: Error | undefined;
  let unsubscribe: (() => void) | undefined;

  const settle = (id: string, run: (entry: Pending) => void): void => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    run(entry);
  };

  const shutdown = (error: Error): void => {
    if (closed) return;
    closed = error;
    try {
      unsubscribe?.();
    } catch {
      // The listener is already unreachable for our purposes: `closed` gates every callback.
    }
    for (const id of [...pending.keys()]) settle(id, (entry) => entry.reject(error));
  };

  const deliver = (packet: Record_, fail: (error: Error) => void): void => {
    try {
      const sent = transport.send({ protocol: PROTOCOL, version: VERSION, ...packet });
      if (isThenable(sent)) sent.then(undefined, (error) => fail(asError(error)));
    } catch (error) {
      fail(asError(error));
    }
  };

  const reply = (id: string, method: string, outcome: { value: unknown } | { failure: unknown }): void => {
    if (closed) return;
    let packet: Record_;
    try {
      if ('failure' in outcome) throw outcome.failure;
      if (outcome.value !== undefined) assertPlain(outcome.value, 'result');
      packet = { kind: 'result', id, method, ...(outcome.value === undefined ? {} : { value: outcome.value }) };
    } catch (failure) {
      packet = { kind: 'error', id, method, error: serializeThrown(failure) };
    }
    // A lost reply leaves the requester waiting on state we can no longer repair.
    deliver(packet, shutdown);
  };

  const incoming = (id: string, packet: Record_): void => {
    const method = packet.method;
    if (typeof method !== 'string' || method === '' || method.length > MAX_TEXT) {
      return reply(id, '', { failure: protocolFailure('request method must be a non-empty string') });
    }
    if (handling >= maxPending) {
      return reply(id, method, {
        failure: new OutcomeRpcError('overflow', `more than ${maxPending} requests are running`),
      });
    }
    handling += 1;
    let outcome: Promise<unknown>;
    try {
      outcome = Promise.resolve(options.onRequest(method, packet.params));
    } catch (failure) {
      outcome = Promise.reject(failure);
    }
    outcome
      .then(
        (value) => reply(id, method, { value }),
        (failure) => reply(id, method, { failure }),
      )
      .finally(() => {
        handling -= 1;
      });
  };

  const malformed = (id: string | undefined, why: string): void => {
    const error = protocolFailure(why);
    if (id !== undefined && pending.has(id)) settle(id, (entry) => entry.reject(error));
    else shutdown(error);
  };

  const dispatch = (packet: unknown): void => {
    // Anything without our marker is someone else's traffic on a shared channel.
    if (!isRecord(packet) || packet.protocol !== PROTOCOL) return;
    const id =
      typeof packet.id === 'string' && packet.id !== '' && packet.id.length <= MAX_TEXT ? packet.id : undefined;
    const { kind } = packet;
    if (packet.version !== VERSION) return malformed(id, `unsupported protocol version ${String(packet.version)}`);
    if (kind !== 'request' && kind !== 'result' && kind !== 'error') return malformed(id, 'unknown packet kind');
    if (id === undefined) return malformed(id, 'packet has no valid id');
    if (kind === 'request') return incoming(id, packet);
    const entry = pending.get(id);
    if (!entry) return; // Late, duplicate or unrelated: it can resolve nothing.
    if (packet.method !== entry.method) return malformed(id, 'response method does not match its request');
    if (kind === 'result') return settle(id, (done) => done.resolve(packet.value as never));
    let failure: unknown;
    try {
      failure = reviveCause(packet.error);
    } catch (error) {
      return malformed(id, asError(error).message);
    }
    settle(id, (done) => done.reject(failure));
  };

  const onMessage = (packet: unknown): void => {
    if (closed) return;
    try {
      dispatch(packet);
    } catch (error) {
      shutdown(asError(error));
    }
  };

  unsubscribe = transport.subscribe(onMessage, (error) => shutdown(asError(error)));
  if (closed) unsubscribe();

  return {
    request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (closed) return reject(closed);
        let deadline: number;
        try {
          if (typeof method !== 'string' || method === '' || method.length > MAX_TEXT) {
            throw new OutcomeRpcError('invalid', 'method must be a non-empty string');
          }
          deadline = timeoutMs === undefined ? defaultTimeout : positive('timeoutMs', timeoutMs);
          if (params !== undefined) assertPlain(params, 'params');
        } catch (error) {
          return reject(error);
        }
        if (pending.size >= maxPending) {
          return reject(new OutcomeRpcError('overflow', `more than ${maxPending} requests are pending`));
        }
        const id = `${prefix}:${(counter += 1)}`;
        const timer = setTimeout(
          () =>
            settle(id, (entry) =>
              entry.reject(new OutcomeRpcError('timeout', `${method} did not complete within ${deadline} ms`)),
            ),
          Math.min(deadline, MAX_TIMER_MS),
        );
        pending.set(id, { method, resolve: resolve as (value: never) => void, reject, timer });
        deliver({ kind: 'request', id, method, ...(params === undefined ? {} : { params }) }, (error) =>
          settle(id, (entry) => entry.reject(error)),
        );
      });
    },
    close(error) {
      shutdown(error ?? new OutcomeRpcError('closed', 'outcome RPC closed'));
    },
  };
}
