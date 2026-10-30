import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkKeys } from '../support/partition-binding.ts';
import { epochFixture, type EpochFixture } from './support/identity-epoch.ts';

let fixture: EpochFixture;
beforeAll(async () => {
  fixture = await epochFixture();
});
afterAll(async () => {
  await fixture?.close();
});

test('every authoritative identity key leads with its native route or partition', async () => {
  const violations = (await checkKeys(fixture.pool)).filter((name) => name.startsWith('semantic.identity_epoch_'));
  expect(violations).toEqual([]);
});
