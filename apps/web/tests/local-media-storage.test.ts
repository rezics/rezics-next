import { expect, test } from 'bun:test';
import { localMediaStorage } from '../src/media/storage.ts';

test('local media requests use Worker-compatible methods, headers, bodies and ranges', async () => {
  const originalFetch = globalThis.fetch;
  const transportToken = 'private-test-transport';
  const uploadBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
  const requests: {
    path: string;
    method: string | undefined;
    redirect: RequestRedirect | undefined;
    credentialMatches: boolean;
    range: string | null;
    contentType: string | null;
    uploadBodyMatches: boolean;
  }[] = [];

  globalThis.fetch = (async (input, init = {}) => {
    if (init.redirect !== 'manual') throw new Error('Local media fetch requires manual redirects');
    const headers = new Headers(init.headers);
    requests.push({
      path: new URL(String(input)).pathname,
      method: init.method,
      redirect: init.redirect,
      credentialMatches: headers.get('x-local-media-key') === transportToken,
      range: headers.get('range'),
      contentType: headers.get('content-type'),
      uploadBodyMatches: init.body === uploadBody,
    });
    if (init.method === 'HEAD') return new Response(null, { headers: { 'content-length': '5' } });
    if (init.method === 'GET') {
      const ranged = headers.has('range');
      return new Response(ranged ? 'abc' : 'bytes', {
        status: ranged ? 206 : 200,
        headers: { 'content-length': ranged ? '3' : '5' },
      });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const storage = localMediaStorage({
      LOCAL_MEDIA_ORIGIN: 'http://127.0.0.1:41234',
      LOCAL_MEDIA_TOKEN: transportToken,
    });
    expect(await storage.head('m/native-cover')).toEqual({ size: 5 });
    const full = await storage.get('m/native-cover', {});
    expect(full?.size).toBe(5);
    expect(await new Response(full!.body).text()).toBe('bytes');
    const ranged = await storage.get('m/native-cover', { range: { offset: 2, length: 3 } });
    expect(ranged?.size).toBe(3);
    expect(ranged?.range).toEqual({ length: 3 });
    expect(await new Response(ranged!.body).text()).toBe('abc');
    expect(await storage.put('m/native-cover', uploadBody, { httpMetadata: { contentType: 'image/avif' } })).toEqual(
      {},
    );
    await storage.delete('m/native-cover');
    expect(requests).toEqual([
      {
        path: '/_local/media/m/native-cover',
        method: 'HEAD',
        redirect: 'manual',
        credentialMatches: true,
        range: null,
        contentType: null,
        uploadBodyMatches: false,
      },
      {
        path: '/_local/media/m/native-cover',
        method: 'GET',
        redirect: 'manual',
        credentialMatches: true,
        range: null,
        contentType: null,
        uploadBodyMatches: false,
      },
      {
        path: '/_local/media/m/native-cover',
        method: 'GET',
        redirect: 'manual',
        credentialMatches: true,
        range: 'bytes=2-4',
        contentType: null,
        uploadBodyMatches: false,
      },
      {
        path: '/_local/media/m/native-cover',
        method: 'PUT',
        redirect: 'manual',
        credentialMatches: true,
        range: null,
        contentType: 'image/avif',
        uploadBodyMatches: true,
      },
      {
        path: '/_local/media/m/native-cover',
        method: 'DELETE',
        redirect: 'manual',
        credentialMatches: true,
        range: null,
        contentType: null,
        uploadBodyMatches: false,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('local media does not follow redirects and preserves missing, failure and size-bound responses', async () => {
  const originalFetch = globalThis.fetch;
  const transportToken = 'private-test-transport';
  let requests = 0;
  let credentialMatches = false;
  globalThis.fetch = (async (input, init = {}) => {
    if (init.redirect !== 'manual') throw new Error('Local media fetch requires manual redirects');
    requests++;
    credentialMatches = new Headers(init.headers).get('x-local-media-key') === transportToken;
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/redirect'))
      return new Response(null, { status: 307, headers: { location: 'https://other.invalid/native-cover' } });
    if (path.endsWith('/missing')) return new Response(null, { status: 404 });
    if (path.endsWith('/failure')) return new Response(null, { status: 503 });
    return new Response(null, { headers: { 'content-length': String(20 * 1024 * 1024 + 1) } });
  }) as typeof fetch;

  try {
    const storage = localMediaStorage({
      LOCAL_MEDIA_ORIGIN: 'http://127.0.0.1:41234',
      LOCAL_MEDIA_TOKEN: transportToken,
    });
    await expect(storage.get('redirect', {})).rejects.toThrow('Local media GET failed (307)');
    expect(requests).toBe(1);
    expect(credentialMatches).toBe(true);
    expect(await storage.head('missing')).toBeNull();
    await expect(storage.head('failure')).rejects.toThrow('Local media HEAD failed (503)');
    await expect(storage.head('too-large')).rejects.toThrow('Invalid local media object length');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
