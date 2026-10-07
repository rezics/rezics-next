import { describe, expect, test } from 'bun:test';
import { counterpartyLabel, handleText, partyFromInput } from './party.ts';

const person = 'https://rezics.com/id/00000011-7c1d-4e2f-9a3b-5c6d7e8f9a0b';

describe('loan counterparty', () => {
  test('a typed name stays that name, even when a person was also resolved', () => {
    expect(partyFromInput({ mode: 'name', name: '  City Library  ', personId: person }))
      .toEqual({ kind: 'name', name: 'City Library' });
    expect(counterpartyLabel({ kind: 'name', name: 'City Library' }, 'Ada Lovelace', 'A person')).toBe('City Library');
  });

  test('a person is the chosen profile, and a handle drops a leading @', () => {
    expect(partyFromInput({ mode: 'person', name: 'City Library', personId: person }))
      .toEqual({ kind: 'person', person });
    expect(partyFromInput({ mode: 'name', name: '   ', personId: null })).toBeNull();
    expect(handleText('  @@ada  ')).toBe('ada');
  });
});
