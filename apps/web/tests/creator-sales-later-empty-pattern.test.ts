import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { CreatorSalesPage } from '../src/checkout/creator-sales-page';
import { creatorSaleFixture, creatorSalesStoryPage } from '../src/kernel/fake/creator-sales';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';

const laterCursor = 'story-signed-current';
const show = (state: Parameters<typeof creatorSalesStoryPage>[0], cursor?: string) =>
  renderToString(createElement(CreatorSalesPage, { page: creatorSalesStoryPage(state), locale: 'en', cursor }));

test('A later empty ready Sales page keeps original cursor destinations and is not preparing', () => {
  setLocale('en', { reload: false });
  const later = show('later-empty', laterCursor);
  expect(later).toContain(m.creator_sales_page_empty());
  expect(later).toContain(m.creator_sales_empty_hint());
  expect(later).not.toContain(m.creator_sales_empty());
  expect(later).not.toContain(m.creator_sales_preparing());
  expect(later).toContain(`href="/en/creator/sales?cursor=${encodeURIComponent(laterCursor)}"`);
  expect(later).toContain('href="/en/creator/sales"');
  expect(later).toContain(m.creator_sales_restart());
  expect(later).toContain(`cursor=${encodeURIComponent('story-signed+next/=')}`);
  expect(later).toContain(m.creator_sales_next());
  expect(later).not.toContain(creatorSaleFixture.title);
  expect(later).not.toContain('$12.99');
  expect(later).not.toContain('¥800');
  expect(later).not.toContain('/en/orders/');

  const preparing = show('preparing', laterCursor);
  expect(preparing).toContain(m.creator_sales_preparing());
  expect(preparing).not.toContain(m.creator_sales_page_empty());
  expect(preparing).not.toContain(m.creator_sales_empty());
  expect(preparing).not.toContain(m.creator_sales_next());

  const incomplete = show('incomplete', laterCursor);
  expect(incomplete).toContain(m.creator_sales_preparing());
  expect(incomplete).toContain(creatorSaleFixture.title);
  expect(incomplete).toContain('$12.99');
  expect(incomplete).toContain('€6.75');
  expect(incomplete).not.toContain(m.creator_sales_page_empty());
  expect(incomplete).not.toContain(m.creator_sales_empty());
  expect(incomplete).toContain(`cursor=${encodeURIComponent('story-signed+next/=')}`);
});
