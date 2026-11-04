import { expect, test } from 'bun:test';
import { creationFixture, approval, button, dom, fill, flush, leave, open, send, session } from './creation-page-fixture';
import { NewOrganizationPage } from '../src/routes/organizations.new';
import {
  readPendingAccountOperationStepUp,
  storePendingAccountOperationStepUp,
} from '../src/account-operation-step-up';
creationFixture();
const initial = session('organization');
const body = { account_id: initial.accountId, client_id: initial.clientId, scope: initial.scopes };

test('a fresh signed-out page keeps its sign-in exit', async () => {
  const page = await open(<NewOrganizationPage initial={{ kind: 'signed-out' }} />, body);
  expect(page.host.querySelector('a[href="/login"]')).not.toBeNull();
});

test('read Retry is separate from same-key command retry and a later refusal keeps unknown history', async () => {
  const page = await open(<NewOrganizationPage initial={initial} />, body);
  await flush(() => fill(page.host.querySelector('input')!, 'team-alpha'));
  await flush(() => send(page.host));
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  const original = readPendingAccountOperationStepUp()!;
  expect(page.host.textContent).toContain('creation result is still unknown');
  expect(button(page.host, 'Check current advice')).not.toBeNull();
  expect(button(page.host, 'Retry this creation')).not.toBeNull();

  await flush(() => button(page.host, 'Check current advice')!.click());
  expect(page.calls).toHaveLength(2);
  expect(page.host.querySelector<HTMLInputElement>('input')!.value).toBe('team-alpha');
  expect(page.host.querySelector<HTMLInputElement>('input')!.readOnly).toBe(true);
  expect(document.activeElement).toBe(page.host.querySelector('[data-organization-create-return]'));

  await flush(() => button(page.host, 'Retry this creation')!.click());
  expect(page.calls[2]!.body.operationKey).toBe(original.operationKey);
  expect(page.calls[2]!.body.operation).toEqual(original.operation);
  await flush(() => page.calls[2]!.resolve(approval()));
  await flush(() =>
    page.calls[3]!.resolve(Response.json({ error: 'account_operation_denied' }, { status: 403 })),
  );
  expect(page.host.textContent).toContain('creation result is still unknown');
  expect(page.host.textContent).toContain('Creation was refused');
  expect(readPendingAccountOperationStepUp()?.operationKey).toBe(original.operationKey);
});

async function beginUnknownReturn() {
  const page = await open(<NewOrganizationPage initial={initial} />, body);
  await flush(() => fill(page.host.querySelector('input')!, 'team-alpha'));
  await flush(() => send(page.host));
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  const original = readPendingAccountOperationStepUp()!;
  await flush(() => {
    leave();
    expect(page.host.querySelector('input')).toBeNull();
    expect(page.host.textContent).not.toContain('team-alpha');
  });
  return { page, original };
}

for (const storageChange of ['replaced', 'missing', 'malformed'] as const)
  test(`${storageChange} recovery data preserves generic unknown history without exposing a retry`, async () => {
    const { page, original } = await beginUnknownReturn();
    if (storageChange === 'replaced') {
      expect(storePendingAccountOperationStepUp({
        kind: 'organization',
        accountId: 'replacement-account',
        operationKey: original.operationKey,
        operation: { kind: 'organization', handle: 'other-team' },
      })).toBe(true);
    } else if (storageChange === 'missing') {
      window.sessionStorage.removeItem('rezics.account-operation.step-up');
    } else {
      window.sessionStorage.setItem('rezics.account-operation.step-up', '{');
    }
  const pageshow = new dom.Event('pageshow');
  Object.defineProperty(pageshow, 'persisted', { value: true });
  await flush(() => window.dispatchEvent(pageshow as unknown as Event));

  expect(page.host.querySelector('input')).toBeNull();
  expect(page.host.textContent).toContain('creation result is still unknown');
  expect(page.host.textContent).toContain('cannot be resumed safely');
  expect(page.host.textContent).not.toContain('team-alpha');
  expect(page.host.textContent).not.toContain('other-team');
  expect(button(page.host, 'Retry this creation')).toBeNull();
  expect(button(page.host, 'Check current advice')).not.toBeNull();
  if (storageChange === 'replaced')
    expect(readPendingAccountOperationStepUp()).toMatchObject({
      accountId: 'replacement-account',
      operationKey: original.operationKey,
    });
  else if (storageChange === 'missing')
    expect(window.sessionStorage.getItem('rezics.account-operation.step-up')).toBeNull();
  else expect(window.sessionStorage.getItem('rezics.account-operation.step-up')).toBe('{');
  expect(page.calls).toHaveLength(2);
  });
