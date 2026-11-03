import { expect, test } from 'bun:test';
import type { EditorRead } from '../src/features/catalogue/statement-editor';
import type { FactsTransport } from '../src/features/catalogue/subject-facts';
import { screenClassificationTransport } from '../src/features/catalogue/screen-classification-review';

test('Screen classification readback observes current values, failures, and reader retirement', async () => {
  const current = { ok: true } as EditorRead;
  const observed: EditorRead[] = [];
  let reads = 0;
  const transport = {
    read: async () => {
      reads += 1;
      return current;
    },
    propose: async () => ({ ok: false, reason: 'unavailable' }),
  } as unknown as FactsTransport;

  const live = screenClassificationTransport(transport, () => true, (next) => observed.push(next));
  expect(await live.read()).toBe(current);
  expect(observed).toEqual([current]);

  const unavailable = screenClassificationTransport(
    { ...transport, read: async () => Promise.reject(new Error('read failed')) },
    () => true,
    (next) => observed.push(next),
  );
  expect(await unavailable.read()).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(observed.at(-1)).toMatchObject({ ok: false, reason: 'unavailable' });

  const retired = screenClassificationTransport(transport, () => false, (next) => observed.push(next));
  await expect(retired.read()).rejects.toThrow('Retired catalogue editor');
  expect(reads).toBe(1);
  expect(observed).toHaveLength(2);
});
