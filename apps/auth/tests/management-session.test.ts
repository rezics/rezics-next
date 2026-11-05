import { expect, test } from 'bun:test';

test('loadManagementSession bounds the complete human proof and never approves refused advice', async () => {
  const script = String.raw`
    import { expect, mock } from 'bun:test';
    let currentSignal;
    const nativeEnv = { AUTH_SECURITY_SCOPE_CONFIGURATION: undefined };
    mock.module('@tanstack/react-start', () => ({
      createServerFn: () => ({ handler: fn => options => {
        currentSignal = options?.signal;
        return fn({ data: options?.data, signal: options?.signal });
      } }),
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
    const sessionStorage = new Map();
    globalThis.window = { sessionStorage: {
      getItem: key => sessionStorage.get(key) ?? null,
      setItem: (key, value) => sessionStorage.set(key, value),
      removeItem: key => sessionStorage.delete(key),
    } };
    const { securityResponseByteBudgets, securityResponseLimits } = await import('@rezics/auth-contract');
    const { loadManagementSession, managementOperationProfile, managementProfileSessionMatches, approveManagementOperation } =
      await import('./apps/auth/src/management-operations.ts');
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 5000 ? 10 : delay, ...args);
    const calls = [];
    let response;
    let approvalResponse;
    let fetchStarted;
    globalThis.fetch = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      fetchStarted?.resolve();
      if (String(input).includes('/account-operations/approve')) return await approvalResponse;
      return await response;
    };
    const unavailable = { kind: 'unavailable' };
    expect(await loadManagementSession()).toEqual(unavailable);
    nativeEnv.AUTH_SECURITY_SCOPE_CONFIGURATION = 'catalogue:4x';
    expect(await loadManagementSession()).toEqual(unavailable);
    expect(calls).toHaveLength(0);

    nativeEnv.AUTH_SECURITY_SCOPE_CONFIGURATION = 'catalogue:4';
    const cap = securityResponseByteBudgets(4).session;
    const encoder = new TextEncoder();
    const stream = (text, headers = {}) => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); },
    }), { headers });
    const maximum = {
      account_id: '\u0001'.repeat(securityResponseLimits.id),
      client_id: '\u0001'.repeat(securityResponseLimits.id),
      scope: Array(4).fill('\u0001'.repeat(securityResponseLimits.scope)),
      authn_epoch: Number.MAX_SAFE_INTEGER,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    };
    const compact = JSON.stringify(maximum);
    const exact = compact + ' '.repeat(cap - encoder.encode(compact).byteLength);
    expect(encoder.encode(exact).byteLength).toBe(cap);
    const parsed = [];
    const jsonParse = JSON.parse;
    JSON.parse = (value, ...args) => { parsed.push(value); return jsonParse(value, ...args); };
    response = stream(exact, { 'content-length': '1' });
    const accepted = await loadManagementSession();
    expect(accepted).toEqual({
      kind: 'ready', accountId: maximum.account_id, clientId: maximum.client_id,
      scopes: maximum.scope, authTime: maximum.auth_time, authnEpoch: maximum.authn_epoch, amr: ['pwd'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://auth.test/session');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers.Cookie).toBe('auth_session=original');
    expect(calls[0].init.headers.Origin).toBe('https://auth.test');

    const parsedBeforeOverflow = parsed.length;
    response = stream(exact + ' ');
    expect(await loadManagementSession()).toEqual(unavailable);
    response = stream(exact + ' ', { 'content-length': '1' });
    expect(await loadManagementSession()).toEqual(unavailable);
    expect(parsed).toHaveLength(parsedBeforeOverflow);
    response = stream('{');
    expect(await loadManagementSession()).toEqual(unavailable);
    response = Response.json({ ...maximum, scope: Array(5).fill('x') });
    expect(await loadManagementSession()).toEqual(unavailable);
    response = Response.json({ ...maximum, account_id: 'x'.repeat(securityResponseLimits.id + 1) });
    expect(await loadManagementSession()).toEqual(unavailable);
    response = Response.json({ ...maximum, amr: ['operator'] });
    expect(await loadManagementSession()).toEqual(unavailable);

    const profile = managementOperationProfile('rename');
    const human = {
      account_id: 'opaque-human-id', client_id: profile.client_id, scope: profile.scope,
      authn_epoch: 9, auth_time: Math.floor(Date.now() / 1000), amr: ['pop'],
    };
    response = Response.json(human);
    const legal = await loadManagementSession();
    expect(legal.kind).toBe('ready');
    expect(legal.kind === 'ready' && managementProfileSessionMatches(legal, 'rename', human.account_id)).toBe(true);
    expect(legal.kind === 'ready' && managementProfileSessionMatches({ ...legal, accountId: 'other' }, 'rename', human.account_id)).toBe(false);
    expect(legal.kind === 'ready' && managementProfileSessionMatches({ ...legal, authTime: legal.authTime - 601 }, 'rename', human.account_id)).toBe(false);
    const validInput = {
      operationKey: 'stable-operation-key', accountId: human.account_id,
      operation: { kind: 'rename', accountId: 'managed-account', handle: 'new-name', expectedHandle: null },
    };
    response = Response.json(human);
    approvalResponse = Response.json({
      reference: 'management-reference', expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(await approveManagementOperation(validInput)).toMatchObject({
      kind: 'approved', input: validInput, reference: 'management-reference',
    });
    response = new Response(null, { status: 401 });
    expect(await loadManagementSession()).toEqual({ kind: 'signed-out' });
    response = new Response(null, { status: 503 });
    expect(await loadManagementSession()).toEqual(unavailable);

    const stalledStarted = Promise.withResolvers();
    response = new Response(new ReadableStream({
      pull() { stalledStarted.resolve(); return new Promise(() => {}); },
    }, { highWaterMark: 0 }));
    const stalled = loadManagementSession();
    await stalledStarted.promise;
    expect(await stalled).toEqual(unavailable);
    expect(calls.at(-1).init.signal.aborted).toBe(true);

    const beforePreAbort = calls.length;
    const preAborted = new AbortController();
    preAborted.abort();
    expect(await loadManagementSession(preAborted.signal)).toEqual(unavailable);
    expect(calls).toHaveLength(beforePreAbort);

    const late = Promise.withResolvers();
    const started = Promise.withResolvers();
    response = late.promise;
    fetchStarted = started;
    const retired = new AbortController();
    const parseCountBeforeRetirement = parsed.length;
    const pending = loadManagementSession(retired.signal);
    await started.promise;
    retired.abort();
    expect(await pending).toEqual(unavailable);
    expect(calls.at(-1).init.signal.aborted).toBe(true);
    late.resolve(Response.json(human));
    await Promise.resolve();
    expect(parsed).toHaveLength(parseCountBeforeRetirement);

    const approvalsBeforeRefusal = calls.filter(call => call.url.includes('/account-operations/approve')).length;
    response = stream(exact + ' ');
    const approval = await approveManagementOperation(validInput);
    expect(approval).toEqual(unavailable);
    expect(calls.filter(call => call.url.includes('/account-operations/approve'))).toHaveLength(approvalsBeforeRefusal);
    const nativeGets = calls.filter(call => call.url.endsWith('/session'));
    expect(nativeGets.every(call => call.init.method === 'GET')).toBe(true);
    expect(calls.filter(call => call.url.includes('/account-operations/approve')).every(call => call.init.method === 'POST')).toBe(true);
    JSON.parse = jsonParse;
    globalThis.setTimeout = originalTimeout;
    console.log(JSON.stringify({ nativeGets: nativeGets.length, cap }));
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, output + error).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ nativeGets: 14 });
});
