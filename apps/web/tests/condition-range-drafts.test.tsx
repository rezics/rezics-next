import { expect, test } from 'bun:test';
import { applyConditionRangeDraft, parseConditionRangeDraft } from '../src/search/condition-range-input';

test('incomplete and overflowing quantity drafts stay correctable and fail native form validity', () => {
  let committed: number | undefined = 12;
  for (const raw of ['-', '1e+', '1e309']) {
    let validity = '';
    const result = applyConditionRangeDraft(
      raw,
      'quantity',
      (value) => (committed = value),
      (message) => (validity = message),
      'Enter a finite bound',
    );
    expect(result).toEqual({ valid: false });
    expect(validity).toBe('Enter a finite bound');
    expect(committed).toBe(12);
  }
});

test('quantity exponents, safe integer years and explicit clearing follow their grammars', () => {
  expect(parseConditionRangeDraft('-1.25e2', 'quantity')).toEqual({ valid: true, value: -125 });
  expect(parseConditionRangeDraft('9007199254740992', 'time')).toEqual({ valid: false });
  expect(parseConditionRangeDraft('-44', 'time')).toEqual({ valid: true, value: -44 });
  let committed: number | undefined = 12;
  const result = applyConditionRangeDraft(
    '',
    'quantity',
    (value) => (committed = value),
    () => {},
    'Invalid',
  );
  expect(result).toEqual({ valid: true, value: undefined });
  expect(committed).toBeUndefined();
});
