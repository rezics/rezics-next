import { expect, test } from 'bun:test';
import { BackpressureSaturated, BackpressureUnavailable } from '../../src/operations/admission-budget.ts';
import { withBrokerAdmission } from './backpressure.ts';

test('broker admission retries the same call after the declared backoff', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await withBrokerAdmission(async () => {
    if (++attempts < 3) throw new BackpressureSaturated('broker', 5);
    return 'saved result';
  }, async delay => { delays.push(delay); });
  expect(result).toBe('saved result');
  expect(attempts).toBe(3);
  expect(delays).toEqual([5000, 5000]);
});

test('persistent saturation is bounded and other faults are never retried', async () => {
  for (const error of [new BackpressureSaturated('broker', 5), new BackpressureSaturated('worker', 5),
    new BackpressureUnavailable('broker'), new Error('authority denied')]) {
    let attempts = 0;
    await expect(withBrokerAdmission(async () => { attempts++; throw error; }, async () => {})).rejects.toBe(error);
    expect(attempts).toBe(error instanceof BackpressureSaturated && error.lane === 'broker' ? 4 : 1);
  }
});
