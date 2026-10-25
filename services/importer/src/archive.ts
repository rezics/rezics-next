/** Decompressed POSIX ustar only. Compression and table policy belong to callers. */
export interface ArchiveOptions {
  maxTotalBytes: number;
  maxChunkBytes: number;
  maxMetadataBytes: number;
  signal?: AbortSignal;
  onProgress: (sample: { retainedBytes: number; visitedBytes: number }) => void;
}
export interface ArchiveEntry {
  path: string;
  kind: 'file' | 'directory';
  declaredBytes: number;
  bytes: AsyncIterableIterator<Uint8Array>;
}

function check(value: unknown, message = 'Invalid ustar archive'): asserts value {
  if (!value) throw new Error(message);
}

/** A single cursor owns input, framing and the currently active member. No prefetch. */
class Cursor {
  private readonly upstream: AsyncIterator<Uint8Array>;
  private chunk: Uint8Array | undefined;
  private offset = 0;
  private header: Uint8Array | undefined;
  private metadata: Uint8Array | undefined;
  private output: Uint8Array | undefined;
  private supplied = 0;
  private visited = 0;
  private closed = false;
  private failure: unknown;
  private failed = false;
  private remaining = 0;
  private padding = 0;
  private member = 0;
  private cancelRead: ((error: unknown) => void) | undefined;
  private pending = Promise.resolve();

  constructor(
    input: AsyncIterable<Uint8Array>,
    private readonly options: ArchiveOptions,
  ) {
    this.upstream = input[Symbol.asyncIterator]();
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }

  private abort = () => {
    // Event listeners must not throw into the host. The pending read delivers
    // the same failure to a pending next(), or live() to the next operation.
    try {
      this.fail(this.options.signal?.reason ?? new Error('Archive aborted'));
    } catch {
      /* Delivered through the iterator. */
    }
  };

