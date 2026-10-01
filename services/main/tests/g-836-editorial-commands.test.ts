import { expect, test } from 'bun:test';
import { mergeEditorialCommands } from '../src/modules/identity-merge/editorial-commands.ts';
import { applyOrderedCommands } from '../src/modules/editorial-review/ordered.ts';
import type { ApplyInput, EditorialAdapter, Json } from '../src/modules/editorial-review/contract.ts';
import { ownerReceipt } from '../src/modules/editorial-review/runtime.ts';
import { mergeOwnerBinding } from '../src/modules/identity-merge/authority.ts';
import { MergeUnavailable } from '../src/modules/identity-merge/contract.ts';
import { MemoryCommandJournal } from './g-865-command-journal.ts';
import { fixture, resource } from './g-836-fixture.ts';

test('G836: merge stages use G846 ordered applications, resume one native effect per item, and never dispatch on reads', async () => {
  const f = fixture(65), second = fixture(3);
  const secondHandler = { ...second.handler, owner: 'second', references: ['table:second.item.target'] };
  const handlers = [f.handler, secondHandler];
  f.wanted.handlers = handlers.map(handler => ({ owner: handler.owner, version: handler.version }));
  const input: ApplyInput = { operationKey: f.wanted.key, target: { resource: resource(1), work: resource(1),
    revision: resource(101), context: 'urn:rezics:context:global' },
  expectedHeads: [{ component: resource(1), head: resource(101) }, { component: resource(2), head: resource(102) }],
  permit: { proof: f.wanted.application, proposal: f.wanted.key.split(':')[1]!, revision: 1,
    candidateDigest: f.wanted.candidateDigest, decidingAgent: resource(10) },
  revision: { proposal: f.wanted.key.split(':')[1]!, n: 1, candidate: f.wanted.plan as unknown as Json,
    candidateDigest: f.wanted.candidateDigest, before: null, baseHeads: [], evidence: [] },
  commands: new MemoryCommandJournal() };
  const adapter: EditorialAdapter = { kind: 'merge', requiredApprovals: 2,
    validate() { throw new Error('Not used by this delivery check'); }, preview: () => Promise.resolve([]),
    apply() { throw new Error('The legacy application port must not deliver ordered merge stages'); },
    commands: next => Promise.resolve(mergeEditorialCommands(next, f.wanted, f.journal, handlers, f.runtime)),
    complete: async next => { await f.runtime.finish(f.wanted, 'final'); return ownerReceipt(next, 'urn:fixture:final', resource(999), { task: f.wanted.key }); },
    compensate() { throw new Error('Compensation planning has its own owner contract'); } };
  f.lose();
  await expect(applyOrderedCommands(adapter, input)).rejects.toThrow('lost owner acknowledgement');
  expect(f.writes()).toBe(1);
  expect(await applyOrderedCommands(adapter, { ...input, resumeDelivery: false })).toEqual({ outcome: 'pending' });
  expect(f.writes()).toBe(1); expect(second.writes()).toBe(0);
  expect(await applyOrderedCommands(adapter, input)).toEqual({ outcome: 'pending' });
  expect(f.writes()).toBe(32); expect(second.writes()).toBe(0);
  expect(await applyOrderedCommands(adapter, input)).toEqual({ outcome: 'pending' });
  expect(f.writes()).toBe(64); expect(second.writes()).toBe(0);
  const result = await applyOrderedCommands(adapter, input);
  expect(result.outcome).toBe('applied');
  if (result.outcome !== 'applied') throw new Error('Expected completion');
  expect(result.receipt.commands?.map(command => command.outcome)).toEqual(['applied', 'applied', 'applied']);
  expect(f.writes()).toBe(65); expect(second.writes()).toBe(3); expect(f.finalizations()).toBe(1);
  expect((await input.commands!.read(input, 0)).binding).toEqual(mergeOwnerBinding(f.wanted, 'identity-merge'));
  expect((await input.commands!.read(input, 1)).binding).toEqual(mergeOwnerBinding(f.wanted, 'fixture'));
  expect((await applyOrderedCommands(adapter, { ...input, resumeDelivery: false })).outcome).toBe('applied');
  expect(f.writes()).toBe(65); expect(f.finalizations()).toBe(1);
  expect(() => mergeEditorialCommands({ ...input, operationKey: 'another' }, f.wanted, f.journal, handlers, f.runtime))
    .toThrow(MergeUnavailable);
});
