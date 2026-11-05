import { expect, test } from 'bun:test';
import { createSemanticDriver } from './outcome-driver.ts';

test('a driver whose setup its caller abandoned does not block the next driver', async () => {
  // A hook that timed out leaves its setup running with nobody holding the driver.
  const abandoned = createSemanticDriver();
  const driver = await createSemanticDriver();
  try {
    const response = await driver.request('anonymous', 'GET', '/v1/definitions/active');
    expect(response.status).toBe(200);
    expect(typeof response.body.digest).toBe('string');
  } finally {
    await driver.close();
    await (await abandoned).close();
  }
}, 180_000);
