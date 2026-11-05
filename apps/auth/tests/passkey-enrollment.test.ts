import { enrollmentOptionsFixture } from './passkey-enrollment-fixture';
import { afterAll, expect, test } from 'bun:test';
import { PasskeyEnrollmentController } from '../src/passkey-enrollment';
import { creationFixture } from './creation-page-fixture';

creationFixture();
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const originalCredentials = Object.getOwnPropertyDescriptor(navigator, 'credentials');
const originalPublicKeyCredential = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: class {} });
const { addPasskey } = await import('../src/passkeys');

afterAll(() => {
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
  else Reflect.deleteProperty(globalThis, 'fetch');
  if (originalCredentials) Object.defineProperty(navigator, 'credentials', originalCredentials);
  else Reflect.deleteProperty(navigator, 'credentials');
  if (originalPublicKeyCredential)
    Object.defineProperty(globalThis, 'PublicKeyCredential', originalPublicKeyCredential);
  else Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
});

function options() {
  return Response.json(enrollmentOptionsFixture());
}

function credential() {
  const bytes = Uint8Array.of(1).buffer;
  return {
    id: 'browser-credential',
    rawId: bytes,
    type: 'public-key',
    response: { attestationObject: bytes, clientDataJSON: bytes },
    getClientExtensionResults: () => ({}),
  };
}

function install(create: () => Promise<Credential | null>, register: () => Promise<Response>) {
  const paths: string[] = [];
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create } });
  globalThis.fetch = (async (path) => {
    paths.push(String(path));
    return String(path) === '/passkeys/register/options' ? options() : register();
  }) as typeof fetch;
  return paths;
}

test('browser cancellation before dispatch sends no registration request', async () => {
  const phases: string[] = [];
  const paths = install(
    async () => {
      throw Object.assign(new Error('dismissed'), { name: 'NotAllowedError' });
    },
    async () => Response.json({}),
  );
  const result = await addPasskey('Travel key', undefined, (phase) => phases.push(phase));
  expect(result).toEqual({ ok: false, reason: 'cancelled' });
  expect(paths).toEqual(['/passkeys/register/options']);
  expect(phases).toEqual(['options', 'prompt', 'cancelled']);
});

test('dispatch is reported at transport handoff and a lost response stays unknown', async () => {
  const phases: string[] = [];
  const paths = install(
    async () => credential() as unknown as Credential,
    async () => {
      throw new TypeError('connection lost');
    },
  );
  const result = await addPasskey('Travel key', undefined, (phase) => phases.push(phase));
  expect(result).toEqual({ ok: false, reason: 'unknown' });
  expect(paths).toEqual(['/passkeys/register/options', '/passkeys/register']);
  expect(phases).toEqual(['options', 'prompt', 'registration-dispatched', 'unknown']);
});

test('a valid 201 response is confirmed only after its body validates', async () => {
  const phases: string[] = [];
  const paths = install(
    async () => credential() as unknown as Credential,
    async () =>
      Response.json({ id: 'native-id', name: 'Travel key', created_at: '2026-11-01T00:00:00Z' }, { status: 201 }),
  );
  const result = await addPasskey('Travel key', undefined, (phase) => phases.push(phase));
  expect(result).toMatchObject({ ok: true, passkey: { id: 'native-id', name: 'Travel key' } });
  expect(paths).toEqual(['/passkeys/register/options', '/passkeys/register']);
  expect(phases).toEqual(['options', 'prompt', 'registration-dispatched', 'confirmed']);
});

test('pagehide clears a pre-dispatch attempt and retains only dispatched uncertainty', () => {
  const controller = new PasskeyEnrollmentController();
  const prompt = controller.begin('account-one')!;
  expect(controller.observe(prompt, 'prompt')).toBe(true);
  controller.pagehide();
  expect(controller.snapshot()).toBeNull();
  expect(controller.observe(prompt, 'registration-dispatched')).toBe(false);

  const dispatched = controller.begin('account-one')!;
  controller.observe(dispatched, 'registration-dispatched');
  controller.pagehide();
  expect(controller.snapshot()).toMatchObject({ attemptId: dispatched, phase: 'unknown', reviewRequired: true });
  expect(controller.observe(dispatched, 'confirmed')).toBe(false);
  expect(controller.restoreFor('account-two')).toMatchObject({ phase: 'changed-account', accountId: null });
  expect(controller.begin('account-two')).not.toBeNull();
});

test('generic history survives retirement and later acknowledgements cannot settle unknown', () => {
  const controller = new PasskeyEnrollmentController();
  const confirmed = controller.begin('account-one')!;
  controller.observe(confirmed, 'registration-dispatched');
  controller.observe(confirmed, 'confirmed');
  controller.pagehide();
  controller.retireAuthority();
  expect(controller.historySnapshot()).toBe('acknowledged');

  const unknown = controller.begin('account-one')!;
  controller.observe(unknown, 'registration-dispatched');
  controller.pagehide();
  controller.retireAuthority();
  const later = controller.begin('account-two')!;
  controller.observe(later, 'confirmed');
  expect(controller.historySnapshot()).toBe('unknown');
  controller.dismissHistory();
  expect(controller.historySnapshot()).toBeNull();
  expect(controller.snapshot()).toMatchObject({ attemptId: later, phase: 'confirmed' });
});

function streamed(value: unknown, headers: Record<string, string> = {}, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i++) c.enqueue(bytes.slice(i, i + 1));
        c.close();
      },
    }),
    { status, headers },
  );
}

