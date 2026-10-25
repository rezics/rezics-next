import { expect, test } from 'bun:test';

const builtinToMatchObject = Object.getPrototypeOf(expect(0)).toMatchObject as (
  this: unknown,
  expected: unknown,
) => void;

await import('./stable-match-object.ts');

test('toMatchObject leaves the received object unchanged', () => {
  const received = { revision: 4, nested: { label: 'current' } };
  const before = structuredClone(received);

  expect(received).toMatchObject({ revision: expect.any(Number), nested: { label: expect.any(String) } });

  expect(received).toEqual(before);
});

test('toMatchObject preserves the built-in mismatch message', () => {
  const received = { revision: 4 };
  const expected = { revision: 5 };
  let expectedMessage = '';
  try {
    builtinToMatchObject.call(expect(received), expected);
  } catch (error) {
    expectedMessage = error instanceof Error ? error.message : String(error);
  }
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
