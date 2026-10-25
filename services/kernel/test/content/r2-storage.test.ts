import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { R2Storage } from '../../src/content/r2-storage.ts';

const accessKeyId = 'fixture-access';
const secretAccessKey = 'fixture-secret';
const prefix = 'm/01900000-0000-7000-8000-000000000001/';
const sibling = 'm/01900000-0000-8000-8000-000000000002/';
const original = `${prefix}original`;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/xml' } });
function page(keys: string[], more = false, token = ''): Response {
  return xml(
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><EncodingType>url</EncodingType><Prefix>${encodeURIComponent(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>${more}</IsTruncated>${keys.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`).join('')}${token ? `<NextContinuationToken>${xmlEscape(token)}</NextContinuationToken>` : ''}</ListBucketResult>`,
  );
}

type Seen = { method: string; url: URL; headers: Headers; bytes: Uint8Array };
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

function fixture() {
  // This is only the remote S3 protocol fixture. Every operation goes through HTTP and the real adapter/signer.
  const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  const seen: Seen[] = [];
  const deleted: string[] = [];
  const pages: Response[] = [];
  const failures = new Set<string>();
  const authFailures: string[] = [];
  let override: ((request: Request) => Response | Promise<Response> | undefined) | undefined;
  const verifier = new AwsClient({ accessKeyId, secretAccessKey, region: 'auto', service: 's3' });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const url = new URL(request.url);
      const auth = request.headers.get('authorization') ?? '';
      const signedHeaders = auth.match(/SignedHeaders=([^,]+)/)?.[1]?.split(';') ?? [];
      const headers = new Headers(signedHeaders.map((name) => [name, request.headers.get(name) ?? '']));
      const signed = await verifier.sign(request.url, {
        method: request.method,
        headers,
        ...(request.method === 'PUT' ? { body: bytes } : {}),
        aws: { datetime: request.headers.get('x-amz-date') ?? '' },
      });
      if (
        auth !== signed.headers.get('authorization') ||
        !/Credential=fixture-access\/\d{8}\/auto\/s3\/aws4_request/.test(auth)
      ) {
        authFailures.push(request.method);
        return new Response(null, { status: 403 });
      }
      seen.push({ method: request.method, url, headers: request.headers, bytes });
      const forced = await override?.(request);
      if (forced) return forced;
      if (url.pathname === '/media-bucket' && request.method === 'GET') {
        if (
          url.searchParams.get('list-type') !== '2' ||
          url.searchParams.get('prefix') !== prefix ||
          url.searchParams.has('delimiter')
        )
          return new Response(null, { status: 400 });
        return pages.shift() ?? page([...objects.keys()].filter((key) => key.startsWith(prefix)));
      }
      const key = decodeURIComponent(url.pathname.slice('/media-bucket/'.length));
      if (request.method === 'PUT') {
        objects.set(key, { bytes, mediaType: request.headers.get('content-type') ?? '' });
        return new Response(null, { status: 200 });
      }
      if (request.method === 'DELETE') {
        if (failures.delete(key)) return new Response('temporary', { status: 503 });
        deleted.push(key);
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const object = objects.get(key);
      return object
        ? new Response(Uint8Array.from(object.bytes).buffer, {
            headers: { 'content-type': object.mediaType, 'content-length': String(object.bytes.length) },
          })
        : xml('<Error><Code>NoSuchKey</Code></Error>', 404);
    },
  });
  servers.push(server);
  const options = {
    endpoint: server.url.origin,
    bucket: 'media-bucket',
    accessKeyId,
    secretAccessKey,
    fetch: (request: Request) => fetch(request),
    maxObjectBytes: 32,
    requestTimeoutMs: 1000,
  };
  const storage: MediaStorage = new R2Storage(options);
  return {
    storage,
    options,
    objects,
    seen,
    deleted,
    pages,
    failures,
    authFailures,
    override: (handler: typeof override) => {
      override = handler;
    },
  };
}

async function retryable(promise: Promise<unknown>): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ retryable: true });
  expect(String(error)).not.toContain(accessKeyId);
  expect(String(error)).not.toContain(secretAccessKey);
}

