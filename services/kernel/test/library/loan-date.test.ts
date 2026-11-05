import { expect, test } from 'bun:test';
import { loanDate, loanDueBoundary, loanIsOverdue, LoanInvalidError } from '../../src/library/loan-date.ts';

test('complete Gregorian dates preserve exact calendar text, including early and leap years', () => {
  for (const day of ['0001-01-01', '0099-12-31', '1600-02-29', '2000-02-29', '2024-02-29', '9999-12-31'])
    expect(loanDate(day, 'startedOn')).toBe(day);
  for (const day of [
    '0000-01-01',
    '1900-02-29',
    '2025-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '2026-1-01',
    '2026',
    '2026-01',
    '2026-01-01\n',
    '2026-01-01T00:00:00Z',
    '',
    null,
    20260101,
  ]) {
    try {
      loanDate(day, 'startedOn');
      throw new Error('Accepted an invalid date');
    } catch (error) {
      expect(error).toBeInstanceOf(LoanInvalidError);
      expect(error).toHaveProperty('field', 'startedOn');
    }
  }
});

test('one server UTC boundary keeps the entire due day inclusive and never makes undated loans overdue', () => {
  const before = loanDueBoundary(new Date('2026-11-04T23:59:59.999Z'));
  const after = loanDueBoundary(new Date('2026-11-05T00:00:00.000Z'));
  expect(before).toEqual({ calendar: 'gregorian', zone: 'UTC', today: '2026-11-04' });
  expect(loanIsOverdue('2026-11-04', before)).toBe(false);
  expect(loanIsOverdue('2026-11-04', after)).toBe(true);
  expect(loanIsOverdue(null, before)).toBe(false);
  expect(loanIsOverdue(null, after)).toBe(false);
  expect(loanDueBoundary(new Date('2026-11-05T08:00:00+08:00'))).toEqual(after);
  expect(() => loanDueBoundary(new Date('invalid'))).toThrow(RangeError);
});
