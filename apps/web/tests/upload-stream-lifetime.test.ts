import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mediaRequest } from '../src/media/index.ts';

type Reservation = { byteCount: number; sha256: string | null };
type Put = (key: string, value: ReadableStream<Uint8Array>, options?: R2PutOptions) => unknown;
type Completion = {
  id: string;
  authorization: string | null;
  containerId: string;
  reservationRequestId: string;
  byteCount: number;
  sha256: string;
};

const reservations = new Map<string, Reservation>();
const completions: Completion[] = [];
let nextId = 0;
const kernel = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const match = /^\/v1\/media\/([^/:]+)(:complete)?$/.exec(new URL(request.url).pathname);
    const id = match?.[1];
    const reservation = id === undefined ? undefined : reservations.get(id);
    if (!match || !id || !reservation) return Response.json({ code: 'not_found' }, { status: 404 });
    if (match[2]) {
      const input = (await request.json()) as Omit<Completion, 'id' | 'authorization'>;
      completions.push({
        id,
        authorization: request.headers.get('authorization'),
        containerId: input.containerId,
        reservationRequestId: input.reservationRequestId,
        byteCount: input.byteCount,
        sha256: input.sha256,
      });
      return Response.json({ media: { id, state: 'uploaded' } });
    }
    return Response.json({
      media: {
        id,
        state: 'reserved',
        byteCount: reservation.byteCount,
        mediaType: 'image/png',
        sha256: reservation.sha256,
        containerId: 'container',
        uploaderId: 'person',
        key: `media/${id}`,
        reservationRequestId: `request-${id}`,
      },
    });
  },
});
afterAll(() => kernel.stop(true));

let digestFault: 'write' | 'close' | null = null;

class TestFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > length) throw new TypeError('the stream is longer than its declared length');
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== length) throw new TypeError('the stream is shorter than its declared length');
      },
    });
  }
}

class TestDigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;

  constructor(algorithm: string) {
    const hash = createHash(algorithm.replace('-', '').toLowerCase());
    let resolve!: (value: ArrayBuffer) => void;
    let reject!: (reason?: unknown) => void;
    let settled = false;
    const digest = new Promise<ArrayBuffer>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const failDigest = (reason: unknown) => {
      if (!settled) {
        settled = true;
        reject(reason);
      }
    };
    super({
      write(chunk) {
        if (digestFault === 'write') {
          const error = new Error('injected digest write failure');
          failDigest(error);
          throw error;
        }
        hash.update(chunk);
      },
      close() {
        if (digestFault === 'close') {
          const error = new Error('injected digest close failure');
          failDigest(error);
          throw error;
        }
        const bytes = hash.digest();
        settled = true;
        resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      },
      abort(reason) {
        failDigest(reason);
      },
    });
    this.digest = digest;
  }
}

const originalFixedLength = Object.getOwnPropertyDescriptor(globalThis, 'FixedLengthStream');
const originalDigest = Object.getOwnPropertyDescriptor(crypto, 'DigestStream');
Object.defineProperty(globalThis, 'FixedLengthStream', {
  value: TestFixedLengthStream,
  configurable: true,
});
Object.defineProperty(crypto, 'DigestStream', { value: TestDigestStream, configurable: true });
afterAll(() => {
  if (originalFixedLength) Object.defineProperty(globalThis, 'FixedLengthStream', originalFixedLength);
  else Reflect.deleteProperty(globalThis, 'FixedLengthStream');
  if (originalDigest) Object.defineProperty(crypto, 'DigestStream', originalDigest);
  else Reflect.deleteProperty(crypto, 'DigestStream');
});

