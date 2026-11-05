import { expect, test } from 'bun:test';

test('production browser membership read bounds ignored cancellation and preserves deliberate exact retry', async () => {
  // Isolate the BFF transport adapter from mounted route spies in other files.
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { expect, mock, spyOn } from 'bun:test';
    let complete; const calls = [];
    mock.module('@tanstack/react-start', () => ({ createServerOnlyFn: fn => fn, createServerFn: () => {
      const builder = { validator() { return builder; }, handler() {
        return options => { calls.push(options); return complete(options); };
      } }; return builder;
    } }));
    const { loadMembershipPage } = await import('./apps/auth/src/organization-membership');
    const [org, account] = [1, 2].map(n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'));
    const cursor = 'opaque/+cursor=';
    const ready = { kind: 'ready', organizationId: org,
      viewer: { accountId: account, role: 'owner', leave: 'unavailable' },
      members: { state: 'ready', holders: [], next: null } };
    const timer = spyOn(globalThis, 'setTimeout');
    const caller = new AbortController(); caller.abort();
    expect(await loadMembershipPage(org, account, cursor, caller.signal)).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(0);
    timer.mockClear();
    const late = Promise.withResolvers(); complete = () => late.promise;
    const pending = loadMembershipPage(org, account, cursor);
    await Promise.resolve();
    expect(timer.mock.calls.map(call => call[1])).toEqual([5000]);
    timer.mock.calls[0][0]();
    expect(await pending).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(1);
    expect(calls[0].signal.aborted).toBe(true);
    complete = async () => ready;
    expect(await loadMembershipPage(org, account, cursor)).toEqual(ready);
    expect(calls.map(call => call.data)).toEqual(Array(2).fill({ organizationId: org, accountId: account, cursor }));
    late.resolve({ kind: 'denied' });
    const cancelled = new AbortController(); complete = () => new Promise(() => {});
    const reading = loadMembershipPage(org, account, cursor, cancelled.signal);
    await Promise.resolve(); cancelled.abort();
    expect(await reading).toEqual({ kind: 'unavailable' });
    expect(calls.at(-1).signal.aborted).toBe(true);
    for (const kind of ['denied', 'unavailable']) {
      complete = async () => ({ kind });
      expect(await loadMembershipPage(org, account, cursor)).toEqual({ kind });
    }
    complete = async () => { throw new Error('BFF transport rejected'); };
    expect(await loadMembershipPage(org, account, cursor)).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(6);
    timer.mockRestore();
  `,
    ],
    { cwd: `${import.meta.dir}/../../..`, stdout: 'pipe', stderr: 'pipe' },
  );
  const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, output + error).toBe(0);
});

test('installed roster phases and selected receiving bound native streams before parsing without retries', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { expect, mock } from 'bun:test';
    let request;
    mock.module('@tanstack/react-start', () => ({ createServerOnlyFn: fn => fn, createServerFn: () => {
      const b = { validator() { return b; }, handler(fn) { return options => {
        request = new Request('https://auth.test/bff', { headers: { origin: 'https://auth.test' }, signal: options?.signal });
        return fn({ data: options?.data });
      }; } }; return b;
    } }));
    mock.module('@tanstack/react-start/server', () => ({ getRequest: () => request, setResponseHeader() {} }));
    mock.module('cloudflare:workers', () => ({ env: { AUTH_SECURITY_SCOPE_CONFIGURATION: 'native-no-catalogue' } }));
    const { loadMembershipPage, loadSelectedMembership } = await import('./apps/auth/src/organization-membership');
    const { membershipResponseBytes } = await import('@rezics/auth-contract');
    const [org, account, reservationId] = [1,2,3].map(n => '00000000-0000-4000-8000-' + String(n).padStart(12,'0'));
    let calls = []; let mode = 'ready'; let cancel;
    const selected = { organizationId: org, memberAccountId: account, membership: { role: 'member', reservationId } };
    const page = { organizationId: org, viewer: { accountId: account, role: 'owner', leave: 'allowed' },
      members: { state: 'ready', items: [], next: 'é' } };
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/session')) {
        if (mode === 'cancel') cancel.abort();
        return Response.json({ account_id: account });
      }
      if (mode === 'stall') return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
      if (mode === 'overflow') return new Response(' '.repeat(membershipResponseBytes.selected + 1), { headers: { 'Content-Length': '1' } });
      if (mode === 'invalid') return Response.json({ ...selected, membership: {} });
      const value = String(url).endsWith('/member') ? selected : page;
      if (mode === 'null') value.membership = null;
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      return new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } }));
    };
    expect((await loadMembershipPage(org, account)).kind).toBe('ready');
    expect(calls).toHaveLength(2);
    expect(calls[0].init.signal).toBe(calls[1].init.signal);
    calls = []; cancel = new AbortController(); mode = 'cancel';
    expect(await loadMembershipPage(org, account, undefined, cancel.signal)).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(1);
    mode = 'ready'; calls = [];
    expect((await loadSelectedMembership(org, account)).membership).toEqual(selected.membership);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.body).toBe(JSON.stringify({ organizationId: org, memberAccountId: account }));
    mode = 'null'; expect((await loadSelectedMembership(org, account)).membership).toBeNull();
    for (mode of ['overflow', 'invalid']) {
      calls = []; expect(await loadSelectedMembership(org, account)).toEqual({ kind: 'unavailable' }); expect(calls).toHaveLength(1);
    }
    mode = 'stall'; calls = []; const caller = new AbortController();
    const pending = loadSelectedMembership(org, account, caller.signal);
    await new Promise(resolve => setTimeout(resolve, 0)); caller.abort();
    expect(await pending).toEqual({ kind: 'unavailable' }); expect(calls).toHaveLength(1);
  `,
    ],
    { cwd: `${import.meta.dir}/../../..`, stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, out + err).toBe(0);
});
