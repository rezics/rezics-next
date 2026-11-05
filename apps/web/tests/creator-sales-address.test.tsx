import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreatorSalesAddress } from '../src/checkout/creator-sales-address';

test('malformed saved cursor stays editable and correction or restart stays on the creator sales route', () => {
  const html = renderToStaticMarkup(createElement(CreatorSalesAddress, { locale: 'en', cursor: 'bad<&"' }));

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

test('sales coordinates retain eight predecessors, branch after Previous and stage exact cursor-free Restart', async () => {
  const { CreatorSalesWindows } = await import('../src/checkout/creator-sales-windows');
  const windows = new CreatorSalesWindows(undefined);
  const raw = ' +/=😀'.repeat(400);
  windows.stage('next', raw);
  expect(windows.current).toBeUndefined();
  expect(windows.previous).toBeUndefined();
  expect(windows.staged?.cursor).toBe(raw);
  windows.accept();
  expect(windows.previous).toEqual({ cursor: undefined });
  for (let n = 0; n < 10; n++) {
    windows.stage('next', `page-${n}`);
    windows.accept();
  }
  windows.stage('previous', windows.previous!.cursor);
  expect(windows.current).toBe('page-9');
  windows.accept();
  windows.stage('next', 'branch+/=');
  windows.accept();
  for (let n = 0; n < 8; n++) {
    expect(windows.previous).toBeDefined();
    windows.stage('previous', windows.previous!.cursor);
    windows.accept();
  }
  expect(windows.previous).toBeUndefined();
  windows.stage('restart', undefined);
  expect(windows.current).toBe('page-1');
  expect(windows.staged).toEqual({ movement: 'restart', cursor: undefined });
  windows.accept();
  expect(windows.current).toBeUndefined();
  expect(windows.previous).toBeUndefined();
  expect(new CreatorSalesWindows('direct-later').previous).toBeUndefined();
});
