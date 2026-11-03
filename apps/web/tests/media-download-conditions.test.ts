import { expect, test } from 'bun:test';
import type { DownloadDecision } from '../src/media/kernel.ts';
import { mediaRequest, type MediaEnv } from '../src/media/index.ts';

const id = '00000000-0000-4000-8000-000000000001';
const key = `m/${id}/original`;
const digest = 'a'.repeat(64);
const etag = `"${digest}"`;
const bytes = new Uint8Array([3, 7, 11, 19, 23, 31, 43, 59, 67, 71, 79, 83, 97, 101, 107, 127]);

type GetCall = { key: string; range: R2Range | null };
type FixtureOptions = { headMissing?: boolean; getMissing?: boolean; headSize?: number };

function allowedDecision(): Extract<DownloadDecision, { allowed: true }> {
  return {
    allowed: true,
    key,
    sha256: digest,
    mediaType: 'image/png',
    byteCount: bytes.length + 100,
    publicCache: false,
    cacheControl: 'private, no-cache',
  };
}

function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

function fixture(options: FixtureOptions = {}) {
  const authorizationCalls: Array<{
    method: string;
    path: string;
    variant: string | null;
    authorization: string | null;
  }> = [];
  const headCalls: string[] = [];
  const getCalls: GetCall[] = [];
  const decisions = new Map<string, DownloadDecision>([['original', allowedDecision()]]);
  let headMissing = options.headMissing ?? false;
  let getMissing = options.getMissing ?? false;
  let kernelProblem: { status: number; code: string } | null = null;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const outgoing = new Request(input, init);
    const url = new URL(outgoing.url);
    authorizationCalls.push({
      method: outgoing.method,
      path: url.pathname,
      variant: url.searchParams.get('variant'),
      authorization: outgoing.headers.get('authorization'),
    });
    if (kernelProblem) {
      return Response.json(
        {
          type: `https://rezics.com/problems/${kernelProblem.code}`,
          title: kernelProblem.code,
          status: kernelProblem.status,
          code: kernelProblem.code,
        },
        { status: kernelProblem.status },
      );
    }
    const decision = decisions.get(url.searchParams.get('variant') ?? '') ?? { allowed: false as const };
    if (decision.allowed) return Response.json(decision);
    return Response.json(
      { type: 'https://rezics.com/problems/not_found', title: 'Not Found', status: 404, code: 'not_found' },
      { status: 404 },
    );
  };

  const storage = {
    async head(storedKey: string) {
      headCalls.push(storedKey);
      return headMissing ? null : ({ size: options.headSize ?? bytes.length } as unknown as R2Object);
    },
    async get(storedKey: string, getOptions?: R2GetOptions) {
      const requested = getOptions?.range;
      getCalls.push({ key: storedKey, range: requested ?? null });
      if (getMissing) return null;

      const selected =
        requested !== undefined && !(requested instanceof Headers)
          ? (requested as { offset?: number; length?: number; suffix?: number })
          : undefined;
      const offset =
        selected?.offset ?? (selected?.suffix !== undefined ? Math.max(bytes.length - selected.suffix, 0) : 0);
      const length =
        selected?.length ?? (selected?.suffix !== undefined ? Math.min(selected.suffix, bytes.length) : bytes.length);
      const bodyBytes = bytes.slice(offset, offset + length);
      return {
        size: bytes.length,
        ...(selected ? { range: { offset, length: bodyBytes.length } } : {}),
        body: stream(bodyBytes),
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;

  const env: MediaEnv = { KERNEL_ORIGIN: 'https://kernel.test', MEDIA: storage };
  return {
    authorizationCalls,
    headCalls,
    getCalls,
    send(request: { method?: string; headers?: HeadersInit; variant?: string } = {}) {
      const path = `/media/${id}/${request.variant ?? 'original'}`;
      return mediaRequest(
        new Request(`https://site.test${path}`, {
          method: request.method ?? 'GET',
          headers: request.headers,
        }),
        env,
      );
    },
    setDecision(value: DownloadDecision, variant = 'original') {
      kernelProblem = null;
      decisions.set(variant, value);
    },
    setKernelProblem(status: number, code: string) {
      kernelProblem = { status, code };
    },
    setHeadMissing(value: boolean) {
      headMissing = value;
    },
    setGetMissing(value: boolean) {
      getMissing = value;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function withFixture(run: (value: ReturnType<typeof fixture>) => Promise<void>, options?: FixtureOptions) {
  const value = fixture(options);
  try {
    await run(value);
  } finally {
    value.restore();
  }
}

function expectOneFreshAuthorization(
  value: ReturnType<typeof fixture>,
  count: number,
  credential: string | null = null,
  variant = 'original',
) {
  expect(value.authorizationCalls).toHaveLength(count);
  expect(value.authorizationCalls.at(-1)).toEqual({
    method: 'GET',
    path: `/v1/media/${id}:authorizeDownload`,
    variant,
    authorization: credential,
  });
}

test('every response decision is freshly authorized and success headers match full GET, including HEAD', async () => {
  await withFixture(async (value) => {
    const full = await value.send({ headers: { authorization: 'Bearer current-viewer' } });
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
    expect(full.headers.get('content-length')).toBe(String(bytes.length));
    expect(full.headers.get('etag')).toBe(etag);
    expect(full.headers.get('cache-control')).toBe('private, no-cache');
    expect(full.headers.get('content-type')).toBe('image/png');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    expect(full.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(full.headers.get('content-disposition')).toBe(`attachment; filename="${id}-original.png"`);
    expect(full.headers.get('last-modified')).toBeNull();
    expect(value.headCalls).toEqual([key]);
    expect(value.getCalls).toEqual([{ key, range: null }]);
    expectOneFreshAuthorization(value, 1, 'Bearer current-viewer');

    const partial = await value.send({ headers: { range: 'bytes=3-6' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 3-6/${bytes.length}`);
    expect(partial.headers.get('content-length')).toBe('4');
    for (const name of [
      'etag',
      'cache-control',
      'content-type',
      'accept-ranges',
      'x-content-type-options',
      'content-security-policy',
      'content-disposition',
    ])
      expect(partial.headers.get(name)).toBe(full.headers.get(name));
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.slice(3, 7));
    expect(value.getCalls.at(-1)).toEqual({ key, range: { offset: 3, length: 4 } });
    expect(value.headCalls).toHaveLength(2);
    expect(value.getCalls).toHaveLength(2);
    expectOneFreshAuthorization(value, 2);

    const head = await value.send({ method: 'HEAD', headers: { range: 'bytes=3-6', 'if-range': 'W/' + etag } });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    for (const name of [
      'etag',
      'cache-control',
      'content-type',
      'content-length',
      'accept-ranges',
      'x-content-type-options',
      'content-security-policy',
      'content-disposition',
    ])
      expect(head.headers.get(name)).toBe(full.headers.get(name));
    expect(head.headers.get('content-range')).toBeNull();
    expect(value.headCalls).toEqual([key, key, key]);
    expect(value.getCalls).toHaveLength(2);
    expectOneFreshAuthorization(value, 3);

    const notModified = await value.send({
      headers: { 'if-none-match': `W/"old,tag", W/${etag}`, range: `bytes=${bytes.length}-` },
    });
    expect(notModified.status).toBe(304);
    expect((await notModified.arrayBuffer()).byteLength).toBe(0);
    expect(notModified.headers.get('etag')).toBe(etag);
    expect(notModified.headers.get('cache-control')).toBe('private, no-cache');
    expect(value.headCalls).toHaveLength(3);
    expect(value.getCalls).toHaveLength(2);
    expectOneFreshAuthorization(value, 4);

    const unsatisfiable = await value.send({ headers: { range: `bytes=${bytes.length}-` } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${bytes.length}`);
    expect(unsatisfiable.headers.get('etag')).toBe(etag);
    expect(unsatisfiable.headers.get('cache-control')).toBe('private, no-cache');
    expect(value.headCalls).toHaveLength(4);
    expect(value.getCalls).toHaveLength(2);
    expectOneFreshAuthorization(value, 5);

    value.setDecision({ allowed: false }, 'webp-320');
    const denied = await value.send({
      variant: 'webp-320',
      headers: { 'if-none-match': '*', range: `bytes=${bytes.length}-` },
    });
    expect(denied.status).toBe(404);
    const deniedSurface = `${await denied.clone().text()}\n${[...denied.headers].map(([name, entry]) => `${name}: ${entry}`).join('\n')}`;
    expect(deniedSurface).not.toContain(key);
    expect(deniedSurface).not.toContain(digest);
    expect(value.headCalls).toHaveLength(4);
    expect(value.getCalls).toHaveLength(2);
    expectOneFreshAuthorization(value, 6, null, 'webp-320');

    value.setDecision({ allowed: false });
    const deniedHead = await value.send({ method: 'HEAD', headers: { 'if-none-match': '*', range: 'bytes=0-0' } });
    expect(deniedHead.status).toBe(404);
    expect((await deniedHead.arrayBuffer()).byteLength).toBe(0);
    expect(value.headCalls).toHaveLength(4);
    expect(value.getCalls).toHaveLength(2);
    expectOneFreshAuthorization(value, 7);

    value.setDecision(allowedDecision());
    value.setHeadMissing(true);
    const missingHead = await value.send();
    expect(missingHead.status).toBe(404);
    const missingHeadBody = await missingHead.text();
    expect(missingHeadBody).not.toContain(key);
    expect(missingHeadBody).not.toContain(digest);
    expect(value.headCalls).toHaveLength(5);
    expect(value.getCalls).toHaveLength(2);
    expectOneFreshAuthorization(value, 8);

    value.setHeadMissing(false);
    value.setGetMissing(true);
    const missingGet = await value.send();
    expect(missingGet.status).toBe(404);
    const missingGetBody = await missingGet.text();
    expect(missingGetBody).not.toContain(key);
    expect(missingGetBody).not.toContain(digest);
    expect(value.headCalls).toHaveLength(6);
    expect(value.getCalls).toHaveLength(3);
    expectOneFreshAuthorization(value, 9);
  });
});

test('If-Range only admits an exact strong entity tag and otherwise ignores even an unsatisfiable Range', async () => {
  await withFixture(async (value) => {
    const cases = [
      { ifRange: etag, range: 'bytes=2-4', status: 206, expectedRange: { offset: 2, length: 3 } },
      { ifRange: `"${'b'.repeat(64)}"`, range: 'bytes=2-4', status: 200, expectedRange: null },
      { ifRange: `W/${etag}`, range: 'bytes=2-4', status: 200, expectedRange: null },
      { ifRange: `${etag} junk`, range: 'bytes=2-4', status: 200, expectedRange: null },
      { ifRange: 'Sun, 06 Nov 1994 08:49:37 GMT', range: `bytes=${bytes.length}-`, status: 200, expectedRange: null },
      { ifRange: `"${'c'.repeat(64)}"`, range: `bytes=${bytes.length}-`, status: 200, expectedRange: null },
    ];

    for (const [index, item] of cases.entries()) {
      const response = await value.send({ headers: { range: item.range, 'if-range': item.ifRange } });
      expect(response.status).toBe(item.status);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(item.status === 206 ? bytes.slice(2, 5) : bytes);
      expect(value.getCalls.at(-1)).toEqual({ key, range: item.expectedRange });
      expect(value.headCalls).toHaveLength(index + 1);
      expect(value.getCalls).toHaveLength(index + 1);
      expectOneFreshAuthorization(value, index + 1);
    }

    const ignoredWithoutRange = await value.send({ headers: { 'if-range': etag } });
    expect(ignoredWithoutRange.status).toBe(200);
    expect(new Uint8Array(await ignoredWithoutRange.arrayBuffer())).toEqual(bytes);
    expect(value.getCalls.at(-1)).toEqual({ key, range: null });
    expect(value.headCalls).toHaveLength(cases.length + 1);
    expect(value.getCalls).toHaveLength(cases.length + 1);
    expectOneFreshAuthorization(value, cases.length + 1);
  });
});

test('If-None-Match uses weak comparison for valid lists and rejects malformed fragments before matching', async () => {
  await withFixture(async (value) => {
    for (const [index, validator] of [
      [`W/${etag}`, 'single weak validator'],
      [`W/"other,opaque", W/${etag}`, 'comma inside an opaque tag'],
      [` , "other", W/${etag}, `, 'empty list members'],
      ['*', 'wildcard'],
    ].entries()) {
      const response = await value.send({ headers: { 'if-none-match': validator[0]! } });
      expect(response.status, validator[1]).toBe(304);
      expect(value.headCalls).toHaveLength(0);
      expect(value.getCalls).toHaveLength(0);
      expectOneFreshAuthorization(value, index + 1);
    }

    for (const [index, validator] of [
      [`broken, W/${etag}`, 'malformed leading fragment'],
      [`W/${etag}, trailing`, 'malformed trailing fragment'],
      [`*, W/${etag}`, 'wildcard mixed with a list'],
      [`W/"unterminated`, 'unterminated entity tag'],
      [`W/"bad tag"`, 'invalid entity tag character'],
    ].entries()) {
      const response = await value.send({ headers: { 'if-none-match': validator[0]! } });
      expect(response.status, validator[1]).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(value.headCalls).toHaveLength(index + 1);
      expect(value.getCalls).toHaveLength(index + 1);
      expectOneFreshAuthorization(value, index + 5);
    }
    expect(value.headCalls).toHaveLength(5);
    expect(value.getCalls).toHaveLength(5);
  });
});

test('single byte ranges cover closed, open, suffix, clamped, huge, malformed, multipart, and empty objects', async () => {
  await withFixture(async (value) => {
    const cases = [
      { range: 'bytes=0-0', status: 206, start: 0, length: 1 },
      { range: 'bytes=4-', status: 206, start: 4, length: bytes.length - 4 },
      { range: 'bytes=-3', status: 206, start: bytes.length - 3, length: 3 },
      { range: `bytes=2-${'9'.repeat(30)}`, status: 206, start: 2, length: bytes.length - 2 },
      { range: `bytes=-${'9'.repeat(30)}`, status: 206, start: 0, length: bytes.length },
      { range: 'items=2-4', status: 200, start: 0, length: bytes.length },
      { range: 'bytes=1-2,4-5', status: 200, start: 0, length: bytes.length },
      { range: 'bytes=5-4', status: 200, start: 0, length: bytes.length },
      { range: 'bytes=-', status: 200, start: 0, length: bytes.length },
    ];
    for (const [index, item] of cases.entries()) {
      const response = await value.send({ headers: { range: item.range } });
      expect(response.status).toBe(item.status);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(item.start, item.start + item.length));
      expect(value.getCalls.at(-1)).toEqual({
        key,
        range: item.status === 206 ? { offset: item.start, length: item.length } : null,
      });
      expect(value.headCalls).toHaveLength(index + 1);
      expect(value.getCalls).toHaveLength(index + 1);
      expectOneFreshAuthorization(value, index + 1);
    }

    const hugeStart = await value.send({ headers: { range: `bytes=${'9'.repeat(30)}-` } });
    expect(hugeStart.status).toBe(416);
    expect(hugeStart.headers.get('content-range')).toBe(`bytes */${bytes.length}`);
    expect(value.headCalls).toHaveLength(cases.length + 1);
    expect(value.getCalls).toHaveLength(cases.length);
    expectOneFreshAuthorization(value, cases.length + 1);
  });

  await withFixture(
    async (value) => {
      const empty = await value.send({ headers: { range: 'bytes=0-' } });
      expect(empty.status).toBe(416);
      expect(empty.headers.get('content-range')).toBe('bytes */0');
      expect(value.headCalls).toEqual([key]);
      expect(value.getCalls).toHaveLength(0);
      expectOneFreshAuthorization(value, 1);
    },
    { headMissing: false, headSize: 0 },
  );
});

test('each download forwards the current caller; a prior 200 or matching validator cannot replace refusal or unavailability', async () => {
  await withFixture(async (value) => {
    const signedOut = await value.send();
    expect(signedOut.status).toBe(200);
    expect(new Uint8Array(await signedOut.arrayBuffer())).toEqual(bytes);
    expectOneFreshAuthorization(value, 1, null);

    const bound = await value.send({ headers: { authorization: 'Bearer current-viewer' } });
    expect(bound.status).toBe(200);
    expectOneFreshAuthorization(value, 2, 'Bearer current-viewer');

    const other = await value.send({ headers: { authorization: 'Bearer other-viewer' } });
    expect(other.status).toBe(200);
    expectOneFreshAuthorization(value, 3, 'Bearer other-viewer');
    expect(value.headCalls).toHaveLength(3);
    expect(value.getCalls).toHaveLength(3);

    value.setDecision({ allowed: false });
    const revoked = await value.send({
      headers: { authorization: 'Bearer current-viewer', 'if-none-match': etag, range: 'bytes=0-3' },
    });
    expect(revoked.status).toBe(404);
    const revokedSurface = `${await revoked.clone().text()}\n${[...revoked.headers].map(([name, entry]) => `${name}: ${entry}`).join('\n')}`;
    expect(revokedSurface).not.toContain(key);
    expect(revokedSurface).not.toContain(digest);
    expect(value.headCalls).toHaveLength(3);
    expect(value.getCalls).toHaveLength(3);
    expectOneFreshAuthorization(value, 4, 'Bearer current-viewer');

    value.setDecision(allowedDecision());
    expect((await value.send()).status).toBe(200);
    expect(value.getCalls).toHaveLength(4);

    for (const [index, item] of [
      { status: 401, code: 'authentication_required', credential: null },
      { status: 503, code: 'dependency_unavailable', credential: 'Bearer current-viewer' },
    ].entries()) {
      value.setKernelProblem(item.status, item.code);
      const response = await value.send({
        headers: {
          ...(item.credential === null ? {} : { authorization: item.credential }),
          'if-none-match': etag,
          range: 'bytes=0-3',
        },
      });
      expect(response.status, item.code).toBe(404);
      const surface = `${await response.clone().text()}\n${[...response.headers].map(([name, entry]) => `${name}: ${entry}`).join('\n')}`;
      expect(surface).not.toContain(key);
      expect(surface).not.toContain(digest);
      expect(value.headCalls).toHaveLength(4);
      expect(value.getCalls).toHaveLength(4);
      expectOneFreshAuthorization(value, index + 6, item.credential);
    }
  });
});
