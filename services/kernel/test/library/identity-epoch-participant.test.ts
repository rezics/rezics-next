import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { stepLibraryIdentityEpoch } from '../../src/library/identity-epoch-participant.ts';
import { createLibraryIdentityEpochReceiver } from '../../src/library/module.ts';
import {
  identitySourceConsumerLibraryWork,
  type IdentitySourceConsumerMaintenanceContext,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';
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

test('the prepaid Library receiver refuses a copied Source context without an active Source frame', async () => {
  const subject = await f.create('Original for prepaid receiver refusal');
  const before = await f.snapshot([subject.id]);
  const receiver = createLibraryIdentityEpochReceiver({
    pool: f.pool,
    frame: { libraryWork: identitySourceConsumerLibraryWork },
  });
  const copied = {
    deadline: Date.now() + 10_000,
    identityConsumerWork: {},
  } as unknown as IdentitySourceConsumerMaintenanceContext;
  await expect(receiver.step({ jobId: newId(0x5d10), epoch: 1n }, copied)).rejects.toThrow(
    'exact live Source maintenance frame',
  );
  expect(await f.snapshot([subject.id])).toEqual(before);
}, 120000);
