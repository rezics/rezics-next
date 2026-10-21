import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { retainedRelationInput, type RetainedRelationInput } from '../src/modules/relation/retained-contract.ts';
import { hash } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = (): RetainedRelationInput => ({ profile: 'relation-change-v2', mode: 'bind-retained-credit',
  retained: { profile: 'work-author-credit-v1', credit: id(1), origin: { kind: 'stored-credit', revision: id(2) } },
  expectedAssociationHead: null, mappingRevision: id(3), attributionSupports: [], actingSubject: id(4) });
test('compatibility transport is closed and separates stored, Source binding and selected publication origins', () => {
  // Malformed transport fixtures are untrusted JSON checked by the same schema.
  const command: Record<string, unknown> = input();
  const stored = { profile: 'work-author-credit-v1', credit: id(1), origin: { kind: 'stored-credit', revision: id(2) } };
  expect(Value.Check(retainedRelationInput, command)).toBe(true);
  const source = { profile: 'source-reported-credit-v1', credit: id(1), origin: { kind: 'source-binding', binding: id(20),
    proposal: id(21), conversion: id(22), record: id(23), observation: id(24), sourceOccurrence: `urn:rezics:source-occurrence:${hash('track-7')}`,
    sourceOrdinal: 127 } };
  const publication = { profile: 'source-reported-credit-v1', credit: id(1), origin: { kind: 'selected-publication',
    decision: id(25), source: 'urn:rezics:work-source:retained-structure', record: id(23), observation: id(24) } };
  expect(Value.Check(retainedRelationInput, { ...command, retained: source })).toBe(true);
  expect(Value.Check(retainedRelationInput, { ...command, retained: publication })).toBe(true);
  for (const replacement of [{ work: id(50) }, { participant: { kind: 'resource', ref: id(51) } }, { role: 'author' },
    { ordinal: 0 }, { sourceIdentity: { provider: 'invented' } }, { receipt: id(52) }, { guard: 'FILTER(true)' }, { definition: id(53) }]) {
    expect(Value.Check(retainedRelationInput, { ...command, ...replacement })).toBe(false);
  }
  const invalidRetained: unknown[] = [{ ...source, profile: 'work-author-credit-v1' }, { ...stored, profile: 'source-reported-credit-v1' },
    { ...source, origin: { ...source.origin, sourceOrdinal: 128 } },
    { ...publication, origin: { ...publication.origin, conversion: id(22) } },
    { ...stored, origin: { ...stored.origin, selectionRevision: id(25) } }];
  for (const retained of invalidRetained)
    expect(Value.Check(retainedRelationInput, { ...command, retained })).toBe(false);
});

