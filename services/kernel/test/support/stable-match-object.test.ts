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

test('toMatchObject sees the own properties of a rejected error', async () => {
  const error = Object.assign(new Error('denied'), { code: 'forbidden' });

  await expect(Promise.reject(error)).rejects.toMatchObject({ code: 'forbidden', message: 'denied' });
  expect({ failure: error }).toMatchObject({ failure: { code: 'forbidden' } });
  expect(error).toBeInstanceOf(Error);
});

test('toMatchObject leaves a frozen or cyclic received value unchanged', () => {
  const frozen = Object.freeze({ revision: 4, rows: Object.freeze([{ id: 'a' }]) });
  const cyclic: { id: string; self?: unknown } = { id: 'b' };
  cyclic.self = cyclic;

  expect(frozen).toMatchObject({ revision: expect.any(Number), rows: [{ id: expect.any(String) }] });
  expect(cyclic).toMatchObject({ id: expect.any(String) });

  expect(frozen).toEqual({ revision: 4, rows: [{ id: 'a' }] });
  expect(cyclic.id).toBe('b');
});