test('options receiving bounds actual bytes before prompt and retains one exact POST', async () => {
  const { passkeyEnrollmentResponseBytes: budgets } = await import('@rezics/auth-contract');
  let ceremonies = 0;
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      create: async () => {
        ceremonies++;
        return credential();
      },
    },
  });
  for (const response of [
    streamed({ ...enrollmentOptionsFixture(), timeout: 0 }),
    streamed({ ...enrollmentOptionsFixture(), challenge: 'a' }),
    new Response(' '.repeat(budgets.options + 1), { headers: { 'content-length': '1' } }),
    new Response('x', { status: 503 }),
    new Response(' '.repeat(budgets.error + 1), { status: 401 }),
  ]) {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (path, init) => {
      expect(path).toBe('/passkeys/register/options');
      calls.push(init!);
      return response;
    }) as typeof fetch;
    expect(await addPasskey('Key')).toMatchObject({ ok: false, reason: 'failure' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: '{}',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    });
  }
  expect(ceremonies).toBe(0);
});

test('legal streamed acknowledgement keeps exact saved identity and native nullable label', async () => {
  for (const name of [null, '😀旅行鍵']) {
    const phases: string[] = [];
    const paths = install(
      async () => credential() as unknown as Credential,
      async () =>
        streamed({ id: 'exact-native-id', name, created_at: '2026-11-01T00:00:00Z' }, { 'content-length': '1' }, 201),
    );
    const fetchOptions = globalThis.fetch;
    globalThis.fetch = (async (path, init) =>
      String(path) === '/passkeys/register/options'
        ? streamed({
            ...enrollmentOptionsFixture(),
            user: { ...enrollmentOptionsFixture().user, displayName: '😀旅行者' },
          })
        : fetchOptions(path, init)) as typeof fetch;
    expect(
      await addPasskey('Suggested name', undefined, (p) => {
        phases.push(p);
        throw new Error('observer');
      }),
    ).toMatchObject({ ok: true, passkey: { id: 'exact-native-id', name: name ?? '' } });
    expect(paths).toEqual(['/passkeys/register']);
    expect(phases).toEqual(['options', 'prompt', 'registration-dispatched', 'confirmed']);
  }
});

test('only explicit native refusal retires dispatched custody; malformed or excess replies stay unknown', async () => {
  const { passkeyEnrollmentResponseBytes: budgets } = await import('@rezics/auth-contract');
  for (const [response, reason] of [
    [Response.json({ error: 'credential_effect_denied', effect_status: 'not_applied' }, { status: 409 }), 'failure'],
    [Response.json({ error: 'step_up_required', effect_status: 'not_applied' }, { status: 401 }), 'step-up'],
    [Response.json({ error: 'credential_effect_denied' }, { status: 400 }), 'unknown'],
    [Response.json({ id: 'native-id', name: null, created_at: 'invalid' }, { status: 201 }), 'unknown'],
    [new Response('{', { status: 201 }), 'unknown'],
    [new Response(' '.repeat(budgets.created + 1), { status: 201 }), 'unknown'],
    [new Response(' '.repeat(budgets.error + 1), { status: 409, headers: { 'content-length': '1' } }), 'unknown'],
  ] as const) {
    const controller = new PasskeyEnrollmentController();
    const attempt = controller.begin('original-account')!;
    const paths = install(
      async () => credential() as unknown as Credential,
      async () => response,
    );
    expect(
      await addPasskey('Key', undefined, (p) => {
        controller.observe(attempt, p);
      }),
    ).toMatchObject({ ok: false, reason });
    expect(paths).toEqual(['/passkeys/register/options', '/passkeys/register']);
    if (reason === 'unknown') {
      expect(controller.snapshot()).toMatchObject({ phase: 'unknown', accountId: 'original-account' });
      expect(controller.observe(attempt, 'failure')).toBe(false);
      expect(controller.observe(attempt, 'confirmed')).toBe(false);
    } else expect(controller.snapshot()).toBeNull();
  }
});

test('caller cancellation is effective through abort-ignoring options and acknowledgement streams', async () => {
  const pre = new AbortController();
  pre.abort();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error('should not fetch');
  }) as typeof fetch;
  expect(await addPasskey('Key', pre.signal)).toEqual({ ok: false, reason: 'cancelled' });
  expect(calls).toBe(0);
  for (const stage of ['options', 'prompt', 'dispatched'] as const) {
    const stop = new AbortController();
    const entered = Promise.withResolvers<void>();
    const finishPrompt = Promise.withResolvers<Credential | null>();
    const paths = install(
      async () => {
        if (stage === 'prompt') {
          entered.resolve();
          return finishPrompt.promise;
        }
        return credential() as unknown as Credential;
      },
      async () => {
        entered.resolve();
        return new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 201 });
      },
    );
    if (stage === 'options')
      globalThis.fetch = (async () => {
        entered.resolve();
        return new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }));
      }) as typeof fetch;
    const result = addPasskey('Key', stop.signal);
    await entered.promise;
    stop.abort();
    finishPrompt.resolve(credential() as unknown as Credential);
    expect(await result).toEqual({ ok: false, reason: stage === 'dispatched' ? 'unknown' : 'cancelled' });
    expect(paths.filter((path) => path === '/passkeys/register')).toHaveLength(stage === 'dispatched' ? 1 : 0);
  }
});
