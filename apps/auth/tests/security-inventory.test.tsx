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
