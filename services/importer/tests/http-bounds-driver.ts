import { AsyncLocalStorage } from 'node:async_hooks';
import { Database } from 'bun:sqlite';
import type { Observation } from '../../../specs/imports-http-bounds-driver.ts';

type Store = ArrayBufferLike | object;
type Ledger = {
  observation: Observation;
  live: Map<Store, number>;
  retained: number;
};
type Reading = {
  source: Map<Ledger, ArrayBufferLike>;
  owned: Map<Ledger, ArrayBufferLike>;
};
type Body = { bytes: number; store: Store };
const active = new AsyncLocalStorage<Ledger[]>();
const responseStreams = new WeakSet<ReadableStream>();
const readers = new WeakMap<object, Reading>();
const buffers = new WeakMap<ArrayBufferLike, Reading>();
const bodies = new WeakMap<Response, Body>();
const NativeResponse = Response;

function retain(ledger: Ledger, store: Store, size: number) {
  if (ledger.live.has(store)) return;
  ledger.live.set(store, size);
  ledger.retained += size;
  ledger.observation.peakResponseBackingBytes = Math.max(ledger.observation.peakResponseBackingBytes, ledger.retained);
}
function release(ledger: Ledger, store: Store | undefined) {
  if (store === undefined) return;
  ledger.retained -= ledger.live.get(store) ?? 0;
  ledger.live.delete(store);
}
function visits(bytes: number) {
  for (const ledger of active.getStore() ?? []) ledger.observation.responseByteVisits += bytes;
}
function instrument(
  target: object,
  name: string,
  apply: (original: Function, receiver: unknown, args: unknown[]) => unknown,
) {
  const original: unknown = Reflect.get(target, name);
  if (typeof original !== 'function') throw new Error(`Cannot instrument ${name}`);
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    ...descriptor,
    value: new Proxy(original, { apply }),
  });
}

/** Observe actual stream deliveries and typed-array copies, not fixture sizes.
 * A reader owns at most its current delivered chunk and accumulator. A growing
 * accumulator overlaps its replacement during set(), then dies. Native Response
 * copies BufferSource inputs (including subviews); its copy stays live until body
 * consumption. Native body methods are forwarded unchanged: their scan sizes
 * come from that actual constructor input, and returned buffers are measured at
 * completion. Backing identities deduplicate views; no GC/heap/time sampling.
 * Native addons, pre-captured builtin methods and non-SQLite DB clients are outside
 * this observer. Production fetch has no such dependencies.
 */
