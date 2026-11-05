import { expect, test } from 'bun:test';
import { MembershipRosterNavigation } from '../src/organization-membership-roster';

test('failed First preserves accepted history; retry applies the same transition only after acceptance', () => {
  const navigation = new MembershipRosterNavigation();
  navigation.accept(navigation.request('reload'));
  navigation.accept(navigation.request('next', 'opaque/+='));
  const accepted = navigation.state;
  const first = navigation.request('first');
  expect(navigation.state.cursor).toBe('opaque/+=');
  expect(navigation.state.previous).toBe(accepted.previous);
  expect(navigation.request('retry')).toBe(first);
  navigation.accept(first);
  expect(navigation.state.cursor).toBeUndefined();
  expect(navigation.state.previous).toEqual([]);
});

test('whole ordinary call includes route proof and both installed bounded source preparations; disclosure adds none', async () => {
  // Isolate server-function runtime adaptation from the mounted tests' source spy.
  const script = `
    import { mock } from 'bun:test';
    mock.module('@tanstack/react-start', () => ({ createServerFn: () => {
      let validate = value => value;
      const builder = { validator(fn) { validate = fn; return builder; },
        handler(fn) { return ({ data }) => fn({ data: validate(data) }); } };
      return builder;
    } }));
    mock.module('@tanstack/react-start/server', () => ({
      getRequest: () => new Request('https://auth.test/organizations/members', { headers: { Origin: 'https://auth.test' } }),
      setResponseHeader() {},
    }));
    globalThis.__AUTH_ORIGIN__ = '';
    const { loadMembershipPage, membershipProfile } = await import('./apps/auth/src/organization-membership');
    const { loadAccountSession } = await import('./apps/auth/src/account-operations');
    const [org, account] = [1, 2].map(n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'));
    const profile = membershipProfile(); const calls = [];
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input), 'https://auth.test').pathname;
      calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
      return Response.json(path === '/session' ? { account_id: account, client_id: profile.client_id, scope: profile.scope } :
        { organizationId: org, viewer: { accountId: account, role: 'owner', leave: 'unavailable' }, members: { state: 'ready', holders: [], next: null } });
    };
    const session = await loadAccountSession();
    const page = await loadMembershipPage(org, session.accountId, 'opaque/+=');
    console.log(JSON.stringify({ kind: page.kind, calls }));
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
  const result = JSON.parse(output);
  expect(result.kind, output).toBe('ready');
  expect(result.calls.map((call: { path: string }) => call.path)).toEqual([
    '/session',
    '/session',
    '/account-management/organizations/page',
  ]);
  expect(result.calls.at(-1).body.cursor).toBe('opaque/+=');
});
