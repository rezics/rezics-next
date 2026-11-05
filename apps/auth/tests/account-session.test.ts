import { expect, test } from 'bun:test';

test('loadAccountSession bounds the native stream, preserves classifications and retires late reads', async () => {
  const script = String.raw`
    import { expect, mock } from 'bun:test';
    let currentSignal;
    const nativeEnv = { AUTH_SECURITY_SCOPE_CONFIGURATION: undefined };
    mock.module('@tanstack/react-start', () => ({
      createServerFn: () => {
        let handler;
        const builder = { validator() { return builder; }, handler(fn) {
          handler = fn;
          return options => { currentSignal = options?.signal; return handler({ data: options?.data, signal: options?.signal }); };
        } };
        return builder;
      },
      createServerOnlyFn: fn => fn,
    }));
    mock.module('cloudflare:workers', () => ({ env: nativeEnv }));
    mock.module('@tanstack/react-start/server', () => ({
      getRequest: () => new Request('https://auth.test/_serverFn/session', {
        headers: { origin: 'https://auth.test', cookie: 'auth_session=original' },
        ...(currentSignal ? { signal: currentSignal } : {}),
      }),
      setResponseHeader() {},
    }));
    globalThis.__AUTH_ORIGIN__ = '';
    const { securityResponseByteBudgets, securityResponseLimits } = await import('@rezics/auth-contract');
    const { loadAccountSession } = await import('./apps/auth/src/account-operations.ts');
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 5000 ? 5 : delay, ...args);
    const calls = [];
    let response;
    let fetchStarted;
    globalThis.fetch = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      fetchStarted?.resolve();
      return await response;
    };
    const failed = { kind: 'failure' };
    expect(await loadAccountSession()).toMatchObject(failed);
    nativeEnv.AUTH_SECURITY_SCOPE_CONFIGURATION = 'catalogue:4x';
    expect(await loadAccountSession()).toMatchObject(failed);
    expect(calls).toHaveLength(0);
    nativeEnv.AUTH_SECURITY_SCOPE_CONFIGURATION = 'catalogue:4';
    const cap = securityResponseByteBudgets(4).session;
    const native = {
      account_id: '\u0001'.repeat(securityResponseLimits.id),
      client_id: '\u0001'.repeat(securityResponseLimits.id),
      scope: Array(4).fill('x'.repeat(securityResponseLimits.scope)),
      authn_epoch: Number.MAX_SAFE_INTEGER,
      auth_time: Number.MAX_SAFE_INTEGER,
      amr: ['private_key_jwt'],
    };
    const raw = JSON.stringify(native);
    const encoded = new TextEncoder();
    const exact = raw + ' '.repeat(cap - encoded.encode(raw).byteLength);
    expect(encoded.encode(exact).byteLength).toBe(cap);
    const stream = (value, headers = {}) => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoded.encode(value)); controller.close(); },
    }), { headers });
    response = stream(exact);
    const parsed = [];
    const parse = JSON.parse;
    JSON.parse = (value, ...args) => { parsed.push(value); return parse(value, ...args); };
    const accepted = await loadAccountSession();
    expect(accepted).toEqual({ kind: 'ready', accountId: native.account_id, clientId: native.client_id, scopes: native.scope });
    expect(calls.at(-1).url).toBe('https://auth.test/session');
    expect(calls.at(-1).init.method).toBe('GET');
    expect(calls.at(-1).init.headers.Cookie).toBe('auth_session=original');
    expect(calls.at(-1).init.headers.Origin).toBe('https://auth.test');
    expect(calls).toHaveLength(1);
    const beforeRefusals = parsed.length;
    response = stream(exact, { 'content-length': '1' });
    expect((await loadAccountSession()).kind).toBe('ready');
    response = stream(exact + ' ', { 'content-length': '1' });
    expect(await loadAccountSession()).toMatchObject(failed);
    expect(parsed).toHaveLength(beforeRefusals + 1);
    let pulls = 0;
    response = new Response(new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 }), { headers: { 'content-length': String(cap + 1) } });
    expect(await loadAccountSession()).toMatchObject(failed);
    expect(pulls).toBe(0);
    response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoded.encode(exact.slice(0, cap)));
      controller.enqueue(encoded.encode(' '));
      controller.close();
    } }), { headers: { 'content-length': '1' } });
    expect(await loadAccountSession()).toMatchObject(failed);
    expect(parsed).toHaveLength(beforeRefusals + 1);
    const longId = { account_id: 'x'.repeat(securityResponseLimits.id + 1) };
    response = Response.json(longId);
    expect(await loadAccountSession()).toMatchObject(failed);
    const tooMany = { account_id: 'a', scope: Array(5).fill('a') };
    response = Response.json(tooMany);
    expect(await loadAccountSession()).toMatchObject(failed);
    const tooLongScope = { account_id: 'a', scope: ['x'.repeat(securityResponseLimits.scope + 1)] };
    response = Response.json(tooLongScope);
    expect(await loadAccountSession()).toMatchObject(failed);
    response = new Response(null, { status: 401 });
    expect(await loadAccountSession()).toEqual({ kind: 'signed-out' });
    response = new Response(null, { status: 503 });
    expect(await loadAccountSession()).toMatchObject(failed);
    expect(calls.length).toBe(10);
    response = new Response(new ReadableStream({ pull() {} }));
    expect(await loadAccountSession()).toMatchObject(failed);
    expect(calls.at(-1).init.signal.aborted).toBe(true);
    const caller = new AbortController();
    const late = Promise.withResolvers();
    const started = Promise.withResolvers();
    fetchStarted = started;
    response = late.promise;
    const pending = loadAccountSession(caller.signal);
    await started.promise;
    caller.abort();
    expect(await pending).toMatchObject(failed);
    expect(calls.at(-1).init.signal.aborted).toBe(true);
    const parseCount = parsed.length;
    late.resolve(Response.json(native));
    await Promise.resolve();
    expect(parsed).toHaveLength(parseCount);
    JSON.parse = parse;
    globalThis.setTimeout = originalTimeout;
    console.log(JSON.stringify({ calls: calls.length, cap }));
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect(await child.exited, output + error).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ calls: 12 });
});
