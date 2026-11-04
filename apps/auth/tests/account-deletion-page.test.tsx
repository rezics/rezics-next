import { expect, spyOn, test } from 'bun:test';
import { DeleteAccountContent } from '../src/routes/account.delete';
import { creationFixture, open, button, flush, fill, send, dom } from './creation-page-fixture';
import { emptyInventory } from '../src/stories/accounts-operations/story';
import { readPendingAccountOperationStepUp } from '../src/account-operation-step-up';
creationFixture();
const review = {
  kind: 'review' as const,
  accountId: 'self',
  email: 'person@example.test',
  action: 'available' as const,
  policy: 'personal-deletion' as const,
};
const props = { privacyContact: 'mailto:privacy@example.test', inventorySource: emptyInventory };

test('direct ordinary visit authenticates without confirmation or approval and returns to fresh review', async () => {
  const page = await open(<DeleteAccountContent {...props} />, { kind: 'authentication-required', accountId: 'self' });
  expect(page.host.querySelector('input')).toBeNull();
  expect(page.host.textContent).not.toContain('person@example.test');
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    await flush(() => button(page.host, 'Authenticate and return to review')!.click());
    expect(assign).toHaveBeenCalledWith('/step-up?account_operation=delete&return_to=%2Faccount%2Fdelete');
    const saved = readPendingAccountOperationStepUp()!;
    expect(saved.submitted).toBe(false);
    expect(page.calls).toHaveLength(0);
    await page.render(<DeleteAccountContent key="returned" {...props} initial={review} />);
    expect(page.host.querySelector('input')!.value).toBe('');
    expect(button(page.host, 'Delete account')!.disabled).toBe(true);
    expect(page.host.textContent).toContain('No action has been executed by returning here');
    const departure = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(departure);
    expect(departure.defaultPrevented).toBe(false);
    await flush(() => {
      fill(page.host.querySelector('input')!, ' DELETE MY ACCOUNT ');
      send(page.host);
    });
    expect(page.calls[0]!.body.operationKey).toBe(saved.operationKey);
    await flush(() => page.calls[0]!.resolve(Response.json({ error: 'account_operation_denied' }, { status: 403 })));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(page.host.querySelector('input')).toBeNull();
    expect(page.host.textContent).not.toContain('person@example.test');
  } finally {
    assign.mockRestore();
  }
});

test('native refusal cannot authenticate or submit; dependency retry renews review without creating an operation', async () => {
  const page = await open(<DeleteAccountContent {...props} initial={{ ...review, action: 'refused' }} />, review);
  expect(page.host.querySelector('input')).toBeNull();
  expect(button(page.host, 'Delete account')!.disabled).toBe(true);
  expect(button(page.host, 'Authenticate and return to review')).toBeUndefined();
  await page.render(<DeleteAccountContent key="unavailable" {...props} initial={{ kind: 'unavailable' }} />);
  await flush(() => button(page.host, 'Retry')!.click());
  expect(page.host.querySelector('input')!.value).toBe('');
  expect(page.calls).toHaveLength(0);
  expect(readPendingAccountOperationStepUp()).toBeNull();
});
