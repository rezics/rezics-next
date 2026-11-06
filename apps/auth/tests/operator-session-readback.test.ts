import { expect, test } from 'bun:test';

test('installed readback and metadata admit bounded native streams without commands or retries', async () => {
  const script = String.raw`
    import { expect, mock } from 'bun:test';
    let signal;
    const env = { AUTH_SECURITY_SCOPE_CONFIGURATION: undefined };
    mock.module('@tanstack/react-start', () => ({ createServerOnlyFn: fn => fn, createServerFn: () => {
      const builder = { validator() { return builder; }, handler(fn) { return options => {
        signal = options?.signal; return fn({ data: options?.data });
      }; } }; return builder;
    } }));
    mock.module('cloudflare:workers', () => ({ env }));
    mock.module('@tanstack/react-start/server', () => ({ setResponseHeader() {}, getRequest: () =>
      new Request('https://auth.test/_serverFn/opening', { signal,
        headers: { origin: 'https://auth.test', cookie: 'auth_session=original' } }) }));
    globalThis.__AUTH_ORIGIN__ = '';
    const { securityScopeLimit, securityResponseByteBudgets, securityResponseLimits: l,
      managementOperationProfile, OPERATOR_OPENING_PAGE_MAX_RESPONSE_BYTES: pageCap } = await import('@rezics/auth-contract');
    const { readOpenedSession: read, loadOpeningMetadata: metadata } = await import('./src/operator-session-opening');
    const subject = '00000000-0000-8000-8000-000000000001';
    const operator = '00000000-0000-8000-8000-000000000002';
    const input = { accountId: 'opaque-human', operationKey: 'one-read', operation: {
      kind: 'opening', subjectAccountId: subject, operatorAccountId: operator } };
    const native = { account_id: subject, client_id: managementOperationProfile('opening').client_id,
      scope: Array(4).fill('x'.repeat(l.scope)), authn_epoch: Number.MAX_SAFE_INTEGER,
      auth_time: Math.floor(Date.now()/1000), amr: ['operator'] };
    const calls = []; let response; let started;
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); started?.resolve(); return await response; };
    for (const configuration of [undefined, '', 'catalogue:4x', 'catalogue:2', 'catalogue:9007199254740991']) {
      env.AUTH_SECURITY_SCOPE_CONFIGURATION = configuration;
      expect(await read(input)).toEqual({ kind: 'unknown' });
    }
    expect(calls).toHaveLength(0);
    const c = securityScopeLimit(['openid', 'offline_access', 'media:complete', 'site:read', 'site:read']);
    expect(c).toBe(4); env.AUTH_SECURITY_SCOPE_CONFIGURATION = 'catalogue:' + c;
    const cap = securityResponseByteBudgets(c).session;
    const encode = value => new TextEncoder().encode(value);
    const stream = (text, headers = {}) => new Response(new ReadableStream({ start(controller) {
      const bytes = encode(text); controller.enqueue(bytes.slice(0, 10)); controller.enqueue(bytes.slice(10)); controller.close();
    } }), { headers });
    const escaped = JSON.stringify(native).replaceAll('x', '\u0078');
    const exact = escaped + ' '.repeat(cap - encode(escaped).byteLength);
    response = stream(exact); expect(await read(input)).toEqual({ kind: 'opened', session: native });
    expect(calls).toHaveLength(1);
    expect(calls[0].init).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store',
      headers: { Origin: 'https://auth.test', Cookie: 'auth_session=original' } });
    const parse = JSON.parse; let parses = 0;
    JSON.parse = (...args) => { parses++; return parse(...args); };
    for (const headers of [{}, { 'content-length': '1' }]) {
      response = stream(exact + ' ', headers); expect(await read(input)).toEqual({ kind: 'unknown' });
    }
    expect(parses).toBe(0);
    for (const value of [ { ...native, scope: Array(5).fill('x') },
      { ...native, scope: ['x'.repeat(l.scope + 1)] }, { ...native, extra: true },
      { ...native, amr: ['pwd'] }, { ...native, auth_time: Math.floor(Date.now()/1000) + 100 },
      { ...native, account_id: operator }, { ...native, authn_epoch: -1 }, { ...native, client_id: 'other' } ]) {
      response = Response.json(value); expect(await read(input)).toEqual({ kind: 'unknown' });
    }
    for (const status of [401, 403, 503]) {
      response = new Response(null, { status }); expect(await read(input)).toEqual({ kind: 'unknown' });
    }
    response = stream('{'); expect(await read(input)).toEqual({ kind: 'unknown' });
    env.AUTH_SECURITY_SCOPE_CONFIGURATION = 'native-no-catalogue';
    response = Response.json(native); expect((await read(input)).kind).toBe('opened');
    const page = { stage: 'current', viewer: { accountId: input.accountId }, subject: { id: subject, kind: 'actor' },
      operator: { id: operator, kind: 'organization' }, relation: { reservationId: subject, version: '9223372036854775807' },
      disclosure: 'unavailable', allowedActions: ['opening'] };
    const pageText = JSON.stringify(page); const exactPage = pageText + ' '.repeat(pageCap - encode(pageText).byteLength);
    response = stream(exactPage); expect((await metadata(input)).kind).toBe('ready');
    const beforeOverflow = parses;
    response = stream(exactPage + ' ', { 'content-length': '1' }); expect(await metadata(input)).toEqual({ kind: 'unavailable' });
    expect(parses).toBe(beforeOverflow);
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 5000 ? 30 : ms, ...args);
    for (const operation of [read, metadata]) {
      const before = calls.length; const pre = new AbortController(); pre.abort();
      expect((await operation(input, pre.signal)).kind).toBe(operation === read ? 'unknown' : 'unavailable');
      expect(calls).toHaveLength(before);
      for (const stalled of [new Promise(() => {}), new Response(new ReadableStream({ pull() {} }))]) {
        response = stalled; expect((await operation(input)).kind).toBe(operation === read ? 'unknown' : 'unavailable');
        expect(calls.at(-1).init.signal.aborted).toBe(true);
      }
      const late = Promise.withResolvers(); started = Promise.withResolvers(); response = late.promise;
      const retired = new AbortController(); const pending = operation(input, retired.signal);
      await started.promise; retired.abort();
      expect((await pending).kind).toBe(operation === read ? 'unknown' : 'unavailable');
      const count = parses; late.resolve(Response.json(operation === read ? native : page));
      await Promise.resolve(); expect(parses).toBe(count); started = undefined;
    }
    expect(calls.every(({ url, init }) => url === 'https://auth.test/session' && init.method === 'GET' ||
      url === 'https://auth.test/account-management/operators/opening-page' && init.method === 'POST')).toBe(true);
    JSON.parse = parse; globalThis.setTimeout = timeout;
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: `${import.meta.dir}/..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, output + error).toBe(0);
});

test('returning from an operated session renews Web at the configured origin without carrying management command context', async () => {
  const { operatorWebsiteHref } = await import('../src/operator-opening-navigation');
  expect(operatorWebsiteHref('http://127.0.0.1:20000', 'ja', '/accounts')).toBe('http://127.0.0.1:20000/ja/accounts');
  const next = new URL(operatorWebsiteHref('http://127.0.0.1:20000', 'zh-Hant', '/', true));
  expect(next.origin).toBe('http://127.0.0.1:20000');
  expect(next.pathname).toBe('/auth/sign-in');
  expect([...next.searchParams]).toEqual([['return_to', '/zh-Hant/']]);
});
