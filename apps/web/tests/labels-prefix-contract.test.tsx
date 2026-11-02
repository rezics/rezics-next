import { afterAll, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import { parseLabelsAddress, type LabelsAddressResult } from '../src/library/labels-address';
import { LabelsAddressRecovery } from '../src/library/labels-address-recovery';

const read = mock(async () => undefined);
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/library/labels-read-route', () => ({ readLabelsCurrent: read, readLabelsPage: read }));
const { Route } = await import('../src/routes/library/labels');
afterAll(() => mock.restore());
const load = Route.options.loader as unknown as (input: {
  deps: { query: string; cursor: string };
}) => Promise<{ kind: string; address: LabelsAddressResult }>;

test('native-invalid saved prefixes require explicit correction before any private catalogue read', async () => {
  for (const query of [
    'a\0b',
    'a\u0001b',
    'a\u007fb',
    'a\u009fb',
    '\u0344'.repeat(51),
    ' '.repeat(101),
    'e\u0301'.repeat(51),
  ]) {
    read.mockClear();
    const result = await load({ deps: { query, cursor: 'saved+/cursor==' } });
    expect(result).toEqual({
      kind: 'invalid-address',
      address: { valid: false, issue: 'prefix', query: null, cursor: null, rawQuery: query, rawCursor: 'saved+/cursor==' },
    });
    expect(read).not.toHaveBeenCalled();
  }
  const query = '\u0344'.repeat(51);
  const address = parseLabelsAddress({ query, cursor: 'saved+/cursor==' });
  if (address.valid) throw new Error('Expected prefix correction');
  const html = renderToStaticMarkup(<LabelsAddressRecovery {...address} />);
  expect(html).toContain(`value="${query}"`);
  expect(html).toContain('method="get"');
  expect(html).not.toContain('name="cursor"');
  expect(html).not.toContain('maxlength');
});

test('valid saved prefixes keep their raw spelling and opaque cursor through the reader boundary', async () => {
  const cursor = `${'x'.repeat(4070)}+/==?&% 漢字#opaque`;
  for (const query of ['', '\t\n\u0085\u00a0\u2003', '  e\u0301\t読書  ', '😀'.repeat(100), '\u0344'.repeat(50)]) {
    read.mockClear();
    expect(await load({ deps: { query, cursor } })).toMatchObject({
      kind: 'loaded',
      address: { valid: true, query, cursor },
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ data: { query, cursor } });
  }
  expect(parseLabelsAddress({ query: '', cursor: '' })).toEqual({ valid: true, query: '', cursor: null });
  expect(parseLabelsAddress({ query: 'a\0b', cursor: 'x'.repeat(4097) })).toMatchObject({ issue: 'prefix' });
  expect(parseLabelsAddress({ query: ' e\u0301 ', cursor: 'x'.repeat(4097) })).toMatchObject({
    valid: false,
    issue: 'cursor',
    query: ' e\u0301 ',
  });
});
