import { expect, test } from 'bun:test';
import {
  creationFixture,
  automatedOperatorPage,
  approval,
  button,
  fill,
  flush,
  leave,
  open,
  send,
} from './creation-page-fixture';
import { AutomatedAccountCreatePage } from '../src/routes/automated.new';
import {
  AUTOMATED_PROFILE,
  createAutomatedAttempt,
  restoreAutomatedAttempt,
  saveAutomatedAttempt,
} from '../src/automated-account-create';
creationFixture();
const human = '11111111-1111-4111-8111-111111111111';
const operator = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'organization' as const,
  handle: 'operator',
  displayName: null,
};
const body = {
  account_id: human,
  client_id: AUTOMATED_PROFILE.client_id,
  scope: AUTOMATED_PROFILE.scope,
  auth_time: Math.floor(Date.now() / 1000),
  authn_epoch: 1,
  amr: ['pwd'],
};
const confirm = async (host: HTMLElement) => {
  await flush(() => host.querySelector<HTMLInputElement>('#automated-confirm')!.click());
  await flush(() => send(host));
};
async function authenticate(host: HTMLElement) {
  await flush(() => {
    fill(host.querySelector('#automated-email')!, 'human@example.com');
    fill(host.querySelector('#automated-password')!, 'secret');
  });
  await flush(() => send(host));
}
test('retry restores exact parties and key without creating until explicit confirmation', async () => {
  const attempt = createAutomatedAttempt(human, operator, 'robot-one')!;
  expect(saveAutomatedAttempt(attempt)).toBe(true);
  const page = await open(<AutomatedAccountCreatePage initial={{ kind: 'unavailable' }} />, { ...body });
  await flush(() => button(page.host, 'Retry')!.click());
  expect(page.host.textContent).toContain('robot-one');
  expect(page.host.textContent).toContain(operator.id);
  expect(page.calls).toHaveLength(0);
  await confirm(page.host);
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(Response.json({ accountId: operator.id })));
  for (const call of page.calls.filter((call) => call.path.startsWith('/account-operations/'))) {
    expect(call.body).toMatchObject({ operationKey: attempt.operationKey, operation: attempt.operation });
  }
  expect(page.host.textContent).toContain('The native creation workflow returned account');
});
for (const stage of ['review', 'approval', 'signin'] as const)
  test(`departure retires pending ${stage} without changing a replacement attempt`, async () => {
    const page = await open(<AutomatedAccountCreatePage />, { ...body });
    if (stage === 'review') {
      await flush(() => {
        fill(page.host.querySelector('#automated-operator')!, operator.id);
        fill(page.host.querySelector('#automated-handle')!, 'old-robot');
      });
      await flush(() => send(page.host));
    } else {
      expect(saveAutomatedAttempt(createAutomatedAttempt(human, operator, 'old-robot')!)).toBe(true);
      await page.render(<AutomatedAccountCreatePage key="resume" />);
      await confirm(page.host);
      if (stage === 'signin') {
        await flush(() => page.calls[0]!.resolve(Response.json({ error: 'step_up_required' }, { status: 401 })));
        await authenticate(page.host);
      }
    }
    await flush(leave);
    window.sessionStorage.clear();
    const replacement = createAutomatedAttempt(human, operator, 'new-robot')!;
    expect(saveAutomatedAttempt(replacement)).toBe(true);
    await page.render(<AutomatedAccountCreatePage key="replacement" />);
    await flush(() =>
      page.calls
        .at(-1)!
        .resolve(
          stage === 'review'
            ? automatedOperatorPage(human, operator)
            : stage === 'approval'
              ? approval()
              : Response.json({}),
        ),
    );
    expect(restoreAutomatedAttempt()).toEqual(replacement);
    expect(page.host.textContent).toContain('new-robot');
    expect(page.host.querySelector<HTMLInputElement>('#automated-confirm')!.checked).toBe(false);
    expect(page.calls).toHaveLength(stage === 'signin' ? 2 : 1);
  });
