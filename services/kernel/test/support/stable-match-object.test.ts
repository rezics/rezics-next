import { expect, test } from 'bun:test';

test('toMatchObject leaves the received object unchanged', () => {
  const received = { revision: 4, nested: { label: 'current' } };
  const before = structuredClone(received);

  expect(received).toMatchObject({ revision: expect.any(Number), nested: { label: expect.any(String) } });

  expect(JSON.stringify(received)).toBe(JSON.stringify(before));
});

test('toMatchObject preserves the built-in mismatch message', () => {
  const received = { revision: 4 };
  const expected = { revision: 5 };
  const expectedMessage = [
    'expect(received).toMatchObject(expected)',
    '',
    '  {',
    '-   "revision": 5,',
    '+   "revision": 4,',
    '  }',
    '',
    '- Expected  - 1',
    '+ Received  + 1',
    '',
  ].join('\n');
  let actualMessage: string | undefined;

  try {
    expect(received).toMatchObject(expected);
  } catch (error) {
    actualMessage = error instanceof Error ? error.message : String(error);
  }

  expect(actualMessage).toBe(expectedMessage);
});

test('toMatchObject continues to support .not', () => {
  expect({ revision: 4 }).not.toMatchObject({ revision: 5 });
  expect(() => expect({ revision: 4 }).not.toMatchObject({ revision: 4 })).toThrow();
});
