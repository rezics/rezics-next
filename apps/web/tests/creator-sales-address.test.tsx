import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreatorSalesAddress } from '../src/checkout/creator-sales-address';

test('malformed saved cursor stays editable and correction or restart stays on the creator sales route', () => {
  const html = renderToStaticMarkup(
    createElement(CreatorSalesAddress, { locale: 'en', cursor: 'bad<&"' }),
  );

  expect(html).toContain('method="get"');
  expect(html).toContain('action="/en/creator/sales"');
  expect(html).toContain('name="cursor"');
  expect(html).toContain('value="bad&lt;&amp;&quot;"');
  expect(html).toMatch(/maxlength="4096"/i);
  expect(html).toContain('href="/en/creator/sales"');
});

test('a malformed non-string cursor is not reflected into the correction field', () => {
  const html = renderToStaticMarkup(createElement(CreatorSalesAddress, { locale: 'en' }));
  expect(html).toContain('value=""');
});
