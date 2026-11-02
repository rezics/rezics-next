import { expect, test } from 'bun:test';
import { approval, button, fill, flush, leave, open, send } from './creation-page-fixture';
import { AutomatedAccountCreatePage } from '../src/routes/automated.new';
import { AUTOMATED_PROFILE, createAutomatedAttempt, restoreAutomatedAttempt, saveAutomatedAttempt } from '../src/automated-account-create';
const human = '11111111-1111-4111-8111-111111111111';
const operator = { id: '22222222-2222-4222-8222-222222222222', kind: 'organization' as const, handle: 'operator', displayName: null };
const initial = { kind: 'ready' as const, accountId: human, clientId: AUTOMATED_PROFILE.client_id, scopes: AUTOMATED_PROFILE.scope, authTime: Math.floor(Date.now() / 1000), authnEpoch: 1, amr: ['pwd' as const] };
const body = { account_id: human, client_id: initial.clientId, scope: initial.scopes, auth_time: initial.authTime, authn_epoch: 1, amr: initial.amr };
const confirm = async (host: HTMLElement) => {
  await flush(() => host.querySelector<HTMLInputElement>('#automated-confirm')!.click());
  await flush(() => send(host));
};

test('retry restores exact parties and key, then step-up and uncertain replay still require confirmation', async () => {
  const attempt = createAutomatedAttempt(human, operator, 'robot-one')!;
  expect(saveAutomatedAttempt(attempt)).toBe(true);
  const page = await open(<AutomatedAccountCreatePage initial={{ kind: 'unavailable' }} />, { ...body });
  await flush(() => button(page.host, 'Retry')!.click());
  expect(page.host.textContent).toContain('robot-one');
  expect(page.host.textContent).toContain(operator.id);
  expect(page.calls).toHaveLength(0);
  await confirm(page.host);
  await flush(() => page.calls[0]!.resolve(Response.json({ error: 'step_up_required' }, { status: 401 })));
  await flush(() => { fill(page.host.querySelector('#automated-email')!, 'human@example.com'); fill(page.host.querySelector('#automated-password')!, 'secret'); });
  await flush(() => send(page.host));
  await flush(() => page.calls[1]!.resolve(Response.json({})));
  expect(page.host.querySelector<HTMLInputElement>('#automated-confirm')!.checked).toBe(false);
  expect(page.calls).toHaveLength(2);
  await confirm(page.host);
  await flush(() => page.calls[2]!.resolve(approval()));
  await flush(() => page.calls[3]!.resolve(Response.json({ error: 'uncertain' }, { status: 503 })));
  expect(page.host.textContent).toContain('The result is uncertain');
  await confirm(page.host);
  await flush(() => page.calls[4]!.resolve(approval()));
  await flush(() => page.calls[5]!.resolve(Response.json({ accountId: operator.id })));
  for (const call of page.calls.filter((call) => call.path.startsWith('/account-operations/'))) {
    expect(call.body.operationKey).toBe(attempt.operationKey);
    expect(call.body.operation).toEqual(attempt.operation);
  }
  expect(page.host.textContent).toContain(operator.id);
  expect(restoreAutomatedAttempt()).toMatchObject({ operationKey: attempt.operationKey });
});

for (const stage of ['review', 'approval', 'signin'] as const) test(`departure retires pending ${stage} without changing a replacement attempt`, async () => {
  const page = await open(<AutomatedAccountCreatePage initial={initial} />, { ...body });
  if (stage === 'review') {
    await flush(() => { fill(page.host.querySelector('#automated-operator')!, operator.id); fill(page.host.querySelector('#automated-handle')!, 'old-robot'); });
    await flush(() => send(page.host));
  } else {
    expect(saveAutomatedAttempt(createAutomatedAttempt(human, operator, 'old-robot')!)).toBe(true);
    await page.render(<AutomatedAccountCreatePage key="resume" initial={initial} />);
    await confirm(page.host);
    if (stage === 'signin') {
      await flush(() => page.calls[0]!.resolve(Response.json({ error: 'step_up_required' }, { status: 401 })));
      await flush(() => { fill(page.host.querySelector('#automated-email')!, 'human@example.com'); fill(page.host.querySelector('#automated-password')!, 'secret'); });
  await flush(() => send(page.host));
    }
  }
  await flush(leave);
  window.sessionStorage.clear();
  const replacement = createAutomatedAttempt(human, operator, 'new-robot')!;
  expect(saveAutomatedAttempt(replacement)).toBe(true);
  await page.render(<AutomatedAccountCreatePage initial={{ ...initial }} />);
  await flush(() => page.calls.at(-1)!.resolve(stage === 'review' ? Response.json(operator) : stage === 'approval' ? approval() : Response.json({})));
  expect(restoreAutomatedAttempt()).toEqual(replacement);
  expect(page.host.textContent).toContain('new-robot');
  expect(page.host.textContent).not.toContain('old-robot');
  expect(page.host.querySelector<HTMLInputElement>('#automated-confirm')!.checked).toBe(false);
  expect(page.calls).toHaveLength(stage === 'signin' ? 2 : 1);
});
