import { expect, test } from 'bun:test';
import { validateLabelInput } from '../src/library/labels-read';

test('create and rename validate normalized scalars while retaining exact command operands and input caps', () => {
  for (const operation of ['create', 'rename'] as const) {
    const input = {
      operation,
      idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000832',
      ...(operation === 'rename' ? { id: 'label', revision: 7 } : {}),
    };
    for (const name of ['📚'.repeat(100), `  ${'e\u0301'.repeat(100)}  `, `A${'\u2003'.repeat(300)}B`, 'Case\u200d'])
      expect(validateLabelInput({ ...input, name })).toEqual({ ...input, name });
    for (const name of ['📚'.repeat(101), ' \t\u2003 ', 'A\u0000B', 'A\u007fB', 'A\ud800', '\udc00B', ' '.repeat(1001)])
      expect(() => validateLabelInput({ ...input, name })).toThrow('Invalid label name');
  }
});
