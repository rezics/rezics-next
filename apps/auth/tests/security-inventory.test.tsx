import { mountedSuite } from './owned-application-review-fixture';
import { expect, test } from 'bun:test';
import { SecurityInventory, type InventorySource } from '../src/security-inventory-view';
import type { InventoryPage } from '../src/security-inventory';
import { click, expand, host, m, render, row, text, tick } from './owned-application-review-fixture';

mountedSuite();

test('Security composes independent ownership/consent data and retires both at the parent boundary', async () => {
  const life = new AbortController();
  const calls: string[] = [];
  const source: InventorySource = async (view) => {
    calls.push(view);
    return (
      view === 'clients'
        ? { kind: 'ready', rows: [row('exact-owner-id')], next: null }
        : {
            kind: 'ready',
            rows: [
              {
                client_id: 'separate-consent',
                display_name: 'Connected only',
                granted: ['openid'],
                status: 'current',
                reducible: false,
                pending_reduction: false,
              },
            ],
            next: null,
          }
    ) as InventoryPage<typeof view>;
  };
  await render(<SecurityInventory source={source} lifetime={life.signal} preflight />);
  expect(calls).toEqual(['clients', 'consents']);
  await expand();
  expect(text()).toContain('exact-owner-id');
  expect(text()).toContain('Connected only');
  expect(text()).toContain(m.auth_inventory_preflight());
  await click(m.auth_owned_close());
  expect(calls).toEqual(['clients', 'consents']);
  await tick(() => life.abort());
  expect(host.textContent).not.toContain('exact-owner-id');
  expect(host.textContent).not.toContain('Connected only');
});

