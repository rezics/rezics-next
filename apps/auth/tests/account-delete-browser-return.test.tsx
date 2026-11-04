import type { AccountDeletionPage } from '../src/account-deletion-page';
import type { InventoryPage, InventoryView } from '../src/security-inventory';
import { expect, test } from 'bun:test';
import { readPendingAccountOperationStepUp } from '../src/account-operation-step-up';
import { DeleteAccountContent } from '../src/routes/account.delete';
import type { InventorySource } from '../src/security-inventory-view';
import { m } from '../src/paraglide/messages.js';
import { emptyInventory } from '../src/stories/accounts-operations/story';
import { approval, button, creationFixture, dom, fill, flush, leave, open, send } from './creation-page-fixture';

creationFixture();

const review: Extract<AccountDeletionPage, { kind: 'review' }> = {
  kind: 'review',
  accountId: 'account-a',
  email: 'private@example.test',
  action: 'available',
  policy: 'personal-deletion',
};
const props = { privacyContact: 'mailto:privacy@example.test', inventorySource: emptyInventory };

test('pagehide synchronously blanks confirmation and removes private review before its event returns', async () => {
  const page = await open(<DeleteAccountContent {...props} initial={review} />, review);
  const input = page.host.querySelector<HTMLInputElement>('#account-delete-input')!;
  await flush(() => fill(input, m.auth_account_delete_confirmation_phrase()));

  let inspected = false;
  window.addEventListener(
    'pagehide',
    () => {
      inspected = true;
      expect(input.value).toBe('');
      expect(page.host.querySelector('#account-delete-input')).toBeNull();
      expect(page.host.querySelector('[data-account-delete-private-review]')).toBeNull();
      expect(page.host.querySelector('[data-account-delete-identity]')).toBeNull();
      expect(page.host.querySelector('[data-account-deletion-return="unsent"]')).not.toBeNull();
      expect(page.host.textContent).not.toContain(review.email);
    },
    { once: true },
  );
  leave();
  expect(inspected).toBe(true);
  expect(document.activeElement).toBe(page.host.querySelector('[data-account-deletion-return="unsent"]'));
});

test('leaving during approval keeps a generic unsent history and prevents the late approval from executing', async () => {
  const page = await open(<DeleteAccountContent {...props} initial={review} />, review);
  await flush(() => {
    fill(
      page.host.querySelector<HTMLInputElement>('#account-delete-input')!,
      m.auth_account_delete_confirmation_phrase(),
    );
    send(page.host);
  });
  const saved = readPendingAccountOperationStepUp()!;
  expect(page.calls.map((call) => call.path)).toEqual(['/account-operations/approve']);

  leave();
  expect(page.host.querySelector('[data-account-deletion-return="unsent"]')).not.toBeNull();
  await flush(() => page.calls[0]!.resolve(approval()));
  expect(page.calls.map((call) => call.path)).toEqual(['/account-operations/approve']);
  expect(readPendingAccountOperationStepUp()).toEqual(saved);
});

test('unknown execution survives dismissal and a late acknowledgement without changing its exact descriptor', async () => {
  const page = await open(<DeleteAccountContent {...props} initial={review} />, review);
  await flush(() => {
    fill(
      page.host.querySelector<HTMLInputElement>('#account-delete-input')!,
      m.auth_account_delete_confirmation_phrase(),
    );
    send(page.host);
  });
  await flush(() => page.calls[0]!.resolve(approval()));
  const saved = readPendingAccountOperationStepUp()!;
  expect(page.calls.map((call) => call.path)).toEqual(['/account-operations/approve', '/account-operations/execute']);

  leave();
  expect(page.host.querySelector('[data-account-deletion-return="unknown"]')).not.toBeNull();
  await flush(() => button(page.host, m.auth_account_delete_return_dismiss())!.click());
  expect(page.host.querySelector('[data-account-deletion-return="unknown"]')).toBeNull();
  const unload = new dom.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);

  await flush(() => page.calls[1]!.resolve(Response.json({ accountId: review.accountId })));
  expect(readPendingAccountOperationStepUp()).toEqual(saved);
  expect(page.host.querySelector('#account-delete-input')).toBeNull();
  expect(page.host.textContent).not.toContain(m.auth_account_delete_success());
  expect(page.calls).toHaveLength(2);
});

