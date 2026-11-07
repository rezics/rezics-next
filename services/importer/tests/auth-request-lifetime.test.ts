import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountKeyIssuerOrigin,
  createAccountTokenProvider,
  CredentialDeniedError,
  CredentialServiceError,
} from '../src/credentials.ts';

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
      // Observe rejection passively; assert the original promise only after cancellation.
      void pending.catch(() => {});
      await reading.promise;
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(CredentialServiceError);
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

test('account-key sign-in posts native Auth and keeps issuer Origin plus assertion audience', async () => {
  const f = await credentials();
  const native = 'http://127.0.0.1:20062';
  const issuer = 'http://127.0.0.1:20061';
  expect(
    accountKeyIssuerOrigin(native, {
      REZICS_LOCAL_STACK_NATIVE_ORIGIN: native,
      REZICS_LOCAL_STACK_ISSUER_ORIGIN: issuer,
    }),
  ).toBe(issuer);
  expect(accountKeyIssuerOrigin('https://auth.rezics.test')).toBe('https://auth.rezics.test');
  const seen: { url: string; origin: string; aud?: string }[] = [];
  try {
    const token = await createAccountTokenProvider({
      ...f.options,
      authOrigin: native,
      issuerOrigin: issuer,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const body = request.method === 'POST' ? await request.clone().text() : '';
        const assertion = body.includes('assertion')
          ? (JSON.parse(body) as { assertion: string }).assertion.split('.')[1]
          : undefined;
        seen.push({
          url: request.url,
          origin: request.headers.get('origin') ?? '',
          ...(assertion
            ? { aud: (JSON.parse(Buffer.from(assertion, 'base64url').toString()) as { aud: string }).aud }
            : {}),
        });
        if (new URL(request.url).pathname === '/signin/key')
          return new Response('{}', { headers: { 'set-cookie': 'fixture=session; Secure; HttpOnly' } });
        return Response.json({ access_token: 'walk-token', token_type: 'Bearer', expires_in: 3600 });
      }) as typeof fetch,
    });
    expect(await token()).toBe('walk-token');
    expect(seen).toEqual([
      { url: `${native}/signin/key`, origin: issuer, aud: `${issuer}/token` },
      { url: `${native}/token`, origin: issuer },
    ]);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

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
    const first = token();
    void first.catch(() => {});
    const second = token();
    void second.catch(() => {});
    const held = await started.promise;
    controller.abort();
    await Promise.all([
      expect(first).rejects.toBeInstanceOf(CredentialServiceError),
      expect(second).rejects.toBeInstanceOf(CredentialServiceError),
    ]);
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

test('walk-stack account-key sign-in reads issuer Origin from the local-stack environment', async () => {
  const f = await credentials();
  const native = 'http://127.0.0.1:20022';
  const issuer = 'http://127.0.0.1:20021';
  const previous = process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN;
  const previousNative = process.env.REZICS_LOCAL_STACK_NATIVE_ORIGIN;
  const seen: string[] = [];
  process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN = issuer;
  process.env.REZICS_LOCAL_STACK_NATIVE_ORIGIN = native;
  try {
    const token = await createAccountTokenProvider({
      ...f.options,
      authOrigin: native,
      fetch: (async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        seen.push(`${new URL(request.url).pathname}:${request.headers.get('origin') ?? ''}`);
        if (new URL(request.url).pathname === '/signin/key') {
          const body = (await request.clone().json()) as { assertion?: string };
          const payload = JSON.parse(Buffer.from(body.assertion!.split('.')[1]!, 'base64url').toString()) as {
            aud?: string;
          };
          expect(payload.aud).toBe(`${issuer}/token`);
          return new Response('{}', { status: 200, headers: { 'set-cookie': 'session=env; Path=/' } });
        }
        return Response.json({ access_token: 'env-token', token_type: 'Bearer', expires_in: 120 });
      }) as typeof fetch,
    });
    expect(await token()).toBe('env-token');
    expect(seen).toEqual(['/signin/key:http://127.0.0.1:20021', '/token:http://127.0.0.1:20021']);
  } finally {
    if (previousNative === undefined) delete process.env.REZICS_LOCAL_STACK_NATIVE_ORIGIN;
    else process.env.REZICS_LOCAL_STACK_NATIVE_ORIGIN = previousNative;
    if (previous === undefined) delete process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN;
    else process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN = previous;
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('walk-stack account-key sign-in posts to native Auth with issuer Origin and audience', async () => {
  const f = await credentials();
  const native = 'http://127.0.0.1:20022';
  const issuer = 'http://127.0.0.1:20021';
  const seen: { url: string; origin: string; aud: string | undefined }[] = [];
  try {
    const token = await createAccountTokenProvider({
      ...f.options,
      authOrigin: native,
      issuerOrigin: issuer,
      fetch: (async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        const origin = request.headers.get('origin') ?? '';
        let aud: string | undefined;
        if (new URL(request.url).pathname === '/signin/key') {
          const body = (await request.clone().json()) as { assertion?: string };
          const payload = JSON.parse(Buffer.from(body.assertion!.split('.')[1]!, 'base64url').toString()) as {
            aud?: string;
          };
          aud = payload.aud;
        }
        seen.push({ url: request.url, origin, aud });
        if (new URL(request.url).pathname === '/signin/key')
          return new Response('{}', { status: 200, headers: { 'set-cookie': 'session=walk; Path=/' } });
        return Response.json({ access_token: 'walk-token', token_type: 'Bearer', expires_in: 120 });
      }) as typeof fetch,
    });
    expect(await token()).toBe('walk-token');
    expect(seen).toEqual([
      { url: `${native}/signin/key`, origin: issuer, aud: `${issuer}/token` },
      { url: `${native}/token`, origin: issuer, aud: undefined },
    ]);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
