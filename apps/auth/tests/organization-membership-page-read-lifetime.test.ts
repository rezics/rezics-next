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
    mock.module('@tanstack/react-start', () => ({ createServerFn: () => {
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
