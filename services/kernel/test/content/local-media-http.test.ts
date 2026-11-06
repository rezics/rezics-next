import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { developmentMediaHandler } from '../../src/content/media-local-http.ts';
import { LocalMediaStorage, LOCAL_MEDIA_ROOT, LOCAL_MEDIA_MAX_OBJECT_BYTES } from '../../src/content/local-media.ts';

test('private local object transport shares producer bytes, bounds external uploads, and deletes only the failed original', async () => {
  const token = randomUUID();
  const storage = new LocalMediaStorage({ root: LOCAL_MEDIA_ROOT, maxObjectBytes: LOCAL_MEDIA_MAX_OBJECT_BYTES });
  const id = randomUUID();
  const key = `m/${id}/original`;
  const derivative = `m/${id}/webp-320`;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: developmentMediaHandler(token) });
  const request = (object: string, options: RequestInit = {}) =>
    fetch(`${server.url}_local/media/${object}`, {
      ...options,
      headers: { 'x-local-media-key': token, ...options.headers },
    });
  try {
    expect((await fetch(`${server.url}_local/media/${key}`)).status).toBe(404);
    expect((await request(`m/${id}/webp-999`)).status).toBe(404);
    expect((await request(key, { method: 'PUT', body: new Uint8Array(LOCAL_MEDIA_MAX_OBJECT_BYTES + 1) })).status).toBe(
      413,
    );
    expect(await storage.get(key)).toBeNull();
    expect((await request(key, { method: 'PUT', body: new Uint8Array([1, 2, 3, 4]) })).status).toBe(204);
    expect(await storage.get(key)).toEqual(new Uint8Array([1, 2, 3, 4]));
    await storage.put(derivative, new Uint8Array([5, 6, 7]), { mediaType: 'image/webp' });
    const head = await request(derivative, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('3');
    const ranged = await request(key, { headers: { range: 'bytes=1-2' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 1-2/4');
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(new Uint8Array([2, 3]));
    expect((await request(key, { headers: { range: 'bytes=100-200' } })).status).toBe(416);
    expect((await request(key, { method: 'DELETE' })).status).toBe(204);
    expect((await request(key)).status).toBe(404);
    expect(new Uint8Array(await (await request(derivative)).arrayBuffer())).toEqual(new Uint8Array([5, 6, 7]));
  } finally {
    await server.stop(true);
    await storage.deletePrefix(`m/${id}/`);
  }
});