  private progress() {
    // Count distinct live backing allocations, including offset input views.
    const stores = new Set<ArrayBufferLike>();
    for (const view of [this.chunk, this.header, this.metadata, this.output]) {
      if (view) stores.add(view.buffer);
    }
    this.options.onProgress({
      retainedBytes: [...stores].reduce((sum, buffer) => sum + buffer.byteLength, 0),
      visitedBytes: this.visited,
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelRead?.(new Error('Archive iterator is closed'));
    this.cancelRead = undefined;
    this.options.signal?.removeEventListener('abort', this.abort);
    this.chunk = this.header = this.metadata = this.output = undefined;
    // Invoke return immediately, even when next is pending. An upstream async
    // generator may queue return behind next, so cancellation must not await it.
    try {
      void Promise.resolve(this.upstream.return?.()).catch(() => {});
    } catch {
      /* Preserve the primary failure. */
    }
    this.progress();
  }

  fail(error: unknown): never {
    if (!this.failed) {
      this.failed = true;
      this.failure = error;
      this.cancelRead?.(error);
      this.cancelRead = undefined;
      this.close();
    }
    throw this.failure;
  }

  private live() {
    if (this.failed) throw this.failure;
    if (this.options.signal?.aborted) {
      this.abort();
      throw this.failure;
    }
    check(!this.closed, 'Archive iterator is closed');
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async start() {
    this.live();
    for (const limit of [this.options.maxTotalBytes, this.options.maxChunkBytes, this.options.maxMetadataBytes]) {
      check(Number.isSafeInteger(limit) && limit > 0, 'Invalid archive limit');
    }
    this.header = new Uint8Array(512);
    this.progress();
  }

  private async available(): Promise<boolean> {
    this.live();
    if (this.chunk && this.offset < this.chunk.length) return true;
    this.chunk = undefined;
    this.progress();
    for (;;) {
      // One disposable cancellation slot. Racing every pull against a shared
      // unresolved promise would accumulate reactions for the entire archive.
      const result = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
        this.cancelRead = reject;
        try {
          void Promise.resolve(this.upstream.next()).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      });
      this.cancelRead = undefined;
      this.live();
      if (result.done) return false;
      const chunk = result.value;
      check(chunk instanceof Uint8Array, 'Archive chunks must be bytes');
      // Check the backing allocation BEFORE copying, decoding or retaining it.
      check(chunk.buffer.byteLength <= this.options.maxChunkBytes, 'Archive chunk backing allocation exceeds limit');
      this.supplied += chunk.length;
      check(
        Number.isSafeInteger(this.supplied) && this.supplied <= this.options.maxTotalBytes,
        'Archive byte limit exceeded',
      );
      if (!chunk.length) continue;
      this.chunk = chunk;
      this.offset = 0;
      this.progress();
      return true;
    }
  }

  private async block() {
    this.header ??= new Uint8Array(512);
    this.progress();
    for (let used = 0; used < 512;) {
      check(await this.available(), 'Truncated archive header or terminator');
      const length = Math.min(512 - used, this.chunk!.length - this.offset);
      this.header.set(new Uint8Array(this.chunk!.buffer, this.chunk!.byteOffset + this.offset, length), used);
      this.visited += length; // Actual header copy.
      this.offset += length;
      used += length;
      this.progress();
    }
    let sum = 0;
    let nonzero = false;
    for (let i = 0; i < 512; i++) {
      const byte = this.header[i]!;
      this.visited++;
      nonzero ||= byte !== 0;
      sum += i >= 148 && i < 156 ? 32 : byte;
    }
    this.progress();
    return { zero: !nonzero, sum };
  }

  private byte(index: number) {
    this.visited++;
    return this.header![index]!;
  }

  private octal(start: number, length: number) {
    let number = 0;
    let digits = 0;
    let ended = false;
    for (let i = start; i < start + length; i++) {
      const byte = this.byte(i);
      if (byte === 0 || byte === 32) {
        if (byte === 0 || digits) ended = true;
      } else {
        check(!ended && byte >= 48 && byte <= 55, 'Invalid ustar octal field');
        number = number * 8 + byte - 48;
        check(Number.isSafeInteger(number), 'Overflowing ustar field');
        digits++;
      }
    }
    check(digits > 0, 'Empty ustar octal field');
    return number;
  }

  private fieldLength(start: number, length: number) {
    let end = length;
    for (let i = 0; i < length; i++) {
      if (this.byte(start + i) === 0) {
        end = i;
        break;
      }
    }
    // A NUL ends the field; hidden suffix bytes are never allowed.
    for (let i = end; i < length; i++) check(this.byte(start + i) === 0, 'Invalid ustar name suffix');
    return end;
  }

  private path(directory: boolean) {
    const name = this.fieldLength(0, 100);
    const prefix = this.fieldLength(345, 155);
    const length = name + prefix + (prefix ? 1 : 0);
    check(name && length <= this.options.maxMetadataBytes, 'Archive path metadata exceeds limit');
    this.metadata = new Uint8Array(length);
    this.metadata.set(this.header!.subarray(345, 345 + prefix));
    if (prefix) this.metadata[prefix] = 47;
    this.metadata.set(this.header!.subarray(0, name), prefix + (prefix ? 1 : 0));
    this.visited += name + prefix;
    this.progress();
    // Fatal decoding rejects overlong UTF8, surrogates and invalid bytes.
    const path = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.metadata);
    this.visited += length;
    check(!/[\\:%\x00-\x1f\x7f-\x9f]/u.test(path), 'Unsafe archive path');
    const parts = path.split('/');
    if (directory && parts.at(-1) === '') parts.pop();
    check(parts.length > 0 && parts.every((part) => part && part !== '.' && part !== '..'), 'Unsafe archive path');
    this.progress();
    return path;
  }

  async nextEntry(): Promise<ArchiveEntry | undefined> {
    this.output = undefined;
    await this.drain(this.member);
    this.output = undefined;
    this.metadata = undefined;
    const framing = await this.block();
    if (framing.zero) {
      check((await this.block()).zero, 'Missing second zero terminator');
      // EOF, including arbitrary zero-only record padding, is part of validation.
      while (await this.available()) {
        while (this.offset < this.chunk!.length) {
          this.visited++;
          check(this.chunk![this.offset++] === 0, 'Nonzero archive trailer');
        }
        this.progress();
      }
      this.close();
      return;
    }
    check(this.octal(148, 8) === framing.sum, 'Invalid ustar checksum');
    for (const [index, expected] of [
      [257, 117],
      [258, 115],
      [259, 116],
      [260, 97],
      [261, 114],
      [262, 0],
      [263, 48],
      [264, 48],
    ]) {
      check(this.byte(index!) === expected, 'Invalid ustar magic or version');
    }
    const type = this.byte(156);
    check(![120, 103, 76, 75].includes(type), 'Unsupported PAX or GNU extension');
    check(type === 0 || type === 48 || type === 53, 'Unsupported ustar entry type');
    const size = this.octal(124, 12);
    // Validate the native numeric fields too; binary/GNU numbers are unsupported.
    for (const [start, length] of [
      [100, 8],
      [108, 8],
      [116, 8],
      [136, 12],
    ])
      this.octal(start!, length!);
    check(
      size <= this.options.maxTotalBytes - this.supplied + (this.chunk!.length - this.offset),
      'Archive member exceeds byte limit',
    );
    const directory = type === 53;
    check(!directory || size === 0, 'Directory has payload');
    const path = this.path(directory);
    // Framing and yielded payload never need their 512-byte buffers together.
    this.header = undefined;
    this.remaining = size;
    this.padding = (512 - (size % 512)) % 512;
    const member = ++this.member;
    const cursor = this;
    let cancelled = false;
    const bytes: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        return cursor.run(async () => {
          if (cursor.failed) throw cursor.failure;
          if (cancelled || member !== cursor.member || cursor.closed) return { done: true, value: undefined };
          try {
            const value = await cursor.payload(member);
            return value ? { done: false, value } : { done: true, value: undefined };
          } catch (error) {
            return cursor.fail(error);
          }
        });
      },
      return() {
        return cursor.run(async () => {
          cancelled = true;
          if (cursor.closed) return { done: true, value: undefined };
          try {
            await cursor.drain(member);
          } catch (error) {
            return cursor.fail(error);
          }
          return { done: true, value: undefined };
        });
      },
    };
    this.progress();
    return { path, kind: directory ? 'directory' : 'file', declaredBytes: size, bytes };
  }

  private async payload(member: number): Promise<Uint8Array | undefined> {
    this.output = undefined;
    this.live();
    if (member !== this.member) return;
    if (!this.remaining) return;
    check(await this.available(), 'Truncated archive payload');
    const length = Math.min(this.remaining, this.chunk!.length - this.offset, 512);
    // Copy only the requested bounded piece. Retain it until the next operation,
    // so samples include the allocation even while next() hands it to the caller.
    // Its backing allocation never keeps an upstream chunk alive.
    this.output = new Uint8Array(length);
    this.output.set(new Uint8Array(this.chunk!.buffer, this.chunk!.byteOffset + this.offset, length));
    this.visited += length;
    this.offset += length;
    this.remaining -= length;
    this.progress();
    return this.output;
  }

  private async drain(member: number) {
    if (member !== this.member) return;
    while (this.remaining) await this.payload(member);
    while (this.padding) {
      check(await this.available(), 'Truncated archive padding');
      const length = Math.min(this.padding, this.chunk!.length - this.offset);
      for (let i = 0; i < length; i++) {
        this.visited++;
        check(this.chunk![this.offset++] === 0, 'Nonzero archive padding');
      }
      this.padding -= length;
      this.progress();
    }
  }
}

export function readArchive(
  input: AsyncIterable<Uint8Array>,
  options: ArchiveOptions,
): AsyncIterableIterator<ArchiveEntry> {
  const cursor = new Cursor(input, options);
  let started = false;
  let done = false;
  // Serialize cursor operations. Returning closes input synchronously rather than
  // being queued behind a generator's pending next().
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      return cursor.run(async (): Promise<IteratorResult<ArchiveEntry>> => {
        if (done) return { done: true, value: undefined };
        try {
          if (!started) {
            started = true;
            await cursor.start();
          }
          const value = await cursor.nextEntry();
          if (value) return { done: false, value };
          done = true;
          return { done: true, value: undefined };
        } catch (error) {
          done = true;
          return cursor.fail(error);
        }
      });
    },
    async return() {
      done = true;
      cursor.close();
      return { done: true, value: undefined };
    },
  };
}
