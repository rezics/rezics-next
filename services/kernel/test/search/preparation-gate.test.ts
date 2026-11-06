import { expect, test } from 'bun:test';
import { createSearchServiceGate } from '../../src/search/work.ts';

test('recovered preparation waits for the live service and refuses work after stop', async () => {
  const gate = createSearchServiceGate<string>(() => new Error('Search preparation service is not running'));
  const waiting = gate.ready();
  let resolved = false;
  void waiting.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);
  expect(gate.current).toBeUndefined();
  gate.offer('live');
  expect(await waiting).toBe('live');
  expect(await gate.ready()).toBe('live');
  expect(gate.current).toBe('live');
  expect(() => gate.offer('again')).toThrow('Search preparation service is already running');
  gate.stop();
  await expect(gate.ready()).rejects.toThrow('Search preparation service is not running');
});
