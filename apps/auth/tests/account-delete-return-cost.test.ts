import { expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { loadAccountDeletionPage, type AccountDeletionPage, type AccountDeletionPageSource } from '../src/account-deletion-page';
import type { InventoryPage, InventoryView } from '../src/security-inventory';
import type { InventorySource } from '../src/security-inventory-view';
import { DeleteAccountContent } from '../src/routes/account.delete';
import { m } from '../src/paraglide/messages.js';
import { button, creationFixture, dom, flush, leave, open } from './creation-page-fixture';

creationFixture();

const review: Extract<AccountDeletionPage, { kind: 'review' }> = {
  kind: 'review',
  accountId: 'account-a',
  email: null,
  action: 'available',
  policy: 'personal-deletion',
};

test('the native advice reader makes one request and restored Retry stays bounded and read-only', async () => {
  const request = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toBe('/account-management/deletion-page');
    expect(init?.method).toBe('POST');
    expect(init?.cache).toBe('no-store');
    return Response.json(review);
  });
  try {
    expect(await loadAccountDeletionPage(new AbortController().signal)).toEqual(review);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    request.mockRestore();
  }

  let reads = 0;
  const responses: AccountDeletionPage[] = [review, { kind: 'unavailable' }, review];
  const source: AccountDeletionPageSource = async () => responses[reads++]!;
  const views: InventoryView[] = [];
  const inventory: InventorySource = <V extends InventoryView,>(view: V) => {
    views.push(view);
    return Promise.resolve({ kind: 'ready', rows: [], next: null } as InventoryPage<V>);
  };
  const page = await open(
    createElement(DeleteAccountContent, {
      privacyContact: 'mailto:privacy@example.test',
      source,
      inventorySource: inventory,
    }),
    review,
  );
  await flush(() => {});
  expect(reads).toBe(1);
  expect(views).toEqual(['clients', 'consents']);

  leave();
  await flush(() => {
    const event = new dom.Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
  });
  await flush(() => {});
  expect(reads).toBe(2);
  expect(views).toEqual(['clients', 'consents']);
  await flush(() => button(page.host, m.auth_account_delete_retry())!.click());
  await flush(() => {});
  expect(reads).toBe(3);
  expect(views.sort()).toEqual(['clients', 'clients', 'consents', 'consents']);
  expect(page.calls).toHaveLength(0);
  expect(page.host.querySelector('#account-delete-input')).not.toBeNull();
  await page.render(null);
});

