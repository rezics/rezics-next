import { expect, test } from 'bun:test';
import { progressDecimalIssue, progressLocatorIssue } from '../src/library/progress-decimal-input';

test('fixed decimal input keeps the native lexical, whitespace, exact bounds and precision rules', () => {
  const rules = { min: '0.255', max: '999999999999.123456', step: 'any' };
  for (const value of ['1e3', '1E+3', '-1', '+1', '01', '.5', '1.', '1,5', '1000000000000', '1.0000001'])
    expect(progressDecimalIssue(value, rules)).toBe('syntax');
  expect(progressDecimalIssue('0.254999', rules)).toBe('min');
  expect(progressDecimalIssue('999999999999.123457', rules)).toBe('max');
  expect(progressDecimalIssue(' 999999999999.123456\n', rules)).toBeNull();
  expect(progressDecimalIssue('0.255', rules)).toBeNull();
  expect(progressDecimalIssue('0.26', { ...rules, step: '0.01' })).toBeNull();
  expect(progressDecimalIssue('0.260', { ...rules, step: '0.01' })).toBe('precision');
  expect(progressDecimalIssue(' \n ', rules)).toBe('required');
  expect(progressDecimalIssue(' \n ', rules, false)).toBeNull();
  for (const value of [' ', 'x'.repeat(256)]) expect(progressLocatorIssue(value)).toBeNull();
  for (const value of ['', 'x'.repeat(257)]) expect(progressLocatorIssue(value)).toBe('locator');
});
