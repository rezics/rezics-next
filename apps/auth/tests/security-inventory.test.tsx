import { mountedSuite } from './owned-application-review-fixture';
import { expect, test } from 'bun:test';
import { SecurityInventory, type InventorySource } from '../src/security-inventory-view';
import type { InventoryPage } from '../src/security-inventory';
import { click, expand, host, m, render, row, text, tick } from './owned-application-review-fixture';

mountedSuite();

test('Security composes independent ownership/consent data and retires both at the parent boundary', async () => {
  const life = new AbortController();
  const calls: string[] = [];
  const source: InventorySource = async (view) => {
    calls.push(view);
    return (
      view === 'clients'
        ? { kind: 'ready', rows: [row('exact-owner-id')], next: null }
        : {
            kind: 'ready',
            rows: [
              {
                client_id: 'separate-consent',
                display_name: 'Connected only',
                granted: ['openid'],
                status: 'current',
                reducible: false,
                pending_reduction: false,
              },
            ],
            next: null,
          }
    ) as InventoryPage<typeof view>;
  };
  await render(<SecurityInventory source={source} lifetime={life.signal} preflight />);
  expect(calls).toEqual(['clients', 'consents']);
  await expand();
  expect(text()).toContain('exact-owner-id');
  expect(text()).toContain('Connected only');
  expect(text()).toContain(m.auth_inventory_preflight());
  await click(m.auth_owned_close());
  expect(calls).toEqual(['clients', 'consents']);
  await tick(() => life.abort());
  expect(host.textContent).not.toContain('exact-owner-id');
  expect(host.textContent).not.toContain('Connected only');
});
