import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { projectVndbConceptCaptures, sameCharacterTraitAppearance, survivingVndbClaims,
  VndbConceptInvalid } from '../../../services/main/src/modules/source/field-vndb.ts';

type Kind = 'vn' | 'character' | 'tag' | 'trait';
const captured = (kind: Kind, body: unknown, complete = true) => {
  const bytes = Buffer.from(JSON.stringify({ results: body, more: false }));
  return { kind, bytes, digest: createHash('sha256').update(bytes).digest('hex'), complete };
};
const fixture = () => [
  captured('vn', [{ id: 'v1', tags: [
    { id: 'g1', name: 'Lead', rating: 2.5, spoiler: 1, lie: false },
    { id: 'g2', name: 'Lead', rating: 1.2, spoiler: 2, lie: true },
    { id: 'g99', name: 'Unresolved', rating: 1, spoiler: 0, lie: false },
  ] }]),
  captured('character', [{ id: 'c1', name: 'A', traits: [
    { id: 'i1', name: 'Lead', group_id: 'i9', group_name: 'Role', spoiler: 1, lie: false },
  ], vns: [
    { id: 'v1', release: { id: 'r1' }, role: 'main', spoiler: 0 },
    { id: 'v1', release: { id: 'r2' }, role: 'side', spoiler: 2 },
  ] }]),
  captured('tag', [
    { id: 'g1', name: 'Lead', description: 'One meaning', category: 'cont' },
    { id: 'g2', name: 'Lead', description: 'Another meaning', category: 'tech' },
  ]),
  captured('trait', [{ id: 'i1', name: 'Lead', description: 'Character meaning',
    group_id: 'i9', group_name: 'Role' }]),
];

test('LIVE01/LIVE05: VNDB concept IDs, qualified claims and native candidates retain independent meanings', () => {
  const projection = projectVndbConceptCaptures(fixture());
  expect(projection.concepts.map(concept => [concept.sourceId, concept.label])).toEqual([
    ['vndb:tag:g1', 'Lead'], ['vndb:tag:g2', 'Lead'], ['vndb:trait:i1', 'Lead'],
  ]);
  expect(projection.concepts[2]).toMatchObject({ display: 'Role / Lead',
    group: { sourceId: 'vndb:trait:i9', label: 'Role' } });
  expect(projection.claims.filter(claim => claim.kind === 'tag').map(claim =>
    [claim.concept, claim.unresolved, claim.score, claim.spoiler, claim.lie, claim.disposition])).toEqual([
    ['vndb:tag:g1', null, 2.5, 1, false, 'native'],
    ['vndb:tag:g2', null, 1.2, 2, true, 'native'],
    [null, 'vndb:tag:g99', 1, 0, false, 'structured-source-only'],
  ]);
  expect(projection.claims.filter(claim => claim.kind === 'appearance').map(claim =>
    [claim.relatedVn, claim.release, claim.role, claim.spoiler, claim.occurrence, claim.disposition])).toEqual([
    ['vndb:vn:v1', 'vndb:release:r1', 'main', 0, 0, 'native'],
    ['vndb:vn:v1', 'vndb:release:r2', 'side', 2, 1, 'native'],
  ]);
  expect(projection.claims.every(claim => /^urn:rezics:source-occurrence:[0-9a-f]{64}$/.test(claim.key)))
    .toBe(true);
  expect(new Set(projection.claims.map(claim => claim.key)).size).toBe(projection.claims.length);
  const nextRun = fixture();
  nextRun[0] = captured('vn', [{ id: 'v1', tags: [{ id: 'g1', name: 'Lead', rating: 2.6,
    spoiler: 1, lie: false }] }]);
  expect(projectVndbConceptCaptures(nextRun).claims[0]!.key).not.toBe(projection.claims[0]!.key);
  expect(projection.nativeCandidates).toHaveLength(3);
  expect(projection.nativeCandidates[0]).toMatchObject({ target: 'classification-proposition-v1#concept' });
  expect(projection.nativeClaims).toHaveLength(5);
  expect(projection.nativeClaims.filter(claim => claim.target === 'statement-v1#appearance'))
    .toEqual(expect.arrayContaining([expect.objectContaining({ sourceSubject: 'vndb:character:c1',
      relatedVn: 'vndb:vn:v1', release: 'vndb:release:r1', role: 'main', spoiler: 0 })]));
  expect(projection.fieldInventory.find(field => field.grain === 'vn' && field.field === 'tags.rating'))
    .toMatchObject({ disposition: 'structured-source-only' });
  expect(projection.fieldInventory.find(field => field.grain === 'character' && field.field === 'vns.role'))
    .toMatchObject({ disposition: 'structured-source-only' });
  expect(projection.exportDisposition).toMatchObject({ status: 'unsupported' });

  const conjunction = sameCharacterTraitAppearance(projection.claims, 'vndb:character:c1',
    'vndb:trait:i1', 'vndb:release:r1');
  expect(conjunction).toEqual({ trait: projection.claims.find(claim => claim.kind === 'trait')!.key,
    appearance: projection.claims.find(claim => claim.kind === 'appearance')!.key });
  expect(sameCharacterTraitAppearance(survivingVndbClaims(projection.claims,
    new Set([conjunction!.trait])), 'vndb:character:c1', 'vndb:trait:i1', 'vndb:release:r1')).toBeNull();
  expect(survivingVndbClaims(projection.claims, new Set([conjunction!.trait]))
    .filter(claim => claim.kind === 'appearance')).toHaveLength(2);
});

test('LIVE01/LIVE02: unknown fields are explicit, incomplete or altered captures cannot project', () => {
  const withUnknown = fixture();
  withUnknown[0] = captured('vn', [{ id: 'v1', tags: [], future_field: { nested: true } }]);
  expect(projectVndbConceptCaptures(withUnknown).fieldInventory).toContainEqual({ grain: 'vn',
    field: 'future_field', disposition: 'unsupported', reason: 'undeclared-field' });
  const incomplete = fixture();
  incomplete[0] = { ...incomplete[0]!, complete: false };
  expect(() => projectVndbConceptCaptures(incomplete)).toThrow(VndbConceptInvalid);
  const altered = fixture();
  altered[1]!.bytes[0] = 0;
  expect(() => projectVndbConceptCaptures(altered)).toThrow(VndbConceptInvalid);
  const missing = fixture().slice(0, 3);
  expect(() => projectVndbConceptCaptures(missing)).toThrow(VndbConceptInvalid);
});

test('LIVE01: VNDB projection enforces the four-capture, 64 KiB and 100-association cost bounds', () => {
  const atLimit = fixture();
  const tags = Array.from({ length: 100 }, () => ({ id: 'g1', name: 'Lead', rating: 1,
    spoiler: 0, lie: false }));
  atLimit[0] = captured('vn', [{ id: 'v1', tags }]);
  expect(projectVndbConceptCaptures(atLimit).claims.filter(claim => claim.kind === 'tag')).toHaveLength(100);
  const overLimit = [...atLimit];
  overLimit[0] = captured('vn', [{ id: 'v1', tags: [...tags, tags[0]] }]);
  expect(() => projectVndbConceptCaptures(overLimit)).toThrow(VndbConceptInvalid);
  const oversized = fixture();
  oversized[0] = { kind: 'vn', bytes: Buffer.alloc(65_537),
    digest: createHash('sha256').update(Buffer.alloc(65_537)).digest('hex'), complete: true };
  expect(() => projectVndbConceptCaptures(oversized)).toThrow(VndbConceptInvalid);
});