test('host media storage uses aws4fetch signed R2 operations and actual byte metadata', async () => {
  const f = fixture();
  const source = new Uint8Array([100, 0, 255, 128, 13, 10, 42]);
  const bytes = source.subarray(1, 6);
  const key = `${prefix}partial/space +%?#&é.webp`;
  await f.storage.put(key, bytes, { mediaType: 'image/webp' });
  expect(f.objects.get(key)).toEqual({ bytes, mediaType: 'image/webp' });
  const read = await f.storage.get(key);
  expect(read).toEqual(bytes);
  expect(hash(read!)).toBe(hash(bytes));
  expect(await f.storage.get(original)).toBeNull();
  const put = f.seen[0]!;
  expect(put.headers.get('content-length')).toBe(String(bytes.length));
  expect(put.headers.get('x-amz-content-sha256')).toBe(hash(bytes));
  expect([...put.headers.keys()].some((name) => name.startsWith('x-amz-checksum'))).toBe(false);
  expect(put.url.pathname).toContain('space%20%2B%25%3F%23%26%C3%A9.webp');
  await f.storage.deletePrefix(prefix);
  expect(f.deleted).toEqual([key]);
  expect(f.authFailures).toEqual([]);
  expect(f.seen.map((r) => r.method)).toEqual(['PUT', 'GET', 'GET', 'GET', 'DELETE']);
});

test('prefix purge paginates empty, one and many pages including original and every partial derivative', async () => {
  const f = fixture();
  const keys = [original, `${prefix}sanitized.avif`, `${prefix}partial/unfinished.webp`, `${prefix}a&b`];
  for (const key of [...keys, `${sibling}original`, 'g/backup', 'x/audit'])
    f.objects.set(key, { bytes: new Uint8Array(), mediaType: 'image/webp' });
  f.pages.push(page([], true, 'one +&='), page(keys.slice(0, 1), true, 'two/%='), page(keys.slice(1)));
  await f.storage.deletePrefix(prefix);
  expect(f.deleted.sort()).toEqual(keys.sort());
  expect([...f.objects.keys()].sort()).toEqual([`${sibling}original`, 'g/backup', 'x/audit'].sort());
  expect(
    f.seen.filter((r) => r.url.searchParams.has('list-type')).map((r) => r.url.searchParams.get('continuation-token')),
  ).toEqual([null, 'one +&=', 'two/%=']);
  await f.storage.deletePrefix(prefix);
  expect(f.deleted).toHaveLength(keys.length);
  expect(f.authFailures).toEqual([]);
});

test('transient partial failure remains retryable and idempotent with no operations left in flight', async () => {
  const f = fixture();
  const keys = [original, `${prefix}partial/a`, `${prefix}sanitized.webp`];
  for (const key of [...keys, `${sibling}original`])
    f.objects.set(key, { bytes: new Uint8Array([7]), mediaType: 'image/webp' });
  f.failures.add(keys[1]!);
  await retryable(f.storage.deletePrefix(prefix));
  const count = f.seen.length;
  await Bun.sleep(10);
  expect(f.seen).toHaveLength(count);
  expect(f.objects.has(keys[1]!)).toBe(true);
  await f.storage.deletePrefix(prefix);
  expect([...f.objects.keys()]).toEqual([`${sibling}original`]);
  expect(f.deleted.sort()).toEqual(keys.sort());
  await f.storage.deletePrefix(prefix);
  expect(f.deleted).toHaveLength(keys.length);
});

test('every listed key is validated before any deletion, including malicious later pages', async () => {
  for (const key of [
    `${sibling}original`,
    'g/audit',
    'x/backup',
    `${prefix}../original`,
    `${prefix}%2e%2e/original`,
    'm/',
  ]) {
    const f = fixture();
    f.pages.push(page([original], true, 'next'), page([key]));
    await retryable(f.storage.deletePrefix(prefix));
    expect(f.deleted).toEqual([]);
  }
});

