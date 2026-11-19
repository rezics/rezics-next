import { expect, spyOn, test } from 'bun:test';
import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { creationFixture } from './creation-page-fixture';
import { managementOperationStepUpUrl, storePendingRenameReviewStepUp } from '../src/management-operation-step-up';
import { managementOperationProfile } from '@rezics/auth-contract';

creationFixture();
// Bind the server-function handlers after the fixture installs Start's test bridge.
const { recheckStepUpReturn } = await import('../src/step-up-return');
const { confirmStepUp } = await import('../src/step-up');

const returnCostTest = 'ordinary and retained reviews stay within their existing whole-call reads';
test(returnCostTest, async () => {
  // Opening tests can cache management-operations with Start's real handler before this bridge loads.
  if (process.env.REZICS_STEP_UP_RETURN_COST_CHILD !== '1') {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path, '--test-name-pattern', returnCostTest], {
      env: { ...process.env, REZICS_STEP_UP_RETURN_COST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
    return;
  }

  const accountId = '00000000-0000-4000-8000-000000000031';
  const profile = managementOperationProfile('rename');
  const calls: { url: string; method: string; body: unknown; cookie: string | null }[] = [];
  using request = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: String(init?.method ?? 'GET'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      cookie: new Headers(init?.headers).get('Cookie'),
    });
    if (url === '/recovery/page')
      return Promise.resolve(
        Response.json(
          recoveryPage(
            'step-up',
            { minPasswordLength: 8, maxPasswordLength: 128 },
            {
              kind: 'signed-in',
              account_id: accountId,
              email: 'current@example.test',
            },
          ),
        ),
      );
    if (url === 'https://auth.test/session')
      return Promise.resolve(
        Response.json({
          account_id: accountId,
          client_id: profile.client_id,
          scope: profile.scope,
          authn_epoch: 1,
          auth_time: Math.floor(Date.now() / 1000),
          amr: ['pwd'],
        }),
      );
    throw new Error(`unexpected request ${url}`);
  });

  const ordinary = await recheckStepUpReturn(
    '?return_to=%2Fsecurity',
    'https://auth.test',
    new AbortController().signal,
    () => true,
  );
  expect(ordinary).toEqual({ kind: 'continue', target: 'https://auth.test/security' });
  const adviceRead = { url: '/recovery/page', method: 'POST', body: { stage: 'step-up' }, cookie: null };
  expect(calls).toEqual([adviceRead]);

  calls.length = 0;
  expect(storePendingRenameReviewStepUp(accountId)).toBe(true);
  const query = new URL(managementOperationStepUpUrl('rename'), 'https://auth.test').search;
  const retained = await recheckStepUpReturn(query, 'https://auth.test', new AbortController().signal, () => true);
  expect(calls).toEqual([
    adviceRead,
    { url: 'https://auth.test/session', method: 'GET', body: null, cookie: 'auth_session=original' },
  ]);
  expect(retained).toEqual({ kind: 'continue', target: 'https://auth.test/account/rename' });
});

test.each([
  ['?return_to=%2Fsecurity', 'rezics-auth-account-management', ['account:manage']],
  ['?client_id=website&return_to=%2Fsecurity', 'login', []],
] as const)(
  'step-up uses the selected scope and reports native suspension after one request (%s)',
  async (query, client, scopes) => {
    const paths: string[] = [];
    const profiles: unknown[] = [];
    const request = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      paths.push(String(input));
      const { client_id, scope } = JSON.parse(String(init?.body));
      profiles.push({ client_id, scope });
      return Promise.resolve(Response.json({ error: 'account_suspended', code: 'ACCOUNT_SUSPENDED' }, { status: 403 }));
    });
    const events: string[] = [];
    try {
      const result = await confirmStepUp(
        'person@example.test',
        'private password',
        query,
        'https://auth.test',
        () => true,
        {
          onDispatch: () => events.push('dispatched'),
          onRefused: () => events.push('refused'),
          onAcknowledged: () => events.push('acknowledged'),
        },
      );
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.message).not.toBeNull();
      expect(events).toEqual(['dispatched', 'refused']);
      expect(paths).toEqual(['/signin']);
      expect(profiles).toEqual([{ client_id: client, scope: scopes }]);
    } finally {
      request.mockRestore();
    }
  },
);
