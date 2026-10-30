import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountTokenProvider, CredentialDeniedError, CredentialServiceError } from '../src/credentials.ts';

async function credentials() {
  const dir = await mkdtemp(join(tmpdir(), 'imports-auth-lifetime-'));
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const accountKeyPath = join(dir, 'key.jwk');
  await writeFile(
    accountKeyPath,
    JSON.stringify({
      ...(await crypto.subtle.exportKey('jwk', pair.privateKey)),
      alg: 'ES256',
      kid: 'fixture',
    }),
    { mode: 0o600 },
  );
  return {
    dir,
    options: {
      accountKeyPath,
      account: '00000000-0000-4000-8000-000000000001',
      client: 'rezics-importer',
      authOrigin: 'https://auth.rezics.test',
    },
  };
}

for (const path of ['/signin/key', '/token']) {
  test(`cancellation during ${path} body consumption disposes without waiting for its cancel hook`, async () => {
    const f = await credentials();
    const controller = new AbortController();
    const reading = Promise.withResolvers<void>();
    const paths: string[] = [];
    let held: Request | undefined;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
        },
        cancel() {
          cancellations++;
          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    try {
      const token = await createAccountTokenProvider({
        ...f.options,
        signal: controller.signal,
        fetch: (async (input: RequestInfo | URL) => {
          const request = input as Request;
          paths.push(new URL(request.url).pathname);
          if (new URL(request.url).pathname !== path) {
            return new Response(null, { headers: { 'set-cookie': 'fixture=session; Secure; HttpOnly' } });
          }
          held = request;
          return new Response(body);
        }) as typeof fetch,
      });
      const pending = token();
      const rejected = expect(pending).rejects.toBeInstanceOf(CredentialServiceError);
      await reading.promise;
      controller.abort();
      await rejected;
      expect(held!.signal.aborted).toBe(true);
      expect(cancellations).toBe(1);
      expect(body.locked).toBe(false);
      await expect(token()).rejects.toBeInstanceOf(CredentialServiceError);
      expect(paths).toEqual(path === '/token' ? ['/signin/key', '/token'] : ['/signin/key']);
    } finally {
      controller.abort();
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}

test('coalesced cancelled renewal disposes a late fetch body and leaves another provider independent', async () => {
  const f = await credentials();
  const controller = new AbortController();
  const started = Promise.withResolvers<Request>();
  const late = Promise.withResolvers<Response>();
  const disposed = Promise.withResolvers<void>();
  let requests = 0;
  try {
    const token = await createAccountTokenProvider({
      ...f.options,
      signal: controller.signal,
      fetch: (async (input: RequestInfo | URL) => {
        requests++;
        started.resolve(input as Request);
        return late.promise;
      }) as typeof fetch,
    });
    let independentRequest: Request | undefined;
    const independent = await createAccountTokenProvider({
      ...f.options,
      fetch: (async (input: RequestInfo | URL) => {
        independentRequest = input as Request;
        return new Response(null, { status: 401 });
      }) as typeof fetch,
    });
    const first = expect(token()).rejects.toBeInstanceOf(CredentialServiceError);
    const second = expect(token()).rejects.toBeInstanceOf(CredentialServiceError);
    const held = await started.promise;
    controller.abort();
    await Promise.all([first, second]);
    expect(held.signal.aborted).toBe(true);
    expect(requests).toBe(1);
    late.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            disposed.resolve();
            return new Promise<void>(() => {});
          },
        }),
        { headers: { 'set-cookie': 'fixture=session; Secure; HttpOnly' } },
      ),
    );
    await disposed.promise;
    await expect(token()).rejects.toBeInstanceOf(CredentialServiceError);
    expect(requests).toBe(1);
    await expect(independent()).rejects.toBeInstanceOf(CredentialDeniedError);
    // Denial ends that request; the cancelled provider cannot prevent it from reaching Auth.
    expect(independentRequest).toBeDefined();
  } finally {
    controller.abort();
    late.resolve(new Response(null, { status: 503 }));
    await rm(f.dir, { recursive: true, force: true });
  }
});