test('public keys and prefixes cannot escape the one routable media object namespace', async () => {
  const f = fixture();
  for (const value of [
    '',
    'm/',
    prefix.slice(0, -1),
    original,
    `${prefix}nested/`,
    `${prefix}../`,
    'g/',
    'x/',
    'audit/',
    'm/01900000-0000-4000-8000-000000000001/',
    'https://evil.invalid/',
    `${prefix}?x`,
  ]) {
    await expect(f.storage.deletePrefix(value)).rejects.toThrow();
  }
  for (const key of [
    '',
    prefix,
    `${prefix}../x`,
    `${prefix}./x`,
    `${prefix}a//b`,
    `${prefix}a\\b`,
    `${prefix}\0x`,
    'x/backup',
    'https://evil.invalid/object',
    `${prefix}%2e%2e/x`,
    `${prefix}\ud800`,
  ]) {
    await expect(f.storage.get(key)).rejects.toThrow();
    await expect(f.storage.put(key, new Uint8Array(), { mediaType: 'image/webp' })).rejects.toThrow();
  }
  expect(f.seen).toEqual([]);
});

test('malformed, ambiguous and looping list responses fail closed', async () => {
  for (const body of [
    '<ListBucketResult><IsTruncated>false</ListBucketResult>',
    '<Error><Code>Denied</Code></Error>',
    '<ListBucketResult/>',
    '<ListBucketResult><IsTruncated>maybe</IsTruncated></ListBucketResult>',
    '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents/></ListBucketResult>',
    '<!DOCTYPE a [<!ENTITY a "expansion">]><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><IsTruncated>true</IsTruncated></ListBucketResult>',
  ]) {
    const f = fixture();
    f.pages.push(xml(body));
    await retryable(f.storage.deletePrefix(prefix));
    expect(f.deleted).toEqual([]);
  }
  const f = fixture();
  f.pages.push(page([original], true, 'repeat'), page([], true, 'repeat'));
  await retryable(f.storage.deletePrefix(prefix));
  expect(f.deleted).toEqual([]);
});

test('GET is bounded using measured bytes and rejects malformed transport or false missing', async () => {
  for (const response of [
    new Response(new Uint8Array(33)),
    new Response(new Uint8Array(33), { headers: { 'content-length': '33' } }),
    new Response(new Uint8Array(4), { headers: { 'content-length': '5' } }),
    new Response(new Uint8Array(4), { status: 206 }),
    xml('<Error><Code>NoSuchBucket</Code></Error>', 404),
    new Response('gateway failed', { status: 503 }),
    new Response('redirect', { status: 307, headers: { location: 'https://evil.invalid' } }),
  ]) {
    const f = fixture();
    const storage = new R2Storage({ ...f.options, fetch: async () => response });
    await retryable(storage.get(original));
  }
  const f = fixture();
  let cancelled = false;
  const storage = new R2Storage({
    ...f.options,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(33));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await retryable(storage.get(original));
  expect(cancelled).toBe(true);
  expect(await f.storage.get(original)).toBeNull();
});

test('transport errors, put/delete failures and timeouts are retryable and redact credentials', async () => {
  const f = fixture();
  const storage = new R2Storage({
    ...f.options,
    fetch: async () => {
      throw new Error(`${accessKeyId}:${secretAccessKey}`);
    },
  });
  await retryable(storage.get(original));
  await retryable(storage.put(original, new Uint8Array([1]), { mediaType: 'image/png' }));
  await retryable(storage.deletePrefix(prefix));
  f.override(() => new Response(secretAccessKey, { status: 403 }));
  await retryable(f.storage.put(original, new Uint8Array([1]), { mediaType: 'image/png' }));
  const timed = new R2Storage({
    ...f.options,
    requestTimeoutMs: 10,
    fetch: async (request) =>
      new Promise<Response>((_resolve, reject) =>
        request.signal.addEventListener('abort', () => reject(new Error(secretAccessKey)), { once: true }),
      ),
  });
  await retryable(timed.get(original));
  let cancelled = false;
  const stalled = new R2Storage({
    ...f.options,
    requestTimeoutMs: 10,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await retryable(stalled.get(original));
  expect(cancelled).toBe(true);
});

test('list transport and put inputs are bounded before remote mutation', async () => {
  const f = fixture();
  await expect(f.storage.put(original, new Uint8Array(33), { mediaType: 'image/webp' })).rejects.toThrow();
  await expect(f.storage.put(original, new Uint8Array(1), { mediaType: 'bad\r\nheader' })).rejects.toThrow();
  expect(f.seen).toEqual([]);
  const storage = new R2Storage({ ...f.options, fetch: async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)) });
  await retryable(storage.deletePrefix(prefix));
  expect(f.deleted).toEqual([]);
});