test('native maximum encrypted cursors pass the production inventory BFF validator and reach their selected endpoint', async () => {
  const script = `
    import { expect, mock } from 'bun:test';
    const validators = [];
    const calls = [];
    mock.module('@tanstack/react-start', () => ({
      createServerFn: () => {
        let validate = value => value;
        const builder = {
          validator(fn) { validate = fn; validators.push(fn); return builder; },
          handler(fn) { return options => fn({ data: validate(options.data), signal: options.signal }); },
        };
        return builder;
      },
      createServerOnlyFn: fn => fn,
    }));
    mock.module('@tanstack/react-start/server', () => ({
      getRequest: () => new Request('https://auth.test/security', {
        headers: { origin: 'https://auth.test', cookie: 'fixture=session' },
      }),
      setResponseHeader() {},
    }));
    mock.module('cloudflare:workers', () => ({ env: { AUTH_SECURITY_SCOPE_CONFIGURATION: 'native-no-catalogue' } }));
    globalThis.__AUTH_ORIGIN__ = '';
    const { securityResponseLimits } = await import('@rezics/auth-contract');
    const { securityCursors } = await import('./services/auth/src/security-cursor.ts');
    const { loadInventory } = await import('./apps/auth/src/security-inventory.ts');
    const validateInventory = validators.find(validate => {
      try { return validate({ view: 'clients' }).view === 'clients'; }
      catch { return false; }
    });
    expect(typeof validateInventory === 'function').toBe(true);
    const time = Number.MAX_SAFE_INTEGER - 900;
    const native = securityCursors('test-only fixture key', 'https://auth.test', () => time);
    const binding = { accountId: 'owner', sessionId: 'session', clientId: 'login', epoch: 1, scopes: [] };
    const after = '\\u0001'.repeat(1024);
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, cursor: url.searchParams.get('cursor') });
      const view = url.pathname.slice(1);
      return Response.json({ [view]: [], next: null });
    };
    for (const view of ['clients', 'consents']) {
      const cursor = native.write(after, view, binding, 20);
      expect(cursor.length > 8192 && cursor.length <= securityResponseLimits.cursor).toBe(true);
      expect(native.read(cursor, view, binding, 20) === after).toBe(true);
      const page = await loadInventory(view, cursor);
      expect(page.kind === 'ready' && page.rows.length === 0).toBe(true);
      const forwarded = calls.at(-1);
      expect(forwarded.path === '/' + view).toBe(true);
      expect(forwarded.cursor === cursor).toBe(true);
    }
    const tooLong = 'x'.repeat(securityResponseLimits.cursor + 1);
    expect(() => validateInventory({ view: 'consents', cursor: '' })).toThrow();
    expect(() => validateInventory({ view: 'consents', cursor: 1 })).toThrow();
    expect(() => validateInventory({ view: 'consents', cursor: tooLong })).toThrow();
    const before = calls.length;
    expect((await loadInventory('consents', tooLong)).kind).toBe('unavailable');
    expect(calls.length === before).toBe(true);
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect(await child.exited, output + error).toBe(0);
});

test('selected inventory BFF bounds streamed native pages and retires stalled reads without another request', async () => {
  const script = `
    import { expect, mock } from 'bun:test';
    let currentRequest;
    const workerEnv = { AUTH_SECURITY_SCOPE_CONFIGURATION: 'catalogue:4' };
    mock.module('@tanstack/react-start', () => ({
      createServerFn: () => {
        let validate = value => value;
        const builder = {
          validator(fn) { validate = fn; return builder; },
          handler(fn) { return options => {
            currentRequest = new Request('https://auth.test/security', {
              headers: { origin: 'https://auth.test', cookie: 'fixture=session' }, signal: options.signal,
            });
            return fn({ data: validate(options.data), signal: options.signal });
          }; },
        };
        return builder;
      },
      createServerOnlyFn: fn => fn,
    }));
    mock.module('@tanstack/react-start/server', () => ({ getRequest: () => currentRequest, setResponseHeader() {} }));
    mock.module('cloudflare:workers', () => ({ env: workerEnv }));
    globalThis.__AUTH_ORIGIN__ = '';
    const { securityResponseByteBudgets, securityResponseLimits } = await import('@rezics/auth-contract');
    const { loadInventory } = await import('./apps/auth/src/security-inventory.ts');
    const scopes = Array.from({ length: 4 }, (_, i) => 'x'.repeat(127) + i);
    const id = i => '\\u0000'.repeat(1024 - String(i).length) + i;
    const rows = view => Array.from({ length: 20 }, (_, i) => view === 'clients'
      ? { client_id: id(i), display_name: '\\u0000'.repeat(100), disabled: false, scopes }
      : { client_id: id(i), display_name: '\\u0000'.repeat(100), granted: scopes, status: 'current', reducible: true, pending_reduction: false });
    const body = view => JSON.stringify({ [view]: rows(view), next: 'a'.repeat(securityResponseLimits.cursor) });
    const encode = value => new TextEncoder().encode(value);
    const streamed = (chunks, length) => new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(encode(chunk)); controller.close(); },
    }), { headers: { 'content-type': 'application/json', ...(length === undefined ? {} : { 'content-length': length }) } });
    let calls = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (init.signal !== currentRequest.signal) throw new Error('BFF request signal not forwarded');
      const view = url.pathname.slice(1), text = body(view);
      if (Buffer.byteLength(text) > securityResponseByteBudgets(4, 20)[view]) throw new Error('fixture exceeds native allowance');
      const response = streamed([text]);
      if (response.headers.has('content-length')) throw new Error('fixture must omit Content-Length');
      return response;
    };
    for (const view of ['clients', 'consents']) {
      const page = await loadInventory(view);
      expect(page.kind === 'ready' && page.rows.length === 20 && page.next.length === securityResponseLimits.cursor).toBe(true);
    }
    expect(calls.join(',')).toBe('/clients,/consents');

    const limit = securityResponseByteBudgets(4, 20).clients;
    const originalParse = JSON.parse;
    let parses = 0;
    JSON.parse = (...args) => {
      if (typeof args[0] === 'string' && args[0].length > limit) parses++;
      return originalParse(...args);
    };
    for (const [chunks, length] of [[[' '.repeat(limit + 1)], undefined], [[' '.repeat(limit >> 1), ' '.repeat((limit >> 1) + 1)], '1']]) {
      const before = calls.length;
      globalThis.fetch = async () => { calls.push('/clients'); return streamed(chunks, length); };
      const page = await loadInventory('clients');
      const callCount = calls.length - before;
      const parseCount = parses;
      expect(page.kind).toBe('unavailable');
      expect(callCount).toBe(1);
      expect(parseCount).toBe(0);
    }
    JSON.parse = originalParse;

    workerEnv.AUTH_SECURITY_SCOPE_CONFIGURATION = '';
    const beforeInvalid = calls.length;
    expect((await loadInventory('clients')).kind).toBe('unavailable');
    expect(calls.length).toBe(beforeInvalid);

    workerEnv.AUTH_SECURITY_SCOPE_CONFIGURATION = 'catalogue:4';
    for (const [status, cursor, kind] of [[401, undefined, 'signed-out'], [403, undefined, 'denied'], [400, 'opaque-cursor', 'expired']]) {
      globalThis.fetch = async input => { calls.push(String(input)); return new Response(null, { status }); };
      expect((await loadInventory('clients', cursor)).kind).toBe(kind);
      if (cursor) expect(new URL(calls.at(-1)).searchParams.get('cursor')).toBe(cursor);
    }

    workerEnv.AUTH_SECURITY_SCOPE_CONFIGURATION = 'catalogue:4';
    let startedResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    globalThis.fetch = async (_input, init) => {
      calls.push('/consents');
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(encode('{"consents":[')); startedResolve(); } }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const beforeStall = calls.length;
    const retirement = new AbortController();
    const pending = loadInventory('consents', undefined, retirement.signal);
    await started;
    retirement.abort();
    expect((await pending).kind).toBe('unavailable');
    expect(calls.length).toBe(beforeStall + 1);
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect(await child.exited, output + error).toBe(0);
});
test('fixed Security response readers accept escaped maxima, reject overflow before parsing and retire stalled bodies', async () => {
  const script = `
    import { expect, mock } from 'bun:test';
    let activeSignal, mode = 'maximum', overflowPath = '', streamStarted, expire, cancelled = 0;
    const calls = [];
    mock.module('@tanstack/react-start', () => ({
      createServerFn: () => {
        let validate = value => value;
        const builder = {
          validator(fn) { validate = fn; return builder; },
          handler(fn) { return options => {
            activeSignal = options?.signal;
            return fn({ data: validate(options?.data), signal: options?.signal });
          }; },
        };
        return builder;
      },
      createServerOnlyFn: fn => fn,
    }));
    mock.module('@tanstack/react-start/server', () => ({
      getRequest: () => new Request('https://auth.test/security', {
        headers: { origin: 'https://auth.test', cookie: 'fixture=session' }, signal: activeSignal,
      }),
      setResponseHeader() {},
    }));
    mock.module('../src/turnstile.ts', () => ({ readTurnstileConfig: async () => ({ siteKey: '', scriptUrl: '' }) }));
    globalThis.__AUTH_ORIGIN__ = '';
    const { securityFixedResponseByteBudgets } = await import('@rezics/auth-contract');
    const id = '\\u0000'.repeat(1024), date = '2026-11-05T00:00:00.000Z';
    const rowId = index => '\\u0000'.repeat(1021) + String(index).padStart(3, '0');
    const page = {
      viewer: { account_id: id, session_id: rowId(0), client_id: id },
      actions: { change_password: 'step-up-required', register_passkey: 'step-up-required' },
      sessions: { kind: 'ready', limit: 64, truncated: false, rows: Array.from({ length: 64 }, (_, i) => ({
        id: rowId(i), client_id: id, client_display_name: '\\u0000'.repeat(100), created_at: date,
        expires_at: date, user_agent: '\\u0000'.repeat(512), current: i === 0, revoke: 'step-up-required',
      })) },
      passkeys: { kind: 'ready', limit: 32, truncated: false, rows: Array.from({ length: 32 }, (_, i) => ({
        id: rowId(i + 64), name: '\\u0000'.repeat(128), created_at: date, last_used_at: date,
        remove: 'step-up-required',
      })) },
    };
    const passkeys = { passkeys: Array.from({ length: 32 }, (_, i) => ({
      id: rowId(i), name: '\\u0000'.repeat(128), created_at: date, last_used_at: date,
    })) };
    const registration = {
      kind: 'already-signed-in', viewer: { account_id: id },
      requirements: {
        handle: { minLength: 3, maxLength: 64 }, email: { maxLength: 254 },
        password: { minLength: 10, maxLength: Number.MAX_SAFE_INTEGER },
        verification: { provider: 'turnstile', required: true },
      },
      verification: { configured: false }, actions: { register: false, continue: true },
    };
    function response(path) {
      if (path === '/session') return Response.json({ account_id: id });
      const body = path === '/security-page' ? page : path === '/passkeys' ? passkeys : registration;
      const maximum = securityFixedResponseByteBudgets[
        path === '/security-page' ? 'securityPage' : path === '/passkeys' ? 'passkeys' : 'registrationPage'
      ];
      let bytes = new TextEncoder().encode(JSON.stringify(body));
      expect(bytes.byteLength).toBeLessThanOrEqual(maximum);
      if (mode === 'overflow' && path === overflowPath) bytes = new Uint8Array(maximum + 1);
      const stream = new ReadableStream({
        start(controller) {
          if (mode === 'stalled' && path === overflowPath) { streamStarted.resolve(); return; }
          controller.enqueue(bytes);
          controller.close();
        },
        cancel() { cancelled++; },
      });
      const result = new Response(stream, { status: 200 });
      result.json = () => { throw new Error('fixed Security responses must use readJsonBounded'); };
      return result;
    }
    globalThis.fetch = async input => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (mode === 'stalled' && path === overflowPath) streamStarted.resolve();
      return response(path);
    };
    const { loadSecurityPage, loadPasskeyInventory } = await import('../src/security-inventory');
    const { readRegistrationPage } = await import('../src/registration-page');
    const { loadPasswordChangeLimits, reviewPasskeyRegistration } = await import('../src/security');
    expect((await loadSecurityPage()).kind).toBe('ready');
    const list = await loadPasskeyInventory();
    expect(list.ok && list.body.passkeys.length === 32).toBe(true);
    expect((await readRegistrationPage()).kind).toBe('already-signed-in');
    expect(await loadPasswordChangeLimits()).toEqual({ minLength: 10, maxLength: Number.MAX_SAFE_INTEGER });
    expect((await reviewPasskeyRegistration(id)).kind).toBe('ready');
    expect(calls).toEqual([
      '/security-page', '/passkeys', '/registration-page', '/registration-page',
      '/session', '/passkeys', '/session',
    ]);

    const parse = JSON.parse;
    let parses = 0;
    JSON.parse = (...args) => { parses++; return parse(...args); };
    for (const [path, read] of [
      ['/security-page', () => loadSecurityPage()],
      ['/passkeys', () => loadPasskeyInventory()],
      ['/registration-page', () => readRegistrationPage()],
      ['/registration-page', () => loadPasswordChangeLimits()],
    ]) {
      mode = 'overflow'; overflowPath = path;
      const before = parses;
      const result = await read();
      expect(parses).toBe(before);
      if (path === '/security-page') expect(result.kind).toBe('unavailable');
      else if (path === '/passkeys') expect(result).toEqual({ ok: false });
      else if (result === null || result.kind === 'unavailable') expect(true).toBe(true);
      else throw new Error('overflow must leave registration advice unavailable');
    }

    const timeout = globalThis.setTimeout;
    let heldTimer;
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 5000) {
        expire = callback;
        heldTimer = timeout(() => {}, 60000);
        return heldTimer;
      }
      return timeout(callback, delay, ...args);
    };
    mode = 'stalled'; overflowPath = '/security-page'; streamStarted = Promise.withResolvers();
    const retired = new AbortController(), beforeStall = calls.length, beforeCancel = cancelled;
    const pending = loadSecurityPage(retired.signal);
    await streamStarted.promise;
    retired.abort();
    expect(await pending).toEqual({ kind: 'unavailable' });
    expect(retired.signal.aborted).toBe(true);
    expect(cancelled).toBe(beforeCancel + 1);
    expect(calls.length).toBe(beforeStall + 1);
    mode = 'stalled'; streamStarted = Promise.withResolvers();
    const timed = new AbortController(), beforeDeadline = calls.length, cancelBeforeDeadline = cancelled;
    const deadlineRead = loadSecurityPage(timed.signal);
    await streamStarted.promise;
    expire();
    expect(await deadlineRead).toEqual({ kind: 'unavailable' });
    expect(timed.signal.aborted).toBe(false);
    expect(cancelled).toBe(cancelBeforeDeadline + 1);
    expect(calls.length).toBe(beforeDeadline + 1);
    globalThis.setTimeout = timeout;
    clearTimeout(heldTimer);
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect(await child.exited, output + error).toBe(0);
});
