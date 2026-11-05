import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { OwnedApplicationReview } from '../src/owned-application-review-view';
import { click, expand, inventory, m, ready, render } from './owned-application-review-fixture';

test('one installed inventory call per deliberate page read; local inspection has zero reads', async () => {
  const data = inventory(
    ready('first', 'opaque'),
    ready('second'),
    ready('second'),
    ready('first', 'opaque'),
    { kind: 'unavailable' },
    ready('second'),
    ready('first'),
  );
  await render(createElement(OwnedApplicationReview, { source: data.source, copyIdentifier: async () => {} }));
  await expand();
  await click(m.auth_owned_copy());
  await click(m.auth_owned_close());
  expect(data.calls).toHaveLength(1);
  await click(m.auth_inventory_next());
  await click(m.auth_owned_reload());
  await click(m.auth_inventory_previous());
  await click(m.auth_inventory_next());
  await click(m.auth_owned_retry());
  await click(m.auth_owned_restart());
  expect(data.cursors()).toEqual([undefined, 'opaque', 'opaque', undefined, 'opaque', 'opaque', undefined]);
  expect(data.calls.every((call) => call.view === 'clients' && call.signal instanceof AbortSignal)).toBe(true);
});
