import { expect, spyOn, test } from 'bun:test';
import { DeleteAccountContent } from '../src/routes/account.delete';
import { readPendingAccountOperationStepUp, storePendingAccountOperationStepUp } from '../src/account-operation-step-up';
import { operationKeyFor } from '../src/account-operations';
import { m } from '../src/paraglide/messages.js';
import { creationFixture, approval, button, fill, flush, open, send } from './creation-page-fixture';
import { emptyInventory } from '../src/stories/accounts-operations/story';
import type { AccountDeletionPage } from '../src/account-deletion-page';

creationFixture();

const review = {
  kind: 'review' as const,
  accountId: 'account-a',
  email: 'person@example.test',
  action: 'available' as const,
  policy: 'personal-deletion' as const,
};
const props = { privacyContact: 'mailto:privacy@example.test', inventorySource: emptyInventory };

async function unknownPage(source: (signal: AbortSignal) => Promise<AccountDeletionPage> = async () => review) {
  const page = await open(<DeleteAccountContent {...props} initial={review} source={source} />, review);
  await flush(() => {
    fill(page.host.querySelector<HTMLInputElement>('#account-delete-input')!, m.auth_account_delete_confirmation_phrase());
    send(page.host);
  });
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(Response.json({ malformed: true })));
  return page;
}

async function renewAndRepeat(page: Awaited<ReturnType<typeof unknownPage>>) {
  const original = page.calls[0]!.body;
  expect(page.host.textContent).toContain(m.auth_account_delete_recovery_title());
  expect(page.host.querySelector('#account-delete-input')).toBeNull();
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await flush(() => button(page.host, m.auth_account_delete_recovery_refresh())!.click());
  expect(page.calls).toHaveLength(2);
  const input = page.host.querySelector<HTMLInputElement>('#account-delete-input')!;
  expect(input.value).toBe('');
  await flush(() => {
    fill(input, m.auth_account_delete_confirmation_phrase());
    send(page.host);
  });
  expect(page.calls[2]!.body).toEqual(original);
  return original;
}

const laterResponses = [
  ['denial', () => Response.json({ error: 'account_operation_denied' }, { status: 403 }), 'account_operation_denied'],
  ['step-up', () => Response.json({ error: 'step_up_required' }, { status: 401 }), 'step-up'],
  ['unavailable', () => Response.json({ error: 'unavailable' }, { status: 503 }), 'unavailable'],
  ['platform closure', () => Response.json({ error: 'platform_closed' }, { status: 403 }), 'platform_closed'],
] as const;

test.each(laterResponses)('a later %s cannot replace the earlier unknown deletion', async (name, response, expected) => {
  const page = await unknownPage();
  const original = await renewAndRepeat(page);
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    await flush(() => page.calls[2]!.resolve(response()));
    if (name === 'unavailable') {
      expect(page.calls).toHaveLength(4);
      expect(page.calls[3]!.path).toBe('/account-operations/approve');
      expect(page.calls[3]!.body).toEqual(original);
      await flush(() => page.calls[3]!.resolve(response()));
    }
    expect(page.calls.filter((call) => call.path === '/account-operations/execute')).toHaveLength(1);
    expect(page.host.textContent).toContain(m.auth_account_delete_recovery_title());
    if (expected === 'account_operation_denied') expect(page.host.textContent).toContain(m.auth_account_delete_denied());
    if (expected === 'step-up') {
      expect(assign).toHaveBeenCalledWith('/step-up?account_operation=delete&return_to=%2Faccount%2Fdelete');
      expect(readPendingAccountOperationStepUp()?.submitted).toBe(true);
      expect(page.host.textContent).toContain(m.auth_account_delete_recovery_title());
    }
    if (expected === 'unavailable') expect(page.host.textContent).toContain(m.auth_account_operation_unavailable());
    if (expected === 'platform_closed') expect(page.host.textContent).toContain(m.auth_organization_not_open());
    expect(page.host.querySelector('#account-delete-input')).toBeNull();
  } finally {
    assign.mockRestore();
  }
});

test('same-turn submits share one approval and keep advice refresh closed while pending', async () => {
  const page = await open(<DeleteAccountContent {...props} initial={review} />, review);
  const input = page.host.querySelector<HTMLInputElement>('#account-delete-input')!;
  await flush(() => {
    fill(input, m.auth_account_delete_confirmation_phrase());
    send(page.host);
    send(page.host);
  });
  expect(page.calls).toHaveLength(1);
  expect(button(page.host, m.auth_account_delete_recovery_refresh())?.disabled).toBe(true);
});

for (const [name, nextAdvice] of [
  ['unavailable advice', { kind: 'unavailable' }],
  ['signout', { kind: 'signed-out' }],
  [
    'account replacement',
    { ...review, accountId: 'account-b', email: 'replacement@example.test' },
  ],
] as const)
  test(`${name} keeps mounted deletion uncertainty and retires private controls`, async () => {
    const page = await unknownPage(async () => nextAdvice);
    await flush(() => button(page.host, m.auth_account_delete_recovery_refresh())!.click());
    expect(page.host.textContent).toContain(m.auth_account_delete_recovery_title());
    expect(page.host.querySelector('#account-delete-input')).toBeNull();
    expect(page.host.textContent).not.toContain('person@example.test');
    expect(page.host.textContent).not.toContain('replacement@example.test');
    expect(page.calls).toHaveLength(2);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

test('a returned submitted hint stays uncertain without dispatching on mount', async () => {
  const operation = { kind: 'delete' as const, accountId: review.accountId };
  const operationKey = operationKeyFor(operation, review.accountId);
  storePendingAccountOperationStepUp({
    kind: 'delete',
    accountId: review.accountId,
    operationKey,
    operation,
    submitted: true,
  });
  const page = await open(<DeleteAccountContent {...props} initial={review} />, review);
  expect(page.calls).toHaveLength(0);
  expect(page.host.textContent).toContain(m.auth_account_delete_recovery_title());
  expect(page.host.textContent).toContain(m.auth_account_delete_recovery_precision());
  await flush(() => {
    fill(page.host.querySelector<HTMLInputElement>('#account-delete-input')!, m.auth_account_delete_confirmation_phrase());
    send(page.host);
  });
  expect(page.calls[0]!.body).toEqual({ operationKey, operation });
});
