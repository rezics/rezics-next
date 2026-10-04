import { expect, test } from 'bun:test';
import { covers, coordinateOf, dimensionOf, type Coordinate } from '../src/modules/projection/dimension.ts';
import type { Base } from '../src/modules/target/contract.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rv = (name: string) => `https://rezics.com/vocab/${name}`;
const railgun = id(1), episode3 = id(2), canon = id(3), legends = id(4), season2 = id(5), battle = id(6);
const at = (dimension: Coordinate['dimension'], iri: string, work: string | null = null): Coordinate =>
  ({ iri, dimension, work });

test('structural grains map to their own dimension, whatever descriptive types they also carry', () => {
  const dimension = (base: Base, types: string[] = []) => dimensionOf({ base, types });
  expect(dimension('work', ['https://schema.org/CreativeWork', 'https://schema.org/Event'])).toBe('work');
  expect(dimension('realization')).toBe('realization');
  expect(dimension('release', [rv('Release')])).toBe('release');
  expect(dimension('occurrence', ['https://schema.org/ListItem'])).toBe('position');
});

test('a descriptive Resource is a frame only through a registered type that declares a dimension', () => {
  const dimension = (...types: string[]) => dimensionOf({ base: 'resource', types });
  expect(dimension('https://schema.org/Event')).toBe('event');
  expect(dimension(rv('NarrativeContinuity'))).toBe('continuity');
  expect(dimension(rv('Character'), rv('NarrativeContinuity'), 'http://www.w3.org/2000/01/rdf-schema#Resource')).toBe('continuity');
  // No dimension: units and held titles are Resources but never coordinates; neither are Realms or Agents.
  for (const type of [rv('GameUnit'), rv('Title'), rv('Character'), rv('Realm'), rv('Zone'), rv('Agent'),
    'http://www.w3.org/2004/02/skos/core#Concept', 'https://schema.org/Place', 'https://example.test/Unknown'])
    expect(dimension(type), type).toBeNull();
  expect(dimension()).toBeNull();
  // A Resource that is both an Event and a continuity belongs to no single dimension.
  expect(dimension('https://schema.org/Event', rv('NarrativeContinuity'))).toBeNull();
  // A Projection is never a frame: there are no projections of projections.
  expect(dimensionOf({ base: 'projection', types: [rv('Projection')] })).toBeNull();
});

test('a target becomes a typed coordinate carrying the Work that owns a position', () => {
  expect(coordinateOf({ resource: episode3, base: 'occurrence', types: [], work: railgun }))
    .toEqual({ iri: episode3, dimension: 'position', work: railgun });
  expect(coordinateOf({ resource: canon, base: 'resource', types: [rv('NarrativeContinuity')], work: null }))
    .toEqual({ iri: canon, dimension: 'continuity', work: null });
  expect(coordinateOf({ resource: id(9), base: 'resource', types: [rv('GameUnit')], work: null })).toBeNull();
});

test('values in one dimension combine with OR', () => {
  const frame = [at('continuity', legends)];
  expect(covers([at('continuity', canon), at('continuity', legends)], frame)).toBe(true);
  expect(covers([at('continuity', canon)], frame)).toBe(false);
});

test('dimensions combine with AND, and an unnamed dimension leaves the frame unconstrained', () => {
  const frame = [at('continuity', canon), at('position', episode3, railgun)];
  expect(covers([at('continuity', canon), at('position', episode3, railgun)], frame)).toBe(true);
  expect(covers([at('continuity', canon), at('position', id(7), railgun)], frame)).toBe(false);
  expect(covers([at('continuity', legends), at('position', episode3, railgun)], frame)).toBe(false);
  expect(covers([at('continuity', canon)], frame)).toBe(true);
  expect(covers([], frame)).toBe(true);
  expect(covers([], [])).toBe(true);
});

test('applicability naming a dimension the frame lacks does not cover it', () => {
  expect(covers([at('continuity', canon)], [at('position', episode3, railgun)])).toBe(false);
  expect(covers([at('event', battle)], [])).toBe(false);
});

test('a position frame is covered by applicability naming its Work, and only by its own Work', () => {
  const frame = [at('position', episode3, railgun)];
  expect(covers([at('work', railgun)], frame)).toBe(true);
  expect(covers([at('work', id(8)), at('work', railgun)], frame)).toBe(true);
  expect(covers([at('work', id(8))], frame)).toBe(false);
  expect(covers([at('work', railgun), at('position', episode3, railgun)], frame)).toBe(true);
  // Containment goes one way: a Work frame is not inside one of its positions.
  expect(covers([at('position', episode3, railgun)], [at('work', railgun)])).toBe(false);
  // A position of unknown Work is covered only by itself.
  expect(covers([at('work', railgun)], [at('position', episode3, null)])).toBe(false);
  // Release and realization have no containment: they match only exactly.
  expect(covers([at('work', railgun)], [at('release', id(10), railgun)])).toBe(false);
  expect(covers([at('release', id(10))], [at('release', id(10), railgun)])).toBe(true);
  expect(covers([at('work', railgun)], [at('work', railgun), at('continuity', season2)])).toBe(true);
});

test('a frame names at most one coordinate per dimension', () => {
  expect(() => covers([], [at('continuity', canon), at('continuity', legends)])).toThrow(RangeError);
});
