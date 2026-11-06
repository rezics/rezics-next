import { expect, test } from 'bun:test';
import { loansAddress, loansQuery, sameLoansAddress } from '../src/library/loans-query';

test('loan addresses keep open/history filters and refuse unknown predicates without widening', () => {
  expect(loansQuery({ filter: 'history', cursor: 'next+page' })).toEqual({
    filter: 'history',
    cursor: 'next+page',
  });
  expect(loansAddress({}, 'en')).toEqual({ filter: 'open', cursor: null, locale: 'en' });
  expect(loansAddress({ filter: 'history' }, 'ja')).toEqual({
    filter: 'history',
    cursor: null,
    locale: 'ja',
  });
  expect(loansAddress({ filter: 'secret' }, 'en').issue).toBe('filter');
  expect(loansAddress({ cursor: 'x'.repeat(4097) }, 'en').issue).toBe('cursor');
  const current = loansAddress({ filter: 'open', cursor: 'held' }, 'en');
  expect(sameLoansAddress(current, loansAddress({ filter: 'open', cursor: 'held' }, 'en'))).toBe(true);
  expect(sameLoansAddress(current, loansAddress({ filter: 'history', cursor: 'held' }, 'en'))).toBe(false);
});
