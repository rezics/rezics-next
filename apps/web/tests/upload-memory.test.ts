import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { upload } from '../src/media/upload.ts';

// Workers-only classes, standing in with the behaviour Cloudflare documents for them.
class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
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
class DigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    const hash = createHash(algorithm.replace('-', '').toLowerCase());
    let resolve!: (value: ArrayBuffer) => void;
    let reject!: (reason?: unknown) => void;
    const digest = new Promise<ArrayBuffer>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    super({
      write(chunk) {
        hash.update(chunk);
      },
      close() {
        const bytes = hash.digest();
        resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      },
      abort(reason) {
        reject(reason);
      },
    });
    this.digest = digest;
  }
}
Object.defineProperty(globalThis, 'FixedLengthStream', { value: FixedLengthStream, configurable: true });
Object.defineProperty(globalThis.crypto, 'DigestStream', { value: DigestStream, configurable: true });

const chunk = 64 * 1024;
const MiB = 1024 * 1024;
const pattern = Uint8Array.from({ length: chunk }, (_, index) => (index * 31) % 251);

// The content media API's reservation read and completion, as far as an upload uses them.
const completions: { byteCount: number; sha256: string }[] = [];
const reservations = new Map<string, number>();
const kernel = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const match = /^\/v1\/media\/([^/:]+)(:complete)?$/.exec(new URL(request.url).pathname);
    const byteCount = match ? reservations.get(match[1]!) : undefined;
    if (!match || byteCount === undefined) return Response.json({ code: 'not_found' }, { status: 404 });
    const id = match[1]!;
    if (match[2]) {
      completions.push((await request.json()) as { byteCount: number; sha256: string });
      return Response.json({ media: { id, state: 'uploaded' } });
    }
    return Response.json({
      media: {
        id,
        state: 'reserved',
        byteCount,
        mediaType: 'image/png',
        sha256: null,
        containerId: 'container',
        uploaderId: 'person',
        key: `media/${id}`,
        reservationRequestId: `request-${id}`,
      },
    });
  },
});
afterAll(() => kernel.stop(true));

// Storage that takes the first chunks, then stalls until released, as a slow write to R2 would.
function slowStorage(stallAfter: number) {
  let consumed = 0;
  let release!: () => void;
  const released = new Promise<void>((done) => (release = done));
  const deleted: string[] = [];
  const bucket = {
    async put(key: string, value: ReadableStream<Uint8Array>) {
      const reader = value.getReader();
      for (;;) {
        if (consumed >= stallAfter) await released;
        const { done, value: bytes } = await reader.read();
        if (done) break;
        consumed += bytes.byteLength;
      }
      return { key };
    },
    async delete(key: string) {
      deleted.push(key);
    },
  };
  return { bucket, consumed: () => consumed, release, deleted };
}

// A request body that produces its bytes only when read, counting how many were read.
function body(total: number) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled >= total) return controller.close();
        const size = Math.min(chunk, total - pulled);
        pulled += size;
        controller.enqueue(pattern.slice(0, size));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled };
}

function expectedDigest(total: number): string {
  const hash = createHash('sha256');
  for (let offset = 0; offset < total; offset += chunk)
    hash.update(pattern.subarray(0, Math.min(chunk, total - offset)));
  return hash.digest('hex');
}

async function settle(read: () => number): Promise<number> {
  let last = -1;
  let still = 0;
  while (still < 10) {
    await Bun.sleep(20);
    const now = read();
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return last;
}

test('an upload holds a bounded number of bytes ahead of storage as the file grows', async () => {
  const ahead: Record<string, number> = {};
  for (const size of [1, 8, 64]) {
    const total = size * MiB;
    const id = `upload-${size}`;
    reservations.set(id, total);
    const storage = slowStorage(2 * chunk);
    const source = body(total);
    const request = new Request(`http://site.test/media/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', authorization: 'Bearer user:person' },
      body: source.stream,
      duplex: 'half',
    } as RequestInit);
    const response = upload(request, id, {
      KERNEL_ORIGIN: kernel.url.origin,
      MEDIA: storage.bucket as unknown as R2Bucket,
    });
    // While storage stalls, the Worker may read only a bounded amount beyond what storage has taken.
    const pulled = await settle(source.pulled);
    ahead[`${size} MiB`] = pulled - storage.consumed();
    storage.release();
    expect((await response).status).toBe(200);
    expect(storage.deleted).toEqual([]);
    expect(completions.at(-1)).toMatchObject({ byteCount: total, sha256: expectedDigest(total) });
  }
  for (const [size, bytes] of Object.entries(ahead)) expect(bytes, size).toBeLessThanOrEqual(MiB);
}, 120_000);