globalThis.Response = new Proxy(NativeResponse, {
  construct(target, args) {
    const response = Reflect.construct(target, args) as Response;
    if (response.body) responseStreams.add(response.body);
    const input: unknown = args[0];
    if (input instanceof Uint8Array) {
      const reading = buffers.get(input.buffer);
      if (reading) {
        const body: Body = { bytes: input.byteLength, store: {} };
        bodies.set(response, body);
        for (const ledger of active.getStore() ?? []) {
          // A real native constructor copy, measured from its actual input view.
          ledger.observation.responseByteVisits += input.byteLength;
          retain(ledger, body.store, input.byteLength);
          release(ledger, reading.owned.get(ledger));
          reading.owned.delete(ledger);
        }
      }
    }
    return response;
  },
});
instrument(NativeResponse, 'json', (original, receiver, args) => {
  const response = Reflect.apply(original, receiver, args) as Response;
  if (response.body) responseStreams.add(response.body);
  return response;
});
instrument(ReadableStream.prototype, 'getReader', (original, receiver, args) => {
  const reader: object = Reflect.apply(original, receiver, args);
  if (responseStreams.has(receiver as ReadableStream)) readers.set(reader, { source: new Map(), owned: new Map() });
  return reader;
});
instrument(ReadableStreamDefaultReader.prototype, 'read', async (original, receiver, args) => {
  const reading = readers.get(receiver as object);
  if (reading) {
    for (const [ledger, buffer] of reading.source) release(ledger, buffer);
    reading.source.clear();
  }
  const result = (await Reflect.apply(original, receiver, args)) as ReadableStreamReadResult<unknown>;
  if (reading && !result.done && result.value instanceof Uint8Array) {
    const buffer = result.value.buffer;
    buffers.set(buffer, reading);
    for (const ledger of active.getStore() ?? []) {
      reading.source.set(ledger, buffer);
      retain(ledger, buffer, buffer.byteLength);
    }
  }
  return result;
});
for (const method of ['cancel', 'releaseLock']) {
  instrument(ReadableStreamDefaultReader.prototype, method, (original, receiver, args) => {
    const reading = readers.get(receiver as object);
    if (reading) {
      for (const [ledger, buffer] of reading.source) release(ledger, buffer);
      for (const [ledger, buffer] of reading.owned) release(ledger, buffer);
      reading.source.clear();
      reading.owned.clear();
    }
    return Reflect.apply(original, receiver, args);
  });
}
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
instrument(typedArrayPrototype, 'set', (original, receiver, args) => {
  const source: unknown = args[0];
  const reading = source instanceof Uint8Array ? buffers.get(source.buffer) : undefined;
  if (reading && receiver instanceof Uint8Array && source instanceof Uint8Array) {
    buffers.set(receiver.buffer, reading);
    for (const ledger of active.getStore() ?? []) {
      ledger.observation.responseByteVisits += source.byteLength;
      retain(ledger, receiver.buffer, receiver.buffer.byteLength);
    }
    const result: unknown = Reflect.apply(original, receiver, args);
    for (const ledger of active.getStore() ?? []) {
      const old = reading.owned.get(ledger);
      if (old !== receiver.buffer) release(ledger, old);
      reading.owned.set(ledger, receiver.buffer);
    }
    return result;
  }
  return Reflect.apply(original, receiver, args);
});
instrument(TextDecoder.prototype, 'decode', (original, receiver, args) => {
  const input: unknown = args[0];
  if (input instanceof Uint8Array && buffers.has(input.buffer)) visits(input.byteLength);
  return Reflect.apply(original, receiver, args);
});
for (const method of ['json', 'text', 'arrayBuffer', 'bytes']) {
  instrument(NativeResponse.prototype, method, async (original, receiver, args) => {
    const body = bodies.get(receiver as Response);
    // Native JSON consumes bytes once for decoding and once for parsing.
    if (body) visits(body.bytes * (method === 'json' ? 2 : 1));
    try {
      const result: unknown = await Reflect.apply(original, receiver, args);
      if (body && (result instanceof ArrayBuffer || result instanceof Uint8Array)) {
        const buffer = result instanceof ArrayBuffer ? result : result.buffer;
        for (const ledger of active.getStore() ?? []) retain(ledger, buffer, buffer.byteLength);
      }
      return result;
    } finally {
      if (body) {
        for (const ledger of active.getStore() ?? []) release(ledger, body.store);
        bodies.delete(receiver as Response);
      }
    }
  });
}
function databaseCall(original: Function, receiver: unknown, args: unknown[]) {
  for (const ledger of active.getStore() ?? []) ledger.observation.databaseCalls++;
  return Reflect.apply(original, receiver, args);
}
const statements = new WeakSet<object>();
for (const method of ['query', 'prepare']) {
  instrument(Database.prototype, method, (original, receiver, args) => {
    const statement: object = databaseCall(original, receiver, args);
    // Bun installs native execution methods on each prepared Statement instance.
    if (!statements.has(statement)) {
      statements.add(statement);
      for (const name of ['all', 'get', 'run', 'values', 'iterate']) instrument(statement, name, databaseCall);
    }
    return statement;
  });
}
for (const method of ['exec', 'run', 'loadExtension']) instrument(Database.prototype, method, databaseCall);

export async function observe<T>(operation: () => Promise<T>): Promise<{ value: T; observation: Observation }> {
  const ledger: Ledger = {
    observation: { responseByteVisits: 0, peakResponseBackingBytes: 0, databaseCalls: 0 },
    live: new Map(),
    retained: 0,
  };
  return active.run([...(active.getStore() ?? []), ledger], async () => {
    try {
      return { value: await operation(), observation: ledger.observation };
    } finally {
      ledger.live.clear();
    }
  });
}
