import { expect, test } from 'bun:test';
import { checkNodeLocalCandidate, profileRegistry } from '../../packages/model/src/index.ts';
import { projectionProfile } from '../definitions/projection-v1.ts';
import { buildCommandRegistry } from '../compiler/registry.ts';

const shape = (role: string) => `https://rezics.com/definition/projection-v1/${role}-shape`;
const iri = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projection = {
  '@id': iri(1),
  'rdf:type': ['https://rezics.com/vocab/Projection'],
  'rv:projectionOf': [iri(2)],
  'rv:frame': [iri(3)],
  'rv:projectionHead': [iri(4)],
};
const revision = {
  '@id': iri(4),
  'rdf:type': [
    'https://rezics.com/vocab/ProjectionRevision',
    'https://rezics.com/vocab/RevisionAnchor',
  ],
  'rv:component': [projection['@id']],
  'rv:projectionOf': projection['rv:projectionOf'],
  'rv:frame': projection['rv:frame'],
  'rv:operation': [`urn:rezics:operation:${'a'.repeat(64)}`],
  'rv:modelRevision': ['https://rezics.com/definition/projection-v1'],
  'rv:shapeRevision': ['https://rezics.com/definition/projection-v1'],
  'rv:datasetId': ['urn:rezics:dataset:product'],
  'rv:dataEpoch': ['00000000-0000-4000-8000-000000000001'],
  'rv:sequence': [1],
};

test('a projection has exactly one subject and one to eight frames', () => {
  expect(checkNodeLocalCandidate(shape('projection'), projection)).toBe(true);
  expect(checkNodeLocalCandidate(shape('revision'), revision)).toBe(true);
  const frames = (count: number) => Array.from({ length: count }, (_, index) => iri(index + 3));
  for (const count of [1, 8]) {
    expect(
      checkNodeLocalCandidate(shape('projection'), { ...projection, 'rv:frame': frames(count) }),
    ).toBe(true);
    expect(
      checkNodeLocalCandidate(shape('revision'), { ...revision, 'rv:frame': frames(count) }),
    ).toBe(true);
  }
  for (const count of [0, 9]) {
    expect(
      checkNodeLocalCandidate(shape('projection'), { ...projection, 'rv:frame': frames(count) }),
    ).toBe(false);
    expect(
      checkNodeLocalCandidate(shape('revision'), { ...revision, 'rv:frame': frames(count) }),
    ).toBe(false);
  }
  for (const subject of [[], [iri(2), iri(5)]]) {
    expect(
      checkNodeLocalCandidate(shape('projection'), { ...projection, 'rv:projectionOf': subject }),
    ).toBe(false);
    expect(
      checkNodeLocalCandidate(shape('revision'), { ...revision, 'rv:projectionOf': subject }),
    ).toBe(false);
  }
});

test('a projection is never an owl:sameAs and keeps exactly one head', () => {
  expect(checkNodeLocalCandidate(shape('projection'), projection)).toBe(true);
  expect(
    checkNodeLocalCandidate(shape('projection'), { ...projection, 'owl:sameAs': [iri(9)] }),
  ).toBe(false);
  expect(
    checkNodeLocalCandidate(shape('projection'), {
      ...projection,
      'rv:projectionHead': [iri(4), iri(5)],
    }),
  ).toBe(false);
  expect(
    checkNodeLocalCandidate(shape('projection'), { ...projection, 'rv:projectionHead': [] }),
  ).toBe(false);
});

test('writes to a projection must bind its focus roles, so no other command can mint one', () => {
  const registry = buildCommandRegistry([projectionProfile], {
    canonicalOrder: [],
    demandOrder: [],
  });
  expect(registry.bindings.get('projection-v1')!.roles).toEqual(['projection', 'revision']);
  expect(registry.canonical.map((entry) => entry.type).sort()).toEqual([
    'https://rezics.com/vocab/Projection',
    'https://rezics.com/vocab/ProjectionRevision',
  ]);
  expect(profileRegistry['projection-v1'].focusRoles).toEqual(['projection', 'revision']);
});
