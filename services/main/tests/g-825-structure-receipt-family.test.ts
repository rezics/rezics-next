import { expect, spyOn, test } from 'bun:test';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { readMainOutboxEnvelope, type MainOutboxBatch } from '../src/modules/outbox/relay.ts';
import * as profiles from '../src/modules/structure/profiles.ts';
import { RV, hash } from '../src/modules/work/activate.ts';
import * as activation from '../src/modules/work/activate.ts';

const admissionId = '01990000-0000-7000-8000-000000000001';
const structure = 'https://rezics.com/id/01990000-0000-7000-8000-000000000002';
const revision = 'https://rezics.com/id/01990000-0000-7000-8000-000000000003';

function fixture(action = 'composition.create', scope = `work:edit:${structure}`,
  family = 'edit-metadata-work') {
  const receipt = `urn:rezics:receipt:${hash(`${admissionId}\0${family}`)}`;
  const eventId = `urn:rezics:event:${hash(`${receipt}\0structure`)}`;
  const batch: MainOutboxBatch = { batchId: `urn:rezics:outbox:${hash(receipt)}`,
    dataEpoch: 'epoch-1', sequence: '5', routingEpoch: 'routing-1', eventIds: [eventId] };
  const binding = (values: Record<string, string>) => Object.fromEntries(Object.entries(values)
    .map(([key, value]) => [key, { type: 'literal', value }]));
  let calls = 0;
  const fuseki = { query: async () => ({ results: { bindings: [binding(++calls === 1
    ? { kind: `${RV}StructureCommandEvent`, ordinal: '0', action: 'structure.command',
      receipt, outcome: `${RV}Succeeded`, admissionId, digest: 'a'.repeat(64),
      authorityEpoch: '1', scope, epoch: batch.dataEpoch, sequence: batch.sequence }
    : { action, structure, revision })] } }) } as unknown as FusekiClient;
  return { fuseki, batch, eventId, receipt };
}

test('G-825: shared Book and Work registrations resolve to one terminal receipt family', async () => {
  const registered = await profiles.discoverStructureProfiles();
  for (const id of ['book-composition', 'work-composition'] as const) {
    expect(registered.get(id)).toMatchObject({
      editAction: 'work.edit', editScopePrefix: 'work:edit:', receiptFamily: 'edit-metadata-work' });
  }
  const f = fixture();
  const event = await readMainOutboxEnvelope(f.fuseki, f.batch, f.eventId);
  expect(event.data.receipt).toMatchObject({ id: f.receipt, action: 'structure.command',
    commandAction: 'composition.create', structure, revision, admissionId, outcome: 'succeeded' });
});

test.each([
  ['Recipe', 'work:edit:', 'structure-command'],
  ['Collection', 'collection:edit:', 'structure-command'],
  ['Zone', 'zone:edit:', 'structure-command'],
])('G-825: %s resolves its own family by receipt identity and scope', async (_name, prefix, family) => {
  const f = fixture('composition.change', `${prefix}${structure}`, family);
  expect((await readMainOutboxEnvelope(f.fuseki, f.batch, f.eventId)).data.receipt)
    .toMatchObject({ id: f.receipt, commandAction: 'composition.change', structure, revision });
});

test('G-825: two distinct families matching the same receipt and scope remain ambiguous', async () => {
  const registered = await profiles.discoverStructureProfiles();
  const work = registered.get('work-composition')!;
  registered.set('work-composition', { ...work, receiptFamily: 'conflicting-family' });
  const discovery = spyOn(profiles, 'discoverStructureProfiles').mockResolvedValue(registered);
  // Different families can match one receipt only if their derived identities collide.
  const originalHash = activation.hash;
  const collision = spyOn(activation, 'hash').mockImplementation(value => originalHash(
    value === `${admissionId}\0conflicting-family` ? `${admissionId}\0edit-metadata-work` : value));
  try {
    const f = fixture();
    await expect(readMainOutboxEnvelope(f.fuseki, f.batch, f.eventId))
      .rejects.toThrow('Structure command event has no matching terminal receipt');
  } finally { collision.mockRestore(); discovery.mockRestore(); }
});

test.each([
  ['missing command action', '', `work:edit:${structure}`, 'edit-metadata-work'],
  ['unmatched scope', 'composition.create', `unknown:edit:${structure}`, 'edit-metadata-work'],
  ['unregistered receipt family', 'composition.create', `work:edit:${structure}`, 'unknown-family'],
])('G-825: %s cannot establish a matching terminal receipt', async (_name, action, scope, family) => {
  const f = fixture(action, scope, family);
  await expect(readMainOutboxEnvelope(f.fuseki, f.batch, f.eventId))
    .rejects.toThrow('Structure command event has no matching terminal receipt');
});