beforeEach(() => {
  digestFault = null;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const failureWitnessMs = 2_000;
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const witness = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`upload did not settle within ${failureWitnessMs}ms`)), failureWitnessMs);
  });
  try {
    return await Promise.race([promise, witness]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function reservation(byteCount: number, sha256: string | null = null): string {
  const id = `lifetime-${++nextId}`;
  reservations.set(id, { byteCount, sha256 });
  return id;
}

function requestFor(id: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Request {
  return new Request(`http://site.test/media/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'image/png', authorization: 'Bearer user:person' },
    body,
    ...(signal === undefined ? {} : { signal }),
    duplex: 'half',
  } as RequestInit);
}

function bytesStream(chunks: Uint8Array[], cancel?: (reason: unknown) => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel(reason) {
        cancel?.(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

function errorStream(cancel?: (reason: unknown) => void): ReadableStream<Uint8Array> {
  let first = true;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(new Uint8Array([1, 2]));
        } else controller.error(new Error('injected upstream failure'));
      },
      cancel(reason) {
        cancel?.(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

function openStream(cancel?: (reason: unknown) => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel(reason) {
        cancel?.(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

async function consume(value: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      chunks.push(item.value);
      length += item.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bucket(put: Put, remove: (key: string) => unknown = () => undefined) {
  const calls = { puts: 0, deletes: 0 };
  const value = {
    put(key: string, stream: ReadableStream<Uint8Array>, options?: R2PutOptions) {
      calls.puts += 1;
      return put(key, stream, options);
    },
    async delete(key: string) {
      calls.deletes += 1;
      await remove(key);
    },
  };
  return { value: value as unknown as R2Bucket, calls };
}

function uploadResponse(id: string, body: ReadableStream<Uint8Array>, storage: R2Bucket, signal?: AbortSignal) {
  const request = requestFor(id, body, signal);
  return bounded(mediaRequest(request, { KERNEL_ORIGIN: kernel.url.origin, MEDIA: storage }));
}

test('streams one exact measured body, completes once with its digest, and does not delete it', async () => {
  const bytes = new Uint8Array([3, 1, 4, 1, 5, 9]);
  const digest = sha256(bytes);
  const id = reservation(bytes.byteLength, digest);
  const completedBefore = completions.length;
  let stored = new Uint8Array();
  const storage = bucket(async (key, stream, options) => {
    expect(key).toBe(`media/${id}`);
    expect(options?.httpMetadata?.contentType).toBe('image/png');
    stored = await consume(stream);
    return { key };
  });

  const response = await uploadResponse(id, bytesStream([bytes]), storage.value);

  expect(response.status).toBe(200);
  expect(stored).toEqual(bytes);
  expect(storage.calls).toEqual({ puts: 1, deletes: 0 });
  expect(completions.slice(completedBefore)).toEqual([
    {
      id,
      authorization: 'Bearer user:person',
      containerId: 'container',
      reservationRequestId: `request-${id}`,
      byteCount: bytes.byteLength,
      sha256: digest,
    },
  ]);
});

test('short, oversized, and errored sources fail once and clean up their single attempted write', async () => {
  const cases = [
    { label: 'short', expected: 400, body: () => bytesStream([new Uint8Array([1, 2])]) },
    { label: 'oversized', expected: 413, body: () => bytesStream([new Uint8Array([1, 2, 3, 4, 5])]) },
    { label: 'source error', expected: 400, body: () => errorStream() },
  ] as const;
  const completedBefore = completions.length;

  for (const scenario of cases) {
    const id = reservation(4);
    const storage = bucket(async (key, stream) => {
      await consume(stream);
      return { key };
    });
    const response = await uploadResponse(id, scenario.body(), storage.value);
    expect(response.status, scenario.label).toBe(scenario.expected);
    expect(storage.calls, scenario.label).toEqual({ puts: 1, deletes: 1 });
  }

  expect(completions).toHaveLength(completedBefore);
});

test('digest write and close failures terminate storage, preserve dependency status, and never complete', async () => {
  const completedBefore = completions.length;
  for (const fault of ['write', 'close'] as const) {
    digestFault = fault;
    const id = reservation(4);
    const storage = bucket(async (key, stream) => {
      await consume(stream);
      return { key };
    });
    const response = await uploadResponse(id, bytesStream([new Uint8Array([1, 2, 3, 4])]), storage.value);
    expect(response.status, fault).toBe(502);
    expect(storage.calls, fault).toEqual({ puts: 1, deletes: 1 });
  }
  expect(completions).toHaveLength(completedBefore);
});

test('synchronous and asynchronous storage failures without a reader cancel the source and are observed', async () => {
  const completedBefore = completions.length;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const mode of ['sync', 'async'] as const) {
      const cancelled = deferred();
      const id = reservation(1024);
      const storage = bucket(() => {
        if (mode === 'sync') throw new Error('injected synchronous storage failure');
        return Promise.reject(new Error('injected asynchronous storage failure'));
      });
      const response = await uploadResponse(
        id,
        openStream(() => cancelled.resolve()),
        storage.value,
      );
      expect(response.status, mode).toBe(502);
      expect(storage.calls, mode).toEqual({ puts: 1, deletes: 1 });
      await bounded(cancelled.promise);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  expect(unhandled).toEqual([]);
  expect(completions).toHaveLength(completedBefore);
});

test('waits for a late storage rejection to settle before deleting failed bytes', async () => {
  const started = deferred();
  let rejectStorage!: (reason: unknown) => void;
  let storageSettled = false;
  let deleteSawSettledStorage = false;
  const id = reservation(8);
  const storage = bucket(
    () => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        rejectStorage = (reason) => {
          storageSettled = true;
          reject(reason);
        };
      });
    },
    () => {
      deleteSawSettledStorage = storageSettled;
    },
  );
  const responsePromise = uploadResponse(
    id,
    bytesStream([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])]),
    storage.value,
  );

  await bounded(started.promise);
  await Promise.resolve();
  expect(storage.calls.deletes).toBe(0);
  rejectStorage(new Error('injected late storage failure'));
  const response = await responsePromise;

  expect(response.status).toBe(502);
  expect(deleteSawSettledStorage).toBe(true);
  expect(storage.calls).toEqual({ puts: 1, deletes: 1 });
});

test('an already-aborted request never starts a put or cleanup delete', async () => {
  const controller = new AbortController();
  controller.abort();
  const id = reservation(4);
  const storage = bucket(async (key, stream) => {
    await consume(stream);
    return { key };
  });
  const completedBefore = completions.length;

  const response = await uploadResponse(
    id,
    bytesStream([new Uint8Array([1, 2, 3, 4])]),
    storage.value,
    controller.signal,
  );

  expect(response.status).toBe(502);
  expect(storage.calls).toEqual({ puts: 0, deletes: 0 });
  expect(completions).toHaveLength(completedBefore);
});

test('an abort under storage backpressure cancels the source and joins storage before cleanup', async () => {
  const controller = new AbortController();
  const firstRead = deferred();
  const allowNextRead = deferred();
  const cancelled = deferred();
  let storageSettled = false;
  let deleteSawSettledStorage = false;
  const id = reservation(12);
  const storage = bucket(
    async (_key, stream) => {
      const reader = stream.getReader();
      try {
        await reader.read();
        firstRead.resolve();
        await allowNextRead.promise;
        for (;;) {
          const item = await reader.read();
          if (item.done) return { key: `media/${id}` };
        }
      } catch (error) {
        storageSettled = true;
        throw error;
      } finally {
        reader.releaseLock();
      }
    },
    () => {
      deleteSawSettledStorage = storageSettled;
    },
  );
  const responsePromise = uploadResponse(
    id,
    bytesStream([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8]), new Uint8Array([9, 10, 11, 12])], () =>
      cancelled.resolve(),
    ),
    storage.value,
    controller.signal,
  );

  await bounded(firstRead.promise);
  controller.abort();
  await bounded(cancelled.promise);
  expect(storage.calls.deletes).toBe(0);
  allowNextRead.resolve();
  const response = await responsePromise;

  expect(response.status).toBe(502);
  expect(deleteSawSettledStorage).toBe(true);
  expect(storage.calls).toEqual({ puts: 1, deletes: 1 });
  expect(completions.some((completion) => completion.id === id)).toBe(false);
});
