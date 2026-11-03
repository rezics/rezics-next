import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { DEFAULT_DUMP_CHUNK_BYTES, DEFAULT_DUMP_RECORD_BYTES, MAX_DUMP_CHUNK_BYTES } from './dumps-bytes.ts';

/** Bounded dump/path failure shared by import and offline preview. */
export class DumpInputError extends Error {}

export type DumpInputObserver = {
  onInputPass?(kind: 'dump' | 'vndb-entries'): void;
  onInputChunk?(kind: 'dump' | 'vndb-entries', bytes: number, backingBytes: number): void;
};

export type DumpByteProgress = {
  add(counter: 'inputBytes', amount?: number): void;
};

export type RawVndbEntry = {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'hardlink';
  declaredBytes: number;
  bytes: AsyncIterable<Uint8Array>;
  linkTarget?: string;
};

export function throwIfAborted(signal: AbortSignal, message = 'Import interrupted'): void {
  if (signal.aborted) throw signal.reason ?? new DOMException(message, 'AbortError');
}

export async function inputWithSignal<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', aborted);
    const aborted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException('Import interrupted', 'AbortError'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve()
      .then(() => {
        throwIfAborted(signal);
        return operation();
      })
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
  });
}

export async function closeInput<T>(iterator: AsyncIterator<T>, signal: AbortSignal, localFile = false): Promise<void> {
  try {
    // The owning finally requests cleanup exactly once. Source cleanup may be
    // queued behind a pending next(), or reject after this invocation finishes.
    const closing = Promise.resolve(iterator.return?.());
    void closing.catch(() => {});
    if (localFile) await closing;
    else if (!signal.aborted) await inputWithSignal(() => closing, signal);
  } catch {
    // Preserve the original parser, staging or cancellation failure.
  }
}

export async function openDump(path: string, handleCount: { value: number }): Promise<FileHandle | undefined> {
  if (path === '-') return undefined;
  return openRegularFile(path, handleCount, constants.O_RDONLY | constants.O_NONBLOCK);
}

/** Regular-file open that refuses symlinks, directories and devices. */
export async function openRegularFile(
  path: string,
  handleCount: { value: number },
  flags: number = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch {
    throw new DumpInputError();
  }
  handleCount.value++;
  try {
    if (!(await handle.stat()).isFile()) throw new DumpInputError();
    return handle;
  } catch (error) {
    try {
      await handle.close();
    } finally {
      handleCount.value--;
    }
    if (error instanceof DumpInputError) throw error;
    throw new DumpInputError();
  }
}

export async function* fileChunks(handle: FileHandle, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let position = 0;
  for (;;) {
    throwIfAborted(signal);
    const buffer = new Uint8Array(DEFAULT_DUMP_CHUNK_BYTES);
    let result: { bytesRead: number };
    try {
      result = await handle.read(buffer, 0, buffer.byteLength, position);
    } catch {
      throw new DumpInputError();
    }
    throwIfAborted(signal);
    if (!result.bytesRead) return;
    position += result.bytesRead;
    yield buffer.subarray(0, result.bytesRead);
  }
}

export async function* ownedChunks(
  input: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  kind: 'dump',
  observer: DumpInputObserver | undefined,
  localFile = false,
  progress?: DumpByteProgress,
): AsyncGenerator<Uint8Array> {
  observer?.onInputPass?.(kind);
  const iterator = input[Symbol.asyncIterator]();
  let ended = false;
  try {
    for (;;) {
      // Owned descriptor reads settle before the descriptor is closed. Only
      // source-controlled operations may be left pending after cancellation.
      const next = localFile ? await iterator.next() : await inputWithSignal(() => iterator.next(), signal);
      if (next.done) {
        ended = true;
        return;
      }
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array) || chunk.buffer.byteLength > MAX_DUMP_CHUNK_BYTES) throw new DumpInputError();
      if (!chunk.byteLength) continue;
      for (let offset = 0; offset < chunk.byteLength; offset += DEFAULT_DUMP_CHUNK_BYTES) {
        const size = Math.min(DEFAULT_DUMP_CHUNK_BYTES, chunk.byteLength - offset);
        const owned = new Uint8Array(size);
        owned.set(chunk.subarray(offset, offset + size));
        observer?.onInputChunk?.(kind, size, owned.buffer.byteLength);
        progress?.add('inputBytes', size);
        yield owned;
      }
    }
  } finally {
    if (!ended) await closeInput(iterator, signal, localFile);
  }
}

