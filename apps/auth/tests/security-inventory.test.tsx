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
test('fixed Security readers apply the public byte caps before parsing and retire stalled streams', async () => {
  const script = `
    import { expect, mock } from 'bun:test';
    let signal, mode = 'maximum', target = '', started, expire, cancelled = 0, timers = 0;
    const calls = [];
    mock.module('@tanstack/react-start', () => ({ createServerFn: () => {
      let validate = value => value;
      const builder = { validator(fn) { validate = fn; return builder; },
        handler(fn) { return options => { signal = options?.signal; return fn({ data: validate(options?.data), signal: options?.signal }); }; } };
      return builder;
    }, createServerOnlyFn: fn => fn }));
    mock.module('@tanstack/react-start/server', () => ({
      getRequest: () => new Request('https://auth.test/security', { headers: { origin: 'https://auth.test', cookie: 'fixture=session' }, signal }),
      setResponseHeader() {},
    }));
    mock.module('./apps/auth/src/turnstile.ts', () => ({ readTurnstileConfig: async () => ({ siteKey: '', scriptUrl: '' }) }));
    mock.module('cloudflare:workers', () => ({ env: { AUTH_SECURITY_SCOPE_CONFIGURATION: 'catalogue:4' } }));
    globalThis.__AUTH_ORIGIN__ = '';
    const { securityResponseByteBudgets, securityFixedResponseByteBudgets: fixed } = await import('@rezics/auth-contract');
    const budgets = { ...fixed, session: securityResponseByteBudgets(4).session };
    let sessionReads = 0, failSession = 0;
    const id = '\\u0000'.repeat(1024), date = '2026-11-05T00:00:00.000Z';
    const page = { viewer: { account_id: id, session_id: 'session', client_id: id },
      actions: { change_password: 'step-up-required', register_passkey: 'step-up-required' },
      sessions: { kind: 'unavailable' }, passkeys: { kind: 'unavailable' } };
    const passkeys = { passkeys: [{ id, name: '', created_at: date, last_used_at: date }] };
    const registration = { kind: 'already-signed-in', viewer: { account_id: id }, requirements: {
      handle: { minLength: 3, maxLength: 64 }, email: { maxLength: 254 },
      password: { minLength: 10, maxLength: Number.MAX_SAFE_INTEGER },
      verification: { provider: 'turnstile', required: true } }, verification: { configured: false },
      actions: { register: false, continue: true } };
    const key = path => path === '/session' ? 'session' : path === '/security-page' ? 'securityPage' : path === '/passkeys' ? 'passkeys' : 'registrationPage';
    function response(path) {
      if (path === '/session') sessionReads++;
      const session = { account_id: mode === 'different' && sessionReads === 2 ? 'replacement' : id,
        client_id: id, scope: Array(4).fill('a'.repeat(128)), authn_epoch: Number.MAX_SAFE_INTEGER,
        auth_time: Number.MAX_SAFE_INTEGER, amr: ['pwd'] };
      const cap = budgets[key(path)], value = path === '/session' ? session : path === '/security-page' ? page : path === '/passkeys' ? passkeys : registration;
      let body = JSON.stringify(value); body += ' '.repeat(cap - new TextEncoder().encode(body).byteLength);
      let bytes = new TextEncoder().encode(body);
      if (mode === 'overflow' && path === target && (!failSession || sessionReads === failSession)) bytes = new Uint8Array(cap + 1);
      const stream = new ReadableStream({ start(c) { if (mode === 'stalled' && path === target && (!failSession || sessionReads === failSession)) { started.resolve(); return; } if (mode === 'unreadable' && path === '/session' && sessionReads === failSession) { c.error(new Error('broken body')); return; } c.enqueue(bytes); c.close(); }, cancel() { cancelled++; } });
      const result = new Response(stream); result.json = () => { throw new Error('expected bounded reader'); }; return result;
    }
    globalThis.fetch = async (input, init) => { const path = new URL(String(input)).pathname; calls.push(path);
      if (init.headers.Cookie !== 'fixture=session' || init.cache !== 'no-store' || init.redirect !== 'manual') throw new Error('private transport changed');
      if (init.signal !== signal) throw new Error('BFF signal not forwarded'); return response(path); };
    const { loadSecurityPage, loadPasskeyInventory } = await import('./apps/auth/src/security-inventory.ts');
    const { readRegistrationPage } = await import('./apps/auth/src/registration-page.ts');
    const { loadPasswordChangeLimits, reviewPasskeyRegistration } = await import('./apps/auth/src/security.ts');
    expect((await loadSecurityPage()).kind).toBe('ready');
    expect((await loadPasskeyInventory()).ok).toBe(true);
    expect((await readRegistrationPage()).kind).toBe('already-signed-in');
    expect(await loadPasswordChangeLimits()).toEqual({ minLength: 10, maxLength: Number.MAX_SAFE_INTEGER });
    expect((await reviewPasskeyRegistration(id)).kind).toBe('ready');
    expect(calls).toEqual(['/security-page', '/passkeys', '/registration-page', '/registration-page', '/session', '/passkeys', '/session']);
    for (const failure of ['overflow', 'unreadable', 'different']) {
      for (const stage of failure === 'different' ? [2] : [1, 2]) {
        mode = failure; target = '/session'; failSession = stage; sessionReads = 0; calls.length = 0;
        expect(await reviewPasskeyRegistration(id)).toEqual({ kind: failure === 'different' ? 'denied' : 'unavailable' });
        expect(calls).toEqual(stage === 1 ? ['/session'] : ['/session', '/passkeys', '/session']);
      }
    }
    failSession = 0;
    const parse = JSON.parse; let parses = 0; JSON.parse = (...args) => { parses++; return parse(...args); };
    for (const [path, read] of [['/security-page', loadSecurityPage], ['/passkeys', loadPasskeyInventory],
      ['/registration-page', readRegistrationPage], ['/registration-page', loadPasswordChangeLimits]]) {
      mode = 'overflow'; target = path; const before = parses, result = await read(); expect(parses).toBe(before);
      if (path === '/security-page') expect(result.kind).toBe('unavailable');
      else if (path === '/passkeys') expect(result).toEqual({ ok: false });
      else if (result !== null && result.kind !== 'unavailable') throw new Error('registration overflow must be unavailable');
    }
    JSON.parse = parse;
    const timer = globalThis.setTimeout; let held;
    globalThis.setTimeout = (fn, ms, ...args) => ms === 5000 ? (timers++, expire = fn, held = timer(() => {}, 60000).unref()) : timer(fn, ms, ...args);
    for (const stage of [1, 2]) {
      for (const retire of [false, true]) {
        mode = 'stalled'; target = '/session'; failSession = stage; sessionReads = 0; calls.length = 0; timers = 0;
        started = Promise.withResolvers(); const life = new AbortController();
        const pending = reviewPasskeyRegistration(id, life.signal); await started.promise; expect(timers).toBe(1);
        if (retire) life.abort(); else expire();
        expect(await pending).toEqual({ kind: 'unavailable' });
        expect(calls).toEqual(stage === 1 ? ['/session'] : ['/session', '/passkeys', '/session']);
      }
    }
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async () => { started.resolve(); return new Promise(() => {}); };
    started = Promise.withResolvers(); const ignored = reviewPasskeyRegistration(id); await started.promise; expire();
    expect(await ignored).toEqual({ kind: 'unavailable' }); globalThis.fetch = nativeFetch;
    mode = 'overflow'; target = '/passkeys'; failSession = 0; calls.length = 0;
    expect(await reviewPasskeyRegistration(id)).toEqual({ kind: 'unavailable' });
    expect(calls).toEqual(['/session', '/passkeys']);
    failSession = 0;
    mode = 'stalled'; target = '/security-page'; started = Promise.withResolvers();
    const retired = new AbortController(), before = calls.length, priorCancel = cancelled, pending = loadSecurityPage(retired.signal);
    await started.promise; retired.abort(); expect(await pending).toEqual({ kind: 'unavailable' });
    expect(cancelled).toBe(priorCancel + 1); expect(calls.length).toBe(before + 1);
    started = Promise.withResolvers(); const timed = new AbortController(), deadlineBefore = calls.length, cancelBefore = cancelled;
    const deadline = loadSecurityPage(timed.signal); await started.promise; expire();
    expect(await deadline).toEqual({ kind: 'unavailable' }); expect(timed.signal.aborted).toBe(false);
    expect(cancelled).toBe(cancelBefore + 1); expect(calls.length).toBe(deadlineBefore + 1);
    globalThis.setTimeout = timer; clearTimeout(held);
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text(),
    error = await new Response(child.stderr).text();
  expect(await child.exited, output + error).toBe(0);
});
