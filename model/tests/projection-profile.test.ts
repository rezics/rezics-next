import { expect, test } from 'bun:test';
import * as fc from 'fast-check';
import {
  checkNodeLocalCandidate,
  profileRegistry,
  shapeArbitraries,
} from '../../packages/model/src/index.ts';
import { projectionProfile } from '../definitions/projection-v1.ts';
import { buildCommandRegistry } from '../compiler/registry.ts';

const shape = (role: string) => `https://rezics.com/definition/projection-v1/${role}-shape`;
type Candidate = Record<string, unknown>;
function sample(role: string, overrides: Candidate = {}): Candidate {
  const arbitrary = shapeArbitraries[
    shape(role) as keyof typeof shapeArbitraries
  ] as fc.Arbitrary<Candidate>;
  const [base] = fc.sample(arbitrary, { seed: 1066, numRuns: 1 });
  return { ...base, ...overrides };
}
const iri = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('a projection has exactly one subject and one to eight frames', () => {
  expect(checkNodeLocalCandidate(shape('projection'), sample('projection'))).toBe(true);
  const frames = (count: number) => Array.from({ length: count }, (_, index) => iri(index + 1));
  for (const count of [1, 8]) {
    expect(checkNodeLocalCandidate(shape('projection'), sample('projection', { 'rv:frame': frames(count) }))).toBe(true);
    expect(checkNodeLocalCandidate(shape('revision'), sample('revision', { 'rv:frame': frames(count) }))).toBe(true);
  }
  for (const count of [0, 9]) {
    expect(checkNodeLocalCandidate(shape('projection'), sample('projection', { 'rv:frame': frames(count) }))).toBe(false);
    expect(checkNodeLocalCandidate(shape('revision'), sample('revision', { 'rv:frame': frames(count) }))).toBe(false);
  }
  expect(checkNodeLocalCandidate(shape('projection'), sample('projection', { 'rv:projectionOf': [iri(1), iri(2)] }))).toBe(false);
  expect(checkNodeLocalCandidate(shape('projection'), sample('projection', { 'rv:projectionOf': [] }))).toBe(false);
});

test('a projection is never an owl:sameAs and keeps exactly one head', () => {
  expect(checkNodeLocalCandidate(shape('projection'), sample('projection', { 'owl:sameAs': [iri(9)] }))).toBe(false);
  expect(checkNodeLocalCandidate(shape('projection'), sample('projection', { 'rv:projectionHead': [iri(1), iri(2)] }))).toBe(false);
  expect(checkNodeLocalCandidate(shape('projection'), sample('projection', { 'rv:projectionHead': [] }))).toBe(false);
});

test('writes to a projection must bind its focus roles, so no other command can mint one', () => {
  const registry = buildCommandRegistry([projectionProfile],
    { established: {}, canonicalOrder: [], demandOrder: [] });
  expect(registry.bindings.get('projection-v1')!.roles).toEqual(['projection', 'revision']);
  expect(registry.canonical.map((entry) => entry.type).sort()).toEqual([
    'https://rezics.com/vocab/Projection',
    'https://rezics.com/vocab/ProjectionRevision',
  ]);
  expect(profileRegistry['projection-v1'].focusRoles).toEqual(['projection', 'revision']);
});