/** Carry Open Library's native TSV modification date into its JSON record. */
export async function* openLibraryMetadata(
  input: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lineLimit = DEFAULT_DUMP_RECORD_BYTES + 1;
  let line = new Uint8Array(0);
  let length = 0;

  const append = (bytes: Uint8Array) => {
    const required = length + bytes.byteLength;
    if (required > lineLimit) throw new DumpInputError();
    if (required > line.byteLength) {
      const capacity = Math.min(lineLimit, Math.max(required, line.byteLength ? line.byteLength * 2 : 64));
      const next = new Uint8Array(capacity);
      next.set(line.subarray(0, length));
      line = next;
    }
    line.set(bytes, length);
    length = required;
  };

  const metadataLine = (raw: Uint8Array): Uint8Array => {
    let text: string;
    try {
      text = decoder.decode(raw);
    } catch {
      return raw;
    }
    const first = text.indexOf('\t');
    const second = first < 0 ? -1 : text.indexOf('\t', first + 1);
    const third = second < 0 ? -1 : text.indexOf('\t', second + 1);
    const fourth = third < 0 ? -1 : text.indexOf('\t', third + 1);
    if (first < 0 || second < 0 || third < 0 || fourth < 0 || text.indexOf('\t', fourth + 1) >= 0) return raw;
    const date = text.slice(third + 1, fourth);
    const stamp = /^\d{4}-\d{2}-\d{2}$/u.test(date)
      ? `${date}T00:00:00Z`
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z?$/u.test(date)
        ? date
        : undefined;
    if (!stamp) return raw;
    const json = text.slice(fourth + 1);
    let payload: unknown;
    try {
      payload = JSON.parse(json);
    } catch {
      return raw;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.hasOwn(payload, 'last_modified'))
      return raw;
    let close = json.length - 1;
    while (close >= 0 && /\s/u.test(json[close]!)) close--;
    if (json[close] !== '}') return raw;
    const addition = `,"last_modified":{"type":"/type/datetime","value":${JSON.stringify(stamp)}}`;
    return encoder.encode(`${text.slice(0, fourth + 1)}${json.slice(0, close)}${addition}${json.slice(close)}`);
  };

  const emit = async function* (raw: Uint8Array): AsyncGenerator<Uint8Array> {
    const transformed = metadataLine(raw);
    for (let offset = 0; offset < transformed.byteLength; offset += DEFAULT_DUMP_CHUNK_BYTES) {
      throwIfAborted(signal);
      const size = Math.min(DEFAULT_DUMP_CHUNK_BYTES, transformed.byteLength - offset);
      const chunk = new Uint8Array(size);
      chunk.set(transformed.subarray(offset, offset + size));
      yield chunk;
    }
  };

  try {
    for await (const chunk of input) {
      throwIfAborted(signal);
      let start = 0;
      for (let offset = 0; offset < chunk.byteLength; offset++) {
        if (chunk[offset] !== 10) continue;
        append(chunk.subarray(start, offset));
        yield* emit(line.subarray(0, length));
        const newline = new Uint8Array([10]);
        yield newline;
        length = 0;
        start = offset + 1;
      }
      append(chunk.subarray(start));
    }
    if (length) yield* emit(line.subarray(0, length));
  } finally {
    line = new Uint8Array(0);
    length = 0;
  }
}

export async function* observedEntries(
  input: AsyncIterable<RawVndbEntry>,
  signal: AbortSignal,
  observer: DumpInputObserver | undefined,
  progress?: DumpByteProgress,
): AsyncGenerator<RawVndbEntry> {
  observer?.onInputPass?.('vndb-entries');
  const iterator = input[Symbol.asyncIterator]();
  let ended = false;
  try {
    for (;;) {
      const next = await inputWithSignal(() => iterator.next(), signal);
      if (next.done) {
        ended = true;
        return;
      }
      const entry = next.value;
      const byteIterator = entry.bytes[Symbol.asyncIterator]();
      const bytes = (async function* (): AsyncGenerator<Uint8Array> {
        let byteEnded = false;
        try {
          for (;;) {
            const item = await inputWithSignal(() => byteIterator.next(), signal);
            if (item.done) {
              byteEnded = true;
              return;
            }
            const chunk = item.value;
            if (!(chunk instanceof Uint8Array)) throw new DumpInputError();
            observer?.onInputChunk?.('vndb-entries', chunk.byteLength, chunk.buffer.byteLength);
            progress?.add('inputBytes', chunk.byteLength);
            yield chunk;
          }
        } finally {
          if (!byteEnded) await closeInput(byteIterator, signal);
        }
      })();
      yield { ...entry, bytes };
    }
  } finally {
    if (!ended) await closeInput(iterator, signal);
  }
}
