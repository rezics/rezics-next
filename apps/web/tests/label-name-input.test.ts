import { expect, test } from 'bun:test';
import { handleLabelForm, validateLabelInput } from '../src/library/labels-read';

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

test('no-script validation returns the bounded raw draft and captured rename baseline without issuing a command', async () => {
  const client = {} as Parameters<typeof handleLabelForm>[0];
  for (const operation of ['create', 'rename']) {
    const name = `  ${'📚'.repeat(101)}  `;
    const request = new Request('https://site.test/en/library/labels', {
      method: 'POST',
      body: new URLSearchParams({ operation, name, id: 'label', library_label_revision: '7', idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000832' }),
    });
    const response = await handleLabelForm(client, request, {});
    const flash = response.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
    expect(JSON.parse(decodeURIComponent(flash)).feedback).toMatchObject({ operation, name, ok: false, reason: 'invalid_request', retry: { revision: 7 } });
  }
});
