import { expect, test } from 'bun:test';
import { acceptsProfileDecimal } from '../../src/library/profile-decimal.ts';

test('profile numeric bounds are exact data and preserve kernel decimal limits without unit-name rules', () => {
  expect(acceptsProfileDecimal({}, '999999999999.999999')).toBe(true);
  for (const value of [
    '1000000000000',
    '0.0000001',
    '01',
    '1.',
    '-1',
    '+1',
    '1e2',
    ' 1',
    '1 ',
    '0x10',
    '１',
    1,
    null,
    undefined,
  ])
    expect(acceptsProfileDecimal({}, value)).toBe(false);
  expect(acceptsProfileDecimal({ minimum: '1.01', maximum: '200', precision: 2 }, '1.01')).toBe(true);
  expect(acceptsProfileDecimal({ minimum: '1.01', maximum: '200', precision: 2 }, '1.00')).toBe(false);
  expect(acceptsProfileDecimal({ minimum: '1.01', maximum: '200', precision: 2 }, '1.234')).toBe(false);
  expect(acceptsProfileDecimal({ minimum: '1.01', maximum: '200', precision: 2 }, '200')).toBe(true);
  expect(acceptsProfileDecimal({ minimum: '1.01', maximum: '200', precision: 2 }, '200.01')).toBe(false);
  expect(acceptsProfileDecimal({ precision: 0 }, '100')).toBe(true);
  expect(acceptsProfileDecimal({ precision: 0 }, '100.01')).toBe(false);
  expect(acceptsProfileDecimal({ maximum: '100' }, '100.000000')).toBe(true);
  expect(acceptsProfileDecimal({ maximum: '100' }, '100.000001')).toBe(false);
  expect(acceptsProfileDecimal({}, '1000.000001')).toBe(true);
  expect(acceptsProfileDecimal({ maximum: '200' }, '150')).toBe(true);
  const bounds = { minimum: '999999999999.000001', maximum: '999999999999.000002' };
  expect(acceptsProfileDecimal(bounds, '999999999999.000000')).toBe(false);
  expect(acceptsProfileDecimal(bounds, '999999999999.000001')).toBe(true);
  expect(acceptsProfileDecimal(bounds, '999999999999.000002')).toBe(true);
  expect(acceptsProfileDecimal(bounds, '999999999999.000003')).toBe(false);
});