test('retired native advice cannot restore identity when its held result arrives', async () => {
  const pending = Promise.withResolvers<AccountDeletionPage>();
  let reads = 0;
  const source = () => {
    reads++;
    return pending.promise;
  };
  const page = await open(<DeleteAccountContent privacyContact={props.privacyContact} source={source} />, review);
  expect(reads).toBe(1);
  leave();
  pending.resolve(review);
  await flush(() => {});
  expect(reads).toBe(1);
  expect(page.host.textContent).not.toContain(review.email);
  expect(page.host.querySelector('#account-delete-input')).toBeNull();
  expect(page.calls).toHaveLength(0);
});

test('retired inventory pages cannot restore private rows after pagehide', async () => {
  const clients = Promise.withResolvers<InventoryPage<'clients'>>();
  const consents = Promise.withResolvers<InventoryPage<'consents'>>();
  const views: InventoryView[] = [];
  const source: InventorySource = <V extends InventoryView>(view: V) => {
    views.push(view);
    return (view === 'clients' ? clients.promise : consents.promise) as Promise<InventoryPage<V>>;
  };
  const page = await open(<DeleteAccountContent {...props} inventorySource={source} initial={review} />, review);
  await flush(() => {});
  expect(views.sort()).toEqual(['clients', 'consents']);
  leave();
  expect(page.host.querySelector('[data-account-delete-private-review]')).toBeNull();
  clients.resolve({
    kind: 'ready',
    rows: [{ client_id: 'former-client', display_name: 'Private inventory row', disabled: false, scopes: [] }],
    next: null,
  });
  consents.resolve({
    kind: 'ready',
    rows: [
      {
        client_id: 'former-consent',
        display_name: 'Private consent row',
        granted: ['openid'],
        status: 'current',
        reducible: true,
        pending_reduction: false,
      },
    ],
    next: null,
  });
  await flush(() => {});
  expect(page.host.textContent).not.toContain('Private inventory row');
  expect(page.host.textContent).not.toContain('Private consent row');
});

test('accepted deletion stays acknowledged through pagehide and persisted pageshow', async () => {
  let reads = 0;
  const source = async () => {
    reads++;
    return review;
  };
  const page = await open(<DeleteAccountContent {...props} source={source} initial={review} />, review);
  await flush(() => {
    fill(
      page.host.querySelector<HTMLInputElement>('#account-delete-input')!,
      m.auth_account_delete_confirmation_phrase(),
    );
    send(page.host);
  });
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(Response.json({ accountId: review.accountId })));
  expect(page.host.textContent).toContain(m.auth_account_delete_cleanup_pending());
  expect(page.host.textContent).toContain(m.auth_account_delete_finality());

  leave();
  expect(page.host.querySelector('[data-account-deletion-return="acknowledged"]')).not.toBeNull();
  await flush(() => {
    const event = new dom.Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
  });
  expect(page.host.textContent).toContain(m.auth_account_delete_cleanup_pending());
  expect(page.host.textContent).toContain(m.auth_account_delete_finality());
  expect(reads).toBe(0);
  expect(page.calls).toHaveLength(2);
});

test.each([
  ['malformed', '{malformed'],
  [
    'foreign',
    JSON.stringify({
      version: 1,
      kind: 'organization',
      accountId: 'another-account',
      operationKey: 'a'.repeat(32),
      operation: { kind: 'organization', handle: 'team-example' },
      returnTo: '/organizations/new',
      submitted: false,
    }),
  ],
] as const)('%s continuation remains untouched and does not admit private review', async (_kind, marker) => {
  window.sessionStorage.setItem('rezics.account-operation.step-up', marker);
  const page = await open(<DeleteAccountContent {...props} initial={review} />, review);
  await flush(() => {});
  expect(page.host.querySelector('#account-delete-input')).toBeNull();
  expect(page.host.textContent).not.toContain(review.email);
  expect(window.sessionStorage.getItem('rezics.account-operation.step-up')).toBe(marker);
  expect(page.calls).toHaveLength(0);
  await page.render(null);
});
