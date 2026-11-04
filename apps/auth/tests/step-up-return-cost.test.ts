import { expect, spyOn, test } from 'bun:test';
import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { creationFixture } from './creation-page-fixture';
import { managementOperationStepUpUrl, storePendingRenameReviewStepUp } from '../src/management-operation-step-up';
import { managementOperationProfile } from '../src/management-operations';
import { recheckStepUpReturn } from '../src/step-up-return';

creationFixture();

test('ordinary and retained reviews stay within their existing whole-call reads', async () => {
  const accountId = '00000000-0000-4000-8000-000000000031';
  const profile = managementOperationProfile('rename');
  const calls: { path: string; method: string; body: unknown }[] = [];
  const request = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    calls.push({
      path,
      method: String(init?.method ?? 'GET'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (path === '/recovery/page')
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
    if (path === '/session')
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
    throw new Error(`unexpected request ${path}`);
  });

  const ordinary = await recheckStepUpReturn(
    '?return_to=%2Fsecurity',
    'https://auth.test',
    new AbortController().signal,
    () => true,
  );
  expect(ordinary).toEqual({ kind: 'continue', target: 'https://auth.test/security' });
  expect(calls).toEqual([{ path: '/recovery/page', method: 'POST', body: { stage: 'step-up' } }]);

  calls.length = 0;
  expect(storePendingRenameReviewStepUp(accountId)).toBe(true);
  const query = new URL(managementOperationStepUpUrl('rename'), 'https://auth.test').search;
  const retained = await recheckStepUpReturn(query, 'https://auth.test', new AbortController().signal, () => true);
  const expected = new URL(managementOperationStepUpUrl('rename'), 'https://auth.test').searchParams.get('return_to');
  expect(retained).toEqual({ kind: 'continue', target: new URL(expected!, 'https://auth.test').href });
  expect(calls.map(({ path, method }) => [path, method])).toEqual([
    ['/recovery/page', 'POST'],
    ['/session', 'GET'],
  ]);
  expect(calls.some(({ path }) => path === '/signin' || path.includes('/execute') || path.includes('/approve'))).toBe(
    false,
  );
  request.mockRestore();
});
