import { expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { creationFixture, approval, dom, fill, flush, open, send, session } from './creation-page-fixture';
import { NewOrganizationPage } from '../src/routes/organizations.new';
import {
  readPendingAccountOperationStepUp,
  storePendingAccountOperationStepUp,
  clearPendingAccountOperationStepUp,
} from '../src/account-operation-step-up';
creationFixture();
const initial = session('organization');
const body = { account_id: initial.accountId, client_id: initial.clientId, scope: initial.scopes };
const view = () => createElement(NewOrganizationPage, { initial });
const unload = () => {
  const event = new dom.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event as unknown as Event);
  return event.defaultPrevented;
};
for (const [code, status] of [
  ['account_operation_denied', 409],
  ['platform_closed', 403],
  ['unavailable', 503],
  ['step_up_required', 401],
] as const)
  test(`lost execution followed by ${code} retains the original attempt`, async () => {
    const page = await open(view(), body);
    const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
    try {
      await flush(() => fill(page.host.querySelector('input')!, 'team-alpha'));
      await flush(() => send(page.host));
      await flush(() => page.calls[0]!.resolve(approval()));
      await flush(() => page.calls[1]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
      const original = readPendingAccountOperationStepUp();
      await flush(() => send(page.host));
      expect(page.calls[2]!.body.operationKey).toBe(original!.operationKey);
      await flush(() => page.calls[2]!.resolve(Response.json({ error: code }, { status })));
      if (status === 503) await flush(() => page.calls[3]!.resolve(Response.json({ error: code }, { status })));
      expect(readPendingAccountOperationStepUp()).toEqual(original);
      const input = page.host.querySelector<HTMLInputElement>('input')!;
      expect([input.value, input.readOnly]).toEqual(['team-alpha', true]);
      if (status !== 401) {
        expect(page.host.textContent).toContain('creation result is still unknown');
        expect(unload()).toBe(true);
      } else expect(assign).toHaveBeenCalledTimes(1);
      if (status === 409 || status === 403) {
        expect(page.host.textContent).toContain(status === 409 ? 'Creation was refused' : 'not open yet');
        expect(page.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
        await flush(() => send(page.host));
        expect(page.calls).toHaveLength(3);
      }
    } finally {
      assign.mockRestore();
    }
  });
test('a known first refusal releases its hint; a restored unsent hint stays conservative', async () => {
  const page = await open(view(), body);
  await flush(() => fill(page.host.querySelector('input')!, 'team-alpha'));
  await flush(() => send(page.host));
  await flush(() => page.calls[0]!.resolve(Response.json({ error: 'account_operation_denied' }, { status: 409 })));
  expect(readPendingAccountOperationStepUp()).toBeNull();
  expect(page.host.querySelector<HTMLInputElement>('input')!.readOnly).toBe(false);
  expect(page.host.textContent).not.toContain('creation result is still unknown');
  storePendingAccountOperationStepUp({
    kind: 'organization',
    accountId: initial.accountId,
    operationKey: 'a'.repeat(32),
    operation: { kind: 'organization', handle: 'retained-team' },
    submitted: false,
  });
  await page.render(createElement(NewOrganizationPage, { key: 'restored', initial }));
  expect(page.host.textContent).toContain('creation result is still unknown');
  expect(page.host.querySelector<HTMLInputElement>('input')!.value).toBe('retained-team');
  expect(page.host.querySelector<HTMLInputElement>('input')!.readOnly).toBe(true);
  expect(page.calls).toHaveLength(1);
  expect(unload()).toBe(true);
  clearPendingAccountOperationStepUp();
  await flush(() => send(page.host));
  expect(page.calls).toHaveLength(1);
  expect(page.host.textContent).toContain('creation result is still unknown');
});
