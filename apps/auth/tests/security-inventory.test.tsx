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
