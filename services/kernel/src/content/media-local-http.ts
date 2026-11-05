import { timingSafeEqual } from 'node:crypto';
import { LocalMediaStorage, LOCAL_MEDIA_ROOT, LOCAL_MEDIA_MAX_OBJECT_BYTES } from './local-media.ts';

const path = '/_local/media/';
const keyPattern =
  /^m\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(original|(?:avif|webp)-(?:[1-9][0-9]{0,1}|[12][0-9]{2}|3[01][0-9]|320|640|960|1280|1920|2560))$/;

/** Private object transport for the supported local composition; never mounted by the production Kernel. */
export function developmentMediaHandler(token: string) {
  const storage = new LocalMediaStorage({ root: LOCAL_MEDIA_ROOT, maxObjectBytes: LOCAL_MEDIA_MAX_OBJECT_BYTES });
  const expected = Buffer.from(token);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const supplied = Buffer.from(request.headers.get('x-local-media-key') ?? '');
    if (url.hostname !== '127.0.0.1' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return new Response(null, { status: 404 });
    const key = url.pathname.slice(path.length);
    if (!url.pathname.startsWith(path) || !keyPattern.test(key)) return new Response(null, { status: 404 });
    const original = key.endsWith('/original');
    if (request.method === 'PUT' && original) {
      const reader = request.body?.getReader();
      if (!reader) return new Response(null, { status: 400 });
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          length += item.value.byteLength;
          if (length > LOCAL_MEDIA_MAX_OBJECT_BYTES) {
            await reader.cancel();
            return new Response(null, { status: 413 });
          }
          chunks.push(item.value);
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
      await storage.put(key, bytes, { mediaType: request.headers.get('content-type') ?? 'application/octet-stream' });
      return new Response(null, { status: 204 });
    }
    if (request.method === 'DELETE' && original) {
      await storage.delete(key);
      return new Response(null, { status: 204 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405, headers: { allow: original ? 'GET, HEAD, PUT, DELETE' : 'GET, HEAD' } });
    const bytes = await storage.get(key);
    if (bytes === null) return new Response(null, { status: 404 });
    let body = bytes;
    const headers = new Headers({ 'cache-control': 'no-store', 'content-length': String(bytes.byteLength) });
    const range = request.headers.get('range');
    if (range !== null && request.method === 'GET') {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match || BigInt(match[1]!) >= BigInt(bytes.byteLength) || BigInt(match[2]!) < BigInt(match[1]!))
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.byteLength}` } });
      const start = Number(match[1]);
      const end = Number(
        BigInt(match[2]!) < BigInt(bytes.byteLength) ? BigInt(match[2]!) : BigInt(bytes.byteLength - 1),
      );
      body = bytes.slice(start, end + 1);
      headers.set('content-length', String(body.byteLength));
      headers.set('content-range', `bytes ${start}-${end}/${bytes.byteLength}`);
    }
    return new Response(request.method === 'HEAD' ? null : body, { status: body === bytes ? 200 : 206, headers });
  };
}
