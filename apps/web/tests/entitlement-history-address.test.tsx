import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocale } from '../src/paraglide/runtime.js';
import {
  entitlementHistoryAddress,
  entitlementHistoryRepairHref,
  loadEntitlementHistoryAddress,
} from '../src/checkout/entitlement-history-address';
import { EntitlementsAddressRecovery } from '../src/checkout/entitlements-page';

setLocale('en', { reload: false });

test('malformed owned-benefit cursors stop before a private page read', async () => {
  for (const cursor of [['first', 'second'], 'x'.repeat(4097)]) {
    const address = entitlementHistoryAddress({ cursor });
    let reads = 0;
    expect(address).toEqual({ kind: 'malformed' });
    expect(await loadEntitlementHistoryAddress(address, async () => (reads += 1))).toEqual({
      kind: 'malformed-address',
    });
    expect(reads).toBe(0);
  }
});

test('valid opaque cursors remain exact and repair keeps the orders return position', async () => {
  const cursor = 'signed+/cursor=';
  const address = entitlementHistoryAddress({ cursor });
  let requested: string | undefined;
  expect(address).toEqual({ kind: 'list', cursor });
  expect(await loadEntitlementHistoryAddress(address, async (value) => ((requested = value), 'page'))).toBe('page');
  expect(requested).toBe(cursor);

  const history = { ordersCursor: 'orders +/=', entitlementsCursor: 'saved-cursor' };
  expect(entitlementHistoryRepairHref('en', history)).toBe('/en/entitlements?ordersCursor=orders%20%2B%2F%3D');
  const html = renderToStaticMarkup(<EntitlementsAddressRecovery locale="en" history={history} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain('href="/en/entitlements?ordersCursor=orders%20%2B%2F%3D"');
  expect(html).toContain('Open first page');
});
