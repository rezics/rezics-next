import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { stepLibraryIdentityEpoch } from '../../src/library/identity-epoch-participant.ts';
import { epochFixture, type EpochFixture } from '../semantic/support/identity-epoch.ts';
let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('the fixed ALL-Library identity step refuses an unadmitted job without an effect or fabricated complete receipt', async () => {
  const subject = await f.create('Real original for refusal');
  const before = await f.snapshot([subject.id]);
  await expect(stepLibraryIdentityEpoch(f.pool, { jobId: newId(0x5d10), epoch: 1n })).rejects.toThrow();
  expect(await f.snapshot([subject.id])).toEqual(before);
}, 120000);
