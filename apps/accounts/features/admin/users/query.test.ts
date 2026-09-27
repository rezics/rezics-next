import { describe, expect, test } from 'bun:test';
import { addFilter, createdRange, isChip, parseQuery, removeToken } from './query.ts';

describe('directory search text', () => {
  test('free text is a prefix of email, name or ID; filters become API parameters', () => {
    expect(parseQuery('  ada   lovelace ').filters).toEqual({ q: 'ada lovelace' });
    expect(parseQuery('email:ADA@Example status:suspended role:staff verified:no 2fa:on').filters).toEqual({
      email: 'ada@example', status: 'suspended', role: 'owner,admin,support', verified: false, hasTwoFactor: true });
    expect(parseQuery('name:"李 明" id:abc123').filters).toEqual({ name: '李 明', q: 'abc123' });
    expect(parseQuery('status:active,reset').filters.status).toBe('active,password-reset-required');
  });

  test('negation takes the complement of a set, or flips a yes/no', () => {
    expect(parseQuery('-status:suspended').filters.status).toBe('active,password-reset-required');
    expect(parseQuery('-role:none').filters.role).toBe('owner,admin,support');
    expect(parseQuery('role:staff -role:owner').filters.role).toBe('admin,support');
    expect(parseQuery('-verified:yes -2fa:no').filters).toEqual({ verified: false, hasTwoFactor: true });
    const contradiction = parseQuery('status:active -status:active');
    expect(contradiction.filters.status).toBeUndefined();
    expect(contradiction.problems).toEqual([{ kind: 'contradiction', key: 'status' }]);
  });

  test('what cannot be searched is reported, never silently widened', () => {
    expect(parseQuery('handle:ada').problems).toEqual([{ kind: 'no-handle' }]);
    expect(parseQuery('colour:red').problems).toEqual([{ kind: 'unknown-filter', key: 'colour' }]);
    expect(parseQuery('-spam').problems).toEqual([{ kind: 'no-negation', key: 'text' }]);
    expect(parseQuery('-email:ada').problems).toEqual([{ kind: 'no-negation', key: 'email' }]);
    expect(parseQuery('status:gone').problems).toEqual([{ kind: 'bad-value', key: 'status', value: 'gone' }]);
    expect(parseQuery('created:2026-02-30').problems).toEqual([{ kind: 'bad-value', key: 'created', value: '2026-02-30' }]);
    expect(parseQuery('handle:ada').filters).toEqual({});
  });

  test('created dates are UTC periods: a day, a month, a year or a range', () => {
    expect(createdRange('2026-03-14')).toEqual({ from: '2026-03-14T00:00:00.000Z', to: '2026-03-15T00:00:00.000Z' });
    expect(createdRange('>2026-03')).toEqual({ from: '2026-04-01T00:00:00.000Z' });
    expect(createdRange('>=2026-03')).toEqual({ from: '2026-03-01T00:00:00.000Z' });
    expect(createdRange('<2026')).toEqual({ to: '2026-01-01T00:00:00.000Z' });
    expect(createdRange('<=2026-12-31')).toEqual({ to: '2027-01-01T00:00:00.000Z' });
    expect(createdRange('2025-12..2026-01')).toEqual({ from: '2025-12-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
    expect(createdRange('2026-02..2026-01')).toBeNull();
    expect(parseQuery('created:>2026-01-01 created:<2026-02-01').filters).toEqual({
      createdFrom: '2026-01-02T00:00:00.000Z', createdTo: '2026-02-01T00:00:00.000Z' });
  });

  test('chips remove exactly their token; the builder appends one', () => {
    const text = 'ada status:suspended -role:none';
    const { tokens } = parseQuery(text);
    expect(tokens.map(isChip)).toEqual([false, true, true]);
    expect(removeToken(text, tokens[1]!)).toBe('ada -role:none');
    expect(addFilter('ada', 'name', 'Ada L')).toBe('ada name:"Ada L"');
    expect(addFilter('', 'status', 'suspended')).toBe('status:suspended');
  });
});
