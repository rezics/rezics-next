import { expect, test } from 'bun:test';
import { copyFieldInputIsTooLong, copyTextFieldLimits } from '../src/library/copy-field-input';

for (const [field, limit] of Object.entries(copyTextFieldLimits) as [keyof typeof copyTextFieldLimits, number][]) {
  test(`${field} counts non-BMP characters as one scalar`, () => {
    expect(copyFieldInputIsTooLong(field, '📚'.repeat(limit))).toBe(false);
    expect(copyFieldInputIsTooLong(field, '📚'.repeat(limit + 1))).toBe(true);
  });
}
